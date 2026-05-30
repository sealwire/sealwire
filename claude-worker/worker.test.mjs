import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionEntry,
  evictSessionsIfNeeded,
  findSessionEntry,
  flushEvents,
} from "./worker.mjs";

async function* streamMessages(messages) {
  for (const message of messages) {
    yield message;
  }
}

function captureStdout(fn) {
  const lines = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      () => lines,
      (error) => {
        throw error;
      },
    )
    .finally(() => {
      process.stdout.write = originalWrite;
    });
}

function makeTracker() {
  const records = [];
  return {
    records,
    stopped: false,
    record(event) {
      records.push(event);
      if (event.type === "done" || event.type === "error") {
        this.stopped = true;
      }
    },
    start() {},
    stop() {
      this.stopped = true;
    },
  };
}

test("findSessionEntry can locate an unpromoted pending thread", () => {
  const sessions = new Map();
  const entry = createSessionEntry({
    key: "pending:req-1",
    cmd: { cwd: "/tmp", pending_thread_id: "claude-pending-1" },
  });
  sessions.set(entry.key, entry);

  assert.equal(findSessionEntry(sessions, "claude-pending-1"), entry);
});

test("evictSessionsIfNeeded does not emit unscoped done for unpromoted sessions", async () => {
  const sessions = new Map();
  for (let i = 0; i < 9; i += 1) {
    const entry = createSessionEntry({
      key: `pending:req-${i}`,
      cmd: { cwd: "/tmp", pending_thread_id: `claude-pending-${i}` },
      pendingStartResponse: { id: `req-${i}`, cwd: "/tmp" },
    });
    sessions.set(entry.key, entry);
  }

  const lines = await captureStdout(() => {
    evictSessionsIfNeeded(sessions, {
      pendingApprovals: new Map(),
      pendingAskUserQuestions: new Map(),
    });
  });

  assert.equal(sessions.size, 8);
  const events = lines.map((line) => JSON.parse(line));
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(events.some((event) => event.id && event.error), true);
});

test("flushEvents records liveness against the owning session tracker", async () => {
  const trackerA = makeTracker();
  const trackerB = makeTracker();

  await captureStdout(async () => {
    await flushEvents(
      streamMessages([
        { type: "system", subtype: "init", session_id: "session-a" },
        {
          type: "assistant",
          uuid: "assistant-a",
          message: { content: [{ type: "text", text: "A" }] },
        },
        { type: "result", usage: {} },
      ]),
      { current: false },
      null,
      null,
      null,
      null,
      null,
      trackerA,
    );

    await flushEvents(
      streamMessages([
        { type: "system", subtype: "init", session_id: "session-b" },
        {
          type: "assistant",
          uuid: "assistant-b",
          message: { content: [{ type: "text", text: "B" }] },
        },
      ]),
      { current: false },
      null,
      null,
      null,
      null,
      null,
      trackerB,
    );
  });

  assert.equal(trackerA.stopped, true);
  assert.equal(trackerB.stopped, false);
  assert.deepEqual(
    trackerA.records.map((event) => event.provider_session_id),
    ["session-a", "session-a", "session-a"],
  );
  assert.deepEqual(
    trackerB.records.map((event) => event.provider_session_id),
    ["session-b", "session-b"],
  );
});
