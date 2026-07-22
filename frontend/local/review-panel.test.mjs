import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ReviewLauncher,
  ReviewPanel,
  reviewSubmitPayload,
  clampReviewRounds,
  providerSwitchClearsReuse,
} from "../shared/review-panel.js";
import {
  canRequestReview,
  isReviewBlocked,
  isReviewInProgress,
  isReviewInProgressForThread,
  reviewChipTone,
  reviewStatusLabel,
  selectReviewLaunchModel,
} from "../shared/review-state.js";

const h = React.createElement;

test("ReviewPanel renders the reviewer provider options and the clean-reviewer field", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [
        { label: "Codex", value: "codex" },
        { label: "Claude", value: "claude_code" },
      ],
      models: [{ model: "gpt-5.5", display_name: "GPT-5.5", provider: "codex" }],
      defaultProvider: "claude_code",
    })
  );

  assert.match(html, /Request review/);
  assert.match(html, /value="codex"/);
  assert.match(html, /value="claude_code"/);
  assert.match(html, /New clean reviewer session/);
  assert.match(html, /Start review/);
  assert.match(html, /focus on the storage refactor/);
});

test("ReviewPanel surfaces a loading hint instead of a silent empty model picker", () => {
  // The reported bug: when the cross-agent reviewer provider's catalog hasn't
  // loaded, the model <select> simply vanished with no explanation. An empty
  // catalog with a "loading" status must show a hint, not nothing.
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [], // codex catalog not loaded yet
      defaultProvider: "codex",
      providerModelsStatus: { codex: "loading" },
      onEnsureProviderModels: () => {}, // a loader is wired, so the hint is meaningful
    })
  );
  assert.match(html, /Loading reviewer models/i);
});

test("ReviewPanel stays silent (no stuck hint) when no catalog loader is wired", () => {
  // Without onEnsureProviderModels nothing can resolve a "loading" state, so the
  // dialog must NOT render a spinner that can never clear (e.g. the local surface).
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "codex",
      providerModelsStatus: { codex: "loading" },
      // no onEnsureProviderModels
    })
  );
  assert.doesNotMatch(html, /Loading reviewer models/i);
});

test("ReviewPanel surfaces a failed-load hint with a retry, not a silent empty picker", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "codex",
      providerModelsStatus: { codex: "error" },
      onEnsureProviderModels: () => {},
    })
  );
  // (renderToStaticMarkup escapes the apostrophe in "Couldn't" → &#x27;)
  assert.match(html, /load the reviewer models/i);
  assert.match(html, /Retry/);
});

test("ReviewPanel does not offer a hidden model in the reviewer-model picker", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [
        { model: "gpt-5.5", display_name: "GPT-5.5", provider: "codex" },
        {
          model: "codex-auto-review",
          display_name: "Codex Auto Review",
          provider: "codex",
          hidden: true,
        },
      ],
      defaultProvider: "codex",
    })
  );

  assert.match(html, /GPT-5\.5/, "visible reviewer model is offered");
  assert.doesNotMatch(html, /Codex Auto Review/, "hidden model must not be offered");
  assert.doesNotMatch(html, /codex-auto-review/, "hidden model value must not appear");
});

test("ReviewPanel lists reusable reviewer threads as 'Reuse:' options", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "codex",
      reusableReviewers: [
        { reviewerThreadId: "rev-1", provider: "codex", label: "Codex reviewer" },
      ],
    })
  );
  // The clean option plus the reusable reviewer are both offered.
  assert.match(html, /New clean reviewer session/);
  assert.match(html, /Reuse: Codex reviewer/);
  assert.match(html, /value="rev-1"/);
});

test("ReviewPanel shows only the clean option when there are no reusable reviewers", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "codex",
      reusableReviewers: [],
    })
  );
  assert.match(html, /New clean reviewer session/);
  assert.doesNotMatch(html, /Reuse:/);
});

test("ReviewPanel reuse options are grouped by provider (a codex reviewer is hidden under Claude)", () => {
  const reusableReviewers = [
    { reviewerThreadId: "rev-codex", provider: "codex", label: "Codex reviewer" },
    { reviewerThreadId: "rev-claude", provider: "claude_code", label: "Claude reviewer" },
  ];
  const providerOptions = [
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude_code" },
  ];
  // Default reviewer provider is Claude → only the Claude reviewer is offered for reuse.
  const claudeView = renderToStaticMarkup(
    h(ReviewPanel, { providerOptions, models: [], defaultProvider: "claude_code", reusableReviewers })
  );
  assert.match(claudeView, /value="rev-claude"/);
  assert.doesNotMatch(claudeView, /value="rev-codex"/);

  // Default reviewer provider is Codex → only the Codex reviewer is offered.
  const codexView = renderToStaticMarkup(
    h(ReviewPanel, { providerOptions, models: [], defaultProvider: "codex", reusableReviewers })
  );
  assert.match(codexView, /value="rev-codex"/);
  assert.doesNotMatch(codexView, /value="rev-claude"/);
});

test("providerSwitchClearsReuse flags switching away from a reused session (drives the flash)", () => {
  // Switching the provider always falls back to a clean reviewer; it should flash the
  // reviewer-session field only when a reused session was actually switched away from.
  assert.equal(providerSwitchClearsReuse("rev-1"), true);
  assert.equal(providerSwitchClearsReuse("clean"), false);
  assert.equal(providerSwitchClearsReuse(undefined), false);
  assert.equal(providerSwitchClearsReuse(null), false);
});

test("re-review keeps the reviewer provider selectable (not locked) and explains switching", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [
        { label: "Codex", value: "codex" },
        { label: "Claude", value: "claude_code" },
      ],
      models: [],
      defaultProvider: "claude_code",
      reusableReviewers: [{ reviewerThreadId: "rev-1", provider: "codex", label: "Codex reviewer" }],
      // Prefilled re-review of a codex reviewer thread.
      initialReviewerThreadId: "rev-1",
      initialProvider: "codex",
    })
  );
  // The provider <select> must NOT be disabled during reuse — the user can switch it.
  assert.doesNotMatch(html, /id="review-panel-provider"[^>]*disabled/);
  // Copy reflects the new behavior (switching starts a new reviewer), not "fixed".
  assert.match(html, /Switching the provider starts a new reviewer/);
  assert.doesNotMatch(html, /Provider and model are fixed/);
});

test("reviewSubmitPayload carries the reuse thread id AND an explicit model/effort override", () => {
  // Reuse now honors a model/effort override (the existing thread no longer silently
  // keeps its own when the user picks one); the chosen thread id is still sent.
  assert.deepEqual(
    reviewSubmitPayload({
      reviewerProvider: "codex",
      reviewerModel: "gpt-5.5",
      reviewerEffort: "high",
      instructions: "  look again  ",
      reviewerThreadId: "rev-1",
    }),
    {
      reviewerProvider: "codex",
      parentThreadId: null,
      reviewerModel: "gpt-5.5",
      reviewerEffort: "high",
      instructions: "look again",
      reviewerThreadId: "rev-1",
      maxRounds: 1,
      recapSource: "last_message",
    }
  );
});

test("reviewSubmitPayload leaves model/effort null when not overridden on reuse", () => {
  // Empty values mean "keep the reviewer thread's own model/effort".
  assert.deepEqual(
    reviewSubmitPayload({
      reviewerProvider: "codex",
      reviewerModel: "",
      reviewerEffort: "",
      reviewerThreadId: "rev-1",
    }),
    {
      reviewerProvider: "codex",
      parentThreadId: null,
      reviewerModel: null,
      reviewerEffort: null,
      instructions: null,
      reviewerThreadId: "rev-1",
      maxRounds: 1,
      recapSource: "last_message",
    }
  );
});

test("reviewSubmitPayload sends a clean reviewer (null thread id) otherwise", () => {
  // "clean" sentinel and undefined both mean a fresh reviewer; model/effort pass through.
  for (const reviewerThreadId of ["clean", undefined]) {
    assert.deepEqual(
      reviewSubmitPayload({
        reviewerProvider: "codex",
        reviewerModel: "gpt-5.5",
        reviewerEffort: "medium",
        instructions: "",
        reviewerThreadId,
      }),
      {
        reviewerProvider: "codex",
        parentThreadId: null,
        reviewerModel: "gpt-5.5",
        reviewerEffort: "medium",
        instructions: null,
        reviewerThreadId: null,
        maxRounds: 1,
        recapSource: "last_message",
      }
    );
  }
});

test("reviewSubmitPayload carries the parent thread id (the thread to review), defaulting to null", () => {
  // The panel is scoped to the VIEWED thread, so a review must target that thread.
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", parentThreadId: "thread-B" }).parentThreadId,
    "thread-B"
  );
  // Absent → null, which lets the backend default to the active thread.
  assert.equal(reviewSubmitPayload({ reviewerProvider: "codex" }).parentThreadId, null);
});

test("reviewSubmitPayload carries and clamps the round budget", () => {
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", maxRounds: 3 }).maxRounds,
    3
  );
  // Default is single-shot.
  assert.equal(reviewSubmitPayload({ reviewerProvider: "codex" }).maxRounds, 1);
  // Out-of-range / garbage clamps into 1..=10.
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", maxRounds: 99 }).maxRounds,
    10
  );
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", maxRounds: 0 }).maxRounds,
    1
  );
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", maxRounds: "abc" }).maxRounds,
    1
  );
});

test("reviewSubmitPayload defaults the briefing to last_message; 'recap' is honored", () => {
  // The token-saving default: brief the reviewer with the author's last message.
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex" }).recapSource,
    "last_message"
  );
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", recapSource: "recap" }).recapSource,
    "recap"
  );
  // Anything unrecognized falls back to the safe default.
  assert.equal(
    reviewSubmitPayload({ reviewerProvider: "codex", recapSource: "bogus" }).recapSource,
    "last_message"
  );
});

test("clampReviewRounds bounds the round budget to 1..=10", () => {
  assert.equal(clampReviewRounds(1), 1);
  assert.equal(clampReviewRounds(10), 10);
  assert.equal(clampReviewRounds(2.6), 3);
  assert.equal(clampReviewRounds(-5), 1);
  assert.equal(clampReviewRounds(50), 10);
  assert.equal(clampReviewRounds(undefined), 1);
  assert.equal(clampReviewRounds("4"), 4);
});

test("ReviewPanel renders a maximum-rounds input", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "codex",
    })
  );
  assert.match(html, /Maximum rounds/);
  assert.match(html, /id="review-panel-max-rounds"/);
  assert.match(html, /type="number"/);
});

test("ReviewPanel renders a reasoning-effort selector with the model's supported efforts", () => {
  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [
        {
          model: "gpt-5.5",
          display_name: "GPT-5.5",
          provider: "codex",
          supported_reasoning_efforts: ["low", "high"],
        },
      ],
      defaultProvider: "codex",
    })
  );
  assert.match(html, /Reasoning effort/);
  assert.match(html, /id="review-panel-effort"/);
});

test("ReviewLauncher renders a Review button alongside the panel", () => {
  const html = renderToStaticMarkup(
    h(ReviewLauncher, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "codex",
    })
  );

  assert.match(html, /review-launch-button/);
  assert.match(html, />Review</);
  assert.match(html, /id="review-panel"/);
});

test("reviewStatusLabel maps each job status to a human label", () => {
  assert.equal(reviewStatusLabel("waiting_for_reviewer"), "Reviewing");
  assert.equal(reviewStatusLabel("waiting_for_parent_recap"), "Recapping changes");
  assert.equal(reviewStatusLabel("posting_back"), "Posting review back");
  assert.equal(reviewStatusLabel("complete"), "Review complete");
  assert.equal(reviewStatusLabel("failed"), "Review failed");
  // Phase 5 iterative-loop statuses.
  assert.equal(reviewStatusLabel("addressing_findings"), "Author addressing findings…");
  assert.equal(reviewStatusLabel("escalated"), "Reviewer still has concerns");
  // Unknown statuses fall back to a sane default.
  assert.equal(reviewStatusLabel("something_new"), "something_new");
});

test("reviewChipTone flags escalated as an alert", () => {
  assert.equal(reviewChipTone("escalated"), "alert");
  assert.equal(reviewChipTone("failed"), "alert");
  assert.equal(reviewChipTone("complete"), "ready");
  assert.equal(reviewChipTone("waiting_for_reviewer"), "active");
});

test("isReviewBlocked detects the persistent blocked state", () => {
  assert.equal(isReviewBlocked({ active_review_jobs: [{ status: "waiting_for_reviewer" }] }), false);
  assert.equal(isReviewBlocked({ active_review_jobs: [{ status: "blocked" }] }), true);
  assert.equal(isReviewBlocked({ active_review_jobs: [] }), false);
  // A blocked review still reads as in-progress (controls stay disabled).
  assert.equal(isReviewInProgress({ active_review_jobs: [{ status: "blocked" }] }), true);
  assert.equal(reviewStatusLabel("blocked"), "Review blocked — action needed");
});

test("selectReviewLaunchModel offers a different default provider and flattens the model catalog", () => {
  const model = selectReviewLaunchModel({
    providers: ["codex", "claude_code"],
    providerModels: {
      codex: [{ model: "gpt-5.5", display_name: "GPT-5.5" }],
      claude_code: [{ model: "sonnet", display_name: "Sonnet" }],
    },
    session: { provider: "codex", available_models: [] },
  });
  // Default reviewer should be the OTHER provider (cross-agent review).
  assert.equal(model.defaultProvider, "claude_code");
  assert.deepEqual(
    model.providerOptions.map((option) => option.value),
    ["codex", "claude_code"]
  );
  assert.equal(model.models.length, 2);
});

test("selectReviewLaunchModel stamps each model with its provider so the dialog filters by reviewer", () => {
  const { models } = selectReviewLaunchModel({
    providers: ["codex", "claude_code"],
    providerModels: {
      // Codex returns models with an EMPTY provider field — the source of the bug
      // where GPT models showed up under a Claude reviewer.
      codex: [{ model: "gpt-5.5", display_name: "GPT-5.5", provider: "" }],
      claude_code: [{ model: "sonnet", display_name: "Sonnet", provider: "claude_code" }],
    },
    session: { provider: "codex", available_models: [] },
  });
  // Every model carries its owning provider key (no empty providers left to leak).
  assert.deepEqual(
    models.map((model) => [model.model, model.provider]).sort(),
    [
      ["gpt-5.5", "codex"],
      ["sonnet", "claude_code"],
    ]
  );
  // The dialog's per-provider filter now shows ONLY the chosen reviewer's models.
  const forClaude = models.filter(
    (model) => !model.provider || model.provider === "claude_code"
  );
  assert.deepEqual(
    forClaude.map((model) => model.model),
    ["sonnet"]
  );
});

test("selectReviewLaunchModel falls back to the session provider when it is the only one", () => {
  const model = selectReviewLaunchModel({
    providers: ["codex"],
    providerModels: {},
    session: { provider: "codex", available_models: [{ model: "gpt-5.5" }] },
  });
  assert.equal(model.defaultProvider, "codex");
  assert.equal(model.models.length, 1);
});

test("canRequestReview gates on the reviewed thread being idle + no review running (control NOT checked)", () => {
  const base = {
    active_thread_id: "t1",
    active_controller_device_id: "device-a",
    active_turn_id: null,
    current_status: "idle",
    active_review_jobs: [],
  };
  assert.equal(canRequestReview(base, "device-a"), true);
  // Control is NOT a gate: a review is a background action authorized server-side by
  // path-scope, so a non-controller device may still request one.
  assert.equal(canRequestReview(base, "device-b"), true);
  // A turn is running on the reviewed (active) thread.
  assert.equal(canRequestReview({ ...base, active_turn_id: "turn-1" }, "device-a"), false);
  // A genuinely-working status blocks.
  assert.equal(canRequestReview({ ...base, current_status: "working" }, "device-a"), false);
  // A saved Codex thread reports `unknown` (not the literal "idle") but isn't running —
  // it must still allow a review, mirroring the backend `thread_status_is_working`.
  assert.equal(canRequestReview({ ...base, current_status: "unknown" }, "device-a"), true);
  assert.equal(canRequestReview({ ...base, current_status: "completed" }, "device-a"), true);
  // A review already in progress ON THE REVIEWED THREAD blocks. The fixture must name the
  // parent: the gate is per-thread (mirroring the backend `is_thread_review_locked`), so a
  // job with no parent is a job on no thread and locks nothing. See the concurrent-reviews
  // test below for the other half of this invariant.
  assert.equal(
    canRequestReview(
      { ...base, active_review_jobs: [{ parent_thread_id: "t1", status: "waiting_for_reviewer" }] },
      "device-a"
    ),
    false
  );
  // No thread to review at all (no active, no viewed) → still false.
  assert.equal(canRequestReview({ ...base, active_thread_id: null }, "device-a"), false);
});

test("canRequestReview mirrors backend workflow mutual exclusion", () => {
  const base = {
    active_thread_id: "t1",
    active_turn_id: null,
    current_status: "idle",
    thread_activity: [],
    pending_approvals: [],
    active_review_jobs: [],
  };
  for (const status of ["queued", "running", "blocked", "resolving"]) {
    assert.equal(
      canRequestReview(
        { ...base, active_workflow_runs: [{ id: `wf-${status}`, status, parent_thread_id: "other" }] },
        "device-a"
      ),
      false,
      `${status} workflow should disable review requests globally`
    );
  }
  for (const status of ["done", "escalated", "failed", "interrupted", "cancelled"]) {
    assert.equal(
      canRequestReview(
        { ...base, active_workflow_runs: [{ id: `wf-${status}`, status, parent_thread_id: "other" }] },
        "device-a"
      ),
      true,
      `${status} workflow should not disable review requests`
    );
  }
});

test("canRequestReview corner cases: no-thread, no-active-but-viewed, and per-thread approvals", () => {
  // No active thread AND no viewed thread → nothing to review.
  assert.equal(canRequestReview({ active_review_jobs: [] }, "device-a"), false);
  assert.equal(canRequestReview({ active_review_jobs: [] }, "device-a", null), false);

  // No active thread, but a named idle viewed thread → allowed (mirrors the backend, which
  // no longer requires an active thread when a parent_thread_id is named).
  assert.equal(
    canRequestReview(
      { active_thread_id: null, thread_activity: [], active_review_jobs: [] },
      "device-a",
      "saved-idle-thread"
    ),
    true
  );

  // Approvals are scoped to the REVIEWED thread: one pending on a different thread does
  // not block; one on the reviewed thread does.
  const session = {
    active_thread_id: "active",
    thread_activity: [],
    active_review_jobs: [],
    pending_approvals: [{ thread_id: "some-other-thread" }],
  };
  assert.equal(canRequestReview(session, "device-a", "viewed-idle"), true);
  assert.equal(
    canRequestReview(
      { ...session, pending_approvals: [{ thread_id: "viewed-idle" }] },
      "device-a",
      "viewed-idle"
    ),
    false
  );
});

test("canRequestReview gates on the VIEWED thread, not the active thread (review a non-active idle thread)", () => {
  // Regression: when another thread holds the active slot and is mid-turn, the
  // Request-review / Re-review button for the idle thread you're VIEWING must NOT be
  // disabled. A review is a background action on the viewed thread — the active thread's
  // turn/status is irrelevant to it.
  const session = {
    active_thread_id: "active-busy",
    active_controller_device_id: null, // unclaimed
    active_turn_id: "turn-running", // the ACTIVE thread is mid-turn
    current_status: "active",
    thread_activity: [], // the viewed thread is NOT working
    active_review_jobs: [],
  };
  // Reviewing the active (busy) thread is still blocked.
  assert.equal(canRequestReview(session, "device-a", "active-busy"), false);
  // Reviewing a DIFFERENT, idle thread you're viewing must be allowed.
  assert.equal(canRequestReview(session, "device-a", "idle-viewed"), true);
  // A viewed thread that IS working (present in thread_activity) stays blocked.
  assert.equal(
    canRequestReview(
      { ...session, thread_activity: [{ thread_id: "busy-bg" }] },
      "device-a",
      "busy-bg"
    ),
    false
  );
});

test("canRequestReview scopes the review-in-progress gate to the reviewed thread (concurrent reviews)", () => {
  // Regression: a review running on SOME OTHER thread used to disable "Request review"
  // on every thread in the workspace, because the gate called the workspace-global
  // `isReviewInProgress`. The backend lock (`is_thread_review_locked`) is per-thread —
  // it only refuses when the named parent is itself the parent OR the reviewer of a
  // non-terminal job — so the UI was strictly stricter than the server and silently
  // serialized reviews that the relay would happily have run concurrently.
  const session = {
    active_thread_id: "active-idle",
    active_turn_id: null,
    current_status: "idle",
    thread_activity: [],
    pending_approvals: [],
    active_review_jobs: [
      {
        parent_thread_id: "other-parent",
        reviewer_thread_id: "other-reviewer",
        status: "waiting_for_reviewer",
      },
    ],
  };
  // The thread under review, and the reviewer thread doing the reviewing, stay locked.
  assert.equal(canRequestReview(session, "device-a", "other-parent"), false);
  assert.equal(canRequestReview(session, "device-a", "other-reviewer"), false);
  // Any UNRELATED thread must remain requestable while that review runs.
  assert.equal(canRequestReview(session, "device-a", "unrelated-idle"), true);
  assert.equal(canRequestReview(session, "device-a", "active-idle"), true);
  // A terminal job on the viewed thread does not lock it (re-review must stay available).
  assert.equal(
    canRequestReview(
      {
        ...session,
        active_review_jobs: [{ parent_thread_id: "done-parent", status: "complete" }],
      },
      "device-a",
      "done-parent"
    ),
    true
  );
});

test("canRequestReview ignores the __view_only__ render sentinel (review is a background action)", () => {
  // Browsing a non-active thread projects the session with a "__view_only__" controller
  // sentinel; that is a render artifact, not a real lock, so it must not disable a review
  // of the (idle) viewed thread.
  const projected = {
    active_thread_id: "viewed-idle",
    active_controller_device_id: "__view_only__",
    active_turn_id: null,
    current_status: "idle",
    thread_activity: [],
    active_review_jobs: [],
  };
  assert.equal(canRequestReview(projected, "device-a", "viewed-idle"), true);
});

// The read-only view projection moved to frontend/local/view-only-thread.js and is
// no longer review-specific — any non-active thread projects read-only. Projection
// behavior (including the review flavor) is covered by view-only-thread.test.mjs.

test("isReviewInProgressForThread only matches the reviewed parent while non-terminal", () => {
  const session = {
    active_review_jobs: [
      { parent_thread_id: "parent-1", status: "waiting_for_reviewer" },
      { parent_thread_id: "parent-2", status: "complete" },
    ],
  };
  // The thread currently under (non-terminal) review.
  assert.equal(isReviewInProgressForThread(session, "parent-1"), true);
  // A thread whose only review already finished must NOT show the placeholder.
  assert.equal(isReviewInProgressForThread(session, "parent-2"), false);
  // Unrelated threads / no thread.
  assert.equal(isReviewInProgressForThread(session, "other"), false);
  assert.equal(isReviewInProgressForThread(session, null), false);
  assert.equal(isReviewInProgressForThread({}, "parent-1"), false);
});

test("reviewChipTone flags failed and complete distinctly from in-progress", () => {
  assert.equal(reviewChipTone("failed"), "alert");
  assert.equal(reviewChipTone("complete"), "ready");
  assert.equal(reviewChipTone("waiting_for_reviewer"), "active");
});

test("isReviewInProgress tracks non-terminal jobs only (terminal jobs linger)", () => {
  assert.equal(isReviewInProgress({ active_review_jobs: [] }), false);
  assert.equal(isReviewInProgress({}), false);
  assert.equal(
    isReviewInProgress({ active_review_jobs: [{ status: "waiting_for_reviewer" }] }),
    true
  );
  // A finished job that is still being shown must NOT read as in-progress.
  assert.equal(
    isReviewInProgress({ active_review_jobs: [{ status: "complete" }] }),
    false
  );
  assert.equal(
    isReviewInProgress({ active_review_jobs: [{ status: "failed" }] }),
    false
  );
  // Mixed: a lingering terminal job plus a live one is in-progress.
  assert.equal(
    isReviewInProgress({
      active_review_jobs: [{ status: "complete" }, { status: "posting_back" }],
    }),
    true
  );
});
