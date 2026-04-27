import {
  decryptJson,
  encryptJson,
  signClaimChallengeProof,
  signClaimInitProof,
} from "./crypto.js";
import { renderLog } from "./session-surface.js";
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
import {
  applyRemoteSurfacePatch,
  createClaimLifecyclePatch,
  createRemoteThreadsPatch,
} from "./surface-state.js";
import { sendBrokerFrame } from "./broker-client.js";

const REMOTE_ACTION_TIMEOUT_MS = 15_000;

let onApplySessionSnapshot = () => {};
let onSyncRemoteSnapshot = async () => {};
let onApplyTranscriptDelta = () => {};

export function configureRemoteActions(handlers) {
  onApplySessionSnapshot = handlers.onApplySessionSnapshot || onApplySessionSnapshot;
  onSyncRemoteSnapshot = handlers.onSyncRemoteSnapshot || onSyncRemoteSnapshot;
  onApplyTranscriptDelta = handlers.onApplyTranscriptDelta || onApplyTranscriptDelta;
}

export async function handleRemoteBrokerPayload(payload) {
  const kind = payload?.kind;

  if (kind === "transcript_delta") {
    onApplyTranscriptDelta(payload);
    return;
  }

  if (kind === "encrypted_transcript_delta") {
    await handleEncryptedTranscriptDelta(payload);
    return;
  }

  if (kind === "encrypted_session_snapshot") {
    await handleEncryptedSessionSnapshot(payload);
    return;
  }

  if (kind === "encrypted_remote_action_result") {
    await handleEncryptedRemoteActionResult(payload);
    return;
  }

  if (kind === "encrypted_remote_action_result_chunk") {
    await handleEncryptedRemoteActionResultChunk(payload);
    return;
  }

  if (kind === "session_snapshot") {
    const message = `[scroll-source] kind=session_snapshot entries=${payload.snapshot?.transcript?.length || 0} truncated=${payload.snapshot?.transcript_truncated ? "1" : "0"} has_truncated=${Object.prototype.hasOwnProperty.call(payload.snapshot || {}, "transcript_truncated") ? "1" : "0"} thread=${payload.snapshot?.active_thread_id || "-"} status=${payload.snapshot?.current_status || "-"}`;
    renderLog(message);
    // TODO(remote-monitor-debug): Remove this console mirror once snapshot routing is stable.
    console.log(message);
    onApplySessionSnapshot(payload.snapshot);
    renderLog("Received managed-mode session snapshot from broker.");
    return;
  }

  if (kind === "remote_action_result") {
    handleRemoteActionResult(payload.action_id, payload);
    return;
  }

  if (kind === "remote_action_result_chunk") {
    handleRemoteActionResultChunk(payload.action_id, payload);
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
    applyRemoteSurfacePatch(createClaimLifecyclePatch({
      claimPromise: null,
    }));
  });
  applyRemoteSurfacePatch(createClaimLifecyclePatch({
    claimPromise,
  }));

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

  const recoverPromise = (async () => {
    try {
      if (state.remoteAuth?.sessionClaim) {
        clearSessionClaim();
      }
      await onSyncRemoteSnapshot(`recovery sync (${reason})`, true);
      if (shouldAutoReclaimSession()) {
        await ensureRemoteClaim({
          force: true,
          reason,
          syncAfterClaim: true,
        });
      }
      applyRemoteSurfacePatch(createClaimLifecyclePatch({
        recoveredSocketPeerId: state.socketPeerId,
      }));
      setRecoveredSocketPeerId(state.socketPeerId);
    } catch (error) {
      renderLog(`Remote recovery failed: ${error.message}`);
    } finally {
      applyRemoteSurfacePatch(createClaimLifecyclePatch({
        recoverPromise: null,
      }));
    }
  })();
  applyRemoteSurfacePatch(createClaimLifecyclePatch({
    recoverPromise,
  }));

  return recoverPromise;
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
  const claimRefreshTimer = window.setTimeout(() => {
    void ensureRemoteClaim({
      force: true,
      reason: "scheduled refresh",
      syncAfterClaim: false,
    }).catch((error) => {
      renderLog(`Scheduled claim refresh failed: ${error.message}`);
    });
  }, delayMs);
  applyRemoteSurfacePatch(createClaimLifecyclePatch({
    claimRefreshTimer,
  }));
}

export function clearClaimLifecycle() {
  cancelClaimRefresh();
  applyRemoteSurfacePatch(createClaimLifecyclePatch({
    claimPromise: null,
    recoverPromise: null,
    recoveredSocketPeerId: null,
  }));
  clearRecoveredSocketPeerId();
}

export function rejectPendingActions(message) {
  if (!state.pendingActions.size) {
    state.pendingActionChunks.clear();
    return;
  }

  const error = new Error(message);
  for (const actionId of Array.from(state.pendingActions.keys())) {
    rejectPendingAction(actionId, error);
  }
  state.pendingActionChunks.clear();
}

async function handleEncryptedSessionSnapshot(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    logIgnoredEncryptedPayload("encrypted_session_snapshot", payload);
    return;
  }

  logAcceptedEncryptedPayload("encrypted_session_snapshot", payload);
  const snapshot = await decryptPayloadWithDeviceTokens(payload.envelope);
  logDecryptedSessionSnapshot("encrypted_session_snapshot", snapshot);
  onApplySessionSnapshot(snapshot);
}

async function handleEncryptedTranscriptDelta(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    logIgnoredEncryptedPayload("encrypted_transcript_delta", payload);
    return;
  }

  logAcceptedEncryptedPayload("encrypted_transcript_delta", payload);
  const delta = await decryptPayloadWithDeviceTokens(payload.envelope);
  logDecryptedTranscriptDelta(delta);
  onApplyTranscriptDelta(delta);
}

async function handleEncryptedRemoteActionResult(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    logIgnoredEncryptedPayload("encrypted_remote_action_result", payload);
    return;
  }

  logAcceptedEncryptedPayload("encrypted_remote_action_result", payload);
  const result = await decryptPayloadWithDeviceTokens(payload.envelope);
  logDecryptedRemoteActionResult(payload.action_id, result);
  handleRemoteActionResult(payload.action_id, result);
}

async function handleEncryptedRemoteActionResultChunk(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    logIgnoredEncryptedPayload("encrypted_remote_action_result_chunk", payload);
    return;
  }

  logAcceptedEncryptedPayload("encrypted_remote_action_result_chunk", payload);
  const chunk = await decryptPayloadWithDeviceTokens(payload.envelope);
  if (
    chunk?.action_id !== payload.action_id ||
    chunk?.action !== payload.action ||
    chunk?.chunk_index !== payload.chunk_index ||
    chunk?.chunk_count !== payload.chunk_count
  ) {
    rejectPendingAction(
      payload.action_id,
      new Error("remote action chunk metadata mismatch")
    );
    return;
  }
  handleRemoteActionResultChunk(payload.action_id, chunk);
}

function logIgnoredEncryptedPayload(kind, payload) {
  const peerMatches = payload.target_peer_id === state.socketPeerId;
  const deviceMatches = payload.device_id === state.remoteAuth?.deviceId;
  const message = `[broker-filter] ignored kind=${kind} target=${payload.target_peer_id || "-"} socket=${state.socketPeerId || "-"} peer_match=${peerMatches ? "1" : "0"} device=${payload.device_id || "-"} localDevice=${state.remoteAuth?.deviceId || "-"} device_match=${deviceMatches ? "1" : "0"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logAcceptedEncryptedPayload(kind, payload) {
  const message = `[broker-filter] accepted kind=${kind} target=${payload.target_peer_id || "-"} socket=${state.socketPeerId || "-"} device=${payload.device_id || "-"} localDevice=${state.remoteAuth?.deviceId || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logDecryptedSessionSnapshot(kind, snapshot) {
  const message = `[broker-decrypt] kind=${kind} thread=${snapshot?.active_thread_id || "-"} entries=${snapshot?.transcript?.length || 0} truncated=${snapshot?.transcript_truncated ? "1" : "0"} status=${snapshot?.current_status || "-"} turn=${snapshot?.active_turn_id || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logDecryptedTranscriptDelta(delta) {
  const message = `[broker-decrypt] kind=encrypted_transcript_delta thread=${delta?.thread_id || "-"} item=${delta?.item_id || "-"} turn=${delta?.turn_id || "-"} delta_kind=${delta?.delta_kind || delta?.kind || "-"} bytes=${typeof delta?.delta === "string" ? delta.delta.length : 0}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logDecryptedRemoteActionResult(actionId, result) {
  const message = `[broker-decrypt] kind=encrypted_remote_action_result action_id=${actionId || "-"} action=${result?.action || "-"} thread=${result?.snapshot?.active_thread_id || "-"} entries=${result?.snapshot?.transcript?.length || 0} truncated=${result?.snapshot?.transcript_truncated ? "1" : "0"} ok=${result?.ok ? "1" : "0"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function handleRemoteActionResult(actionId, result) {
  clearPendingActionChunks(actionId);
  settlePendingAction(actionId, result);
  const isTranscriptFetch =
    result.action === "fetch_thread_transcript"
    || result.action === "fetch_thread_entries"
    || result.action === "fetch_thread_entry_detail";

  try {
    if (result.session_claim && state.remoteAuth) {
      setSessionClaim(result.session_claim, result.session_claim_expires_at || null);
      scheduleClaimRefresh();
    }

    if (isTranscriptFetch) {
      return;
    }

    const isLiveDisruptingAction =
      result.action === "heartbeat"
      || result.action === "claim_challenge"
      || result.action === "claim_device"
      || result.action === "list_threads"
      || result.action === "take_over";

    if (result.snapshot && !isLiveDisruptingAction) {
      const message = `[scroll-source] kind=remote_action_result action=${result.action || "-"} entries=${result.snapshot?.transcript?.length || 0} truncated=${result.snapshot?.transcript_truncated ? "1" : "0"} has_truncated=${Object.prototype.hasOwnProperty.call(result.snapshot || {}, "transcript_truncated") ? "1" : "0"} thread=${result.snapshot?.active_thread_id || "-"} status=${result.snapshot?.current_status || "-"}`;
      renderLog(message);
      // TODO(remote-monitor-debug): Remove this console mirror once snapshot routing is stable.
      console.log(message);
      onApplySessionSnapshot(result.snapshot);
    }

    if (result.threads?.threads) {
      applyRemoteSurfacePatch(createRemoteThreadsPatch(result.threads.threads));
    }
  } catch (error) {
    console.error("[agent-relay] remote action result side effects failed", error);
  }

  if (result.ok) {
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
  }

  renderLog(`Remote ${result.action} failed: ${result.error || "unknown error"}`);
}

function handleRemoteActionResultChunk(actionId, chunk) {
  if (!actionId || !state.pendingActions.has(actionId)) {
    clearPendingActionChunks(actionId);
    return;
  }

  const chunkIndex = Number(chunk?.chunk_index);
  const chunkCount = Number(chunk?.chunk_count);
  if (
    !Number.isInteger(chunkIndex) ||
    !Number.isInteger(chunkCount) ||
    chunkIndex < 0 ||
    chunkCount <= 0 ||
    chunkIndex >= chunkCount ||
    typeof chunk?.data_base64 !== "string"
  ) {
    rejectPendingAction(actionId, new Error("remote action chunk is malformed"));
    return;
  }

  let pendingChunks = state.pendingActionChunks.get(actionId);
  if (!pendingChunks) {
    pendingChunks = {
      action: chunk.action || null,
      chunkCount,
      chunks: new Array(chunkCount),
      receivedCount: 0,
    };
    state.pendingActionChunks.set(actionId, pendingChunks);
  }

  if (pendingChunks.chunkCount !== chunkCount) {
    rejectPendingAction(actionId, new Error("remote action chunk count changed mid-stream"));
    return;
  }

  if (pendingChunks.chunks[chunkIndex] == null) {
    pendingChunks.receivedCount += 1;
  }
  pendingChunks.chunks[chunkIndex] = chunk.data_base64;

  if (pendingChunks.receivedCount !== chunkCount) {
    return;
  }

  clearPendingActionChunks(actionId);
  try {
    const result = reassembleRemoteActionResultChunks(pendingChunks.chunks);
    logDecryptedRemoteActionResult(actionId, result);
    handleRemoteActionResult(actionId, result);
  } catch (error) {
    rejectPendingAction(actionId, error);
  }
}

function reassembleRemoteActionResultChunks(chunks) {
  const parts = chunks.map((chunk, index) => {
    if (typeof chunk !== "string") {
      throw new Error(`remote action result chunk ${index + 1} is missing`);
    }
    return decodeBase64ToBytes(chunk);
  });
  const totalBytes = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function decodeBase64ToBytes(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function clearPendingActionChunks(actionId) {
  if (!actionId) {
    return;
  }
  state.pendingActionChunks.delete(actionId);
}

function rejectPendingAction(actionId, error) {
  if (!actionId) {
    return;
  }
  const pending = state.pendingActions.get(actionId);
  clearPendingActionChunks(actionId);
  if (!pending) {
    return;
  }
  window.clearTimeout(pending.timeoutId);
  state.pendingActions.delete(actionId);
  pending.reject(error);
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
    clearPendingActionChunks(actionId);
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
      rejectPendingAction(
        actionId,
        new Error(`remote ${actionType} timed out waiting for relay response`)
      );
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

  clearPendingActionChunks(actionId);
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
  applyRemoteSurfacePatch(createClaimLifecyclePatch({
    claimRefreshTimer: null,
  }));
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
