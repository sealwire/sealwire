import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewerPanel, renderReviewerText } from "../shared/reviewer-panel.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";
import {
  ReviewerChip,
  WorkspaceDiffModalTitle,
  WorkspaceDiffSheetBody,
} from "./workspace-diff.js";

const h = React.createElement;

function renderReviewerMarkdown(markdown) {
  return renderToStaticMarkup(h(React.Fragment, null, renderReviewerText(markdown)));
}

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

test("reviewer replies reuse the transcript markdown renderer", () => {
  const html = renderReviewerMarkdown(
    "Findings:\n\n- **Fix** [link](javascript:alert(1))"
  );
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>Fix<\/strong>/);
  assert.match(html, /href="#blocked"/);
  assert.doesNotMatch(html, /javascript:/i);
});

test("ReviewerPanel empty state shows the CTA + launcher when a review can be requested", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [],
      reviewModel: { providerOptions: [{ label: "Codex", value: "codex" }], models: [], defaultProvider: "codex" },
      canRequest: true,
      onRequestReview() {},
    })
  );
  assert.match(html, /Other agents working on this appear here/);
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

test("ReviewerPanel renders a job card with a Delete action enabled only on terminal status", () => {
  const terminal = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r1", reviewer_provider: "claude_code", status: "complete", reviewer_thread_id: "t-rev" }],
      canRequest: false,
    })
  );
  assert.match(terminal, /claude_code/);
  assert.match(terminal, /Review complete/);
  // Delete button present and NOT disabled for a terminal job.
  assert.match(terminal, /reviewer-delete-button/);
  assert.doesNotMatch(terminal, /reviewer-delete-button[^>]*disabled/);

  const active = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r2", reviewer_provider: "codex", status: "waiting_for_reviewer" }],
      canRequest: false,
    })
  );
  // Delete disabled while the review is still running.
  assert.match(active, /reviewer-delete-button[^>]*disabled/);
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
  assert.match(html, />Agents</);
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
  assert.match(blockedLabel, /Agents ⚠/);

  const reviewerBody = renderToStaticMarkup(
    h(RightPanelTabs, {
      store: makeStore({ activeTab: "reviewer" }),
      panelId: "review-panel-test",
      reviewer: {},
      changes: h("div", null, "CHANGES-BODY"),
    })
  );
  assert.match(reviewerBody, /Other agents working on this appear here/);
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
  assert.match(html, /Agents •/);
});

test("RightPanelTabs treats an escalated review as terminal (no in-progress dot)", () => {
  // `escalated` is terminal: the tab label must read a plain "Agents" — not the
  // in-progress "Agents •" — so the tab agrees with review-state.js + the backend
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
  assert.doesNotMatch(html, /Agents •/);
  assert.doesNotMatch(html, /Agents ⚠/);
  assert.match(html, />Agents</);
});

test("WorkspaceDiffModalTitle follows the active tab (so opening Reviewer isn't titled 'Workspace diff')", () => {
  const changes = renderToStaticMarkup(
    h(WorkspaceDiffModalTitle, { store: makeStore({ activeTab: "changes" }) })
  );
  assert.match(changes, /Workspace diff/);
  assert.doesNotMatch(changes, /Reviewer/);

  const reviewer = renderToStaticMarkup(
    h(WorkspaceDiffModalTitle, { store: makeStore({ activeTab: "reviewer" }) })
  );
  assert.match(reviewer, /Reviewer/);
  assert.doesNotMatch(reviewer, /Workspace diff/);
});

test("WorkspaceDiffSheetBody carries its own diff-scoped refresh (not the modal header)", () => {
  // The refresh lives WITH the diff and is labelled so it can't read as a
  // global/session refresh. It only renders here (the Changes body), so it never
  // appears on the Reviewer tab.
  const html = renderToStaticMarkup(
    h(WorkspaceDiffSheetBody, { store: makeStore({ status: "loaded", data: { cwd: "/repo" } }) })
  );
  assert.match(html, /workspace-diff-sheet-refresh/);
  assert.match(html, /Refresh diff/);
  assert.match(html, /aria-label="Refresh workspace diff"/);
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
  // The verdict is the card's title now, so the visible word drops the "Verdict:" prefix
  // that its own position already implies — but the prefix stays for screen readers, and
  // the underscore is humanised for display only.
  assert.match(html, /reviewer-job-verdict-label[^>]*>needs changes</);
  assert.match(html, /sr-only[^>]*>Verdict: </);
  // Tone rides a class, and the colour lands on the MARK rather than the word: dark
  // --ok-fg is a passing mark (3.86:1) but a failing 4.5:1 word on this surface.
  assert.match(html, /reviewer-job-verdict reviewer-job-verdict-warn/);
  assert.match(html, /reviewer-job-verdict-mark/);
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
  // An escalated job is deletable (and its transcript is fetched, gated by the same flag).
  assert.match(html, /Delete this review and its reviewer session/);
  assert.doesNotMatch(html, /Stop the reviewer before deleting/);
});

test("ReviewerPanel shows the reviewer model and collapses the (long) session id behind the info toggle, full value in its tooltip", () => {
  const longName = "Review: refactor the workspace-diff host into shared chrome (round 1)";
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r1",
          reviewer_provider: "codex",
          reviewer_model: "gpt-5-codex",
          status: "waiting_for_reviewer",
          reviewer_thread_id: "rev-thread-1",
        },
      ],
      reviewerThreads: [{ reviewer_thread_id: "rev-thread-1", name: longName }],
      canRequest: false,
    })
  );
  // Model is shown.
  assert.match(html, /reviewer-job-model[^>]*>gpt-5-codex</);
  // The noisy session id/name is NOT in the resting card — it's collapsed behind the
  // header "i" (default hidden), so it doesn't crowd the header.
  assert.doesNotMatch(html, /reviewer-job-thread/);
  // The info toggle is present, starts collapsed (aria-expanded="false"), and carries the
  // FULL value in its title + aria-label so hovering/tapping reveals all of it.
  const escaped = longName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  assert.match(html, new RegExp(`reviewer-job-info[^>]*title="${escaped}"`));
  assert.match(html, /reviewer-job-info[^>]*aria-expanded="false"/);
  assert.match(html, /aria-label="Show reviewer session id \(Review: refactor/);
});

test("ReviewerPanel shows the reviewer effort chip beside the model, with a reasoning-effort tooltip", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r1",
          reviewer_provider: "codex",
          reviewer_model: "gpt-5-codex",
          reviewer_effort: "high",
          status: "waiting_for_reviewer",
          reviewer_thread_id: "rev-thread-1",
        },
      ],
      canRequest: false,
    })
  );
  // The effort renders in its own chip, with the full value in the title tooltip.
  assert.match(html, /reviewer-job-effort[^>]*>high</);
  assert.match(html, /reviewer-job-effort[^>]*title="Reasoning effort: high"/);
  // Both facets show together: model AND effort.
  assert.match(html, /reviewer-job-model[^>]*>gpt-5-codex</);
});

test("ReviewerPanel omits the effort chip when the job carries no effort", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r2",
          reviewer_provider: "codex",
          reviewer_model: "gpt-5-codex",
          // no reviewer_effort (e.g. a reused thread with no recorded effort)
          status: "waiting_for_reviewer",
          reviewer_thread_id: "rev-thread-2",
        },
      ],
      canRequest: false,
    })
  );
  assert.doesNotMatch(html, /reviewer-job-effort/);
});

test("ReviewerPanel falls back to the reviewer thread id when the thread has no name; hides model when unknown", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r2",
          reviewer_provider: "codex",
          status: "waiting_for_reviewer",
          reviewer_thread_id: "rev-thread-2",
          // no reviewer_model (e.g. a reused thread that inherits its model)
        },
      ],
      reviewerThreads: [], // no name match
      canRequest: false,
    })
  );
  // No model span when the job carries no model.
  assert.doesNotMatch(html, /reviewer-job-model/);
  // The id is collapsed by default (not in the resting card)...
  assert.doesNotMatch(html, /reviewer-job-thread/);
  // ...and the info toggle falls back to the raw thread id as its tooltip value.
  assert.match(html, /reviewer-job-info[^>]*title="rev-thread-2"/);
});

test("ReviewerPanel collapses the session id behind an info toggle (hidden by default; toggle omitted when there's no session)", () => {
  // With a reviewer thread: the id line is collapsed and the info toggle stands in for it.
  const withThread = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r1",
          reviewer_provider: "codex",
          status: "waiting_for_reviewer",
          reviewer_thread_id: "rev-thread-9",
        },
      ],
      canRequest: false,
    })
  );
  // The id is NOT rendered in the resting card (collapsed by default)...
  assert.doesNotMatch(withThread, /reviewer-job-thread/);
  // ...but the reveal control is present, collapsed, and wired to the id.
  assert.match(withThread, /reviewer-job-info[^>]*title="rev-thread-9"/);
  assert.match(withThread, /reviewer-job-info[^>]*aria-expanded="false"/);
  assert.match(withThread, /aria-label="Show reviewer session id \(rev-thread-9\)"/);

  // With NO reviewer thread id there's nothing to reveal, so the toggle is omitted
  // entirely (no dangling "i" that opens an empty line).
  const noThread = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r2", reviewer_provider: "codex", status: "waiting_for_reviewer" }],
      canRequest: false,
    })
  );
  assert.doesNotMatch(noThread, /reviewer-job-info/);
  assert.doesNotMatch(noThread, /reviewer-job-thread/);
});

test("a terminal card carries a per-card Re-review launcher (prefilled, own modal id)", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r1",
          reviewer_provider: "codex",
          status: "complete",
          reviewer_thread_id: "rev-1",
        },
      ],
      reviewModel: {
        providerOptions: [{ label: "Codex", value: "codex" }],
        models: [],
        defaultProvider: "codex",
      },
      reusableReviewers: [{ reviewerThreadId: "rev-1", provider: "codex", label: "Reviewer one" }],
      canRequest: true,
      panelId: "review-panel-test",
      onRequestReview() {},
    })
  );
  // Each card gets its own "Re-review" button + a request modal namespaced by the
  // panel mount (rail vs sheet) so the two copies don't collide on a shared dialog id.
  assert.match(html, /Re-review/);
  assert.match(html, /id="review-panel-test-recard-r1"/);
  // The form is prefilled to reuse this card's reviewer thread.
  assert.match(html, /value="rev-1"/);
});

test("the per-card Re-review modal id is namespaced by the panel mount (rail vs sheet)", () => {
  // Regression guard: the reviewer panel renders in BOTH the remote rail and the
  // remote sheet, so the same job must NOT produce a shared dialog id — otherwise the
  // sheet's button opens the (hidden) rail's dialog via getElementById and looks dead
  // on mobile while working on desktop.
  const job = {
    id: "rX",
    reviewer_provider: "codex",
    status: "complete",
    reviewer_thread_id: "rev-x",
  };
  const props = {
    reviewJobs: [job],
    reviewModel: { providerOptions: [], models: [], defaultProvider: "codex" },
    reusableReviewers: [{ reviewerThreadId: "rev-x", provider: "codex", label: "X" }],
    canRequest: true,
    onRequestReview() {},
  };
  const rail = renderToStaticMarkup(h(ReviewerPanel, { ...props, panelId: "review-panel-remote-rail" }));
  const sheet = renderToStaticMarkup(h(ReviewerPanel, { ...props, panelId: "review-panel-remote-modal" }));
  assert.match(rail, /id="review-panel-remote-rail-recard-rX"/);
  assert.match(sheet, /id="review-panel-remote-modal-recard-rX"/);
  // The two mounts must not share an id.
  assert.doesNotMatch(rail, /id="review-panel-remote-modal-recard-rX"/);
});

test("an in-progress card has no Re-review launcher (only terminal cards can re-review)", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r2",
          reviewer_provider: "codex",
          status: "waiting_for_reviewer",
          reviewer_thread_id: "rev-2",
        },
      ],
      reviewModel: { providerOptions: [], models: [], defaultProvider: "codex" },
      canRequest: true,
      panelId: "review-panel-test",
      onRequestReview() {},
    })
  );
  assert.doesNotMatch(html, /Re-review/);
  assert.doesNotMatch(html, /-recard-r2"/);
});

// The request dialog leads with the working tree it will review; it is a control, not a caption.

const RESOLVED_WORKSPACE = {
  cwd: "/repo/.worktrees/feature",
  origin: { kind: "proven" },
  git: {
    cwd: "/repo/.worktrees/feature",
    is_repo: true,
    branch: "feature",
    detached: false,
    dirty: true,
  },
  roots: [
    { path: "/repo", branch: "main", is_main: true },
    { path: "/repo/.worktrees/feature", branch: "feature", is_main: false },
  ],
  birth_cwd: "/repo",
  birth_cwd_exists: true,
};

test("the review dialog names the working tree it will review, and lets you re-point it", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewModel: {
        providerOptions: [{ label: "Codex", value: "codex" }],
        models: [],
        defaultProvider: "codex",
      },
      canRequest: true,
      panelId: "review-panel-test",
      workspace: RESOLVED_WORKSPACE,
      onPinWorkspace() {},
      onRequestReview() {},
    })
  );
  assert.match(html, /Working tree to review/, "the dialog says what it is about to read");
  assert.match(html, /\/repo\/\.worktrees\/feature/, "and names it");
  assert.match(html, /feature · changes/, "with that tree's live git standing");
  assert.match(html, /workspace-picker-trigger/, "as a control, not a caption");
});

// A prefill bound to another tree would be refused; the dialog must not sit on it silently.
test("a Re-review prefill that is not on offer falls back to a clean reviewer, and says why", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r9",
          reviewer_provider: "codex",
          status: "complete",
          reviewer_thread_id: "rev-in-main",
        },
      ],
      reviewModel: {
        providerOptions: [{ label: "Codex", value: "codex" }],
        models: [],
        defaultProvider: "codex",
      },
      // Filtered upstream to the tree under review.
      reusableReviewers: [
        { reviewerThreadId: "rev-in-worktree", provider: "codex", label: "Worktree reviewer" },
      ],
      canRequest: true,
      panelId: "review-panel-test",
      workspace: RESOLVED_WORKSPACE,
      onRequestReview() {},
    })
  );
  const dialogStart = html.indexOf('id="review-panel-test-recard-r9"');
  assert.ok(dialogStart > -1, "the per-card dialog should render");
  const dialog = html.slice(dialogStart, html.indexOf("</dialog>", dialogStart));
  // The reuse select must land on a real option, not a blank that still submits the refused id.
  assert.match(
    dialog,
    /<option value="clean" selected="">/,
    "an unofferable prefill must resolve to the clean reviewer, not to no selection"
  );
  assert.doesNotMatch(dialog, /value="rev-in-main"/, "and never to the cross-tree reviewer");
  // (the apostrophe arrives HTML-escaped, so match the half that carries the meaning)
  assert.match(html, /review this working tree/, "and the dialog says why it changed");
  assert.match(html, /starts a clean one/);
});

test("ReviewerPanel renders an ask card, and says which side you are looking at", () => {
  // The panel showed its empty state with a live ask in the API, so this pins
  // the component end: given asks, a card must appear.
  const ask = {
    id: "ask-1",
    asker_thread_id: "me",
    peer_thread_id: "them",
    peer_provider: "codex",
    asker_name: "Main session",
    peer_name: "Retry work",
    message: "have a look at the retry loop",
    answer: "Fixed the backoff.",
    status: "done",
    delivered: false,
  };
  const html = renderToStaticMarkup(
    React.createElement(ReviewerPanel, {
      asks: [ask],
      parentThreadId: "me",
      onOpenThread: () => {},
    })
  );
  assert.match(html, /You asked Retry work/, "the relation is stated, not just the provider");
  assert.match(html, /have a look at the retry loop/);
  assert.match(html, /Fixed the backoff\./);

  // …and from the other side it reads the other way round.
  const mirrored = renderToStaticMarkup(
    React.createElement(ReviewerPanel, {
      asks: [ask],
      parentThreadId: "them",
    })
  );
  assert.match(mirrored, /Main session asked you/);
});
