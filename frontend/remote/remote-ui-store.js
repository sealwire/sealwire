import { createStore } from "zustand/vanilla";
import { defaultModelForProvider } from "../shared/provider-settings.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
} from "../shared/last-used-settings.js";
import { loadDeviceLabel } from "./state.js";
import { notificationPermission } from "../shared/thread-notify.js";
import { pushSupported } from "./push-subscribe.js";

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
    forkDialog: {
      open: false,
      pending: false,
      sourceThread: null,
      fields: null,
      error: "",
    },
    remoteInfoModalOpen: false,
    providerModels: {},
    // Per-provider catalog fetch status: "loading" | "ready" | "error".
    // Lets the new-session dialog show a truthful state instead of silently
    // presenting a single fallback model when a fetch is pending or failed.
    providerModelsStatus: {},
    providers: [],
    // Web Push / PWA notification state. Initialized from feature detection and
    // the current Notification permission (both guarded so a Node/SSR import is
    // safe).
    pushSupported: pushSupported(),
    pushPermission: notificationPermission(),
    pushSubscribed: false,
    pushBusy: false,
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
    setForkDialog(next) {
      set((state) => ({
        forkDialog: {
          ...state.forkDialog,
          ...(next || {}),
        },
      }));
    },
    closeForkDialog() {
      set({
        forkDialog: {
          open: false,
          pending: false,
          sourceThread: null,
          fields: null,
          error: "",
        },
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
    setProviderModelsStatus(provider, status) {
      set((state) => ({
        providerModelsStatus: {
          ...state.providerModelsStatus,
          [provider]: status,
        },
      }));
    },
    setProviders(providers) {
      set({
        providers: providers || [],
      });
    },
    setPushSupported(value) {
      set({
        pushSupported: Boolean(value),
      });
    },
    setPushPermission(value) {
      set({
        pushPermission: value || "default",
      });
    },
    setPushSubscribed(value) {
      set({
        pushSubscribed: Boolean(value),
      });
    },
    setPushBusy(value) {
      set({
        pushBusy: Boolean(value),
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
