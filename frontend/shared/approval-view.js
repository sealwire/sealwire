// What the approval card and its float bar show, kept pure so it is testable
// without a DOM. See frontend/approval-card-redesign.test.mjs.
import { approvalKindLabel } from "./approval-labels.js";

// Past this the summary is a sentence ("Codex wants to run …"), not a tool name.
const MAX_NAME_CHARS = 24;
// Less than this much of the card on screen does not count as "visible".
const MIN_VISIBLE_PX = 24;

function firstLine(value) {
  return String(value || "").trim().split("\n")[0].trim();
}

// Codex's summary quotes the command; with the command block right below, that
// would print it twice.
export function approvalTitle(approval) {
  const summary = String(approval?.summary || "").trim();
  const head = firstLine(approval?.command).slice(0, MAX_NAME_CHARS);
  if (head && summary.includes(head)) {
    return "";
  }
  return summary;
}

export function approvalFloatName(approval) {
  const summary = String(approval?.summary || "").trim();
  if (summary && summary.length <= MAX_NAME_CHARS) {
    return summary;
  }
  return approvalKindLabel(approval?.kind) || "Approval";
}

export function approvalFloatSubject(approval) {
  return firstLine(approval?.command) || String(approval?.summary || "").trim();
}

// `null` card = unmounted (virtualized away), which is as off screen as it gets.
export function isApprovalCardOffscreen(cardRect, viewRect) {
  if (!cardRect || !viewRect) {
    return true;
  }
  const visible = Math.min(cardRect.bottom, viewRect.bottom) - Math.max(cardRect.top, viewRect.top);
  return visible < MIN_VISIBLE_PX;
}
