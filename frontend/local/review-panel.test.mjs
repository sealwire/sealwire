import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ReviewLauncher,
  ReviewPanel,
  reviewSubmitPayload,
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

test("reviewSubmitPayload carries the reuse thread id and nulls the model on reuse", () => {
  // Reuse: the chosen thread id is sent and the model is NEVER overridden (the
  // existing thread keeps its own session model).
  assert.deepEqual(
    reviewSubmitPayload({
      reviewerProvider: "codex",
      reviewerModel: "gpt-5.5",
      instructions: "  look again  ",
      reviewerThreadId: "rev-1",
    }),
    {
      reviewerProvider: "codex",
      reviewerModel: null,
      instructions: "look again",
      reviewerThreadId: "rev-1",
    }
  );
});

test("reviewSubmitPayload sends a clean reviewer (null thread id) otherwise", () => {
  // "clean" sentinel and undefined both mean a fresh reviewer; the model passes through.
  for (const reviewerThreadId of ["clean", undefined]) {
    assert.deepEqual(
      reviewSubmitPayload({
        reviewerProvider: "codex",
        reviewerModel: "gpt-5.5",
        instructions: "",
        reviewerThreadId,
      }),
      {
        reviewerProvider: "codex",
        reviewerModel: "gpt-5.5",
        instructions: null,
        reviewerThreadId: null,
      }
    );
  }
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
  // Unknown statuses fall back to a sane default.
  assert.equal(reviewStatusLabel("something_new"), "something_new");
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

test("selectReviewLaunchModel falls back to the session provider when it is the only one", () => {
  const model = selectReviewLaunchModel({
    providers: ["codex"],
    providerModels: {},
    session: { provider: "codex", available_models: [{ model: "gpt-5.5" }] },
  });
  assert.equal(model.defaultProvider, "codex");
  assert.equal(model.models.length, 1);
});

test("canRequestReview requires controller + idle + no active review", () => {
  const base = {
    active_thread_id: "t1",
    active_controller_device_id: "device-a",
    active_turn_id: null,
    current_status: "idle",
    active_review_jobs: [],
  };
  assert.equal(canRequestReview(base, "device-a"), true);
  // Not the controller.
  assert.equal(canRequestReview(base, "device-b"), false);
  // A turn is running.
  assert.equal(canRequestReview({ ...base, active_turn_id: "turn-1" }, "device-a"), false);
  // Status not idle.
  assert.equal(canRequestReview({ ...base, current_status: "working" }, "device-a"), false);
  // A review already in progress.
  assert.equal(
    canRequestReview({ ...base, active_review_jobs: [{ status: "waiting_for_reviewer" }] }, "device-a"),
    false
  );
  // No active thread.
  assert.equal(canRequestReview({ ...base, active_thread_id: null }, "device-a"), false);
});

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
