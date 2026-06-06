import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ReviewLauncher,
  ReviewPanel,
} from "../shared/review-panel.js";
import {
  isReviewBlocked,
  isReviewInProgress,
  reviewChipTone,
  reviewStatusLabel,
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
