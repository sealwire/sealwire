export function seedRemoteAuth(state, saveRemoteAuth, remoteAuth, patch = {}) {
  saveRemoteAuth(remoteAuth);
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
