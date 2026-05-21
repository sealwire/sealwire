import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const storage = new Map();

  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    location: { origin: "https://remote.example.test" },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

installBrowserStubs();

const {
  applyRemoteSurfacePatch,
  createClearedRemoteSurfaceSessionStatePatch,
  createClearedTranscriptHydrationPatch,
  createBrokerConnectionPatch,
  createClaimLifecyclePatch,
  createPairingStatePatch,
  createRemoteThreadsPatch,
  createResetRemoteSurfaceStatePatch,
  createSessionRuntimeStatePatch,
} = await import("../surface-state.js");
const { state } = await import("../state.js");

function assertClearedSessionPatch(patch) {
  assert.equal(patch.currentApprovalId, null);
  assert.equal(patch.session, null);
  assert.deepEqual(patch.threads, []);
  // The cleared session patch also wipes the transcript entry detail
  // caches so a fresh session does not surface stale tool diffs from the
  // previous one. Pin those fields here so we notice if the cleanup is
  // dropped.
  assert.ok(patch.transcriptEntryDetailCache instanceof Map);
  assert.equal(patch.transcriptEntryDetailCache.size, 0);
  assert.deepEqual(patch.transcriptEntryDetailOrder, []);
  assert.ok(patch.transcriptLiveEntryDetails instanceof Map);
  assert.equal(patch.transcriptLiveEntryDetails.size, 0);
  assert.equal(patch.transcriptLiveEntryThreadId, null);
}

test("createClearedRemoteSurfaceSessionStatePatch clears session, threads, current approval, and transcript caches", () => {
  assertClearedSessionPatch(createClearedRemoteSurfaceSessionStatePatch());
});

test("createResetRemoteSurfaceStatePatch returns reset state and runs lifecycle hooks", () => {
  const calls = [];

  const patch = createResetRemoteSurfaceStatePatch({
    clearClaimLifecycle() {
      calls.push("claim");
    },
    clearSessionRuntime() {
      calls.push("runtime");
    },
    rejectPendingActions(reason) {
      calls.push(`reject:${reason}`);
    },
    reason: "unit-test reset",
  });

  assert.deepEqual(calls, ["claim", "runtime", "reject:unit-test reset"]);
  assertClearedSessionPatch(patch);
});

test("createRemoteThreadsPatch returns the canonical thread list patch", () => {
  const nextThreads = [{ thread_id: "thread-2" }];

  assert.deepEqual(createRemoteThreadsPatch(nextThreads), {
    threads: nextThreads,
  });
});

test("createSessionRuntimeStatePatch returns the session runtime patch", () => {
  const session = { active_thread_id: "thread-1" };

  assert.deepEqual(
    createSessionRuntimeStatePatch({
      currentApprovalId: "approval-1",
      session,
    }),
    {
      currentApprovalId: "approval-1",
      session,
    }
  );
});

test("createPairingStatePatch only includes defined pairing fields", () => {
  assert.deepEqual(
    createPairingStatePatch({
      pairingPhase: "connecting",
      pairingError: null,
    }),
    {
      pairingPhase: "connecting",
      pairingError: null,
    }
  );
});

test("createBrokerConnectionPatch only includes defined connection fields", () => {
  assert.deepEqual(
    createBrokerConnectionPatch({
      socket: null,
      socketConnected: false,
      socketPeerId: null,
    }),
    {
      socket: null,
      socketConnected: false,
      socketPeerId: null,
    }
  );
});

test("createClaimLifecyclePatch only includes defined lifecycle fields", () => {
  assert.deepEqual(
    createClaimLifecyclePatch({
      claimPromise: null,
      recoverPromise: null,
      recoveredSocketPeerId: null,
    }),
    {
      claimPromise: null,
      recoverPromise: null,
      recoveredSocketPeerId: null,
    }
  );
});

test("createClearedTranscriptHydrationPatch returns the hydration reset patch", () => {
  const patch = createClearedTranscriptHydrationPatch();

  assert.equal(patch.transcriptHydrationBaseSnapshot, null);
  assert.equal(patch.transcriptHydrationOlderCursor, null);
  assert.equal(patch.transcriptHydrationPromise, null);
  assert.equal(patch.transcriptHydrationSignature, null);
  assert.equal(patch.transcriptHydrationStatus, "idle");
  assert.equal(patch.transcriptHydrationThreadId, null);
  assert.equal(patch.transcriptHydrationLastFetchAt, 0);
  assert.ok(patch.transcriptHydrationEntries instanceof Map);
  assert.equal(patch.transcriptHydrationEntries.size, 0);
});

test("applyRemoteSurfacePatch applies the patch to shared remote state", () => {
  const previousApprovalId = state.currentApprovalId;

  applyRemoteSurfacePatch({
    currentApprovalId: "approval-test",
  });

  assert.equal(state.currentApprovalId, "approval-test");

  applyRemoteSurfacePatch({
    currentApprovalId: previousApprovalId,
  });
});
