import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    className: "",
    scrollTop: 0,
    scrollHeight: 0,
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

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send() {}

  emit(type, event = {}) {
    if (type === "open") {
      this.readyState = FakeWebSocket.OPEN;
    }
    if (type === "close") {
      this.readyState = FakeWebSocket.CLOSED;
    }
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

function createRequest() {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

function createIndexedDbStub() {
  const databases = new Map();

  function createDatabase() {
    const stores = new Map();

    return {
      objectStoreNames: {
        contains(name) {
          return stores.has(name);
        },
      },
      createObjectStore(name, options = {}) {
        if (!stores.has(name)) {
          stores.set(name, {
            keyPath: options.keyPath || "id",
            records: new Map(),
          });
        }
        return {};
      },
      transaction(name) {
        const storeState = stores.get(name);
        const transaction = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore() {
            return {
              get(key) {
                const request = createRequest();
                queueMicrotask(() => {
                  request.result = storeState.records.get(key);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
              put(value) {
                const request = createRequest();
                queueMicrotask(() => {
                  storeState.records.set(value[storeState.keyPath], value);
                  request.result = value[storeState.keyPath];
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
              delete(key) {
                const request = createRequest();
                queueMicrotask(() => {
                  storeState.records.delete(key);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
            };
          },
        };
        return transaction;
      },
      close() {},
    };
  }

  return {
    open(name) {
      const request = createRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = createDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) {
          request.onupgradeneeded?.();
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for async browser state");
}

function installBrowserStubs() {
  const storage = new Map();
  const elements = new Map();
  const pendingTimers = [];
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
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
  };
  const windowObject = {
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
    crypto: webcrypto,
    indexedDB: createIndexedDbStub(),
    setTimeout(callback) {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    clearTimeout(id) {
      pendingTimers[id - 1] = null;
    },
  };

  globalThis.document = document;
  globalThis.window = windowObject;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: windowObject.indexedDB,
  });
  globalThis.WebSocket = FakeWebSocket;

  return {
    localStorage,
    runTimers() {
      while (pendingTimers.length) {
        const callback = pendingTimers.shift();
        if (callback) {
          callback();
        }
      }
    },
  };
}

test("expired device broker access refreshes automatically during reconnect", async () => {
  const browser = installBrowserStubs();
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({
      url: String(url),
      options,
    });
    return {
      ok: true,
      async json() {
        return {
          broker_room_id: "room-a",
          device_id: "device-1",
          device_ws_token: "fresh-device-ws-token",
          device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      },
    };
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.remoteAuth = {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "seed-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  state.pairingTicket = null;
  state.socket = null;
  state.socketConnected = false;
  state.socketPeerId = null;
  state.socketReconnectTimer = null;
  saveRemoteAuth(state.remoteAuth);

  await connectBroker("initial boot");
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.match(FakeWebSocket.instances[0].url, /join_ticket=seed-device-ws-token/);
  FakeWebSocket.instances[0].emit("open");
  assert.equal(state.socketConnected, true);

  state.remoteAuth.deviceJoinTicket = "expired-device-ws-token";
  state.remoteAuth.deviceJoinTicketExpiresAt = Math.floor(Date.now() / 1000) - 5;
  saveRemoteAuth(state.remoteAuth);

  FakeWebSocket.instances[0].emit("close", { code: 1006, reason: "restart" });
  browser.runTimers();
  await waitFor(() => fetchCalls.length === 2);
  await waitFor(() => FakeWebSocket.instances.length === 2);

  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/session$/);
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer device-refresh-1");
  assert.equal(fetchCalls[0].options.credentials, "same-origin");
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/ws-token$/);
  assert.equal(fetchCalls[1].options.credentials, "same-origin");
  assert.equal(fetchCalls[1].options.headers, undefined);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.match(FakeWebSocket.instances[1].url, /join_ticket=fresh-device-ws-token/);
  assert.equal(state.remoteAuth.deviceRefreshMode, "cookie");
  assert.equal(state.remoteAuth.deviceRefreshToken, null);
  assert.equal(state.remoteAuth.deviceJoinTicket, "fresh-device-ws-token");
  const storedAuth = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
  const storedProfile = storedAuth.remoteProfiles["relay-1"];
  assert.equal(storedProfile.deviceRefreshToken, undefined);
  assert.equal(storedProfile.deviceJoinTicket, undefined);
  assert.equal(storedProfile.sessionClaim, undefined);
  assert.equal(storedProfile.deviceRefreshMode, "cookie");
  FakeWebSocket.instances[1].emit("open");
  assert.equal(state.socketConnected, true);
});

test("old pairing links without pairing_join_ticket are rejected with a clear error", async () => {
  const { parsePairingPayload } = await import("./crypto.js");
  const payload = {
    broker_channel_id: "dev-room",
    broker_url: "ws://192.168.1.105:8788",
    expires_at: 1774731071,
    pairing_id: "pair-z55kwjolad",
    pairing_secret: "PdNAR62HZGWivFxf7Wo25rlGFxWH8PSD",
    relay_peer_id: "local-relay",
    security_mode: "private",
    version: 1,
  };
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");

  assert.throws(
    () => parsePairingPayload(raw),
    /pairing link is outdated and missing pairing_join_ticket/
  );
});

test("expired pairing join ticket surfaces a clear QR renewal message", async () => {
  installBrowserStubs();
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {};
    },
  });

  const { state } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");

  state.remoteAuth = null;
  state.socket = null;
  state.socketConnected = false;
  state.socketPeerId = null;
  state.pairingTicket = {
    broker_url: "ws://broker.example.test",
    broker_channel_id: "dev-room",
    pairing_id: "pair-expired-ticket",
    pairing_join_ticket: "expired-join-ticket",
    expires_at: Math.floor(Date.now() / 1000) - 10,
  };
  state.pairingPhase = "connecting";
  state.pairingError = null;

  configureBrokerClient({});
  await connectBroker("expired pairing");

  assert.equal(FakeWebSocket.instances.length > 0, true);
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("error", {});
  socket.emit("message", {
    data: JSON.stringify({
      type: "error",
      message: "join_ticket has expired",
    }),
  });

  assert.equal(state.pairingPhase, "error");
  assert.match(
    state.pairingError,
    /QR code or pairing link has expired.*Generate a new QR code/i
  );
});
