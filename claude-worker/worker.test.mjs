import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSdkMsgProbe,
  closeSessionEntry,
  createSessionEntry,
  createWorkerSession,
  ensureLiveSession,
  evictSessionsIfNeeded,
  findSessionEntry,
  flushEvents,
  sessionOptionsChanged,
} from "./worker.mjs";

test("buildSdkMsgProbe keeps diagnostics content-free (no prompts/output/errors/paths)", () => {
  // The relay forwards worker stderr into global, client-visible logs, so the
  // SEALWIRE_STREAM_DIAG probe must never carry content-bearing fields.
  const resultProbe = buildSdkMsgProbe({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    num_turns: 1,
    result: "SECRET_ASSISTANT_OUTPUT",
    errors: ["SECRET_ERROR_BODY"],
    session_id: "sess-x",
    usage: { output_tokens: 3 },
  });
  const resultJson = JSON.stringify(resultProbe);
  assert.doesNotMatch(resultJson, /SECRET_ASSISTANT_OUTPUT/);
  assert.doesNotMatch(resultJson, /SECRET_ERROR_BODY/);
  // shape + completion-semantic scalars survive (enough to diagnose terminals)
  assert.equal(resultProbe.type, "result");
  assert.equal(resultProbe.safe.is_error, false);
  assert.equal(resultProbe.safe.stop_reason, "end_turn");
  assert.ok(resultProbe.keys.includes("result")); // a field NAME is fine; its value is not

  // system/init must not leak cwd paths or tool/arg values either.
  const initProbe = buildSdkMsgProbe({
    type: "system",
    subtype: "init",
    cwd: "/secret/workspace/path",
    tools: ["Bash", "Edit"],
    model: "claude-secret",
  });
  const initJson = JSON.stringify(initProbe);
  assert.doesNotMatch(initJson, /secret\/workspace\/path/);
  assert.doesNotMatch(initJson, /claude-secret/);
});

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
        { type: "system", subtype: "session_state_changed", state: "idle" },
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

// A fake SDK whose query() records the options it was booted with and blocks
// (like a live session awaiting input) until interrupt(), so we can observe
// whether ensureLiveSession reuses or rebuilds the underlying query.
function makeFakeSdk() {
  const queries = [];
  return {
    queries,
    query({ options }) {
      let release = () => {};
      const ended = new Promise((resolve) => {
        release = resolve;
      });
      const record = { options, resume: options.resume ?? null, interrupted: false };
      queries.push(record);
      return {
        async *[Symbol.asyncIterator]() {
          await ended; // mimic an idle live session: yield nothing until closed
        },
        interrupt() {
          record.interrupted = true;
          release();
        },
      };
    },
  };
}

function rebuildContext() {
  return { pendingApprovals: new Map(), pendingAskUserQuestions: new Map() };
}

test("sessionOptionsChanged flags permissionMode/model but ignores an omitted model", () => {
  assert.equal(
    sessionOptionsChanged({ permissionMode: "default" }, { permissionMode: "bypassPermissions" }),
    true,
  );
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", model: "a" },
      { permissionMode: "default", model: "b" },
    ),
    true,
  );
  // A resume command omits model — that must not be read as a change.
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", model: "a" },
      { permissionMode: "default" },
    ),
    false,
  );
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", model: "a" },
      { permissionMode: "default", model: "a" },
    ),
    false,
  );
  assert.equal(sessionOptionsChanged(null, { permissionMode: "x" }), false);
});

test("ensureLiveSession rebuilds the SDK query when a thread flips to YOLO", async () => {
  const sdk = makeFakeSdk();
  const sessions = new Map();
  const context = rebuildContext();
  const entry = createSessionEntry({
    key: "session:sess-1",
    providerSessionId: "sess-1",
    cmd: { cwd: "/tmp", model: "claude-sonnet-4-6" },
  });
  entry.options = {
    cwd: "/tmp",
    permissionMode: "default",
    model: "claude-sonnet-4-6",
    canUseTool: () => {},
  };
  sessions.set(entry.key, entry);

  await captureStdout(async () => {
    // Boot the initial default-mode session.
    await ensureLiveSession(sdk, sessions, entry, context, "sess-1", entry.options);
    assert.equal(sdk.queries.length, 1);
    assert.equal(sdk.queries[0].options.permissionMode, "default");

    // Re-sending with identical options must reuse the live session, not rebuild.
    await ensureLiveSession(sdk, sessions, entry, context, "sess-1", {
      cwd: "/tmp",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      canUseTool: () => {},
    });
    assert.equal(sdk.queries.length, 1);

    // Flip to bypassPermissions → tear down + rebuild, resuming the same session.
    await ensureLiveSession(sdk, sessions, entry, context, "sess-1", {
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: "claude-sonnet-4-6",
      canUseTool: () => {},
    });
  });

  assert.equal(sdk.queries.length, 2);
  assert.equal(sdk.queries[0].interrupted, true);
  assert.equal(sdk.queries[1].options.permissionMode, "bypassPermissions");
  assert.equal(sdk.queries[1].options.allowDangerouslySkipPermissions, true);
  assert.equal(sdk.queries[1].resume, "sess-1");
  assert.equal(entry.options.permissionMode, "bypassPermissions");

  closeSessionEntry(entry);
});

test("ensureLiveSession rebuilds on a model switch and preserves model when omitted", async () => {
  const sdk = makeFakeSdk();
  const sessions = new Map();
  const context = rebuildContext();
  const entry = createSessionEntry({
    key: "session:sess-2",
    providerSessionId: "sess-2",
    cmd: { cwd: "/tmp", model: "claude-opus-4-6" },
  });
  entry.options = {
    cwd: "/tmp",
    permissionMode: "default",
    model: "claude-opus-4-6",
    canUseTool: () => {},
  };
  sessions.set(entry.key, entry);

  await captureStdout(async () => {
    await ensureLiveSession(sdk, sessions, entry, context, "sess-2", entry.options);

    // Same mode, different model → rebuild with the new model.
    await ensureLiveSession(sdk, sessions, entry, context, "sess-2", {
      cwd: "/tmp",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      canUseTool: () => {},
    });
    assert.equal(sdk.queries.length, 2);
    assert.equal(sdk.queries[1].options.model, "claude-sonnet-4-6");

    // Resume-style change (mode flips, model omitted) must keep the live model.
    await ensureLiveSession(sdk, sessions, entry, context, "sess-2", {
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: () => {},
    });
  });

  assert.equal(sdk.queries.length, 3);
  assert.equal(sdk.queries[2].options.permissionMode, "bypassPermissions");
  assert.equal(sdk.queries[2].options.model, "claude-sonnet-4-6");

  closeSessionEntry(entry);
});
