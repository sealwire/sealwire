// Reproduction harness for the "one running thread becomes un-enterable" bug:
// with two claude threads running and the user switching between them, one thread
// ends up showing the LOCAL CONSOLE-HOME dashboard in the center while the
// Reviewer panel on the right still scopes to a thread.
//
// app.js itself can't be imported under `node --test` (it grabs DOM elements at
// module load). So this harness imports the REAL decision functions from
// view-only-thread.js / review-state.js and mirrors ONLY the thin imperative glue
// in app.js / render-session.js, citing the exact lines each piece reproduces.
// If the glue here diverges from app.js, that is itself the thing to fix.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildViewOnlyPin,
  projectViewOnlySession,
  viewOnlyEligible,
  viewOnlyPinNextAction,
} from "./view-only-thread.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";

// --- state slice (app.js:201/205/211/623) ---------------------------------
function makeState() {
  return {
    viewThreadId: null, // app.js:201 — derived from the URL ?thread param
    viewOnlyThread: null, // app.js:205
    viewOnlyGeneration: 0, // app.js:623
    viewOnlyLoadAttemptThreadId: null, // app.js:211 — set once, NEVER reset
    session: null, // the REAL live snapshot
    threads: [],
  };
}

function snap(activeThreadId, transcript = [], extra = {}) {
  return {
    active_thread_id: activeThreadId,
    active_turn_id: `turn-${activeThreadId}`,
    transcript,
    transcript_truncated: false,
    current_status: "active",
    active_review_jobs: [],
    thread_activity: [],
    pending_approvals: [],
    pending_ask_user_questions: [],
    ...extra,
  };
}

const okFetch = (threadId) =>
  Promise.resolve({
    thread_id: threadId,
    entries: [{ item_id: `${threadId}-tail` }],
    prev_cursor: null,
  });

// --- isViewingConversation (app.js:2243-2245) -----------------------------
function isViewingConversation(state, session) {
  return Boolean(
    session?.active_thread_id && state.viewThreadId === session.active_thread_id
  );
}

// --- Reviewer panel thread scope (render-session.js:843) -------------------
// Note the `|| active_thread_id` FALLBACK — the center panel has no equivalent.
function reviewerScopeThreadId(state, session) {
  return state.viewThreadId || session?.active_thread_id || null;
}

// --- Center panel decision: renderTranscript branch order
// (render-session.js:1021-1102) applied to the PROJECTED session
// (render-session.js:251 projects before rendering). -----------------------
function centerDecision(state) {
  const session = projectViewOnlySession(state.session, {
    viewThreadId: state.viewThreadId,
    viewOnlyThread: state.viewOnlyThread,
  });
  if (!session) return { kind: "no-session" };
  const viewingConversation = isViewingConversation(state, session);
  if (!viewingConversation) {
    if (isReviewInProgressForThread(session, state.viewThreadId)) {
      return { kind: "review", threadId: state.viewThreadId }; // :1041-1051
    }
    if (state.viewThreadId && state.viewThreadId !== session.active_thread_id) {
      return { kind: "loading", threadId: state.viewThreadId }; // :1053-1074
    }
    return { kind: "console-home" }; // :1076-1095 — the local dashboard
  }
  const entries = session.transcript || [];
  if (!entries.length && session.view_only) {
    return { kind: "thread", threadId: session.active_thread_id, viewOnly: true, empty: true }; // :1102
  }
  return {
    kind: "thread",
    threadId: session.active_thread_id,
    viewOnly: Boolean(session.view_only),
    empty: entries.length === 0,
  };
}

// --- loadViewOnlyTranscript (app.js:612-719) ------------------------------
async function loadViewOnlyTranscript(state, threadId, fetchPage) {
  const session = state.session;
  if (!viewOnlyEligible(session, threadId)) {
    // app.js:614-620
    if (state.viewOnlyThread) state.viewOnlyThread = null;
    return;
  }
  const generation = (state.viewOnlyGeneration = (state.viewOnlyGeneration || 0) + 1); // :623
  const prior = state.viewOnlyThread?.threadId === threadId ? state.viewOnlyThread : null; // :630
  state.viewOnlyThread = buildViewOnlyPin({
    threadId,
    generation,
    loading: true,
    priorEntries: prior?.entries || [],
    priorOlderCursor: prior?.olderCursor ?? null,
  }); // :635-656
  try {
    const page = await fetchPage(threadId); // :660
    if (generation !== state.viewOnlyGeneration) return; // :661
    const normalized =
      page && Array.isArray(page.entries)
        ? page
        : { thread_id: threadId, entries: [], prev_cursor: null };
    state.viewOnlyThread = buildViewOnlyPin({ threadId, page: normalized, generation }); // :666-692
  } catch {
    if (generation !== state.viewOnlyGeneration) return; // :694
    state.viewOnlyThread = buildViewOnlyPin({
      threadId,
      generation,
      priorEntries: prior?.entries || [],
      priorOlderCursor: prior?.olderCursor ?? null,
    }); // :695-715 — failure leaves an EMPTY pin
  }
}

// --- maybeRefreshViewOnly (app.js:768-820) --------------------------------
// Returns the threadIds the real code would `void loadViewOnlyTranscript(...)`.
function maybeRefreshViewOnly(state, session) {
  const loads = [];
  const pin = state.viewOnlyThread;
  if (pin && session) {
    const action = viewOnlyPinNextAction(session, pin, { viewThreadId: state.viewThreadId });
    if (action.kind === "release") {
      state.viewOnlyThread = null; // :776
    } else if (action.kind === "refresh") {
      loads.push(pin.threadId); // :778
    }
  }
  const viewId = state.viewThreadId;
  if (
    viewId &&
    session &&
    viewOnlyEligible(session, viewId) &&
    state.viewOnlyThread?.threadId !== viewId &&
    state.viewOnlyLoadAttemptThreadId !== viewId // :816 — one-shot guard
  ) {
    state.viewOnlyLoadAttemptThreadId = viewId; // :818 — never reset
    loads.push(viewId); // :819
  }
  return loads;
}

// --- wrappedRenderSession (app.js:560-594) --------------------------------
async function applySnapshot(state, session, fetchPage) {
  const previousLiveSession = state.session;
  const viewedThreadWasLive = Boolean(
    state.viewThreadId &&
      previousLiveSession?.active_thread_id === state.viewThreadId &&
      session?.active_thread_id !== state.viewThreadId &&
      !state.viewOnlyThread
  ); // :562-567
  if (viewedThreadWasLive) {
    state.viewOnlyThread = buildViewOnlyPin({
      threadId: state.viewThreadId,
      priorEntries: previousLiveSession.transcript || [],
      status: previousLiveSession.current_status || "idle",
      wasWorking: Boolean(previousLiveSession.active_turn_id),
    }); // :571-579
  }
  state.session = session; // :587
  const loads = maybeRefreshViewOnly(state, session); // :588
  for (const id of loads) await loadViewOnlyTranscript(state, id, fetchPage);
  if (viewedThreadWasLive) {
    await loadViewOnlyTranscript(state, state.viewThreadId, fetchPage); // :592
  }
}

// --- click a thread (app.js:1218-1232 / viewThread 540-552) ---------------
async function clickThread(state, threadId, fetchPage) {
  state.viewThreadId = threadId; // setThreadRoute → pushState ?thread + state.viewThreadId (app.js:2236)
  await loadViewOnlyTranscript(state, threadId, fetchPage); // :1229
}

// --- popstate (app.js:1055-1061): back/forward re-reads viewThreadId from URL
function popstate(state, urlThreadId) {
  state.viewThreadId = urlThreadId ?? null; // :1056 readThreadIdFromUrl()
}

// ===========================================================================

test("CHARACTERIZATION: the reviewer panel falls back to the active thread, the center panel does not", () => {
  // viewThreadId is null but a thread (B) is live. This asymmetry is why a lost
  // route shows the dashboard in the center yet keeps the Reviewer panel populated.
  const state = makeState();
  state.viewThreadId = null;
  state.session = snap("B", [{ item_id: "b1" }]);

  assert.equal(reviewerScopeThreadId(state, state.session), "B", "reviewer falls back to active");
  assert.deepEqual(centerDecision(state), { kind: "console-home" }, "center has no fallback");
});

test("REPRO: rapid switch + a back-navigation leaves the Reviewer showing a thread while the center shows the console-home dashboard", async () => {
  const state = makeState();
  state.threads = [
    { id: "A", provider: "claude_code" },
    { id: "B", provider: "claude_code" },
  ];

  // Viewing A live.
  state.viewThreadId = "A";
  state.session = snap("A", [{ item_id: "a1" }]);
  await applySnapshot(state, state.session, okFetch);
  assert.equal(centerDecision(state).threadId, "A");

  // B takes a turn (relay's single active thread flips to B) and the user clicks B.
  await applySnapshot(state, snap("B", [{ item_id: "b1" }]), okFetch);
  await clickThread(state, "B", okFetch);
  assert.equal(centerDecision(state).threadId, "B");

  // Each thread click pushState()s (app.js:1223, non-replace), so a stray
  // back-gesture during rapid switching pops to the bare (no ?thread) entry.
  popstate(state, null);
  await applySnapshot(state, snap("B", [{ item_id: "b1" }]), okFetch);

  const center = centerDecision(state);
  const reviewerThread = reviewerScopeThreadId(state, state.session);

  assert.equal(reviewerThread, "B", "reviewer still scopes to a thread (active fallback)");
  // DESIRED: the center must not collapse to the dashboard while the reviewer
  // still shows a thread. Today it does — exactly the reported symptom.
  assert.notEqual(
    center.kind,
    "console-home",
    "center must not show the local dashboard while the reviewer shows a thread"
  );
});

test("REPRO: with the relay unreachable (net::ERR_CONNECTION_REFUSED), selecting the other running thread leaves an empty, un-enterable center", async () => {
  const state = makeState();
  state.threads = [
    { id: "A", provider: "claude_code" },
    { id: "B", provider: "claude_code" },
  ];

  // active = B, viewing B live.
  state.viewThreadId = "B";
  state.session = snap("B", [{ item_id: "b1" }]);
  await applySnapshot(state, state.session, okFetch);

  // Backend goes down (the console's ERR_CONNECTION_REFUSED on the transcript
  // endpoint). User clicks A trying to get into it.
  const downFetch = () => Promise.reject(new Error("ERR_CONNECTION_REFUSED"));
  await clickThread(state, "A", downFetch);

  const center = centerDecision(state);
  assert.equal(center.threadId, "A", "the center is scoped to A...");
  // DESIRED: A is actually shown. Today A is an empty read-only shell the user
  // cannot enter — i.e. "点不进去".
  assert.equal(center.empty, false, "A must not be left as an empty, un-enterable shell");
});
