import test from "node:test";
import assert from "node:assert/strict";
import {
  seedPairingState,
  seedSocketState,
} from "./test-support/state-fixtures.mjs";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    hidden: false,
    readOnly: false,
    open: false,
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    close() {
      this.open = false;
    },
    showModal() {
      this.open = true;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

function installBrowserStubs() {
  const storage = new Map();
  const elements = new Map();
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
  };
  globalThis.window = {
    localStorage,
    // Real windows have timers. `session-ops` schedules the thread poll and the search
    // debounce through `window`, and a surface reset clears them — so a stub without
    // these turns any teardown into a TypeError rather than exercising it.
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    location: { href: "https://remote.example.test/" },
    history: {
      replaceState() {},
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    crypto: {
      getRandomValues(buffer) {
        return buffer.fill(7);
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

test("expired pairing link is rejected locally with a clear QR renewal message", async () => {
  installBrowserStubs();
  const { beginPairing } = await import("./pairing.js");
  const { state } = await import("./state.js");

  seedPairingState(state);

  const payload = {
    broker_channel_id: "dev-room",
    broker_url: "ws://192.168.1.47:8788",
    expires_at: Math.floor(Date.now() / 1000) - 5,
    pairing_id: "pair-expired-local",
    pairing_join_ticket: "expired-pairing-ticket",
    pairing_secret: "expired-pairing-secret",
    relay_peer_id: "local-relay",
    security_mode: "private",
    version: 1,
  };
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");

  await beginPairing(raw, { auto: true });

  assert.equal(state.pairingPhase, "error");
  assert.match(
    state.pairingError,
    /QR code or pairing link has expired.*Generate a new QR code/i
  );
});

test("an expired attempt's result is discarded by the handler; the gate owns the message", async () => {
  // This used to assert the handler itself translated an expired result into the QR
  // renewal message. The policy now lives one layer up: the socket gate drops every frame
  // on an expired attempt and calls `retirePairing(expiredPairingMessage())`, so the
  // user-facing guarantee is unchanged but is covered by
  // `broker-client.test.mjs` → "a pairing ticket that expires after the socket opens
  // retires that socket, not the old session". Keeping the handler in step with the gate
  // is what stops a test from documenting behaviour the product does not have.
  installBrowserStubs();
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");
  const { state } = await import("./state.js");

  seedSocketState(state, { socketPeerId: "surface-expired" });
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: {
      pairing_id: "pair-expired-approval",
      pairing_secret: "expired-approval-secret",
      broker_url: "ws://192.168.1.47:8788",
      broker_channel_id: "dev-room",
      relay_peer_id: "local-relay",
      security_mode: "private",
      expires_at: Math.floor(Date.now() / 1000) - 1,
    },
  });

  const envelope = await encryptJson(state.pairingTicket.pairing_secret, {
    ok: false,
    error: "pairing request is missing or expired",
  });

  await handleEncryptedPairingResult({
    pairing_id: state.pairingTicket.pairing_id,
    target_peer_id: "surface-expired",
    envelope,
  });

  assert.equal(
    state.pairingPhase,
    "requesting",
    "the handler must discard it, leaving the gate as the single place that retires"
  );
  assert.equal(state.pairingError, null);
});

test("forgeting one relay does not clear the broker-wide client session cookie", async () => {
  installBrowserStubs();
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({
      url: String(url),
      options,
    });
    return {
      ok: true,
      async json() {
        return {};
      },
    };
  };

  const { forgetCurrentDevice } = await import(`./pairing.js?forget-${Date.now()}`);
  const {
    state,
    saveClientAuth,
    selectRelayProfile,
  } = await import("./state.js");

  saveClientAuth({
    clientId: "client-1",
    brokerControlUrl: "https://broker.example.test",
  });
  state.remoteProfiles = {
    "relay-1": {
      relayId: "relay-1",
      brokerUrl: "wss://broker.example.test",
      brokerChannelId: "room-a",
      relayPeerId: "relay-1",
      securityMode: "private",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: "payload-secret-1",
      hasStoredPayloadSecret: true,
      deviceRefreshMode: "cookie",
      deviceJoinTicket: null,
      deviceJoinTicketExpiresAt: null,
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    },
    "relay-2": {
      relayId: "relay-2",
      brokerUrl: "wss://broker.example.test",
      brokerChannelId: "room-b",
      relayPeerId: "relay-2",
      securityMode: "private",
      deviceId: "device-2",
      deviceLabel: "Tablet",
      payloadSecret: "payload-secret-2",
      hasStoredPayloadSecret: true,
      deviceRefreshMode: "cookie",
      deviceJoinTicket: null,
      deviceJoinTicketExpiresAt: null,
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    },
  };
  selectRelayProfile("relay-1");

  forgetCurrentDevice();

  assert.equal(fetchCalls.length, 1);
  // Forget clears only relay-1's own room-scoped device session, not the
  // broker-wide client session and not relay-2's.
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/room-a\/session$/);
  assert.equal(state.clientAuth?.clientId, "client-1");
  assert.equal(state.remoteProfiles["relay-2"]?.relayId, "relay-2");
});

test("forgetting one relay must NOT clear the device session a sibling relay on the same broker still needs", async () => {
  // The device session cookie (agent_relay_device_session) is scoped per broker
  // ORIGIN, not per relay — so all relays fronted by one public broker share a
  // single cookie. Forgetting relay-1 while relay-2 lives on the SAME broker must
  // not clear that shared cookie, otherwise relay-2's device auth is silently
  // bricked (and, with device tokens no longer persisted, unrecoverably so).
  installBrowserStubs();
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: true,
      async json() {
        return {};
      },
    };
  };

  const { forgetCurrentDevice } = await import(`./pairing.js?forget-sibling-${Date.now()}`);
  const { state, saveClientAuth, selectRelayProfile } = await import("./state.js");

  saveClientAuth({
    clientId: "client-1",
    brokerControlUrl: "https://broker.example.test",
  });
  state.remoteProfiles = {
    "relay-1": {
      relayId: "relay-1",
      brokerUrl: "wss://broker.example.test",
      brokerChannelId: "room-a",
      relayPeerId: "relay-1",
      securityMode: "private",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: "payload-secret-1",
      hasStoredPayloadSecret: true,
      deviceRefreshMode: "cookie",
      deviceJoinTicket: null,
      deviceJoinTicketExpiresAt: null,
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    },
    "relay-2": {
      relayId: "relay-2",
      brokerUrl: "wss://broker.example.test",
      brokerChannelId: "room-b",
      relayPeerId: "relay-2",
      securityMode: "private",
      deviceId: "device-2",
      deviceLabel: "Tablet",
      payloadSecret: "payload-secret-2",
      hasStoredPayloadSecret: true,
      deviceRefreshMode: "cookie",
      deviceJoinTicket: null,
      deviceJoinTicketExpiresAt: null,
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    },
  };
  selectRelayProfile("relay-1");

  forgetCurrentDevice();

  const deletes = fetchCalls
    .filter((call) => call.options?.method === "DELETE")
    .map((call) => call.url);
  // relay-2's (room-b) device session must be untouched — that is the whole fix.
  assert.ok(
    !deletes.some((url) => /\/api\/public\/device\/room-b\/session$/.test(url)),
    "forgetting relay-1 cleared relay-2's (room-b) device session — siblings on the same broker must stay isolated"
  );
  // ...while relay-1 does clear its OWN (room-a) session.
  assert.ok(
    deletes.some((url) => /\/api\/public\/device\/room-a\/session$/.test(url)),
    "forgetting relay-1 should still clear its own (room-a) device session"
  );
  assert.equal(state.remoteProfiles["relay-2"]?.relayId, "relay-2");
});

test("forgetting the last relay on a broker still clears its device session", async () => {
  // Boundary guard for the fix above: when no sibling shares the broker, there is
  // nothing to protect, so the device session should still be cleared.
  installBrowserStubs();
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: true,
      async json() {
        return {};
      },
    };
  };

  const { forgetCurrentDevice } = await import(`./pairing.js?forget-last-${Date.now()}`);
  const { state, saveClientAuth, selectRelayProfile } = await import("./state.js");

  saveClientAuth({
    clientId: "client-1",
    brokerControlUrl: "https://broker.example.test",
  });
  state.remoteProfiles = {
    "relay-1": {
      relayId: "relay-1",
      brokerUrl: "wss://broker.example.test",
      brokerChannelId: "room-a",
      relayPeerId: "relay-1",
      securityMode: "private",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: "payload-secret-1",
      hasStoredPayloadSecret: true,
      deviceRefreshMode: "cookie",
      deviceJoinTicket: null,
      deviceJoinTicketExpiresAt: null,
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    },
  };
  selectRelayProfile("relay-1");

  forgetCurrentDevice();

  const clearedDeviceSession = fetchCalls.some(
    (call) =>
      /\/api\/public\/device\/room-a\/session$/.test(call.url) && call.options?.method === "DELETE"
  );
  assert.equal(
    clearedDeviceSession,
    true,
    "forgetting the only relay on a broker should still clear its device session"
  );
});

test("a retired pairing ignores late results, but a merely-expired one still surfaces its reason", async () => {
  // Guard-placement regression: gating this handler on `hasActivePairing()` looks like
  // the tidy unification, but an expired ticket is not "active" — and a result arriving
  // for it is the relay saying WHY pairing failed. Dropping it strands the user on a
  // "requesting" spinner with the explanation only in the logs. A ticket that has
  // already been retired is the only one with nothing left to learn.
  installBrowserStubs();
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");
  const { state } = await import("./state.js");

  const secret = "late-result-secret";
  const ticket = {
    pairing_id: "pair-late",
    pairing_secret: secret,
    broker_url: "ws://192.168.1.47:8788",
    broker_channel_id: "dev-room",
    relay_peer_id: "local-relay",
    security_mode: "private",
    expires_at: Math.floor(Date.now() / 1000) - 1,
  };
  const envelope = await encryptJson(secret, {
    ok: false,
    error: "pairing request was rejected on the local relay",
  });
  const frame = {
    pairing_id: ticket.pairing_id,
    target_peer_id: "surface-late",
    envelope,
  };

  // Already retired: nothing should change.
  seedSocketState(state, { socketPeerId: "surface-late" });
  seedPairingState(state, {
    pairingPhase: "error",
    pairingError: "the original reason",
    pairingRetired: true,
    pairingTicket: ticket,
  });
  await handleEncryptedPairingResult(frame);
  assert.equal(
    state.pairingError,
    "the original reason",
    "a late result must not overwrite the reason the pairing was already retired for"
  );

  // Expired but not yet retired: also discarded, matching the socket gate. The expiry
  // message the user sees comes from `retirePairing` at that gate, not from here.
  seedSocketState(state, { socketPeerId: "surface-late" });
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: ticket,
  });
  await handleEncryptedPairingResult(frame);
  assert.equal(
    state.pairingPhase,
    "requesting",
    "an expired attempt's result must be discarded here too, exactly as the gate does"
  );

  // A LIVE attempt is the one whose relay reason must land.
  seedSocketState(state, { socketPeerId: "surface-late" });
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: { ...ticket, expires_at: Math.floor(Date.now() / 1000) + 120 },
  });
  await handleEncryptedPairingResult(frame);
  assert.equal(state.pairingPhase, "error");
  assert.equal(state.pairingRetired, true, "handling it must also complete retirement");
  assert.match(state.pairingError, /rejected/i);
});

// The waiting screen can only show the fingerprint the request step recorded.
test("sending a pairing request records the fingerprint the computer will show", async () => {
  installBrowserStubs();
  globalThis.WebSocket = { OPEN: 1 };
  const { sendPairingRequest } = await import("./pairing.js");
  const { state } = await import("./state.js");
  const sent = [];
  const socket = { readyState: 1, send: (frame) => sent.push(frame) };

  seedSocketState(state, { socket, socketConnected: true, socketPeerId: "surface-fp" });
  seedPairingState(state, {
    pairingTicket: {
      pairing_id: "pair-fingerprint",
      pairing_secret: "fingerprint-secret",
      broker_url: "wss://broker.example.test",
      broker_channel_id: "room-fp",
      relay_peer_id: "local-relay",
      security_mode: "private",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  });
  Object.assign(state, {
    deviceKeypair: {
      verifyKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
      sign: async () => new Uint8Array(64),
    },
    requestedDeviceId: "mobile-fp",
  });

  await sendPairingRequest();

  assert.equal(sent.length, 1, "the request went out");
  assert.equal(state.pairingPhase, "requesting");
  assert.equal(state.pairingFingerprint, "ae:21:6c:2e:f5:24:7a:37");
});
