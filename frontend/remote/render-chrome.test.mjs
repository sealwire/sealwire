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
const { renderDeviceMeta } = await import("./render-chrome.js");
const { state } = await import("./state.js");

test("device meta renders without old key-storage warnings", async () => {
  state.remoteAuth = null;
  state.pairingTicket = null;
  state.relayDirectory = [];
  renderDeviceMeta();

  const unpairedMarkup = browser.elements.get("#device-meta").innerHTML;
  assert.doesNotMatch(unpairedMarkup, /Legacy key storage/);
  assert.doesNotMatch(unpairedMarkup, /legacy localStorage/);

  state.remoteAuth = {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "private",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  state.relayDirectory = [
    {
      relayId: "relay-1",
      relayLabel: "Work Mac",
      brokerRoomId: "room-a",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      hasLocalProfile: true,
      grantedAt: null,
    },
  ];
  renderDeviceMeta();

  const pairedMarkup = browser.elements.get("#device-meta").innerHTML;
  assert.doesNotMatch(pairedMarkup, /Legacy key storage/);
  assert.doesNotMatch(pairedMarkup, /legacy localStorage/);
  assert.match(pairedMarkup, /Primary Phone/);
  assert.equal(browser.elements.get("#remote-home-button").hidden, false);
});

test("device meta calls out relays that need local credential recovery", async () => {
  state.session = null;
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

  renderDeviceMeta();

  const markup = browser.elements.get("#device-meta").innerHTML;
  assert.match(markup, /Re-pair required/);
  assert.match(markup, /local encrypted credentials are unavailable/i);
  assert.equal(
    browser.elements.get("#remote-workspace-subtitle").textContent,
    "Local encrypted credentials are unavailable in this browser. Pair this relay again on this device to restore remote access."
  );
});
