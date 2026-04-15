import {
  decryptJson,
  encryptJson,
  signClaimChallengeProof,
  signClaimInitProof,
} from "./crypto.js";
import { renderDeviceMeta, renderLog, renderThreads } from "./render.js";
import {
  CLAIM_REFRESH_FLOOR_MS,
  CLAIM_REFRESH_SKEW_MS,
  clearSessionClaim,
  clearRecoveredSocketPeerId,
  ensureDeviceIdentity,
  hasUsableSessionClaim,
  setRecoveredSocketPeerId,
  setSessionClaim,
  state,
} from "./state.js";
import { sendBrokerFrame } from "./broker-client.js";

const REMOTE_ACTION_TIMEOUT_MS = 15_000;

let onApplySessionSnapshot = () => {};
let onSyncRemoteSnapshot = async () => {};

export function configureRemoteActions(handlers) {
  onApplySessionSnapshot = handlers.onApplySessionSnapshot || onApplySessionSnapshot;
  onSyncRemoteSnapshot = handlers.onSyncRemoteSnapshot || onSyncRemoteSnapshot;
}

export async function handleRemoteBrokerPayload(payload) {
  const kind = payload?.kind;

  if (kind === "encrypted_session_snapshot") {
    await handleEncryptedSessionSnapshot(payload);
    return;
  }

  if (kind === "encrypted_remote_action_result") {
    await handleEncryptedRemoteActionResult(payload);
    return;
  }

  if (kind === "session_snapshot") {
    onApplySessionSnapshot(payload.snapshot);
    renderLog("Received managed-mode session snapshot from broker.");
    return;
  }

  if (kind === "remote_action_result") {
    handleRemoteActionResult(payload.action_id, payload);
  }
}

export async function ensureRemoteClaim({
  force = false,
  reason = "claim refresh",
  syncAfterClaim = false,
} = {}) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }
  if (!force && hasUsableSessionClaim(CLAIM_REFRESH_SKEW_MS)) {
    return state.remoteAuth.sessionClaim;
  }
  if (state.claimPromise) {
    return state.claimPromise;
  }

  const needsRefresh = Boolean(state.remoteAuth.sessionClaim);
  const claimPromise = (async () => {
    try {
      renderLog(`${needsRefresh ? "Refreshing" : "Claiming"} remote device (${reason}).`);
      const challengeResult = await dispatchRemoteAction("claim_challenge", {});
      if (!challengeResult.claim_challenge_id || !challengeResult.claim_challenge) {
        throw new Error(
          `claim challenge response is incomplete: ${JSON.stringify(challengeResult)}`
        );
      }
      renderLog("Remote claim challenge accepted; completing claim.");
      const result = await dispatchRemoteAction("claim_device", {
        challenge_id: challengeResult.claim_challenge_id,
        challenge: challengeResult.claim_challenge,
      });
      if (!result.session_claim) {
        throw new Error(`claim device response is incomplete: ${JSON.stringify(result)}`);
      }
      return result.session_claim;
    } catch (error) {
      console.error("[agent-relay] ensureRemoteClaim failed", error);
      throw error;
    }
  })().finally(() => {
    state.claimPromise = null;
  });
  state.claimPromise = claimPromise;

  const sessionClaim = await claimPromise;
  if (syncAfterClaim) {
    await onSyncRemoteSnapshot(`claim sync (${reason})`, true);
  }
  return sessionClaim;
}

export async function recoverRemoteSession(reason) {
  if (!state.remoteAuth) {
    return;
  }
  if (
    state.socketConnected &&
    state.socketPeerId &&
    state.recoveredSocketPeerId === state.socketPeerId &&
    hasUsableSessionClaim()
  ) {
    await onSyncRemoteSnapshot(`already recovered (${reason})`, true);
    return;
  }
  if (state.recoverPromise) {
    return state.recoverPromise;
  }

  state.recoverPromise = (async () => {
    try {
      if (state.remoteAuth?.sessionClaim) {
        clearSessionClaim();
        renderDeviceMeta();
      }
      await onSyncRemoteSnapshot(`recovery sync (${reason})`, true);
      if (shouldAutoReclaimSession()) {
        await ensureRemoteClaim({
          force: true,
          reason,
          syncAfterClaim: true,
        });
      }
      setRecoveredSocketPeerId(state.socketPeerId);
    } catch (error) {
      renderLog(`Remote recovery failed: ${error.message}`);
    } finally {
      state.recoverPromise = null;
    }
  })();

  return state.recoverPromise;
}

export async function dispatchOrRecover(actionType, request, options = {}) {
  const allowClaimRetry = options.allowClaimRetry !== false;
  const skipPreclaim = options.skipPreclaim === true;

  if (requiresSessionClaim(actionType) && !skipPreclaim) {
    await ensureRemoteClaim({
      force: !hasUsableSessionClaim(CLAIM_REFRESH_SKEW_MS),
      reason: `${actionType} preflight`,
      syncAfterClaim: false,
    });
  }

  try {
    return await dispatchRemoteAction(actionType, request);
  } catch (error) {
    if (
      allowClaimRetry &&
      requiresSessionClaim(actionType) &&
      isSessionClaimError(error.message)
    ) {
      clearSessionClaim();
      renderDeviceMeta();
      renderLog(`Session claim expired during ${actionType}; re-claiming and retrying once.`);
      await ensureRemoteClaim({
        force: true,
        reason: `${actionType} retry`,
        syncAfterClaim: false,
      });
      return dispatchOrRecover(actionType, request, {
        ...options,
        allowClaimRetry: false,
        skipPreclaim: true,
      });
    }

    throw error;
  }
}

export function scheduleClaimRefresh() {
  cancelClaimRefresh();

  if (!state.socketConnected || !state.remoteAuth?.sessionClaimExpiresAt) {
    return;
  }

  const expiresAtMs = state.remoteAuth.sessionClaimExpiresAt * 1000;
  const delayMs = Math.max(
    CLAIM_REFRESH_FLOOR_MS,
    expiresAtMs - Date.now() - CLAIM_REFRESH_SKEW_MS
  );
  state.claimRefreshTimer = window.setTimeout(() => {
    void ensureRemoteClaim({
      force: true,
      reason: "scheduled refresh",
      syncAfterClaim: false,
    }).catch((error) => {
      renderLog(`Scheduled claim refresh failed: ${error.message}`);
    });
  }, delayMs);
}

export function clearClaimLifecycle() {
  cancelClaimRefresh();
  state.claimPromise = null;
  state.recoverPromise = null;
  clearRecoveredSocketPeerId();
}

export function rejectPendingActions(message) {
  if (!state.pendingActions.size) {
    return;
  }

  const error = new Error(message);
  for (const pending of state.pendingActions.values()) {
    window.clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  state.pendingActions.clear();
}

async function handleEncryptedSessionSnapshot(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const snapshot = await decryptPayloadWithDeviceTokens(payload.envelope);
  onApplySessionSnapshot(snapshot);
}

async function handleEncryptedRemoteActionResult(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    return;
  }

  const result = await decryptPayloadWithDeviceTokens(payload.envelope);
  handleRemoteActionResult(payload.action_id, result);
}

function handleRemoteActionResult(actionId, result) {
  settlePendingAction(actionId, result);
  const isTranscriptFetch = result.action === "fetch_thread_transcript";

  try {
    if (result.session_claim && state.remoteAuth) {
      setSessionClaim(result.session_claim, result.session_claim_expires_at || null);
      scheduleClaimRefresh();
      renderDeviceMeta();
    }

    if (result.snapshot && !isTranscriptFetch) {
      onApplySessionSnapshot(result.snapshot);
    }

    if (result.threads?.threads) {
      state.threads = result.threads.threads;
      renderThreads(state.threads);
    }
  } catch (error) {
    console.error("[agent-relay] remote action result side effects failed", error);
  }

  if (result.ok) {
    if (isTranscriptFetch) {
      return;
    }
    if (result.action === "claim_challenge") {
      return;
    }
    if (result.action === "claim_device") {
      renderLog("Remote device claim is active.");
      return;
    }
    if (result.receipt?.message) {
      renderLog(result.receipt.message);
    } else {
      renderLog(`Remote ${result.action} succeeded.`);
    }
    return;
  }

  if (isSessionClaimError(result.error) && state.remoteAuth) {
    clearSessionClaim();
    scheduleClaimRefresh();
    renderDeviceMeta();
  }

  renderLog(`Remote ${result.action} failed: ${result.error || "unknown error"}`);
}

async function decryptPayloadWithDeviceTokens(envelope) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }

  return decryptJson(state.remoteAuth.payloadSecret, envelope);
}

async function dispatchRemoteAction(actionType, request) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }

  const actionId = makeActionId(actionType);
  const resultPromise = registerPendingAction(actionId, actionType);

  try {
    if (actionType === "claim_challenge") {
      sendBrokerFrame(await buildClaimChallengePayload(actionId));
      return await resultPromise;
    }

    if (actionType === "claim_device") {
      sendBrokerFrame(await buildClaimDevicePayload(actionId, request));
      return await resultPromise;
    }

    if (requiresSessionClaim(actionType) && !state.remoteAuth.sessionClaim) {
      throw new Error("device is not claimed yet");
    }

    sendBrokerFrame(
      requiresSessionClaim(actionType)
        ? await buildClaimedActionPayload(actionId, actionType, request)
        : await buildDeviceActionPayload(actionId, actionType, request)
    );
    return await resultPromise;
  } catch (error) {
    const pending = state.pendingActions.get(actionId);
    if (pending) {
      window.clearTimeout(pending.timeoutId);
      state.pendingActions.delete(actionId);
    }
    throw error;
  }
}

async function buildClaimChallengePayload(actionId) {
  if (!state.socketPeerId) {
    throw new Error("broker peer id is not ready yet");
  }
  const deviceKeypair = await ensureDeviceIdentity();
  const proof = await signClaimInitProof(
    actionId,
    state.remoteAuth.deviceId,
    state.socketPeerId,
    deviceKeypair
  );

  if (state.remoteAuth.securityMode === "managed") {
    return {
      kind: "remote_action",
      action_id: actionId,
      device_id: state.remoteAuth.deviceId,
      request: {
        type: "claim_challenge",
        proof,
      },
    };
  }

  return {
    kind: "encrypted_remote_action",
    action_id: actionId,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.payloadSecret, {
      type: "claim_challenge",
      proof,
    }),
  };
}

async function buildClaimDevicePayload(actionId, request) {
  if (!state.socketPeerId) {
    throw new Error("broker peer id is not ready yet");
  }
  if (!request?.challenge_id || !request?.challenge) {
    throw new Error("claim_device requires a claim challenge");
  }
  const deviceKeypair = await ensureDeviceIdentity();

  const claimProof = await signClaimChallengeProof(
    request.challenge_id,
    request.challenge,
    state.remoteAuth.deviceId,
    state.socketPeerId,
    deviceKeypair
  );

  if (state.remoteAuth.securityMode === "managed") {
    return {
      kind: "remote_action",
      action_id: actionId,
      device_id: state.remoteAuth.deviceId,
      request: {
        type: "claim_device",
        challenge_id: request.challenge_id,
        proof: claimProof,
      },
    };
  }

  return {
    kind: "encrypted_remote_action",
    action_id: actionId,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.payloadSecret, {
      type: "claim_device",
      challenge_id: request.challenge_id,
      proof: claimProof,
    }),
  };
}

async function buildClaimedActionPayload(actionId, actionType, request) {
  if (state.remoteAuth.securityMode === "managed") {
    return {
      kind: "remote_action",
      action_id: actionId,
      session_claim: state.remoteAuth.sessionClaim,
      device_id: state.remoteAuth.deviceId,
      request: {
        type: actionType,
        ...request,
      },
    };
  }

  return {
    kind: "encrypted_remote_action",
    action_id: actionId,
    session_claim: state.remoteAuth.sessionClaim,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.payloadSecret, {
      type: actionType,
      ...request,
    }),
  };
}

async function buildDeviceActionPayload(actionId, actionType, request) {
  if (state.remoteAuth.securityMode === "managed") {
    return {
      kind: "remote_action",
      action_id: actionId,
      device_id: state.remoteAuth.deviceId,
      request: {
        type: actionType,
        ...request,
      },
    };
  }

  return {
    kind: "encrypted_remote_action",
    action_id: actionId,
    device_id: state.remoteAuth.deviceId,
    envelope: await encryptJson(state.remoteAuth.payloadSecret, {
      type: actionType,
      ...request,
    }),
  };
}

function registerPendingAction(actionId, actionType) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      const pending = state.pendingActions.get(actionId);
      if (!pending) {
        return;
      }

      state.pendingActions.delete(actionId);
      reject(new Error(`remote ${actionType} timed out waiting for relay response`));
    }, REMOTE_ACTION_TIMEOUT_MS);

    state.pendingActions.set(actionId, {
      actionType,
      timeoutId,
      reject,
      resolve,
    });
  });
}

function settlePendingAction(actionId, result) {
  if (!actionId) {
    return;
  }

  const pending = state.pendingActions.get(actionId);
  if (!pending) {
    return;
  }

  state.pendingActions.delete(actionId);
  window.clearTimeout(pending.timeoutId);
  if (result.ok) {
    pending.resolve(result);
    return;
  }

  pending.reject(new Error(result.error || `${pending.actionType} failed`));
}

function cancelClaimRefresh() {
  if (!state.claimRefreshTimer) {
    return;
  }

  window.clearTimeout(state.claimRefreshTimer);
  state.claimRefreshTimer = null;
}

function isSessionClaimError(message) {
  return typeof message === "string" && message.toLowerCase().includes("session claim");
}

function requiresSessionClaim(actionType) {
  return actionType === "send_message";
}

function shouldAutoReclaimSession() {
  return Boolean(
    state.remoteAuth?.deviceId &&
      state.session?.active_thread_id &&
      state.session.active_controller_device_id === state.remoteAuth.deviceId
  );
}

function makeActionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
