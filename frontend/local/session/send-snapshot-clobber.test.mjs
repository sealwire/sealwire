import test from "node:test";
import assert from "node:assert/strict";

// The send's own POST response must never erase the message it just sent.
//
// `/api/session/message` returns a session snapshot, and the relay builds that
// snapshot BEFORE the user message is appended to the transcript: for codex the
// append arrives asynchronously on the app-server's `item/completed` +
// `userMessage`, for the fake provider in a task spawned after `start_turn`
// returns. (Only `claude` appends synchronously inside `start_turn_with_images`,
// which is why it never showed this.) So that response is reliably one revision
// stale, and it lands a few ms AFTER the SSE frame that carried the message.
// Measured at the apply site in a real browser:
//
//   +81ms  rev=48  (SSE)            -> no user message
//   +82ms  rev=49  (SSE)            -> the user message, rendered correctly
//   +85ms  rev=48  (POST response)  -> reverts it
//
// `applySessionSnapshot` applied whichever landed last, so the user's own
// message stayed invisible until the NEXT transcript change. With a live
// provider that is a few hundred ms and nobody notices; when the turn parks
// immediately on an approval or an AskUserQuestion it is seconds of "I pressed
// send and nothing happened". Reproduced with and without virtualization, with
// and without a reload — including on a brand-new thread's first message ever,
// where the render went 0 -> 1 -> 0 entries.
//
// The fix is scoped to this one response rather than to snapshot ordering in
// general: this response is stale BY CONSTRUCTION, which is a fact about the
// endpoint, not an inference from arrival order — so the guard holds regardless
// of what the revision counter does. (`transcript_revision` used to restart at 0
// per process, which made cross-restart comparison unsafe; it is now a single
// persisted monotonic clock. The guard never relied on it either way.)
//
// lifecycle.js transitively imports dom.js, which queries the document at
// import time — stub it the same way send-error.test.mjs does.
const nodes = new Map();
function fakeNode(selector) {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      selector,
      value: "",
      disabled: false,
      hidden: true,
      textContent: "",
      dataset: {},
      style: {},
      classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    });
  }
  return nodes.get(selector);
}

globalThis.document = {
  querySelector: fakeNode,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: () => fakeNode("created"),
  get body() {
    return fakeNode("body");
  },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
};

const { createLifecycleController } = await import("./lifecycle.js");

// This file is exercising the send/snapshot clobber guard, not the shared
// flush scheduler (see lifecycle-snapshot-flush.test.mjs for that), so
// renders fire synchronously regardless of how snapshotIsInteractive would
// classify them.
function createSyncTranscriptFlushScheduler(render) {
  return {
    queue: render,
    note() {},
    flushNow: render,
    cancel() {},
    stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
  };
}

const THREAD = "thread-1";
const USER_TEXT = "ask-user-live";

function entry(itemId, kind, text) {
  return {
    item_id: itemId,
    kind,
    text,
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
  };
}

function snapshot({ revision, transcript, truncated = false }) {
  return {
    active_thread_id: THREAD,
    active_turn_id: "turn-1",
    transcript,
    transcript_revision: revision,
    transcript_truncated: truncated,
    pending_approvals: [],
    pending_ask_user_questions: [],
    pending_pairing_requests: [],
    thread_activity: [],
    logs: [],
  };
}

/// Drive the real controller through a send whose POST response is pre-append,
/// with the post-append SSE frame landing while the request is still in flight —
/// the measured ordering.
function buildController({
  response,
  streamFrame = null,
  hydrationOrder = [],
  hydrationEntries = new Map(),
}) {
  const rendered = [];
  const state = {
    deviceId: "device-1",
    session: null,
    viewThreadId: null,
    viewOnlyThread: null,
    transcriptHydrationThreadId: THREAD,
    transcriptHydrationOrder: hydrationOrder,
    transcriptHydrationEntries: hydrationEntries,
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationFetchedRevision: null,
    localUiStore: { getState: () => ({ clearTranscriptDetailLoading() {} }) },
  };
  let controller = null;
  const renderSession = (session) => {
    state.session = session;
    rendered.push(session);
  };
  controller = createLifecycleController({
    state,
    apiFetch: async () => {
      // When the stream is up, its frame lands while the POST is still in
      // flight — the measured ordering. `streamFrame: null` models a surface
      // whose stream is down, lagging, or not yet connected.
      if (streamFrame) {
        controller.applySessionSnapshot(streamFrame);
      }
      return { ok: true, json: async () => ({ ok: true, data: response }) };
    },
    logLine: () => {},
    renderSession,
    transcriptFlushScheduler: createSyncTranscriptFlushScheduler(() => {
      if (state.session) {
        renderSession(state.session);
      }
    }),
    canCurrentDeviceWrite: () => true,
    seedDefaults: () => {},
    setSelectedCwd: () => {},
    setThreadRoute: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},
    renderAuthRequiredState: () => {},
    runViewTransition: (fn) => fn(),
    setStartControlsBusy: () => {},
    liveElement: () => null,
    isViewingConversation: () => true,
    queryClient: null,
  });
  const lastRenderedTexts = () =>
    (rendered.at(-1)?.transcript || []).map((candidate) => candidate.text);
  return { controller, state, rendered, lastRenderedTexts };
}

test("the send's own response does not un-render the message the user just sent", async () => {
  // The simplest and most alarming shape: a brand-new thread, the first message
  // ever. Measured in a real browser this went 0 -> 1 -> 0 entries.
  const { controller, lastRenderedTexts } = buildController({
    response: snapshot({ revision: 48, transcript: [] }),
    streamFrame: snapshot({
      revision: 49,
      transcript: [entry("user-1", "user_text", USER_TEXT)],
    }),
  });

  assert.equal(await controller.sendMessage(USER_TEXT, THREAD), true);

  assert.deepEqual(
    lastRenderedTexts(),
    [USER_TEXT],
    "the send's pre-append response must not revert the transcript it raced"
  );
});

test("the send's own response does not drop the message off a deep hydration window", async () => {
  // The shape this was originally reported as — a long, virtualized thread. The
  // hydration merge places the new entry correctly (proven by the precondition
  // in the test above); the stale response that follows is what drops it back
  // out, which is why the virtualizer looked guilty.
  const older = entry("item-1", "agent_text", "older reply one");
  const tailEntry = entry("item-2", "agent_text", "older reply two");
  const tail = [tailEntry];
  const { controller, lastRenderedTexts } = buildController({
    response: snapshot({ revision: 48, transcript: tail, truncated: true }),
    streamFrame: snapshot({
      revision: 49,
      transcript: [...tail, entry("user-1", "user_text", USER_TEXT)],
      truncated: true,
    }),
    hydrationOrder: [older.item_id, tailEntry.item_id],
    hydrationEntries: new Map([
      [older.item_id, older],
      [tailEntry.item_id, tailEntry],
    ]),
  });

  assert.equal(await controller.sendMessage(USER_TEXT, THREAD), true);

  assert.deepEqual(
    lastRenderedTexts(),
    ["older reply one", "older reply two", USER_TEXT],
    "the send's pre-append response must not drop the just-sent message off a deep window"
  );
});

test("a response that DOES carry the sent message renders it with no stream frame", async () => {
  // Being pre-write is provider-dependent, not an endpoint-wide invariant:
  // `claude` awaits `record_local_user_message` BEFORE `start_turn` returns
  // (claude.rs:777), so its response already contains the user entry. When the
  // stream has not delivered it — not yet connected, lagging, or down — that
  // response is the ONLY copy, and holding it back would leave the message
  // invisible until the poll fallback ticks. Hence the rule is additive: the
  // response may add to the transcript, it may never remove from it.
  const older = entry("item-1", "agent_text", "older reply one");
  const { controller, lastRenderedTexts } = buildController({
    response: snapshot({
      revision: 49,
      transcript: [older, entry("user-1", "user_text", USER_TEXT)],
    }),
    streamFrame: null,
  });

  // The surface already shows the thread; the stream is not delivering.
  controller.applySessionSnapshot(snapshot({ revision: 48, transcript: [older] }));
  assert.deepEqual(lastRenderedTexts(), ["older reply one"], "precondition");

  assert.equal(await controller.sendMessage(USER_TEXT, THREAD), true);

  assert.deepEqual(
    lastRenderedTexts(),
    ["older reply one", USER_TEXT],
    "a response carrying the user entry must render it even with no stream frame"
  );
});

test("a response that omits entries the surface holds keeps them AND adds its own", async () => {
  // The two halves of the rule in one shape: the response is missing the entry
  // the surface just rendered (so it must not remove it) and carries one the
  // surface has never seen (so it must still be applied).
  const older = entry("item-1", "agent_text", "older reply one");
  const { controller, lastRenderedTexts } = buildController({
    response: snapshot({
      revision: 48,
      transcript: [older, entry("agent-2", "agent_text", "reply the stream missed")],
    }),
    streamFrame: snapshot({
      revision: 49,
      transcript: [older, entry("user-1", "user_text", USER_TEXT)],
    }),
  });

  assert.equal(await controller.sendMessage(USER_TEXT, THREAD), true);

  assert.deepEqual(
    lastRenderedTexts(),
    ["older reply one", "reply the stream missed", USER_TEXT],
    "the response's own entries land, and nothing the surface held is dropped"
  );
});

test("rescued entries keep their rendered order behind the response's own tail", async () => {
  // The rescue appends, so it must only ever append what genuinely belongs at
  // the end. Here the response carries a middle entry and drops an earlier one
  // (a truncated tail is shorter on purpose, and drops it today too) while the
  // surface holds two entries past it. Re-inserting the earlier one would put
  // it AFTER the entry it precedes.
  const dropped = entry("item-0", "agent_text", "trimmed by truncation");
  const shared = entry("item-1", "agent_text", "older reply one");
  const { controller, lastRenderedTexts } = buildController({
    response: snapshot({ revision: 48, transcript: [shared], truncated: true }),
    streamFrame: snapshot({
      revision: 49,
      transcript: [dropped, shared, entry("user-1", "user_text", USER_TEXT)],
    }),
  });

  assert.equal(await controller.sendMessage(USER_TEXT, THREAD), true);

  assert.deepEqual(
    lastRenderedTexts(),
    ["older reply one", USER_TEXT],
    "the rescued suffix follows the response's tail in rendered order"
  );
});

test("a send that promotes the thread still applies its response in full", async () => {
  // Deferred-start Claude threads are promoted server-side by the first send:
  // the public id changes from `claude-pending-…` to the real session id, and
  // `applySessionSnapshot` is what moves the scroll bookkeeping and retargets
  // the route. The response is authoritative for a thread the surface holds
  // nothing for, so pinning the transcript there would render an empty thread.
  const promoted = {
    ...snapshot({
      revision: 0,
      transcript: [entry("user-1", "user_text", USER_TEXT)],
    }),
    active_thread_id: "claude-real-1",
    active_thread_promoted_from: "claude-pending-1",
  };
  const { controller, state, lastRenderedTexts } = buildController({
    response: promoted,
    streamFrame: snapshot({ revision: 1, transcript: [] }),
  });

  assert.equal(await controller.sendMessage(USER_TEXT, "claude-pending-1"), true);

  assert.equal(
    state.session?.active_thread_id,
    "claude-real-1",
    "the promoted thread id must reach the surface"
  );
  assert.deepEqual(
    lastRenderedTexts(),
    [USER_TEXT],
    "a response for a different thread stays authoritative for its transcript"
  );
});

test("the send's own response does not erase a question that arrived while it was in flight", async () => {
  // Same staleness, the other field. A turn can park on an AskUserQuestion
  // before the send's pre-append response lands, and that response carries the
  // pending list as it was BEFORE the question existed. Applying it wholesale
  // drops the request for a beat, which un-pins the card, downgrades it to the
  // read-only look whose options do nothing, and — because the wizard keeps the
  // reader's picks in component state — forgets what they had already clicked.
  const question = {
    request_id: "ask-1",
    tool_use_id: "toolu-ask-1",
    thread_id: THREAD,
    requested_at: 1,
    question_count: 1,
    questions_inline_complete: true,
    questions: [
      {
        question: "Which approach?",
        header: "Approach",
        multi_select: false,
        options: [{ label: "Option A", description: "" }],
      },
    ],
  };
  const asked = snapshot({
    revision: 49,
    transcript: [entry("user-1", "user_text", USER_TEXT)],
  });
  asked.pending_ask_user_questions = [question];
  // An approval parks a turn the same way and is dropped by the same apply.
  asked.pending_approvals = [
    { request_id: "approve-1", thread_id: THREAD, kind: "exec", command: "ls" },
  ];

  const { controller, rendered } = buildController({
    response: snapshot({ revision: 48, transcript: [] }),
    streamFrame: asked,
  });

  assert.equal(await controller.sendMessage(USER_TEXT, THREAD), true);

  assert.deepEqual(
    (rendered.at(-1)?.pending_ask_user_questions || []).map((item) => item.request_id),
    ["ask-1"],
    "a snapshot built before the question must not un-ask it"
  );
  assert.deepEqual(
    (rendered.at(-1)?.pending_approvals || []).map((item) => item.request_id),
    ["approve-1"],
    "nor withdraw an approval the same turn is parked on"
  );
});
