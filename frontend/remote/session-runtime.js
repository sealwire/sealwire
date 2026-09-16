import { threadError } from "../shared/composer-errors.js";
import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "../shared/reasoning-efforts.js";
import { sessionIsWorking } from "../shared/thread-attention.js";
import { isStopPending } from "../shared/stop-pending.js";

export function selectRemoteControlSession({ session, realSession }) {
  if (session?.view_only) {
    return realSession || null;
  }
  return session || null;
}

export function deriveSessionRuntime({
  composerDraft = "",
  composerEffort = "medium",
  // Why each thread's last send/settings change was refused, straight from the
  // relay, keyed by thread id. It rides the composer because that is where the
  // user acted; the client log is a debug panel, not a way to tell someone
  // their message did not go. Keyed by thread because sends survive navigation
  // in both directions: a late rejection must not blame the session now on
  // screen, and a late success elsewhere must not silence this one.
  composerErrors = null,
  // What a "/" command stopped itself. Same per-thread rule, a different slot.
  composerHeld = null,
  composerModel = "",
  fallbackModels = [],
  sendPending = false,
  // Same thread-scoping as composerErrors: Stopping… belongs to the thread that
  // was stopped, not whichever session is currently painted.
  stopPendingByThread = null,
  session,
  sessionView,
}) {
  const currentModelValue = composerModel || session?.model || "";
  const sessionModels = session?.available_models || [];
  // Keep the fetched same-provider catalogue on screen through a transiently
  // empty session snapshot. This stabilizes both the model label and the effort
  // choices derived from that model; the live session catalogue wins whenever
  // it has entries.
  const models = sessionModels.length ? sessionModels : fallbackModels;
  // The session's reasoning_effort is the source of truth. An empty composer
  // effort means "this surface hasn't overridden it" (e.g. you just opened the
  // session on another device), so fall back to the session value instead of
  // the model default — otherwise a high session silently shows/sends medium.
  const currentEffortValue = resolveReasoningEffortValue(
    models,
    currentModelValue,
    composerEffort || session?.reasoning_effort || ""
  );
  const working = sessionIsWorking(session);
  const threadId = session?.active_thread_id || null;
  // Pending only paints while THIS thread's turn is still up — once idle, Send
  // returns. Another thread's pending flag must not leak onto this composer.
  const stopping = Boolean(isStopPending(stopPendingByThread, threadId) && working);
  return {
    composerDisabled: sessionView.composerDisabled,
    currentDraft: composerDraft,
    currentApprovalId: sessionView.currentApprovalId,
    currentEffortValue,
    currentModelValue,
    errorMessage: threadError(composerErrors, session?.active_thread_id),
    heldMessage: threadError(composerHeld, session?.active_thread_id),
    effortOptions: buildReasoningEffortOptions(
      models,
      currentModelValue,
      currentEffortValue
    ),
    messagePlaceholder: sessionView.messagePlaceholder,
    models,
    sendDisabled: Boolean(session?.active_turn_id || stopping),
    sendPending,
    session,
    stopPending: stopping,
    stopVisible: Boolean(
      (working || stopping)
      && (!sessionView.composerDisabled || session?.view_only)
    ),
  };
}
