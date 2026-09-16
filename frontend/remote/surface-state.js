import { patchRemoteState } from "./state.js";
import {
  createClearedTranscriptEntryDetailsPatch,
} from "../shared/transcript-entry-details-state.js";
import {
  createClearedTranscriptHydrationPatch as createSharedClearedTranscriptHydrationPatch,
} from "../shared/transcript-hydration-store.js";
import { resetRemoteProjectsStore } from "./projects-host.js";
import { resetRemoteWorkspaceCounts } from "./workspace-diff-host.js";
import { EMPTY_THREAD_SEARCH } from "../shared/thread-search.js";

export function applyRemoteSurfacePatch(patch) {
  return patchRemoteState(patch);
}

export function createClearedRemoteSurfaceSessionStatePatch() {
  return {
    currentApprovalId: null,
    realSession: null,
    session: null,
    threads: [],
    // Results belong to the relay that answered them, and thread ids are only unique
    // within a relay — the same reason fetched Projects are forgotten below.
    threadSearch: { ...EMPTY_THREAD_SEARCH },
    // Both failure channels for the same reason. The goal one also carries the action
    // generation, and leaving it standing lets a request this reset rejected settle
    // afterwards and file the old relay's failure against the new one.
    composerErrors: {},
    goalErrors: {},
    // Keyed by thread id for the same reason, though nothing here failed: a draft the
    // composer held back on one relay would render under another's same-id thread.
    composerHeld: {},
    ...createClearedTranscriptEntryDetailsPatch(),
  };
}

export function createSessionRuntimeStatePatch(sessionRuntime) {
  return {
    currentApprovalId: sessionRuntime.currentApprovalId,
    session: sessionRuntime.session,
  };
}

export function createResetRemoteSurfaceStatePatch({
  cancelThreadSearch,
  clearClaimLifecycle,
  clearSessionRuntime,
  rejectPendingActions,
  reason,
}) {
  clearClaimLifecycle();
  clearSessionRuntime();
  rejectPendingActions(reason);
  // Belongs in the transaction rather than in a relay-id watcher: re-pairing resets the
  // surface while KEEPING the current relay id, so an id-keyed effect never fires and
  // the rejected request writes its error back over the state just cleared.
  //
  // Required, not optional, and deliberately so: the failure this guards against is a
  // reset path that FORGETS to abandon the search. Making it optional would turn that
  // into a silent leak — the exact shape of the bug — instead of an immediate throw.
  cancelThreadSearch();
  // A different relay may advertise an equal projects_revision — forget fetched
  // Projects so the next syncToRevision refetches unconditionally.
  resetRemoteProjectsStore();
  // Counts are cached by path, which only identifies a directory while the relay is the
  // same machine — another host would inherit this one's numbers.
  resetRemoteWorkspaceCounts();
  return createClearedRemoteSurfaceSessionStatePatch();
}

export function createRemoteThreadsPatch(threads) {
  return {
    threads,
  };
}

export function createRemoteThreadSearchPatch(threadSearch) {
  return {
    threadSearch,
  };
}

export function createPairingStatePatch({
  pairingError,
  pairingPhase,
  pairingRetired,
  pairingTicket,
}) {
  const patch = {};
  if (pairingError !== undefined) {
    patch.pairingError = pairingError;
  }
  if (pairingPhase !== undefined) {
    patch.pairingPhase = pairingPhase;
  }
  if (pairingRetired !== undefined) {
    patch.pairingRetired = pairingRetired;
  }
  if (pairingTicket !== undefined) {
    patch.pairingTicket = pairingTicket;
  }
  return patch;
}

export function createClearedTranscriptHydrationPatch() {
  return createSharedClearedTranscriptHydrationPatch();
}

export function createBrokerConnectionPatch({
  relayConnected,
  relayConnectionMessage,
  serverConnectionMessage,
  serverConnectionState,
  socket,
  socketConnected,
  socketPeerId,
  socketReconnectTimer,
}) {
  const patch = {};
  if (relayConnected !== undefined) {
    patch.relayConnected = relayConnected;
  }
  if (relayConnectionMessage !== undefined) {
    patch.relayConnectionMessage = relayConnectionMessage;
  }
  if (serverConnectionMessage !== undefined) {
    patch.serverConnectionMessage = serverConnectionMessage;
  }
  if (serverConnectionState !== undefined) {
    patch.serverConnectionState = serverConnectionState;
  }
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
