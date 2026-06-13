import test from "node:test";
import assert from "node:assert/strict";

import {
  buildViewOnlyPin,
  mergeOlderViewOnlyPage,
  projectViewOnlySession,
  viewOnlyEligible,
  viewOnlyPinNextAction,
} from "./view-only-thread.js";

const REVIEW_RUNNING = [{ parent_thread_id: "A", status: "waiting_for_reviewer" }];
const REVIEW_DONE = [{ parent_thread_id: "A", status: "complete" }];

function realSession(overrides = {}) {
  return {
    active_thread_id: "LIVE",
    active_turn_id: "turn-9",
    active_controller_device_id: "device-1",
    pending_approvals: [{ request_id: "appr-1" }],
    pending_ask_user_questions: [{ request_id: "ask-1" }],
    transcript: [{ item_id: "live-entry" }],
    transcript_truncated: false,
    current_status: "active",
    current_cwd: "/live/workspace",
    model: "live-model",
    provider: "live-provider",
    reasoning_effort: "high",
    approval_policy: "on-request",
    sandbox: "workspace-write",
    active_review_jobs: [],
    ...overrides,
  };
}

function pinFor(threadId, overrides = {}) {
  return {
    threadId,
    entries: [{ item_id: `${threadId}-tail` }],
    olderCursor: 7,
    generation: 1,
    review: false,
    reviewSig: null,
    cwd: "/saved/workspace",
    provider: "saved-provider",
    loading: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// projectViewOnlySession — the heart of bug #2's fix
// ---------------------------------------------------------------------------

test("REGRESSION #2: a non-active, NON-review thread projects read-only with pagination enabled", () => {
  // Today this is impossible: the projection refuses any thread that is not
  // review-locked, so viewing a saved thread shows an empty state and history
  // can never paginate.
  const real = realSession();
  const pin = pinFor("A", { olderCursor: 7 });

  const projected = projectViewOnlySession(real, { viewThreadId: "A", viewOnlyThread: pin });

  assert.notEqual(projected, real, "must project, not return the real session");
  assert.equal(projected.active_thread_id, "A");
  assert.deepEqual(projected.transcript, pin.entries);
  assert.equal(projected.view_only, true);
  assert.equal(projected.current_status, "idle");
  assert.equal(projected.active_controller_device_id, "__view_only__");
  assert.equal(projected.active_turn_id, null);
  assert.deepEqual(projected.pending_approvals, []);
  assert.deepEqual(projected.pending_ask_user_questions, []);
  assert.equal(
    projected.transcript_truncated,
    true,
    "older cursor present → truncated → scroll-up pagination must arm"
  );
});

test("projection uses the VIEWED thread's metadata and never impersonates the live session", () => {
  const real = realSession();
  const projected = projectViewOnlySession(real, {
    viewThreadId: "A",
    viewOnlyThread: pinFor("A", {
      cwd: "/saved/workspace",
      provider: "saved-provider",
      settings: {
        approval_policy: "never",
        sandbox: "read-only",
        reasoning_effort: "low",
        model: "saved-model",
      },
      settingsWritable: true,
    }),
  });
  // Summary-backed fields use the saved thread's own values.
  assert.equal(projected.current_cwd, "/saved/workspace");
  assert.equal(projected.provider, "saved-provider");
  // Settings come from the targeted thread-state read, never the live thread.
  assert.equal(projected.model, "saved-model");
  assert.equal(projected.reasoning_effort, "low");
  assert.equal(projected.approval_policy, "never");
  assert.equal(projected.sandbox, "read-only");
  assert.equal(projected.settings_writable, true);
});

test("projection blanks cwd/provider when unknown — never falls back to live metadata", () => {
  const projected = projectViewOnlySession(realSession(), {
    viewThreadId: "A",
    viewOnlyThread: pinFor("A", { cwd: null, provider: null }),
  });
  assert.equal(projected.current_cwd, "", "blank, not the live cwd");
  assert.equal(projected.provider, "", "blank, not the live provider");
  assert.equal(projected.model, "");
});

test("projection reports complete history when the older cursor is exhausted", () => {
  const projected = projectViewOnlySession(realSession(), {
    viewThreadId: "A",
    viewOnlyThread: pinFor("A", { olderCursor: null }),
  });
  assert.equal(projected.transcript_truncated, false);
});

test("projection treats a stale working summary as idle when activity is absent", () => {
  const projected = projectViewOnlySession(realSession({ thread_activity: [] }), {
    viewThreadId: "A",
    viewOnlyThread: pinFor("A", { status: "active" }),
  });
  assert.equal(projected.current_status, "idle");
  assert.equal(projected.active_turn_id, null);
});

test("projection derives working state and pending prompts from the viewed thread", () => {
  const projected = projectViewOnlySession(
    realSession({
      thread_activity: [
        { thread_id: "A", phase: "tool", tool: "shell" },
        { thread_id: "B", phase: "thinking", tool: null },
      ],
      pending_approvals: [
        { request_id: "approval-a", thread_id: "A" },
        { request_id: "approval-b", thread_id: "B" },
      ],
      pending_ask_user_questions: [
        { request_id: "question-a", thread_id: "A" },
        { request_id: "question-b", thread_id: "B" },
      ],
    }),
    {
      viewThreadId: "A",
      viewOnlyThread: pinFor("A", { status: "idle" }),
    }
  );

  assert.equal(projected.current_status, "active");
  assert.equal(projected.current_phase, "tool");
  assert.equal(projected.current_tool, "shell");
  assert.equal(projected.active_turn_id, "view:A");
  assert.deepEqual(
    projected.pending_approvals.map((entry) => entry.request_id),
    ["approval-a"]
  );
  assert.deepEqual(
    projected.pending_ask_user_questions.map((entry) => entry.request_id),
    ["question-a"]
  );
});

test("projection is a no-op without a matching pin or when viewing the active thread", () => {
  const real = realSession();
  assert.equal(projectViewOnlySession(real, { viewThreadId: "A", viewOnlyThread: null }), real);
  assert.equal(
    projectViewOnlySession(real, { viewThreadId: "A", viewOnlyThread: pinFor("B") }),
    real
  );
  assert.equal(
    projectViewOnlySession(real, { viewThreadId: "LIVE", viewOnlyThread: pinFor("LIVE") }),
    real,
    "viewing the live thread must stay live, never read-only"
  );
  assert.equal(projectViewOnlySession(null, { viewThreadId: "A", viewOnlyThread: pinFor("A") }), null);
});

test("review-locked threads still project read-only (existing behavior preserved)", () => {
  const real = realSession({ active_review_jobs: REVIEW_RUNNING });
  const projected = projectViewOnlySession(real, {
    viewThreadId: "A",
    viewOnlyThread: pinFor("A", { review: true }),
  });
  assert.equal(projected.view_only, true);
  assert.equal(projected.active_thread_id, "A");
});

// ---------------------------------------------------------------------------
// mergeOlderViewOnlyPage — scroll-up pagination for the pinned view
// ---------------------------------------------------------------------------

test("merging an older page prepends entries and advances the cursor", () => {
  const pin = pinFor("A", {
    entries: [{ item_id: "e3" }, { item_id: "e4" }],
    olderCursor: 2,
  });
  const merged = mergeOlderViewOnlyPage(pin, {
    thread_id: "A",
    entries: [{ item_id: "e1" }, { item_id: "e2" }],
    prev_cursor: 0,
  });
  assert.deepEqual(
    merged.entries.map((entry) => entry.item_id),
    ["e1", "e2", "e3", "e4"]
  );
  assert.equal(merged.olderCursor, 0);
});

test("merging the final page clears the cursor so truncation turns off", () => {
  const merged = mergeOlderViewOnlyPage(pinFor("A", { olderCursor: 2 }), {
    thread_id: "A",
    entries: [{ item_id: "first" }],
    prev_cursor: null,
  });
  assert.equal(merged.olderCursor, null);
});

test("merge dedupes overlapping item_ids and ignores wrong-thread pages", () => {
  const pin = pinFor("A", { entries: [{ item_id: "e2" }], olderCursor: 1 });
  const merged = mergeOlderViewOnlyPage(pin, {
    thread_id: "A",
    entries: [{ item_id: "e1" }, { item_id: "e2" }],
    prev_cursor: null,
  });
  assert.deepEqual(
    merged.entries.map((entry) => entry.item_id),
    ["e1", "e2"],
    "overlap must not duplicate"
  );

  const wrongThread = mergeOlderViewOnlyPage(pin, {
    thread_id: "OTHER",
    entries: [{ item_id: "x" }],
    prev_cursor: null,
  });
  assert.equal(wrongThread, pin, "wrong-thread page must be ignored");
});

// ---------------------------------------------------------------------------
// viewOnlyPinNextAction — pin lifecycle; encodes the do-NOT-auto-resume rule
// ---------------------------------------------------------------------------

test("REGRESSION #1-guard: a general pin while still viewing stays pinned — never auto-resumes", () => {
  // The old review-only refresh logic auto-resumed whenever the review was not
  // in progress. Generalized naively, every saved-thread view would immediately
  // resume and steal the relay's active thread — exactly the coupling bug.
  const action = viewOnlyPinNextAction(realSession(), pinFor("A"), { viewThreadId: "A" });
  assert.deepEqual(action, { kind: "none" });
});

test("a general pin releases when its thread becomes active or the user navigates away", () => {
  assert.deepEqual(
    viewOnlyPinNextAction(realSession({ active_thread_id: "A" }), pinFor("A"), {
      viewThreadId: "A",
    }),
    { kind: "release" }
  );
  assert.deepEqual(
    viewOnlyPinNextAction(realSession(), pinFor("A"), { viewThreadId: "B" }),
    { kind: "release" }
  );
});

test("a review pin refreshes in place when the review ends and never resumes", () => {
  const session = realSession({ active_review_jobs: REVIEW_DONE });
  assert.deepEqual(
    viewOnlyPinNextAction(session, pinFor("A", { review: true }), { viewThreadId: "A" }),
    { kind: "refresh" }
  );
  assert.deepEqual(
    viewOnlyPinNextAction(session, pinFor("A", { review: true }), { viewThreadId: "B" }),
    { kind: "release" },
    "navigated away → just release, no resume"
  );
});

test("a review pin refreshes when the review advances and is quiet while loading", () => {
  const session = realSession({ active_review_jobs: REVIEW_RUNNING });
  const sig = (s, threadId) =>
    (s.active_review_jobs || [])
      .filter((job) => job.parent_thread_id === threadId)
      .map((job) => `${job.status}:${job.round ?? 0}`)
      .join("|");

  assert.deepEqual(
    viewOnlyPinNextAction(
      session,
      pinFor("A", { review: true, reviewSig: "stale-signature" }),
      { viewThreadId: "A", reviewSignature: sig }
    ),
    { kind: "refresh" }
  );
  assert.deepEqual(
    viewOnlyPinNextAction(
      session,
      pinFor("A", { review: true, reviewSig: "stale-signature", loading: true }),
      { viewThreadId: "A", reviewSignature: sig }
    ),
    { kind: "none" },
    "an in-flight load must not trigger another refresh"
  );
});

test("no pin or no session → nothing to do", () => {
  assert.deepEqual(viewOnlyPinNextAction(realSession(), null, { viewThreadId: "A" }), {
    kind: "none",
  });
  assert.deepEqual(viewOnlyPinNextAction(null, pinFor("A"), { viewThreadId: "A" }), {
    kind: "none",
  });
});

// ---------------------------------------------------------------------------
// viewOnlyEligible + buildViewOnlyPin
// ---------------------------------------------------------------------------

test("any non-active thread is eligible for view-only — review no longer required", () => {
  const session = realSession();
  assert.equal(viewOnlyEligible(session, "A"), true);
  assert.equal(viewOnlyEligible(session, "LIVE"), false, "the active thread is live, not view-only");
  assert.equal(viewOnlyEligible(session, null), false);
  assert.equal(viewOnlyEligible(null, "A"), false);
});

test("buildViewOnlyPin captures entries, older cursor, and the viewed thread cwd", () => {
  const pin = buildViewOnlyPin({
    threadId: "A",
    page: {
      thread_id: "A",
      entries: [{ item_id: "e9" }],
      prev_cursor: 4,
    },
    generation: 3,
    review: false,
    cwd: "/saved/workspace",
    provider: "saved-provider",
  });
  assert.equal(pin.threadId, "A");
  assert.deepEqual(pin.entries.map((entry) => entry.item_id), ["e9"]);
  assert.equal(pin.olderCursor, 4);
  assert.equal(pin.generation, 3);
  assert.equal(pin.cwd, "/saved/workspace");
  assert.equal(pin.provider, "saved-provider");
  assert.equal(pin.loading, false);
});
