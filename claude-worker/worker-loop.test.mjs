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

function spawnWorker(extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER], {
    env: {
      ...process.env,
      CLAUDE_WORKER_SDK_MODULE: FAKE_SDK,
      ...extraEnv,
    },
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
const isStopped = (event) => event.type === "session_stopped";

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

test("send emits user_message with relay-provided transcript ids", async () => {
  const worker = spawnWorker();
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(isDone, { label: "done#1" });

    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      prompt: "second",
      turn_id: "relay-turn-1",
      user_item_id: "user:relay-turn-1",
    });

    const userMessage = await worker.waitFor(
      (event) =>
        event.type === "user_message" &&
        event.provider_session_id === "sess-1" &&
        event.text === "second",
      { label: "second user_message" },
    );
    assert.equal(userMessage.item_id, "user:relay-turn-1");
    assert.equal(userMessage.turn_id, "relay-turn-1");
    const done = await worker.waitFor(
      (event) =>
        event.type === "done"
        && event.provider_session_id === "sess-1"
        && event.turn_id === "relay-turn-1",
      { label: "second done with relay turn id" },
    );
    assert.equal(done.turn_id, "relay-turn-1");
  } finally {
    await worker.close();
  }
});

test("a turn's trailing idle never completes a later relay turn (idle is non-terminal)", async () => {
  // Turn A settles on its `result`; a `session_state_changed: idle` then arrives
  // late (150ms). Because idle is non-terminal it must do nothing — in
  // particular it must never leak across to complete the next turn B. (Turn B is
  // held with no terminal, so the only thing that could spuriously finish it is
  // A's trailing idle.)
  const worker = spawnWorker({
    CLAUDE_FAKE_FIRST_TURN_LATE_IDLE_MS: "150",
    CLAUDE_FAKE_HOLD_AFTER_FIRST: "1",
  });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-a" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(
      (event) => event.type === "done" && event.turn_id === "relay-turn-a",
      { label: "turn A done" },
    );

    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      prompt: "second",
      turn_id: "relay-turn-b",
      user_item_id: "user:relay-turn-b",
    });
    await worker.waitFor(
      (event) => event.type === "user_message" && event.turn_id === "relay-turn-b",
      { label: "turn B user message" },
    );

    await assert.rejects(
      worker.waitFor(
        (event) => event.type === "done" && event.turn_id === "relay-turn-b",
        { timeoutMs: 400, label: "unexpected turn B completion" },
      ),
      /timed out/,
    );
  } finally {
    await worker.close();
  }
});

test("result settles the turn even when the SDK stream then closes", async () => {
  // CLAUDE_FAKE_END_AFTER_RESULT emits `result` and then closes the stream.
  // `result` is the authoritative terminal, so the turn completes via `done`
  // (NOT session_stopped): the stream closing afterwards is not an "unexpected"
  // end because the turn has already settled.
  const worker = spawnWorker({ CLAUDE_FAKE_END_AFTER_RESULT: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-stream-end" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    const done = await worker.waitFor(
      (event) =>
        event.type === "done"
        && event.provider_session_id === "sess-1"
        && event.turn_id === "relay-turn-stream-end",
      { label: "result-terminated done" },
    );
    assert.equal(done.turn_id, "relay-turn-stream-end");
  } finally {
    await worker.close();
  }
});

test("a stream that ends with no terminal at all still settles via session_stopped", async () => {
  // The settleUnexpectedStreamEnd safety net: if the SDK stream closes while a
  // turn is genuinely in flight (no `result`, no `idle`), the worker must still
  // settle the turn with a matching turn_id so the relay can clear it.
  const worker = spawnWorker({ CLAUDE_FAKE_END_WITHOUT_TERMINAL: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-abrupt-end" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    const stopped = await worker.waitFor(
      (event) =>
        event.type === "session_stopped"
        && event.turn_id === "relay-turn-abrupt-end",
      { label: "abrupt-end session_stopped" },
    );
    assert.equal(stopped.turn_id, "relay-turn-abrupt-end");
  } finally {
    await worker.close();
  }
});

test("result completes the turn even though the SDK never emits idle (real SDK sequence)", async () => {
  // ⚠️ REGRESSION LOCK for the "turn ended but the UI still shows streaming" bug.
  // CLAUDE_FAKE_KEEP_OPEN_AFTER_RESULT reproduces the REAL SDK end-of-turn
  // sequence: emit `result`, then keep the stream OPEN and never send
  // `session_state_changed: idle` (verified by driving the real SDK through
  // worker.mjs). `result` must settle the turn with a matching turn_id —
  // otherwise the relay's active_turn_id is never cleared and the thread is
  // stuck "streaming" until the 10-minute watchdog. Before changing this, read
  // the warning in sdk-mapping.test.mjs and actually re-test the real SDK.
  const worker = spawnWorker({ CLAUDE_FAKE_KEEP_OPEN_AFTER_RESULT: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-result-terminal" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    const done = await worker.waitFor(
      (event) =>
        event.type === "done" && event.turn_id === "relay-turn-result-terminal",
      { label: "result-terminated done" },
    );
    assert.equal(done.turn_id, "relay-turn-result-terminal");
  } finally {
    await worker.close();
  }
});

test("a failed result emits error and done with the same session/turn identity (sanitized)", async () => {
  // A failing turn must terminate AND be visibly a failure, with `error` and the
  // settling `done` carrying the same turn/session id so the relay routes both
  // to the right thread. The error message must be sanitized (no raw provider
  // content) — the fake injects RAW_* sentinels that must not appear.
  const worker = spawnWorker({ CLAUDE_FAKE_ERROR_RESULT: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-err" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    const error = await worker.waitFor(
      (event) => event.type === "error" && event.turn_id === "relay-turn-err",
      { label: "error event" },
    );
    const done = await worker.waitFor(
      (event) => event.type === "done" && event.turn_id === "relay-turn-err",
      { label: "settling done" },
    );
    // same identity on both
    assert.equal(error.turn_id, done.turn_id);
    assert.equal(error.provider_session_id, "sess-1");
    assert.equal(done.provider_session_id, "sess-1");
    // sanitized: no raw provider content leaked into the message
    assert.doesNotMatch(error.message || "", /RAW_PROVIDER_ERROR_BODY/);
    assert.doesNotMatch(error.message || "", /RAW_PARTIAL_ASSISTANT_OUTPUT/);
    assert.match(error.message || "", /Claude turn failed/);
    // The settling `done` itself flags the failure (so the relay can render a
    // durable transcript failure entry, not just an operator-only log line) and
    // its reason is the SAME sanitized string — never raw provider content.
    assert.equal(done.failed, true);
    assert.match(done.reason || "", /Claude turn failed/);
    assert.doesNotMatch(done.reason || "", /RAW_PROVIDER_ERROR_BODY/);
    assert.doesNotMatch(done.reason || "", /RAW_PARTIAL_ASSISTANT_OUTPUT/);
  } finally {
    await worker.close();
  }
});

test("a replayed result uuid does not complete a later turn (dedup)", async () => {
  // CLAUDE_FAKE_REPLAY_RESULT_UUID emits the SAME result uuid on every turn.
  // Turn A settles on the first occurrence; when turn B sends, the replayed
  // (same-uuid) result must be DROPPED, so it cannot prematurely complete B —
  // which would otherwise let the relay admit another prompt mid-turn.
  const worker = spawnWorker({ CLAUDE_FAKE_REPLAY_RESULT_UUID: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-dup-a" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(
      (event) => event.type === "done" && event.turn_id === "relay-turn-dup-a",
      { label: "turn A done" },
    );

    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      prompt: "second",
      turn_id: "relay-turn-dup-b",
      user_item_id: "user:relay-turn-dup-b",
    });
    await worker.waitFor(
      (event) => event.type === "user_message" && event.turn_id === "relay-turn-dup-b",
      { label: "turn B user message" },
    );

    // The replayed result must NOT complete turn B.
    await assert.rejects(
      worker.waitFor(
        (event) =>
          (event.type === "done" || event.type === "session_stopped")
          && event.turn_id === "relay-turn-dup-b",
        { timeoutMs: 400, label: "unexpected turn B completion from replay" },
      ),
      /timed out/,
    );
  } finally {
    await worker.close();
  }
});

test("send streams a user id that a later history read reproduces", async () => {
  // Regression for the duplicate-user-message bug: the live `user_message`
  // event id and a later `read_session` history read MUST resolve to the same
  // item_id. The relay supplies one uuid as both `user_item_id` (user:<uuid>)
  // and `user_message_uuid`; the worker stamps that uuid onto the SDK message,
  // so getSessionMessages -> mapSessionMessages yields the very same id. If they
  // diverge, the background buffer re-injects the live copy on a thread
  // switch-away-and-back and the message shows up twice.
  const worker = spawnWorker();
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    await worker.waitFor(isDone, { label: "done#1" });

    worker.send({
      type: "send",
      provider_session_id: "sess-1",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      prompt: "second turn",
      turn_id: "claude-turn-7",
      user_item_id: "user:7b3c1d04-1111-4222-8333-444455556666",
      user_message_uuid: "7b3c1d04-1111-4222-8333-444455556666",
    });

    const liveEvent = await worker.waitFor(
      (event) => event.type === "user_message" && event.text === "second turn",
      { label: "live user_message" },
    );
    assert.equal(liveEvent.item_id, "user:7b3c1d04-1111-4222-8333-444455556666");

    worker.send({ type: "read_session", id: "read-1", provider_session_id: "sess-1" });
    const response = await worker.waitFor(
      (event) => event.type === "response" && event.id === "read-1",
      { label: "read_session response" },
    );
    assert.equal(response.ok, true);
    const historyEntry = response.result.transcript.find(
      (entry) => entry.kind === "user_text" && entry.text === "second turn",
    );
    assert.ok(historyEntry, "history read must contain the sent user message");
    assert.equal(
      historyEntry.item_id,
      liveEvent.item_id,
      "live id and history id must match so the message is not duplicated",
    );
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

test("cancel tears the live session down and emits session_stopped", async () => {
  const worker = spawnWorker({ CLAUDE_FAKE_HOLD_TURNS: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-cancel" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });

    worker.send({ type: "cancel", id: "cancel-1", provider_session_id: "sess-1" });
    const stopped = await worker.waitFor(isStopped, { label: "session_stopped" });
    assert.equal(stopped.turn_id, "relay-turn-cancel");
    const response = await worker.waitFor(
      (event) => event.type === "response" && event.id === "cancel-1",
      { label: "cancel response" },
    );
    assert.equal(response.ok, true);

    // No rebuild happened — cancel just tears the one session down.
    assert.equal(worker.queries().length, 1);
  } finally {
    await worker.close();
  }
});

test("duplicate cancel commands share one drain and emit one stopped event", async () => {
  const worker = spawnWorker({
    CLAUDE_FAKE_HOLD_TURNS: "1",
    CLAUDE_FAKE_INTERRUPT_DELAY_MS: "150",
  });
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });

    worker.send({ type: "cancel", id: "cancel-1", provider_session_id: "sess-1" });
    worker.send({ type: "cancel", id: "cancel-2", provider_session_id: "sess-1" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      worker.events.filter(isStopped).length,
      0,
      "a repeated cancel must not report stopped before the shared drain finishes",
    );

    await worker.waitFor(isStopped, { label: "session_stopped" });
    await worker.waitFor(
      (event) => event.type === "response" && event.id === "cancel-1" && event.ok,
      { label: "first cancel response" },
    );
    await worker.waitFor(
      (event) => event.type === "response" && event.id === "cancel-2" && event.ok,
      { label: "second cancel response" },
    );
    assert.equal(worker.events.filter(isStopped).length, 1);
  } finally {
    await worker.close();
  }
});

test("cancel timeout returns an error but emits stopped only after the real drain", async () => {
  const worker = spawnWorker({
    CLAUDE_FAKE_HOLD_TURNS: "1",
    CLAUDE_FAKE_INTERRUPT_DELAY_MS: "200",
    CLAUDE_WORKER_CANCEL_DRAIN_TIMEOUT_MS: "40",
  });
  try {
    worker.send(START_DEFAULT);
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    worker.send({ type: "cancel", id: "cancel-timeout", provider_session_id: "sess-1" });

    const response = await worker.waitFor(
      (event) => event.type === "response" && event.id === "cancel-timeout",
      { label: "cancel timeout response" },
    );
    assert.equal(response.ok, false);
    assert.match(response.error.message, /did not stop/i);
    assert.equal(worker.events.filter(isStopped).length, 0);

    await worker.waitFor(isStopped, { label: "eventual session_stopped" });
    assert.equal(worker.events.filter(isStopped).length, 1);
  } finally {
    await worker.close();
  }
});

test("an SDK-spontaneous turn after done re-arms liveness with a fresh turn id", async () => {
  // The bug this pins: the worker only ever armed a turn from its OWN send/start
  // path. When a background subagent finishes, the SDK injects a
  // `<task-notification>` and continues the conversation itself on the same
  // persistent stream — a turn nobody armed. `done` had already cleared
  // currentTurnId and stopped the progress tracker, so the relay saw a fully
  // streaming turn with no live turn id and showed the thread as idle until the
  // user typed again.
  const worker = spawnWorker({ CLAUDE_FAKE_SPONTANEOUS_TURN: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-1" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });

    const firstDone = await worker.waitFor(isDone, { label: "done#1" });
    assert.equal(firstDone.turn_id, "relay-turn-1", "the relay-armed turn settles under its own id");

    // The SDK continues on its own — the worker must announce the new turn.
    const started = await worker.waitFor((event) => event.type === "turn_started", {
      label: "turn_started",
    });
    assert.equal(started.provider_session_id, "sess-1");
    assert.ok(started.turn_id, "an SDK-started turn must carry a turn id the relay can arm on");
    assert.notEqual(
      started.turn_id,
      "relay-turn-1",
      "a spontaneous turn must get its OWN id, not resurrect the settled one",
    );

    // The turn must be announced BEFORE the output it carries, or the relay
    // would append a transcript entry to a thread it still believes is idle.
    // (Await the text first — turn_started is emitted ahead of it, so its waiter
    // resolving says nothing about the text having arrived yet.)
    const text = await worker.waitFor(
      (event) => event.type === "assistant_message" && event.text === "subagent finished",
      { label: "spontaneous turn text" },
    );
    assert.ok(
      worker.events.indexOf(started) < worker.events.indexOf(text),
      "turn_started must precede the turn's output",
    );

    // ...and it must settle under that same id, or the relay's
    // completion_matches_turn drops the terminal and the thread hangs "running".
    const secondDone = await worker.waitFor(isDone, { count: 2, label: "done#2" });
    assert.equal(
      secondDone.turn_id,
      started.turn_id,
      "the spontaneous turn's terminal must carry the id it was announced with",
    );
  } finally {
    await worker.close();
  }
});

test("a spontaneous turn whose only message is its terminal is still announced", async () => {
  // The no-activity hole in arming: a continuation that fails before emitting
  // any assistant/tool output has NO activity event to arm on, so its terminal
  // used to go out with no turn id. The relay (holding a live turn id) rejects a
  // turn-id-less completion as stale — stranding liveness until the 600s
  // watchdog AND dropping the durable failure entry, which is written only after
  // that guard. The terminal itself has to announce the turn it settles.
  const worker = spawnWorker({ CLAUDE_FAKE_SPONTANEOUS_RESULT_ONLY: "1" });
  try {
    worker.send({ ...START_DEFAULT, turn_id: "relay-turn-1" });
    await worker.waitFor(isStarted("sess-1"), { label: "session_started" });
    const firstDone = await worker.waitFor(isDone, { label: "done#1" });
    assert.equal(firstDone.turn_id, "relay-turn-1");

    const started = await worker.waitFor((event) => event.type === "turn_started", {
      label: "turn_started",
    });
    const secondDone = await worker.waitFor(isDone, { count: 2, label: "done#2" });
    assert.equal(
      secondDone.turn_id,
      started.turn_id,
      "the terminal must settle the turn it announced, so the relay can match it",
    );
    assert.equal(secondDone.failed, true, "the failure must survive the announcement");
    assert.match(
      secondDone.reason || "",
      /Claude turn failed/,
      "the sanitized failure reason must ride the terminal, so the relay can make it durable",
    );
    assert.ok(
      !JSON.stringify(worker.events).includes("RAW_PROVIDER_ERROR_BODY"),
      "raw provider error content must never leave the worker",
    );
  } finally {
    await worker.close();
  }
});
