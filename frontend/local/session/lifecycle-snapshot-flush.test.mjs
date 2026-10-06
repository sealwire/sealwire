import test from "node:test";
import assert from "node:assert/strict";
import { THREAD, entry, baseSnapshot, createLifecycleHarness } from "./test-support/lifecycle-harness.mjs";

const { snapshotIsInteractive } = await import("./lifecycle.js");
const { createSessionController } = await import("../session-controller.js");
const { createThreadListStore } = await import("../../shared/thread-list-store.js");
const { TRANSCRIPT_FLUSH_MIN_WINDOW_MS } = await import("../../shared/transcript-flush-scheduler.js");

test("thread-list loads notify the composer after updated titles land without a session render", async () => {
  let rows = [{ id: "peer", name: "中文安全审查", provider: "codex", cwd: "/tmp/project" }];
  const updates = [];
  const harness = createLifecycleHarness({
    apiFetch: async () => ({ ok: true, json: async () => ({ ok: true, data: { threads: rows } }) }),
    onThreadsUpdated: () => updates.push(harness.state.threads.map((thread) => thread.name)),
  });
  harness.state.threadListStore = createThreadListStore();
  harness.state.session = baseSnapshot();
  const controller = createSessionController(harness.ctx);
  try {
    await controller.loadThreads("poll");
    rows = [{ ...rows[0], name: "更新后的内容标题" }];
    await controller.loadThreads("poll");
    rows = [{ ...rows[0], name: "用户改名", renamed: true }];
    await controller.loadThreads("session renamed", { fresh: true });
    assert.deepEqual(updates, [["中文安全审查"], ["更新后的内容标题"], ["用户改名"]]);
    assert.equal(harness.rendered.length, 0, "no snapshot or session render is needed");
  } finally {
    controller.cancelThreadsPoll();
  }
});

test("a snapshot interleaved with a pending delta flush renders exactly once, keeping the longer delta text over the truncated preview", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({ transcript: [entry("agent-1", "Hello", { status: "running" })] });
  h.state.transcriptHydrationOrder = ["agent-1"];
  h.state.transcriptHydrationEntries = new Map([
    ["agent-1", entry("agent-1", "Hello", { status: "running" })],
  ]);

  // The live delta stream extends the window's cached body to "Hello world"
  // and queues a coalesced render.
  h.stream.applyLocalTranscriptEntryDelta({
    item_id: "agent-1",
    thread_id: THREAD,
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(h.rendered.length, 0, "the delta must still be coalescing");

  // An ordinary mid-stream snapshot arrives with the server's compacted
  // (truncated) preview for the same entry — turn state, approvals and
  // thread id are unchanged, so this is NOT an interactive snapshot.
  h.lifecycle.applySessionSnapshot(
    baseSnapshot({
      active_turn_id: null,
      transcript: [entry("agent-1", "Hel", { status: "running", content_state: "preview" })],
    })
  );
  assert.equal(h.rendered.length, 0, "an ordinary snapshot must coalesce with the pending delta");

  h.clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(h.rendered.length, 1, "the delta and the snapshot must produce exactly one render");
  assert.equal(
    h.rendered[0].transcript.find((candidate) => candidate.item_id === "agent-1").text,
    "Hello world",
    "the longer delta text must survive over the snapshot's truncated preview"
  );
});

// P1: restoreHydratedTranscriptSnapshot (transcript-hydration-store.js)
// overlays a snapshot's tail onto the window WITHOUT writing the result back
// into state.transcriptHydrationEntries/order — it is a per-render overlay,
// not a persisted merge (its own comment: "never clone the whole window
// every snapshot"). So a brand-new entry the snapshot introduces exists only
// in the returned `merged.transcript`, never in the window Map. If a delta
// for some OTHER item is still pending settlement when this snapshot lands,
// settling later (e.g. at the next flush) rebuilds the array PURELY from the
// window via renderedTranscriptFromWindow — which has never heard of the new
// entry — and the entry silently disappears. The fix settles BEFORE the
// snapshot overlay runs, so nothing is left pending to later re-derive from
// the (window-only) old state and clobber the fresher merged transcript.
test("a snapshot introducing a brand-new entry keeps it after a same-flush pending delta for another item", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({ transcript: [entry("agent-1", "Hello", { status: "running" })] });
  h.state.transcriptHydrationOrder = ["agent-1"];
  h.state.transcriptHydrationEntries = new Map([
    ["agent-1", entry("agent-1", "Hello", { status: "running" })],
  ]);

  // A live delta for agent-1 queues a coalesced render — a projection is now
  // pending, unrelated to the snapshot below.
  h.stream.applyLocalTranscriptEntryDelta({
    item_id: "agent-1",
    thread_id: THREAD,
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(h.rendered.length, 0, "the delta must still be coalescing");

  // Before the flush, an ordinary snapshot arrives introducing "agent-2" — an
  // entry the hydration window has never seen. It coalesces into the same
  // pending flush (turn state and approvals are unchanged).
  h.lifecycle.applySessionSnapshot(
    baseSnapshot({
      active_turn_id: null,
      transcript: [
        entry("agent-1", "Hel", { status: "running", content_state: "preview" }),
        entry("agent-2", "a brand new tool result", { status: "completed" }),
      ],
    })
  );
  assert.equal(h.rendered.length, 0, "the snapshot must also coalesce with the pending delta");

  h.clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(h.rendered.length, 1);
  const rendered = h.rendered[0].transcript;
  assert.equal(
    rendered.find((candidate) => candidate.item_id === "agent-1")?.text,
    "Hello world",
    "the pending delta's text must still survive"
  );
  assert.ok(
    rendered.some((candidate) => candidate.item_id === "agent-2"),
    "the snapshot's brand-new entry must not disappear when the pending delta settles"
  );
});

// P1 (review, reverse of the two tests above): restoreHydratedTranscriptSnapshot
// (transcript-hydration-store.js) merges a snapshot's tail onto the window only
// for the RETURNED array — it never writes that merge back into
// state.transcriptHydrationEntries/order. So when a snapshot introduces an
// entry the window has never cached, and a genuine continuation delta for
// THAT SAME entry arrives before the next flush, the delta finds no cached
// base text, takes the "unknown item" branch, and — because its offset is
// non-zero — stores an EMPTY preview shell for it. The next settle rebuilds
// state.session.transcript purely from the window and overwrites the
// snapshot's own text with that empty shell, silently erasing text nobody
// ever restreamed. The fix must synchronize the snapshot's tail merge into
// the canonical window, not just the returned object.
test("a delta for an entry the snapshot just introduced does not erase the snapshot's own text at settle", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({ transcript: [entry("agent-1", "Hello", { status: "running" })] });
  h.state.transcriptHydrationOrder = ["agent-1"];
  h.state.transcriptHydrationEntries = new Map([
    ["agent-1", entry("agent-1", "Hello", { status: "running" })],
  ]);

  // An ordinary snapshot introduces "agent-2" with a body the window has
  // never cached — e.g. a tool result written in one shot, not streamed
  // token-by-token yet. Turn state is unchanged, so this coalesces.
  h.lifecycle.applySessionSnapshot(
    baseSnapshot({
      transcript: [
        entry("agent-1", "Hello", { status: "running" }),
        entry("agent-2", "Partial result", { status: "running" }),
      ],
    })
  );
  assert.equal(h.rendered.length, 0, "an ordinary snapshot must coalesce, not paint immediately");

  // Before the flush, a genuine continuation delta for agent-2 arrives,
  // offset at the length of the text the snapshot just introduced.
  h.stream.applyLocalTranscriptEntryDelta({
    item_id: "agent-2",
    thread_id: THREAD,
    turn_id: "turn-1",
    delta: " continues",
    delta_kind: "agent_text",
    text_offset: "Partial result".length,
  });

  h.clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(h.rendered.length, 1);
  const rendered = h.rendered[0].transcript;
  assert.equal(
    rendered.find((candidate) => candidate.item_id === "agent-2")?.text,
    "Partial result continues",
    "the snapshot's own text for agent-2 must survive, with the delta appended — not be erased"
  );
});

// P1 (review): restoreHydratedTranscriptSnapshot returns the incoming
// snapshot UNCHANGED whenever the hydration window has never loaded for this
// thread (transcriptHydrationOrder is empty) — a normal steady state, since
// deltas legitimately arrive before the first hydration fetch resolves, not
// an edge case. Nothing then protects the longer text already streamed into
// state.session from a shorter/compacted snapshot body for the same entry
// before it overwrites state.session — unlike remote, which guards this
// unconditionally via preserveVisibleTranscriptText.
test("a snapshot arriving before hydration ever loads does not overwrite longer streamed text with a shorter/compacted body", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({
    transcript: [
      entry("agent-1", "Hello world, this is the full streamed answer", { status: "running" }),
    ],
  });
  // Hydration has never loaded for this thread.
  h.state.transcriptHydrationOrder = [];
  h.state.transcriptHydrationEntries = new Map();

  // A compacted/preview snapshot arrives for the SAME entry with shorter text
  // (e.g. the relay's max_transcript_chars clip) — turn state is unchanged.
  h.lifecycle.applySessionSnapshot(
    baseSnapshot({
      active_turn_id: null,
      transcript: [entry("agent-1", "Hello wor", { status: "running", content_state: "preview" })],
    })
  );

  h.clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(h.rendered.length, 1);
  assert.equal(
    h.rendered[0].transcript.find((candidate) => candidate.item_id === "agent-1")?.text,
    "Hello world, this is the full streamed answer",
    "the longer already-visible text must survive an unhydrated snapshot's shorter body"
  );
});

test("an ordinary streaming snapshot coalesces rather than painting immediately", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot();

  h.lifecycle.applySessionSnapshot(baseSnapshot({ transcript: [entry("agent-1", "hi")] }));

  assert.equal(h.rendered.length, 0);
  h.clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(h.rendered.length, 1);
});

test("a snapshot adding a pending approval flushes on the same tick", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot();

  h.lifecycle.applySessionSnapshot(
    baseSnapshot({ pending_approvals: [{ request_id: "approval-1", summary: "Run" }] })
  );

  assert.equal(h.rendered.length, 1, "an approval must paint immediately, not wait out the window");
});

test("a snapshot resolving a pending approval flushes on the same tick", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({
    pending_approvals: [{ request_id: "approval-1", summary: "Run" }],
  });

  h.lifecycle.applySessionSnapshot(baseSnapshot({ pending_approvals: [] }));

  assert.equal(h.rendered.length, 1);
});

test("a snapshot adding a pending AskUserQuestion flushes on the same tick", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot();

  h.lifecycle.applySessionSnapshot(
    baseSnapshot({ pending_ask_user_questions: [{ request_id: "question-1" }] })
  );

  assert.equal(h.rendered.length, 1);
});

test("a snapshot whose turn completes (goes idle) flushes on the same tick", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({ active_turn_id: "turn-1", current_status: "active" });

  h.lifecycle.applySessionSnapshot(baseSnapshot({ active_turn_id: null, current_status: "idle" }));

  assert.equal(
    h.rendered.length,
    1,
    "turn completion must paint at once — it is the only way local sees completion at all"
  );
});

test("a snapshot adding a failed transcript entry flushes on the same tick, even while the turn stays idle", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({ active_turn_id: null, current_status: "idle" });

  h.lifecycle.applySessionSnapshot(
    baseSnapshot({
      active_turn_id: null,
      current_status: "idle",
      transcript: [entry("agent-1", "boom", { kind: "error", status: "failed" })],
    })
  );

  assert.equal(
    h.rendered.length,
    1,
    "an error entry must paint at once even though turn state alone would coalesce"
  );
});

test("a snapshot reporting the workspace missing flushes on the same tick", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot();

  h.lifecycle.applySessionSnapshot(
    baseSnapshot({ workspace_missing: { recorded_cwd: "/tmp/gone" } })
  );

  assert.equal(h.rendered.length, 1);
});

test("a snapshot switching the active thread flushes on the same tick", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({ active_thread_id: "thread-1" });

  h.lifecycle.applySessionSnapshot(baseSnapshot({ active_thread_id: "thread-2" }));

  assert.equal(h.rendered.length, 1);
});

// P1 (two review findings, closely coupled): app.js's renderSession wrap
// freezes the thread the user is viewing into a view-only pin when the ACTIVE
// thread switches out from under it, using "the live session a moment ago" —
// which it used to recover by reading state.session before its OWN write
// reached it. That stopped working once applySessionSnapshot had to advance
// state.session synchronously here too (queue() only defers the PAINT, never
// the write), so applySessionSnapshot must stash the outgoing session
// explicitly for app.js to read (lifecycle.js:1007 / app.js:1213).
//
// Second, closely coupled finding: switchTranscriptHydrationThread (which
// repoints the hydration window at the incoming thread) used to run BEFORE
// settleTranscriptProjection. A pending delta for the OUTGOING thread then
// fails settleTranscriptProjection's transcriptWindowIsLoaded check against
// the just-switched-to window, has its pending flag cleared anyway, and is
// never rebuilt into state.session.transcript — so the stash above would
// freeze a pin missing the last thing the user watched stream in
// (lifecycle.js:938 running before the settle at :997).
test("a snapshot switching threads stashes the outgoing session for the view-only pin, with its pending delta already settled into it", () => {
  const h = createLifecycleHarness();
  h.state.session = baseSnapshot({
    active_thread_id: THREAD,
    transcript: [entry("agent-1", "Hello", { status: "running" })],
  });
  h.state.transcriptHydrationThreadId = THREAD;
  h.state.transcriptHydrationOrder = ["agent-1"];
  h.state.transcriptHydrationEntries = new Map([
    ["agent-1", entry("agent-1", "Hello", { status: "running" })],
  ]);

  // A live delta extends the OUTGOING thread's window but is still
  // coalescing — state.session.transcript itself still reads the pre-delta
  // text until something settles it.
  h.stream.applyLocalTranscriptEntryDelta({
    item_id: "agent-1",
    thread_id: THREAD,
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(
    h.state.session.transcript[0].text,
    "Hello",
    "sanity: the delta is still deferred before the switch below"
  );

  // A snapshot for a DIFFERENT thread arrives — e.g. the user started a new
  // session while thread-1 was still streaming.
  h.lifecycle.applySessionSnapshot(baseSnapshot({ active_thread_id: "thread-2" }));

  assert.equal(
    h.state.previousLiveSessionForPin?.active_thread_id,
    THREAD,
    "the outgoing thread's session must be stashed for app.js's view-only pin to read"
  );
  assert.equal(
    h.state.previousLiveSessionForPin?.transcript.find((candidate) => candidate.item_id === "agent-1")?.text,
    "Hello world",
    "and it must carry the SETTLED text — the pending delta must not be lost when the window switches threads"
  );
});

test("the very first snapshot (no previous session) flushes immediately", () => {
  const h = createLifecycleHarness();
  assert.equal(h.state.session, null);

  h.lifecycle.applySessionSnapshot(baseSnapshot());

  assert.equal(h.rendered.length, 1);
});

test("snapshotIsInteractive", async (t) => {
  await t.test("is interactive with no previous snapshot", () => {
    assert.equal(snapshotIsInteractive(null, baseSnapshot()), true);
  });

  await t.test("is not interactive when nothing turn-relevant changed", () => {
    const prev = baseSnapshot();
    const next = baseSnapshot({ transcript: [entry("agent-1", "hi")] });
    assert.equal(snapshotIsInteractive(prev, next), false);
  });

  await t.test("is interactive when the approval id set changes", () => {
    const prev = baseSnapshot();
    const next = baseSnapshot({ pending_approvals: [{ request_id: "a" }] });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });

  await t.test("is interactive when the AskUserQuestion id set changes", () => {
    const prev = baseSnapshot({ pending_ask_user_questions: [{ request_id: "q" }] });
    const next = baseSnapshot({ pending_ask_user_questions: [] });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });

  await t.test("is interactive when active_turn_id changes", () => {
    const prev = baseSnapshot({ active_turn_id: "turn-1" });
    const next = baseSnapshot({ active_turn_id: null });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });

  await t.test("is interactive when current_status changes", () => {
    const prev = baseSnapshot({ current_status: "active" });
    const next = baseSnapshot({ current_status: "idle" });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });

  await t.test("is interactive when workspace_missing appears", () => {
    const prev = baseSnapshot();
    const next = baseSnapshot({ workspace_missing: { recorded_cwd: "/tmp/gone" } });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });

  await t.test("is interactive when a transcript entry fails, even while turn state is unchanged", () => {
    const prev = baseSnapshot({ active_turn_id: null, current_status: "idle" });
    const next = baseSnapshot({
      active_turn_id: null,
      current_status: "idle",
      transcript: [entry("agent-1", "boom", { kind: "error", status: "failed" })],
    });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });

  await t.test("is not interactive when a previously-reported failure persists unchanged", () => {
    const failedEntry = entry("agent-1", "boom", { kind: "error", status: "failed" });
    const prev = baseSnapshot({ transcript: [failedEntry] });
    const next = baseSnapshot({ transcript: [failedEntry] });
    assert.equal(snapshotIsInteractive(prev, next), false);
  });

  await t.test("is interactive when active_thread_id changes", () => {
    const prev = baseSnapshot({ active_thread_id: "thread-1" });
    const next = baseSnapshot({ active_thread_id: "thread-2" });
    assert.equal(snapshotIsInteractive(prev, next), true);
  });
});
