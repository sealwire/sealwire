// End-to-end test for the two cross-agent review BRIEFING modes, over the real
// relay HTTP API with the fake provider (no browser / Playwright):
//
//   recap_source: "recap"        -> the relay drives a recap TURN on the parent,
//                                   then briefs the reviewer with that recap.
//   recap_source: "last_message" -> the relay SKIPS the recap turn and briefs the
//                                   reviewer with the parent's last message (saves a
//                                   whole parent turn). Falls back to a recap turn
//                                   when the parent has no usable message.
//
// This complements the in-process Rust tests (state/app/tests.rs) by exercising the
// full path: HTTP `/api/session/review` -> orchestrator -> fake provider -> the
// parent/reviewer transcripts read back over HTTP.
//
// Run: node scripts/review-recap-modes-e2e.mjs   (or `npm run test:review-recap-modes`)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.REVIEW_MODES_E2E_TIMEOUT_MS || 60000);
const DEVICE = "review-modes-e2e";
const RECAP_PROMPT_MARKER = "recap the changes"; // from parent_recap_prompt(): the recap turn ran
const RECAP_CONTENT_MARKER = "Goal you were implementing"; // distinctive recap-body line
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-review-modes-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  // Build once, then spawn the relay BINARY directly. `cargo run` wraps the server in
  // a cargo process that doesn't forward SIGTERM, so teardown would orphan the relay
  // (and hold the port) on local runs; spawning the prebuilt binary lets
  // stopManagedProcess actually reach the server.
  await buildRelay();
  const relayBin = path.join(ROOT, "target", "debug", "relay-server");
  const relay = spawnManagedProcess("relay", relayBin, [], {
    AGENT_PROVIDERS: "fake",
    PORT: String(relayPort),
    RELAY_STATE_PATH: statePath,
  });

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

    // --- Mode A: recap (drives a recap turn on the parent) ---------------------
    const recapCwd = await makeProjectDir(stateDir, "recap");
    const recap = await runReview(relayPort, { cwd: recapCwd, recapSource: "recap" });
    assert.equal(
      recap.job.status,
      "complete",
      `recap-mode review should complete (status=${recap.job.status}, error=${recap.job.error})`
    );
    assert.ok(
      recap.parentEntries.some((entry) => (entry.text || "").includes(RECAP_PROMPT_MARKER)),
      "recap mode must drive a recap turn on the parent (the recap prompt should appear in the parent transcript)"
    );
    // ...and the reviewer was briefed with the recap CONTENT, not merely that a turn
    // ran. The fake echoes the recap prompt, so a distinctive recap-body line lands in
    // the reviewer's prompt — symmetric with the mode-B briefing-source assertion.
    assert.ok(recap.job.reviewer_thread_id, "recap-mode review should have a reviewer thread");
    const recapReviewerEntries = await transcriptEntries(relayPort, recap.job.reviewer_thread_id);
    assert.ok(
      recapReviewerEntries.some((entry) => (entry.text || "").includes(RECAP_CONTENT_MARKER)),
      "recap mode must brief the reviewer with the recap content"
    );

    // --- Mode B: last_message (skips recap; briefs with the parent's last msg) --
    const lastCwd = await makeProjectDir(stateDir, "last");
    const seed = "E2E_SEED_LAST_MESSAGE_payload_42";
    const last = await runReview(relayPort, {
      cwd: lastCwd,
      recapSource: "last_message",
      seedMessage: seed,
    });
    assert.equal(
      last.job.status,
      "complete",
      `last_message-mode review should complete (status=${last.job.status}, error=${last.job.error})`
    );
    assert.ok(
      last.parentEntries.every((entry) => !(entry.text || "").includes(RECAP_PROMPT_MARKER)),
      "last_message mode must NOT drive a recap turn on the parent"
    );
    assert.ok(last.job.reviewer_thread_id, "the review should have a reviewer thread");
    const reviewerEntries = await transcriptEntries(relayPort, last.job.reviewer_thread_id);
    assert.ok(
      reviewerEntries.some((entry) => (entry.text || "").includes(seed)),
      "last_message mode must brief the reviewer with the parent's last message (the seed text should appear in the reviewer's prompt)"
    );

    // --- Mode C: last_message with NO last message -> falls back to a recap turn ---
    const fallbackCwd = await makeProjectDir(stateDir, "fallback");
    const fallback = await runReview(relayPort, { cwd: fallbackCwd, recapSource: "last_message" });
    assert.equal(
      fallback.job.status,
      "complete",
      `last_message fallback review should complete (status=${fallback.job.status}, error=${fallback.job.error})`
    );
    assert.ok(
      fallback.parentEntries.some((entry) => (entry.text || "").includes(RECAP_PROMPT_MARKER)),
      "last_message with no parent message must fall back to a recap turn"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          recap: recap.job.status,
          last_message: last.job.status,
          last_message_fallback: fallback.job.status,
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

// Start a parent session in `cwd`, optionally seed a last message, request a review
// with the given recap mode, wait for it to finish, and return the terminal job +
// the parent's transcript entries.
async function runReview(relayPort, { cwd, recapSource, seedMessage }) {
  const started = await postEnvelope(relayPort, "/api/session/start", {
    device_id: DEVICE,
    cwd,
    provider: "fake",
  });
  assert.ok(started.ok, `start_session failed: ${JSON.stringify(started.error)}`);
  const parentId = started.data?.active_thread_id;
  assert.ok(parentId, "started session should expose an active thread id");

  if (seedMessage) {
    const sent = await postEnvelope(relayPort, "/api/session/message", {
      text: seedMessage,
      device_id: DEVICE,
    });
    assert.ok(sent.ok, `send_message failed: ${JSON.stringify(sent.error)}`);
    await waitForActiveTurnIdle(relayPort);
  }

  const receipt = await postEnvelope(relayPort, "/api/session/review", {
    reviewer_provider: "fake",
    recap_source: recapSource,
    device_id: DEVICE,
  });
  assert.ok(receipt.ok, `request_review failed: ${JSON.stringify(receipt.error)}`);
  const jobId = receipt.data?.review_job_id;
  assert.ok(jobId, "request_review should return a review_job_id");

  const job = await waitForTerminalReview(relayPort, jobId);
  const parentEntries = await transcriptEntries(relayPort, parentId);
  return { parentId, job, parentEntries };
}

async function makeProjectDir(base, name) {
  const dir = path.join(base, `project-${name}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function waitForActiveTurnIdle(relayPort, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await fetchEnvelope(relayPort, "/api/session");
    if (snap.ok && !snap.data?.active_turn_id) {
      return;
    }
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
    const job = (reviews.data || []).find((entry) => entry.id === jobId);
    if (job) {
      lastStatus = job.status;
      if (terminal.has(job.status)) {
        return job;
      }
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for review ${jobId} to finish (last status: ${lastStatus})`);
}

async function transcriptEntries(relayPort, threadId) {
  const payload = await fetchEnvelope(
    relayPort,
    `/api/threads/${encodeURIComponent(threadId)}/transcript`
  );
  assert.ok(payload.ok, `transcript fetch failed for ${threadId}: ${JSON.stringify(payload.error)}`);
  return payload.data?.entries || [];
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
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) {
    return;
  }
  console.error(`\n[${child._logName} logs]`);
  console.error(lines.join("\n"));
}

async function waitForHealth(url, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`timed out waiting for health endpoint: ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
