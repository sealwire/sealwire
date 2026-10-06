import test from "node:test";
import assert from "node:assert/strict";
import { entry, baseSnapshot, createLifecycleHarness } from "./test-support/lifecycle-harness.mjs";

const { createPairingController } = await import("./pairing.js");
const { createViewOnlyRefreshOps } = await import("../view-only-refresh-ops.js");
const { buildViewOnlyPin } = await import("../view-only-thread.js");
const { hydrateLocalTranscript, loadOlderLocalTranscript } = await import("../transcript/hydration.js");

function numberedRows(start, end) {
  return Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return entry(`row-${index}`, `message ${index}`, {
      row_id: `row-${index}`,
      order_seq: index * 1048576,
    });
  });
}

function createTakeOverHarness() {
  const target = "background-thread";
  const generation = "take-over-generation";
  let refresh;
  const h = createLifecycleHarness({
    onRender: (session) => refresh?.maybeRefreshViewOnly(session),
  });
  h.state.session = baseSnapshot({ transcript_generation: generation });
  h.state.viewThreadId = target;
  h.state.viewOnlyThread = buildViewOnlyPin({
    threadId: target,
    relayGeneration: generation,
    generation: 1,
    historyExtended: true,
    page: { entries: numberedRows(20, 60), prev_cursor: "before-20", revision: 10 },
  });
  refresh = createViewOnlyRefreshOps({
    getState: () => h.state,
    fetchTranscriptPage: async () => { throw new Error("unexpected view-only fetch"); },
    renderSession: () => {},
  });
  const snapshot = baseSnapshot({
    active_thread_id: target,
    transcript_generation: generation,
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: numberedRows(52, 60),
  });
  h.ctx.applySessionSnapshot = h.lifecycle.applySessionSnapshot;
  h.ctx.shortId = (id) => id;
  h.ctx.apiFetch = async (url, options) => {
    assert.equal(url, "/api/session/take-over");
    assert.equal(JSON.parse(options.body).thread_id, target);
    return { ok: true, json: async () => ({ ok: true, data: snapshot }) };
  };
  return { ...h, target, generation, snapshot, pairing: createPairingController(h.ctx) };
}

for (const streamFirst of [false, true]) {
  test(`take-over keeps viewed history and streamed text when ${streamFirst ? "SSE" : "HTTP"} lands first`, async () => {
    const h = createTakeOverHarness();
    h.stream.applyLocalTranscriptEntryDelta({
      thread_id: h.target,
      transcript_generation: h.generation,
      item_id: "row-59",
      row_id: "row-59",
      order_seq: 59 * 1048576,
      turn_id: "turn-1",
      delta_kind: "agent_text",
      text_offset: "message 59".length,
      delta: " streamed before take-over",
    });
    h.snapshot.transcript.at(-1).content_state = "preview";
    if (streamFirst) h.lifecycle.applySessionSnapshot(h.snapshot);
    await h.pairing.takeOverControl();
    if (!streamFirst) h.lifecycle.applySessionSnapshot(h.snapshot);
    h.clock.tick(100);

    assert.equal(h.state.viewOnlyThread, null);
    for (const painted of h.rendered.filter(session => session.active_thread_id === h.target)) {
      assert.deepEqual(painted.transcript.map(row => row.row_id), numberedRows(20, 60).map(row => row.row_id));
      assert.equal(painted.transcript.at(-1).text, "message 59 streamed before take-over");
    }
    assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");

    let releaseTail;
    let tailReads = 0;
    const hydration = hydrateLocalTranscript(h.state, h.state.session, {
      fetchPage: ({ before }) => {
        tailReads++;
        assert.equal(before, null);
        return new Promise(resolve => { releaseTail = resolve; });
      },
      onProgress: (snapshot) => { h.state.session = snapshot; },
      onError: (error) => { throw error; },
    });
    assert.equal(tailReads, 1);
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 60).map(row => row.row_id));
    h.stream.applyLocalTranscriptEntryDelta({
      thread_id: h.target,
      transcript_generation: h.generation,
      item_id: "row-60",
      row_id: "row-60",
      order_seq: 60 * 1048576,
      turn_id: "turn-1",
      delta_kind: "agent_text",
      text_offset: 0,
      delta: "streamed after take-over",
    });
    h.clock.tick(100);
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 61).map(row => row.row_id));
    assert.equal(h.state.session.transcript.at(-1).text, "streamed after take-over");
    assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
    releaseTail({
      thread_id: h.target, transcript_generation: h.generation,
      revision: 11, entries: numberedRows(52, 60), prev_cursor: "before-52",
    });
    await hydration;
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 61).map(row => row.row_id));
    assert.equal(h.state.session.transcript.find(row => row.row_id === "row-59").text, "message 59 streamed before take-over");
    assert.equal(h.state.session.transcript.at(-1).text, "streamed after take-over");
    assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
    await hydrateLocalTranscript(h.state, h.state.session, {
      fetchPage: async () => { throw new Error("a settled take-over must not reread the same tail"); },
      onError: (error) => { throw error; },
    });
  });
}

for (const start of [0, 30]) {
  test(`take-over combines restored and viewed history when the ${start ? "viewed" : "restored"} window is older`, async () => {
    const h = createTakeOverHarness();
    h.state.transcriptHydrationThreadCache = new Map([[h.target, {
      entries: new Map(numberedRows(start, 40).map(row => [row.row_id, row])),
      order: numberedRows(start, 40).map(row => row.row_id),
      olderCursor: `before-${start}`,
      generation: h.generation,
      tailReady: true,
      keyed: true,
    }]]);
    await h.pairing.takeOverControl();
    const earliest = Math.min(start, 20);
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(earliest, 60).map(row => row.row_id));
    assert.equal(h.state.transcriptHydrationOlderCursor, `before-${earliest}`);
  });
}

test("take-over retains messages while a background refresh is loading", async () => {
  const h = createTakeOverHarness();
  h.state.viewOnlyThread.loading = true;
  await h.pairing.takeOverControl();
  assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 60).map(row => row.row_id));
});

test("take-over keeps a viewed delta newer than the restored window and the pin's last page read", async () => {
  const h = createTakeOverHarness();
  h.state.transcriptHydrationThreadCache = new Map([[h.target, {
    entries: new Map(numberedRows(0, 60).map(row => [row.row_id, row])),
    order: numberedRows(0, 60).map(row => row.row_id),
    olderCursor: null,
    generation: h.generation,
    tailReady: true,
    keyed: true,
    seenRevisions: new Map([["row-59", 11]]),
    bodyRevisions: new Map([["row-59", 11]]),
  }]]);
  h.stream.applyLocalTranscriptEntryDelta({
    thread_id: h.target,
    transcript_generation: h.generation,
    item_id: "row-59",
    row_id: "row-59",
    order_seq: 59 * 1048576,
    turn_id: "turn-1",
    revision: 12,
    delta_kind: "agent_text",
    text_offset: "message 59".length,
    delta: " latest streamed text",
  });
  h.snapshot.transcript_revision = 13;
  h.snapshot.transcript.at(-1).content_state = "preview";
  await h.pairing.takeOverControl();
  assert.equal(h.state.session.transcript.at(-1).text, "message 59 latest streamed text");
  assert.equal(h.state.transcriptHydrationOlderCursor, null);
});

test("take-over carries a background delta gap into the active transcript repair", async () => {
  const h = createTakeOverHarness();
  h.stream.applyLocalTranscriptEntryDelta({
    thread_id: h.target,
    transcript_generation: h.generation,
    item_id: "row-59",
    row_id: "row-59",
    order_seq: 59 * 1048576,
    turn_id: "turn-1",
    delta_kind: "agent_text",
    text_offset: 20,
    delta: "missing earlier bytes",
  });
  assert.equal(h.state.viewOnlyThread.tailGap, true);
  h.snapshot.transcript.at(-1).content_state = "preview";
  await h.pairing.takeOverControl();
  let reads = 0;
  await hydrateLocalTranscript(h.state, h.state.session, {
    fetchPage: async ({ threadId, before }) => {
      reads++;
      assert.equal(threadId, h.target);
      assert.equal(before, null);
      const entries = numberedRows(52, 60);
      entries.at(-1).text = "message 59 repaired";
      return {
        thread_id: h.target,
        transcript_generation: h.generation,
        entries,
        revision: 11,
        prev_cursor: "before-52",
      };
    },
    onProgress: (snapshot) => { h.state.session = snapshot; },
    onError: (error) => { throw error; },
  });
  assert.equal(reads, 1);
  assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 60).map(row => row.row_id));
  assert.equal(h.state.session.transcript.at(-1).text, "message 59 repaired");
});

test("take-over discards a restored window from an older relay generation", async () => {
  const h = createTakeOverHarness();
  h.state.transcriptHydrationThreadCache = new Map([[h.target, {
    entries: new Map(numberedRows(0, 20).map(row => [row.row_id, row])),
    order: numberedRows(0, 20).map(row => row.row_id),
    olderCursor: "before-0",
    generation: "previous-run",
    tailReady: true,
    keyed: true,
  }]]);
  await h.pairing.takeOverControl();
  assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 60).map(row => row.row_id));
  assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
});

test("take-over rejects viewed history from a previous relay generation", async () => {
  const h = createTakeOverHarness();
  h.state.viewOnlyThread.relayGeneration = "previous-run";
  await h.pairing.takeOverControl();
  assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(52, 60).map(row => row.row_id));
});

for (const loading of [false, true]) {
  test(`take-over refreshes unstreamed tool rows and terminal states${loading ? " while the pin is loading" : ""}`, async () => {
    const h = createTakeOverHarness();
    h.state.viewOnlyThread.entries = numberedRows(20, 52);
    h.state.viewOnlyThread.loading = loading;
    if (loading) h.state.viewOnlyThread.resyncRevision = 12;
    const fresh = numberedRows(52, 72).map((row, index) => index % 2
      ? { ...row, kind: "tool_call", tool: { name: "Bash", command: "test command" } }
      : row);
    for (const row of fresh.filter(row => row.kind === "agent_text")) {
      h.stream.applyLocalTranscriptEntryDelta({
        thread_id: h.target,
        transcript_generation: h.generation,
        item_id: row.item_id,
        row_id: row.row_id,
        order_seq: row.order_seq,
        turn_id: "turn-1",
        delta_kind: "agent_text",
        text_offset: 0,
        delta: row.text,
      });
    }
    Object.assign(h.snapshot, {
      active_turn_id: "turn-1", current_status: "active",
      transcript_revision: 12, transcript: fresh.slice(-8),
    });
    await h.pairing.takeOverControl();
    assert.equal(h.state.session.transcript.some(row => row.row_id === "row-53"), false);
    assert.equal(h.state.session.transcript.find(row => row.row_id === "row-52").status, "running");
    let reads = 0;
    await hydrateLocalTranscript(h.state, h.state.session, {
      fetchPage: async ({ threadId, before }) => {
        reads++;
        assert.equal(threadId, h.target);
        assert.equal(before, null);
        return {
          thread_id: h.target, transcript_generation: h.generation,
          revision: 12, entries: fresh, prev_cursor: "before-52",
        };
      },
      onProgress: (snapshot) => { h.state.session = snapshot; },
      onError: (error) => { throw error; },
    });
    assert.equal(reads, 1);
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 72).map(row => row.row_id));
    assert.ok(h.state.session.transcript.every(row => row.status === "completed"));
    assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
  });
}

for (const [pageSize, streamDuringBridge] of [[20, false], [6, false], [20, true]]) {
  test(`take-over repairs a streamed background interval across ${pageSize === 20 ? "three" : "more than three"} pages${streamDuringBridge ? " while newer snapshots arrive" : ""}`, async () => {
    const h = createTakeOverHarness();
    h.state.viewOnlyThread = buildViewOnlyPin({
      threadId: h.target, relayGeneration: h.generation, historyExtended: true,
      page: { entries: numberedRows(20, 52), prev_cursor: "before-20", revision: 10 },
    });
    const fresh = numberedRows(52, 100).map((row, index) => index % 2
      ? { ...row, kind: "tool_call", tool: { name: "Bash", command: "test command" } }
      : row);
    for (const row of fresh.filter(row => row.kind === "agent_text")) {
      h.stream.applyLocalTranscriptEntryDelta({
        thread_id: h.target, transcript_generation: h.generation,
        item_id: row.item_id, row_id: row.row_id, order_seq: row.order_seq,
        turn_id: "turn-1", delta_kind: "agent_text", text_offset: 0, delta: row.text,
      });
    }
    Object.assign(h.snapshot, {
      active_turn_id: "turn-1", current_status: "active",
      transcript_revision: 12, transcript: fresh.slice(-8),
    });
    await h.pairing.takeOverControl();
    const reads = [];
    let partialPaints = 0;
    await hydrateLocalTranscript(h.state, h.state.session, {
      fetchPage: async ({ before }) => {
        reads.push(before);
        if (streamDuringBridge && reads.length === 2) {
          h.stream.applyLocalTranscriptEntryDelta({
            thread_id: h.target, transcript_generation: h.generation,
            item_id: "row-100", row_id: "row-100", order_seq: 100 * 1048576,
            turn_id: "turn-1", delta_kind: "agent_text", text_offset: 0,
            delta: "streamed during the bridge",
          });
          h.lifecycle.applySessionSnapshot({
            ...h.snapshot, transcript_revision: 13,
            transcript: [...fresh.slice(-7), { ...numberedRows(100, 101)[0], status: "running", content_state: "preview", text: "streamed" }],
          });
          void hydrateLocalTranscript(h.state, h.state.session, {
            fetchPage: () => { throw new Error("a newer snapshot must reuse the bridge request"); },
            onError: (error) => { throw error; },
          });
        }
        const end = before == null ? 100 : Number(before.slice("before-".length));
        const start = Math.max(20, end - pageSize);
        return {
          thread_id: h.target, transcript_generation: h.generation, revision: 12,
          entries: numberedRows(start, end).map(row => fresh.find(candidate => candidate.row_id === row.row_id) || row),
          prev_cursor: `before-${start}`,
        };
      },
      onProgress: (snapshot) => {
        h.state.session = snapshot;
        if (reads.length > 1 && h.state.transcriptHydrationNeedsTailRepair) {
          partialPaints++;
          assert.equal(h.state.transcriptHydrationStatus, "loading");
          void hydrateLocalTranscript(h.state, snapshot, {
            fetchPage: () => { throw new Error("a progress paint must reuse the bridge request"); },
            onError: (error) => { throw error; },
          });
        }
      },
      onError: (error) => { throw error; },
    });
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, streamDuringBridge ? 101 : 100).map(row => row.row_id));
    assert.ok(h.state.session.transcript.filter(row => row.row_id !== "row-100").every(row => row.status === "completed"));
    if (streamDuringBridge) assert.equal(h.state.session.transcript.at(-1).text, "streamed during the bridge");
    const expectedReads = [null];
    for (let end = 100 - pageSize; end > 51; end -= pageSize) expectedReads.push(`before-${end}`);
    assert.deepEqual(reads, expectedReads);
    assert.equal(h.state.transcriptHydrationNeedsTailRepair, false);
    assert.equal(h.state.transcriptHydrationBridgeTarget, null);
    if (pageSize === 6) assert.ok(partialPaints > 1, "a longer repair must publish progress while reading history");
  });
}

test("take-over stops bridging when the reader leaves and finishes on return", async () => {
  const h = createTakeOverHarness();
  h.snapshot.transcript = numberedRows(92, 100);
  await h.pairing.takeOverControl();
  const reads = [];
  const options = {
    fetchPage: async ({ before }) => {
      reads.push(before);
      const end = before == null ? 100 : Number(before.slice("before-".length));
      const start = end - 10;
      if (reads.length === 2) h.state.viewThreadId = "another-tab";
      return {
        thread_id: h.target, transcript_generation: h.generation, revision: 11,
        entries: numberedRows(start, end), prev_cursor: `before-${start}`,
      };
    },
    onProgress: (snapshot) => { h.state.session = snapshot; },
    onError: (error) => { throw error; },
  };
  await hydrateLocalTranscript(h.state, h.state.session, options);
  assert.deepEqual(reads, [null, "before-90"]);
  assert.equal(h.state.transcriptHydrationNeedsTailRepair, true);
  assert.deepEqual(h.state.transcriptHydrationBridgeTarget, { orderSeq: 59 * 1048576, olderCursor: "before-20" });
  h.state.viewThreadId = h.target;
  await hydrateLocalTranscript(h.state, h.state.session, options);
  assert.deepEqual(reads.slice(2), [null, "before-90", "before-80", "before-70", "before-60"]);
  assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 100).map(row => row.row_id));
  assert.equal(h.state.transcriptHydrationNeedsTailRepair, false);
});

test("a bridge from before an active A-B-A switch cannot settle the returning window's repair", async () => {
  const h = createTakeOverHarness();
  Object.assign(h.snapshot, { active_turn_id: "turn-1", current_status: "active", transcript: numberedRows(92, 100) });
  await h.pairing.takeOverControl();
  let releaseOlder;
  let olderStarted;
  const pendingOlder = new Promise(resolve => { olderStarted = resolve; });
  const page = (start, end) => ({
    thread_id: h.target, transcript_generation: h.generation, revision: 11,
    entries: numberedRows(start, end), prev_cursor: `before-${start}`,
  });
  const oldHydration = hydrateLocalTranscript(h.state, h.state.session, {
    fetchPage: ({ before }) => {
      if (before == null) return page(80, 100);
      assert.equal(before, "before-80", "the retired request must not continue paging after the switch");
      olderStarted();
      return new Promise(resolve => { releaseOlder = resolve; });
    },
    onProgress: (snapshot) => { h.state.session = snapshot; },
    onError: (error) => { throw error; },
  });
  await pendingOlder;
  h.state.viewThreadId = "another-thread";
  h.lifecycle.applySessionSnapshot(baseSnapshot({ active_thread_id: "another-thread", transcript_generation: h.generation }));
  h.state.viewThreadId = h.target;
  h.lifecycle.applySessionSnapshot(h.snapshot);
  assert.deepEqual(h.state.transcriptHydrationBridgeTarget, { orderSeq: 59 * 1048576, olderCursor: "before-20" });
  let releaseTail;
  const newHydration = hydrateLocalTranscript(h.state, h.state.session, {
    fetchPage: ({ before }) => {
      if (before == null) return new Promise(resolve => { releaseTail = resolve; });
      const end = Number(before.slice("before-".length));
      return page(end - 20, end);
    },
    onProgress: (snapshot) => { h.state.session = snapshot; },
    onError: (error) => { throw error; },
  });
  const newOwner = h.state.transcriptHydrationPromise;
  releaseOlder(page(60, 80));
  await oldHydration;
  assert.equal(h.state.transcriptHydrationPromise, newOwner);
  assert.equal(h.state.transcriptHydrationStatus, "loading");
  assert.equal(h.state.transcriptHydrationNeedsTailRepair, true);
  releaseTail(page(80, 100));
  await newHydration;
  assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(20, 100).map(row => row.row_id));
  assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
  assert.equal(h.state.transcriptHydrationNeedsTailRepair, false);
});

for (const savedCursor of [null, "before-0"]) {
  test(`take-over keeps a gap reachable when a disconnected retained window has cursor ${savedCursor}`, async () => {
    const h = createTakeOverHarness();
    h.state.transcriptHydrationThreadCache = new Map([[h.target, {
      entries: new Map(numberedRows(0, 10).map(row => [row.row_id, row])),
      order: numberedRows(0, 10).map(row => row.row_id),
      olderCursor: savedCursor,
      generation: h.generation,
      tailReady: true,
      keyed: true,
    }]]);
    await h.pairing.takeOverControl();
    assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
    const reads = [];
    const options = {
      fetchPage: async ({ before }) => {
        reads.push(before);
        const [start, end] = before === "before-20" ? [10, 20] : before === "before-10" ? [0, 10] : [52, 60];
        return {
          thread_id: h.target, transcript_generation: h.generation,
          revision: 11, entries: numberedRows(start, end), prev_cursor: start ? `before-${start}` : null,
        };
      },
      onProgress: (snapshot) => { h.state.session = snapshot; },
      onError: (error) => { throw error; },
    };
    await hydrateLocalTranscript(h.state, h.state.session, options);
    assert.deepEqual(reads, [null]);
    assert.equal(h.state.transcriptHydrationOlderCursor, "before-20");
    await loadOlderLocalTranscript(h.state, options);
    assert.deepEqual(h.state.session.transcript.map(row => row.row_id), numberedRows(0, 60).map(row => row.row_id));
    await loadOlderLocalTranscript(h.state, options);
    assert.deepEqual(reads, [null, "before-20", "before-10"]);
    assert.equal(h.state.transcriptHydrationOlderCursor, null);
  });
}
