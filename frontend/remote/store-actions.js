import { patchRemoteState, readRemoteState } from "./state.js";

export function updateSessionDraftField(field, value) {
  patchRemoteState({
    sessionDraft: {
      ...readRemoteState().sessionDraft,
      [field]: value,
    },
  });
}

export function setSessionPanelOpen(open) {
  patchRemoteState({
    sessionPanelOpen: Boolean(open),
  });
}

export function setSessionStartPending(value) {
  patchRemoteState({
    sessionStartPending: Boolean(value),
  });
}

export function setThreads(threads) {
  patchRemoteState({
    threadsError: null,
    threads,
  });
}

export function beginThreadsRefresh() {
  patchRemoteState({
    threadsError: null,
    threadsRefreshPending: true,
  });
}

export function finishThreadsRefresh() {
  patchRemoteState({
    threadsRefreshPending: false,
  });
}

export function failThreadsRefresh(message) {
  patchRemoteState({
    threads: [],
    threadsError: message,
    threadsRefreshPending: false,
  });
}

export function setThreadsFilterValue(value) {
  patchRemoteState({
    threadsFilterValue: value,
  });
}

export function setComposerDraft(value) {
  patchRemoteState({
    composerDraft: value,
  });
}

export function clearComposerDraft() {
  patchRemoteState({
    composerDraft: "",
  });
}

export function setComposerEffort(value) {
  patchRemoteState({
    composerEffort: value,
  });
}

export function setSendPending(value) {
  patchRemoteState({
    sendPending: Boolean(value),
  });
}

export function setPairingModalOpen(open) {
  patchRemoteState({
    pairingModalOpen: Boolean(open),
  });
}

export function setRemoteInfoModalOpen(open) {
  patchRemoteState({
    remoteInfoModalOpen: Boolean(open),
  });
}

export function setPairingInputValue(value) {
  patchRemoteState({
    pairingInputValue: value,
  });
}

export function setDeviceLabelDraft(value) {
  patchRemoteState({
    deviceLabelDraft: value,
  });
}

export function setControllerHeartbeatTimer(timerId) {
  patchRemoteState({
    controllerHeartbeatTimer: timerId || null,
  });
}

export function clearControllerHeartbeatTimer() {
  patchRemoteState({
    controllerHeartbeatTimer: null,
  });
}

export function setControllerLeaseRefreshTimer(timerId) {
  patchRemoteState({
    controllerLeaseRefreshTimer: timerId || null,
  });
}

export function clearControllerLeaseRefreshTimer() {
  patchRemoteState({
    controllerLeaseRefreshTimer: null,
  });
}
