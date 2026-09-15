import { abandonStalledClaim, clearClaimLifecycle, configureRemoteActions, handleRemoteBrokerPayload, recoverRemoteSession, rejectPendingActions, resendPendingActions, suspendPendingActionDeadlines } from "./actions.js";
import { closeBrokerSocket, configureBrokerClient, connectBroker, refreshRelayDirectory } from "./broker-client.js";
import { replaceRemoteIdentity } from "./identity-change.js";
import { initializeRemoteNavigation, openRemoteNavigation } from "./navigation.js";
import { initializeRemotePointerClass } from "./pointer-mode.js";
import { applyPairingQuery, beginPairing, forgetCurrentDevice, handleEncryptedPairingResult, sendPairingRequest } from "./pairing.js";
import { mountIosInstallHint } from "./ios-install.js";
import { registerRemotePwa } from "./pwa.js";
import { renderLog } from "./session-surface.js";
import { sidebarGestureDebugEnabled } from "./sidebar-debug-flag.js";
import { applyFileChange, applySessionSnapshot, applyTranscriptDelta, applyTranscriptEvent, cancelRemoteThreadSearch, cancelRemoteThreadsPoll, clearSessionRuntime, delegateRemote, deleteRemoteReview, fetchAskDetail, fetchAskUserQuestionDetail, fetchRemoteProviderModels, fetchRemoteProviders, fetchRemoteThreadTranscript, fetchTranscriptEntryDetail, forkRemoteSession, probeRemoteThreadsExist, refreshRemoteThreads, repairRemoteWorkspace, requestRemoteReview, resolveRemoteReview, resolveRemoteWorkflow, resetDeclaredWatchedThreads, resumeRemoteSession, sendMessage, beginGoalActionOn, clearGoalErrorOn, setComposerError, setGoalError, setRemoteGoal, startRemoteSession, startRemoteWorkflow, stopActiveTurn, stopRemoteGoal, submitAskUserAnswer, submitDecision, syncRemoteSnapshot, takeOverControl, updateRemoteSessionSettings, viewRemoteThread } from "./session-ops.js";
import { clearActiveRelaySelection, ensureDeviceIdentity, hasActivePairing, hydrateStoredRemoteSecrets, selectRelayProfile, state } from "./state.js";
import { applyRemoteSurfacePatch, createResetRemoteSurfaceStatePatch } from "./surface-state.js";

let runtimeConfigured = false;

/// What this browser must do about the RELAY coming and going, as opposed to its own
/// socket. Exported so the recovery it owes can be tested: none of it is observable
/// through the socket, and all of it is state the relay drops on its side.
export function handleRelayPresence(kind, peer) {
  if (peer?.role !== "relay") {
    return;
  }
  // Pairing first, because it is the case with no `remoteAuth` to check: the request is
  // sent once and is not a pending action, so if the relay's session ended before it was
  // acted on, nothing else ever asks again and this browser waits for an approval the
  // laptop was never shown.
  if (hasActivePairing()) {
    if (kind === "joined") {
      void sendPairingRequest().catch((error) => {
        renderLog(`Pairing request could not be re-sent: ${error.message}`);
      });
    }
    return;
  }
  if (!state.remoteAuth) {
    return;
  }
  if (kind === "joined") {
    // Before recovery, because recovery awaits the claim and a challenge left over from
    // the relay's previous session is one nobody will ever answer.
    abandonStalledClaim();
    void recoverRemoteSession("relay joined");
    // Anything still unanswered is asked again under its ORIGINAL action id, so a
    // reply lost while the relay was away is served from its replay cache rather
    // than by running the action a second time.
    void resendPendingActions();
    return;
  }
  // The relay ending its own session — which is what a dropped publish now causes —
  // leaves this browser's socket up, so nothing else here notices. Without this the
  // pending action just waits out its deadline and reports a failure the user is
  // liable to answer by redoing a write.
  suspendPendingActionDeadlines();
  // The relay drops every broker watch set with its connection, and a declaration is
  // not a pending action, so nothing above brings it back. The dedupe key is this
  // browser's own peer id, which has not changed — so without this the phone believes
  // the set is already declared and the thread on screen stops receiving deltas.
  resetDeclaredWatchedThreads();
}

export function ensureRemoteRuntimeConfigured() {
  if (runtimeConfigured) {
    return;
  }

  configureBrokerClient({
    onBrokerReady(frame, reason, connection) {
      // Decided by what THIS socket was opened for, not by a global predicate. A
      // retired/expired ticket stays in state for its error card, and when a device
      // profile also exists a clock-dependent check would flip mid-connection and
      // recover the old session over the PAIRING room (or send a dead pairing request
      // into the device's room). `connection.kind` cannot drift.
      if (connection?.kind === "pairing") {
        // Catch rather than `void`: the request re-validates its attempt before
        // publishing, but a socket torn down underneath it still rejects.
        void sendPairingRequest().catch((error) => {
          renderLog(`Pairing request could not be sent: ${error.message}`);
        });
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
      // Stop the recurring thread poll while the socket is down; recovery on the
      // next broker-ready re-arms it via refreshRemoteThreads.
      cancelRemoteThreadsPoll();
      rejectPendingActions("broker socket disconnected");
    },
    onRelayPresence: handleRelayPresence,
  });

  configureRemoteActions({
    onApplySessionSnapshot: applySessionSnapshot,
    onApplyTranscriptDelta: applyTranscriptDelta,
    onApplyTranscriptEvent: applyTranscriptEvent,
    onSyncRemoteSnapshot: syncRemoteSnapshot,
  });

  runtimeConfigured = true;
}

export function initializeRemoteSurface() {
  initializeRemoteNavigation();
  initializeRemotePointerClass();
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
  // iOS Safari shows no automatic install prompt, so nudge the user toward
  // Share → Add to Home Screen (no-op on every other platform / when installed).
  mountIosInstallHint();

  // The pairing payload arrives in the URL fragment (it holds the pairing_secret,
  // which must never reach the broker that serves this page). A fragment-only
  // navigation is a SAME-document navigation, so re-opening the same pairing link
  // in an already-loaded tab — re-scanning the QR, or following the link twice —
  // fires `hashchange` and never re-runs this boot. Watch for it explicitly, or a
  // second scan silently does nothing.
  window.addEventListener("hashchange", () => {
    const rescanned = applyPairingQuery();
    if (rescanned) {
      void beginPairing(rescanned, { auto: true });
    }
  });

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

  if (!state.remoteProfiles?.[relayId]) {
    renderLog("This relay is not stored in the current browser profile yet.");
    return;
  }

  cancelRemoteThreadsPoll();
  // The profile is validated above rather than by `selectRelayProfile`'s return value, so
  // that a switch which cannot happen resets nothing. See identity-change.js for why the
  // reset has to precede the move.
  replaceRemoteIdentity({
    resetSurface: () =>
      applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
        cancelThreadSearch: cancelRemoteThreadSearch,
        clearClaimLifecycle,
        clearSessionRuntime,
        rejectPendingActions,
        reason: "switched to a different relay profile",
      })),
    moveIdentity: () => selectRelayProfile(relayId),
  });
  renderLog(`Switching to relay ${relayId}.`);
  void connectBroker("switch relay");
}

export function returnToRelayHome() {
  if (!state.remoteAuth) {
    return;
  }

  cancelRemoteThreadsPoll();
  replaceRemoteIdentity({
    resetSurface: () =>
      applyRemoteSurfacePatch(createResetRemoteSurfaceStatePatch({
        cancelThreadSearch: cancelRemoteThreadSearch,
        clearClaimLifecycle,
        clearSessionRuntime,
        rejectPendingActions,
        reason: "returned to relay directory before broker actions completed",
      })),
    moveIdentity: clearActiveRelaySelection,
  });
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
    onRefreshThreads({ reason = "manual refresh", silent = false, fresh = false } = {}) {
      return refreshRemoteThreads(reason, { silent, fresh });
    },
    // "Do these sessions still exist?" — asked by id, because a page cannot answer it.
    onProbeThreadsExist(threadIds) {
      return probeRemoteThreadsExist(threadIds);
    },
    onFetchProviders() {
      return fetchRemoteProviders();
    },
    onFetchProviderModels(provider) {
      return fetchRemoteProviderModels(provider);
    },
    onFetchTranscriptEntryDetail(threadId, itemId) {
      return fetchTranscriptEntryDetail(threadId, itemId);
    },
    onFetchAskUserQuestionDetail(requestId) {
      return fetchAskUserQuestionDetail(requestId);
    },
    onFetchAskDetail(askId) {
      return fetchAskDetail(askId);
    },
    onResumeThread(threadId, sessionDraft) {
      return resumeRemoteSession(threadId, sessionDraft);
    },
    // View-only navigation: fetch the thread's transcript and show it without
    // calling the backend resume, which is mutating. Used when the target thread
    // is review-locked (the remote UI already rejects resume in that case).
    onViewThread(threadId) {
      return viewRemoteThread(threadId);
    },
    onReturnHome() {
      return returnToRelayHome();
    },
    onSelectRelay(relayId) {
      return switchRemoteRelay(relayId);
    },
    onSendMessage(messageDraft, effort, model) {
      return sendMessage(messageDraft, effort, model);
    },
    onStopTurn() {
      return stopActiveTurn();
    },
    onStartSession(sessionDraft) {
      return startRemoteSession(sessionDraft);
    },
    onForkSession(forkDraft) {
      return forkRemoteSession(forkDraft);
    },
    onSubmitDecision(decision, scope) {
      return submitDecision(decision, scope);
    },
    onSubmitAskUserAnswers(requestId, answers) {
      return submitAskUserAnswer(requestId, answers);
    },
    onApplyFileChange(itemId, direction) {
      return applyFileChange(itemId, direction);
    },
    onTakeOver() {
      return takeOverControl();
    },
    onRepairWorkspace(threadId) {
      return repairRemoteWorkspace(threadId);
    },
    onUpdateSessionSettings(payload) {
      return updateRemoteSessionSettings(payload);
    },
    onRequestReview(values) {
      return requestRemoteReview(values);
    },
    onStartWorkflow(values) {
      return startRemoteWorkflow(values);
    },
    onResolveReview(reviewJobId) {
      return resolveRemoteReview(reviewJobId);
    },
    onResolveWorkflow(workflowRunId) {
      return resolveRemoteWorkflow(workflowRunId);
    },
    onDeleteReview(reviewId) {
      return deleteRemoteReview(reviewId);
    },
    onDelegate(threadId, args) {
      return delegateRemote(threadId, args);
    },
    onSetGoal(threadId, objective) {
      return setRemoteGoal(threadId, objective);
    },
    onStopGoal(threadId) {
      return stopRemoteGoal(threadId);
    },
    onComposerError(threadId, message) {
      return setComposerError(threadId, message);
    },
    onGoalError(threadId, message, generation) {
      return setGoalError(threadId, message, generation);
    },
    onBeginGoalAction(threadId) {
      return beginGoalActionOn(threadId);
    },
    onDismissGoalError(threadId) {
      return clearGoalErrorOn(threadId);
    },
    onFetchReviewerTranscript(threadId) {
      return fetchRemoteThreadTranscript(threadId);
    },
  };
}

/**
 * Trace every sidebar gesture into the console AND the client log panel.
 *
 * OPT-IN: `?sidebarDebug=1`, or `localStorage["sealwire:sidebar-debug"] = "1"` to survive
 * a reload. Off by default, and off means this returns before attaching anything.
 *
 * That matters because the tracer is not a passive observer of the region it watches. It
 * calls `renderLog()` — `patchRemoteState`, a re-render — on pointerdown, touchstart,
 * wheel and scroll. A re-render between mousedown and mouseup replaces the
 * `dangerouslySetInnerHTML` glyph inside a button, and the browser then fires NO click:
 * the button hovers, depresses, and does nothing. `.inline-icon { pointer-events: none }`
 * protects the buttons carrying that class, but `.project-switcher-trigger`'s svg does
 * not, and an e2e run shows this tracer firing with that svg as the pointerdown target.
 *
 * It ran unconditionally for ~590 commits behind a "remove after scroll bugs are fixed"
 * TODO. Gating beats deleting: on a phone there is usually no console to read, which is
 * why it renders into the log panel, and that is precisely where the next sidebar scroll
 * report will come from.
 */
export function installSidebarGestureDebug() {
  if (
    !sidebarGestureDebugEnabled({
      search: typeof window !== "undefined" ? window.location?.search || "" : "",
      storage: typeof window !== "undefined" ? window.localStorage : null,
    })
  ) {
    // A no-op cleanup, so the caller's teardown does not have to know it never ran.
    return () => {};
  }

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
    // Opt-in only (see the gate at the top of this function): reaching here means the
    // tracer was explicitly armed, so the re-render below is asked for.
    console.log(message);
    renderLog(message);
  };

  const logScrollEvent = (scope, element) => {
    const message = `[sidebar-debug] ${scope} type=scroll current=${describeNode(element)} top=${element.scrollTop} height=${element.scrollHeight} client=${element.clientHeight}`;
    // Opt-in only, as above.
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
