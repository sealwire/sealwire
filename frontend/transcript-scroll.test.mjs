import test from "node:test";
import assert from "node:assert/strict";

import {
  LATEST_USER_MESSAGE_ATTR,
  MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS,
  TOP_SCROLL_PRESERVE_THRESHOLD_PX,
  applyTranscriptScrollAction,
  captureTranscriptScrollSnapshot,
  decideTranscriptScrollAction,
  didPrependOlderTranscript,
  findLatestUserEntryId,
  readTranscriptScrollPosition,
  rememberTranscriptScrollPosition,
  restoreTranscriptScrollPosition,
  retargetRemoteTranscriptScroll,
  retargetTranscriptScrollThread,
} from "./shared/transcript-scroll.js";

function userEntry(id) {
  return { item_id: id, kind: "user_text", status: "completed", tool: null, turn_id: id };
}
function agentEntry(id) {
  return { item_id: id, kind: "agent_text", status: "completed", tool: null, turn_id: id };
}

function makeScrollElement({ clientHeight = 400, scrollHeight = 2000, scrollTop = 0 } = {}) {
  const calls = [];
  let _scrollTop = scrollTop;
  const target = {
    _queryResult: null,
    clientHeight,
    scrollHeight,
    get scrollTop() {
      return _scrollTop;
    },
    set scrollTop(value) {
      _scrollTop = value;
      calls.push({ kind: "scrollTop", value });
    },
    querySelector(selector) {
      calls.push({ kind: "querySelector", selector });
      return target._queryResult;
    },
  };
  return { calls, target };
}

// --- findLatestUserEntryId -------------------------------------------------

test("findLatestUserEntryId returns the id of the last user_text entry", () => {
  assert.equal(
    findLatestUserEntryId([userEntry("u1"), agentEntry("a1"), userEntry("u2"), agentEntry("a2")]),
    "u2"
  );
  assert.equal(findLatestUserEntryId([agentEntry("a1")]), null);
  assert.equal(findLatestUserEntryId([]), null);
  assert.equal(findLatestUserEntryId(null), null);
});

// --- thread switch / first view --------------------------------------------

test("first view of a thread snaps to the bottom so user lands at latest", () => {
  const { target } = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    previousSnapshot: null,
    scrollElement: target,
  });
  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.scrollTop, 1600);
});

test("switching to a different thread snaps to bottom", () => {
  const { target } = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-2",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u-old"), agentEntry("a-old")],
      latestUserEntryId: "u-old",
      scrollHeight: 1000,
      scrollTop: 200,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "jump-bottom");
});

test("switching back to a retained thread restores its exact scroll offset", () => {
  const { target } = makeScrollElement({ scrollHeight: 3000, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-2",
      entries: [userEntry("u2")],
      scrollHeight: 1200,
      scrollTop: 800,
    },
    restoredScrollTop: 437,
    scrollElement: target,
  });
  assert.deepEqual(action, { kind: "restore-thread", scrollTop: 437 });
});

test("per-thread scroll positions use bounded LRU retention", () => {
  const cache = new Map();
  for (let index = 0; index <= MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS; index += 1) {
    rememberTranscriptScrollPosition(cache, `thread-${index}`, { scrollTop: index * 10 });
  }
  assert.equal(cache.has("thread-0"), false);
  assert.equal(readTranscriptScrollPosition(cache, "thread-1"), 10);
  assert.equal([...cache.keys()].at(-1), "thread-1", "reading refreshes LRU recency");
  assert.equal(readTranscriptScrollPosition(cache, "missing"), null);
});

// --- new user message ------------------------------------------------------

test("a new user message anchors the message to the top of the viewport", () => {
  const { target } = makeScrollElement({ scrollHeight: 3000, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1"), agentEntry("a1"), userEntry("u2")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2200,
      scrollTop: 200,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "anchor-user");
  assert.equal(action.userEntryId, "u2");
});

test("alreadyAnchoredUserIds suppresses re-anchoring a user message we've already pinned", () => {
  // Intermediate render shows a regressed entry set — without the anchored
  // set, the previous snapshot's latestUserEntryId would compare against the
  // older user message and falsely re-fire anchor-user.
  const { target } = makeScrollElement({ scrollHeight: 3000, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u2"]),
    nextEntries: [userEntry("u1"), agentEntry("a1"), userEntry("u2")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1")],
      latestUserEntryId: "u1",
      scrollHeight: 1000,
      scrollTop: 600,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "preserve");
});

test("no new user message and no thread switch: leave the user alone", () => {
  const { target } = makeScrollElement({
    scrollHeight: 3000,
    scrollTop: 800,
    clientHeight: 400,
  });
  // Same entries plus one new agent chunk — simulates streaming. Scroll
  // position must NOT change; this is the bug-fix we care about. The user
  // message u1 was already anchored earlier in the thread's lifetime.
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1"), agentEntry("a2")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2200,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "preserve");
});

// --- prepended older transcript --------------------------------------------

test("prepended older transcript anchors the viewport so the reader keeps their place", () => {
  // User was reading at 500px down with previous scrollHeight 2000; new
  // entries were prepended, growing scrollHeight by 1500. We expect their
  // position adjusted up by that delta so the same content stays in view.
  const { target } = makeScrollElement({
    scrollHeight: 3500,
    scrollTop: 500,
    clientHeight: 400,
  });
  const action = decideTranscriptScrollAction({
    nextEntries: [
      agentEntry("older-1"),
      agentEntry("older-2"),
      userEntry("u1"),
      agentEntry("a1"),
    ],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2000,
      scrollTop: 500,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "anchor-prepend");
  assert.equal(action.scrollTop, 3500 - 2000 + 500);
});

test("prepended older transcript when the user is at the top: keep them at the top", () => {
  const { target } = makeScrollElement({
    scrollHeight: 3500,
    scrollTop: TOP_SCROLL_PRESERVE_THRESHOLD_PX - 5,
    clientHeight: 400,
  });
  const action = decideTranscriptScrollAction({
    nextEntries: [agentEntry("older-1"), userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2000,
      scrollTop: TOP_SCROLL_PRESERVE_THRESHOLD_PX - 5,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "preserve");
});

// --- applyTranscriptScrollAction -------------------------------------------

test("applyTranscriptScrollAction jump-bottom assigns scrollTop", () => {
  const { calls, target } = makeScrollElement({ scrollTop: 0 });
  applyTranscriptScrollAction({ kind: "jump-bottom", scrollTop: 1600 }, target);
  assert.equal(target.scrollTop, 1600);
  assert.deepEqual(calls.at(-1), { kind: "scrollTop", value: 1600 });
});

test("applyTranscriptScrollAction anchor-prepend assigns scrollTop", () => {
  const { target } = makeScrollElement({ scrollTop: 0 });
  applyTranscriptScrollAction({ kind: "anchor-prepend", scrollTop: 2000 }, target);
  assert.equal(target.scrollTop, 2000);
});

test("applyTranscriptScrollAction restore-thread assigns the retained scrollTop", () => {
  const { target } = makeScrollElement({ scrollTop: 0 });
  applyTranscriptScrollAction({ kind: "restore-thread", scrollTop: 437 }, target);
  assert.equal(target.scrollTop, 437);
});

test("applyTranscriptScrollAction anchor-user scrolls the marked element to top", () => {
  const { target } = makeScrollElement({ scrollTop: 0 });
  let intoViewArgs = null;
  target._queryResult = {
    offsetTop: 700,
    scrollIntoView(arg) {
      intoViewArgs = arg;
    },
  };
  applyTranscriptScrollAction(
    { kind: "anchor-user", userEntryId: "u2" },
    target
  );
  assert.deepEqual(intoViewArgs, { block: "start", behavior: "auto" });
});

test("applyTranscriptScrollAction anchor-user falls back to offsetTop if no scrollIntoView", () => {
  const { target } = makeScrollElement({ scrollTop: 0 });
  target._queryResult = { offsetTop: 700 };
  applyTranscriptScrollAction(
    { kind: "anchor-user", userEntryId: "u2" },
    target
  );
  assert.equal(target.scrollTop, 700);
});

test("applyTranscriptScrollAction preserve leaves the DOM untouched", () => {
  const { calls, target } = makeScrollElement({ scrollTop: 500 });
  applyTranscriptScrollAction({ kind: "preserve" }, target);
  assert.equal(target.scrollTop, 500);
  assert.equal(calls.filter((c) => c.kind === "scrollTop").length, 0);
});

// --- restoreTranscriptScrollPosition end-to-end ----------------------------

test("restoreTranscriptScrollPosition does nothing without a scroll element", () => {
  const result = restoreTranscriptScrollPosition({
    nextEntries: [],
    nextThreadId: "thread-1",
    previousSnapshot: null,
    scrollElement: null,
  });
  assert.equal(result, null);
});

test("restoreTranscriptScrollPosition snaps to bottom on first ever render", () => {
  const { target } = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });
  const action = restoreTranscriptScrollPosition({
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    previousSnapshot: null,
    scrollElement: target,
  });
  assert.equal(action.kind, "jump-bottom");
  assert.equal(target.scrollTop, 1600);
});

test("restoreTranscriptScrollPosition preserves scrollTop during streaming", () => {
  // Live scenario: assistant chunk arrives. previousSnapshot has the same
  // thread + same latest user message. scrollTop must not change.
  const { target } = makeScrollElement({
    scrollHeight: 3000,
    scrollTop: 800,
    clientHeight: 400,
  });
  const action = restoreTranscriptScrollPosition({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1"), agentEntry("a2")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2200,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "preserve");
  assert.equal(target.scrollTop, 800);
});

// --- captureTranscriptScrollSnapshot ---------------------------------------

test("captureTranscriptScrollSnapshot records geometry + entries + latest user id", () => {
  const entries = [userEntry("u1"), agentEntry("a1"), userEntry("u2")];
  const snapshot = captureTranscriptScrollSnapshot({
    entries,
    scrollElement: { clientHeight: 400, scrollHeight: 2000, scrollTop: 1600 },
    threadId: "thread-7",
  });
  assert.equal(snapshot.activeThreadId, "thread-7");
  assert.equal(snapshot.clientHeight, 400);
  assert.equal(snapshot.scrollHeight, 2000);
  assert.equal(snapshot.scrollTop, 1600);
  assert.equal(snapshot.latestUserEntryId, "u2");
  assert.equal(snapshot.entries, entries);
});

// --- didPrependOlderTranscript ---------------------------------------------

test("didPrependOlderTranscript returns true when previous entries appear at the tail", () => {
  const previous = [userEntry("b"), agentEntry("c")];
  const next = [userEntry("a"), userEntry("b"), agentEntry("c")];
  assert.equal(didPrependOlderTranscript(previous, next), true);
});

test("didPrependOlderTranscript returns false when entries diverge", () => {
  const previous = [userEntry("b"), agentEntry("c")];
  const next = [userEntry("a"), agentEntry("c"), userEntry("d")];
  assert.equal(didPrependOlderTranscript(previous, next), false);
});

// --- constant export -------------------------------------------------------

test("LATEST_USER_MESSAGE_ATTR is the documented data attribute name", () => {
  assert.equal(LATEST_USER_MESSAGE_ATTR, "data-latest-user-message");
});

// --- deferred-thread promotion (claude-pending-* -> real id) -----------------

test("retargetTranscriptScrollThread rekeys snapshot, positions and anchors", () => {
  const { target } = makeScrollElement();
  const state = {
    localTranscriptScrollSnapshot: captureTranscriptScrollSnapshot({
      entries: [],
      scrollElement: target,
      threadId: "claude-pending-7",
    }),
    localTranscriptScrollPositions: new Map([["claude-pending-7", 480]]),
    localTranscriptScrollAnchors: new Map([["claude-pending-7", new Set(["u1"])]]),
  };
  assert.equal(
    retargetTranscriptScrollThread(state, "claude-pending-7", "real-thread-9"),
    true
  );
  assert.equal(state.localTranscriptScrollSnapshot.activeThreadId, "real-thread-9");
  assert.equal(state.localTranscriptScrollPositions.get("real-thread-9"), 480);
  assert.equal(state.localTranscriptScrollPositions.has("claude-pending-7"), false);
  assert.ok(state.localTranscriptScrollAnchors.get("real-thread-9").has("u1"));
  assert.equal(state.localTranscriptScrollAnchors.has("claude-pending-7"), false);
});

test("retargetTranscriptScrollThread is a safe no-op for unrelated or missing state", () => {
  assert.equal(retargetTranscriptScrollThread(null, "a", "b"), false);
  assert.equal(retargetTranscriptScrollThread({}, "a", "b"), false);
  const state = {
    localTranscriptScrollSnapshot: { activeThreadId: "other" },
    localTranscriptScrollPositions: new Map([["other", 10]]),
  };
  assert.equal(retargetTranscriptScrollThread(state, "a", "b"), false);
  assert.equal(state.localTranscriptScrollSnapshot.activeThreadId, "other");
  assert.equal(retargetTranscriptScrollThread(state, "a", "a"), false);
});

test("first send after pending->real promotion still anchors (not jump-bottom)", () => {
  // A deferred Claude session records its empty snapshot under the synthetic
  // `claude-pending-*` id; the first send promotes the thread to its real id.
  // After retargeting, the first entries must classify as a new user message
  // (anchor-user) — NOT as a thread switch (jump-bottom + brief sticky).
  const { target } = makeScrollElement();
  const state = {
    localTranscriptScrollSnapshot: captureTranscriptScrollSnapshot({
      entries: [],
      scrollElement: target,
      threadId: "claude-pending-42",
    }),
  };
  retargetTranscriptScrollThread(state, "claude-pending-42", "real-42");
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1")],
    nextThreadId: "real-42",
    previousSnapshot: state.localTranscriptScrollSnapshot,
    scrollElement: target,
  });
  assert.equal(action.kind, "anchor-user");
});

test("retargetRemoteTranscriptScroll rekeys pane refs across a pending promotion", () => {
  const anchoredUserIds = new Map([["relay-1:claude-pending-3", new Set(["u1"])]]);
  const scrollPositions = new Map([["relay-1:claude-pending-3", 640]]);
  const snapshot = {
    activeThreadId: "claude-pending-3",
    entries: [],
    scrollKey: "relay-1:claude-pending-3",
  };
  assert.equal(
    retargetRemoteTranscriptScroll({
      anchoredUserIds,
      scrollPositions,
      snapshot,
      fromScrollKey: "relay-1:claude-pending-3",
      toScrollKey: "relay-1:real-3",
      fromThreadId: "claude-pending-3",
      toThreadId: "real-3",
    }),
    true
  );
  assert.equal(snapshot.activeThreadId, "real-3");
  assert.equal(snapshot.scrollKey, "relay-1:real-3");
  assert.equal(scrollPositions.get("relay-1:real-3"), 640);
  assert.equal(scrollPositions.has("relay-1:claude-pending-3"), false);
  assert.ok(anchoredUserIds.get("relay-1:real-3").has("u1"));
});

test("remote promotion rekey keeps the first send classified as anchor-user", () => {
  const { target } = makeScrollElement();
  const snapshot = {
    ...captureTranscriptScrollSnapshot({
      entries: [],
      scrollElement: target,
      threadId: "claude-pending-9",
    }),
    scrollKey: "relay-1:claude-pending-9",
  };
  retargetRemoteTranscriptScroll({
    anchoredUserIds: new Map(),
    scrollPositions: new Map(),
    snapshot,
    fromScrollKey: "relay-1:claude-pending-9",
    toScrollKey: "relay-1:real-9",
    fromThreadId: "claude-pending-9",
    toThreadId: "real-9",
  });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1")],
    nextThreadId: "real-9",
    previousSnapshot: snapshot,
    scrollElement: target,
  });
  assert.equal(action.kind, "anchor-user");
});

test("retargetRemoteTranscriptScroll is a safe no-op when nothing matches", () => {
  assert.equal(
    retargetRemoteTranscriptScroll({
      anchoredUserIds: new Map(),
      scrollPositions: new Map(),
      snapshot: { activeThreadId: "other", scrollKey: "r:other" },
      fromScrollKey: "r:a",
      toScrollKey: "r:b",
      fromThreadId: "a",
      toThreadId: "b",
    }),
    false
  );
  assert.equal(retargetRemoteTranscriptScroll(null), false);
});
