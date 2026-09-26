import test from "node:test";
import assert from "node:assert/strict";

import { hydrateLocalTranscript as hydrateWithSnapshot } from "./hydration.js";
import {
  mergeTranscriptHydrationPage,
  restoreHydratedTranscript,
  switchTranscriptHydrationThread,
} from "./store.js";

function createState() {
  return {
    session: { active_thread_id: "thread-1" },
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOrder: [],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: false,
    transcriptHydrationThreadId: null,
  };
}

const row = (id, seq, extra = {}) => ({
  item_id: id,
  row_id: id,
  order_seq: seq,
  kind: "agent_text",
  text: `${id} body`,
  status: "completed",
  turn_id: "turn-1",
  tool: null,
  content_state: "full",
  ...extra,
});
const shell = (id, seq, extra = {}) => row(id, seq, { text: null, content_state: "omitted", ...extra });

function snapshot(revision, transcript, extra = {}) {
  return {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
    transcript_truncated: true,
    transcript_revision: revision,
    transcript_generation: "gen-1",
    transcript,
    ...extra,
  };
}

// Establish a loaded window holding only `a0`, the way a first visit does.
async function loadedWindow(state) {
  await hydrateLocalTranscript(state, snapshot(1, [row("a0", 100)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: null, entries: [row("a0", 100)] }),
    fetchRows: async () => {
      throw new Error("nothing to recover yet");
    },
  });
}

async function settle(state, rounds = 20) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!state.transcriptRowRecoveryInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!state.transcriptRowRecoveryInFlight) return;
    }
  }
}

const displayed = (state, id) => state.transcriptHydrationEntries.get(id);

// The page checks each answer against the session it is rendering, so keep it current.
function hydrateLocalTranscript(state, nextSnapshot, options) {
  state.session = nextSnapshot;
  return hydrateWithSnapshot(state, nextSnapshot, options);
}

// The bug: long command output left one row per page, so a shelled row that was
// not the newest when the tail page was fetched was never fetched at all, and
// showed "•••" until a reload.
test("a shelled row that never lands on a fetched tail page still gets its body", async () => {
  const state = createState();
  await loadedWindow(state);
  const rowRequests = [];

  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("u1", 200, { kind: "user_text" }), shell("c1", 300, { kind: "command" })]), {
    // The newest row alone fills the latest page.
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [row("c1", 300, { kind: "command" })] }),
    fetchRows: async ({ threadId, rowIds }) => {
      rowRequests.push([threadId, [...rowIds]]);
      return {
        thread_id: "thread-1",
        transcript_generation: "gen-1",
        entries: rowIds.map((id) => row(id, id === "u1" ? 200 : 300, { kind: id === "u1" ? "user_text" : "command" })),
      };
    },
  });
  await settle(state);

  assert.equal(displayed(state, "u1")?.content_state, "full");
  assert.equal(displayed(state, "u1")?.text, "u1 body");
  assert.ok(rowRequests.length >= 1, "the row was recovered by id");
  assert.ok(rowRequests.every(([threadId]) => threadId === "thread-1"));
});

test("shells are recovered together, one request at a time", async () => {
  const state = createState();
  await loadedWindow(state);
  const calls = [];
  let release;
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) => {
      calls.push([...rowIds]);
      return new Promise((resolve) => {
        release = () => resolve({ thread_id: "thread-1", transcript_generation: "gen-1", entries: rowIds.map((id, index) => row(id, 200 + index)) });
      });
    },
  };

  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("s1", 200), shell("s2", 201), shell("s3", 202)]), options);
  await hydrateLocalTranscript(state, snapshot(3, [row("a0", 100), shell("s1", 200), shell("s2", 201), shell("s3", 202), shell("s4", 203)]), options);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, "a second snapshot must not start a parallel request");
  assert.deepEqual(calls[0], ["s1", "s2", "s3"]);
  release();
  await settle(state);
  assert.deepEqual(calls[1], ["s4"], "rows queued meanwhile go in the next request");
  release();
  await settle(state);
  for (const id of ["s1", "s2", "s3", "s4"]) {
    assert.equal(displayed(state, id)?.content_state, "full", id);
  }
});

test("a finished row whose cached body predates its finish is recovered, preview or not", async () => {
  const state = createState();
  await loadedWindow(state);
  const options = (fetchRows) => ({
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows,
  });
  // Mid-turn the row was recovered while still running.
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("m1", 200, { status: "in_progress" })]), options(async () => ({
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    entries: [row("m1", 200, { status: "in_progress", text: "partial" })],
  })));
  await settle(state);
  assert.equal(displayed(state, "m1")?.text, "partial");

  // It finished; the snapshot can only say so with a clipped preview.
  const requested = [];
  await hydrateLocalTranscript(state, snapshot(3, [row("a0", 100), row("m1", 200, { text: "partial and…", content_state: "preview" })]), options(async ({ rowIds }) => {
    requested.push(...rowIds);
    return { thread_id: "thread-1", transcript_generation: "gen-1", entries: [row("m1", 200, { text: "partial and the whole final answer" })] };
  }));
  await settle(state);

  assert.deepEqual(requested, ["m1"]);
  assert.equal(displayed(state, "m1")?.text, "partial and the whole final answer");
  assert.equal(displayed(state, "m1")?.content_state, "full");
});

test("a row the relay no longer holds leaves the queue instead of retrying forever", async () => {
  const state = createState();
  await loadedWindow(state);
  let calls = 0;
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("gone", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async () => {
      calls += 1;
      return { thread_id: "thread-1", transcript_generation: "gen-1", entries: [], missing_rows: ["gone"] };
    },
  });
  await settle(state);
  assert.equal(calls, 1);
  assert.equal(state.transcriptUnresolvedRows.size, 0);
});

test("a failed recovery retries after a backoff, without a new snapshot", async () => {
  const state = createState();
  await loadedWindow(state);
  const timers = [];
  let clock = 1_000;
  let attempts = 0;
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async ({ rowIds }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay busy");
      return { thread_id: "thread-1", transcript_generation: "gen-1", entries: rowIds.map((id) => row(id, 200)) };
    },
    now: () => clock,
    setTimer: (fn, delay) => {
      timers.push({ fn, at: clock + delay });
      return timers.length;
    },
    clearTimer: () => {},
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("r1", 200)]), options);
  await settle(state);
  assert.equal(attempts, 1);
  assert.equal(displayed(state, "r1")?.content_state, "omitted");
  assert.ok(timers.length >= 1, "a retry is scheduled");
  assert.ok(timers.at(-1).at > clock, "…in the future, not immediately");

  clock = timers.at(-1).at;
  timers.at(-1).fn();
  await settle(state);
  assert.equal(attempts, 2);
  assert.equal(displayed(state, "r1")?.content_state, "full");
});

test("an answer for a thread already left is dropped", async () => {
  const state = createState();
  await loadedWindow(state);
  let release;
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("x1", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) =>
      new Promise((resolve) => {
        release = () => resolve({ thread_id: "thread-1", transcript_generation: "gen-1", entries: rowIds.map((id) => row(id, 200)) });
      }),
  });
  switchTranscriptHydrationThread(state, "thread-2");
  release();
  await settle(state);

  assert.equal(state.transcriptHydrationThreadId, "thread-2");
  assert.equal(state.transcriptHydrationEntries.get("x1"), undefined, "nothing lands in the other thread's window");
});

test("owing rows never walks the window: only the snapshot tail is judged", async () => {
  // The streaming path must stay proportional to the tail; a per-snapshot window
  // scan is the freeze this code base already paid for once.
  class CountingMap extends Map {
    constructor(entries) {
      super(entries);
      this.walks = 0;
    }
    [Symbol.iterator]() {
      this.walks += 1;
      return super[Symbol.iterator]();
    }
    entries() {
      this.walks += 1;
      return super.entries();
    }
    values() {
      this.walks += 1;
      return super.values();
    }
    keys() {
      this.walks += 1;
      return super.keys();
    }
    forEach(...args) {
      this.walks += 1;
      return super.forEach(...args);
    }
  }
  const state = createState();
  await loadedWindow(state);
  const big = Array.from({ length: 5_000 }, (_, index) => row(`h${index}`, 1_000 + index));
  const window = new CountingMap(big.map((entry) => [entry.item_id, entry]));
  state.transcriptHydrationEntries = window;
  state.transcriptHydrationOrder = big.map((entry) => entry.item_id);
  state.transcriptHydrationKeyed = true;
  let answered = 0;

  for (let revision = 2; revision < 12; revision += 1) {
    await hydrateLocalTranscript(state, snapshot(revision, [row("h4999", 5_999), shell(`s${revision}`, 10_000 + revision)]), {
      fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
      fetchRows: async ({ rowIds }) => {
        answered += rowIds.length;
        return { thread_id: "thread-1", transcript_generation: "gen-1", entries: rowIds.map((id, index) => row(id, 10_000 + index)) };
      },
    });
    await settle(state);
  }

  assert.equal(answered, 10, "every owed row was recovered");
  assert.equal(window.walks, 0, "no snapshot or recovery walked the window");
});

test("a relay restart empties the owed rows and drops an answer from before it", async () => {
  const state = createState();
  await loadedWindow(state);
  let release;
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("old1", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) =>
      new Promise((resolve) => {
        release = () => resolve({ thread_id: "thread-1", transcript_generation: "gen-1", entries: rowIds.map((id) => row(id, 200)) });
      }),
  });
  assert.equal(state.transcriptUnresolvedRows.has("old1"), true);

  // The relay restarted: same thread, new generation, ids renumbered.
  const restarted = snapshot(1, [row("n0", 100)], { transcript_generation: "gen-2" });
  await hydrateLocalTranscript(state, restarted, {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-2", prev_cursor: null, entries: [row("n0", 100)] }),
    fetchRows: async () => ({ thread_id: "thread-1", transcript_generation: "gen-2", entries: [] }),
  });
  release();
  await settle(state);

  assert.equal(state.transcriptUnresolvedRows.has("old1"), false);
  assert.equal(state.transcriptHydrationEntries.get("old1"), undefined, "the old run's answer never lands");
});

test("a withdrawn row leaves the queue", async () => {
  const state = createState();
  await loadedWindow(state);
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: () => new Promise(() => {}),
    setTimer: () => 0,
    clearTimer: () => {},
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("w1", 200)]), options);
  assert.equal(state.transcriptUnresolvedRows.has("w1"), true);

  await hydrateLocalTranscript(state, snapshot(3, [row("a0", 100), shell("w1", 200, { withdrawn: true })]), options);
  assert.equal(state.transcriptUnresolvedRows.has("w1"), false);
});

test("rows still owed when a thread is left are asked for again on return", async () => {
  const state = createState();
  await loadedWindow(state);
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("k1", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async () => {
      throw new Error("relay busy");
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  await settle(state);

  switchTranscriptHydrationThread(state, "thread-2");
  assert.equal(state.transcriptUnresolvedRows.size, 0, "the other thread starts with nothing owed");
  switchTranscriptHydrationThread(state, "thread-1");
  assert.equal(state.transcriptUnresolvedRows.has("k1"), true, "the returning window still owes its row");
});

test("a request that never answers is given up on, and the row is asked for again", async () => {
  const state = createState();
  await loadedWindow(state);
  const timers = [];
  let clock = 1_000;
  let attempts = 0;
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async ({ rowIds }) => {
      attempts += 1;
      if (attempts === 1) return new Promise(() => {});
      return { thread_id: "thread-1", transcript_generation: "gen-1", entries: rowIds.map((id) => row(id, 200)) };
    },
    now: () => clock,
    setTimer: (fn, delay) => {
      timers.push({ fn, at: clock + delay, fired: false });
      return timers.length;
    },
    clearTimer: (handle) => {
      if (timers[handle - 1]) timers[handle - 1].fired = true;
    },
  };
  const fireDue = async () => {
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (!timer.fired && timer.at <= clock) {
        timer.fired = true;
        timer.fn();
        await settle(state);
      }
    }
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("h1", 200)]), options);
  await settle(state);
  assert.equal(attempts, 1);

  clock += 60_000;
  await fireDue();
  clock += 60_000;
  await fireDue();

  assert.equal(attempts, 2, "the hung request was abandoned and the row re-requested");
  assert.equal(displayed(state, "h1")?.content_state, "full");
});

test("a request still out for a thread already left does not hold up the new one", async () => {
  const state = createState();
  await loadedWindow(state);
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("x1", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: () => new Promise(() => {}),
    setTimer: () => 0,
    clearTimer: () => {},
  });

  switchTranscriptHydrationThread(state, "thread-2");
  const threadTwo = (revision, transcript) =>
    snapshot(revision, transcript, { active_thread_id: "thread-2" });
  const requested = [];
  const options = {
    fetchPage: async () => ({ thread_id: "thread-2", transcript_generation: "gen-1", prev_cursor: null, entries: [row("b0", 100)] }),
    fetchRows: async ({ threadId, rowIds }) => {
      requested.push([threadId, ...rowIds]);
      return { thread_id: "thread-2", transcript_generation: "gen-1", entries: rowIds.map((id) => row(id, 200)) };
    },
  };
  await hydrateLocalTranscript(state, threadTwo(1, [row("b0", 100)]), options);
  await hydrateLocalTranscript(state, threadTwo(2, [row("b0", 100), shell("y1", 200)]), options);
  await settle(state);

  assert.deepEqual(requested, [["thread-2", "y1"]]);
  assert.equal(displayed(state, "y1")?.content_state, "full");
});

test("a row read while running stays owed across frames until a finished body is read", async () => {
  // The completion frame overwrites the held row's status; the next identical
  // frame must not mistake a pre-completion body for the final one.
  const state = createState();
  await loadedWindow(state);
  const failing = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async () => {
      throw new Error("relay busy");
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("p1", 200, { status: "in_progress" })]), {
    ...failing,
    fetchRows: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", revision: 2, entries: [row("p1", 200, { status: "in_progress", text: "partial" })] }),
  });
  await settle(state);
  assert.equal(displayed(state, "p1")?.text, "partial");

  const finished = snapshot(3, [row("a0", 100), shell("p1", 200)]);
  await hydrateLocalTranscript(state, finished, failing);
  await settle(state);
  await hydrateLocalTranscript(state, { ...finished }, failing);
  await settle(state);

  assert.equal(displayed(state, "p1")?.text, "partial", "precondition: still the pre-completion body");
  assert.equal(state.transcriptUnresolvedRows.has("p1"), true, "a body read before the row finished is still owed");
});

test("a late answer from before a newer read neither regresses the row nor settles it", async () => {
  const state = createState();
  await loadedWindow(state);
  const deferredAnswers = [];
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) => new Promise((resolve) => deferredAnswers.push({ rowIds, resolve })),
    setTimer: () => 0,
    clearTimer: () => {},
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("q1", 200, { status: "in_progress" })]), options);
  await settle(state);
  assert.equal(deferredAnswers.length, 1);

  // A newer, finished body lands first (here from a tail page read at revision 3).
  state.transcriptHydrationEntries.set("q1", row("q1", 200, { text: "final" }));
  state.transcriptRowBodyRevisions.set("q1", { revision: 3, at: 0, terminal: true });
  state.transcriptUnresolvedRows.delete("q1");

  // Then the answer to the revision-2 request arrives.
  deferredAnswers[0].resolve({
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    revision: 2,
    entries: [row("q1", 200, { status: "in_progress", text: "an older but longer running body" })],
  });
  await settle(state);

  assert.equal(displayed(state, "q1")?.status, "completed", "an older answer must not reopen a finished row");
  assert.equal(displayed(state, "q1")?.text, "final", "…nor replace its newer body");
});

test("an answer that predates a row's completion does not settle it", async () => {
  const state = createState();
  await loadedWindow(state);
  const deferredAnswers = [];
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) => new Promise((resolve) => deferredAnswers.push({ rowIds, resolve })),
    setTimer: () => 0,
    clearTimer: () => {},
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("r2", 200, { status: "in_progress" })]), options);
  await settle(state);
  // The snapshot says it finished while the running-era request is still out.
  await hydrateLocalTranscript(state, snapshot(3, [row("a0", 100), shell("r2", 200)]), options);
  deferredAnswers[0].resolve({
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    revision: 2,
    entries: [row("r2", 200, { status: "in_progress", text: "running body" })],
  });
  await settle(state);

  assert.equal(displayed(state, "r2")?.status, "completed", "the finished status stands");
  assert.equal(state.transcriptUnresolvedRows.has("r2"), true, "and the final body is still owed");
});

test("giving up on a request cancels it, so it stops holding a connection", async () => {
  const state = createState();
  await loadedWindow(state);
  const timers = [];
  let clock = 1_000;
  const signals = [];
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("c9", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    },
    now: () => clock,
    setTimer: (fn, delay) => {
      timers.push({ fn, at: clock + delay });
      return timers.length;
    },
    clearTimer: () => {},
  });
  await settle(state);
  assert.equal(signals.length, 1);
  assert.ok(signals[0], "the request is given a signal it can be cancelled by");

  clock += 60_000;
  timers.find((timer) => timer.at <= clock)?.fn();
  await settle(state);

  assert.equal(signals[0].aborted, true, "the abandoned request is cancelled, not left running");
});

test("the owed set is bounded while the relay keeps failing", async () => {
  const state = createState();
  await loadedWindow(state);
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async () => {
      throw new Error("relay down");
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  for (let revision = 2; revision < 400; revision += 1) {
    await hydrateLocalTranscript(state, snapshot(revision, [row("a0", 100), shell(`z${revision}`, 1_000 + revision)]), options);
  }
  await settle(state);

  assert.ok(state.transcriptUnresolvedRows.size <= 128, `owed rows: ${state.transcriptUnresolvedRows.size}`);
  assert.equal(state.transcriptUnresolvedRows.has("z399"), true, "the newest rows are the ones kept");
});

test("a late tail page from before a row finished neither reopens it nor settles it", async () => {
  const state = createState();
  await loadedWindow(state);
  const pending = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: () => new Promise(() => {}),
    setTimer: () => 0,
    clearTimer: () => {},
  };
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("t1", 200, { status: "in_progress" })]), {
    ...pending,
    fetchRows: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", revision: 2, entries: [row("t1", 200, { status: "in_progress", text: "partial" })] }),
  });
  await settle(state);
  await hydrateLocalTranscript(state, snapshot(3, [row("a0", 100), shell("t1", 200)]), pending);
  assert.equal(state.transcriptUnresolvedRows.has("t1"), true, "precondition: the finished row is owed");

  // A latest-page read made at revision 2 lands only now.
  mergeTranscriptHydrationPage(state, {
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    revision: 2,
    prev_cursor: "older",
    entries: [row("t1", 200, { status: "in_progress", text: "partial" })],
  });

  assert.equal(displayed(state, "t1")?.status, "completed", "an older page must not reopen a finished row");
  assert.equal(state.transcriptUnresolvedRows.has("t1"), true, "…nor settle what it still owes");
});

test("a late answer from before a newer full snapshot does not roll back what that snapshot said", async () => {
  const state = createState();
  await loadedWindow(state);
  const answers = [];
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) => new Promise((resolve) => answers.push({ rowIds, resolve })),
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const edit = (applyState) => ({
    item_type: "fileChange",
    name: "Edit",
    title: "Edit",
    file_changes: [{ path: "a.rs", change_type: "update", diff: "@@\n-a\n+b\n" }],
    ...(applyState ? { apply_state: applyState } : {}),
  });
  // Rolled back at revision 2, when the row's recovery was requested.
  await hydrateLocalTranscript(state, snapshot(2, [row("a0", 100), shell("f1", 200, { kind: "tool_call", tool: edit("rolled_back") })]), options);
  await settle(state);
  assert.equal(answers.length, 1);

  // Re-applied; the snapshot says so in full before the revision-2 answer lands.
  await hydrateLocalTranscript(state, snapshot(3, [row("a0", 100), row("f1", 200, { kind: "tool_call", text: null, tool: edit("applied") })]), options);
  answers[0].resolve({
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    revision: 2,
    entries: [row("f1", 200, { kind: "tool_call", text: null, tool: edit("rolled_back") })],
  });
  await settle(state);

  assert.equal(displayed(state, "f1")?.tool?.apply_state, "applied", "the older answer must not undo a newer apply");
});

// The page renders a snapshot (restoreHydratedTranscript, which writes the tail
// into the window) BEFORE it hydrates; judge owed rows through that same order.
function deliver(state, nextSnapshot, options) {
  state.rawSessionSnapshot = nextSnapshot;
  const rendered = restoreHydratedTranscript(state, nextSnapshot);
  state.session = rendered;
  return hydrateWithSnapshot(state, rendered, options);
}

test("a body the stream grew is still owed when its row finishes, in the page's real render order", async () => {
  const state = createState();
  await loadedWindow(state);
  // Grown by deltas while running: a full body, but no read behind it.
  state.transcriptHydrationEntries.set("d1", row("d1", 200, { status: "in_progress", text: "partial from deltas" }));
  state.transcriptHydrationOrder.push("d1");
  const requested = [];

  await deliver(state, snapshot(3, [row("a0", 100), shell("d1", 200)]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: async ({ rowIds }) => {
      requested.push(...rowIds);
      return { thread_id: "thread-1", transcript_generation: "gen-1", revision: 3, entries: [row("d1", 200, { text: "the whole final text" })] };
    },
  });
  await settle(state);

  assert.deepEqual(requested, ["d1"], "the render must not hide that the held body predates the finish");
  assert.equal(displayed(state, "d1")?.text, "the whole final text");
});

test("frames that only repeat a shell while its recovery is out do not outdate the answer", async () => {
  // While a reply streams, every chunk bumps the revision. If a mere repeat of a
  // shell counted as news, every answer would arrive "stale" and never land.
  const state = createState();
  await loadedWindow(state);
  let release;
  let calls = 0;
  const options = {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
    fetchRows: ({ rowIds }) => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ thread_id: "thread-1", transcript_generation: "gen-1", revision: 2, entries: rowIds.map((id) => row(id, 200)) });
      });
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  await deliver(state, snapshot(2, [row("a0", 100), shell("v1", 200)]), options);
  for (const revision of [3, 4, 5, 6]) {
    await deliver(state, snapshot(revision, [row("a0", 100), shell("v1", 200)]), options);
  }
  release();
  await settle(state);

  assert.equal(calls, 1);
  assert.equal(displayed(state, "v1")?.content_state, "full");
});

test("a failed re-read of the tail page does not stall row recovery", async () => {
  const state = createState();
  await loadedWindow(state);
  // Shells were seen this turn, so the settle re-reads the tail — and it fails.
  await deliver(state, snapshot(2, [row("a0", 100), shell("g1", 200, { status: "in_progress" })]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
  });
  assert.equal(state.transcriptUnresolvedRows.has("g1"), true, "precondition: owed, not yet asked for");
  const requested = [];
  await deliver(state, snapshot(3, [row("a0", 100), shell("g1", 200)], { active_turn_id: null }), {
    fetchPage: async () => {
      throw new Error("tail read failed");
    },
    fetchRows: async ({ rowIds }) => {
      requested.push(...rowIds);
      return { thread_id: "thread-1", transcript_generation: "gen-1", revision: 3, entries: [row("g1", 200)] };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  await settle(state);

  assert.ok(requested.includes("g1"), "the owed row is still recovered");
  assert.equal(displayed(state, "g1")?.content_state, "full");
});

test("a stale row in a page still anchors the page's order in an unnumbered window", () => {
  const state = createState();
  // A window with no order numbers, holding only b, which we saw at revision 3.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationGeneration = "gen-1";
  state.session = snapshot(3, []);
  state.transcriptHydrationEntries = new Map([["b", { item_id: "b", row_id: "b", kind: "agent_text", text: "b final", status: "completed", content_state: "full" }]]);
  state.transcriptHydrationOrder = ["b"];
  state.transcriptHydrationKeyed = false;
  state.transcriptRowSeenRevisions = new Map([["b", 3]]);

  mergeTranscriptHydrationPage(state, {
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    revision: 2,
    prev_cursor: "older",
    entries: [row("a", 1), row("b", 2, { status: "in_progress", text: "b older" }), row("c", 3)],
  });

  assert.deepEqual(state.transcriptHydrationOrder, ["a", "b", "c"]);
  assert.equal(displayed(state, "b")?.text, "b final");
});

for (const shape of ["preview", "omitted"]) {
  test(`an apply state that changes on a ${shape} row outdates answers from before it`, async () => {
    const state = createState();
    await loadedWindow(state);
    const answers = [];
    const options = {
      fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
      fetchRows: ({ rowIds }) => new Promise((resolve) => answers.push({ rowIds, resolve })),
      setTimer: () => 0,
      clearTimer: () => {},
    };
    const tool = (applyState) => ({
      item_type: "fileChange",
      name: "Edit",
      title: "Edit",
      detail: "a long detail",
      file_changes: [{ path: "a.rs", change_type: "update", diff: "" }],
      apply_state: applyState,
    });
    const clipped = (applyState) =>
      shape === "preview"
        ? row("f2", 200, { kind: "tool_call", text: "clipped", content_state: "preview", tool: tool(applyState) })
        : shell("f2", 200, { kind: "tool_call", tool: tool(applyState) });
    await deliver(state, snapshot(2, [row("a0", 100), clipped("rolled_back")]), options);
    await settle(state);
    assert.equal(answers.length, 1);

    // Re-applied at revision 3; the snapshot still clips the row but says so.
    await deliver(state, snapshot(3, [row("a0", 100), clipped("applied")]), options);
    answers[0].resolve({
      thread_id: "thread-1",
      transcript_generation: "gen-1",
      revision: 2,
      entries: [row("f2", 200, { kind: "tool_call", text: "full", tool: tool("rolled_back") })],
    });
    await settle(state);

    assert.equal(displayed(state, "f2")?.tool?.apply_state, "applied");
  });
}

test("what a thread knew about its rows survives switching away and back", async () => {
  const state = createState();
  await loadedWindow(state);
  // A running row read by id at revision 3, long enough ago to be re-read; and a
  // finished, applied row we last learned about at revision 4.
  state.transcriptHydrationEntries.set("c1", row("c1", 200, { status: "in_progress", text: "partial" }));
  state.transcriptHydrationEntries.set("f3", row("f3", 300, { status: "completed", text: "final" }));
  state.transcriptHydrationOrder.push("c1", "f3");
  state.transcriptRowBodyRevisions = new Map([["c1", { revision: 3, at: 0, terminal: false }]]);
  state.transcriptRowSeenRevisions = new Map([["c1", 3], ["f3", 4]]);

  switchTranscriptHydrationThread(state, "thread-2");
  switchTranscriptHydrationThread(state, "thread-1");

  // An answer read at revision 3 lands after the return: it must still be refused.
  mergeTranscriptHydrationPage(state, {
    thread_id: "thread-1",
    transcript_generation: "gen-1",
    revision: 3,
    prev_cursor: "older",
    entries: [row("f3", 300, { status: "in_progress", text: "older" })],
  });
  assert.equal(displayed(state, "f3")?.status, "completed", "the restored window still refuses older copies");

  // And the running row, read at revision 3, is re-read once revision 4 moves it on.
  await deliver(state, snapshot(4, [row("a0", 100), shell("c1", 200, { status: "in_progress" })]), {
    fetchPage: async () => ({ thread_id: "thread-1", transcript_generation: "gen-1", prev_cursor: "older", entries: [] }),
  });
  assert.equal(state.transcriptUnresolvedRows.has("c1"), true, "the read record came back with the window");
});
