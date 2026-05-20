import test from "node:test";
import assert from "node:assert/strict";

import {
  LATEST_USER_MESSAGE_ATTR,
  TOP_SCROLL_PRESERVE_THRESHOLD_PX,
  applyTranscriptScrollAction,
  captureTranscriptScrollSnapshot,
  decideTranscriptScrollAction,
  didPrependOlderTranscript,
  findLatestUserEntryId,
  restoreTranscriptScrollPosition,
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
