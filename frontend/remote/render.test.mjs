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
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
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
const { renderEmptyState, renderSession } = await import("./render.js");
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

test("renderSession opts the remote surface into the shared conversation layout", async () => {
  state.remoteAuth = {
    relayId: "relay-1",
    deviceId: "device-1",
    payloadSecret: "payload-secret-1",
  };
  state.threads = [];

  renderSession({
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
    transcript: [],
    logs: [],
    available_models: [],
  });

  assert.equal(browser.elements.get(".chat-shell").dataset.view, "conversation");
  assert.equal(browser.elements.get(".app-shell").dataset.view, "conversation");
});

test("renderSession preserves scroll position when the user is reading older transcript", async () => {
  state.remoteAuth = {
    relayId: "relay-1",
    deviceId: "device-1",
    payloadSecret: "payload-secret-1",
  };
  state.session = null;
  state.threads = [];
  const transcript = browser.elements.get("#remote-transcript");
  transcript.clientHeight = 400;
  transcript.scrollHeight = 2000;
  transcript.scrollTop = 0;

  const session = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
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
    transcript_truncated: false,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "older line",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
      {
        item_id: "item-2",
        kind: "user_text",
        text: "newer line",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
    logs: [],
    available_models: [],
  };

  renderSession(session);
  transcript.scrollTop = 240;
  transcript.scrollHeight = 2000;

  renderSession({
    ...session,
    current_status: "running",
  });

  assert.equal(transcript.scrollTop, 240);
});

test("renderSession keeps the viewport anchored when older transcript is prepended", async () => {
  state.remoteAuth = {
    relayId: "relay-1",
    deviceId: "device-1",
    payloadSecret: "payload-secret-1",
  };
  state.session = null;
  state.threads = [];
  const transcript = browser.elements.get("#remote-transcript");
  transcript.clientHeight = 400;
  transcript.scrollHeight = 1200;
  transcript.scrollTop = 0;

  const tailSession = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
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
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "middle",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
      {
        item_id: "item-3",
        kind: "user_text",
        text: "tail",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
    logs: [],
    available_models: [],
  };

  renderSession(tailSession);
  transcript.scrollTop = 180;
  transcript.scrollHeight = 1200;

  const prependedHeight = 500;
  Object.defineProperty(transcript, "innerHTML", {
    configurable: true,
    get() {
      return this._innerHTML || "";
    },
    set(value) {
      this._innerHTML = value;
      this.scrollHeight = 1200 + prependedHeight;
    },
  });

  renderSession({
    ...tailSession,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "older",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
      ...tailSession.transcript,
    ],
  });

  assert.equal(transcript.scrollTop, 180 + prependedHeight);
});

test("renderSession keeps the user pinned at the top when older transcript is prepended during hydration", async () => {
  state.remoteAuth = {
    relayId: "relay-1",
    deviceId: "device-1",
    payloadSecret: "payload-secret-1",
  };
  state.session = null;
  state.threads = [];
  const transcript = browser.elements.get("#remote-transcript");
  transcript.clientHeight = 400;
  transcript.scrollHeight = 1200;
  transcript.scrollTop = 0;

  const originalInnerHtmlDescriptor = Object.getOwnPropertyDescriptor(transcript, "innerHTML");
  Object.defineProperty(transcript, "innerHTML", {
    configurable: true,
    get() {
      return this._innerHTML || "";
    },
    set(value) {
      this._innerHTML = value;
      this.scrollHeight = 1700;
    },
  });

  const tailSession = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
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
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "middle",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
      {
        item_id: "item-3",
        kind: "user_text",
        text: "tail",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
    logs: [],
    available_models: [],
  };

  renderSession(tailSession);
  transcript.scrollTop = 0;
  transcript.scrollHeight = 1200;

  renderSession({
    ...tailSession,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "older",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
      ...tailSession.transcript,
    ],
  });

  assert.equal(transcript.scrollTop, 0);

  if (originalInnerHtmlDescriptor) {
    Object.defineProperty(transcript, "innerHTML", originalInnerHtmlDescriptor);
  } else {
    delete transcript.innerHTML;
  }
});
