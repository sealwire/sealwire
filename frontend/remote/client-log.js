import { mapRelayLogEntries } from "../shared/client-log-merge.js";
import { patchRemoteState, state } from "./state.js";

/**
 * Whether the broker's frame-by-frame diagnostics should be written.
 *
 * Every `renderLog` is a `patchRemoteState`, which notifies the store behind
 * `useSyncExternalStore` — one full RemoteApp re-render per line. That is far too
 * expensive to spend on per-frame tracing, so the tracing lives behind this flag.
 * One definition, because three modules gate on it and they must agree.
 */
export function isVerboseBrokerLoggingEnabled() {
  return typeof window !== "undefined" && window.__agentRelayVerboseBrokerLogs === true;
}

export function renderEmptyState() {
  patchRemoteState({
    session: null,
  });
}

export function renderLog(message) {
  patchRemoteState({
    clientLogs: [{ at: Date.now(), text: message }, ...state.clientLogs].slice(0, 400),
  });
}

export function renderLogs(entries) {
  patchRemoteState({
    clientLogs: mapRelayLogEntries(entries),
  });
}
