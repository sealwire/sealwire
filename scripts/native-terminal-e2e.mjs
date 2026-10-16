import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { approvePairing, closeSecurityModal, startPairingFromLocalPage, waitForPairedRemote } from "./e2e/harness/pairing.mjs";
import { selectFirstRelayIfNeeded } from "./e2e/harness/remote-session.mjs";
import { waitForBrokerConnection } from "./e2e/harness/relay.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";

const provider = process.env.NATIVE_TERMINAL_PROVIDER || "codex";
const claude = provider === "claude_code";
const nonYolo = claude && process.env.NATIVE_TERMINAL_NON_YOLO === "1";
const emptyStart = claude && process.env.NATIVE_TERMINAL_EMPTY === "1";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-managed-terminal-"));
const workspace = path.join(root, "workspace");
const config = path.join(root, "codex");
await fs.mkdir(workspace);
await fs.mkdir(config);
const requests = [];
const model = http.createServer(async (req, res) => {
  let body = "";
  for await (const data of req) body += data;
  if (claude && req.url.includes("messages")) {
    const request = JSON.parse(body);
    if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 })); return; }
    requests.push(request);
    const text = (request.messages || []).filter((item) => item.role === "user").at(-1)?.content;
    const prompt = typeof text === "string" ? text : text?.map((item) => item.text || "").join(" ") || "";
    const question = prompt.includes("NATIVE_QUESTION");
    const policy = prompt.match(/POLICY_(WRITE_INSIDE|WRITE_OUTSIDE_SDK|WRITE_OUTSIDE_NATIVE|BASH_READ)/)?.[1];
    const answer = prompt.includes("CLOSE_WHILE_RUNNING") ? "SESSION_CONTINUES_AFTER_TERMINAL_CLOSE" : prompt.includes("NATIVE_INPUT") ? "NATIVE_INPUT_ACCEPTED" : "SEALWIRE_TERMINAL_READY";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    if (policy) {
      const name = policy === "BASH_READ" ? "Bash" : "Write";
      const input = name === "Bash" ? { command: "pwd" } : { file_path: path.join(policy === "WRITE_INSIDE" ? workspace : root, `${policy}.txt`), content: "POLICY_OK" };
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `policy-${requests.length}`, name, input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
      send("message_stop", {});
      res.end(); return;
    }
    if (question) {
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: "native-question-1", name: "AskUserQuestion", input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ questions: [{ question: "Which fixture option?", header: "Choice", multiSelect: false, options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }] }] }) } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
      send("message_stop", {});
      res.end(); return;
    }
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    if (prompt.includes("CLOSE_WHILE_RUNNING")) await new Promise((resolve) => setTimeout(resolve, 700));
    for (const text of answer.match(/.{1,8}/g)) { send("content_block_delta", { index: 0, delta: { type: "text_delta", text } }); await new Promise((resolve) => setTimeout(resolve, 40)); }
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    send("message_stop", {});
    res.end(); return;
  }
  if (!req.url.includes("responses")) { res.writeHead(404).end(); return; }
  const request = JSON.parse(body);
  requests.push(request);
  const last = (request.input || []).filter((item) => item.role === "user").at(-1);
  const text = last?.content?.map((item) => item.text || "").join(" ") || "";
  const answer = text.includes("CLOSE_WHILE_RUNNING") ? "SESSION_CONTINUES_AFTER_TERMINAL_CLOSE" : text.includes("NATIVE_INPUT") ? "NATIVE_INPUT_ACCEPTED" : "SEALWIRE_TERMINAL_READY";
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `response_${requests.length}`;
  const item = { type: "message", id: `message_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
  send("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
  send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  send("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  if (text.includes("CLOSE_WHILE_RUNNING")) await new Promise((resolve) => setTimeout(resolve, 700));
  for (const delta of answer.match(/.{1,8}/g)) {
    send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: answer });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
  res.end();
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
await fs.writeFile(path.join(config, "config.toml"), `model_provider = "fixture"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Local acceptance fixture"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[analytics]\nenabled = false\n`);
const claudeConfig = path.join(root, "claude");
await fs.mkdir(claudeConfig);
if (process.env.NATIVE_TERMINAL_SKILLS === "1") {
  const skill = path.join(claudeConfig, "skills", "native-fixture");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: native-fixture\ndescription: Native skill acceptance fixture\n---\nNATIVE_SKILL_APPLIED. Follow the user's arguments: $ARGUMENTS\n");
}
await fs.writeFile(path.join(claudeConfig, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, theme: "dark", projects: { [await fs.realpath(workspace)]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["sk-ant-sealwire-probe-key".slice(-20)], rejected: [] } }));
if (process.env.NATIVE_TERMINAL_HISTORY === "1") await fs.writeFile(path.join(claudeConfig, "history.jsonl"), JSON.stringify({ display: "!printf HISTORY_BYPASS > history-bang.txt", pastedContents: {}, timestamp: Date.now(), project: await fs.realpath(workspace), sessionId: "00112233-4455-4677-8899-aabbccddeeff" }) + "\n");
const nativePath = path.join(root, "bin");
if (process.env.NATIVE_TERMINAL_NO_CLI === "1") {
  await fs.mkdir(nativePath);
  await fs.symlink(process.execPath, path.join(nativePath, "node"));
}
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const brokerPort = process.env.NATIVE_TERMINAL_REMOTE === "1" ? await getFreePort() : null;
const ticketSecret = "native-terminal-isolated-broker-fixture";
const stripInherited = (key) => /^(CODEX|CLAUDE|ANTHROPIC|OPENAI|SEALWIRE|RELAY|AGENT_PROVIDERS|PORT$)/.test(key);
const broker = brokerPort ? spawnManagedProcess("native-terminal-broker", path.resolve("target/debug/relay-broker"), [], {
  BIND_HOST: "127.0.0.1", PORT: String(brokerPort), RELAY_BROKER_AUTH_MODE: "self_hosted", RELAY_BROKER_TICKET_SECRET: ticketSecret,
}, { stripInherited }) : null;
const relay = spawnManagedProcess("native-terminal-relay", path.resolve("target/debug/relay-server"), [], {
  ...(brokerPort ? { RELAY_BROKER_URL: `ws://127.0.0.1:${brokerPort}`, RELAY_BROKER_PUBLIC_URL: `ws://127.0.0.1:${brokerPort}`, RELAY_BROKER_AUTH_MODE: "self_hosted", RELAY_BROKER_CHANNEL_ID: "native-terminal-fixture", RELAY_BROKER_PEER_ID: "native-terminal-fixture", RELAY_BROKER_TICKET_SECRET: ticketSecret } : {}),
  ...(process.env.NATIVE_TERMINAL_NO_CLI === "1" ? { PATH: nativePath + ":/usr/bin:/bin" } : {}),
  PORT: String(port), RELAY_STATE_DB: path.join(root, "sealwire.db"), CLAUDE_WORKER_PATH: path.resolve("claude-worker/worker.mjs"), AGENT_PROVIDERS: provider, CODEX_HOME: config,
  ...(claude ? { CLAUDE_CONFIG_DIR: claudeConfig, ANTHROPIC_API_KEY: "sk-ant-sealwire-probe-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" } : {}),
}, { stripInherited });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, name, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(100); }
  throw new Error(`Timeout: ${name}`);
}
let inputSeq = 0;
async function api(route, input) {
  if (route.endsWith("/terminal/input") && input.data != null) input = { ...input, input_stream_id: input.input_stream_id ?? "e2e", input_seq: input.input_seq ?? ++inputSeq };
  const read = route.endsWith("/terminal/read");
  const data = input ? { device_id: "native-terminal-e2e", ...input } : undefined;
  const url = read ? `${base}${route}?${new URLSearchParams(Object.entries(data).filter(([, value]) => value != null))}` : base + route;
  const response = await fetch(url, { method: read || !input ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: !read && input ? JSON.stringify(data) : undefined });
  const result = await response.json();
  assert.ok(response.ok && result.ok !== false, `${route}: ${JSON.stringify(result)}`);
  return result.data ?? result;
}
let browser;
let terminal;
let thread;
let output = "";
let offset;
try {
  await waitForHealth(base + "/api/health");
  if (brokerPort) { await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`); await waitForBrokerConnection(base + "/api/session"); }
  await api("/api/allowed-roots", { allowed_roots: [root] });
  await api("/api/workspace/trust", { cwd: workspace, trusted: true });
  const started = await api("/api/session/start", { cwd: workspace, provider, model: claude ? "haiku" : "gpt-6-luna", effort: "low", approval_policy: claude && !nonYolo && process.env.NATIVE_TERMINAL_POLICY !== "1" ? "bypass" : "never", sandbox: claude ? "workspace-write" : "read-only", initial_prompt: emptyStart ? undefined : "Initialize this isolated terminal fixture." });
  thread = started.active_thread_id;
  if (!emptyStart) await until(async () => {
    const p = await api(`/api/threads/${thread}/transcript`);
    return !p.thread_state.active_turn_id && p.entries.some((e) => e.text?.includes("SEALWIRE_TERMINAL_READY"));
  }, "provider warmup");
  if (claude && process.env.NATIVE_TERMINAL_POLICY === "1") {
    await api("/api/session/message", { thread_id: thread, text: "POLICY_WRITE_OUTSIDE_SDK" });
    const pending = await until(async () => (await api("/api/session")).pending_approvals[0], "SDK outside edit asks permission");
    assert.equal(await fs.access(path.join(root, "WRITE_OUTSIDE_SDK.txt")).then(() => true, () => false), false);
    await api(`/api/approvals/${encodeURIComponent(pending.request_id)}`, { decision: "deny" });
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "SDK denied edit settles");
  }
  if (claude && process.env.NATIVE_TERMINAL_POLICY === "1") await api("/api/session/settings", { thread_id: thread, approval_policy: "bypass", sandbox: "workspace-write" });
  const beforeNative = requests.length;
  if (nonYolo || process.env.NATIVE_TERMINAL_NO_CLI === "1") {
    const snapshot = await api("/api/session");
    assert.equal(snapshot.native_terminal_providers.includes("claude_code"), true);
    const response = await fetch(base + "/api/session/terminal/open", { method: "POST", headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: JSON.stringify({ thread_id: thread, device_id: "native-terminal-e2e" }) });
    assert.equal(response.ok, false);
    assert.match((await response.json()).error.message, nonYolo ? /Full access \(YOLO\)/ : /Claude Code 2.1.292/);
    await api("/api/session/message", { thread_id: thread, text: "Continue the SDK session after refusing the native terminal." });
    await until(async () => requests.length === 2 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "SDK remains usable");
  } else {
  terminal = await api("/api/session/terminal/open", { thread_id: thread, cols: 100, rows: 30 });
  offset = terminal.offset;
  async function read() {
    const frame = await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.terminal_id, offset });
    if (claude && frame.terminal_id !== terminal.terminal_id) terminal = frame;
    output += Buffer.from(frame.data, "base64").toString("utf8");
    offset = frame.offset;
    assert.equal(frame.exited, false, `Native TUI exited: ${output.slice(-4000)}`);
    return frame;
  }
  let trustedNative = false;
  await until(async () => {
    await read();
    if (claude && !trustedNative && output.includes("trust")) {
      trustedNative = true;
      await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\x1b[B" });
      await sleep(250);
      await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\r" });
    }
    return output.includes(emptyStart ? "v2." : "SEALWIRE_TERMINAL_READY");
  }, "native TUI attached");
  const second = await api("/api/session/terminal/open", { thread_id: thread, cols: 80, rows: 24 });
  assert.equal(second.terminal_id, terminal.terminal_id, "a second device must attach the same terminal");
  await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "Reply to NATIVE_INPUT with a short marker." });
  await sleep(250);
  await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\r" });
  await until(async () => {
    await read();
    const p = await api(`/api/threads/${thread}/transcript`);
    return p.entries.some((e) => e.kind === "agent_text" && e.text?.includes("NATIVE_INPUT_ACCEPTED"));
  }, "native keyboard turn routed through Sealwire");
  assert.equal(emptyStart ? requests.filter((r) => r.tools?.length).length : requests.length, emptyStart ? 1 : beforeNative + 1, "native input must start exactly one conversation turn");
  if (claude && process.env.NATIVE_TERMINAL_POLICY === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before policy comparison");
    for (const code of ["BASH_READ", "WRITE_INSIDE", "WRITE_OUTSIDE_NATIVE"]) {
      const count = requests.length;
      await api("/api/session/message", { thread_id: thread, text: `POLICY_${code}` });
      await until(async () => {
        assert.equal((await api("/api/session")).pending_approvals.length, 0, `${code} must run without approval under YOLO`);
        return requests.length === count + 2 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id;
      }, `native YOLO ${code}`);
    }
    assert.equal(await fs.readFile(path.join(root, "WRITE_OUTSIDE_NATIVE.txt"), "utf8"), "POLICY_OK");
  }
  if (claude && process.env.NATIVE_TERMINAL_EXIT === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before CLI exit");
    const sessions = (await fs.readdir(path.join(claudeConfig, "projects"), { recursive: true })).map((file) => path.basename(file)).filter((file) => /^[a-f0-9-]{36}\.jsonl$/.test(file)).map((file) => file.slice(0, -6));
    const processes = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n").filter((line) => sessions.some((id) => line.includes(`--resume ${id}`)));
    assert.equal(processes.length, 1, "only the fixture's CLI may be terminated");
    process.kill(Number(processes[0].trim().match(/^\d+/)[0]), "SIGKILL");
    await until(async () => (await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.terminal_id })).exited, "CLI exit becomes visible");
    const count = requests.length;
    await api("/api/session/message", { thread_id: thread, text: "Reply AFTER_NATIVE_EXIT using the same conversation." });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "composer works after native CLI exit");
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT after recovery." });
    await until(async () => requests.length === count + 2 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "second composer turn after native CLI exit");
    inputSeq = 0;
    terminal = await api("/api/session/terminal/open", { thread_id: thread });
    offset = undefined;
    await read();
  }
  if (claude && process.env.NATIVE_TERMINAL_RECONNECT === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before reconnecting input streams");
    for (let index = 0; index < 127; index++) await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, input_stream_id: `old-view-${index}`, input_seq: 1, data: "" });
    const old = terminal.terminal_id;
    terminal = await api("/api/session/terminal/open", { thread_id: thread });
    assert.notEqual(terminal.terminal_id, old, "reopening renews exhausted input without replacing the CLI");
    const replay = await fetch(base + "/api/session/terminal/input", { method: "POST", headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: JSON.stringify({ thread_id: thread, device_id: "native-terminal-e2e", terminal_id: old, input_stream_id: "old-view-0", input_seq: 1, data: "STALE_REPLAY" }) });
    assert.equal(replay.ok, false, "input from the retired generation must be refused");
    inputSeq = 0;
    offset = terminal.offset;
    const count = requests.length;
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "Reply to NATIVE_INPUT after reconnecting input streams." });
    await sleep(300);
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\r" });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "input still works after 128 mounts");
    await read();
    assert.ok(!output.includes("STALE_REPLAY"));
  }
  if (claude && process.env.NATIVE_TERMINAL_IMAGE_SCOPE === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before native attachment");
    const filename = path.join(root, "outside-workspace.png");
    await fs.writeFile(filename, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "Describe NATIVE_OUTSIDE_IMAGE " });
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: `\x1b[200~${filename}\x1b[201~` });
    await sleep(800);
    const count = requests.length;
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\r" });
    await until(async () => {
      const frame = await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.terminal_id });
      const screen = Buffer.from(frame.data, "base64").toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      return screen.replace(/\s+/g, "").includes("Sealwirecomposer");
    }, "native attachment is refused before inference");
    assert.equal(requests.length, count);
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT after the refused native attachment." });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "composer remains usable after native attachment refusal");
    assert.ok(!requests.at(-1).messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image")));
  }
  if (claude && process.env.NATIVE_TERMINAL_SKILLS === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before selected skill");
    const count = requests.length;
    await api("/api/session/message", { thread_id: thread, text: "NATIVE_SKILL_ARGS", skill: { name: "native-fixture" } });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "selected native skill finishes");
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("NATIVE_SKILL_APPLIED"), "the native CLI must expand the selected skill");
    assert.ok(JSON.stringify(requests.at(-1).messages).includes("NATIVE_SKILL_ARGS"));
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "/native-fixture UNADMITTED_SKILL_ARGS" });
    await sleep(300);
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\r" });
    await until(async () => {
      const frame = await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.terminal_id });
      return Buffer.from(frame.data, "base64").toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "").includes("UsetheSealwire");
    }, "an earlier skill selection must not authorize later native commands");
    assert.equal(requests.length, count + 1);
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT after the selected skill." });
    await until(async () => requests.length === count + 2 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "composer remains usable after selected skill");
  }
  if (emptyStart) {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "first native turn idle");
    const resumed = await api("/api/session/resume", { thread_id: thread });
    assert.equal(resumed.active_thread_id, thread);
    const transcript = await api(`/api/threads/${thread}/transcript`);
    assert.equal(transcript.entries.filter((e) => e.kind === "user_text" && e.text?.includes("NATIVE_INPUT")).length, 1, "native history must retain one canonical user uuid");
    assert.equal((await api("/api/threads")).threads.filter((e) => e.id === thread).length, 1);
  }
  if (claude && process.env.NATIVE_TERMINAL_IMAGES === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "native idle");
    await api("/api/session/message", { thread_id: thread, text: "Describe the attached image briefly.", images: [{ data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" }] });
    await until(async () => { await read(); return requests.length === 3; }, "native GUI image inference");
    assert.ok(requests.at(-1).messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image")), "the native model must receive actual image bytes");
  }
  if (claude && process.env.NATIVE_TERMINAL_QUESTIONS === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before native question");
    const count = requests.length;
    await api("/api/session/message", { thread_id: thread, text: "NATIVE_QUESTION: ask me to choose a fixture option." });
    const pending = await until(async () => (await api("/api/session")).pending_ask_user_questions.find((q) => q.questions.some((item) => item.question === "Which fixture option?")), "native question reaches shared card");
    assert.deepEqual(pending.questions[0].options.map((item) => item.label), ["Alpha", "Beta"]);
    await api(`/api/ask-user-questions/${encodeURIComponent(pending.request_id)}/answer`, { answers: { "Which fixture option?": "Beta" } });
    await until(async () => requests.length === count + 2 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "native turn receives shared answer");
    assert.ok(requests.at(-1).messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && JSON.stringify(b.content).includes("Beta"))), "native model must receive the selected answer");
  }
  if (claude && process.env.NATIVE_TERMINAL_HISTORY === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before recalled shell command");
    for (const data of ["\x1b[A", "\x1b[A", "\r"]) {
      await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data });
      await sleep(400);
    }
    await read();
    await until(async () => await fs.readFile(path.join(workspace, "history-bang.txt"), "utf8").catch(() => null) === "HISTORY_BYPASS", "YOLO recalled shell command runs directly");
    const count = requests.length;
    assert.equal((await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, null);
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT after the recalled shell command." });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "workflow messages remain usable after shell history");
  }
  if (claude && process.env.NATIVE_TERMINAL_CONTROL === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before control test");
    await api("/api/session/message", { thread_id: thread, text: "CLOSE_WHILE_RUNNING control test one." });
    await until(async () => requests.length === 3 && (await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "native control target running");
    const stopSequence = inputSeq + 1;
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\x03" });
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "Ctrl+C through common stop");
    await api("/api/session/message", { thread_id: thread, text: "CLOSE_WHILE_RUNNING control test two." });
    await until(async () => requests.length === 4 && (await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "second native turn");
    const retry = await fetch(base + "/api/session/terminal/input", { method: "POST", headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: JSON.stringify({ thread_id: thread, device_id: "native-terminal-e2e", terminal_id: terminal.terminal_id, data: "\x03", input_stream_id: "e2e", input_seq: stopSequence }) });
    assert.equal(retry.ok, true);
    assert.ok((await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "a replayed stop must not interrupt a later turn");
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\x1b" });
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "Esc through common stop");
    await read();
  }
  if (claude && process.env.NATIVE_TERMINAL_SLASH === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before slash command");
    const response = await fetch(base + "/api/session/message", { method: "POST", headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: JSON.stringify({ thread_id: thread, device_id: "native-terminal-e2e", text: "/clear" }) });
    assert.equal(response.ok, false, "a managed prompt must not run an independent session command");
    await api("/api/session/message", { thread_id: thread, text: "Reply AFTER_REFUSED_CLEAR to prove the same native session is usable." });
    await until(async () => requests.length === 3 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "native session retained after rejected clear");
  }
  if (claude && process.env.NATIVE_TERMINAL_MODEL_CHANGE === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before model change");
    const previousTerminal = terminal.terminal_id;
    await api("/api/session/settings", { thread_id: thread, model: "sonnet", effort: "low" });
    await api("/api/session/message", { thread_id: thread, text: "Check model settings after changing from Haiku." });
    await until(async () => { await read(); return requests.length === 3 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id; }, "model change on same native session");
    assert.notEqual(terminal.terminal_id, previousTerminal);
    assert.match(requests.at(-1).model, /^claude-sonnet/);
  }
  if (claude && process.env.NATIVE_TERMINAL_BANG === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before shell shortcut");
    await api("/api/session/message", { thread_id: thread, text: "!printf NATIVE_BANG > native-gui-bang.txt" });
    await until(async () => { await read(); return requests.length === 3 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id; }, "literal exclamation through common composer");
    assert.equal(await fs.readFile(path.join(workspace, "native-gui-bang.txt"), "utf8").catch(() => null), null);
    const count = requests.length;
    for (const data of ["!", "printf NATIVE_BANG > native-bang.txt", "\r"]) {
      await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data });
      await sleep(400);
    }
    await until(async () => await fs.readFile(path.join(workspace, "native-bang.txt"), "utf8").catch(() => null) === "NATIVE_BANG", "YOLO native shell runs directly");
    assert.equal(requests.length, count, "manual shell must not be counted as model inference");
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT after the manual shell command." });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "managed messages still work after manual shell");
    await read();
    for (const data of ["!", "sleep 30; printf SHOULD_NOT_FINISH > interrupted-shell.txt", "\r"]) {
      await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data });
      await sleep(400);
    }
    await sleep(600);
    await api("/api/session/terminal/input", { thread_id: thread, terminal_id: terminal.terminal_id, data: "\x03" });
    await sleep(1000);
    await read();
    const afterShell = requests.length;
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT after interrupting the manual shell." });
    await until(async () => requests.length === afterShell + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "Ctrl+C interrupts the manual shell without blocking managed messages");
    assert.equal(await fs.access(path.join(workspace, "interrupted-shell.txt")).then(() => true, () => false), false);
    await read();
  }
  const resumed = await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.terminal_id });
  assert.equal(resumed.reset, true);
  assert.ok(Buffer.from(resumed.data, "base64").length);
  if (process.env.NATIVE_TERMINAL_CONTROL !== "1") {
    const marker = process.env.NATIVE_TERMINAL_POLICY === "1" || process.env.NATIVE_TERMINAL_SKILLS === "1" ? "SEALWIRE_TERMINAL_READY" : "NATIVE_INPUT_ACCEPTED";
    await until(async () => {
      const frame = await api("/api/session/terminal/read", { thread_id: thread, terminal_id: terminal.terminal_id });
      return Buffer.from(frame.data, "base64").toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "").includes(marker);
    }, "completed answer renders in the native screen");
  }
  if (process.env.NATIVE_TERMINAL_BROWSER === "1" || brokerPort) {
    let context;
    ({ browser, context } = await launchBrowser());
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__terminalStyleViolations = [];
      addEventListener("securitypolicyviolation", (event) => { if (event.effectiveDirective.startsWith("style-src")) window.__terminalStyleViolations.push(event.effectiveDirective); });
    });
    await page.goto(base);
    await page.locator(`[data-open-thread-id="${thread}"]`).first().click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.locator(".native-terminal canvas").first().waitFor();
    await page.getByText("Live terminal", { exact: true }).waitFor();
    const waitForFit = async () => {
      await page.waitForFunction(() => {
        const screen = document.querySelector(".native-terminal .xterm-screen");
        const mount = document.querySelector(".native-terminal-screen");
        return screen && mount && screen.getBoundingClientRect().width <= mount.clientWidth && screen.getBoundingClientRect().width > mount.clientWidth * 0.7;
      });
      await page.evaluate(() => document.fonts.ready);
      await sleep(500);
    };
    await waitForFit();
    assert.equal(await page.locator(".native-terminal .xterm-rows").count(), 0, "the canvas renderer must replace DOM text rendering");
    await page.screenshot({ path: path.join(root, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFit();
    await page.screenshot({ path: path.join(root, "mobile.png"), fullPage: true });
    const metrics = await page.evaluate(() => [".native-terminal", ".native-terminal-screen", ".xterm-screen", ".xterm-rows", ".native-terminal-keys"].map((selector) => {
      const node = document.querySelector(selector); const style = node && getComputedStyle(node); const rect = node?.getBoundingClientRect();
      return { selector, width: rect?.width, height: rect?.height, fontFamily: style?.fontFamily, fontSize: style?.fontSize, overflow: style?.overflow };
    }));
    await fs.writeFile(path.join(root, "metrics.json"), JSON.stringify(metrics, null, 2));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, "terminal view must not overflow the mobile page");
    if (brokerPort) {
      await page.setViewportSize({ width: 1280, height: 900 });
      const pairing = await startPairingFromLocalPage(page, { lanIp: "127.0.0.1", brokerPort, timeoutMs: 30000 });
      const phone = await context.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(pairing);
      await approvePairing(page, 30000);
      await waitForPairedRemote(phone, 30000);
      await closeSecurityModal(page, 30000);
      await selectFirstRelayIfNeeded(phone, 30000);
      if (!(await phone.getByRole("button", { name: "Terminal", exact: true }).count())) {
        await phone.locator("#remote-nav-toggle-button").click();
        await phone.locator(`#remote-threads-list [data-thread-id="${thread}"]`).first().click();
      }
      await phone.getByRole("button", { name: "Terminal", exact: true }).click();
      await phone.getByText("Live terminal", { exact: true }).waitFor();
      await phone.locator(".native-terminal .xterm-helper-textarea").focus();
      await phone.keyboard.insertText("Reply to PHONE_NATIVE_INPUT with a short marker.");
      await sleep(600);
      await phone.getByRole("button", { name: "Enter", exact: true }).click();
      await until(async () => {
        const transcript = await api(`/api/threads/${thread}/transcript`);
        return requests.length === 3 && !transcript.thread_state.active_turn_id && transcript.entries.some((entry) => entry.kind === "user_text" && entry.text?.includes("PHONE_NATIVE_INPUT"));
      }, "encrypted phone terminal input");
      const remoteDevice = await phone.evaluate(() => Object.values(JSON.parse(localStorage.getItem("agent-relay.remote-state")).remoteProfiles)[0].deviceId);
      assert.equal((await api("/api/session")).active_controller_device_id, remoteDevice, "native turns must use the signed phone identity");
      assert.equal(requests.length, 3, "phone input must start exactly one turn");
      await sleep(500);
      await phone.screenshot({ path: path.join(root, "phone-remote.png"), fullPage: true });
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.ok(!broker._logBuffer.join("\n").includes("PHONE_NATIVE_INPUT"), "broker logs must not contain terminal input");
      if (claude && process.env.NATIVE_TERMINAL_MODEL_UI === "1") {
        const prior = await api("/api/session/terminal/open", { thread_id: thread });
        await api("/api/session/settings", { thread_id: thread, model: "sonnet", effort: "low" });
        await api("/api/session/message", { thread_id: thread, text: "Confirm GUI_AFTER_MODEL_SWITCH briefly." });
        await until(async () => requests.length === 4 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "GUI model change");
        await sleep(1500);
        await phone.locator(".native-terminal .xterm-helper-textarea").focus();
        await phone.keyboard.insertText("Reply to PHONE_NATIVE_INPUT after the model change.");
        await sleep(600);
        await phone.getByRole("button", { name: "Enter", exact: true }).click();
        await until(async () => requests.length === 5 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "phone follows reconfigured CLI");
        assert.match(requests.at(-1).model, /^claude-sonnet/);
        const next = await api("/api/session/terminal/open", { thread_id: thread });
        assert.notEqual(next.terminal_id, prior.terminal_id);
        assert.equal((await api("/api/session")).active_controller_device_id, remoteDevice);
        assert.equal(await phone.locator(".native-terminal-error").count(), 0);
        await phone.screenshot({ path: path.join(root, "phone-model-change.png"), fullPage: true });
        assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      const beforeCloseRequests = requests.length;
      await api("/api/session/message", { thread_id: thread, text: "Reply to CLOSE_WHILE_RUNNING with the session completion marker." });
      await until(async () => (await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "turn in flight before closing TUI");
      await phone.getByRole("button", { name: "Close terminal", exact: true }).click();
      await phone.getByText("Terminal closed; session keeps running", { exact: true }).waitFor();
      assert.equal((await api("/api/session")).active_thread_id, thread);
      await until(async () => {
        const transcript = await api(`/api/threads/${thread}/transcript`);
        return !transcript.thread_state.active_turn_id && transcript.entries.some((entry) => entry.kind === "agent_text" && entry.text?.includes("SESSION_CONTINUES_AFTER_TERMINAL_CLOSE"));
      }, "closing native TUI must not stop the agent turn");
      assert.equal(requests.length, beforeCloseRequests + 1);
    }

  }
  if (claude && process.env.NATIVE_TERMINAL_POLICY === "1") {
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "idle before returning to managed permissions");
    await api("/api/session/settings", { thread_id: thread, approval_policy: "never", sandbox: "workspace-write" });
    const refused = await fetch(base + "/api/session/terminal/open", { method: "POST", headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" }, body: JSON.stringify({ thread_id: thread, device_id: "native-terminal-e2e" }) });
    assert.equal(refused.ok, false);
    assert.match((await refused.json()).error.message, /Full access \(YOLO\)/);
    await api("/api/session/message", { thread_id: thread, text: "POLICY_WRITE_OUTSIDE_SDK" });
    const pending = await until(async () => (await api("/api/session")).pending_approvals[0], "returning to Conversation restores SDK approvals");
    await api(`/api/approvals/${encodeURIComponent(pending.request_id)}`, { decision: "deny" });
    await until(async () => !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "SDK denial settles after native handback");
    const count = requests.length;
    await api("/api/session/message", { thread_id: thread, text: "Reply to NATIVE_INPUT in Conversation after leaving YOLO." });
    await until(async () => requests.length === count + 1 && !(await api(`/api/threads/${thread}/transcript`)).thread_state.active_turn_id, "same conversation works after restoring permissions");
    const sessions = (await api("/api/threads")).threads;
    assert.equal(sessions.filter((entry) => entry.id === thread).length, 1);
  }
  }
  console.log(JSON.stringify({ ok: true, thread, terminal_id: terminal?.terminal_id, modelRequests: requests.length, artifacts: root }));
} finally {
  await fs.writeFile(path.join(root, "requests-summary.json"), JSON.stringify(requests.map((r) => ({ model: r.model, last: (r.messages || []).filter((m) => m.role === "user").at(-1)?.content?.filter?.((b) => b.type === "text").at(-1)?.text })), null, 2));
  await fs.writeFile(path.join(root, "terminal.ansi"), output);
  await fs.writeFile(path.join(root, "relay.log"), relay._logBuffer.join("\n"));
  await browser?.close();
  await stopManagedProcess(relay);
  await stopManagedProcess(broker);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
}
