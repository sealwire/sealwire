import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createCwdReporter } from "./session-options.mjs";
import {
  buildSdkMsgProbe,
  closeSessionEntry,
  createSessionEntry,
  createWorkerSession,
  releaseSession,
  cwdChangedEvent,
  ensureLiveSession,
  evictSessionsIfNeeded,
  findSessionEntry,
  flushEvents,
  isDeleteSessionNotFoundError,
  sessionOptionsChanged,
  SESSION_LIMIT,
  trackBackgroundTasks,
} from "./worker.mjs";

test("delete-session missing detection accepts only the pinned SDK's exact messages", () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  assert.equal(
    isDeleteSessionNotFoundError(
      new Error(`Session ${sessionId} not found in any project directory`),
      sessionId,
    ),
    true,
  );
  assert.equal(
    isDeleteSessionNotFoundError(
      new Error(`Session ${sessionId} not found in project directory for /tmp/project`),
      sessionId,
    ),
    true,
  );
  assert.equal(
    isDeleteSessionNotFoundError(new Error(`permission denied for ${sessionId}`), sessionId),
    false,
  );
  assert.equal(
    isDeleteSessionNotFoundError(
      new Error("Session aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee not found in any project directory"),
      sessionId,
    ),
    false,
  );
});

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

// Capture the WORKER's stdout without eating the test runner's.
//
// Both go through `process.stdout.write`, and these tests are async, so a naive
// swap swallows whatever node:test reports while the swap is in place. That is
// not a cosmetic loss: under `node --test` it silently dropped 12 of this file's
// 14 results, so a failure in any of them could not fail the gate. (Running the
// file directly showed them, which is what made it invisible.)
//
// The two streams are distinguishable by construction: the worker's protocol is
// NDJSON — `protocol.mjs:emit` writes exactly `JSON.stringify(event) + "\n"` —
// and the runner's output is never a bare JSON value. So capture what parses and
// forward what does not.
function captureStdout(fn) {
  const lines = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // Classify the chunk as a whole and forward it BYTE-FOR-BYTE if it is not
  // ours. Rebuilding a passthrough chunk from split lines corrupts the runner's
  // output (it writes partial lines and ANSI escapes, and may hand us a Buffer).
  const isWorkerOutput = (text) => {
    const candidates = text.split("\n").filter(Boolean);
    if (candidates.length === 0) return false;
    return candidates.every((line) => {
      try {
        return JSON.parse(line) !== null && typeof JSON.parse(line) === "object";
      } catch {
        return false;
      }
    });
  };
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (!isWorkerOutput(text)) return originalWrite(chunk, ...rest);
    lines.push(...text.split("\n").filter(Boolean));
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

// Same as captureStdout but for stderr — the worker's log() (MCP status etc.)
// writes there, which the relay forwards into its log panel.
function captureStderr(fn) {
  const lines = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
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
      process.stderr.write = originalWrite;
    });
}

// Minimal stand-in for an SDK query: eviction and release both close it.
function fakeQuery() {
  return { closed: false, close() { this.closed = true; }, async interrupt() {} };
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

test("flushEvents logs MCP server status from a system/init message", async () => {
  const initMsg = {
    type: "system",
    subtype: "init",
    session_id: "s1",
    model: "m",
    cwd: "/x",
    tools: [],
    mcp_servers: [
      { name: "fs", status: "connected" },
      { name: "github", status: "failed" },
    ],
  };
  let stderr;
  // Swallow the session_started line on stdout; assert on the stderr MCP log.
  await captureStdout(async () => {
    stderr = await captureStderr(async () => {
      await flushEvents(
        streamMessages([initMsg]),
        { current: false },
        null,
        null,
        null,
        null,
        null,
        makeTracker(),
      );
    });
  });
  assert.ok(stderr.includes("MCP: 1/2 server(s) connected"), stderr.join(" | "));
  assert.ok(
    stderr.some((l) => l.includes('MCP server "github" failed to connect')),
    stderr.join(" | "),
  );
});

test("flushEvents emits no MCP log when init has no servers", async () => {
  const initMsg = {
    type: "system",
    subtype: "init",
    session_id: "s1",
    model: "m",
    cwd: "/x",
    tools: [],
  };
  let stderr;
  await captureStdout(async () => {
    stderr = await captureStderr(async () => {
      await flushEvents(
        streamMessages([initMsg]),
        { current: false },
        null,
        null,
        null,
        null,
        null,
        makeTracker(),
      );
    });
  });
  assert.ok(
    !stderr.some((l) => l.startsWith("MCP:")),
    stderr.join(" | "),
  );
});

test("flushEvents emits a queued PostToolUse cwd after the tool result", async () => {
  const order = [];
  const reporter = createCwdReporter((cwd) => order.push(`cwd:${cwd}`));
  reporter.observeCwd("/repo/a", { source: "PostToolUse" });
  assert.deepEqual(order, [], "PostToolUse must not race the tool result");

  await captureStdout(async () => {
    await flushEvents(
      streamMessages([
        {
          type: "user",
          uuid: "user-1",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
          },
        },
      ]),
      { current: false },
      (event) => order.push(event.type),
      null,
      null,
      null,
      null,
      makeTracker(),
      (event) => {
        if (event?.type === "tool_call_result") reporter.flushPostToolCwd(event.id);
        else if (event?.type === "mapped_batch_end") reporter.flushPostToolCwd();
      },
    );
  });

  assert.deepEqual(order, ["tool_call_result", "cwd:/repo/a"]);
});

test("flushEvents emits PostToolUse cwd after a parallel batch of write results", async () => {
  const order = [];
  const reporter = createCwdReporter((cwd) => order.push(`cwd:${cwd}`));
  reporter.observeCwd("/repo/a", { source: "PostToolUse", tool_use_id: "tool-1" });
  reporter.observeCwd("/repo/a", { source: "PostToolUse", tool_use_id: "tool-2" });

  await captureStdout(async () => {
    await flushEvents(
      streamMessages([
        {
          type: "user",
          uuid: "user-1",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
              { type: "tool_result", tool_use_id: "tool-2", content: "ok" },
            ],
          },
        },
      ]),
      { current: false },
      (event) => order.push(event.type),
      null,
      null,
      null,
      null,
      makeTracker(),
      (event) => {
        if (event?.type === "tool_call_result") reporter.flushPostToolCwd(event.id);
        else if (event?.type === "mapped_batch_end") reporter.flushPostToolCwd();
      },
    );
  });

  assert.deepEqual(order, [
    "tool_call_result",
    "cwd:/repo/a",
    "tool_call_result",
    "cwd:/repo/a",
  ]);
  const lastCwd = order.lastIndexOf("cwd:/repo/a");
  const lastResult = order.lastIndexOf("tool_call_result");
  assert.ok(lastCwd > lastResult, "the last cwd must outrank the last write result");
});

test("the live stream flushes PostToolUse cwd after publishing tool_call_result", () => {
  const src = readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");
  const flushAfterResult =
    src.includes('event?.type === "tool_call_result"') &&
    src.includes("entry.flushPostToolCwd?.(event.id)");
  const flushAfterBatch =
    src.includes('event?.type === "mapped_batch_end"') && src.includes("entry.flushPostToolCwd?.()");
  assert.equal(
    flushAfterResult && flushAfterBatch,
    true,
    "PostToolUse cwd has to leave the worker after each result and after the mapped batch",
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

test("sessionOptionsChanged notices a persona swap", () => {
  // systemPrompt is baked into query() like permissionMode and model. Left out
  // of this comparison, a live session silently keeps the OLD persona while the
  // relay believes it sent a new one — the failure is invisible, which is what
  // makes it worth pinning.
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", systemPrompt: "You are the Orchestrator." },
      { permissionMode: "default", systemPrompt: "You are something else." }
    ),
    true
  );
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", systemPrompt: "same" },
      { permissionMode: "default", systemPrompt: "same" }
    ),
    false
  );
  // Absent on both sides is not a change.
  assert.equal(
    sessionOptionsChanged({ permissionMode: "default" }, { permissionMode: "default" }),
    false
  );
  // Omitted systemPrompt on a live command clears the baked persona (rebuild).
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", systemPrompt: "You are the Orchestrator." },
      { permissionMode: "default" },
    ),
    true,
  );
});

test("sessionOptionsChanged compares structured personas by value", () => {
  // REGRESSION (SDK 0.3.267+ / snapshot:false shape): buildSessionOptionsBase
  // mint a fresh `{ type:'custom', prompt, snapshot:false }` object on every
  // send/resume. Reference inequality would tear down the Orchestrator session
  // on every identical turn — latency plus lost process-local state.
  const prev = {
    permissionMode: "default",
    systemPrompt: {
      type: "custom",
      prompt: "You are the Orchestrator.",
      snapshot: false,
    },
  };
  const next = {
    permissionMode: "default",
    systemPrompt: {
      type: "custom",
      prompt: "You are the Orchestrator.",
      snapshot: false,
    },
  };
  assert.notEqual(prev.systemPrompt, next.systemPrompt, "test setup: distinct objects");
  assert.equal(sessionOptionsChanged(prev, next), false);

  assert.equal(
    sessionOptionsChanged(prev, {
      permissionMode: "default",
      systemPrompt: {
        type: "custom",
        prompt: "You are something else.",
        snapshot: false,
      },
    }),
    true,
  );
});

test("sessionOptionsChanged notices a toolset swap", () => {
  const withTools = {
    permissionMode: "acceptEdits",
    mcpServers: { sealwire: { type: "stdio", command: "node", args: ["/x.mjs"] } },
    allowedTools: ["mcp__sealwire__propose_task"],
  };
  assert.equal(sessionOptionsChanged({ permissionMode: "acceptEdits" }, withTools), true);
  assert.equal(sessionOptionsChanged(withTools, withTools), false);
  assert.equal(
    sessionOptionsChanged(withTools, { ...withTools, allowedTools: ["mcp__sealwire__list_teams"] }),
    true
  );
});

test("sessionOptionsChanged flags an effort switch, and ignores an omitted one", () => {
  // effort is baked into query() like model, so a live session cannot be
  // re-pointed at a new one — without a rebuild, switching a thread to "max"
  // keeps running at whatever it started on, silently.
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", effort: "medium" },
      { permissionMode: "default", effort: "max" },
    ),
    true,
  );
  // Same reasoning as model: a resume omits it, and "unspecified" is not a change.
  assert.equal(
    sessionOptionsChanged(
      { permissionMode: "default", effort: "medium" },
      { permissionMode: "default" },
    ),
    false,
  );
});

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

test("cwd_changed carries the pending thread id before Claude has a real session id", () => {
  const pendingId = "claude-pending-1";
  const event = cwdChangedEvent("/repo/wt", pendingId);
  assert.equal(event.type, "cwd_changed");
  assert.equal(event.cwd, "/repo/wt");
  assert.equal(
    event.provider_session_id,
    pendingId,
    "the first cwd hook must not wait for the SDK session id"
  );
});

test("releaseSession hands an idle session back, keeping the conversation", async () => {
  // The relay knows when a run is done, so the worker never infers idleness.
  const sessions = new Map();
  const entry = createSessionEntry({
    key: "session:done",
    providerSessionId: "done",
    cmd: { cwd: "/tmp" },
  });
  entry.session = fakeQuery();
  sessions.set(entry.key, entry);

  const lines = await captureStdout(() => {
    const result = releaseSession(sessions, "done", {
      pendingApprovals: new Map(),
      pendingAskUserQuestions: new Map(),
    });
    assert.equal(result.released, true);
  });

  assert.equal(sessions.size, 0);
  // Silent, like eviction: no turn is in flight, and a stray `done` would hit
  // the relay's stale-completion path.
  assert.deepEqual(lines.map((line) => JSON.parse(line)), []);
});

test("releaseSession refuses while work is in flight", async () => {
  // The guard is here, not only in the relay: an explicit protocol still needs
  // to be safe against a caller that asks at the wrong moment.
  const sessions = new Map();
  const context = { pendingApprovals: new Map(), pendingAskUserQuestions: new Map() };

  const running = createSessionEntry({
    key: "session:running",
    providerSessionId: "running",
    cmd: { cwd: "/tmp" },
  });
  running.running = true;
  sessions.set(running.key, running);

  const busy = createSessionEntry({
    key: "session:busy",
    providerSessionId: "busy",
    cmd: { cwd: "/tmp" },
  });
  busy.backgroundTasks = [{ task_id: "t1", task_type: "subagent", description: "audit" }];
  sessions.set(busy.key, busy);

  await captureStdout(() => {
    assert.equal(releaseSession(sessions, "running", context).released, false);
    assert.equal(releaseSession(sessions, "busy", context).released, false);
    assert.equal(releaseSession(sessions, "ghost", context).released, false);
  });

  assert.equal(sessions.size, 2, "nothing released while work is in flight");
});

test("an eviction mid-turn reports the turn failed, not a clean done", async () => {
  // A dev that had already emitted text, then got evicted at the session cap,
  // used to settle via a bare `done` — indistinguishable from a real success,
  // so the relay read it as Replied and could open review on nothing.
  const sessions = new Map();
  const context = { pendingApprovals: new Map(), pendingAskUserQuestions: new Map() };
  for (let i = 0; i < SESSION_LIMIT + 1; i += 1) {
    const entry = createSessionEntry({
      key: `session:${i}`,
      providerSessionId: `session-${i}`,
      cmd: { cwd: "/tmp" },
    });
    entry.running = true;
    entry.currentTurnId = `turn-${i}`;
    entry.lastUsedAt = i; // ascending: session-0 is the oldest, evicted first
    entry.session = fakeQuery();
    sessions.set(entry.key, entry);
  }

  const lines = await captureStdout(() => {
    evictSessionsIfNeeded(sessions, context);
  });

  assert.equal(sessions.size, SESSION_LIMIT, "exactly one session was evicted");
  const events = lines.map((line) => JSON.parse(line));
  const done = events.find((event) => event.type === "done");
  assert.ok(done, `expected a done event among: ${JSON.stringify(events)}`);
  assert.equal(done.provider_session_id, "session-0");
  assert.equal(done.turn_id, "turn-0");
  assert.equal(
    done.failed,
    true,
    "an evicted mid-turn session must settle as a FAILED turn, not a clean \
done, or a dev that already emitted text reads as Replied and can consume \
review rounds"
  );
  assert.ok(
    typeof done.reason === "string" && done.reason.length > 0,
    "the failure needs a reason the relay can show, not just failed:true",
  );
});

test("trackBackgroundTasks mirrors the SDK's live set", () => {
  // Kept for `releaseSession` only: the relay must not hand back a seat whose
  // background subagent is still running, since closing it destroys the result.
  const entry = createSessionEntry({ key: "session:a", cmd: { cwd: "/tmp" } });
  const level = (tasks) =>
    trackBackgroundTasks(entry, { type: "system", subtype: "background_tasks_changed", tasks });

  level([{ task_id: "t1", task_type: "subagent", description: "audit" }]);
  assert.equal(entry.backgroundTasks.length, 1);
  level([]);
  assert.deepEqual(entry.backgroundTasks, []);
  trackBackgroundTasks(entry, { type: "result", subtype: "success" });
  assert.deepEqual(entry.backgroundTasks, []);
});
