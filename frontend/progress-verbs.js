/**
 * Verb pool + label helpers for the "agent is doing something" badge.
 * Pure utilities — no DOM, no timers.
 */

import { currentLanguage, t } from "./shared/i18n.js";

export const PROGRESS_VERBS = [
  t("Pondering"),
  t("Cogitating"),
  t("Hatching"),
  t("Plotting"),
  t("Brewing"),
  t("Tinkering"),
  t("Whittling"),
  t("Stitching"),
  t("Conjuring"),
  t("Relaying"),
  t("Channeling"),
  t("Tunneling"),
  t("Wiring"),
  t("Vibing"),
  t("Noodling"),
];

// Per-phase stall thresholds in seconds. `null` disables stall detection
// for that phase entirely. The defaults assume: streaming and
// waiting_approval should never be flagged stalled (deltas are constant
// when streaming; approvals are literally waiting on the human). Thinking
// allows up to a minute of silent reasoning; tool calls can run for two
// minutes (test suites, long greps, etc.) before we get suspicious.
export const STALL_THRESHOLDS_BY_PHASE = {
  thinking: 60,
  tool: 120,
  streaming: null,
  waiting_approval: null,
};

// How often the filler verb rotates while the agent works. One constant: the
// Tasks pane used to carry its own copy, kept in step by a comment.
export const VERB_CYCLE_MS = 2500;

export function createVerbCycler(opts = {}) {
  const verbs = opts.verbs ?? PROGRESS_VERBS;
  const random = opts.random ?? Math.random;
  let last = -1;
  return {
    next() {
      if (verbs.length === 0) return null;
      if (verbs.length === 1) {
        last = 0;
        return verbs[0];
      }
      let idx;
      do {
        idx = Math.floor(random() * verbs.length);
      } while (idx === last);
      last = idx;
      return verbs[idx];
    },
    peek() {
      return last < 0 ? null : verbs[last];
    },
    reset() {
      last = -1;
    },
  };
}

const TOOL_GERUND_OVERRIDES = {
  grep: "Grepping",
  glob: "Globbing",
  ls: "Listing",
};

export function toolGerund(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (TOOL_GERUND_OVERRIDES[lower]) return TOOL_GERUND_OVERRIDES[lower];
  if (lower.endsWith("ing")) return capitalize(trimmed);
  if (lower.endsWith("e")) return capitalize(trimmed.slice(0, -1) + "ing");
  return capitalize(trimmed + "ing");
}

function capitalize(value) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// English bends the tool's own name into a verb ("Bashing…"); other languages name the tool.
function toolLabel(tool) {
  const gerund = toolGerund(tool);
  if (!gerund) return null;
  return currentLanguage() === "en" ? `${gerund}…` : t("Using {tool}…", { tool: tool.trim() });
}

export function progressPhaseLabel(phase, currentTool, verb) {
  switch (phase) {
    case "streaming":
      return verb ? `${verb}…` : t("Streaming…");
    case "tool":
      return toolLabel(currentTool) || (verb ? `${verb}…` : t("Working…"));
    case "waiting_approval":
      return t("Waiting on you");
    case "thinking":
      return verb ? `${verb}…` : t("Thinking…");
    default:
      return null;
  }
}

export function isProgressStalled(session, opts = {}) {
  if (!session) return false;
  const phase = session.current_phase;
  if (!phase) return false;
  const lastAt = session.last_progress_at;
  if (lastAt == null) return false;

  const phaseThresholds = opts.phaseThresholds ?? STALL_THRESHOLDS_BY_PHASE;
  const threshold = opts.thresholdSec ?? phaseThresholds[phase];
  if (threshold == null) return false;

  const now = opts.now ?? session.server_time ?? Math.floor(Date.now() / 1000);
  return now - lastAt > threshold;
}
