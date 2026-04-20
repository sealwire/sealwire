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

export function setThreads(threads) {
  patchRemoteState({
    threadsError: null,
    threads,
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

export function setComposerEffort(value) {
  patchRemoteState({
    composerEffort: value,
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
