// Revision-keyed cache for `GET /api/orchestrator/proposals`.
//
// Same shape as `teams-cache.js`. The snapshot carries only
// `orchestrator_proposals_revision`: pending cards carry multi-KB briefs and sit
// for weeks, and riding every frame they crowded the live transcript into shells.

const MAX_ATTEMPTS_PER_REVISION = 3;

export function proposalsRevisionOf(session) {
  return session?.orchestrator_proposals_revision ?? 0;
}

export function createProposalsCache() {
  let syncedRevision = null;
  // Identified by request, not revision: a refetch at the same revision must be
  // able to orphan the one a local edit made stale.
  let inflight = null;
  let requestSeq = 0;
  let loaded = false;
  let data = { proposals: [] };
  let failedRevision = null;
  let failures = 0;
  let lastSnapshotRevision = null;
  // The snapshot revision a local edit was made under; until a snapshot moves past
  // it, that snapshot predates the edit and must not wipe it.
  let editBaseRevision = null;

  function invalidate() {
    syncedRevision = null;
    failedRevision = null;
    failures = 0;
    inflight = null;
  }

  function localEdit(next, onUpdate) {
    data = { proposals: next };
    editBaseRevision = lastSnapshotRevision;
    invalidate();
    onUpdate?.();
  }

  return {
    current() {
      return data;
    },
    hasData() {
      return loaded;
    },
    isSyncing() {
      return inflight !== null;
    },
    invalidate,
    /** Show a card the relay just accepted before the next snapshot names its revision. */
    stage(proposal, onUpdate) {
      if (!proposal?.id) return;
      localEdit(
        [...data.proposals.filter((entry) => entry?.id !== proposal.id), proposal],
        onUpdate
      );
    },
    drop(proposalId, onUpdate) {
      localEdit(
        data.proposals.filter((entry) => entry?.id !== proposalId),
        onUpdate
      );
    },
    async sync(snapshotRevision, fetchProposals, onUpdate, onError) {
      if (snapshotRevision == null) return;
      lastSnapshotRevision = snapshotRevision;
      if (editBaseRevision !== null && snapshotRevision !== editBaseRevision) {
        editBaseRevision = null;
      }
      // Zero is the relay saying "no cards"; there is nothing to fetch.
      if (snapshotRevision === 0) {
        if (editBaseRevision === 0) return;
        const changed = !loaded || data.proposals.length > 0;
        syncedRevision = 0;
        loaded = true;
        data = { proposals: [] };
        if (changed) onUpdate?.();
        return;
      }
      if (syncedRevision === snapshotRevision || inflight?.revision === snapshotRevision) return;
      if (failedRevision === snapshotRevision && failures >= MAX_ATTEMPTS_PER_REVISION) return;
      if (failedRevision !== snapshotRevision) {
        failedRevision = null;
        failures = 0;
      }
      const request = { revision: snapshotRevision, seq: (requestSeq += 1) };
      inflight = request;
      try {
        const response = await fetchProposals();
        if (inflight !== request) return;
        if (response == null) {
          failedRevision = snapshotRevision;
          failures += 1;
          onError?.(new Error("the relay returned no proposal list"));
          return;
        }
        syncedRevision = snapshotRevision;
        loaded = true;
        failedRevision = null;
        failures = 0;
        data = { proposals: Array.isArray(response.proposals) ? response.proposals : [] };
        onError?.(null);
        onUpdate?.();
      } catch (error) {
        if (inflight !== request) return;
        // Keep the cards on screen: one failed poll must not blank a pending decision.
        failedRevision = snapshotRevision;
        failures += 1;
        onError?.(error);
      } finally {
        if (inflight === request) inflight = null;
      }
    },
  };
}
