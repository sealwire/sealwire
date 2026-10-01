// Design 27a / 27b: each goal turn opens with a thin line, and the turn the agent settles
// it in carries a card. The Agents panel lists the same steps with the same rows.
import React, { useState } from "react";

import { avatar, CardIcon, Caret } from "./card-parts.js";
import { renderMarkdown } from "./markdown.js";
import { providerLabel } from "./provider-labels.js";

const h = React.createElement;

const GOAL_FLAG_ICON = ["M3.5 14V2.5", "M3.5 3h8.5l-2 3 2 3H3.5"];

const SETTLED_TONES = {
  complete_claimed: "pass",
  blocked: "blocker",
  awaiting_user: "needs-you",
};

const RESOLUTION_LABELS = {
  reopened: "Reopened",
  answered: "Answered",
  accepted: "Marked done",
  cancelled: "Cancelled",
};

const STEP_STATUS_WORDS = {
  done: "done",
  active: "in progress",
  pending: "not started",
};

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function turnOf(turns, maxTurns) {
  return Number.isFinite(maxTurns) && maxTurns > 0 ? `turn ${turns} of ${maxTurns}` : `turn ${turns}`;
}

export function goalStepsOf(value) {
  return (Array.isArray(value?.steps) ? value.steps : []).filter(
    (step) => step && typeof step.title === "string" && step.title.trim()
  );
}

export function goalListOf(value) {
  return (Array.isArray(value) ? value : []).filter(
    (item) => typeof item === "string" && item.trim()
  );
}

export function goalStepsDone(steps) {
  return steps.filter((step) => step.status === "done").length;
}

/** The settled goal tool rows drawn as a card; any other status stays an ordinary row. */
export function drawsGoalSettledCard(entry) {
  return (
    entry?.kind === "tool_call"
    && entry.status === "completed"
    && entry.injection?.kind === "goal_settled"
    && Boolean(SETTLED_TONES[entry.injection.goal_settled?.status])
  );
}

function CheckGlyph() {
  return h(
    "svg",
    { width: 8, height: 8, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": "true" },
    h("path", { d: "M2 5.2 4.2 7.4 8 3" })
  );
}

function BangGlyph() {
  return h(
    "svg",
    { width: 8, height: 8, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": "true" },
    h("path", { d: "M5 1.8v3.9M5 8.2v.1" })
  );
}

function StepMark({ status, live, flagTone }) {
  if (status === "done") {
    return h("span", { className: "goal-step-mark is-done", "aria-hidden": "true" }, h(CheckGlyph));
  }
  if (status === "active" && flagTone) {
    return h("span", { className: `goal-step-mark is-flag is-${flagTone}`, "aria-hidden": "true" }, h(BangGlyph));
  }
  if (status === "active") {
    return h("span", { className: `goal-step-mark ${live ? "is-working" : "is-current"}`, "aria-hidden": "true" });
  }
  return h("span", { className: "goal-step-mark is-pending", "aria-hidden": "true" });
}

/** Where a blocked or waiting goal stopped: the step it was on, if the plan says. */
function flaggedStepIndex(steps, flagTone) {
  return flagTone ? steps.findIndex((step) => step.status === "active") : -1;
}

/**
 * One row per step. While the goal runs only the state shows; once it settles, each
 * step's one-line note does too. `under` goes below the flagged step instead of its note.
 */
export function GoalSteps({ steps, live = false, flagTone = "", under = null }) {
  if (!steps.length) {
    return null;
  }
  const flagged = under ? flaggedStepIndex(steps, flagTone) : -1;
  return h(
    "ol",
    { className: "goal-steps" },
    ...steps.map((step, index) => {
      const status = STEP_STATUS_WORDS[step.status] ? step.status : "pending";
      const note = !live && step.note ? step.note : "";
      return h(
        "li",
        {
          key: `${index}:${step.title}`,
          className: `goal-step is-${status}${live && status === "active" ? " is-working" : ""}`,
        },
        h("span", { className: "goal-step-mark-slot" }, h(StepMark, { status, live, flagTone })),
        h(
          "div",
          { className: "goal-step-text" },
          h("span", { className: "goal-step-title" }, step.title),
          h("span", { className: "sr-only" }, ` (${flagTone && status === "active" ? "stopped here" : STEP_STATUS_WORDS[status]})`),
          index === flagged ? under : note ? h("span", { className: "goal-step-note" }, note) : null
        ),
        h("span", { className: "goal-step-turn" }, Number.isFinite(step.turn) ? `turn ${step.turn}` : "")
      );
    })
  );
}

/** What a completion claim says is still the person's to do. */
export function GoalLeftForYou({ items }) {
  if (!items.length) {
    return null;
  }
  return h(
    "div",
    { className: "goal-left" },
    h("span", { className: "goal-left-label" }, "Left for you"),
    h(
      "ul",
      { className: "goal-left-items" },
      ...items.map((item, index) => h("li", { key: `${index}:${item}`, className: "goal-left-item" }, item))
    )
  );
}

/** Where a relay-driven goal turn starts, in place of the prompt nobody typed. */
export function GoalTurnLine({ attrs, entry }) {
  const turn = entry.injection.goal_turn;
  const step = turn.step?.title ? turn.step : null;
  const stepText = step ? `Step ${step.index} · ${step.title}` : "";
  return h(
    "article",
    { ...attrs, className: `${attrs.className} goal-turn` },
    h("span", { className: "goal-turn-icon" }, h(CardIcon, { paths: GOAL_FLAG_ICON, size: 14 })),
    h("span", { className: "goal-turn-label" }, "Goal"),
    h("span", { className: "goal-turn-count" }, turnOf(turn.turn, turn.max_turns)),
    h("span", { className: "goal-turn-rule", "aria-hidden": "true" }),
    step ? h("span", { className: "goal-turn-step", title: stepText }, stepText) : null
  );
}

function kickerParts(card, provider) {
  if (card.status === "complete_claimed") {
    return ["Goal complete", `claimed by ${providerLabel(card.provider || provider) || "the agent"}`];
  }
  return [card.status === "blocked" ? "Goal stuck" : "Goal needs you", turnOf(card.turns, card.max_turns)];
}

// On a phone the kicker wraps between its parts, never inside "turn 3 of 20".
function Kicker({ parts }) {
  return h(
    "span",
    { className: "handover-card-kicker" },
    ...parts.flatMap((part, index) => [
      index ? " · " : null,
      h("span", { key: part, className: "goal-card-kicker-part" }, part),
    ]).filter(Boolean)
  );
}

function GoalReport({ text }) {
  return h("div", { className: "message-body goal-card-report" }, renderMarkdown(text));
}

function FullReport({ text }) {
  const [open, setOpen] = useState(false);
  return h(
    React.Fragment,
    null,
    h(
      "button",
      {
        type: "button",
        className: "handover-card-more",
        "aria-expanded": open ? "true" : "false",
        onClick: () => setOpen((value) => !value),
      },
      h(Caret, { open }),
      "Full report"
    ),
    open ? h(GoalReport, { text }) : null
  );
}

function Resolved({ resolution }) {
  return h("p", { className: "goal-card-resolved" }, RESOLUTION_LABELS[resolution] || "Settled");
}

function actionAttrs(card, action, extra = null) {
  return {
    type: "button",
    "data-goal-action": action,
    "data-goal-id": card.goal_id || "",
    "data-goal-seq": String(card.seq ?? ""),
    "data-thread-id": card.thread_id || "",
    ...extra,
  };
}

function WaitingActions({ card, options }) {
  return h(
    "div",
    { className: "goal-card-actions" },
    ...options.map((option, index) =>
      h(
        "button",
        {
          ...actionAttrs(card, "option", { "data-goal-option": option }),
          key: `${index}:${option}`,
          className: "review-card-primary goal-card-option",
        },
        option
      )
    ),
    h("button", { ...actionAttrs(card, "reply"), key: "reply", className: "review-card-secondary" }, "Reply…"),
    card.status === "blocked"
      ? h("span", { key: "spacer", className: "handover-card-spacer" })
      : null,
    card.status === "blocked"
      ? h("button", { ...actionAttrs(card, "stop"), key: "stop", className: "handover-card-link" }, "Cancel goal")
      : null
  );
}

/**
 * The `goal_complete` / `goal_blocked` / `goal_needs_you` call, drawn as how the agent left
 * the goal. Its buttons act on the live goal; once the person has, a quiet line says how.
 */
export function GoalSettledEntry({ attrs, entry, showAvatar = true, provider = "", providerIcon = "" }) {
  const card = entry.injection.goal_settled;
  const tone = SETTLED_TONES[card.status];
  const complete = card.status === "complete_claimed";
  const steps = goalStepsOf(card);
  const report = String(card.report || "").trim();
  const resolution = card.resolution || null;
  const flagTone = complete ? "" : tone;
  const underStep = report && flaggedStepIndex(steps, flagTone) >= 0;
  const leftForYou = complete ? goalListOf(card.left_for_you) : [];
  const trailing = complete ? plural(card.turns || 0, "turn") : resolution ? "" : "paused";
  return h(
    "article",
    { ...attrs, className: `${attrs.className} handover-message goal-message` },
    showAvatar ? avatar(providerIcon, provider) : null,
    h(
      "div",
      { className: `handover-card goal-card is-${tone}`, "data-goal-id": card.goal_id || "" },
      h(
        "div",
        { className: "handover-card-head" },
        h("span", { className: "handover-card-icon" }, h(CardIcon, { paths: GOAL_FLAG_ICON })),
        h(
          "div",
          { className: "handover-card-heading" },
          h(Kicker, { parts: kickerParts(card, provider) }),
          h("span", { className: "handover-card-title", title: card.objective || "" }, card.objective || "Goal")
        ),
        trailing ? h("span", { className: "handover-card-time" }, trailing) : null
      ),
      h(
        "div",
        { className: "handover-card-body goal-card-body" },
        h(GoalSteps, {
          steps,
          flagTone,
          under: underStep ? h(GoalReport, { text: report }) : null,
        }),
        !complete && report && !underStep ? h(GoalReport, { text: report }) : null,
        h(GoalLeftForYou, { items: leftForYou }),
        complete && report ? h(FullReport, { text: report }) : null,
        complete
          ? null
          : resolution
            ? h(Resolved, { resolution })
            : h(WaitingActions, { card, options: goalListOf(card.options) })
      ),
      complete
        ? h(
            "div",
            { className: "handover-card-foot" },
            resolution
              ? h(Resolved, { resolution })
              : h(
                  React.Fragment,
                  null,
                  h("button", { ...actionAttrs(card, "resume"), className: "review-card-secondary" }, "Not done — keep going"),
                  h("span", { className: "handover-card-spacer" }),
                  h("button", { ...actionAttrs(card, "stop"), className: "handover-card-link" }, "Mark done")
                )
          )
        : null
    )
  );
}

/**
 * One meaning for the goal card's buttons on every surface; each passes what it can do.
 * Keep going and stop go to the relay with the card's seq, and the relay decides whether
 * the goal still sits on this card: a client's copy of the goal can be stale.
 */
export function dispatchGoalAction(
  { action, threadId, seq, option },
  { card = null, send = null, reply = null } = {}
) {
  if (!threadId) {
    return undefined;
  }
  if (action === "reply") {
    return reply?.(threadId);
  }
  // Any reply resumes a goal waiting on the person, so an answer needs no card check.
  if (action === "option") {
    return option ? send?.(threadId, option) : undefined;
  }
  if (action !== "resume" && action !== "stop") {
    return undefined;
  }
  const cardSeq = seq === "" || seq == null ? NaN : Number(seq);
  if (!Number.isInteger(cardSeq) || cardSeq < 0) {
    return undefined;
  }
  return card?.(threadId, cardSeq, action === "resume" ? "keep_going" : "stop");
}

// Claude names them `mcp__sealwire-<hash>__goal_step`, Codex plain `goal_step`.
const GOAL_TOOL = /(?:^|__)goal_(status|plan|step|complete|blocked|needs_you)$/;

function toolArgs(tool) {
  try {
    const parsed = JSON.parse(String(tool?.input_preview || ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function planTitles(args) {
  const list = Array.isArray(args.steps) ? args.steps : [];
  return list
    .map((step) => (typeof step === "string" ? step : step?.title))
    .filter((title) => typeof title === "string" && title.trim())
    .map((title) => title.trim());
}

/** A goal tool row's own line, from its name and structured arguments only. */
export function goalToolLabel(tool) {
  const match = GOAL_TOOL.exec(String(tool?.name || ""));
  if (!match) {
    return null;
  }
  const args = toolArgs(tool);
  switch (match[1]) {
    case "status":
      return { title: "Checked goal status", detail: "" };
    case "plan": {
      const titles = planTitles(args);
      return titles.length
        ? { title: `Planned ${plural(titles.length, "step")}`, detail: titles.join(" · ") }
        : { title: "Planned the goal", detail: "" };
    }
    case "step": {
      const number = Number(args.step);
      const which = Number.isInteger(number) && number > 0 ? `Step ${number}` : "A step";
      const note = typeof args.note === "string" ? args.note.trim() : "";
      const title =
        args.status === "done"
          ? `${which} done`
          : args.status === "active"
            ? `${which} started`
            : args.status === "pending"
              ? `${which} back to not started`
              : `${which} updated`;
      return { title, detail: note };
    }
    case "complete":
      return { title: "Said the goal is done", detail: "" };
    case "blocked":
      return { title: "Said the goal is stuck", detail: "" };
    default:
      return { title: "Asked you to decide", detail: "" };
  }
}
