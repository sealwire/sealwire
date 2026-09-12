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

test("the review slot leads with its lifecycle, and keeps Stop/Delete out of the resting card", () => {
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        { id: "r1", reviewer_provider: "claude_code", status: "complete", reviewer_thread_id: "t-rev" },
      ],
      canRequest: false,
      onDeleteReview() {},
    })
  );
  assert.match(html, /reviewer-ledger-label[^>]*>Review</);
  assert.match(html, /Claude/, "the reviewer is named on the heading, not inside the card");
  assert.match(html, /Review complete/);
  // Both destructive/rare actions live behind the ··· menu now, so neither is in the
  // resting markup; what stands in for them is the menu trigger.
  assert.doesNotMatch(html, />Delete</);
  assert.match(html, /reviewer-menu-button/);
});

test("a blocked review says so in the card's headline, in the alert tone", () => {
  // Blocked is the one state the user MUST act on, so it outranks the verdict and is
  // the only thing in the panel that earns colour.
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r3", reviewer_provider: "codex", status: "blocked" }],
      canRequest: false,
      onResolveReview() {},
    })
  );
  assert.match(html, /reviewer-tone-alert/);
  assert.match(html, /Review blocked — action needed/);
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

test("WorkspaceDiffModalTitle follows the active tab (so opening Agents isn't titled 'Workspace diff')", () => {
  const changes = renderToStaticMarkup(
    h(WorkspaceDiffModalTitle, { store: makeStore({ activeTab: "changes" }) })
  );
  assert.match(changes, /Workspace diff/);
  assert.doesNotMatch(changes, /Agents/);

  const reviewer = renderToStaticMarkup(
    h(WorkspaceDiffModalTitle, { store: makeStore({ activeTab: "reviewer" }) })
  );
  assert.match(reviewer, /Agents/);
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

test("the review heading carries the iterative round, and the card headlines the verdict", () => {
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
  assert.match(html, /round 1\/3 · Codex/, "the loop's own round beats the attempt count");
  // The verdict is the headline, phrased as the decision it implies rather than as the
  // enum — "needs_changes" is not what a user wants to read off a merge gate.
  assert.match(html, /Needs changes · won&#x27;t merge yet/);
  assert.match(html, /reviewer-tone-alert/);
});

test("a single-shot review counts attempts instead, and an unknown verdict is not surfaced", () => {
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
  assert.match(html, /round 1 · Codex/);
  assert.doesNotMatch(html, /round 1\/1/);
  assert.match(html, /Review complete/, "with no verdict, the lifecycle is the headline");
  assert.doesNotMatch(html, /unknown/);
});

test("the reviewer's model rides the heading; effort survives on its tooltip", () => {
  // The identity band inside the card is gone — the agent is named by the heading now —
  // so both facts have to land there, and the row truncates, so effort goes to the title.
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
  assert.match(html, /reviewer-ledger-meta[^>]*>round 1 · Codex · gpt-5-codex</);
  assert.match(html, /title="round 1 · Codex · gpt-5-codex · effort high"/);
});

test("no bare session id is shown for a review — only a short sha, and only a real one", () => {
  const withSha = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        {
          id: "r1",
          reviewer_provider: "codex",
          status: "complete",
          reviewer_thread_id: "rev-thread-9",
          verdict_candidate_sha: "2011c6939ab4f00c",
        },
      ],
      canRequest: false,
      onOpenThread() {},
    })
  );
  assert.match(withSha, /reviewer-sha[^>]*>2011c69</);
  assert.doesNotMatch(withSha, /2011c6939ab4/, "the full sha never renders");
  assert.doesNotMatch(withSha, /rev-thread-9</, "nor does the reviewer's session id");
  // What the id was FOR is now a named action instead.
  assert.match(withSha, /Open review/);

  // No sha on the wire → no trailing slot at all, rather than a placeholder.
  const noSha = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [{ id: "r2", reviewer_provider: "codex", status: "waiting_for_reviewer" }],
      canRequest: false,
    })
  );
  assert.doesNotMatch(noSha, /reviewer-sha/);
  assert.doesNotMatch(noSha, /Open review/, "and nothing to open without a reviewer session");
});

test("earlier review attempts collapse to one line each instead of repeating as cards", () => {
  // The panel used to give a failed round its own full card restating the same error.
  const html = renderToStaticMarkup(
    h(ReviewerPanel, {
      reviewJobs: [
        { id: "r1", reviewer_provider: "codex", status: "complete", verdict: "approve", updated_at: 100 },
        { id: "r2", reviewer_provider: "codex", status: "failed", error: "nothing committed to review", updated_at: 200 },
        { id: "r3", reviewer_provider: "codex", status: "blocked", updated_at: 300 },
      ],
      canRequest: false,
    })
  );
  assert.equal(html.match(/reviewer-review-banner-text/g).length, 1, "one card, not three");
  assert.match(html, /reviewer-round-label[^>]*>R2<[\s\S]*nothing committed to review/);
  assert.match(html, /reviewer-round-label[^>]*>R1<[\s\S]*Review complete · approve/);
  assert.match(html, /reviewer-ledger-meta[^>]*>round 3 · Codex</, "and the heading counts them");
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

test("an ask renders under its agent's heading, titled by intent rather than by subject", () => {
  // The panel showed its empty state with a live ask in the API, so this pins
  // the component end: given asks, a card must appear.
  const ask = {
    id: "ask-1",
    asker_thread_id: "me",
    peer_thread_id: "them",
    peer_provider: "codex",
    peer_model: "gpt-5-codex",
    asker_name: "Main session",
    peer_name: "Retry work",
    message: "have a look at the retry loop\n\n(hundreds of words of context follow)",
    answer: "Fixed the backoff.",
    status: "done",
    delivered: true,
    updated_at: 10,
  };
  const html = renderToStaticMarkup(
    React.createElement(ReviewerPanel, {
      asks: [ask],
      parentThreadId: "me",
      onOpenThread: () => {},
    })
  );
  assert.match(html, /reviewer-agent-name[^>]*>Codex</, "the agent is the GROUP heading");
  assert.match(html, /reviewer-agent-model[^>]*>gpt-5-codex</);
  assert.match(html, /Asked<[\s\S]*1 thread</);
  // The card carries the intent and the result — never "You asked codex", and never the
  // raw prompt, which only survives on the tooltip.
  assert.doesNotMatch(html, /You asked/);
  assert.match(html, /reviewer-card-title[^>]*>have a look at the retry loop</);
  assert.match(html, /hundreds of words of context follow/, "…on the title attribute");
  assert.match(html, /reviewer-card-result[^>]*>Fixed the backoff\.</);
  assert.match(html, /reviewer-ask-state is-answered/);

  // …and from the other side the direction is a tag, not a rewritten title.
  const mirrored = renderToStaticMarkup(
    React.createElement(ReviewerPanel, {
      asks: [ask],
      parentThreadId: "them",
    })
  );
  assert.match(mirrored, /reviewer-agent-name[^>]*>Main session</);
  assert.match(mirrored, /reviewer-ask-inbound[^>]*>asked you</);
});

test("an answer that has not been handed back does not read as answered", () => {
  const html = renderToStaticMarkup(
    React.createElement(ReviewerPanel, {
      asks: [
        {
          id: "ask-2",
          asker_thread_id: "me",
          peer_thread_id: "them",
          peer_provider: "codex",
          message: "check the retry loop",
          answer: "done",
          status: "done",
          delivered: false,
          updated_at: 10,
        },
      ],
      parentThreadId: "me",
    })
  );
  assert.match(html, /reviewer-ask-state is-not-handed-back/);
  assert.match(html, />not handed back</);
});

test("follow-ups to one agent session collapse into that thread's rounds", () => {
  const base = {
    asker_thread_id: "me",
    peer_thread_id: "them",
    peer_provider: "codex",
    status: "done",
    delivered: true,
  };
  const html = renderToStaticMarkup(
    React.createElement(ReviewerPanel, {
      asks: [
        { ...base, id: "a1", message: "where should /goal live", answer: "In the JSON state file.", updated_at: 100 },
        { ...base, id: "a2", message: "and what about archive", answer: "Same record, new field.", updated_at: 200 },
      ],
      parentThreadId: "me",
    })
  );
  assert.equal(html.match(/reviewer-card-title/g).length, 1, "one card for one subject");
  assert.match(html, /reviewer-card-title[^>]*>and what about archive</);
  assert.match(html, /reviewer-round-label[^>]*>R1<[\s\S]*In the JSON state file\./);
  assert.match(html, /1 thread</, "counted as one thread, not two asks");
});
