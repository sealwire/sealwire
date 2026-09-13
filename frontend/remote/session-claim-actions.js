// Kept in its own module, free of browser globals, so the parity test against the relay's
// `requires_session_claim` can import it without booting the remote store.
export const ACTIONS_REQUIRING_SESSION_CLAIM = new Set([
  "send_message",
  "apply_file_change",
  "request_review",
  "start_workflow",
  "resolve_review",
  "resolve_workflow",
  "delete_review",
  "delegate",
  "set_goal",
  "stop_goal",
]);
