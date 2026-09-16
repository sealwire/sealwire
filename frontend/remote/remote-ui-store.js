import { createStore } from "zustand/vanilla";
import { defaultModelForProvider } from "../shared/provider-settings.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
} from "../shared/last-used-settings.js";
import { loadDeviceLabel } from "./state.js";
import { notificationPermission } from "../shared/thread-notify.js";
import { pushSupported } from "./push-subscribe.js";
import {
  reconcileAllStopPending,
  reconcileStopPending,
  withoutStopPending,
  withStopPending,
} from "../shared/stop-pending.js";

export function createDefaultSessionDraft(provider = "codex") {
  return {
    approvalPolicy: loadLastApprovalPolicy(provider) || "untrusted",
    cwd: "",
    effort: loadLastEffort(provider) || "medium",
    initialPrompt: "",
    provider,
    model: defaultModelForProvider(provider),
    // Which project the new session is filed under. Seeded from the project the
    // UI is currently in when the dialog opens; null is the Default Workspace.
    projectId: null,
    sandbox: "workspace-write",
  };
}

export function createRemoteUiStore(initialState = {}) {
  return createStore((set, get) => ({
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
    settingsModalOpen: false,
    // Git standing of the launch dialog's chosen directory; null when unknown or
    // when the directory is not a repo.
    launchGitContext: null,
    // Bumped on every opening of either dialog. A DOM `open` check, or the fork's
    // source id, cannot tell a reopened dialog from the one a request started against.
    launchDialogGeneration: 0,
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
    sendPending: false,
    // Thread ids whose Stop was asked but whose turn has not idled yet. A single
    // boolean used to live here and was reconciled against whichever session was
    // on screen — stopping A then opening idle B cleared it, so returning to A
    // re-armed Stop (and opening working B wore A's Stopping… label).
    stopPendingByThread: {},
    // The bell used to live here as a byte-identical port of local's
    // `state.threadFilter`. It now lives once, in shared/thread-list-store.js — both
    // shells already own one of those stores, so neither shell has to declare the field.
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
    setSettingsModalOpen(open) {
      set({
        settingsModalOpen: Boolean(open),
      });
    },
    // Called by the open paths, not inferred inside setForkDialog: reopening on a
    // different thread while one is already showing is still a new opening.
    beginForkDialogOpening() {
      set((state) => ({
        forkDialog: {
          ...state.forkDialog,
          generation: (state.forkDialog.generation || 0) + 1,
        },
      }));
      return get().forkDialog.generation;
    },
    beginLaunchDialogOpening() {
      set((state) => ({ launchDialogGeneration: state.launchDialogGeneration + 1 }));
      return get().launchDialogGeneration;
    },
    setLaunchGitContext(context) {
      set({ launchGitContext: context || null });
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
    setSendPending(value) {
      set({
        sendPending: Boolean(value),
      });
    },
    markStopPending(threadId, turnMarker = true) {
      if (!threadId) return;
      set((state) => ({
        stopPendingByThread: withStopPending(
          state.stopPendingByThread,
          threadId,
          turnMarker
        ),
      }));
    },
    clearStopPending(threadId) {
      if (!threadId) return;
      set((state) => ({
        stopPendingByThread: withoutStopPending(state.stopPendingByThread, threadId),
      }));
    },
    reconcileStopPendingForThread(threadId, workingOrInfo) {
      if (!threadId) return;
      set((state) => ({
        stopPendingByThread: reconcileStopPending(
          state.stopPendingByThread,
          threadId,
          workingOrInfo
        ),
      }));
    },
    reconcileAllStopPending(resolve) {
      set((state) => ({
        stopPendingByThread: reconcileAllStopPending(
          state.stopPendingByThread,
          resolve
        ),
      }));
    },
    // One transition: provider, model and effort are a single decision, and each
    // intermediate state is both invalid and observable by subscribers.
    patchSessionDraft(patch) {
      set((state) => ({
        sessionDraft: { ...state.sessionDraft, ...(patch || {}) },
      }));
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
