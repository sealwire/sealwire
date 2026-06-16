import {
  allowedRootsInput,
  approvalPolicyInput,
  cwdInput,
  loadDirectoryButton,
  modelInput,
  openLaunchSettingsButton,
  providerInput,
  resumeLatestButton,
  saveAllowedRootsButton,
  sandboxInput,
  startEffortInput,
  startPromptInput,
  startSessionButton,
} from "./dom.js";
import { renderAllowedRoots } from "./render-security.js";
import { readLocalUiState } from "./ui-store.js";
import { createPollingController } from "./session/polling.js";
import { createStreamController } from "./session/stream.js";
import { createTranscriptController } from "./session/transcript.js";
import { createPairingController } from "./session/pairing.js";
import { createLifecycleController } from "./session/lifecycle.js";

export function createSessionController({
  state,
  apiFetch,
  queryClient = null,
  shortId,
  logLine,
  seedDefaults,
  setSelectedCwd,
  setThreadRoute,
  canCurrentDeviceWrite,
  renderSession,
  renderOverviewState,
  renderSessionUnavailable,
  renderThreadListMessage,
  renderThreads,
  renderAuthRequiredState,
  runViewTransition,
  handleUnauthorized,
}) {
  function setStartControlsBusy(busy) {
    [
      loadDirectoryButton,
      startSessionButton,
      resumeLatestButton,
      openLaunchSettingsButton,
      cwdInput,
      startPromptInput,
      modelInput,
      providerInput,
      approvalPolicyInput,
      sandboxInput,
      startEffortInput,
    ].forEach((element) => {
      if (element) {
        element.disabled = busy;
      }
    });
  }

  function isViewingConversation(session) {
    return Boolean(session?.active_thread_id && state.viewThreadId === session.active_thread_id);
  }

  function liveElement(id, fallback) {
    return document.getElementById(id) || fallback;
  }

  function isCurrentDeviceActiveController(session) {
    if (!session?.active_thread_id || !session.active_controller_device_id) {
      return false;
    }

    return session.active_controller_device_id === state.deviceId;
  }

  async function saveAllowedRoots() {
    const allowed_roots = (allowedRootsInput?.value || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (saveAllowedRootsButton) {
      saveAllowedRootsButton.disabled = true;
    }
    if (allowedRootsInput) {
      allowedRootsInput.disabled = true;
    }

    logLine(
      allowed_roots.length
        ? `Saving ${allowed_roots.length} allowed workspace root${allowed_roots.length === 1 ? "" : "s"}.`
        : "Clearing relay workspace restrictions."
    );

    try {
      const response = await apiFetch("/api/allowed-roots", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          allowed_roots,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to save allowed roots");
      }

      state.localUiStore.getState().setAllowedRootsDraftDirty(false);
      renderAllowedRoots(payload.data.allowed_roots || [], {
        draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
      });
      await ctx.loadSession("post-allowed-roots refresh");
      await ctx.loadThreads("post-allowed-roots refresh");
      logLine(payload.data?.message || "Relay workspace restrictions saved.");
    } catch (error) {
      logLine(`Allowed roots update failed: ${error.message}`);
    } finally {
      if (saveAllowedRootsButton) {
        saveAllowedRootsButton.disabled = false;
      }
      if (allowedRootsInput) {
        allowedRootsInput.disabled = false;
      }
    }
  }

  const ctx = {
    state,
    apiFetch,
    queryClient,
    shortId,
    logLine,
    seedDefaults,
    setSelectedCwd,
    setThreadRoute,
    canCurrentDeviceWrite,
    renderSession,
    renderOverviewState,
    renderSessionUnavailable,
    renderThreadListMessage,
    renderThreads,
    renderAuthRequiredState,
    runViewTransition,
    handleUnauthorized,
    setStartControlsBusy,
    liveElement,
    isViewingConversation,
    isCurrentDeviceActiveController,
  };

  const polling = createPollingController(ctx);
  const stream = createStreamController(ctx);
  const transcriptController = createTranscriptController(ctx);
  const pairing = createPairingController(ctx);
  const lifecycle = createLifecycleController(ctx);
  const controller = {
    ...polling,
    ...stream,
    ...transcriptController,
    ...pairing,
    ...lifecycle,
    saveAllowedRoots,
  };
  Object.assign(ctx, controller);

  return {
    cancelControllerHeartbeat: controller.cancelControllerHeartbeat,
    cancelControllerLeaseRefresh: controller.cancelControllerLeaseRefresh,
    cancelSessionPoll: controller.cancelSessionPoll,
    cancelStreamReconnect: controller.cancelStreamReconnect,
    cancelThreadsPoll: controller.cancelThreadsPoll,
    connectSessionStream: controller.connectSessionStream,
    copyPairingLink: controller.copyPairingLink,
    decidePairingRequest: controller.decidePairingRequest,
    ensureConversationTranscript: controller.ensureConversationTranscript,
    loadSession: controller.loadSession,
    loadThreads: controller.loadThreads,
    maybeLoadOlderTranscript: controller.maybeLoadOlderTranscript,
    resumeLatestSession: controller.resumeLatestSession,
    resumeSession: controller.resumeSession,
    revokeOtherDevices: controller.revokeOtherDevices,
    revokePairedDevice: controller.revokePairedDevice,
    saveAllowedRoots: controller.saveAllowedRoots,
    scheduleControllerHeartbeat: controller.scheduleControllerHeartbeat,
    scheduleControllerLeaseRefresh: controller.scheduleControllerLeaseRefresh,
    scheduleSessionPoll: controller.scheduleSessionPoll,
    scheduleThreadsPoll: controller.scheduleThreadsPoll,
    sendMessage: controller.sendMessage,
    requestReview: controller.requestReview,
    resolveReview: controller.resolveReview,
    deleteReview: controller.deleteReview,
    fetchTranscriptPage: controller.fetchTranscriptPage,
    stopActiveTurn: controller.stopActiveTurn,
    startPairing: controller.startPairing,
    startSession: controller.startSession,
    submitAskUserQuestionAnswer: controller.submitAskUserQuestionAnswer,
    submitDecision: controller.submitDecision,
    takeOverControl: controller.takeOverControl,
    toggleTranscriptEntry: controller.toggleTranscriptEntry,
    toggleTranscriptExpandKey: controller.toggleTranscriptExpandKey,
    ensureFileChangeDetail: controller.ensureFileChangeDetail,
    applyFileChange: controller.applyFileChange,
    updateSessionSettings: controller.updateSessionSettings,
  };
}
