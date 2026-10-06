// End-to-end: a session born in a git worktree keeps Changes + review on that
// tree through a quiet (read-only) turn, and pin/unpin via the local HTTP API
// still overrides/restores it.
//
// Full path: real relay binary + fake provider + real git worktrees —
// `/api/session/start` → message → `/api/thread/workspace` → `/api/workspace/diff`
// → `/api/session/review` → pin/unpin. Complements the in-process race tests
// in state/app/tests.rs (HTTP has no inject for cwd_changed under fake).
//
// Run: node scripts/cwd-drift-e2e.mjs   (or `npm run test:cwd-drift`)

import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.CWD_DRIFT_E2E_TIMEOUT_MS || 90000);
const DEVICE = "cwd-drift-e2e";
const MARKER = "WORKTREE-ONLY-EDIT";
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cwd-drift-e2e-"));
  const statePath = path.join(stateDir, "sealwire.db");
  const { mainCwd, linkedCwd } = await initRepoWithWorktree(stateDir);

  // CI already builds; local runs may not. Skip rebuild when the binary exists
  // and CWD_DRIFT_E2E_SKIP_BUILD=1, otherwise build so a cold checkout works.
  if (process.env.CWD_DRIFT_E2E_SKIP_BUILD !== "1") {
    await buildRelay();
  }

  const relayPort = await getFreePort();
  const relayBin = path.join(ROOT, "target", "debug", "relay-server");
  const relay = spawnManagedProcess("relay", relayBin, [], {
    AGENT_PROVIDERS: "fake",
    PORT: String(relayPort),
    RELAY_STATE_DB: statePath,
  });

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

    // Dirty ONLY the linked worktree so Changes can prove which tree was used.
    await fs.writeFile(path.join(linkedCwd, "seed.txt"), `line1\n${MARKER}\n`, "utf8");

    // Starting an agent in a directory is a deliberate local action, but it is not
    // permission for ambient git probes, so Changes/review degrade to `unavailable`
    // until the repository is granted. Mirror the local UI's explicit trust step, the
    // same way `review-recap-modes-e2e.mjs` does, so this fixture exercises worktree
    // drift instead of the trust refusal path.
    //
    // Granted through the LINKED tree on purpose: trust is a property of the
    // repository, so this one grant must also cover the main worktree the pin step
    // below switches to. `a_repository_and_all_its_worktrees_are_trusted_as_one`
    // pins that same rule in Rust.
    const trusted = await postEnvelope(relayPort, "/api/workspace/trust", {
      cwd: linkedCwd,
    });
    assert.ok(trusted.ok, `workspace trust failed: ${JSON.stringify(trusted.error)}`);

    const started = await postEnvelope(relayPort, "/api/session/start", {
      device_id: DEVICE,
      cwd: linkedCwd,
      provider: "fake",
    });
    assert.ok(started.ok, `start_session failed: ${JSON.stringify(started.error)}`);
    const threadId = started.data?.active_thread_id;
    assert.ok(threadId, "started session should expose an active thread id");
    assert.ok(
      await samePath(started.data?.current_cwd, linkedCwd),
      `birth cwd should be the worktree; got ${started.data?.current_cwd}`
    );

    const sent = await postEnvelope(relayPort, "/api/session/message", {
      text: "summarize the workspace without editing files",
      thread_id: threadId,
      device_id: DEVICE,
    });
    assert.ok(sent.ok, `send_message failed: ${JSON.stringify(sent.error)}`);
    await waitForActiveTurnIdle(relayPort);

    const workspace = await fetchEnvelope(
      relayPort,
      `/api/thread/workspace?thread_id=${encodeURIComponent(threadId)}`
    );
    assert.ok(workspace.ok, `thread workspace failed: ${JSON.stringify(workspace.error)}`);
    assert.ok(
      await samePath(workspace.data?.cwd, linkedCwd),
      `resolved workspace must stay on the worktree after a quiet turn; got ${workspace.data?.cwd}`
    );
    assert.equal(workspace.data?.origin?.kind, "birth");

    const diff = await fetchEnvelope(
      relayPort,
      `/api/workspace/diff?thread_id=${encodeURIComponent(threadId)}`
    );
    assert.ok(diff.ok, `workspace diff failed: ${JSON.stringify(diff.error)}`);
    assert.ok(
      await samePath(diff.data?.cwd, linkedCwd),
      `Changes must open on the worktree; got ${diff.data?.cwd}`
    );
    const diffs = (diff.data?.file_changes || []).map((c) => c.diff || "").join("\n");
    assert.ok(
      diffs.includes(MARKER),
      "Changes on the worktree session must show the worktree-only edit"
    );

    const receipt = await postEnvelope(relayPort, "/api/session/review", {
      reviewer_provider: "fake",
      recap_source: "last_message",
      device_id: DEVICE,
    });
    assert.ok(receipt.ok, `request_review failed: ${JSON.stringify(receipt.error)}`);
    const jobId = receipt.data?.review_job_id;
    assert.ok(jobId, "request_review should return a review_job_id");
    const job = await waitForTerminalReview(relayPort, jobId);
    assert.equal(
      job.status,
      "complete",
      `review should complete (status=${job.status}, error=${job.error})`
    );
    assert.ok(job.reviewer_thread_id, "review should have a reviewer thread");

    const reviewer = await fetchEnvelope(
      relayPort,
      `/api/thread/workspace?thread_id=${encodeURIComponent(job.reviewer_thread_id)}`
    );
    assert.ok(reviewer.ok, `reviewer workspace failed: ${JSON.stringify(reviewer.error)}`);
    assert.ok(
      await samePath(reviewer.data?.cwd, linkedCwd),
      `reviewer must land in the parent's worktree; got ${reviewer.data?.cwd}`
    );

    let mainRoot = null;
    for (const root of workspace.data?.roots || []) {
      if (await samePath(root.path, mainCwd)) {
        mainRoot = root;
        break;
      }
    }
    assert.ok(
      mainRoot,
      `main worktree must be enumerated; roots=${JSON.stringify(workspace.data?.roots)}`
    );
    const pinned = await postEnvelope(relayPort, "/api/thread/workspace", {
      thread_id: threadId,
      cwd: mainRoot.path,
      device_id: DEVICE,
    });
    assert.ok(pinned.ok, `pin failed: ${JSON.stringify(pinned.error)}`);
    assert.equal(pinned.data?.origin?.kind, "pinned");
    assert.ok(
      await samePath(pinned.data?.cwd, mainCwd),
      `pin must move Diff to main; got ${pinned.data?.cwd}`
    );

    const pinnedDiff = await fetchEnvelope(
      relayPort,
      `/api/workspace/diff?thread_id=${encodeURIComponent(threadId)}`
    );
    assert.ok(pinnedDiff.ok, `pinned diff failed: ${JSON.stringify(pinnedDiff.error)}`);
    assert.ok(
      await samePath(pinnedDiff.data?.cwd, mainCwd),
      `pinned Changes must open on main; got ${pinnedDiff.data?.cwd}`
    );
    const pinnedBody = (pinnedDiff.data?.file_changes || []).map((c) => c.diff || "").join("\n");
    assert.ok(
      !pinnedBody.includes(MARKER),
      "pinned Diff on main must not show the worktree-only edit"
    );

    const unpinned = await postEnvelope(relayPort, "/api/thread/workspace", {
      thread_id: threadId,
      cwd: null,
      device_id: DEVICE,
    });
    assert.ok(unpinned.ok, `unpin failed: ${JSON.stringify(unpinned.error)}`);
    assert.ok(
      await samePath(unpinned.data?.cwd, linkedCwd),
      `unpin must restore the worktree; got ${unpinned.data?.cwd}`
    );
    assert.notEqual(unpinned.data?.origin?.kind, "pinned");

    const restoredDiff = await fetchEnvelope(
      relayPort,
      `/api/workspace/diff?thread_id=${encodeURIComponent(threadId)}`
    );
    assert.ok(restoredDiff.ok, `restored diff failed: ${JSON.stringify(restoredDiff.error)}`);
    assert.ok(
      await samePath(restoredDiff.data?.cwd, linkedCwd),
      `unpinned Changes must reopen the worktree; got ${restoredDiff.data?.cwd}`
    );
    const restoredBody = (restoredDiff.data?.file_changes || [])
      .map((c) => c.diff || "")
      .join("\n");
    assert.ok(
      restoredBody.includes(MARKER),
      "after unpin, Changes must again show the worktree-only edit"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          thread_id: threadId,
          worktree: linkedCwd,
          main: mainCwd,
          review_job: job.id,
          reviewer_thread_id: job.reviewer_thread_id,
          checks: [
            "worktree birth survives quiet turn",
            "Changes shows worktree-only edit",
            "reviewer lands in worktree",
            "pin moves Changes to main",
            "unpin restores worktree Changes",
          ],
        },
        null,
        2
      )
    );
  } catch (error) {
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function initRepoWithWorktree(base) {
  const main = path.join(base, "mainwt");
  const linked = path.join(base, "linkedwt");
  await fs.mkdir(main, { recursive: true });
  await git(main, ["init", "-q", "-b", "main"]);
  await git(main, ["config", "user.email", "e2e@example.com"]);
  await git(main, ["config", "user.name", "E2E"]);
  await fs.writeFile(path.join(main, "seed.txt"), "line1\n", "utf8");
  await git(main, ["add", "seed.txt"]);
  await git(main, ["commit", "-q", "-m", "seed"]);
  await git(main, ["worktree", "add", "-q", "-b", "feature", linked]);
  return { mainCwd: main, linkedCwd: linked };
}

async function git(cwd, args) {
  const { stderr } = await execFileAsync("git", args, { cwd });
  if (stderr && /fatal|error:/i.test(stderr)) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function samePath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return ra === rb;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

async function waitForActiveTurnIdle(relayPort, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await fetchEnvelope(relayPort, "/api/session");
    if (snap.ok && !snap.data?.active_turn_id) return;
    await delay(150);
  }
  throw new Error("timed out waiting for the active turn to settle");
}

async function waitForTerminalReview(relayPort, jobId, timeoutMs = TIMEOUT_MS) {
  const terminal = new Set(["complete", "failed", "escalated", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "(none)";
  while (Date.now() < deadline) {
    const reviews = await fetchEnvelope(relayPort, "/api/session/reviews");
    assert.ok(reviews.ok, `review list failed: ${JSON.stringify(reviews.error)}`);
    const jobs = Array.isArray(reviews.data) ? reviews.data : reviews.data?.review_jobs || [];
    const job = jobs.find((entry) => entry.id === jobId);
    if (job) {
      lastStatus = job.status;
      if (terminal.has(job.status)) return job;
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for review ${jobId} (last status: ${lastStatus})`);
}

async function fetchEnvelope(relayPort, pathName) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`);
  return response.json();
}

async function postEnvelope(relayPort, pathName, body = undefined) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

function buildRelay() {
  return new Promise((resolve, reject) => {
    const build = spawn("cargo", ["build", "-p", "relay-server"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    build.on("error", reject);
    build.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`cargo build -p relay-server failed (exit ${code})`))
    );
  });
}

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child._logName = name;
  child._logBuffer = [];
  child.stdout.on("data", (chunk) => appendLog(child, chunk));
  child.stderr.on("data", (chunk) => appendLog(child, chunk));
  managedProcesses.push(child);
  return child;
}

function appendLog(child, chunk) {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
  child._logBuffer.push(...lines);
  if (child._logBuffer.length > 200) {
    child._logBuffer.splice(0, child._logBuffer.length - 200);
  }
}

async function stopManagedProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) return;
  console.error(`\n--- ${child._logName || "process"} log (tail) ---`);
  for (const line of lines.slice(-80)) console.error(line);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(url, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for health at ${url}`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
