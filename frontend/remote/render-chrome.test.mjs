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
const { renderDeviceMeta, renderSessionChrome } = await import("./render-chrome.js");
const { state } = await import("./state.js");

test("device meta renders without old key-storage warnings", async () => {
  state.clientAuth = null;
  state.remoteAuth = null;
  state.pairingTicket = null;
  state.relayDirectory = [];
  renderDeviceMeta();

  const unpairedMarkup = browser.elements.get("#device-meta").innerHTML;
  assert.doesNotMatch(unpairedMarkup, /Legacy key storage/);
  assert.doesNotMatch(unpairedMarkup, /legacy localStorage/);
  assert.equal(
    browser.elements.get("#remote-workspace-subtitle").textContent,
    "Open a pairing QR from your local relay to control Codex remotely."
  );

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
  assert.equal(
    browser.elements.get("#remote-workspace-subtitle").textContent,
    "Remote device paired. Start a session, resume one from history, or wait for a live thread."
  );
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

test("session chrome keeps the header compact and only shows the control banner when another device controls", async () => {
  state.socketConnected = true;
  state.remoteAuth = {
    relayId: "relay-1",
    relayLabel: "agent-relay",
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

  renderSessionChrome({
    active_thread_id: "thread-1",
    current_cwd: "/Users/luchi/git/agent-relay",
    current_status: "idle",
    codex_connected: true,
    broker_connected: true,
    broker_channel_id: "room-a",
    broker_peer_id: "relay-peer-1",
    security_mode: "private",
    e2ee_enabled: true,
    broker_can_read_content: false,
    audit_enabled: false,
    active_controller_device_id: "device-1",
    pending_approvals: [],
  });

  assert.equal(browser.elements.get("#remote-workspace-title").textContent, "agent-relay");
  assert.equal(
    browser.elements.get("#remote-workspace-subtitle").textContent,
    "/Users/luchi/git/agent-relay"
  );
  assert.equal(browser.elements.get("#remote-status-badge").textContent, "Ready");
  assert.equal(browser.elements.get("#remote-control-banner").hidden, true);
  assert.equal(
    browser.elements.get("#remote-session-path").textContent,
    "/Users/luchi/git/agent-relay"
  );

  renderSessionChrome({
    active_thread_id: "thread-1",
    current_cwd: "/Users/luchi/git/agent-relay",
    current_status: "idle",
    codex_connected: true,
    broker_connected: true,
    broker_channel_id: "room-a",
    broker_peer_id: "relay-peer-1",
    security_mode: "private",
    e2ee_enabled: true,
    broker_can_read_content: false,
    audit_enabled: false,
    active_controller_device_id: "device-2",
    pending_approvals: [],
  });

  assert.equal(browser.elements.get("#remote-control-banner").hidden, false);
  assert.equal(browser.elements.get("#remote-control-summary").textContent, "Controlled by device-2");
  assert.equal(browser.elements.get("#remote-control-hint").textContent, "Read-only here until you take over.");
});
