import test from "node:test";
import assert from "node:assert/strict";

import { MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS } from "./transcript-scroll.js";
import { createTranscriptScrollBookkeeping } from "./transcript-scroll-bookkeeping.js";

function userEntry(id) {
  return { item_id: id, kind: "user_text", status: "completed", tool: null, turn_id: id };
}
function agentEntry(id) {
  return { item_id: id, kind: "agent_text", status: "completed", tool: null, turn_id: id };
}

// Plain duck-typed geometry — no getters, no DOM. The engine only ever reads
// scrollTop/scrollHeight/clientHeight off whatever it's handed.
function makeScrollElement({ clientHeight = 400, scrollHeight = 2000, scrollTop = 0 } = {}) {
  return { clientHeight, scrollHeight, scrollTop };
}

// Drives the engine the way an adapter hook does for one render: on a thread
// switch, remember the leaving key's geometry and read the arriving key's
// restore intent BEFORE deciding; then apply and commit. `leavingGeometry`
// lets a test give the leaving thread's pre-swap geometry separately from the
// arriving thread's own scrollElement, since a real pane's DOM node reports
// different numbers before and after the swap.
function render(engine, { key, threadId, entries, scrollElement, leavingGeometry, pendingInputRequestIds = [] }) {
  const previous = engine.getSnapshot();
  let restoredScrollPosition = null;
  if (previous?.activeThreadId && previous.activeThreadId !== threadId) {
    engine.rememberView(previous.scrollKey, leavingGeometry || scrollElement);
    restoredScrollPosition = engine.readRestoreIntent(key);
  }
  const action = engine.applyRestore({
    key,
    nextEntries: entries,
    nextThreadId: threadId,
    pendingInputRequestIds,
    restoredScrollPosition,
    scrollElement,
  });
  engine.commitSnapshot({ key, threadId, entries, scrollElement });
  return action;
}

// --- first render ------------------------------------------------------

test("first render of a thread jumps to the bottom and commits the snapshot", () => {
  const engine = createTranscriptScrollBookkeeping();
  assert.equal(engine.getSnapshot(), null);

  const action = render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1"), agentEntry("a1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.scrollTop, 1600);
  assert.equal(engine.getSnapshot().activeThreadId, "thread-1");
  assert.equal(engine.getSnapshot().scrollKey, "thread-1");
});

// --- switch away and back ------------------------------------------------

test("switching away and back restores the retained thread's exact offset", () => {
  const engine = createTranscriptScrollBookkeeping();
  render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  render(engine, {
    key: "thread-2",
    threadId: "thread-2",
    entries: [userEntry("u2")],
    scrollElement: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
    // thread-1's geometry the instant the reader left it, mid-history.
    leavingGeometry: makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 }),
  });

  const action = render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
    leavingGeometry: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
  });

  assert.equal(action.kind, "restore-thread");
  assert.equal(action.scrollTop, 300);
});

// --- mid-history restore --------------------------------------------------

test("mid-history restore lands on the exact retained offset regardless of the new render's live geometry", () => {
  const engine = createTranscriptScrollBookkeeping();
  render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    scrollElement: makeScrollElement({ scrollHeight: 5000, clientHeight: 400 }),
  });

  render(engine, {
    key: "thread-2",
    threadId: "thread-2",
    entries: [userEntry("u2")],
    scrollElement: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
    leavingGeometry: makeScrollElement({ scrollHeight: 5000, clientHeight: 400, scrollTop: 1200 }),
  });

  const action = render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    // The thread grew hugely while hidden -- restore-thread must not derive
    // its target from this.
    scrollElement: makeScrollElement({ scrollHeight: 9000, clientHeight: 400 }),
    leavingGeometry: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
  });

  assert.equal(action.kind, "restore-thread");
  assert.equal(action.scrollTop, 1200);
});

// --- bottom-follow intent --------------------------------------------------

test("switching back to a bottom-following thread follows its grown tail, not a stale pixel offset", () => {
  const engine = createTranscriptScrollBookkeeping();
  render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    scrollElement: makeScrollElement({ scrollHeight: 3000, clientHeight: 400 }),
  });

  render(engine, {
    key: "thread-2",
    threadId: "thread-2",
    entries: [userEntry("u2")],
    scrollElement: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
    // The reader was pinned at the very bottom when they left.
    leavingGeometry: makeScrollElement({ scrollHeight: 3000, clientHeight: 400, scrollTop: 2600 }),
  });

  const action = render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    // Grew by 4,000px while hidden.
    scrollElement: makeScrollElement({ scrollHeight: 7000, clientHeight: 400 }),
    leavingGeometry: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
  });

  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.scrollTop, 6600);
});

// --- older-history prepend --------------------------------------------------

test("older transcript prepended in the same thread anchors the viewport so the reader keeps their place", () => {
  const engine = createTranscriptScrollBookkeeping();
  render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1"), agentEntry("a1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  const action = render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [agentEntry("older-1"), agentEntry("older-2"), userEntry("u1"), agentEntry("a1")],
    scrollElement: makeScrollElement({ scrollHeight: 3500, clientHeight: 400, scrollTop: 500 }),
  });

  assert.equal(action.kind, "anchor-prepend");
  assert.equal(action.scrollTop, 3500 - 2000 + 500);
});

// --- first message from an empty thread -------------------------------------

test("a first message on a thread whose empty snapshot is already committed is a new message, not a restore", () => {
  const engine = createTranscriptScrollBookkeeping();
  // An unrelated thread leaves retained history behind, to prove the empty
  // commit below -- not a switch-back into it -- is what the first message
  // actually reads.
  render(engine, {
    key: "decoy",
    threadId: "decoy",
    entries: [userEntry("d1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 900 }),
  });

  // The empty thread commits its own (empty) snapshot under its own key,
  // mirroring Local's "empty-ready" mode.
  engine.commitSnapshot({
    key: "thread-1",
    threadId: "thread-1",
    entries: [],
    scrollElement: makeScrollElement({ scrollHeight: 400, clientHeight: 400 }),
  });

  const action = render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.userEntryId, "u1");
});

// --- pending approval/AskUser claimed exactly once --------------------------

test("a pending input request is claimed exactly once, then leaves the reader alone", () => {
  const engine = createTranscriptScrollBookkeeping();
  const entries = [userEntry("u1"), agentEntry("a1")];
  render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries,
    scrollElement: makeScrollElement({ scrollHeight: 2600, clientHeight: 400 }),
  });

  const scrollElement = makeScrollElement({ scrollHeight: 2600, clientHeight: 400, scrollTop: 800 });
  const first = engine.applyRestore({
    key: "thread-1",
    nextEntries: entries,
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["approval:req-1"],
    restoredScrollPosition: null,
    scrollElement,
  });
  assert.equal(first.kind, "input-required");
  assert.deepEqual(first.inputRequestIds, ["approval:req-1"]);
  assert.ok(engine.anchorsFor("thread-1").has("approval:req-1"));
  engine.commitSnapshot({ key: "thread-1", threadId: "thread-1", entries, scrollElement });

  const second = engine.applyRestore({
    key: "thread-1",
    nextEntries: entries,
    nextThreadId: "thread-1",
    pendingInputRequestIds: ["approval:req-1"],
    restoredScrollPosition: null,
    scrollElement,
  });
  assert.equal(second.kind, "preserve", "the same request must not re-fire once claimed");
});

// --- LRU eviction drops the evicted key's anchors ---------------------------

test("bounded LRU eviction drops the evicted key's anchors along with its retained position", () => {
  const engine = createTranscriptScrollBookkeeping();
  const threadCount = MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS + 2;
  let previousScrollElement = null;

  for (let index = 0; index < threadCount; index += 1) {
    const key = `thread-${index}`;
    const scrollElement = makeScrollElement({ scrollHeight: 1000, clientHeight: 400, scrollTop: index * 5 });
    render(engine, {
      key,
      threadId: key,
      entries: [userEntry(`u-${index}`)],
      scrollElement,
      leavingGeometry: previousScrollElement,
    });
    previousScrollElement = scrollElement;
  }

  assert.equal(engine.readRestoreIntent("thread-0"), null, "the least-recently-used key was evicted");
  assert.equal(engine.anchorsFor("thread-0").size, 0, "its anchors were dropped together with its position");
  assert.ok(engine.anchorsFor("thread-1").has("u-1"), "a retained key keeps its own anchors");
});

// --- reset -------------------------------------------------------------

test("reset clears the snapshot, retained positions, and anchors", () => {
  const engine = createTranscriptScrollBookkeeping();
  render(engine, {
    key: "thread-1",
    threadId: "thread-1",
    entries: [userEntry("u1")],
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });
  render(engine, {
    key: "thread-2",
    threadId: "thread-2",
    entries: [userEntry("u2")],
    scrollElement: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
    leavingGeometry: makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 }),
  });
  assert.notEqual(engine.getSnapshot(), null);
  assert.notEqual(engine.readRestoreIntent("thread-1"), null);
  assert.ok(engine.anchorsFor("thread-2").has("u2"));

  engine.reset();

  assert.equal(engine.getSnapshot(), null);
  assert.equal(engine.readRestoreIntent("thread-1"), null);
  assert.equal(engine.anchorsFor("thread-2").size, 0);
});

// --- retarget / promotion (claude-pending-* -> real id) ---------------------

test("retarget rekeys the snapshot, retained position, and anchors together", () => {
  const engine = createTranscriptScrollBookkeeping();
  const scrollElement = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });

  engine.commitSnapshot({ key: "claude-pending-7", threadId: "claude-pending-7", entries: [], scrollElement });
  engine.rememberView("claude-pending-7", scrollElement);
  engine.applyRestore({
    key: "claude-pending-7",
    nextEntries: [userEntry("u1")],
    nextThreadId: "claude-pending-7",
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement,
  });

  assert.equal(
    engine.retarget({
      fromKey: "claude-pending-7",
      toKey: "real-thread-9",
      fromThreadId: "claude-pending-7",
      toThreadId: "real-thread-9",
    }),
    true
  );

  assert.equal(engine.getSnapshot().activeThreadId, "real-thread-9");
  assert.equal(engine.getSnapshot().scrollKey, "real-thread-9");
  assert.equal(engine.readRestoreIntent("claude-pending-7"), null);
  assert.notEqual(engine.readRestoreIntent("real-thread-9"), null);
  assert.equal(engine.anchorsFor("claude-pending-7").size, 0);
  assert.ok(engine.anchorsFor("real-thread-9").has("u1"));
});

test("retarget is a safe no-op when the keys are missing, unrelated, or identical", () => {
  const engine = createTranscriptScrollBookkeeping();
  assert.equal(
    engine.retarget({ fromKey: "a", toKey: "b", fromThreadId: "a", toThreadId: "b" }),
    false,
    "nothing retained yet"
  );

  engine.commitSnapshot({ key: "other", threadId: "other", entries: [], scrollElement: makeScrollElement() });
  engine.rememberView("other", makeScrollElement({ scrollTop: 10 }));

  assert.equal(
    engine.retarget({ fromKey: "a", toKey: "b", fromThreadId: "a", toThreadId: "b" }),
    false,
    "unrelated key"
  );
  assert.equal(engine.getSnapshot().activeThreadId, "other");

  assert.equal(
    engine.retarget({ fromKey: "a", toKey: "a", fromThreadId: "a", toThreadId: "a" }),
    false,
    "identical from/to key"
  );

  assert.equal(engine.retarget(null), false, "a null options argument must not throw");
  assert.equal(engine.retarget(undefined), false, "a missing options argument must not throw");
});

test("retarget does not corrupt another key's snapshot when thread ids collide", () => {
  // Two distinct scroll keys can carry the same underlying thread id (e.g. a
  // reconnect that reuses a thread id under a different relay). The engine's
  // single retained snapshot belongs to whichever key committed it last
  // (here "keyB") -- retargeting an unrelated "keyA" that happens to share
  // the same thread id must not rewrite keyB's snapshot out from under it.
  const engine = createTranscriptScrollBookkeeping();
  const sharedThreadId = "shared-thread";

  engine.commitSnapshot({
    key: "keyB",
    threadId: sharedThreadId,
    entries: [],
    scrollElement: makeScrollElement({ scrollHeight: 1000, clientHeight: 400 }),
  });

  // keyA retains its own, unrelated position and anchor under the same
  // thread id.
  engine.rememberView("keyA", makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 500 }));
  engine.applyRestore({
    key: "keyA",
    nextEntries: [userEntry("ua1")],
    nextThreadId: sharedThreadId,
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  const changed = engine.retarget({
    fromKey: "keyA",
    toKey: "keyC",
    fromThreadId: sharedThreadId,
    toThreadId: "promoted-thread",
  });

  assert.equal(changed, true, "keyA's own retained position/anchors still moved");
  assert.equal(engine.getSnapshot().activeThreadId, sharedThreadId, "keyB's snapshot thread id is untouched");
  assert.equal(engine.getSnapshot().scrollKey, "keyB", "keyB's snapshot key is untouched");
  assert.equal(engine.readRestoreIntent("keyA"), null);
  assert.notEqual(engine.readRestoreIntent("keyC"), null);
  assert.equal(engine.anchorsFor("keyA").size, 0);
  assert.ok(engine.anchorsFor("keyC").has("ua1"));
});

test("first send after a pending-to-real promotion classifies as a new user message, not a thread switch", () => {
  // A deferred Claude session records its empty snapshot under the synthetic
  // `claude-pending-*` id; the first send promotes the thread to its real id.
  // After retargeting, the first entries must classify as a new user message
  // -- a bottom-follow jump-bottom carrying userEntryId (fire-once).
  const engine = createTranscriptScrollBookkeeping();
  const scrollElement = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });
  engine.commitSnapshot({ key: "claude-pending-42", threadId: "claude-pending-42", entries: [], scrollElement });

  engine.retarget({
    fromKey: "claude-pending-42",
    toKey: "real-42",
    fromThreadId: "claude-pending-42",
    toThreadId: "real-42",
  });

  const action = engine.applyRestore({
    key: "real-42",
    nextEntries: [userEntry("u1")],
    nextThreadId: "real-42",
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement,
  });

  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.userEntryId, "u1");
});

// --- isolation between two distinct keys ------------------------------------

test("two distinct keys retain fully independent positions and anchors", () => {
  const engine = createTranscriptScrollBookkeeping();

  engine.rememberView("a", makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 }));
  engine.rememberView("b", makeScrollElement({ scrollHeight: 5000, clientHeight: 400, scrollTop: 4600 }));

  assert.deepEqual(engine.readRestoreIntent("a"), { followBottom: false, scrollTop: 300 });
  assert.deepEqual(engine.readRestoreIntent("b"), { followBottom: true, scrollTop: 4600 });

  engine.applyRestore({
    key: "a",
    nextEntries: [userEntry("ua1")],
    nextThreadId: "a",
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  assert.ok(engine.anchorsFor("a").has("ua1"));
  assert.equal(engine.anchorsFor("b").size, 0, "claiming an anchor for one key must not leak into another");
});

test("two keys that share a thread id under different relays stay isolated", () => {
  // Remote's scroll key is relay-scoped (`relayId:threadId`), so the same
  // underlying thread id can appear under two different keys at once -- the
  // reader has panes open on two relays whose threads share an id. Nothing
  // about the thread id alone can tell the two panes apart, so this asserts
  // the ACTION each pane gets, not just that the Maps are keyed separately:
  // a switch between them must honor the arriving key's own retained intent
  // rather than reading as "same thread, nothing happened".
  const engine = createTranscriptScrollBookkeeping();
  const sharedThreadId = "shared-thread";
  const entries = [userEntry("u1")];

  // relay-1 is the pane on screen: it claims its anchor and, crucially,
  // commits the engine's single retained snapshot under its own key.
  engine.applyRestore({
    key: "relay-1:shared-thread",
    nextEntries: entries,
    nextThreadId: sharedThreadId,
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });
  engine.commitSnapshot({
    key: "relay-1:shared-thread",
    threadId: sharedThreadId,
    entries,
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });

  // relay-2's pane retained its own mid-history offset on an earlier visit.
  engine.rememberView(
    "relay-2:shared-thread",
    makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 })
  );

  const restoredScrollPosition = engine.readRestoreIntent("relay-2:shared-thread");
  assert.deepEqual(restoredScrollPosition, { followBottom: false, scrollTop: 300 });

  const action = engine.applyRestore({
    key: "relay-2:shared-thread",
    nextEntries: entries,
    nextThreadId: sharedThreadId,
    pendingInputRequestIds: [],
    restoredScrollPosition,
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 0 }),
  });

  assert.equal(
    action.kind,
    "restore-thread",
    "arriving at relay-2 is a transition, even though relay-1's snapshot carries the same thread id"
  );
  assert.equal(action.scrollTop, 300, "relay-2 gets ITS retained offset, not relay-1's position");

  assert.ok(engine.anchorsFor("relay-1:shared-thread").has("u1"));
  assert.deepEqual(
    [...engine.anchorsFor("relay-2:shared-thread")],
    ["u1"],
    "relay-2 claims the entry for ITSELF on arrival; the two anchor sets are separate objects"
  );
  assert.notEqual(
    engine.anchorsFor("relay-1:shared-thread"),
    engine.anchorsFor("relay-2:shared-thread")
  );
});

test("a same-thread-id relay switch restores rather than preserving, with nothing new to anchor", () => {
  // The same defect's quietest shape, and the one that actually reaches a
  // reader: with no unclaimed user entry to fall through to, treating
  // relay-1's snapshot as "the same thread" decides `preserve` and leaves the
  // reader at scrollTop 0 instead of the 300 they left relay-2 at. There is
  // no scroll to undo it afterwards -- the pane just renders in the wrong place.
  const engine = createTranscriptScrollBookkeeping();
  const sharedThreadId = "shared-thread";
  const entries = [agentEntry("a1")];

  engine.commitSnapshot({
    key: "relay-1:shared-thread",
    threadId: sharedThreadId,
    entries,
    scrollElement: makeScrollElement({ scrollHeight: 2000, clientHeight: 400 }),
  });
  engine.rememberView(
    "relay-2:shared-thread",
    makeScrollElement({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 })
  );

  const scrollElement = makeScrollElement({
    scrollHeight: 2000,
    clientHeight: 400,
    scrollTop: 0,
  });
  const action = engine.applyRestore({
    key: "relay-2:shared-thread",
    nextEntries: entries,
    nextThreadId: sharedThreadId,
    pendingInputRequestIds: [],
    restoredScrollPosition: engine.readRestoreIntent("relay-2:shared-thread"),
    scrollElement,
  });

  assert.equal(action.kind, "restore-thread");
  assert.equal(action.scrollTop, 300);
  assert.equal(scrollElement.scrollTop, 300, "the reader is actually moved, not left at 0");
});

// --- retarget across relay-scoped keys (Remote's flavor of promotion) ------

test("retarget across relay-scoped keys rekeys positions, anchors, and the snapshot together", () => {
  const engine = createTranscriptScrollBookkeeping();
  const scrollElement = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });

  engine.commitSnapshot({
    key: "relay-1:claude-pending-3",
    threadId: "claude-pending-3",
    entries: [],
    scrollElement,
  });
  engine.rememberView("relay-1:claude-pending-3", scrollElement);
  engine.applyRestore({
    key: "relay-1:claude-pending-3",
    nextEntries: [userEntry("u1")],
    nextThreadId: "claude-pending-3",
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement,
  });

  assert.equal(
    engine.retarget({
      fromKey: "relay-1:claude-pending-3",
      toKey: "relay-1:real-3",
      fromThreadId: "claude-pending-3",
      toThreadId: "real-3",
    }),
    true
  );

  assert.equal(engine.getSnapshot().activeThreadId, "real-3");
  assert.equal(engine.getSnapshot().scrollKey, "relay-1:real-3");
  assert.equal(engine.readRestoreIntent("relay-1:claude-pending-3"), null);
  assert.notEqual(engine.readRestoreIntent("relay-1:real-3"), null);
  assert.equal(engine.anchorsFor("relay-1:claude-pending-3").size, 0);
  assert.ok(engine.anchorsFor("relay-1:real-3").has("u1"));
});

test("first send after a relay-scoped promotion classifies as a new user message, not a thread switch", () => {
  const engine = createTranscriptScrollBookkeeping();
  const scrollElement = makeScrollElement({ scrollHeight: 2000, clientHeight: 400 });
  engine.commitSnapshot({
    key: "relay-1:claude-pending-9",
    threadId: "claude-pending-9",
    entries: [],
    scrollElement,
  });

  engine.retarget({
    fromKey: "relay-1:claude-pending-9",
    toKey: "relay-1:real-9",
    fromThreadId: "claude-pending-9",
    toThreadId: "real-9",
  });

  const action = engine.applyRestore({
    key: "relay-1:real-9",
    nextEntries: [userEntry("u1")],
    nextThreadId: "real-9",
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement,
  });

  assert.equal(action.kind, "jump-bottom");
  assert.equal(action.userEntryId, "u1");
});

test("retarget across relay-scoped keys is a safe no-op when nothing matches", () => {
  const engine = createTranscriptScrollBookkeeping();
  engine.commitSnapshot({
    key: "relay-1:other",
    threadId: "other",
    entries: [],
    scrollElement: makeScrollElement(),
  });

  assert.equal(
    engine.retarget({
      fromKey: "relay-1:a",
      toKey: "relay-1:b",
      fromThreadId: "a",
      toThreadId: "b",
    }),
    false
  );
  assert.equal(engine.getSnapshot().activeThreadId, "other");
  assert.equal(engine.getSnapshot().scrollKey, "relay-1:other");
});

// --- hasPosition -------------------------------------------------------

test("hasPosition is a pure existence check that does not refresh LRU recency", () => {
  const engine = createTranscriptScrollBookkeeping();
  engine.rememberView("a", makeScrollElement({ scrollTop: 10 }));
  engine.rememberView("b", makeScrollElement({ scrollTop: 20 }));

  assert.equal(engine.hasPosition("a"), true);
  assert.equal(engine.hasPosition("missing"), false);

  // Repeated checks must not move "a" to most-recently-used: fill up to
  // capacity without touching it any other way.
  engine.hasPosition("a");
  engine.hasPosition("a");
  for (let index = 0; index < MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS - 2; index += 1) {
    engine.rememberView(`filler-${index}`, makeScrollElement({ scrollTop: index }));
  }
  assert.equal(engine.hasPosition("a"), true, "at capacity, but not yet evicted");

  // One more distinct key pushes past capacity. "a" is the least-recently-used
  // entry (inserted first, never refreshed by hasPosition), so it is the one
  // evicted -- proving hasPosition's reads above did not refresh it.
  engine.rememberView("tiebreaker", makeScrollElement({ scrollTop: 99 }));
  assert.equal(engine.hasPosition("a"), false, "the untouched-by-hasPosition key was evicted first");
  assert.equal(engine.hasPosition("b"), true);
});

// ---------------------------------------------------------------------------
// Generation ownership. Everything retained here is keyed by ITEM IDS, and a new
// relay run renames the same messages, so nothing retained under one run may be
// applied under another.
// ---------------------------------------------------------------------------

function seeded(generation) {
  const engine = createTranscriptScrollBookkeeping();
  engine.syncGeneration(generation);
  engine.commitSnapshot({
    key: "T",
    threadId: "T",
    entries: [userEntry("u1")],
    scrollElement: { scrollTop: 40, scrollHeight: 400, clientHeight: 100 },
  });
  engine.rememberView("T", { scrollTop: 40, scrollHeight: 400, clientHeight: 100 });
  engine.applyRestore({
    key: "T",
    nextEntries: [userEntry("u1")],
    nextThreadId: "T",
    pendingInputRequestIds: [],
    restoredScrollPosition: null,
    scrollElement: { scrollTop: 40, scrollHeight: 400, clientHeight: 100 },
  });
  return engine;
}

test("a generation change drops the snapshot, positions and anchors", () => {
  const engine = seeded("gen-a");
  assert.ok(engine.getSnapshot(), "seeded");
  assert.equal(engine.hasPosition("T"), true, "seeded");

  assert.equal(engine.syncGeneration("gen-b"), true, "the change is reported");

  assert.equal(engine.getSnapshot(), null, "a snapshot naming gen-a ids cannot be applied");
  assert.equal(engine.hasPosition("T"), false, "nor a position filed against them");
  assert.equal(engine.anchorsFor("T").size, 0, "nor the anchored-id set");
});

test("both empty boundaries count as a change", () => {
  // "" -> "gen-a" is a relay that gained stamping, "gen-a" -> "" is one that
  // lost it. Both renumber, so both must drop what the other run's ids anchored.
  const upgrading = seeded("");
  assert.equal(upgrading.syncGeneration("gen-a"), true, "empty -> stamped resets");
  assert.equal(upgrading.getSnapshot(), null);

  const downgrading = seeded("gen-a");
  assert.equal(downgrading.syncGeneration(""), true, "stamped -> empty resets");
  assert.equal(downgrading.getSnapshot(), null);
});

test("an old relay's steady empty generation never resets, and repeats do not either", () => {
  // The termination property: a relay that never stamps holds "" forever, so
  // this must be a no-op every render rather than wiping the reader's place on
  // each one. null/undefined normalise to the same "" so they do not flap.
  const engine = seeded("");
  for (const value of ["", null, undefined, "", null]) {
    assert.equal(engine.syncGeneration(value), false, `steady empty: ${String(value)}`);
  }
  assert.ok(engine.getSnapshot(), "the reader's place survives");
  assert.equal(engine.hasPosition("T"), true);

  const stamped = seeded("gen-a");
  for (let i = 0; i < 5; i += 1) {
    assert.equal(stamped.syncGeneration("gen-a"), false, "a steady stamped generation is a no-op");
  }
  assert.ok(stamped.getSnapshot());
});

test("mount adopts the live generation instead of reading itself as a change", () => {
  const engine = createTranscriptScrollBookkeeping();
  assert.equal(engine.syncGeneration("gen-a"), false, "first sync is adoption, not a reset");
});

test("same-generation promotion still retargets", () => {
  // The deferred-Claude rekey must keep working: it is a rename WITHIN one run,
  // not a run change, and the fence must not eat it.
  const engine = seeded("gen-a");
  assert.equal(engine.syncGeneration("gen-a"), false);

  assert.equal(
    engine.retarget({
      fromKey: "T",
      toKey: "T2",
      fromThreadId: "T",
      toThreadId: "T2",
    }),
    true,
    "the promoted pair is still rekeyed across all three retained things"
  );
  assert.equal(engine.hasPosition("T2"), true);
  assert.equal(engine.getSnapshot().activeThreadId, "T2");
});
