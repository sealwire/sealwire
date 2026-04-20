import { loadDeviceLabel } from "./state.js";

export function createDefaultSessionDraft() {
  return {
    approvalPolicy: "untrusted",
    cwd: "",
    effort: "medium",
    initialPrompt: "",
    model: "gpt-5.4",
    sandbox: "workspace-write",
  };
}

export function createInitialRemoteUiState() {
  return {
    composerDraft: "",
    composerEffort: "medium",
    deviceLabelDraft: loadDeviceLabel(),
    pairingInputValue: "",
    pairingModalOpen: false,
    remoteInfoModalOpen: false,
    sendPending: false,
    sessionDraft: createDefaultSessionDraft(),
    sessionPanelOpen: false,
    sessionStartPending: false,
    threadsError: null,
    threadsFilterValue: "",
    threadsRefreshPending: false,
  };
}

export function reduceRemoteUiState(state, action) {
  switch (action.type) {
    case "composer/setDraft":
      return {
        ...state,
        composerDraft: action.value,
      };
    case "composer/clearDraft":
      return {
        ...state,
        composerDraft: "",
      };
    case "composer/setEffort":
      return {
        ...state,
        composerEffort: action.value,
      };
    case "pairing/setDeviceLabelDraft":
      return {
        ...state,
        deviceLabelDraft: action.value,
      };
    case "pairing/setInputValue":
      return {
        ...state,
        pairingInputValue: action.value,
      };
    case "pairing/setModalOpen":
      return {
        ...state,
        pairingModalOpen: Boolean(action.open),
      };
    case "pairing/resetInput":
      return {
        ...state,
        pairingInputValue: "",
      };
    case "remoteInfo/setOpen":
      return {
        ...state,
        remoteInfoModalOpen: Boolean(action.open),
      };
    case "session/setDraftField":
      return {
        ...state,
        sessionDraft: {
          ...state.sessionDraft,
          [action.field]: action.value,
        },
      };
    case "session/setPanelOpen":
      return {
        ...state,
        sessionPanelOpen: Boolean(action.open),
      };
    case "session/setStartPending":
      return {
        ...state,
        sessionStartPending: Boolean(action.value),
      };
    case "send/setPending":
      return {
        ...state,
        sendPending: Boolean(action.value),
      };
    case "threads/setFilterValue":
      return {
        ...state,
        threadsFilterValue: action.value,
      };
    case "threads/startRefresh":
      return {
        ...state,
        threadsError: null,
        threadsRefreshPending: true,
      };
    case "threads/finishRefresh":
      return {
        ...state,
        threadsRefreshPending: false,
      };
    case "threads/failRefresh":
      return {
        ...state,
        threadsError: action.message,
        threadsRefreshPending: false,
      };
    case "threads/clearError":
      return {
        ...state,
        threadsError: null,
      };
    default:
      return state;
  }
}
