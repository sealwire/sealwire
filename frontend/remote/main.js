import * as dom from "./dom.js";
import {
  closeRemoteNavigation,
  initializeRemoteNavigation,
  openRemoteNavigation,
  toggleRemoteNavigation,
} from "./navigation.js";
import {
  configureBrokerClient,
  closeBrokerSocket,
  connectBroker,
  refreshRelayDirectory,
} from "./broker-client.js";
import {
  clearClaimLifecycle,
  configureRemoteActions,
  handleRemoteBrokerPayload,
  recoverRemoteSession,
  rejectPendingActions,
} from "./actions.js";
import {
  applyPairingQuery,
  beginPairing,
  forgetCurrentDevice,
  handleEncryptedPairingResult,
  sendPairingRequest,
} from "./pairing.js";
import { registerRemotePwa } from "./pwa.js";
import {
  configureRenderHandlers,
  handleTranscriptScroll,
  renderDeviceMeta,
  renderEmptyState,
  renderLog,
  renderRelayDirectory,
  renderThreads,
  setRemoteSessionPanelOpen,
} from "./render.js";
import {
  applySessionSnapshot,
  clearSessionRuntime,
  refreshRemoteThreads,
  resumeRemoteSession,
  sendMessage,
  startRemoteSession,
  submitDecision,
  syncRemoteSnapshot,
  takeOverControl,
} from "./session-ops.js";
import {
  clearActiveRelaySelection,
  ensureDeviceIdentity,
  hydrateStoredRemoteSecrets,
  loadDeviceLabel,
  selectRelayProfile,
  state,
} from "./state.js";

configureRenderHandlers({
  onResumeThread(threadId) {
    closeRemoteNavigation();
    void resumeRemoteSession(threadId);
  },
  onSelectRelay(relayId) {
    closeRemoteNavigation();
    void switchRelay(relayId);
  },
});

configureBrokerClient({
  onBrokerReady(frame, reason) {
    if (state.pairingTicket) {
      void sendPairingRequest();
      return;
    }

    if (state.remoteAuth) {
      const relayPresent = Array.isArray(frame?.peers)
        && frame.peers.some((peer) => peer?.role === "relay");
      if (!relayPresent) {
        renderLog("Broker is ready; waiting for the relay peer before recovering this session.");
        return;
      }
      void recoverRemoteSession(`broker ${reason}`);
    }
  },
  onBrokerPayload(payload) {
    return handleBrokerPayload(payload);
  },
  onBrokerDisconnect() {
    clearClaimLifecycle();
    rejectPendingActions("broker socket disconnected");
  },
  onRelayPresence(kind, peer) {
    if (kind === "joined" && peer?.role === "relay" && state.remoteAuth) {
      void recoverRemoteSession("relay joined");
    }
  },
});

configureRemoteActions({
  onApplySessionSnapshot: applySessionSnapshot,
  onSyncRemoteSnapshot: syncRemoteSnapshot,
});

dom.pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginPairing(dom.pairingInput.value);
});

dom.openPairingModalBtn?.addEventListener("click", () => {
  dom.pairingModal?.showModal();
});

dom.closePairingModalBtn?.addEventListener("click", () => {
  dom.pairingModal?.close();
});

dom.pairingModal?.addEventListener("click", (event) => {
  if (event.target === dom.pairingModal) {
    dom.pairingModal.close();
  }
});

dom.forgetDeviceButton.addEventListener("click", () => {
  forgetCurrentDevice();
});

dom.remoteSessionToggle.addEventListener("click", () => {
  setRemoteSessionPanelOpen(dom.remoteSessionPanel.hidden);
});

dom.remoteNavToggleButton?.addEventListener("click", () => {
  toggleRemoteNavigation();
});

dom.remoteNavBackdrop?.addEventListener("click", () => {
  closeRemoteNavigation();
});

dom.remoteInfoButton?.addEventListener("click", () => {
  dom.remoteInfoModal?.showModal();
});

dom.closeRemoteInfoModalBtn?.addEventListener("click", () => {
  dom.remoteInfoModal?.close();
});

dom.remoteInfoModal?.addEventListener("click", (event) => {
  if (event.target === dom.remoteInfoModal) {
    dom.remoteInfoModal.close();
  }
});

dom.remoteStartSessionButton.addEventListener("click", () => {
  void startRemoteSession();
});

dom.remoteThreadsRefreshButton.addEventListener("click", () => {
  void refreshRemoteThreads("manual refresh");
});

dom.remoteRelaysRefreshButton.addEventListener("click", () => {
  void refreshRelayDirectoryFromUi();
});

dom.remoteHomeButton?.addEventListener("click", () => {
  returnToRelayHome();
});

dom.remoteTakeOverButton.addEventListener("click", () => {
  void takeOverControl();
});

dom.remoteMessageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

dom.remoteTranscript.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (!approvalButton) {
    return;
  }

  void submitDecision(
    approvalButton.dataset.approvalDecision,
    approvalButton.dataset.approvalScope || "once"
  );
});

dom.remoteTranscript.addEventListener("scroll", () => {
  handleTranscriptScroll();
});

void boot();

async function boot() {
  if (!window.crypto?.getRandomValues) {
    renderLog("Secure random bytes are unavailable in this browser. Remote pairing cannot start here.");
  }
  try {
    await ensureDeviceIdentity();
  } catch (error) {
    renderLog(`Device identity could not be initialized: ${error.message}`);
  }
  try {
    await hydrateStoredRemoteSecrets();
  } catch (error) {
    renderLog(`Stored relay secrets could not be restored: ${error.message}`);
  }
  void registerRemotePwa();

  dom.deviceLabelInput.value = loadDeviceLabel();
  initializeRemoteNavigation();
  setRemoteSessionPanelOpen(false);
  const pairingQuery = applyPairingQuery();
  renderDeviceMeta();
  renderRelayDirectory();
  renderEmptyState();
  renderThreads([]);

  if (pairingQuery) {
    await beginPairing(pairingQuery, { auto: true });
    return;
  }

  if (state.clientAuth) {
    try {
      await refreshRelayDirectory("initial boot", { silent: true });
      renderRelayDirectory();
    } catch (error) {
      renderLog(`Relay directory refresh failed: ${error.message}`);
    }
  }

  if (state.remoteAuth) {
    void connectBroker("initial boot");
  }
}

async function handleBrokerPayload(payload) {
  if (payload?.kind === "encrypted_pairing_result") {
    await handleEncryptedPairingResult(payload);
    return;
  }

  await handleRemoteBrokerPayload(payload);
}

async function switchRelay(relayId) {
  if (!relayId || state.remoteAuth?.relayId === relayId) {
    return;
  }

  if (!selectRelayProfile(relayId)) {
    renderLog("This relay is not stored in the current browser profile yet.");
    return;
  }

  clearClaimLifecycle();
  clearSessionRuntime();
  rejectPendingActions("switched to a different relay profile");
  state.session = null;
  state.threads = [];
  state.currentApprovalId = null;
  renderDeviceMeta();
  renderEmptyState();
  renderThreads([]);
  renderLog(`Switching to relay ${relayId}.`);
  void connectBroker("switch relay");
}

function returnToRelayHome() {
  if (!state.remoteAuth) {
    return;
  }

  clearClaimLifecycle();
  clearSessionRuntime();
  rejectPendingActions("returned to relay directory before broker actions completed");
  state.session = null;
  state.threads = [];
  state.currentApprovalId = null;
  clearActiveRelaySelection();
  closeBrokerSocket();
  openRemoteNavigation();
  setRemoteSessionPanelOpen(false);
  renderDeviceMeta();
  renderEmptyState();
  renderThreads([]);
  renderLog("Returned to relay directory.");
}

async function refreshRelayDirectoryFromUi() {
  try {
    await refreshRelayDirectory("manual refresh");
    renderDeviceMeta();
  } catch (error) {
    renderLog(`Relay directory refresh failed: ${error.message}`);
  }
}
