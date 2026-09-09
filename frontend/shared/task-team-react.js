// The Task screen: full-area view of team runs, laid out like mockup 12b —
// list in the app sidebar, task detail in the middle, Orchestrator on the right.
//
// Presentational only. Every piece of data is a prop and every mutation is a
// callback; fetching, caching and navigation live in the caller. Mirrors the
// shape of `project-overview-react.js`, which is the other full-area view.

import React from "react";

import { composerButtonState } from "./thread-compose.js";
import { formatAttachmentBytes } from "./attachment-size.js";
import { ConversationComposer } from "./composer.js";
import { AgentWorkingIndicator } from "./conversation.js";
import { createVerbCycler, progressPhaseLabel, VERB_CYCLE_MS } from "../progress-verbs.js";
// The remote pair, not `app.js`'s private copies: these take an injectable
// clock, which is the only reason a scheduled card is testable at a fixed hour.
import { formatRelativeTime, formatTimestamp } from "../remote/utils.js";
import { ToggleLeftPanelIcon } from "./panel-icons.js";
import { TaskBoard } from "./task-board-react.js";
import { bindTaskWorkspaceResizeHandle } from "./task-workspace-resize.js";
import { TranscriptPane } from "./transcript-pane.js";
import {
  availableTeamActions,
  canTalkToTeamLead,
  currentSubTask,
  groupTeamRuns,
  isTeamRunDeletable,
  isTerminalSubTaskStatus,
  isTerminalTeamStatus,
  teamAttention,
  teamListMeta,
  teamPhaseLabel,
  teamRunIsWorking,
  teamRunProgress,
  teamSeats,
  teamStatusLabel,
  teamStatusTone,
  TEAM_ACTION_HINTS,
  TEAM_ACTION_LABELS,
  TEAM_LIST_GROUPS,
} from "./task-team-model.js";

const h = React.createElement;
const { useEffect, useState } = React;

function BranchGlyph() {
  return h(
    "svg",
    { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M5 3.5v9M5 3.5a1.5 1.5 0 1 0 0-.001zM5 12.5a1.5 1.5 0 1 0 0 .001zM11 6.5a1.5 1.5 0 1 0 0-.001zM11 8v.5A3.5 3.5 0 0 1 7.5 12H5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

function BackGlyph() {
  return h(
    "svg",
    { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: "M10 3.5 5.5 8l4.5 4.5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    })
  );
}

function StatusPill({ status }) {
  const tone = teamStatusTone(status);
  return h(
    "span",
    {
      className: `task-status-pill${tone ? ` is-${tone}` : ""}`,
      title: teamStatusLabel(status),
    },
    teamStatusLabel(status)
  );
}

// ---- the beta lock ---------------------------------------------------------

/**
 * Sessions put this control in the chat header when the sidebar collapses.
 * Tasks hides that header, so the twin lives on the Tasks surface — both the
 * Orchestrator pane and the locked preview, which never mounts the pane.
 * CSS shows it only while `body.sidebar-collapsed` is set on the tasks view.
 */
function TasksSidebarToggle() {
  return h(
    "button",
    {
      type: "button",
      id: "tasks-sidebar-toggle",
      className: "header-button header-panel-toggle tasks-sidebar-toggle",
      title: "Show navigation panel (\u2318B)",
      "aria-label": "Show navigation panel",
    },
    h(ToggleLeftPanelIcon)
  );
}

/**
 * What the Task screen looks like on a relay without `--beta`.
 *
 * The skeleton is invented — no datum here comes from the relay, and the caller
 * never fetches while locked. Blur is one devtools click from gone, so the gate
 * is that the data was never sent. `aria-hidden` keeps a screen reader from
 * reading the fake titles out as the user's own.
 */
function TaskLockedPreview() {
  // Enough rows to run past the card's edges; a skeleton hidden entirely behind
  // it reads as an empty screen.
  const rows = [
    { title: "Rework the export pipeline", meta: "4/7 sub-tasks", tone: "running" },
    { title: "Tighten the retry budget", meta: "Needs you", tone: "blocked" },
    { title: "Split the settings drawer", meta: "Reviewing", tone: "running" },
    { title: "Backfill the migration tests", meta: "6/6 sub-tasks", tone: "done" },
    { title: "Trim the cold-start path", meta: "Planning", tone: "running" },
    { title: "Retire the legacy uploader", meta: "2/9 sub-tasks", tone: "running" },
  ];
  return h(
    "div",
    { className: "task-screen task-screen-centered task-locked" },
    h("header", { className: "task-locked-chrome" }, h(TasksSidebarToggle)),
    h(
      "div",
      { className: "task-locked-scenery", "aria-hidden": "true" },
      h(
        "div",
        { className: "task-locked-rows" },
        ...rows.map((row, index) =>
          h(
            "div",
            { key: index, className: "task-locked-row" },
            h("span", { className: `task-sidebar-dot is-${row.tone}` }),
            h(
              "span",
              { className: "task-locked-row-body" },
              h("span", { className: "task-locked-row-title" }, row.title),
              h("span", { className: "task-locked-row-meta" }, row.meta)
            )
          )
        )
      )
    ),
    h(
      "div",
      { className: "task-locked-notice", role: "status" },
      h("h2", { className: "task-locked-title" }, "Tasks is in development"),
      h(
        "p",
        { className: "task-locked-lede" },
        "A task will be a written brief worked by a small team of agents, on its own branch, while you do something else. It is not finished yet, so it is switched off here."
      )
    )
  );
}

// ---- list ------------------------------------------------------------------

/**
 * Empty centre while no Orchestrator thread exists yet (M4).
 *
 * Mockup 12b puts the secretary chat here; until that thread exists this space
 * still has one job: tell someone what a task is, and how to start one, without
 * duplicating the sidebar list.
 */
export function TaskWelcome({ runs, loading, error, onStartTask, orchReady = false }) {
  if (error && !runs) {
    return h(
      "div",
      { className: "task-orch-body task-screen-centered" },
      h(
        "div",
        { className: "task-screen-empty" },
        h("h3", null, "Tasks unavailable"),
        h("p", null, String(error))
      )
    );
  }
  if (loading && !runs) {
    return h(
      "div",
      { className: "task-orch-body task-screen-centered" },
      h("div", { className: "task-screen-empty" }, h("p", null, "Loading tasks…"))
    );
  }

  const hasTasks = Boolean(runs?.length);
  return h(
    "div",
    { className: "task-orch-body task-welcome" },
    h("h2", { className: "task-welcome-title" }, hasTasks || orchReady ? "Ask the Orchestrator" : "Start a task"),
    h(
      "p",
      { className: "task-welcome-lede" },
      orchReady
        ? "Describe a task, ask about one on the left, or use New task for the brief form. The Orchestrator proposes before it starts anything."
        : hasTasks
          ? "Pick a task on the left, or describe a new one once the Orchestrator is available. Until then, New task still opens the brief."
          : "A task is a written brief worked by a three-role team, in its own git worktree on its own branch. Nothing touches your working tree until you merge it."
    ),
    hasTasks || orchReady
      ? null
      : h(
          "ol",
          { className: "task-welcome-steps" },
          h(
            "li",
            null,
            h("b", null, "Team lead"),
            " reads the brief, judges the size, and splits it into sub-tasks."
          ),
          h("li", null, h("b", null, "Developer"), " builds one sub-task, with a fresh session each time."),
          h("li", null, h("b", null, "Reviewer"), " checks the work against your scope and rules."),
          h("li", null, "You get a branch, commits and a report — and a question if the team needs one.")
        ),
    h(
      "button",
      { type: "button", className: "task-screen-start", onClick: () => onStartTask?.() },
      "New task"
    )
  );
}

/**
 * Centre column of the 12b Tasks layout: the Orchestrator chat.
 *
 * The transcript is the existing `TranscriptPane` at a new mount — not a second
 * chat stack. Attention cards (parked questions) sit above the transcript when
 * a selected run needs the user; the composer always targets the Orchestrator
 * thread, never the selected run's seats.
 */
export function OrchestratorPane({
  // The thread whose questions this pane may answer. Its own — the Orchestrator
  // is a conversation like any other, and the session's questions belong to the
  // session's composer.
  runs,
  selectedRun = null,
  seenAt = {},
  loading = false,
  error = null,
  waitingCount = 0,
  onStartTask,
  onOpenThread,
  transcriptEntries = null,
  transcriptLoading = false,
  onTranscriptInteract = null,
  transcriptOptions = null,
  // Whether this DEVICE may write, which is not the same question as whether
  // the composer is currently usable. Conflating them made a pane that was
  // merely still opening announce that another device had control.
  canWrite = true,
  approval = null,
  composerDisabled = false,
  composerBusy = false,
  composerError = null,
  proposals = [],
  onSend = null,
  onPropose = null,
  onConfirmProposal = null,
  onDismissProposal = null,
  onToggleProposalAutoStart = null,
  // Injectable clock: a scheduled card renders a countdown, and a test that
  // read the real one could not assert what it says.
  nowSeconds = null,
  onReset = null,
  resetBusy = false,
  attachments = [],
  onPasteImages = null,
  onRemoveAttachment = null,
  // { phase, tool, stalled } for the Orchestrator's own thread. The caller
  // resolves which snapshot field holds it (see threadActivityFor).
  activity = null,
  onStop = null,
  enterSubmits = undefined,
}) {
  const attention = selectedRun ? teamAttention(selectedRun, seenAt) : null;
  const showAttention = selectedRun && attention?.kind === "needs_input";
  const hasTranscript = Array.isArray(transcriptEntries);
  const emptyTranscript = hasTranscript && transcriptEntries.length === 0;
  const pendingProposals = Array.isArray(proposals) ? proposals.filter(Boolean) : [];

  let body;
  if (showAttention) {
    body = h(OrchestratorAttentionCard, {
      run: selectedRun,
      attention,
      onOpenThread,
    });
    // `|| transcriptLoading`: a refetch of an existing conversation arrives with
    // entries still null, and without this the pane fell through to the
    // first-run welcome -- so every re-open of Tasks flashed "Start a task" at
    // someone who already had a conversation.
  } else if (hasTranscript || transcriptLoading) {
    body = h(
      "div",
      {
        // `chat-thread` is the CONTRACT, not a style: it is how the shared
        // stick-to-bottom follower, the scroll-to-latest button and the
        // transcript virtualizer all find "the overflow:auto element that owns
        // transcript scrolling". Without it the follower's layout effect bailed
        // and the reply scrolled out of view while it streamed. The class
        // carries no CSS here — every `.chat-thread` rule is scoped under
        // `.chat-shell[data-view="conversation"]`, and this pane is "tasks".
        className: "task-orch-transcript chat-thread",
        "aria-label": "Orchestrator conversation",
      },
      // The first-run welcome leads with a New task button. Offering that to a
      // device that cannot write is worse than saying why, so a locked-out
      // device falls through to the ready/waiting state instead.
      emptyTranscript && !transcriptLoading && canWrite
        ? h(TaskWelcome, { runs, loading, error, onStartTask, orchReady: true })
        : h(TranscriptPane, {
            // Never null: ConversationPanel reads `entries.length`, and the
            // loading branch above deliberately gets here before the first page.
            entries: transcriptEntries || [],
            hydrationLoading: transcriptLoading,
            // The renderer emits Copy, fork, tool toggles and file-change
            // actions here exactly as it does in the conversation. Without a
            // handler they render and do nothing, which is worse than not
            // rendering them — see shared/transcript-interactions.js.
            onTranscriptInteract,
            // Same bundle the conversation passes. Omitting it did not degrade
            // gracefully: it left tool cards permanently un-expandable, agent
            // messages unattributed, and -- worst -- a live AskUserQuestion
            // rendered as the read-only "Answered" card, so a blocked
            // Orchestrator looked merely finished.
            transcriptOptions,
            approval,
            canWrite,
            // Withheld while loading. ConversationPanel checks `readyState`
            // BEFORE it reaches the skeleton, so leaving it set means
            // `hydrationLoading` can never render anything and an empty pane
            // claims to be ready before its history has arrived.
            readyState: transcriptLoading ? null : {
              // Titles too, not only the copy: the defaults are "Session ready"
              // and "Session active on another device", and this pane is not a
              // session.
              readyTitle: "Ask the Orchestrator",
              readyCopy:
                "Ask about a task, or describe a new one. The Orchestrator will propose before it starts anything.",
              waitingTitle: "Another device has control",
              waitingCopy: "The Orchestrator is open, but another device has control.",
            },
          })
    );
  } else if (selectedRun) {
    body = h(
      "div",
      { className: "task-orch-body" },
      h("h2", { className: "task-welcome-title" }, selectedRun.title || "Untitled task"),
      h(
        "p",
        { className: "task-welcome-lede" },
        `${teamStatusLabel(selectedRun.status)}. The seats and branch are on the left.`
      )
    );
  } else {
    body = h(TaskWelcome, { runs, loading, error, onStartTask });
  }

  return h(
    "section",
    { className: "task-orch", "aria-label": "Orchestrator" },
    h(
      "header",
      { className: "task-orch-header" },
      h(TasksSidebarToggle),
      h("div", { className: "task-orch-brand" }, h("span", { className: "task-orch-mark" }, "S"), "Orchestrator"),
      waitingCount > 0
        ? h("span", { className: "task-orch-waiting" }, `${waitingCount} waiting on you`)
        : h("span", { className: "task-orch-waiting is-quiet" }, "Nothing waiting"),
      // The way out when the secretary is wedged: its provider session can die
      // (a restart drops cursor's) while the thread still resolves, so nothing
      // self-heals and every turn answers the same error. No confirm step —
      // the old conversation is kept, only the pin moves.
      onReset
        ? h(
            "button",
            {
              type: "button",
              className: "task-orch-refresh",
              title: "Start a new Orchestrator conversation. The old one is kept.",
              "aria-label": "Restart the Orchestrator",
              disabled: resetBusy,
              onClick: onReset,
            },
            resetBusy ? "…" : "\u21bb"
          )
        : null
    ),
    pendingProposals.length
      ? h(
          "div",
          { className: "task-orch-proposals", "aria-label": "Pending proposals" },
          ...pendingProposals.map((proposal) =>
            h(OrchestratorProposalCard, {
              key: proposal.id,
              proposal,
              busy: composerBusy,
              onConfirm: onConfirmProposal,
              onDismiss: onDismissProposal,
              onToggleAutoStart: onToggleProposalAutoStart,
              nowSeconds,
            })
          )
        )
      : null,
    body,
    // Between the transcript and the composer, exactly where the session
    // conversation puts it.
    h(OrchestratorWorkingIndicator, { activity }),
    h(OrchestratorComposer, {
      // `canWrite` too, not only for the transcript's copy: announcing that
      // another device has control above a live textarea whose Send silently
      // takes it back is the announcement disagreeing with the affordance.
      disabled: composerDisabled || !onSend || !canWrite,
      busy: composerBusy,
      threadWorking: Boolean(activity?.phase),
      onStop,
      enterSubmits,
      error: composerError,
      onSend,
      onPropose,
      attachments,
      onPasteImages,
      onRemoveAttachment,
    })
  );
}

/**
 * "Bashing…" — the same pill, from the same parts, as the session conversation.
 *
 * Not a copy of the label logic: `progressPhaseLabel` and `AgentWorkingIndicator`
 * are the shared ones, so a new phase or a nicer verb lands in both places at
 * once. What is local is the verb cycler's timer, because the session surfaces
 * drive theirs imperatively (app.js `syncVerbTimer`) and this pane is React.
 *
 * The verb only ever fills in for non-tool phases — a tool call names itself,
 * and "Cogitating…" over a running `Bash` would be less informative, not more.
 */
function OrchestratorWorkingIndicator({ activity }) {
  const phase = activity?.phase || null;
  const tool = activity?.tool || null;
  const stalled = Boolean(activity?.stalled);
  const [verb, setVerb] = useState(null);

  // Keyed on WHETHER there is a phase, not on which one — the same rule
  // `syncVerbTimer` uses on the session surfaces, which tear the timer down only
  // when the phase clears. Keyed on the phase itself, a thinking -> streaming
  // transition restarted the rotation mid-turn here and not there.
  const working = Boolean(phase);
  useEffect(() => {
    if (!working) {
      setVerb(null);
      return undefined;
    }
    const cycler = createVerbCycler();
    setVerb(cycler.next());
    const timer = setInterval(() => setVerb(cycler.next()), VERB_CYCLE_MS);
    return () => clearInterval(timer);
  }, [working]);

  const label = stalled ? "Stalled?" : progressPhaseLabel(phase, tool, verb ?? undefined);
  if (!label) {
    return null;
  }
  return h(AgentWorkingIndicator, {
    model: { hidden: false, label, tone: stalled ? "alert" : "ready" },
  });
}

// The seats, in pipeline order, with the label the card shows for each.
const PROPOSAL_SEATS = [
  ["tl", "Planner"],
  ["dev", "Implementer"],
  ["reviewer", "Reviewer"],
];

const PAIR_PROPOSAL_SEATS = [
  ["dev", "Pair programmer"],
  ["reviewer", "Reviewer"],
];

// "codex \u00b7 gpt-5.6-codex \u00b7 max", skipping whatever was not chosen.
// An empty seat renders nothing at all rather than the word "default": the
// relay's default can move, and naming it here would claim a guarantee the
// proposal does not carry.
function seatAgentLabel(agent) {
  if (!agent) return "";
  return [agent.provider, agent.model, agent.effort].filter(Boolean).join(" \u00b7 ");
}

// Confirming a proposal authorises whatever agent it names — a different
// provider, a pricier model, `max` effort on every seat. Showing only the title
// asked the user to approve spend they could not see, so any seat that names
// something is listed here before the Start button.
/// Which parts of the task definition this card rewrites, in the order the
/// brief reads. Names match the labels the team sees, not the wire keys.
const SPEC_FIELD_LABELS = [
  ["title", "title"],
  ["context", "context"],
  ["acceptance_criteria", "acceptance criteria"],
  ["agreed_scope", "agreed scope"],
  ["quality_rules", "quality rules"],
];

function rewrittenFields(proposal) {
  const updates = proposal?.spec_updates;
  if (!updates) return [];
  return SPEC_FIELD_LABELS.filter(([key]) => typeof updates[key] === "string").map(
    ([, label]) => label
  );
}

function proposalAgentRows(proposal) {
  const structured = Array.isArray(proposal?.agent_rows) ? proposal.agent_rows : [];
  if (structured.length > 0) {
    return structured
      .map((row) => [
        row.role_id || row.label,
        row.label || row.role_id || "Agent",
        seatAgentLabel(row.agent),
      ])
      .filter(([, , value]) => value);
  }

  const seats = proposal?.team_id === "pair" ? PAIR_PROPOSAL_SEATS : PROPOSAL_SEATS;
  return seats
    .map(([seat, label]) => [label, label, seatAgentLabel(proposal?.agents?.[seat])])
    .filter(([, , value]) => value);
}

function ProposalAgentSummary({ proposal }) {
  const rows = proposalAgentRows(proposal);
  if (rows.length === 0) return null;
  return h(
    "ul",
    { className: "task-orch-proposal-agents" },
    rows.map(([key, label, value]) =>
      h(
        "li",
        { key, className: "task-orch-proposal-agent" },
        h("span", { className: "task-orch-proposal-agent-seat" }, `${label}:`),
        " ",
        h("span", { className: "task-orch-proposal-agent-value" }, value),
      ),
    ),
  );
}

/**
 * How long until `startsAt`, or `null` once it has arrived.
 *
 * `formatRelativeTime` measures how long ago its first argument was, so the
 * pair is swapped to measure forward. Its floor is the word "now", which is
 * right for the past and lands as "in now" here — hence the explicit boundary
 * at the minute, exactly where its own minute count takes over.
 */
function timeUntil(startsAt, now) {
  const secondsAway = startsAt - now;
  if (secondsAway <= 0) {
    return null;
  }
  return secondsAway < 60 ? "under a minute" : formatRelativeTime(now, startsAt);
}

/**
 * What this card's schedule actually promises, as one sentence.
 *
 * A timestamp on its own is ambiguous: the same "09:00" is a machine starting
 * work unattended or a note beside a button someone still has to press.
 * `auto_start` is the whole difference, so the two never share a sentence.
 */
function scheduleSentence(proposal, nowSeconds) {
  const startsAt = Number(proposal?.scheduled_start_at) || 0;
  const armed = Boolean(proposal?.auto_start);
  if (!startsAt) {
    // Reachable: the tool may stage `auto_start` with no `start_in_minutes`.
    // Nothing fires without a time, so the card must not imply it will.
    return armed ? "No start time, so it will not start on its own." : null;
  }
  const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  const stamp = formatTimestamp(startsAt);
  const away = timeUntil(startsAt, now);
  if (armed) {
    return away
      ? `Starts on its own in ${away}, on ${stamp}.`
      : `Starts on its own — due now, ${stamp}.`;
  }
  return away
    ? `Planned for ${stamp}, in ${away}. Waiting for you to press Start task.`
    : `Planned for ${stamp}. Waiting for you to press Start task.`;
}

function OrchestratorProposalCard({
  proposal,
  busy = false,
  onConfirm = null,
  onDismiss = null,
  onToggleAutoStart = null,
  nowSeconds = null,
}) {
  const armed = Boolean(proposal.auto_start);
  const schedule = scheduleSentence(proposal, nowSeconds);
  return h(
    "div",
    { className: "task-orch-card task-orch-proposal" },
    h(
      "div",
      { className: "task-orch-card-head" },
      h(
        "span",
        { className: "task-orch-card-tag" },
        proposal.kind === "reopen_task" ? "Reopen task" : "Propose task"
      ),
      // A reopen names no team: it puts the task back on the one it already ran
      // with. Falling back to "Default" would claim a choice nobody made.
      h(
        "span",
        { className: "task-orch-card-state" },
        proposal.kind === "reopen_task"
          ? "continues on its own branch"
          : proposal.team_name || "Default"
      )
    ),
    h("h3", { className: "task-orch-card-title" }, proposal.title || "Untitled task"),
    proposal.why
      ? h("p", { className: "task-orch-card-body" }, proposal.why)
      : proposal.context
        ? h("p", { className: "task-orch-card-body" }, proposal.context)
        : null,
    // A reopen may rewrite the brief the reviewer grades against. Confirm is
    // the only gate on that, so say which fields move before it is pressed.
    rewrittenFields(proposal).length
      ? h(
          "p",
          { className: "task-orch-card-note" },
          `Rewrites the ${rewrittenFields(proposal).join(", ")} for this run.`
        )
      : null,
    h(ProposalAgentSummary, { proposal }),
    schedule ? h("p", { className: "task-orch-card-note task-orch-card-schedule" }, schedule) : null,
    h(
      "div",
      { className: "task-orch-proposal-actions" },
      h(
        "button",
        {
          type: "button",
          className: "task-orch-card-action",
          disabled: busy || !onConfirm,
          onClick: () => onConfirm?.(proposal.id),
        },
        "Start task"
      ),
      // Quiet even when armed: solid is what "Start task" uses, and two accent
      // buttons side by side would argue about which one starts the work. The
      // tick carries the state, as it does for `ask-user-option`.
      h(
        "button",
        {
          type: "button",
          className: "task-orch-card-action is-quiet task-orch-card-autostart",
          "aria-pressed": armed,
          disabled: busy || !onToggleAutoStart,
          onClick: () => onToggleAutoStart?.(proposal.id, !armed),
        },
        armed ? h("span", { "aria-hidden": "true" }, "✓ ") : null,
        "Start automatically"
      ),
      h(
        "button",
        {
          type: "button",
          className: "task-orch-card-action is-quiet",
          disabled: busy || !onDismiss,
          onClick: () => onDismiss?.(proposal.id),
        },
        "Dismiss"
      )
    )
  );
}


function OrchestratorComposer({
  disabled = false,
  busy = false,
  error = null,
  // Is the Orchestrator's thread running a turn right now (as opposed to "is a
  // send in flight from this composer")? Only the second was ever tracked, so
  // Send stayed live mid-turn and there was no way to interrupt.
  threadWorking = false,
  onStop = null,
  enterSubmits = undefined,
  onSend = null,
  onPropose = null,
  attachments = [],
  onPasteImages = null,
  onRemoveAttachment = null,
}) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const pending = Array.isArray(attachments) ? attachments : [];
  // A screenshot with no words is a message: "look at this". Requiring text
  // alongside it would make the common case the awkward one.
  const canSubmit =
    Boolean(onSend) && !disabled && !busy && (trimmed.length > 0 || pending.length > 0);
  const canPropose = Boolean(onPropose) && !disabled && !busy && trimmed.length > 0;
  // The shared rule: "Send hides exactly when Stop shows -- the two buttons
  // never coexist." Re-deriving that here is how the two composers would drift.
  const buttons = composerButtonState({
    composerReady: canSubmit,
    turnRunning: threadWorking,
    threadWorking: threadWorking && Boolean(onStop),
    activeThreadFrozen: false,
    canWrite: true,
    viewOnly: false,
    submitInFlight: busy,
  });

  function submit(event) {
    event?.preventDefault?.();
    if (!canSubmit) {
      return;
    }
    const text = trimmed;
    setDraft("");
    void onSend(text);
  }

  function propose(event) {
    event?.preventDefault?.();
    if (!canPropose) {
      return;
    }
    const text = trimmed;
    setDraft("");
    void onPropose(text);
  }

  return h(
    "footer",
    { className: "task-orch-composer" },
    h(
      "div",
      { className: "task-orch-chips" },
      h(
        "button",
        {
          type: "button",
          className: `task-orch-chip${canPropose ? "" : " is-disabled"}`,
          disabled: !canPropose,
          onClick: propose,
        },
        "Propose as task"
      ),
      h("span", { className: "task-orch-chip is-disabled" }, "How much today?")
    ),
    h(
      "form",
      {
        className: "task-orch-form",
        onSubmit: submit,
      },
      // The SAME composer the session conversation uses. Written standalone
      // once, this had none of the keyboard policy the shared one had already
      // settled — most visibly IME: pressing Enter to pick a Chinese candidate
      // sent the half-typed pinyin, because a hand-rolled `key === "Enter"`
      // cannot know a composition is in flight. Rebuilding on it is how that
      // stays fixed in one place instead of two.
      //
      // Two slots stay deliberately empty. `models: []` renders no picker: the
      // Orchestrator's model is settled when its thread is created and there is
      // nothing here that could change it, so a picker would be a control that
      // lies. `actionsBeforeSend` is null where the session composer mounts its
      // settings gear, for the same reason — approval policy and sandbox are
      // fixed for this thread.
      h(ConversationComposer, {
        composerDisabled: disabled,
        currentDraft: draft,
        // Distinct from the session composer's ids: on the local surface both
        // composers live in one document.
        messageId: "task-orch-input",
        sendButtonId: "task-orch-send",
        messagePlaceholder: disabled
          ? "Opening the Orchestrator…"
          : "Message the Orchestrator. To stage a task, use Propose (first line = title)…",
        models: [],
        actionsBeforeSend: null,
        attachmentArea: orchestratorAttachments({ pending, busy, onRemoveAttachment }),
        errorMessage: error || "",
        onDraftChange: setDraft,
        onPaste: onPasteImages
          ? (event) => {
              if (onPasteImages(event.clipboardData)) {
                event.preventDefault();
              }
            }
          : null,
        rows: 2,
        sendDisabled: buttons.sendDisabled || !canSubmit,
        sendPending: busy,
        stopVisible: !buttons.stopHidden,
        stopPending: false,
        stopButtonId: "task-orch-stop",
        onStop: onStop || null,
        // Pinned, exactly as local/react-shell.js pins it for the conversation.
        // Left to the environment default, the two composers in this one
        // document could disagree about what Enter does.
        enterSubmits: enterSubmits === undefined ? true : enterSubmits,
      })
    )
  );
}

/** The attached-image strip, as the shared composer's attachment slot. */
function orchestratorAttachments({ pending, busy, onRemoveAttachment }) {
  return pending.length
      ? h(
          "ul",
          { className: "task-orch-attachments", "aria-label": "Attached images" },
          ...pending.map((attachment) =>
            h(
              "li",
              { key: attachment.id, className: "task-orch-attachment" },
              h(
                "span",
                { className: "task-orch-attachment-name" },
                attachment.size == null
                  ? attachment.name || "Image"
                  // The size was plumbed all the way here and then never shown,
                  // so the same paste produced a different chip in each of this
                  // document's two composers. Same formatter as the other one.
                  : `${attachment.name || "Image"} · ${formatAttachmentBytes(attachment.size)}`
              ),
              onRemoveAttachment
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "task-orch-attachment-remove",
                      "aria-label": `Remove ${attachment.name || "image"}`,
                      disabled: busy,
                      onClick: () => onRemoveAttachment(attachment.id),
                    },
                    "\u00d7"
                  )
                : null
            )
          )
        )
      : null;
}


function OrchestratorAttentionCard({ run, attention, onOpenThread }) {
  const [tag, state] = {
    question: ["Needs you", "Paused for a decision"],
    blocked: ["Needs you", "Paused for a decision"],
    escalated: ["Finished", "Ran out of rounds"],
    failed: ["Finished", "Task stopped"],
  }[attention.reason];
  return h(
    "div",
    { className: "task-orch-card" },
    h(
      "div",
      { className: "task-orch-card-head" },
      h("span", { className: "task-orch-card-tag" }, tag),
      h("span", { className: "task-orch-card-state" }, state)
    ),
    h("h3", { className: "task-orch-card-title" }, run.title || "Untitled task"),
    h("p", { className: "task-orch-card-body" }, attention.text),
    attention.reason === "question" && run.awaiting?.thread_id
      ? h(
          "button",
          {
            type: "button",
            className: "task-orch-card-action",
            onClick: () => onOpenThread?.(run.awaiting.thread_id),
          },
          "Answer it"
        )
      : null,
    h(
      "p",
      { className: "task-orch-card-meta" },
      [teamPhaseLabel(run.phase), run.branch].filter(Boolean).join(" · ")
    )
  );
}

// ---- the sidebar list ------------------------------------------------------

/**
 * The task list, in the sidebar, where the session list lives on the other tab.
 *
 * Grouped the way mockup 12b is: Needs you / In progress / Queued / Ready to
 * merge. A row is title + status dot + one meta line — no progress bars, no
 * token counts.
 */
export function TaskSidebarList({
  runs,
  loading,
  error = null,
  selectedRunId,
  onOpenTask,
  onStartTask,
  onOpenTeams,
  locked = false,
  seenAt = {},
  teamsSummary = null,
}) {
  // No "+ New task" while locked — the server would refuse it.
  if (locked) {
    return h(
      "div",
      { className: "task-sidebar task-locked" },
      h(
        "div",
        { className: "task-locked-scenery", "aria-hidden": "true" },
        h("div", { className: "task-locked-bar" }),
        h("div", { className: "task-locked-bar" }),
        h("div", { className: "task-locked-bar" })
      ),
      h("p", { className: "task-sidebar-empty" }, "In development")
    );
  }
  const list = runs || [];
  const grouped = groupTeamRuns(list, seenAt);
  return h(
    "div",
    { className: "task-sidebar" },
    h(
      "button",
      { type: "button", className: "task-sidebar-new", onClick: () => onStartTask?.() },
      h("span", { className: "task-sidebar-new-plus" }, "+"),
      "New task"
    ),
    // The error outranks the loading state. Without it a persistent failure reads
    // as "Loading…" here forever while the main area says the relay is
    // unreachable — the two halves of one screen disagreeing about one fetch.
    !runs && error
      ? h("p", { className: "task-sidebar-empty is-error" }, "Tasks unavailable.")
      : !runs && loading
        ? h("p", { className: "task-sidebar-empty" }, "Loading…")
      : list.length
        ? h(
            "div",
            { className: "task-sidebar-groups" },
            ...TEAM_LIST_GROUPS.map((group) => {
              const rows = grouped[group.id] || [];
              if (!rows.length) return null;
              return h(
                "section",
                { key: group.id, className: "task-sidebar-group", "aria-label": group.label },
                h(
                  "h3",
                  { className: "task-sidebar-group-label" },
                  group.label,
                  h("span", { className: "task-sidebar-group-count" }, String(rows.length))
                ),
                h(
                  "div",
                  { className: "task-sidebar-rows" },
                  ...rows.map((run) => {
                    const attention = teamAttention(run);
                    const tone = teamStatusTone(run.status);
                    return h(
                      "button",
                      {
                        key: run.team_run_id,
                        type: "button",
                        className: [
                          "task-sidebar-row",
                          run.team_run_id === selectedRunId ? "is-selected" : "",
                          attention?.kind === "needs_input" ? "is-attention" : "",
                          isTerminalTeamStatus(run.status) ? "is-terminal" : "",
                        ]
                          .filter(Boolean)
                          .join(" "),
                        title: run.title || "Untitled task",
                        onClick: () => onOpenTask?.(run.team_run_id),
                      },
                      h("span", { className: `task-sidebar-dot${tone ? ` is-${tone}` : ""}` }),
                      h(
                        "span",
                        { className: "task-sidebar-body" },
                        h("span", { className: "task-sidebar-title" }, run.title || "Untitled task"),
                        h(
                          "span",
                          { className: "task-sidebar-meta" },
                          teamListMeta(run, group.id)
                        )
                      )
                    );
                  })
                )
              );
            })
          )
        : h(
            "p",
            { className: "task-sidebar-empty" },
            "No tasks yet. A task runs on its own branch while you do something else."
          ),
    typeof onOpenTeams === "function"
      ? h(
          "button",
          {
            type: "button",
            className: "task-sidebar-teams",
            onClick: () => onOpenTeams(),
          },
          h("span", { className: "task-sidebar-teams-label" }, "Teams"),
          h(
            "span",
            { className: "task-sidebar-teams-meta" },
            teamsSummary || "1 team"
          )
        )
      : null
  );
}

// ---- the team diagram / role flow ------------------------------------------

function SeatNode({ seat, onOpenThread }) {
  const openable = Boolean(seat.threadId);
  const stateClass = seat.state ? ` is-${seat.state}` : "";
  return h(
    "button",
    {
      type: "button",
      className: `team-seat${stateClass}${openable ? "" : " is-empty"}`,
      disabled: !openable,
      title: openable
        ? `Open ${seat.label}'s transcript`
        : `${seat.label} has not been seated yet`,
      onClick: () => (openable ? onOpenThread?.(seat.threadId) : undefined),
    },
    h(
      "span",
      { className: "team-seat-head" },
      h("span", { className: "team-seat-dot" }),
      h("span", { className: "team-seat-role" }, seat.label)
    ),
    h(
      "span",
      { className: "team-seat-note" },
      seat.state === "needs_input"
        ? "Waiting on you"
        : seat.state === "working"
          ? "Working"
          : seat.state === "reviewing"
            ? "Reviewing"
            : openable
              ? "Idle"
              : "Not started"
    ),
    seat.subTaskTitle
      ? h("span", { className: "team-seat-subtask" }, seat.subTaskTitle)
      : null
  );
}

export function TeamDiagram({ run, onOpenThread }) {
  const seats = teamSeats(run);
  return h(
    "section",
    { className: "team-diagram", "aria-label": "The team" },
    ...seats.map((seat) => h(SeatNode, { key: seat.role, seat, onOpenThread }))
  );
}

/**
 * Vertical role flow for the 12b right pane — index, name, status, optional
 * token estimate. Same seats as `TeamDiagram`; different geometry.
 */
export function TeamRoleFlow({ run, onOpenThread, tokenByRole = null }) {
  const seats = teamSeats(run);
  return h(
    "ol",
    { className: "team-role-flow", "aria-label": "Role flow" },
    ...seats.map((seat, index) => {
      const openable = Boolean(seat.threadId);
      const tokens = tokenByRole?.[seat.role];
      const state =
        seat.state === "needs_input"
          ? "needs_input"
          : seat.state === "working" || seat.state === "reviewing"
            ? "active"
            : openable
              ? "done"
              : "queued";
      const note =
        seat.state === "needs_input"
          ? "Waiting on you"
          : seat.state === "working"
            ? "Working"
            : seat.state === "reviewing"
              ? "Reviewing"
              : openable
                ? "Done"
                : "Queued";
      return h(
        "li",
        {
          key: seat.role,
          className: `team-role-step is-${state}`,
        },
        h("span", { className: "team-role-index" }, String(index + 1)),
        h(
          "div",
          { className: "team-role-body" },
          h(
            "div",
            { className: "team-role-head" },
            h(
              openable ? "button" : "span",
              openable
                ? {
                    type: "button",
                    className: "team-role-name is-link",
                    onClick: () => onOpenThread?.(seat.threadId),
                  }
                : { className: "team-role-name" },
              seat.label
            ),
            tokens != null
              ? h("span", { className: "team-role-estimate" }, tokens)
              : null
          ),
          h("p", { className: "team-role-blurb" }, seat.subTaskTitle || note)
        )
      );
    })
  );
}

// ---- detail ----------------------------------------------------------------

function SubTaskRow({ task, isCurrent }) {
  return h(
    "li",
    {
      className: `task-subtask${isCurrent ? " is-current" : ""}${
        isTerminalSubTaskStatus(task.status) ? " is-settled" : ""
      }`,
    },
    h("span", { className: `task-subtask-dot is-${task.status}` }),
    h(
      "span",
      { className: "task-subtask-body" },
      h("span", { className: "task-subtask-title" }, task.title || task.id),
      task.result_summary
        ? h("span", { className: "task-subtask-summary" }, task.result_summary)
        : null
    ),
    // Finished is not the same as folded in. The run leaves this phase only
    // once every sub-task is `digested` (state/app/team.rs:2451-2492), so a
    // settled-but-undigested sub-task is what holds an apparently-complete run
    // in place — and nothing else on screen says so.
    //
    // The wording is deliberately about the RUN, not about who is holding it.
    // `digested` flips only after BOTH the lead read-out and the worktree
    // checkpoint commit, and skipped sub-tasks bypass the lead entirely
    // ("Skipped sub-tasks have nothing to report", team.rs:2459). Naming the
    // lead here would be wrong for skipped tasks, and wrong for any task whose
    // lead turn is already done but whose commit is still running.
    //
    // Keyed off terminal status AND !digested: `digested` is false for a
    // sub-task's whole working life, so the flag alone would mark every row
    // from the moment the run starts.
    isTerminalSubTaskStatus(task.status) && !task.digested
      ? h(
          "span",
          {
            className: "task-subtask-digest",
            title: "Finished — the run has not folded this sub-task in yet",
          },
          "finalizing"
        )
      : null,
    task.rounds_used
      ? h(
          "span",
          { className: "task-subtask-rounds", title: "Review rounds used" },
          `${task.rounds_used} round${task.rounds_used === 1 ? "" : "s"}`
        )
      : null
  );
}

function TaskActions({ run, onAction, onDelete, pending, error }) {
  const actions = availableTeamActions(run.status);
  const canDelete = isTeamRunDeletable(run.status) && typeof onDelete === "function";
  if (!actions.length && !canDelete) {
    return error ? h("p", { className: "task-action-error" }, String(error)) : null;
  }
  return h(
    "div",
    { className: "task-actions" },
    ...actions.map((action) =>
      h(
        "button",
        {
          key: action,
          type: "button",
          className: `task-action is-${action}`,
          disabled: Boolean(pending),
          title: TEAM_ACTION_HINTS[action],
          onClick: () => onAction?.(action),
        },
        pending === action ? "…" : TEAM_ACTION_LABELS[action]
      )
    ),
    canDelete
      ? h(
          "button",
          {
            type: "button",
            className: "task-action is-delete",
            disabled: Boolean(pending),
            title: "Permanently delete this task and all of its sessions",
            onClick: () => onDelete(run.team_run_id),
          },
          pending === "delete" ? "…" : "Delete task"
        )
      : null,
    error ? h("p", { className: "task-action-error" }, String(error)) : null
  );
}

export function TaskDetail({
  run,
  onBack,
  onOpenThread,
  onAction,
  onDelete,
  actionPending,
  actionError,
  changesPanel = null,
  /** Right pane of the 12b workspace — list stays visible, so no back control. */
  embedded = false,
  /** Optional capacity strip: `{ parallelUsed, parallelCap, todayLabel }`. */
  capacity = null,
}) {
  if (!run) {
    return h(
      "div",
      { className: `task-screen${embedded ? " is-embedded" : ""}` },
      embedded
        ? null
        : h(
            "header",
            { className: "task-screen-header" },
            h(
              "button",
              { type: "button", className: "task-screen-back", onClick: () => onBack?.() },
              h(BackGlyph),
              "All tasks"
            )
          ),
      h(
        "div",
        { className: "task-screen-empty" },
        h("h3", null, "That task is gone"),
        h(
          "p",
          null,
          "The relay no longer has a record of it. Any branch it created is still on disk."
        )
      )
    );
  }

  const attention = teamAttention(run);
  const progress = teamRunProgress(run);
  const current = currentSubTask(run);

  return h(
    "div",
    { className: `task-screen${embedded ? " is-embedded" : ""}` },
    capacity
      ? h(
          "div",
          { className: "task-capacity-line" },
          h(
            "span",
            null,
            `Parallel ${capacity.parallelUsed ?? "—"}/${capacity.parallelCap ?? "—"}`
          ),
          capacity.todayLabel
            ? h("span", null, ` · ${capacity.todayLabel}`)
            : null
        )
      : null,
    h(
      "header",
      { className: "task-screen-header" },
      h(
        "div",
        { className: "task-detail-heading" },
        embedded
          ? null
          : h(
              "button",
              { type: "button", className: "task-screen-back", onClick: () => onBack?.() },
              h(BackGlyph),
              "All tasks"
            ),
        h(
          "div",
          { className: "task-detail-titles" },
          h("h2", { className: "task-screen-title" }, run.title || "Untitled task"),
          h(
            "p",
            { className: "task-screen-subtitle" },
            h("span", { className: "task-card-branch" }, h(BranchGlyph), run.branch || "—"),
            run.target_ref
              ? h("span", null, ` vs ${run.target_ref.replace(/^refs\/heads\//, "")}`)
              : null
          )
        )
      ),
      h(
        "div",
        { className: "task-detail-status" },
        h(StatusPill, { status: run.status }),
        h("span", { className: "task-detail-phase" }, teamPhaseLabel(run.phase))
      )
    ),

    attention
      ? h(
          "div",
          // Keyed on the REASON, not the bucket. Collapsing every
          // wanting-a-person state into one `kind` is right for the badge, the
          // sort and the pill — but the banner is where the difference has to
          // come back, because only a parked question has something to answer.
          { className: `task-banner is-${attention.reason || attention.kind}` },
          h("p", null, attention.text),
          attention.reason === "question" && run.awaiting?.thread_id
            ? h(
                "button",
                {
                  type: "button",
                  className: "task-banner-action",
                  onClick: () => onOpenThread?.(run.awaiting.thread_id),
                },
                "Answer it"
              )
            : null
        )
      : null,

    h(TaskActions, {
      run,
      onAction,
      onDelete,
      pending: actionPending,
      error: actionError,
    }),

    canTalkToTeamLead(run)
      ? h(
          "p",
          { className: "task-screen-hint" },
          "The task is paused, so you can talk to the team lead — open its session to redirect the work."
        )
      : null,

    // 12b right pane uses the vertical flow; the compact horizontal diagram stays
    // for any non-embedded caller that still wants the three-up seats.
    embedded
      ? h(TeamRoleFlow, { run, onOpenThread })
      : h(TeamDiagram, { run, onOpenThread }),

    progress.total
      ? h(
          "section",
          { className: "task-subtasks" },
          h(
            "h3",
            { className: "task-section-title" },
            `Sub-tasks (${progress.done}/${progress.total})`
          ),
          h(
            "ul",
            { className: "task-subtask-list" },
            ...run.sub_tasks.map((task) =>
              h(SubTaskRow, {
                key: task.id,
                task,
                isCurrent: current?.id === task.id,
              })
            )
          )
        )
      : null,

    run.unresolved?.length
      ? h(
          "section",
          { className: "task-unresolved" },
          h("h3", { className: "task-section-title" }, "Unresolved"),
          h(
            "ul",
            null,
            ...run.unresolved.map((note, index) => h("li", { key: index }, note))
          )
        )
      : null,

    changesPanel
      ? h(
          "section",
          { className: "task-changes" },
          h("h3", { className: "task-section-title" }, "Changes on this branch"),
          changesPanel
        )
      : null
  );
}

// ---- the screen ------------------------------------------------------------

/**
 * Drag handle on the Orchestrator column's left edge. Binds on mount so React
 * re-renders that replace the node still get a live listener.
 */
function TaskWorkspaceResizeHandle() {
  React.useEffect(() => {
    const binding = bindTaskWorkspaceResizeHandle();
    return () => binding?.destroy?.();
  }, []);
  return h("div", {
    className: "task-workspace-resize",
    id: "task-workspace-resize",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize Orchestrator panel",
    tabIndex: 0,
  });
}

export const TASK_VIEW_MODES = Object.freeze(["list", "board"]);

/**
 * The Tasks header strip (16a): title, the list/board switch, and the two live
 * numbers. Sits above both modes so switching does not move it.
 *
 * 16a also carries a Usage tab and two filter dropdowns. Usage is already its own
 * sidebar destination, and both filters would filter on the team a run belongs
 * to — a field `TeamRunView` does not carry — so neither is here yet.
 */
function TasksToolbar({ viewMode, onChangeViewMode, runningCount, capacity, onStartTask }) {
  return h(
    "header",
    { className: "task-surface-toolbar" },
    h("h2", { className: "task-surface-title" }, "Tasks"),
    h(
      "div",
      { className: "task-surface-modes", role: "tablist", "aria-label": "Task view" },
      ...TASK_VIEW_MODES.map((mode) =>
        h(
          "button",
          {
            key: mode,
            type: "button",
            role: "tab",
            "aria-selected": viewMode === mode ? "true" : "false",
            className: `task-surface-mode${viewMode === mode ? " is-active" : ""}`,
            onClick: () => onChangeViewMode?.(mode),
          },
          mode === "list" ? "List" : "Board"
        )
      )
    ),
    h("div", { className: "task-surface-toolbar-spacer" }),
    h(
      "span",
      { className: "task-surface-stat" },
      h("span", { className: "task-surface-stat-dot" }),
      `${runningCount} running`
    ),
    // `todayLabel` is the WHOLE label ("Today 42%"), as TaskDetail's capacity
    // line consumes it. Only the empty case supplies the word.
    capacity?.todayLabel
      ? h("span", { className: "task-surface-stat" }, h("strong", null, capacity.todayLabel))
      : h(
          "span",
          { className: "task-surface-stat" },
          "Today ",
          h(
            "span",
            { className: "task-surface-unknown", title: "Today's spend is not reported yet" },
            "—"
          )
        ),
    h(
      "button",
      { type: "button", className: "task-surface-new", onClick: () => onStartTask?.() },
      "New task"
    )
  );
}

export function TaskTeamScreen({
  runs,
  selectedRunId,
  seenAt = {},
  loading = false,
  error = null,
  onOpenTask,
  onBack,
  onOpenThread,
  onAction,
  onDelete,
  actionPending = null,
  actionError = null,
  onStartTask,
  syncing = false,
  changesPanel = null,
  locked = false,
  waitingCount = 0,
  capacity = null,
  orchestrator = null,
  viewMode = "list",
  onChangeViewMode = null,
  onOpenReview = null,
  onOpenTicket = null,
  /** Injectable clock, like the card helpers in `remote/utils.js`. */
  nowSeconds = undefined,
}) {
  // Before the loading and not-found branches: nothing was ever fetched.
  if (locked) {
    return h(TaskLockedPreview);
  }

  const run =
    selectedRunId
      ? (runs || []).find((entry) => entry?.team_run_id === selectedRunId) || null
      : null;
  // A run we have not fetched yet is not a run that is gone.
  //
  // `loading` alone is not enough, and the gap is reachable in one click: starting
  // a task navigates straight to its detail, but the cache still holds the
  // pre-create list — so it HAS data, is not loading, and the new run is simply
  // absent. Without `syncing` the user's brand-new task greets them with "that
  // task is gone".
  const waitingOnFetch = Boolean(
    selectedRunId && !run && (syncing || (loading && !runs))
  );

  const detailPane = h(
    "aside",
    { className: "task-workspace-detail", "aria-label": "Task detail" },
    waitingOnFetch
      ? h(
          "div",
          { className: "task-screen task-screen-centered is-embedded" },
          h("div", { className: "task-screen-empty" }, h("p", null, "Loading task…"))
        )
      : selectedRunId
        ? h(TaskDetail, {
            run,
            onBack,
            onOpenThread,
            onAction,
            onDelete,
            actionPending,
            actionError,
            changesPanel,
            embedded: true,
            capacity: capacity || { parallelUsed: "—", parallelCap: "—", todayLabel: "Today —" },
          })
        : h(
            "div",
            { className: "task-screen is-embedded task-workspace-empty" },
            h(
              "div",
              { className: "task-capacity-line" },
              h(
                "span",
                null,
                `Parallel ${capacity?.parallelUsed ?? "—"}/${capacity?.parallelCap ?? "—"}`
              ),
              h("span", null, ` · ${capacity?.todayLabel || "Today —"}`)
            ),
            h(
              "div",
              { className: "task-screen-empty" },
              h("h3", null, "No task selected"),
              h("p", null, "Pick one on the left to see its seats and branch.")
            )
          )
  );

  const orchPane = h(
    "div",
    { className: "task-workspace-orch" },
    h(TaskWorkspaceResizeHandle),
    h(OrchestratorPane, {
      runs,
      selectedRun: run,
      seenAt,
      loading,
      error,
      waitingCount,
      onStartTask,
      onOpenThread,
      transcriptEntries: orchestrator?.entries ?? null,
      transcriptLoading: Boolean(orchestrator?.loading),
      onTranscriptInteract: orchestrator?.onTranscriptInteract || null,
      transcriptOptions: orchestrator?.transcriptOptions || null,
      approval: orchestrator?.approval || null,
      canWrite: orchestrator?.canWrite !== false,
      composerDisabled: Boolean(orchestrator?.composerDisabled),
      composerBusy: Boolean(orchestrator?.composerBusy),
      composerError: orchestrator?.composerError || null,
      proposals: orchestrator?.proposals || [],
      onSend: orchestrator?.onSend || null,
      onPropose: orchestrator?.onPropose || null,
      onConfirmProposal: orchestrator?.onConfirmProposal || null,
      onDismissProposal: orchestrator?.onDismissProposal || null,
      onToggleProposalAutoStart: orchestrator?.onToggleProposalAutoStart || null,
      onReset: orchestrator?.onReset || null,
      resetBusy: Boolean(orchestrator?.resetBusy),
      attachments: orchestrator?.attachments || [],
      onPasteImages: orchestrator?.onPasteImages || null,
      onRemoveAttachment: orchestrator?.onRemoveAttachment || null,
      activity: orchestrator?.activity || null,
      onStop: orchestrator?.onStop || null,
      enterSubmits: orchestrator?.enterSubmits,
    })
  );

  const toolbar = h(TasksToolbar, {
    viewMode,
    onChangeViewMode,
    // The In-progress bucket MINUS the ones holding a worktree with no driver.
    // Both halves are needed: the bucket alone counted `paused` as running, and
    // `teamRunIsWorking` alone would pull in a parked question, whose turn is
    // genuinely still open but which lives in Needs you.
    runningCount: (groupTeamRuns(runs || [], seenAt).in_progress || []).filter(teamRunIsWorking)
      .length,
    capacity,
    onStartTask,
  });

  // Board mode takes the whole area: it is five columns wide, and 16a has no
  // Orchestrator rail. Clicking a card returns to list mode with that task open,
  // which is the only detail view that exists.
  if (viewMode === "board") {
    return h(
      "div",
      { className: "task-surface" },
      toolbar,
      h(TaskBoard, {
        runs,
        seenAt,
        selectedRunId,
        loading,
        error,
        capacity,
        ...(nowSeconds === undefined ? {} : { nowSeconds }),
        // A card opens the run's own page (17b). The fallback matters: without
        // a ticket route the click would set a selection board mode has nowhere
        // to draw, so it drops back to List, which does.
        onOpenTask: (teamRunId) => {
          if (onOpenTicket) {
            onOpenTicket(teamRunId);
            return;
          }
          onChangeViewMode?.("list");
          onOpenTask?.(teamRunId);
        },
        onOpenThread,
        onOpenReview,
      })
    );
  }

  // Detail in the middle (1fr), Orchestrator on the right (resizable width).
  return h(
    "div",
    { className: "task-surface" },
    toolbar,
    h("div", { className: "task-workspace" }, detailPane, orchPane)
  );
}
