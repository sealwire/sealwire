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
    restoredScrollPosition: {
      followBottom: false,
      scrollTop: 437,
    },
    scrollElement: target,
  });
  assert.deepEqual(action, {
    kind: "restore-thread",
    scrollTop: 437,
    userEntryId: "u1",
  });
});

test("switching back to a retained bottom-following thread follows its grown tail", () => {
  const cache = new Map();
  rememberTranscriptScrollPosition(
    cache,
    "thread-1",
    makeScrollElement({
      scrollHeight: 3000,
      clientHeight: 400,
      scrollTop: 2600,
    }).target
  );
  const restoredScrollPosition = readTranscriptScrollPosition(cache, "thread-1");
  assert.deepEqual(restoredScrollPosition, {
    followBottom: true,
    scrollTop: 2600,
  });

  // The live thread grew by 4,000px while it was hidden. Restoring 2,600 would
  // strand the reader in history; restoring bottom intent lands on the new tail.
  const { target } = makeScrollElement({
    scrollHeight: 7000,
    clientHeight: 400,
    scrollTop: 0,
  });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-2",
      entries: [userEntry("u2")],
    },
    restoredScrollPosition,
    scrollElement: target,
  });
  assert.deepEqual(action, {
    kind: "jump-bottom",
    scrollTop: 6600,
    userEntryId: "u1",
  });
});

test("a reader who escaped by one wheel step retains history-reading intent", () => {
  const cache = new Map();
  rememberTranscriptScrollPosition(
    cache,
    "thread-1",
    makeScrollElement({
      scrollHeight: 3000,
      clientHeight: 400,
      // 40px above the bottom: inside the button's broad near-bottom band, but
      // well outside the follower's 4px re-stick boundary.
      scrollTop: 2560,
    }).target
  );
  assert.deepEqual(readTranscriptScrollPosition(cache, "thread-1"), {
    followBottom: false,
    scrollTop: 2560,
  });
});

test("switch-back baselines retained users so a later snapshot does not undo the restore", () => {
  const anchorsForThread = new Set();
  const entries = [userEntry("u1"), agentEntry("a1")];
  const firstTarget = makeScrollElement({
    scrollHeight: 379,
    clientHeight: 266,
    scrollTop: 0,
  }).target;
  const restored = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: anchorsForThread,
    nextEntries: entries,
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-2",
      entries: [userEntry("u2")],
    },
    restoredScrollPosition: {
      followBottom: false,
      scrollTop: 73,
    },
    scrollElement: firstTarget,
  });
  assert.deepEqual(restored, {
    kind: "restore-thread",
    scrollTop: 73,
    userEntryId: "u1",
  });
  anchorsForThread.add(restored.userEntryId);

  const nextSnapshot = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: anchorsForThread,
    nextEntries: entries,
    nextThreadId: "thread-1",
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries,
      scrollHeight: 379,
      scrollTop: 73,
    },
    scrollElement: makeScrollElement({
      scrollHeight: 379,
      clientHeight: 266,
      scrollTop: 73,
    }).target,
  });
  assert.deepEqual(nextSnapshot, { kind: "preserve" });
});

test("per-thread scroll positions use bounded LRU retention", () => {
  const cache = new Map();
  for (let index = 0; index <= MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS; index += 1) {
    rememberTranscriptScrollPosition(cache, `thread-${index}`, {
      clientHeight: 100,
      scrollHeight: 1000,
      scrollTop: index * 10,
    });
  }
  assert.equal(cache.has("thread-0"), false);
  assert.deepEqual(readTranscriptScrollPosition(cache, "thread-1"), {
    followBottom: false,
    scrollTop: 10,
  });
  assert.equal([...cache.keys()].at(-1), "thread-1", "reading refreshes LRU recency");
  assert.equal(readTranscriptScrollPosition(cache, "missing"), null);
});

// --- new user message ------------------------------------------------------

test("a new user message follows to the bottom (bottom-follow, no top-anchor)", () => {
  // Bottom-follow: a freshly sent message locks the transcript to the bottom and
  // the reply streams below the fold — it is NOT pinned to the top of the
  // viewport (that top-anchor mode, plus its 60vh reserve, is gone).
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
  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.scrollTop, 2600);
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

test("anchor-user is retired (bottom-follow): apply ignores it, no scroll", () => {
  const { calls, target } = makeScrollElement({ scrollTop: 0 });
  target._queryResult = { offsetTop: 700, scrollIntoView() {} };
  applyTranscriptScrollAction({ kind: "anchor-user", userEntryId: "u2" }, target);
  assert.equal(target.scrollTop, 0);
  assert.equal(calls.filter((c) => c.kind === "scrollTop").length, 0);
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

// --- input required (Bug B) -------------------------------------------------
//
// When the agent blocks on the reader (an approval, or an AskUser question) the
// request renders at the BOTTOM of the transcript — the approval card is pushed
// last, after every entry. It is NOT a transcript entry: it has no `item_id` and
// never enters the hydration window, so none of the triggers above can see it.
// Without a trigger of its own the decision is `preserve`, the follower only
// re-pins when it is already stuck, and the request lands below the fold: the
// session looks hung. These tests pin the once-per-request trigger.

test("a pending input request pulls the transcript to the bottom", () => {
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["approval:req-1"],
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2600,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "input-required");
  assert.equal(action.scrollTop, 2600);
  assert.deepEqual(
    action.inputRequestIds,
    ["approval:req-1"],
    "the action reports the request it handled so the call site can record it"
  );
});

test("an input request fires ONCE — a reader who scrolled up is not yanked back", () => {
  // Same fire-once discipline as a new user message. Re-firing on every render
  // while the approval is still pending would make it impossible to scroll up and
  // re-read the command you are being asked to approve.
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1", "approval:req-1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["approval:req-1"],
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2600,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "preserve");
});

test("a SECOND input request in the same thread fires again", () => {
  // Fire-once is keyed on the request id, not on "we already did this once".
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1", "approval:req-1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["approval:req-2"],
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2600,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "input-required");
  assert.deepEqual(action.inputRequestIds, ["approval:req-2"]);
});

test("no pending input request: still leave the user alone", () => {
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1"), agentEntry("a2")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: [],
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

test("switching INTO a thread that already needs input does not override restore-thread", () => {
  // The reader left this thread mid-history, so the switch restores that offset.
  // The pending request must be seeded as handled by the transition, otherwise the
  // very next render fires input-required and undoes the restore.
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 0, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-2",
    pendingInputRequestIds: ["approval:req-1"],
    previousSnapshot: { activeThreadId: "thread-1", entries: [], scrollHeight: 0, scrollTop: 0 },
    restoredScrollPosition: { followBottom: false, scrollTop: 640 },
    scrollElement: target,
  });
  assert.equal(action.kind, "restore-thread");
  assert.equal(action.scrollTop, 640);
  assert.deepEqual(
    action.inputRequestIds,
    ["approval:req-1"],
    "the transition must claim the pending request so it cannot re-fire behind the restore"
  );
});

test("a send and a request in the SAME render: one action claims both", () => {
  // The relay publishes the user message and the approval in one beat, so this is
  // the COMMON path, not a corner case. That render's own jump-bottom already put
  // the request on screen — but if the action only reports `userEntryId`, the call
  // site never records the request, and the next render treats it as brand new and
  // yanks a reader who has since scrolled up.
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1"), userEntry("u2")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["pending_approvals:r1"],
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2600,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.userEntryId, "u2");
  assert.deepEqual(
    action.inputRequestIds,
    ["pending_approvals:r1"],
    "a jump to the bottom SHOWS the request, so it must claim it too"
  );
});

test("after a same-render send+request, a reader who scrolls up is left alone", () => {
  // The end-to-end consequence of the claim above: with both ids recorded, every
  // later render while that request is still pending is a no-op.
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1", "u2", "pending_approvals:r1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1"), userEntry("u2")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["pending_approvals:r1"],
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1"), userEntry("u2")],
      latestUserEntryId: "u2",
      scrollHeight: 3000,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "preserve");
});

test("older history prepended in the same render as a request: keep the reader's place, claim it", () => {
  // Priority, made explicit. A reader who triggered a prepend is at the top of the
  // thread, unambiguously reading history. Anchoring and THEN teleporting them to
  // the bottom on the next render is the worst of both, so the prepend wins — and
  // it claims the request for the same reason `restore-thread` does: whatever this
  // render decided about position must not be undone behind it. The pending-action
  // banner above the composer still surfaces the request meanwhile.
  const { target } = makeScrollElement({ scrollHeight: 3500, scrollTop: 500, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [agentEntry("older-1"), agentEntry("older-2"), userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["pending_approvals:r1"],
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
  assert.deepEqual(
    action.inputRequestIds,
    ["pending_approvals:r1"],
    "the prepend owns this render's position, so it claims the request rather than being undone next render"
  );
});

test("noop (no scroll element) claims nothing — nothing was positioned", () => {
  const action = decideTranscriptScrollAction({
    nextEntries: [userEntry("u1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["pending_approvals:r1"],
    scrollElement: null,
  });
  assert.equal(action.kind, "noop");
  assert.equal(action.inputRequestIds, undefined);
});

test("a SECOND request arriving while the first is still pending fires again", () => {
  // Nothing constrains a thread to one pending question, so a request that
  // arrives behind an already-claimed one must still be brought into view —
  // otherwise it is pinned at the bottom where an escaped reader never sees it.
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1", "pending_ask_user_questions:q1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: [
      "pending_ask_user_questions:q1",
      "pending_ask_user_questions:q2",
    ],
    previousSnapshot: {
      activeThreadId: "thread-1",
      entries: [userEntry("u1"), agentEntry("a1")],
      latestUserEntryId: "u1",
      scrollHeight: 2600,
      scrollTop: 800,
    },
    scrollElement: target,
  });
  assert.equal(action.kind, "input-required");
  assert.deepEqual(
    action.inputRequestIds,
    ["pending_ask_user_questions:q1", "pending_ask_user_questions:q2"],
    "one render claims ALL pending requests, so neither fires twice"
  );
});

test("two requests arriving in one beat fire once, then leave the reader alone", () => {
  const { target } = makeScrollElement({ scrollHeight: 3000, scrollTop: 800, clientHeight: 400 });
  const both = ["pending_ask_user_questions:q1", "pending_ask_user_questions:q2"];
  const previousSnapshot = {
    activeThreadId: "thread-1",
    entries: [userEntry("u1"), agentEntry("a1")],
    latestUserEntryId: "u1",
    scrollHeight: 2600,
    scrollTop: 800,
  };
  const first = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1"]),
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: both,
    previousSnapshot,
    scrollElement: target,
  });
  assert.equal(first.kind, "input-required");

  const second = decideTranscriptScrollAction({
    alreadyAnchoredUserIds: new Set(["u1", ...first.inputRequestIds]),
    nextEntries: [userEntry("u1"), agentEntry("a1")],
    nextThreadId: "thread-1",
    pendingInputRequestIds: both,
    previousSnapshot,
    scrollElement: target,
  });
  assert.equal(second.kind, "preserve");
});
