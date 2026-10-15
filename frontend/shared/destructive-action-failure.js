// Reporting a failed archive/delete so the user actually learns about it.
//
// These two actions used to report failure by calling `logLine` alone, which
// writes into `#client-log` — a collapsed panel. The relay would refuse the
// action, the row would stay exactly where it was, and from the user's side the
// menu item had simply done nothing. That is the shape the original Cursor bug
// report took ("删除 session 完好像没反应"): the delete was failing loudly at the
// HTTP layer and silently at the only layer anyone was looking at.
//
// Making delete work does not retire the problem, it makes it more reachable:
// a real delete has real failure modes (the directory already gone, a
// permissions error, a session the relay is holding for a running turn), where
// before there was exactly one and it was constant.
//
// So the invariant is that a refused destructive action is reported through BOTH
// channels: the log keeps the record, and a modal states it. `window.alert` is
// the counterpart of the `window.confirm` these same flows already open to ask —
// answering a modal question with a modal outcome — and it cannot be missed the
// way a collapsed panel can.

import { t } from "./i18n.js";

/**
 * The sentence shown for a refused destructive action.
 *
 * Names the session, because the menu is opened per-row and a bare "Failed to
 * delete" leaves the user unsure WHICH one they just acted on. Falls back to a
 * generic reason rather than rendering "undefined" when a throw carries no
 * message.
 */
export function describeDestructiveActionFailure({ action = "", title = "", message = "" } = {}) {
  const reason = String(message || "").trim() || t("the relay did not say why");
  const subject = String(title || "").trim();
  if (action === "archive") {
    return subject
      ? t("Could not archive \"{title}\": {reason}", { title: subject, reason })
      : t("Could not archive this session: {reason}", { reason });
  }
  if (action === "delete") {
    return subject
      ? t("Could not delete \"{title}\": {reason}", { title: subject, reason })
      : t("Could not delete this session: {reason}", { reason });
  }
  return subject
    ? `Could not ${action} "${subject}": ${reason}`
    : `Could not ${action} this session: ${reason}`;
}

/**
 * Report a refused destructive action through both channels.
 *
 * `log` and `notify` are injected so the pairing itself is testable — the
 * regression this guards is one of them quietly going away, which a test that
 * only checked the string would not catch.
 *
 * Returns the message, so a caller can assert on or reuse it.
 */
export function reportDestructiveActionFailure({
  action = "",
  title = "",
  error = null,
  log = () => {},
  notify = () => {},
} = {}) {
  const text = describeDestructiveActionFailure({
    action,
    title,
    message: error?.message,
  });
  log(text);
  notify(text);
  return text;
}
