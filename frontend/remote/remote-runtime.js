import { mountBuildBadge } from "../shared/build-badge.js";
import { clearClaimLifecycle, configureRemoteActions, handleRemoteBrokerPayload, recoverRemoteSession, rejectPendingActions } from "./actions.js";
import { closeBrokerSocket, configureBrokerClient, connectBroker, refreshRelayDirectory } from "./broker-client.js";
import { initializeRemoteNavigation, openRemoteNavigation } from "./navigation.js";
import { applyPairingQuery, beginPairing, forgetCurrentDevice, handleEncryptedPairingResult, sendPairingRequest } from "./pairing.js";
import { registerRemotePwa } from "./pwa.js";
import { renderLog } from "./render.js";
import { applySessionSnapshot, applyTranscriptDelta, clearSessionRuntime, fetchTranscriptEntryDetail, refreshRemoteThreads, resumeRemoteSession, sendMessage, startRemoteSession, submitDecision, syncRemoteSnapshot, takeOverControl } from "./session-ops.js";
import { clearActiveRelaySelection, ensureDeviceIdentity, hydrateStoredRemoteSecrets, selectRelayProfile, state } from "./state.js";
import { applyRemoteSurfacePatch, createResetRemoteSurfaceStatePatch } from "./surface-state.js";

let runtimeConfigured = false;
let buildBadgeMounted = false;

export function ensureRemoteRuntimeConfigured() {
  if (runtimeConfigured) {
    return;
  }

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
    onApplyTranscriptDelta: applyTranscriptDelta,
    onSyncRemoteSnapshot: syncRemoteSnapshot,
  });

  if (!buildBadgeMounted) {
    buildBadgeMounted = true;
    void mountBuildBadge({
      surface: "remote",
    });
  }

  runtimeConfigured = true;
}

export function initializeRemoteSurface() {
  initializeRemoteNavigation();
  ensureRemoteRuntimeConfigured();
}

export async function bootRemoteRuntime() {
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

  const pairingQuery = applyPairingQuery();

  if (pairingQuery) {
    await beginPairing(pairingQuery, { auto: true });
    return;
  }

  if (state.clientAuth) {
    try {
      await refreshRelayDirectory("initial boot", { silent: true });
    } catch (error) {
      renderLog(`Relay directory refresh failed: ${error.message}`);
    }
  }

  if (state.remoteAuth) {
    void connectBroker("initial boot");
  }
}

export async function refreshRelayDirectoryFromUi() {
  try {
    await refreshRelayDirectory("manual refresh");
  } catch (error) {
    renderLog(`Relay directory refresh failed: ${error.message}`);
  }
}

export async function switchRemoteRelay(relayId) {
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
  renderLog(`Switching to relay ${relayId}.`);
  void connectBroker("switch relay");
}

export function returnToRelayHome() {
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
  renderLog("Returned to relay directory.");
}

export function createRemoteAppHandlers() {
  return {
    onBeginPairing(rawValue, deviceLabel) {
      return beginPairing(rawValue, { deviceLabel });
    },
    onForgetDevice() {
      forgetCurrentDevice();
    },
    onRefreshRelayDirectory() {
      return refreshRelayDirectoryFromUi();
    },
    onRefreshThreads(filterValue, { reason = "manual refresh", silent = false } = {}) {
      return refreshRemoteThreads(reason, { filterValue, silent });
    },
    onFetchTranscriptEntryDetail(threadId, itemId) {
      return fetchTranscriptEntryDetail(threadId, itemId);
    },
    onResumeThread(threadId, sessionDraft) {
      return resumeRemoteSession(threadId, sessionDraft);
    },
    onReturnHome() {
      return returnToRelayHome();
    },
    onSelectRelay(relayId) {
      return switchRemoteRelay(relayId);
    },
    onSendMessage(messageDraft, effort) {
      return sendMessage(messageDraft, effort);
    },
    onStartSession(sessionDraft) {
      return startRemoteSession(sessionDraft);
    },
    onSubmitDecision(decision, scope) {
      return submitDecision(decision, scope);
    },
    onTakeOver() {
      return takeOverControl();
    },
  };
}

export function installSidebarGestureDebug() {
  const sidebar = document.querySelector(".sidebar");
  const remoteRelaysList = document.querySelector("#remote-relays-list");
  const remoteThreadsList = document.querySelector("#remote-threads-list");
  const targets = [
    ["sidebar", sidebar],
    ["relays", remoteRelaysList],
    ["threads", remoteThreadsList],
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
    const sidebarTop = sidebar?.scrollTop ?? -1;
    const relaysTop = remoteRelaysList?.scrollTop ?? -1;
    const threadsTop = remoteThreadsList?.scrollTop ?? -1;
    const message = `[sidebar-debug] ${scope} type=${event.type} target=${target} current=${current} sidebarTop=${sidebarTop} relaysTop=${relaysTop} threadsTop=${threadsTop}`;
    console.log(message);
    renderLog(message);
  };

  const logScrollEvent = (scope, element) => {
    const message = `[sidebar-debug] ${scope} type=scroll current=${describeNode(element)} top=${element.scrollTop} height=${element.scrollHeight} client=${element.clientHeight}`;
    console.log(message);
    renderLog(message);
  };

  const cleanups = [];

  for (const [name, element] of targets) {
    if (!element) {
      continue;
    }

    const onPointerDown = (event) => {
      logGestureEvent(name, event);
    };
    const onTouchStart = (event) => {
      logGestureEvent(name, event);
    };
    const onWheel = (event) => {
      logGestureEvent(name, event);
    };
    const onScroll = () => {
      logScrollEvent(name, element);
    };

    element.addEventListener("pointerdown", onPointerDown, { passive: true });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("scroll", onScroll, { passive: true });

    cleanups.push(() => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("scroll", onScroll);
    });
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

async function handleBrokerPayload(payload) {
  if (payload?.kind === "encrypted_pairing_result") {
    await handleEncryptedPairingResult(payload);
    return;
  }

  await handleRemoteBrokerPayload(payload);
}
