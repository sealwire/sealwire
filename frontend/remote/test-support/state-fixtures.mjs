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
      transcriptHydrationStatus: "idle",
      transcriptHydrationTailReady: false,
      transcriptHydrationLastFetchAt: 0,
    },
    patch
  );
}
