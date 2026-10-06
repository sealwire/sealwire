export const TEST_RELAY_VERIFY_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

/// A seeded claim is a request session the relay opened: give it the boot and clock a
/// real claim reply carries, and pin the relay key, so requests can be signed.
export function seedRemoteAuth(state, saveRemoteAuth, remoteAuth, patch = {}) {
  const claimed = remoteAuth.sessionClaim && remoteAuth.sessionClaimBoot === undefined
    ? {
      sessionClaimBoot: "test-boot",
      sessionClaimRelayMs: 2_000_000_000,
      sessionClaimReceivedAt: performance.now(),
    }
    : {};
  saveRemoteAuth({ relayVerifyKey: TEST_RELAY_VERIFY_KEY, ...remoteAuth, ...claimed });
  Object.assign(state, patch);
}

export function seedPairingState(state, patch = {}) {
  Object.assign(
    state,
    {
      pairingError: null,
      pairingPhase: null,
      // Must be reset explicitly: a leftover retirement from a previous seed makes
      // `connectionTarget` refuse the freshly seeded ticket, so the code under test
      // silently never connects.
      pairingRetired: false,
      pairingTicket: null,
    },
    patch
  );
}

export function seedSocketState(state, patch = {}) {
  if (patch.socket && !("relayPeerId" in patch.socket)) {
    patch.socket.relayPeerId = state.pairingTicket?.relay_peer_id ?? state.remoteAuth?.relayPeerId;
  }
  Object.assign(
    state,
    {
      socket: null,
      socketConnected: false,
      socketPeerId: null,
      socketReconnectTimer: null,
    },
    patch
  );
}

export function seedTranscriptHydrationState(state, patch = {}) {
  Object.assign(
    state,
    {
      transcriptHydrationPromise: null,
      transcriptHydrationSignature: null,
      transcriptHydrationThreadId: null,
      transcriptHydrationBaseSnapshot: null,
      transcriptHydrationOlderCursor: null,
      transcriptHydrationEntries: new Map(),
      transcriptHydrationOrder: [],
      transcriptHydrationStatus: "idle",
      transcriptHydrationTailReady: false,
      transcriptHydrationLastFetchAt: 0,
      // Row bookkeeping lives on the shared state too; a test must not inherit it.
      transcriptUnresolvedRows: new Map(),
      transcriptRowBodyRevisions: new Map(),
      transcriptRowSeenRevisions: new Map(),
      transcriptTailSawShells: false,
      transcriptHydrationNeedsTailRepair: false,
      transcriptRowRecoveryInFlight: null,
      transcriptRowRecoveryInFlightSet: null,
    },
    patch
  );
}
