import {
  decryptJson,
  encryptJson,
  signClaimChallengeProof,
  signClaimInitProof,
} from "./crypto.js";
import { renderLog } from "./session-surface.js";
import { ACTIONS_REQUIRING_SESSION_CLAIM } from "./session-claim-actions.js";
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
} from "./surface-state.js";
import { sendBrokerFrame } from "./broker-client.js";
import { actionDeadlineMs } from "./action-deadlines.js";


let onApplySessionSnapshot = () => {};
let onSyncRemoteSnapshot = async () => {};
let onApplyTranscriptDelta = () => {};
let onApplyTranscriptEvent = () => {};

export function configureRemoteActions(handlers) {
  onApplySessionSnapshot = handlers.onApplySessionSnapshot || onApplySessionSnapshot;
  onSyncRemoteSnapshot = handlers.onSyncRemoteSnapshot || onSyncRemoteSnapshot;
  onApplyTranscriptDelta = handlers.onApplyTranscriptDelta || onApplyTranscriptDelta;
  onApplyTranscriptEvent = handlers.onApplyTranscriptEvent || onApplyTranscriptEvent;
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

  if (isTranscriptEventKind(kind)) {
    onApplyTranscriptEvent(payload);
    return;
  }

  if (kind === "encrypted_transcript_event") {
    await handleEncryptedTranscriptEvent(payload);
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
    if (!isVerboseBrokerLoggingEnabled()) {
      onApplySessionSnapshot(payload.snapshot);
      return;
    }
    const message = `[scroll-source] kind=session_snapshot entries=${payload.snapshot?.transcript?.length || 0} truncated=${payload.snapshot?.transcript_truncated ? "1" : "0"} has_truncated=${Object.prototype.hasOwnProperty.call(payload.snapshot || {}, "transcript_truncated") ? "1" : "0"} thread=${payload.snapshot?.active_thread_id || "-"} status=${payload.snapshot?.current_status || "-"}`;
    renderLog(message);
    // TODO(remote-monitor-debug): Remove this console mirror once snapshot routing is stable.
    console.log(message);
    onApplySessionSnapshot(payload.snapshot);
    renderLog("Received managed-mode session snapshot from broker.");
    return;
  }

  if (isRemoteActionResultKind(kind)) {
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

async function handleEncryptedTranscriptEvent(payload) {
  if (
    payload.target_peer_id !== state.socketPeerId ||
    payload.device_id !== state.remoteAuth?.deviceId
  ) {
    logIgnoredEncryptedPayload("encrypted_transcript_event", payload);
    return;
  }

  logAcceptedEncryptedPayload("encrypted_transcript_event", payload);
  const event = await decryptPayloadWithDeviceTokens(payload.envelope);
  onApplyTranscriptEvent(event);
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
  // Discarding a frame must be FREE. The broker broadcasts remote action results
  // and session snapshots to every peer in the room and leaves the filtering to
  // each surface (`must_not_be_broadcast` in crates/relay-broker/src/state.rs lists
  // only `encrypted_pairing_result`), so every surface sees every other surface's
  // traffic. `renderLog` is a `patchRemoteState`, which notifies the store behind
  // `useSyncExternalStore` — so logging here cost one full RemoteApp re-render per
  // frame we then threw away. A real boot trace showed 21 of them, all chunks of
  // another surface's `fetch_workspace_diff`, arriving before the first frame
  // addressed to this surface.
  //
  // The gate is now the whole function, not just the high-volume kinds: a frame
  // that is not for us is by definition not this surface's business, and anyone
  // debugging broker routing turns on `window.__agentRelayVerboseBrokerLogs`.
  if (!isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const peerMatches = payload.target_peer_id === state.socketPeerId;
  const deviceMatches = payload.device_id === state.remoteAuth?.deviceId;
  const message = `[broker-filter] ignored kind=${kind} target=${payload.target_peer_id || "-"} socket=${state.socketPeerId || "-"} peer_match=${peerMatches ? "1" : "0"} device=${payload.device_id || "-"} localDevice=${state.remoteAuth?.deviceId || "-"} device_match=${deviceMatches ? "1" : "0"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logAcceptedEncryptedPayload(kind, payload) {
  if (isHighVolumeEncryptedPayloadKind(kind) && !isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const message = `[broker-filter] accepted kind=${kind} target=${payload.target_peer_id || "-"} socket=${state.socketPeerId || "-"} device=${payload.device_id || "-"} localDevice=${state.remoteAuth?.deviceId || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logDecryptedSessionSnapshot(kind, snapshot) {
  if (!isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const message = `[broker-decrypt] kind=${kind} thread=${snapshot?.active_thread_id || "-"} entries=${snapshot?.transcript?.length || 0} truncated=${snapshot?.transcript_truncated ? "1" : "0"} status=${snapshot?.current_status || "-"} turn=${snapshot?.active_turn_id || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function logDecryptedTranscriptDelta(delta) {
  if (!isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const message = `[broker-decrypt] kind=encrypted_transcript_delta thread=${delta?.thread_id || "-"} item=${delta?.item_id || "-"} turn=${delta?.turn_id || "-"} delta_kind=${delta?.delta_kind || delta?.kind || "-"} bytes=${typeof delta?.delta === "string" ? delta.delta.length : 0}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

/// Kinds that arrive in bursts, where one log line per frame means one full RemoteApp
/// re-render per frame. Chunked action replies belong here for the same reason
/// transcript deltas do: a single workspace diff is tens of frames, and each one was
/// costing a render on the accepted path even when the reply was for this very surface.
function isHighVolumeEncryptedPayloadKind(kind) {
  return kind === "encrypted_transcript_delta"
    || kind === "encrypted_transcript_event"
    || kind === "encrypted_remote_action_result_chunk"
    || kind === "encrypted_session_snapshot";
}

function isTranscriptEventKind(kind) {
  return kind === "session_meta_updated"
    || kind === "transcript_entry_started"
    || kind === "transcript_entry_delta"
    || kind === "transcript_entry_completed"
    || kind === "transcript_entry_patched"
    || kind === "approval_added"
    || kind === "approval_resolved"
    || kind === "transcript_stream_lagged";
}

function isVerboseBrokerLoggingEnabled() {
  return typeof window !== "undefined" && window.__agentRelayVerboseBrokerLogs === true;
}

function logDecryptedRemoteActionResult(actionId, result) {
  const message = `[broker-decrypt] kind=${result?.kind || "encrypted_remote_action_result"} action_id=${actionId || "-"} action=${result?.action || "-"} thread=${result?.snapshot?.active_thread_id || "-"} entries=${result?.snapshot?.transcript?.length || 0} truncated=${result?.snapshot?.transcript_truncated ? "1" : "0"} ok=${result?.ok ? "1" : "0"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once broker routing is stable.
  console.log(message);
}

function handleRemoteActionResult(actionId, result) {
  clearPendingActionChunks(actionId);
  settlePendingAction(actionId, result);

  try {
    if (result.session_claim && state.remoteAuth) {
      setSessionClaim(result.session_claim, result.session_claim_expires_at || null);
      scheduleClaimRefresh();
    }

    if (result.kind === "remote_session_result" && result.snapshot) {
      const message = `[scroll-source] kind=remote_session_result action=${result.action || "-"} entries=${result.snapshot?.transcript?.length || 0} truncated=${result.snapshot?.transcript_truncated ? "1" : "0"} has_truncated=${Object.prototype.hasOwnProperty.call(result.snapshot || {}, "transcript_truncated") ? "1" : "0"} thread=${result.snapshot?.active_thread_id || "-"} status=${result.snapshot?.current_status || "-"}`;
      renderLog(message);
      // TODO(remote-monitor-debug): Remove this console mirror once snapshot routing is stable.
      console.log(message);
      onApplySessionSnapshot(result.snapshot);
    }

    // Deliberately NOT patching `state.threads` here. `list_threads` is the only action
    // that returns a list, and its normal caller (`refreshRemoteThreads`) already writes
    // it behind a generation guard — so this was redundant there and actively wrong for
    // a SEARCH, whose narrowed answer would replace the authoritative list until the
    // next poll. Who owns the list is a caller's decision, not a side effect of the
    // frame arriving.
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

function isRemoteActionResultKind(kind) {
  return kind === "remote_action_ack"
    || kind === "remote_action_result"
    || kind === "remote_approval_result"
    || kind === "remote_control_result"
    || kind === "remote_models_result"
    || kind === "remote_session_result"
    || kind === "remote_threads_result"
    || kind === "remote_transcript_result";
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
    typeof chunk?.data !== "string"
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

  const advancedTransfer = pendingChunks.chunks[chunkIndex] == null;
  if (advancedTransfer) {
    pendingChunks.receivedCount += 1;
  }
  pendingChunks.chunks[chunkIndex] = chunk.data;
  // A chunk that ADVANCES the transfer is proof the relay is alive and still working on
  // this reply, so the deadline restarts. A repeat of one already held is not: renewing
  // on those would hand a stalled action an unlimited lease, kept alive forever by a
  // peer re-sending the same frame. It was armed once when the request went out and never moved,
  // which put a hard ceiling on how large a reply could ever be: the relay paces chunks
  // 250ms apart, so 61 of them consume the whole budget before the last one lands, and
  // a workspace diff is allowed to be far bigger than that. The deadline is meant to
  // catch a stalled transfer, not to cap a healthy one.
  if (advancedTransfer) {
    extendPendingActionDeadline(actionId);
  }

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

// Chunks are text slices of the serialized result, split on character boundaries by the
// relay, so reassembly is plain concatenation. They used to be base64 of byte slices,
// which cost a whole extra 4/3 expansion on the wire — on top of the base64 the encrypted
// transport already applies to the ciphertext — for an encoding the payload never needed:
// what is being chunked is JSON text to begin with.
function reassembleRemoteActionResultChunks(chunks) {
  let serialized = "";
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (typeof chunk !== "string") {
      throw new Error(`remote action result chunk ${index + 1} is missing`);
    }
    serialized += chunk;
  }
  return JSON.parse(serialized);
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
  const resultPromise = registerPendingAction(actionId, actionType, request);

  try {
    await sendRemoteActionFrame(actionId, actionType, request);
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

export async function dispatchRemoteActionWithoutReply(actionType, request) {
  if (!state.remoteAuth) {
    throw new Error("this browser is not paired yet");
  }
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }
  if (requiresSessionClaim(actionType) && !state.remoteAuth.sessionClaim) {
    throw new Error("device is not claimed yet");
  }

  const actionId = makeActionId(actionType);
  sendBrokerFrame(
    requiresSessionClaim(actionType)
      ? await buildClaimedActionPayload(actionId, actionType, request)
      : await buildDeviceActionPayload(actionId, actionType, request),
    socket
  );
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

/// Build and send the frame for one action attempt.
///
/// Separate from `dispatchRemoteAction` so a resend can reproduce the request under its
/// ORIGINAL action id — see `resendPendingActions`.
async function sendRemoteActionFrame(actionId, actionType, request) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("broker socket is not connected");
  }
  if (actionType === "claim_challenge") {
    sendBrokerFrame(await buildClaimChallengePayload(actionId), socket);
    return;
  }
  if (actionType === "claim_device") {
    sendBrokerFrame(await buildClaimDevicePayload(actionId, request), socket);
    return;
  }
  if (requiresSessionClaim(actionType) && !state.remoteAuth.sessionClaim) {
    throw new Error("device is not claimed yet");
  }
  sendBrokerFrame(
    requiresSessionClaim(actionType)
      ? await buildClaimedActionPayload(actionId, actionType, request)
      : await buildDeviceActionPayload(actionId, actionType, request),
    socket
  );
}

/// Stand down the deadlines of everything still in flight, without failing anything.
///
/// Used when the relay leaves the room: we know precisely why no reply is coming, so
/// letting the deadline fire would report a failure the user is likely to answer by
/// redoing the action — and a redo mints a new action id, which misses the relay's
/// replay cache and can execute a write for the second time. The honest state here is
/// "outcome unknown until the relay is back", so the attempt is kept and resent under
/// its own id by `resendPendingActions`.
export function suspendPendingActionDeadlines() {
  for (const pending of state.pendingActions.values()) {
    window.clearTimeout(pending.timeoutId);
    pending.timeoutId = null;
  }
}

/// Ask again for every reply we are still waiting on, under the same action ids.
///
/// Reusing the id is the whole point, and it is what makes this safe for writes. The
/// relay caches a completed result under `(device_id, action_id)` and replays it rather
/// than re-executing, so a `send_message` whose reply was lost is answered from that
/// cache instead of being sent twice. A fresh id would miss the cache and run it again.
///
/// If the original is still executing, the relay recognises the duplicate and stays
/// quiet; its own reply is still addressed to this surface and still arrives.
export async function resendPendingActions() {
  const attempts = [...state.pendingActions.entries()];
  for (const [actionId, pending] of attempts) {
    if (!pending || pending.actionType === "claim_challenge") {
      continue;
    }
    try {
      await sendRemoteActionFrame(actionId, pending.actionType, pending.request);
      extendPendingActionDeadline(actionId);
    } catch (error) {
      rejectPendingAction(actionId, error);
    }
  }
}

/// Restart the deadline for an action that is demonstrably still being answered.
function extendPendingActionDeadline(actionId) {
  const pending = state.pendingActions.get(actionId);
  if (!pending) {
    return;
  }
  window.clearTimeout(pending.timeoutId);
  pending.timeoutId = window.setTimeout(() => {
    rejectPendingAction(
      actionId,
      new Error(`remote ${pending.actionType} timed out waiting for relay response`)
    );
  }, actionDeadlineMs(pending.actionType));
}

function registerPendingAction(actionId, actionType, request) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      rejectPendingAction(
        actionId,
        new Error(`remote ${actionType} timed out waiting for relay response`)
      );
    }, actionDeadlineMs(actionType));

    state.pendingActions.set(actionId, {
      actionType,
      // Kept so the attempt can be reproduced verbatim under the same id.
      request,
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
  return ACTIONS_REQUIRING_SESSION_CLAIM.has(actionType);
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
