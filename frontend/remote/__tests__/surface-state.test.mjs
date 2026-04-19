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
  createTranscriptScrollModePatch,
} = await import("../surface-state.js");
const { state } = await import("../state.js");

test("createClearedRemoteSurfaceSessionStatePatch clears session, threads, and current approval", () => {
  assert.deepEqual(createClearedRemoteSurfaceSessionStatePatch(), {
    currentApprovalId: null,
    session: null,
    threadsError: null,
    threads: [],
  });
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
  assert.deepEqual(patch, {
    currentApprovalId: null,
    session: null,
    threadsError: null,
    threads: [],
  });
});

test("createRemoteThreadsPatch returns the canonical thread list patch", () => {
  const nextThreads = [{ thread_id: "thread-2" }];

  assert.deepEqual(createRemoteThreadsPatch(nextThreads), {
    threadsError: null,
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

test("createTranscriptScrollModePatch returns the scroll mode patch", () => {
  assert.deepEqual(createTranscriptScrollModePatch("preserve"), {
    transcriptScrollMode: "preserve",
  });
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
  const previousMode = state.transcriptScrollMode;
  const previousApprovalId = state.currentApprovalId;

  applyRemoteSurfacePatch({
    currentApprovalId: "approval-test",
    transcriptScrollMode: "preserve",
  });

  assert.equal(state.currentApprovalId, "approval-test");
  assert.equal(state.transcriptScrollMode, "preserve");

  applyRemoteSurfacePatch({
    currentApprovalId: previousApprovalId,
    transcriptScrollMode: previousMode,
  });
});
