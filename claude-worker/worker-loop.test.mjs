// Full-command-loop integration tests for the claude worker.
//
// Unlike worker.test.mjs (which calls exported helpers directly), these spawn
// the REAL worker.mjs as a subprocess and drive it over stdin/stdout NDJSON —
// exactly how the Rust relay talks to it — with a fake SDK module swapped in via
// CLAUDE_WORKER_SDK_MODULE (no Anthropic SDK, no API key). The fake prints a
// `__query` marker for every session it creates, so we can assert what options
// the worker actually baked into each (re)build.
//
// This is the layer that catches live-session lifecycle bugs at the seam — e.g.
// a settings change that never reaches an already-running session (the
// YOLO-still-prompts bug that motivated all this).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "worker.mjs");
const FAKE_SDK = path.join(HERE, "test-fake-sdk.mjs");

function spawnWorker() {
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, CLAUDE_WORKER_SDK_MODULE: FAKE_SDK },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume(); // drain diagnostics so the pipe never blocks

  const events = [];
  const waiters = [];
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // diagnostic log line, not a protocol event
      }
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].satisfied()) {
          const waiter = waiters[i];
          waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }
    }
  });

  return {
    events,
    queries: () => events.filter((event) => event.type === "__query"),
    send(cmd) {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    },
    waitFor(predicate, { count = 1, timeoutMs = 4000, label = "event" } = {}) {
      const satisfied = () => events.filter(predicate).length >= count;
      const pick = () => events.filter(predicate)[count - 1];
      if (satisfied()) return Promise.resolve(pick());
      return new Promise((resolve, reject) => {
        const waiter = {
          satisfied,
          resolve: () => resolve(pick()),
          timer: setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(
              new Error(
                `waitFor(${label}, count=${count}) timed out; saw: ` +
                  JSON.stringify(events.map((e) => e.type)),
              ),
            );
          }, timeoutMs),
        };
        waiter.timer.unref?.();
        waiters.push(waiter);
      });
    },
    async close() {
      child.stdin.end();
      const exited = once(child, "exit");
      const guard = setTimeout(() => child.kill("SIGKILL"), 2000);
      guard.unref?.();
      await exited;
      clearTimeout(guard);
    },
  };
}

const isStarted = (sid) => (event) =>
  event.type === "session_started" && event.provider_session_id === sid;
const isDone = (event) => event.type === "done";

const START_DEFAULT = {
  type: "start",
  id: "start-1",
  cwd: "/tmp",
  model: "claude-sonnet-4-6",
  permissionMode: "default",
  prompt: "first turn",
};

test("worker boots a session and acks the first turn", async () => {
  const worker = spawnWorker();
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(isDone, { label: "done" });

    const queries = worker.queries();
    assert.equal(queries.length, 1);
    assert.equal(queries[0].permissionMode, "default");
    assert.equal(queries[0].model, "claude-sonnet-4-6");
    assert.equal(queries[0].resume, null);
  } finally {
    await worker.close();
  }
});

test("flipping a live session to YOLO rebuilds the SDK query with bypass + resume", async () => {
  const worker = spawnWorker();
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started#1" });
    await worker.waitFor(isDone, { label: "done#1" });
    assert.equal(worker.queries().length, 1);

    // The user flips the thread to YOLO; the relay sends the next turn with the
    // new permission mode. The live session must be rebuilt, not reused.
    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      prompt: "second turn in YOLO",
    });
    // The rebuilt query re-announces the resumed session → a 2nd session_started.
    await worker.waitFor(isStarted("sess-1"), { count: 2, label: "session_started#2" });

    const queries = worker.queries();
    assert.equal(queries.length, 2, "expected a rebuilt query");
    assert.equal(queries[1].permissionMode, "bypassPermissions");
    assert.equal(
      queries[1].allowDangerouslySkipPermissions,
      true,
      "rebuild must opt into the dangerous-skip flag the SDK requires for bypass",
    );
    assert.equal(queries[1].resume, "sess-1", "rebuild must resume to preserve context");
  } finally {
    await worker.close();
  }
});

test("re-sending with unchanged settings reuses the live session (no churn)", async () => {
  const worker = spawnWorker();
  try {
    worker.send({ ...START_DEFAULT, permissionMode: "bypassPermissions" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(isDone, { count: 1, label: "done#1" });

    // Same mode + model → must NOT rebuild; the existing session handles the turn.
    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      prompt: "second",
    });
    await worker.waitFor(isDone, { count: 2, label: "done#2" });

    assert.equal(worker.queries().length, 1, "unchanged settings must reuse the session");
  } finally {
    await worker.close();
  }
});

test("switching the model on a live session rebuilds the query", async () => {
  const worker = spawnWorker();
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started#1" });
    await worker.waitFor(isDone, { label: "done#1" });

    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-opus-4-6",
      permissionMode: "default",
      prompt: "second",
    });
    await worker.waitFor(isStarted("sess-1"), { count: 2, label: "session_started#2" });

    const queries = worker.queries();
    assert.equal(queries.length, 2);
    assert.equal(queries[1].model, "claude-opus-4-6");
    assert.equal(queries[1].resume, "sess-1");
  } finally {
    await worker.close();
  }
});

test("cancel tears the live session down and emits a done", async () => {
  const worker = spawnWorker();
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(isDone, { label: "turn done" });

    worker.send({ type: "cancel", provider_session_id: "sess-1" });
    await worker.waitFor(isDone, { count: 2, label: "cancel done" });

    // No rebuild happened — cancel just tears the one session down.
    assert.equal(worker.queries().length, 1);
  } finally {
    await worker.close();
  }
});
