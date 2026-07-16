import test from "node:test";
import assert from "node:assert/strict";

// The pairing decision takes seconds (two broker HTTP round-trips behind the
// relay endpoint), and the Approve button gives no feedback — inviting a
// double-tap. A duplicate in-flight decision used to reach the relay twice,
// where the second call rotated + revoked the first tap's freshly-issued
// credentials (bricking the device being approved). The controller must
// serialize decisions per pairing_id: while one is in flight, further taps are
// no-ops; after it settles (success OR failure), deciding again is allowed.
//
// pairing.js transitively imports dom.js, which queries the document at import
// time — stub just enough DOM for the import to succeed.
function fakeNode() {
  const target = function () {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "";
      }
      if (!(prop in t)) {
        t[prop] = fakeNode();
      }
      return t[prop];
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
    apply() {
      return fakeNode();
    },
  });
}
globalThis.document = fakeNode();
globalThis.window = fakeNode();

const { createPairingController } = await import("./pairing.js");

function buildController({ apiFetch }) {
  const state = { session: { pending_pairing_requests: [] } };
  const renders = [];
  const controller = createPairingController({
    state,
    apiFetch,
    shortId: (value) => String(value),
    logLine: () => {},
    renderSession: (session) => {
      renders.push(session);
    },
    liveElement: () => null,
    applySessionSnapshot: () => {},
    loadSession: async () => {},
  });
  return { controller, state, renders };
}

test("decidePairingRequest: a second tap while the first is in flight sends no second request", async () => {
  let fetchCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { controller, state } = buildController({
    apiFetch: async () => {
      fetchCalls += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({ ok: true, data: { message: "approved" } }),
      };
    },
  });

  const firstTap = controller.decidePairingRequest("pair-1", "approve");
  const secondTap = controller.decidePairingRequest("pair-1", "approve");
  await Promise.resolve();
  assert.equal(
    fetchCalls,
    1,
    "the duplicate tap must not fire a second decision request while one is in flight"
  );

  release();
  await Promise.all([firstTap, secondTap]);
  assert.deepEqual(
    state.pendingPairingDecisions ?? {},
    {},
    "the in-flight marker must be cleared once the decision settles"
  );
});

test("decidePairingRequest: after a failed decision the operator can retry", async () => {
  let fetchCalls = 0;
  const { controller } = buildController({
    apiFetch: async () => {
      fetchCalls += 1;
      throw new Error("network down");
    },
  });

  await controller.decidePairingRequest("pair-1", "approve");
  await controller.decidePairingRequest("pair-1", "approve");
  assert.equal(fetchCalls, 2, "a settled (failed) decision must release the guard for retry");
});

test("decidePairingRequest: decisions for different pairings do not block each other", async () => {
  let fetchCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { controller } = buildController({
    apiFetch: async () => {
      fetchCalls += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({ ok: true, data: { message: "approved" } }),
      };
    },
  });

  const first = controller.decidePairingRequest("pair-1", "approve");
  const second = controller.decidePairingRequest("pair-2", "reject");
  await Promise.resolve();
  assert.equal(fetchCalls, 2, "independent pairings must proceed concurrently");
  release();
  await Promise.all([first, second]);
});
