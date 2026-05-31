import { createStore } from "zustand/vanilla";
import { defaultModelForProvider } from "../shared/provider-settings.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
} from "../shared/last-used-settings.js";
import { loadDeviceLabel } from "./state.js";

export function createDefaultSessionDraft(provider = "codex") {
  return {
    approvalPolicy: loadLastApprovalPolicy(provider) || "untrusted",
    cwd: "",
    effort: loadLastEffort(provider) || "medium",
    initialPrompt: "",
    provider,
    model: defaultModelForProvider(provider),
    sandbox: "workspace-write",
  };
}

export function createRemoteUiStore(initialState = {}) {
  return createStore((set) => ({
    composerDraft: "",
    // Empty = "this surface hasn't overridden the session's effort". Readers
    // fall back to session.reasoning_effort, so opening a session on a new
    // device shows/sends its real effort instead of a hardcoded medium.
    composerEffort: "",
    composerModel: "",
    deviceLabelDraft: loadDeviceLabel(),
    pairingInputValue: "",
    pairingModalOpen: false,
    remoteInfoModalOpen: false,
    providerModels: {},
    providers: [],
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
        composerEffort: value || "",
      });
    },
    setComposerModel(value) {
      set({
        composerModel: value || "",
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
    setProviderModels(provider, models) {
      set((state) => ({
        providerModels: {
          ...state.providerModels,
          [provider]: models || [],
        },
      }));
    },
    setProviders(providers) {
      set({
        providers: providers || [],
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
