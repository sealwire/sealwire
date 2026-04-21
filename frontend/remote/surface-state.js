import { patchRemoteState } from "./state.js";

export function applyRemoteSurfacePatch(patch) {
  return patchRemoteState(patch);
}

export function createClearedRemoteSurfaceSessionStatePatch() {
  return {
    currentApprovalId: null,
    session: null,
    threads: [],
    transcriptLiveEntryDetails: new Map(),
    transcriptLiveEntryThreadId: null,
  };
}

export function createSessionRuntimeStatePatch(sessionRuntime) {
  return {
    currentApprovalId: sessionRuntime.currentApprovalId,
    session: sessionRuntime.session,
  };
}

export function createResetRemoteSurfaceStatePatch({
  clearClaimLifecycle,
  clearSessionRuntime,
  rejectPendingActions,
  reason,
}) {
  clearClaimLifecycle();
  clearSessionRuntime();
  rejectPendingActions(reason);
  return createClearedRemoteSurfaceSessionStatePatch();
}

export function createRemoteThreadsPatch(threads) {
  return {
    threads,
  };
}

export function createPairingStatePatch({
  pairingError,
  pairingPhase,
  pairingTicket,
}) {
  const patch = {};
  if (pairingError !== undefined) {
    patch.pairingError = pairingError;
  }
  if (pairingPhase !== undefined) {
    patch.pairingPhase = pairingPhase;
  }
  if (pairingTicket !== undefined) {
    patch.pairingTicket = pairingTicket;
  }
  return patch;
}

export function createTranscriptScrollModePatch(mode) {
  return {
    transcriptScrollMode: mode,
  };
}

export function createClearedTranscriptHydrationPatch() {
  return {
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOrder: [],
    transcriptHydrationLastFetchAt: 0,
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: false,
    transcriptHydrationThreadId: null,
  };
}

export function createBrokerConnectionPatch({
  socket,
  socketConnected,
  socketPeerId,
  socketReconnectTimer,
}) {
  const patch = {};
  if (socket !== undefined) {
    patch.socket = socket;
  }
  if (socketConnected !== undefined) {
    patch.socketConnected = socketConnected;
  }
  if (socketPeerId !== undefined) {
    patch.socketPeerId = socketPeerId;
  }
  if (socketReconnectTimer !== undefined) {
    patch.socketReconnectTimer = socketReconnectTimer;
  }
  return patch;
}

export function createClaimLifecyclePatch({
  claimPromise,
  claimRefreshTimer,
  recoverPromise,
  recoveredSocketPeerId,
}) {
  const patch = {};
  if (claimPromise !== undefined) {
    patch.claimPromise = claimPromise;
  }
  if (claimRefreshTimer !== undefined) {
    patch.claimRefreshTimer = claimRefreshTimer;
  }
  if (recoverPromise !== undefined) {
    patch.recoverPromise = recoverPromise;
  }
  if (recoveredSocketPeerId !== undefined) {
    patch.recoveredSocketPeerId = recoveredSocketPeerId;
  }
  return patch;
}
