/**
 * Verb pool + label helpers for the "agent is doing something" badge.
 * Pure utilities — no DOM, no timers.
 */

export const PROGRESS_VERBS = [
  "Pondering",
  "Cogitating",
  "Hatching",
  "Plotting",
  "Brewing",
  "Tinkering",
  "Whittling",
  "Stitching",
  "Conjuring",
  "Relaying",
  "Channeling",
  "Tunneling",
  "Wiring",
  "Vibing",
  "Noodling",
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

export function progressPhaseLabel(phase, currentTool, verb) {
  switch (phase) {
    case "streaming":
      return `${verb ?? "Streaming"}…`;
    case "tool": {
      const gerund = toolGerund(currentTool);
      return gerund ? `${gerund}…` : `${verb ?? "Working"}…`;
    }
    case "waiting_approval":
      return "Waiting on you";
    case "thinking":
      return `${verb ?? "Thinking"}…`;
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
