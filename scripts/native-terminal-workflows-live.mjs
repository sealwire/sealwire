import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

// Opt-in, paid acceptance. The selected parent uses Haiku or Luna; workers use Luna low.
const MODEL = "gpt-6-luna";
const PROVIDER = process.env.LIVE_TERMINAL_PROVIDER || "codex";
const PARENT_MODEL = PROVIDER === "claude_code" ? "haiku" : MODEL;
const DEVICE = "native-terminal-workflows";
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-terminal-workflows-"));
const CODEX_HOME = path.join(ROOT, "codex");
const results = [];
const terminals = [];
const activeGoals = new Set();
let browser;
await fs.mkdir(CODEX_HOME);
process.once("exit", () => { try { unlinkSync(path.join(CODEX_HOME, "auth.json")); } catch {} });
await fs.copyFile(path.join(os.homedir(), ".codex/auth.json"), path.join(CODEX_HOME, "auth.json"));
await fs.chmod(path.join(CODEX_HOME, "auth.json"), 0o600);
await fs.writeFile(path.join(CODEX_HOME, "config.toml"), `model = "${MODEL}"\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n[tui]\nauto_recap = false\n`);
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const relay = spawnManagedProcess("native-workflows", process.env.NATIVE_TERMINAL_RELAY_BINARY || path.resolve("target/debug/relay-server"), [], {
  CODEX_HOME, PORT: String(port), RELAY_STATE_DB: path.join(ROOT, "sealwire.db"), CLAUDE_WORKER_PATH: path.resolve("claude-worker/worker.mjs"), AGENT_PROVIDERS: "codex,claude_code", SEALWIRE_BETA: "1", SEALWIRE_RELAY_URL: base, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
}, { stripInherited: (key) => /^(CODEX|CLAUDE|ANTHROPIC|OPENAI|SEALWIRE|RELAY|AGENT_PROVIDERS|PORT$)/.test(key) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(250); }
  throw new Error(`Timeout: ${label}`);
}
async function api(route, input) {
  const read = route.endsWith("/terminal/read");
  const data = input ? { device_id: DEVICE, ...input } : undefined;
  const url = read ? `${base}${route}?${new URLSearchParams(Object.entries(data).filter(([, value]) => value != null))}` : base + route;
  const response = await fetch(url, { method: read || !input ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: !read && input ? JSON.stringify(data) : undefined });
  const result = await response.json();
  assert.ok(response.ok && result.ok !== false && !result.isError, `${route}: ${JSON.stringify(result)}`);
  return result.data ?? result;
}
async function project(name) {
  const dir = path.join(ROOT, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'AGENTS.md'), 'This is a tiny isolated acceptance fixture. For task teams, developers edit and verify files only; the team driver owns Git staging and commits. Do not run Git commit or create .git-index files. Use the requested model only. Do not use web, spawn subagents, install packages, or modify files outside this project. Keep replies concise. Follow the Sealwire workflow prompts and use its MCP tools when requested.\n');
  await fs.writeFile(path.join(dir, 'sample.txt'), 'fixture\n');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Probe']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'probe@example.invalid']);
  execFileSync('git', ['-C', dir, 'add', '.']);
  const tree = execFileSync('git', ['-C', dir, 'write-tree'], { encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['-C', dir, 'commit-tree', tree], { input: 'Isolated acceptance fixture\n', encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'Probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' } }).trim();
  execFileSync('git', ['-C', dir, 'update-ref', 'HEAD', commit]);
  await api('/api/allowed-roots', { allowed_roots: [ROOT] });
  await api('/api/workspace/trust', { cwd: dir, trusted: true });
  return dir;
}
async function page(thread) { return api(`/api/threads/${encodeURIComponent(thread)}/transcript`); }
async function idle(thread, predicate = () => true, timeout = 120000) {
  return until(async () => {
    const p = await page(thread);
    return !p.thread_state?.active_turn_id && predicate(p) ? p : false;
  }, `thread ${thread} idle`, timeout);
}
async function start(cwd, text) {
  const snapshot = await api("/api/session/start", { cwd, provider: PROVIDER, model: PARENT_MODEL, effort: "low", approval_policy: PROVIDER === "claude_code" ? "bypass" : "never", sandbox: "danger-full-access", initial_prompt: text });
  await idle(snapshot.active_thread_id, (p) => p.entries.some((entry) => entry.kind === "agent_text"));
  return snapshot.active_thread_id;
}
async function attach(thread, cwd) {
  const provider = (await api("/api/threads")).threads.find((row) => row.id === thread)?.provider;
  const initial = await api("/api/session/terminal/open", { thread_id: thread, cols: 110, rows: 35 });
  let offset = initial.offset;
  let output = Buffer.from(initial.data, "base64").toString();
  let sequence = 0;
  let writes = Promise.resolve();
  let reading = false;
  console.log("ATTACH", thread);
  const terminal = { thread, nativeId: initial.terminal_id, cwd, probeLog: () => output, stdin: { write(data) {
    if (data.length > 1 && !data.startsWith("\x1b")) data = `\x1b[200~${data}\x1b[201~`;
    const input = { thread_id: thread, terminal_id: terminal.nativeId, input_stream_id: "live-workflows", input_seq: ++sequence, data };
    writes = writes.then(() => api("/api/session/terminal/input", input));
    writes.catch((error) => { terminal.error = error; });
  } } };
  terminal.timer = setInterval(async () => {
    if (reading || terminal.error) return;
    reading = true;
    try {
      const frame = await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.nativeId, offset });
      if (frame.terminal_id !== terminal.nativeId) { terminal.nativeId = frame.terminal_id; sequence = 0; }
      offset = frame.offset;
      output += Buffer.from(frame.data, "base64").toString();
      if (frame.exited) throw new Error(`Native TUI exited for ${thread}`);
    } catch (error) { terminal.error = error; }
    finally { reading = false; }
  }, 200);
  terminals.push(terminal);
  let trustedNative = false;
  await until(async () => {
    if (terminal.error) throw terminal.error;
    const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (provider === "claude_code" && !trustedNative && plain.includes("trust") && plain.includes("folder")) {
      trustedNative = true;
      await sleep(1000);
      terminal.stdin.write("\x1b[B");
      await sleep(300);
      terminal.stdin.write("\r");
    }
    if (provider === "claude_code" && (output.includes("\x1b[?1049h") || /v2\./.test(plain))) {
      terminal.stdin.write("");
      await writes;
      return true;
    }
    return provider !== "claude_code" && output.includes("GPT-6-Luna") && output.includes("\x1b[?2004h"); }, "native CLI attached", 30000);
  return terminal;
}
async function record(name, test) {
  if (process.env.LIVE_CASES && !process.env.LIVE_CASES.split(",").includes(name)) return;
  const before = Date.now();
  try { const detail = await test(); results.push({ name, ok: true, durationMs: Date.now() - before, detail }); console.log("PASS", name); }
  catch (error) {
    results.push({ name, ok: false, durationMs: Date.now() - before, error: error.stack });
    console.log("FAIL", name, error.message);
    for (const thread of activeGoals) await api("/api/session/goal", { thread_id: thread, objective: "" }).catch(() => {});
    activeGoals.clear();
  }
  await fs.writeFile(path.join(ROOT, "results.json"), JSON.stringify({ root: ROOT, model: MODEL, results }, null, 2));
}

try {
  await waitForHealth(base + "/api/health");
  if (!process.env.LIVE_CASES || process.env.LIVE_CASES.includes("task_team")) assert.equal((await api("/api/session")).beta_features_enabled, true, "Build with private features and the private checkout first");
  console.log("ARTIFACTS", ROOT);
  const cwd = await project('handover');
  let source, target;
  await record('real_model_source_and_native_keyboard', async () => {
    source = await start(cwd, 'The task to leave for handover is to create handover-result.txt with exactly HANDOVER_OK. For this turn only reply READY and leave the file absent. Do not call any tools.');
    const tui = await attach(source, cwd);
    const before = (await page(source)).entries.length;
    tui.stdin.write('Keep the pending handover task unchanged. Reply exactly NATIVE_KEYBOARD_OK. Do not call tools.');
    await sleep(300);
    tui.stdin.write('\r');
    const p = await idle(source, p => p.entries.length > before && p.entries.some(e => e.kind === 'agent_text' && e.text.includes('NATIVE_KEYBOARD_OK')));
    return { source, nativeId: tui.nativeId, entries: p.entries.length };
  });
  await record(PROVIDER === "claude_code" ? "native_yolo_tool_execution" : "native_approval_through_shared_handler", async () => {
    const dir = await project("approval");
    const parent = await start(dir, "Reply APPROVAL_READY only. Do not call tools.");
    const tui = await attach(parent, dir);
    try {
      if (PROVIDER === "claude_code") {
        await api("/api/session/message", { thread_id: parent, text: "Run exactly one Bash command: printf NATIVE_APPROVAL_OK. Report its output. Do not call any other tools." });
        await idle(parent, (p) => p.entries.some((row) => row.kind === "agent_text" && row.text?.includes("NATIVE_APPROVAL_OK")));
        assert.ok(!(await api("/api/session")).pending_approvals.some((row) => row.thread_id === parent));
        return { parent, nativeDecision: false, permissionMode: "YOLO" };
      }
      await api("/api/session/settings", { thread_id: parent, approval_policy: "on-request", sandbox: "read-only" });
      await api("/api/session/message", { thread_id: parent, text: 'Call tools.exec_command exactly once with cmd="printf NATIVE_APPROVAL_OK", sandbox_permissions="require_escalated", and justification="Native terminal approval acceptance fixture". This harmless printf is testing the permission dialog. Wait for permission, then report the output. Do not call any other tools.' });
      const pending = await until(async () => (await api("/api/session")).pending_approvals?.find((row) => row.thread_id === parent), "native command approval", 45000);
      await until(() => /Yes, proceed|approve|approval/i.test(tui.probeLog().slice(-6000)), "native approval dialog", 15000);
      await sleep(300);
      tui.stdin.write("\r");
      await idle(parent, (p) => p.entries.some((row) => row.kind === "agent_text" && row.text?.includes("NATIVE_APPROVAL_OK")));
      assert.ok(!(await api("/api/session")).pending_approvals.some((row) => row.request_id === pending.request_id));
      return { parent, request: pending.request_id, nativeDecision: true };
    } finally {
      clearInterval(tui.timer);
      await api("/api/session/terminal/close", { thread_id: parent, terminal_id: tui.nativeId });
    }
  });
  await record('handover_native_to_native_existing_target', async () => {
    assert.ok(source);
    target = await start(cwd, 'You will receive a handover shortly. For now reply TARGET_READY only; do not call tools.');
    const tui = await attach(target, cwd);
    const outcome = await api('/api/session/handover', { thread_id: source, agent: target, model: PARENT_MODEL, effort: 'low', note: 'Hand over the pending task: create handover-result.txt containing exactly HANDOVER_OK. Keep the handover concise.' });
    await until(async () => (await fs.readFile(path.join(cwd, 'handover-result.txt'), 'utf8').catch(() => '')).trim() === 'HANDOVER_OK', 'handover result file');
    const p = await idle(target);
    const reviews = await api('/api/session/reviews');
    const terminalText = tui.probeLog().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.ok(terminalText.includes('HANDOVER_OK') || terminalText.includes('handover-result.txt'));
    return { source, target, outcome, targetEntries: p.entries.length, handovers: reviews.handovers, handoverLinks: reviews.handover_links };
  });
  await record('delegate_real_brief_and_report_back', async () => {
    const dir = await project('delegate');
    const parent = await start(dir, 'We are testing a small delegated task. Reply DELEGATE_PARENT_READY only, no tools.');
    await attach(parent, dir);
    const outcome = await api('/api/session/delegate', { thread_id: parent, provider: 'codex', model: MODEL, effort: 'low', message: 'Work only on this tiny question: what is 17 + 25? Return DELEGATE_ANSWER_42 using the Sealwire report_back tool. Do not modify files, use web, or spawn agents. Keep the brief short.' });
    const review = await until(async () => {
      const r = await api('/api/session/reviews');
      const ask = r.asks?.find(a => a.asker_thread_id === parent);
      return ask && ['answered', 'delivered', 'done', 'failed'].includes(ask.status) ? { r, ask } : false;
    }, 'delegate answer', 180000);
    assert.notEqual(review.ask.status, 'failed', JSON.stringify(review.ask));
    await idle(parent, p => p.entries.some(e => e.text?.includes('DELEGATE_ANSWER_42')), 60000);
    return { parent, outcome, ask: review.ask };
  });
  await record('review_real_read_only_reviewer', async () => {
    const dir = await project('review');
    const parent = await start(dir, 'Use the file tools to create answer.txt containing exactly REVIEW_FIXTURE_OK. Then describe that change in one short sentence.');
    await attach(parent, dir);
    const outcome = await api('/api/session/review', { parent_thread_id: parent, reviewer_provider: 'codex', reviewer_model: MODEL, reviewer_effort: 'low', instructions: 'Check only whether answer.txt contains REVIEW_FIXTURE_OK. It is a tiny synthetic fixture; keep your review brief.', recap_source: 'last_message', max_rounds: 1 });
    const job = await until(async () => {
      const r = await api('/api/session/reviews');
      const row = r.review_jobs?.find(j => j.parent_thread_id === parent);
      return row && ['complete', 'failed', 'escalated', 'cancelled'].includes(row.phase ?? row.status?.phase ?? row.status) ? row : false;
    }, 'review terminal', 180000);
    assert.equal(job.status, 'complete', JSON.stringify(job));
    if (process.env.NATIVE_TERMINAL_BROWSER === "1") {
      let context;
      ({ browser, context } = await launchBrowser());
      const view = await context.newPage();
      await view.goto(base);
      await view.locator(`[data-open-thread-id="${parent}"]`).first().click();
      await view.getByRole("button", { name: "Terminal", exact: true }).click();
      await view.getByText("Live terminal", { exact: true }).waitFor();
      const card = view.locator(`[data-review-id="${job.id}"]`).first();
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await view.screenshot({ path: path.join(ROOT, "review-terminal-desktop.png"), fullPage: true });
      await view.setViewportSize({ width: 390, height: 844 });
      await card.scrollIntoViewIfNeeded();
      await view.screenshot({ path: path.join(ROOT, "review-terminal-mobile.png"), fullPage: true });
      assert.equal(await view.locator("[data-session-mode='terminal'] .native-terminal").count(), 1);
      await browser.close();
      browser = null;
    }
    return { parent, outcome, job };
  });
  await record('goal_real_plan_and_completion', async () => {
    const dir = await project('goal');
    const parent = await start(dir, 'Reply GOAL_PARENT_READY only. Do not call tools yet.');
    await attach(parent, dir);
    activeGoals.add(parent);
    const outcome = await api('/api/session/goal', { thread_id: parent, objective: 'Create goal-result.txt with exactly GOAL_OK. Verify it, then use Sealwire goal tools to mark the goal complete. This is one small step; do not use web or spawn agents.' });
    let goal = await until(async () => {
      const s = await api('/api/session/reviews');
      const g = s.goals?.find(g => g.thread_id === parent);
      if (g && ['complete_claimed', 'failed', 'blocked', 'needs_user'].includes(g.status)) return g;
      return false;
    }, 'goal completion', 180000);
    await idle(parent);
    goal = (await api('/api/session/reviews')).goals.find(g => g.thread_id === parent);
    assert.equal(goal.status, 'complete_claimed', JSON.stringify(goal));
    activeGoals.delete(parent);
    assert.equal((await fs.readFile(path.join(dir, 'goal-result.txt'), 'utf8')).trim(), 'GOAL_OK');
    return { parent, outcome, goal, allPlanStepsDone: goal.steps?.every(s => s.status === 'done') ?? false };
  });
  await record(process.env.LIVE_TEAM_NATIVE_CLAUDE === '1' ? 'task_team_native_claude_lead' : process.env.LIVE_TEAM_CLAUDE_DEV === '1' ? 'task_team_with_claude_developer' : 'task_team_confirm_to_native_seats', async () => {
    const dir = await project('task-team');
    const anchor = await start(dir, 'Reply TASK_WORKSPACE_READY only, no tools.');
    await attach(anchor, dir);
    const seat = { provider: 'codex', model: MODEL, effort: 'low' };
    const lead = process.env.LIVE_TEAM_NATIVE_CLAUDE === "1" ? { provider: "claude_code", model: "haiku", effort: "low" } : seat;
    const developer = process.env.LIVE_TEAM_CLAUDE_DEV === '1' ? { provider: 'claude_code', model: 'haiku', effort: 'low' } : seat;
    const proposal = await api('/api/orchestrator/proposals', {
      title: 'Create one tiny team result file', context: 'Synthetic acceptance fixture. Implement exactly one subtask creating team-result.txt. Do not ask questions or broaden scope.',
      acceptance_criteria: 'team-result.txt contains exactly TEAM_OK, with no newline. Verify its bytes. The team driver must commit the completed change; the developer must only edit and verify the file.',
      agreed_scope: 'Only team-result.txt inside the active task-team worktree. Use relative paths from the session cwd, including .sealwire/PLAN.md and team-result.txt. The original repository path is a source checkout: never write or review team-result.txt there. Confirm pwd before editing. No web, installations, or unrelated edits.', quality_rules: 'Keep the plan and report brief. One subtask suffices. The team driver owns staging and commits; tell the developer to only edit and verify team-result.txt, without running Git stage/commit. Do not add commit-message or attribution criteria to the subtask. Never create or commit .git-index files. No other acceptance criteria may be added. For Git inspection on this macOS fixture, use /Applications/Xcode.app/Contents/Developer/usr/bin/git directly so read-only tools do not invoke the system xcrun cache wrapper.',
      agents: { tl: lead, dev: developer, reviewer: seat }
    });
    assert.equal(proposal.proposal.agents.tl.model, lead.model);
    assert.equal(proposal.proposal.agents.reviewer.model, MODEL);
    assert.equal(proposal.proposal.agents.dev.model, developer.model);
    const before = await api('/api/session/teams');
    assert.equal(before.teams.length, 0, 'proposal must not start a run');
    const receipt = await api(`/api/orchestrator/proposals/${proposal.proposal.id}/confirm`, {});
    const runId = receipt.team_run_id;
    assert.ok(runId, JSON.stringify(receipt));
    const run = await until(async () => (await api('/api/session/teams')).teams.find(r => r.team_run_id === runId && r.tl_thread_id), 'team lead appears', 60000);
    const tl = await until(async () => (await api('/api/threads')).threads.find(r => r.id === run.tl_thread_id), 'TL provider registration', 30000);
    if (process.env.LIVE_TEAM_NATIVE_CLAUDE === "1") {
      await api("/api/session/team/pause", { team_run_id: runId });
      await until(async () => (await api("/api/session/teams")).teams.find((r) => r.team_run_id === runId)?.status === "paused", "team paused at runtime switch");
    }
    const tui = await attach(run.tl_thread_id, tl.cwd);
    if (process.env.LIVE_TEAM_NATIVE_CLAUDE === "1") await api("/api/session/team/resume", { team_run_id: runId });
    let lastPhase;
    const done = await until(async () => {
      const row = (await api('/api/session/teams')).teams.find(r => r.team_run_id === runId);
      if (row.phase !== lastPhase) { console.log('TEAM_PHASE', row.phase, row.status); lastPhase = row.phase; }
      if (['done', 'failed', 'escalated', 'interrupted', 'cancelled', 'blocked'].includes(row.status)) return row;
      return false;
    }, 'task team completes', 300000);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.ok(done.sub_tasks.length > 0 && done.sub_tasks.every(s => s.status === 'done'));
    const contents = execFileSync('git', ['-C', dir, 'show', `${done.head_commit}:team-result.txt`], { encoding: 'utf8' });
    assert.equal(contents, 'TEAM_OK');
    assert.ok(tui.probeLog().includes('team-result.txt'), 'native TL transcript missing team result');
    return { proposal: proposal.proposal, receipt, run: done, nativeLead: tui.nativeId, fileContents: contents };
  });
  await record('native_input_review_lock_parity', async () => {
    const dir = await project('input-guard');
    const parent = await start(dir, 'Create answer.txt containing exactly GUARD_FIXTURE_OK. Describe the change briefly.');
    const tui = await attach(parent, dir);
    const review = await api('/api/session/review', { parent_thread_id: parent, reviewer_provider: 'codex', reviewer_model: MODEL, reviewer_effort: 'low', instructions: 'First run the harmless shell command sleep 12. Then check answer.txt is GUARD_FIXTURE_OK. Keep your verdict brief.', recap_source: 'last_message', max_rounds: 1 });
    await until(async () => {
      const row = (await api('/api/session/reviews')).review_jobs.find(j => j.id === review.review_job_id);
      const p = await page(parent);
      return row?.status === 'waiting_for_reviewer' && !p.thread_state?.active_turn_id;
    }, 'review owns idle parent', 60000);
    const gui = await fetch(base + '/api/session/message', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Agent-Relay-CSRF': '1' }, body: JSON.stringify({ thread_id: parent, device_id: DEVICE, text: 'Reply GUARD_SHOULD_BLOCK only, no tools.' }) });
    const rejection = await gui.json();
    assert.ok(!gui.ok || rejection.ok === false, JSON.stringify(rejection));
    tui.stdin.write('Reply NATIVE_REVIEW_LOCK_BYPASS only. Do not call tools.');
    await sleep(250);
    tui.stdin.write('\r');
    await sleep(3000);
    const after = (await api('/api/session/reviews')).review_jobs.find(j => j.id === review.review_job_id);
    const nativeReply = (await page(parent)).entries.some(e => e.kind === 'agent_text' && e.text?.includes('NATIVE_REVIEW_LOCK_BYPASS'));
    const nativeStarted = nativeReply || Boolean((await page(parent)).thread_state?.active_turn_id);
    assert.match(tui.probeLog().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), /review/i, 'native UI must show the refusal');
    const evidence = { parent, guiStatus: gui.status, rejection, nativeStarted, nativeReply, reviewStatus: after.status, nativeText: tui.probeLog().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-2200) };

    assert.equal(nativeStarted, false, `Native input bypassed active review lock: ${JSON.stringify({ guiStatus: gui.status, nativeStarted, reviewStatus: after.status })}`);
    return evidence;
  });
} finally {
  await browser?.close();
  for (const terminal of terminals) {
    clearInterval(terminal.timer);
    await fs.writeFile(path.join(ROOT, `${terminal.thread}.ansi`), terminal.probeLog());
  }
  await fs.writeFile(path.join(ROOT, "relay.log"), relay._logBuffer.join("\n"));
  await stopManagedProcess(relay);
  await fs.rm(path.join(CODEX_HOME, "auth.json"), { force: true });
  await fs.writeFile(path.join(ROOT, "results.json"), JSON.stringify({ root: ROOT, model: MODEL, results }, null, 2));
  console.log("RESULTS", JSON.stringify(results.map(({ name, ok }) => ({ name, ok }))));
  process.exitCode = results.some((row) => !row.ok) ? 1 : 0;
}
