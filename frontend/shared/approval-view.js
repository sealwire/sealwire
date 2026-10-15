// What the approval card and its float bar show, kept pure so it is testable
// without a DOM. See frontend/approval-card-redesign.test.mjs.
import { approvalKindLabel } from "./approval-labels.js";
import { t } from "./i18n.js";

// Past this the summary is a sentence ("Codex wants to run …"), not a tool name.
const MAX_NAME_CHARS = 24;
// Less than this much of the card on screen does not count as "visible".
const MIN_VISIBLE_PX = 24;

// These render as nothing, as a plain space, reorder the text or break the line, while the
// shell runs them as sent; that includes the CR of CRLF. Not the `v` flag: older Safari refuses it.
const HIDDEN_CHARS =
  /(?![\t\n ])[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

export function visibleText(value) {
  return String(value ?? "").replace(HIDDEN_CHARS, (char) => {
    const code = char.codePointAt(0);
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

// Escaped first: trim() deletes U+FEFF, U+2028, \r and the like, which would make
// `./safe` + U+FEFF read as `./safe`. Afterwards only ASCII whitespace is left to trim.
function shownText(value) {
  return visibleText(value).trim();
}

// Prose and diffs keep their tabs. In a command a quoted or escaped tab or space is part of
// the word, yet a tab looks like spaces and a space ending a line looks like nothing.
export function visibleCommand(value) {
  return visibleText(value)
    .replace(/\t/g, "\\u0009")
    .replace(/ +$/gm, (spaces) => "\\u0020".repeat(spaces.length));
}

// Only the blanks the shell skips before the first word are dropped; trim() would also
// take the line-end spaces `visibleCommand` has to show.
function commandFirstLine(command) {
  return visibleCommand(String(command ?? "").replace(/^[ \t\n]+/, "")).split("\n")[0];
}

// Codex's summary quotes the command; with the command block right below, that
// would print it twice.
export function approvalTitle(approval) {
  const summary = shownText(approval?.summary);
  const head = commandFirstLine(approval?.command).slice(0, MAX_NAME_CHARS);
  if (head && summary.includes(head)) {
    return "";
  }
  return summary;
}

export function approvalFloatName(approval) {
  const summary = shownText(approval?.summary);
  if (summary && summary.length <= MAX_NAME_CHARS) {
    return summary;
  }
  return approvalKindLabel(approval?.kind) || t("Approval");
}

export function approvalFloatSubject(approval) {
  // One line: the bar keeps spaces (`white-space: pre`), so a newline would grow it.
  return commandFirstLine(approval?.command) || shownText(approval?.summary).split("\n")[0];
}

// The bar can approve with the card off screen, so it must not pass off a first line
// as the whole command.
export function approvalFloatMoreLines(approval) {
  const lines = visibleText(approval?.command).split("\n").filter((line) => /[^ \t]/.test(line));
  return Math.max(lines.length - 1, 0);
}

// `null` card = unmounted (virtualized away), which is as off screen as it gets.
export function isApprovalCardOffscreen(cardRect, viewRect) {
  if (!cardRect || !viewRect) {
    return true;
  }
  const visible = Math.min(cardRect.bottom, viewRect.bottom) - Math.max(cardRect.top, viewRect.top);
  return visible < MIN_VISIBLE_PX;
}
