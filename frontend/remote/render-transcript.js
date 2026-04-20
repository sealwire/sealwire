import { patchRemoteState, state } from "./state.js";

export function renderEmptyState() {
  patchRemoteState({
    session: null,
  });
}

export function renderLog(message) {
  const time = new Date().toLocaleTimeString();
  patchRemoteState({
    clientLogs: [`${time}  ${message}`, ...state.clientLogs].slice(0, 400),
  });
}

export function renderLogs(entries) {
  patchRemoteState({
    clientLogs: entries.map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    ),
  });
}
