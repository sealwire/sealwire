import * as dom from "./dom.js";
import {
  closeRemoteNavigation,
  initializeRemoteNavigation,
  openRemoteNavigation,
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
  renderDeviceMeta,
  renderEmptyState,
  renderLog,
  renderRelayDirectory,
  renderThreads,
  setRemoteSessionPanelOpen,
  setLegacyRemoteRenderBridgeEnabled,
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
import { mountBuildBadge } from "../shared/build-badge.js";
import {
  clearActiveRelaySelection,
  ensureDeviceIdentity,
  hydrateStoredRemoteSecrets,
  loadDeviceLabel,
  selectRelayProfile,
  state,
} from "./state.js";
import {
  applyRemoteSurfacePatch,
  createResetRemoteSurfaceStatePatch,
} from "./surface-state.js";
import { mountRemoteApp } from "./react-app.js";

mountRemoteApp({
  onRefreshRelayDirectory() {
    void refreshRelayDirectoryFromUi();
  },
  onRefreshThreads() {
    void refreshRemoteThreads("manual refresh");
  },
  onResumeThread(threadId) {
    void resumeRemoteSession(threadId);
  },
  onReturnHome() {
    returnToRelayHome();
  },
  onSelectRelay(relayId) {
    void switchRelay(relayId);
  },
  onSendMessage() {
    void sendMessage();
  },
  onStartSession() {
    void startRemoteSession();
  },
  onSubmitDecision(decision, scope) {
    void submitDecision(decision, scope);
  },
  onTakeOver() {
    void takeOverControl();
  },
});
setLegacyRemoteRenderBridgeEnabled(false);

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

void mountBuildBadge({
  surface: "remote",
});

void boot();

installSidebarGestureDebug();

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

function installSidebarGestureDebug() {
  const targets = [
    ["sidebar", dom.sidebar],
    ["relays", dom.remoteRelaysList],
    ["threads", dom.remoteThreadsList],
  ];

  const describeNode = (node) => {
    if (!(node instanceof Element)) {
      return node?.nodeName || "-";
    }

    const tag = node.tagName || "-";
    const id = node.id ? `#${node.id}` : "";
    const classNames = typeof node.className === "string"
      ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".")
      : "";
    const classes = classNames ? `.${classNames}` : "";
    return `${tag}${id}${classes}`;
  };

  const describeEventTarget = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const elements = path.filter((entry) => entry instanceof Element).slice(0, 4);
    if (elements.length) {
      return elements.map((entry) => describeNode(entry)).join(" -> ");
    }
    return describeNode(event.target);
  };

  const logGestureEvent = (scope, event) => {
    const target = describeEventTarget(event);
    const current = describeNode(event.currentTarget);
    const sidebarTop = dom.sidebar?.scrollTop ?? -1;
    const relaysTop = dom.remoteRelaysList?.scrollTop ?? -1;
    const threadsTop = dom.remoteThreadsList?.scrollTop ?? -1;
    const message = `[sidebar-debug] ${scope} type=${event.type} target=${target} current=${current} sidebarTop=${sidebarTop} relaysTop=${relaysTop} threadsTop=${threadsTop}`;
    console.log(message);
    renderLog(message);
  };

  const logScrollEvent = (scope, element) => {
    const message = `[sidebar-debug] ${scope} type=scroll current=${describeNode(element)} top=${element.scrollTop} height=${element.scrollHeight} client=${element.clientHeight}`;
    console.log(message);
    renderLog(message);
  };

  for (const [name, element] of targets) {
    if (!element) {
      continue;
    }

    element.addEventListener("pointerdown", (event) => {
      logGestureEvent(name, event);
    }, { passive: true });
    element.addEventListener("touchstart", (event) => {
      logGestureEvent(name, event);
    }, { passive: true });
    element.addEventListener("wheel", (event) => {
      logGestureEvent(name, event);
    }, { passive: true });
    element.addEventListener("scroll", () => {
      logScrollEvent(name, element);
    }, { passive: true });
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

  applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
    clearClaimLifecycle,
    clearSessionRuntime,
    rejectPendingActions,
    reason: "switched to a different relay profile",
  }));
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

  applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
    clearClaimLifecycle,
    clearSessionRuntime,
    rejectPendingActions,
    reason: "returned to relay directory before broker actions completed",
  }));
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
