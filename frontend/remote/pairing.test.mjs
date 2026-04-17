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

test("expired pairing result from relay is translated into a clear QR renewal message", async () => {
  installBrowserStubs();
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");
  const { state } = await import("./state.js");

  seedSocketState(state, {
    socketPeerId: "surface-expired",
  });
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

  assert.equal(state.pairingPhase, "error");
  assert.match(
    state.pairingError,
    /QR code or pairing link has expired.*Generate a new QR code/i
  );
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
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/session$/);
  assert.equal(state.clientAuth?.clientId, "client-1");
  assert.equal(state.remoteProfiles["relay-2"]?.relayId, "relay-2");
});
