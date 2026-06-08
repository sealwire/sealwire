import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewerPanel } from "../shared/reviewer-panel.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";
import { ReviewerChip } from "./workspace-diff.js";

const h = React.createElement;

function makeStore(stateOverrides = {}) {
  const state = {
    status: "loaded",
    data: null,
    activeTab: "changes",
    review: { reviewJobs: [], reviewModel: {}, canRequest: false, blocked: false },
    ...stateOverrides,
  };
  return {
    getState: () => state,
    subscribe: () => () => {},
    setActiveTab() {},
    setReview() {},
  };
}

test("ReviewerPanel empty state shows the CTA + launcher when a review can be requested", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [],
      reviewModel: { providerOptions: [{ label: "Codex", value: "codex" }], models: [], defaultProvider: "codex" },
      canRequest: true,
      onRequestReview() {},
    })
  );
  assert.match(html, /Ask another agent to review/);
  assert.match(html, /review-launch-button/);
});

test("ReviewerPanel empty state shows a disabled launcher + hint when not allowed but wired", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [],
      reviewModel: {},
      canRequest: false,
      onRequestReview() {},
    })
  );
  // The affordance stays visible (discoverable) but disabled, with the reason.
  assert.match(html, /review-launch-button/);
  assert.match(html, /review-launch-button[^>]*disabled/);
  assert.match(html, /Available when the agent is idle/);
});

test("ReviewerPanel empty state omits the launcher entirely when no request wiring exists", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [],
      reviewModel: {},
      canRequest: false,
    })
  );
  assert.doesNotMatch(html, /review-launch-button/);
  assert.match(html, /Available when the agent is idle/);
});

test("ReviewerPanel renders a job card with a Dismiss action enabled only on terminal status", () => {
  const terminal = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r1", reviewer_provider: "claude_code", status: "complete", reviewer_thread_id: "t-rev" }],
      canRequest: false,
    })
  );
  assert.match(terminal, /claude_code/);
  assert.match(terminal, /Review complete/);
  // Dismiss button present and NOT disabled for a terminal job.
  assert.match(terminal, /reviewer-dismiss-button/);
  assert.doesNotMatch(terminal, /reviewer-dismiss-button[^>]*disabled/);

  const active = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r2", reviewer_provider: "codex", status: "waiting_for_reviewer" }],
      canRequest: false,
    })
  );
  // Dismiss disabled while the review is still running.
  assert.match(active, /reviewer-dismiss-button[^>]*disabled/);
});

test("ReviewerPanel surfaces the unlock action when a review is blocked", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r3", reviewer_provider: "codex", status: "blocked" }],
      canRequest: false,
      onResolveReview() {},
    })
  );
  assert.match(html, /review-resolve-button/);
  assert.match(html, /Stop reviewer &amp; unlock/);
});

test("ReviewerPanel shows a Stop button for any in-progress (non-terminal) review", () => {
  // A stuck-but-not-blocked review (e.g. the reviewer turn hangs) must still be
  // stoppable, so the user can recover the locked workspace.
  const running = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r", reviewer_provider: "codex", status: "waiting_for_reviewer" }],
      canRequest: false,
      onResolveReview() {},
    })
  );
  assert.match(running, /review-resolve-button/);
  assert.match(running, />Stop review</);
  assert.doesNotMatch(running, /Stop reviewer &amp; unlock/);

  // A terminal review has no Stop button (only Delete).
  const done = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        { id: "r2", reviewer_provider: "codex", status: "complete", reviewer_thread_id: "t" },
      ],
      canRequest: false,
      onResolveReview() {},
    })
  );
  assert.doesNotMatch(done, /review-resolve-button/);
});

test("ReviewerChip stays hidden when there is no review (idle), regardless of canRequest", () => {
  // No reviews + can't request → hidden.
  const cannot = renderToStaticMarkup(
    h(ReviewerChip, {
      store: makeStore({
        review: { reviewJobs: [], reviewModel: {}, canRequest: false, blocked: false },
      }),
    })
  );
  assert.equal(cannot, "");

  // No reviews + COULD request → still hidden. The composer already carries the
  // "Want a second opinion?" idle nudge for launching; a badge-less pill here
  // would just be a second, signal-less Reviewer affordance competing for space.
  const idle = renderToStaticMarkup(
    h(ReviewerChip, {
      store: makeStore({
        review: { reviewJobs: [], reviewModel: {}, canRequest: true, blocked: false },
      }),
    })
  );
  assert.equal(idle, "");
});

test("ReviewerChip is a labeled pill that surfaces review status", () => {
  const done = renderToStaticMarkup(
    h(ReviewerChip, {
      store: makeStore({
        review: { reviewJobs: [{ id: "r1", status: "complete" }], canRequest: false, blocked: false },
      }),
    })
  );
  assert.match(done, /reviewer-chip/);
  assert.match(done, />Reviewer</);
  assert.match(done, /is-done/);
  assert.match(done, /✓/);

  const blocked = renderToStaticMarkup(
    h(ReviewerChip, {
      store: makeStore({
        review: { reviewJobs: [{ id: "r2", status: "blocked" }], canRequest: false, blocked: true },
      }),
    })
  );
  assert.match(blocked, /is-blocked/);
  assert.match(blocked, /⚠/);
});

test("ReviewerChip surfaces a running review with a badge", () => {
  const html = renderToStaticMarkup(
    h(ReviewerChip, {
      store: makeStore({
        review: { reviewJobs: [{ id: "r1", status: "waiting_for_reviewer" }], canRequest: false, blocked: false },
      }),
    })
  );
  assert.match(html, /reviewer-chip/);
  assert.match(html, />Reviewer</);
  assert.match(html, /is-active/);
  assert.match(html, /workspace-diff-chip-review/);
});

test("RightPanelTabs shows the Changes body by default and both tab labels", () => {
  const store = makeStore({ activeTab: "changes" });
  const html = renderToStaticMarkup(
    h(RightPanelTabs, {
      store,
      panelId: "review-panel-test",
      reviewer: {},
      changes: h("div", { id: "changes-body" }, "CHANGES-BODY"),
    })
  );
  assert.match(html, /CHANGES-BODY/);
  assert.match(html, />Changes</);
  assert.match(html, />Reviewer</);
});

test("RightPanelTabs flags the Reviewer tab when a review is blocked, and renders the reviewer body when selected", () => {
  const blockedLabel = renderToStaticMarkup(
    h(RightPanelTabs, {
      store: makeStore({
        activeTab: "changes",
        review: { reviewJobs: [{ id: "r", status: "blocked" }], reviewModel: {}, canRequest: false, blocked: true },
      }),
      panelId: "review-panel-test",
      reviewer: {},
      changes: h("div", null, "CHANGES-BODY"),
    })
  );
  assert.match(blockedLabel, /Reviewer ⚠/);

  const reviewerBody = renderToStaticMarkup(
    h(RightPanelTabs, {
      store: makeStore({ activeTab: "reviewer" }),
      panelId: "review-panel-test",
      reviewer: {},
      changes: h("div", null, "CHANGES-BODY"),
    })
  );
  assert.match(reviewerBody, /Ask another agent to review/);
  assert.doesNotMatch(reviewerBody, /CHANGES-BODY/);
});

test("RightPanelTabs shows the in-progress dot for a running review", () => {
  const html = renderToStaticMarkup(
    h(RightPanelTabs, {
      store: makeStore({
        activeTab: "changes",
        review: {
          reviewJobs: [{ id: "r", status: "waiting_for_reviewer" }],
          reviewModel: {},
          canRequest: false,
          blocked: false,
        },
      }),
      panelId: "review-panel-test",
      reviewer: {},
      changes: h("div", null, "CHANGES-BODY"),
    })
  );
  assert.match(html, /Reviewer •/);
});

test("RightPanelTabs treats an escalated review as terminal (no in-progress dot)", () => {
  // `escalated` is terminal: the tab label must read a plain "Reviewer" — not the
  // in-progress "Reviewer •" — so the tab agrees with review-state.js + the backend
  // (regression guard for the duplicated terminal-status set that omitted escalated).
  const html = renderToStaticMarkup(
    h(RightPanelTabs, {
      store: makeStore({
        activeTab: "changes",
        review: {
          reviewJobs: [{ id: "r", status: "escalated" }],
          reviewModel: {},
          canRequest: false,
          blocked: false,
        },
      }),
      panelId: "review-panel-test",
      reviewer: {},
      changes: h("div", null, "CHANGES-BODY"),
    })
  );
  assert.doesNotMatch(html, /Reviewer •/);
  assert.doesNotMatch(html, /Reviewer ⚠/);
  assert.match(html, />Reviewer</);
});

test("ReviewerPanel shows round progress + verdict for an iterative review", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r1",
          reviewer_provider: "codex",
          status: "addressing_findings",
          round: 1,
          max_rounds: 3,
          verdict: "needs_changes",
        },
      ],
      canRequest: false,
    })
  );
  assert.match(html, /Round 1\/3/);
  assert.match(html, /Verdict: needs_changes/);
});

test("ReviewerPanel hides round/verdict for a single-shot review", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r2",
          reviewer_provider: "codex",
          status: "complete",
          round: 1,
          max_rounds: 1,
          verdict: "unknown",
        },
      ],
      canRequest: false,
    })
  );
  assert.doesNotMatch(html, /Round 1\/1/);
  // An "unknown" verdict is not surfaced.
  assert.doesNotMatch(html, /Verdict:/);
});

test("ReviewerPanel treats an escalated review as terminal (Delete enabled)", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r-esc",
          reviewer_provider: "codex",
          status: "escalated",
          reviewer_thread_id: "rev-1",
          round: 3,
          max_rounds: 3,
          verdict: "needs_changes",
        },
      ],
      canRequest: false,
    })
  );
  // The Delete button shows its TERMINAL title only when the job is terminal — so an
  // escalated job is dismissible (and its transcript is fetched, gated by the same flag).
  assert.match(html, /Delete this review and its reviewer thread/);
  assert.doesNotMatch(html, /Stop the reviewer before deleting/);
});
