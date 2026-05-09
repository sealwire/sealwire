import { createStore } from "zustand/vanilla";
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

export function createRemoteUiStore(initialState = {}) {
  return createStore((set) => ({
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
    ...initialState,
    clearComposerDraft() {
      set({
        composerDraft: "",
      });
    },
    resetPairingInput() {
      set({
        pairingInputValue: "",
      });
    },
    setComposerDraft(value) {
      set({
        composerDraft: value || "",
      });
    },
    setComposerEffort(value) {
      set({
        composerEffort: value || "medium",
      });
    },
    setDeviceLabelDraft(value) {
      set({
        deviceLabelDraft: value || "",
      });
    },
    setPairingInputValue(value) {
      set({
        pairingInputValue: value || "",
      });
    },
    setPairingModalOpen(open) {
      set({
        pairingModalOpen: Boolean(open),
      });
    },
    setRemoteInfoModalOpen(open) {
      set({
        remoteInfoModalOpen: Boolean(open),
      });
    },
    setSendPending(value) {
      set({
        sendPending: Boolean(value),
      });
    },
    setSessionDraftField(field, value) {
      set((state) => ({
        sessionDraft: {
          ...state.sessionDraft,
          [field]: value,
        },
      }));
    },
    setSessionPanelOpen(open) {
      set({
        sessionPanelOpen: Boolean(open),
      });
    },
    setSessionStartPending(value) {
      set({
        sessionStartPending: Boolean(value),
      });
    },
  }));
}
