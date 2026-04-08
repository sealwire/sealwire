import test from "node:test";
import assert from "node:assert/strict";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    hidden: false,
    readOnly: false,
    dataset: {},
    addEventListener() {},
    setAttribute() {},
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
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });

  return { elements };
}

const browser = installBrowserStubs();
const { renderEmptyState } = await import("./render.js");
const { state } = await import("./state.js");

test("renderEmptyState shows relay directory home when no relay is selected", async () => {

  state.clientAuth = {
    clientId: "client-1",
    clientRefreshToken: "refresh-1",
    brokerControlUrl: "https://broker.example.test",
  };
  state.remoteAuth = null;
  state.pairingTicket = null;
  state.relayDirectory = [
    {
      relayId: "relay-1",
      relayLabel: "Work Mac",
      brokerRoomId: "room-a",
      deviceId: "device-1",
      deviceLabel: "iPhone",
      hasLocalProfile: true,
      grantedAt: null,
    },
  ];

  renderEmptyState();

  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Choose a relay/);
  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Work Mac/);
  assert.equal(browser.elements.get("#remote-session-toggle").disabled, true);
  assert.equal(browser.elements.get("#remote-session-toggle").textContent, "Select a relay first");
  assert.equal(browser.elements.get("#remote-home-button").hidden, true);
});

test("renderEmptyState shows first-pair copy when no relay grants exist", async () => {
  state.clientAuth = null;
  state.remoteAuth = null;
  state.pairingTicket = null;
  state.relayDirectory = [];

  renderEmptyState();

  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Pair your first relay/);
  assert.match(
    browser.elements.get("#remote-message-input").placeholder,
    /Pair this browser before sending messages/
  );
});

test("renderEmptyState shows re-pair guidance when local credentials are missing", async () => {
  state.clientAuth = {
    clientId: "client-1",
    brokerControlUrl: "https://broker.example.test",
  };
  state.remoteAuth = {
    relayId: "relay-1",
    relayLabel: "Work Mac",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "private",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: null,
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: null,
    deviceJoinTicketExpiresAt: null,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  state.pairingTicket = null;
  state.relayDirectory = [
    {
      relayId: "relay-1",
      relayLabel: "Work Mac",
      brokerRoomId: "room-a",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      hasLocalProfile: false,
      needsLocalRePairing: true,
      grantedAt: null,
    },
  ];

  renderEmptyState();

  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Local credentials missing/);
  assert.match(browser.elements.get("#remote-transcript").innerHTML, /Pair this relay again on this device/);
  assert.equal(browser.elements.get("#remote-session-toggle").disabled, true);
  assert.match(
    browser.elements.get("#remote-message-input").placeholder,
    /Local credentials are unavailable/
  );
});
