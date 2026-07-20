import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  seedPairingState,
  seedRemoteAuth,
  seedSocketState,
} from "./test-support/state-fixtures.mjs";

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

  seedRemoteAuth(state, saveRemoteAuth, {
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
  });
  seedPairingState(state);
  seedSocketState(state);

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
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/room-a\/session$/);
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer device-refresh-1");
  assert.equal(fetchCalls[0].options.credentials, "same-origin");
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/room-a\/ws-token$/);
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

test("device broker refresh updates the original relay when selection changes mid-refresh", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  let resolveWsTokenResponse;
  const wsTokenResponse = new Promise((resolve) => {
    resolveWsTokenResponse = resolve;
  });
  globalThis.fetch = async (url, options) => {
    const call = {
      url: String(url),
      options,
    };
    fetchCalls.push(call);
    if (/\/api\/public\/device\/room-a\/session$/.test(call.url)) {
      return {
        ok: true,
        async json() {
          return {
            broker_room_id: "room-a",
            device_id: "device-1",
          };
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(call.url)) {
      return wsTokenResponse;
    }
    throw new Error(`unexpected fetch ${call.url}`);
  };

  const { state, saveRemoteAuth, selectRelayProfile } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-2",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-b",
    relayPeerId: "relay-2",
    deviceId: "device-2",
    deviceLabel: "Tablet",
    payloadSecret: "payload-secret-2",
    deviceJoinTicket: "relay-2-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    deviceRefreshMode: "cookie",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  assert.equal(selectRelayProfile("relay-1"), true);
  seedPairingState(state);
  seedSocketState(state);

  const connectPromise = connectBroker("reconnect");
  await waitFor(() => fetchCalls.some((call) => /\/room-a\/ws-token$/.test(call.url)));

  assert.equal(selectRelayProfile("relay-2"), true);
  await connectBroker("switch relay");
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.match(FakeWebSocket.instances[0].url, /\/ws\/room-b\?/);
  assert.equal(state.socket, FakeWebSocket.instances[0]);

  resolveWsTokenResponse({
    ok: true,
    async json() {
      return {
        broker_room_id: "room-a",
        device_id: "device-1",
        device_ws_token: "fresh-relay-1-device-ws-token",
        device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
      };
    },
  });
  await connectPromise;

  assert.equal(
    state.remoteProfiles["relay-1"].deviceJoinTicket,
    "fresh-relay-1-device-ws-token"
  );
  assert.equal(state.remoteProfiles["relay-1"].deviceRefreshMode, "cookie");
  assert.equal(state.remoteProfiles["relay-1"].deviceRefreshToken, null);
  assert.equal(state.remoteProfiles["relay-2"].deviceJoinTicket, "relay-2-device-ws-token");
  assert.equal(state.remoteAuth.relayId, "relay-2");
  assert.equal(state.remoteAuth.deviceJoinTicket, "relay-2-device-ws-token");
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(state.socket, FakeWebSocket.instances[0]);
  assert.match(state.socket.url, /\/ws\/room-b\?/);
});

test("late device broker refresh after forget does not resurrect the forgotten profile", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  let resolveWsTokenResponse;
  const wsTokenResponse = new Promise((resolve) => {
    resolveWsTokenResponse = resolve;
  });
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options };
    fetchCalls.push(call);
    if (options?.method === "DELETE") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/session$/.test(call.url)) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { broker_room_id: "room-a", device_id: "device-1" };
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(call.url)) {
      return wsTokenResponse;
    }
    throw new Error(`unexpected fetch ${call.url}`);
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");
  const { forgetCurrentDevice } = await import(`./pairing.js?forget-late-${Date.now()}`);

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  const connectPromise = connectBroker("reconnect");
  await waitFor(() => fetchCalls.some((call) => /\/room-a\/ws-token$/.test(call.url)));

  forgetCurrentDevice();
  assert.equal(state.remoteProfiles["relay-1"], undefined);
  assert.equal(state.remoteAuth, null);

  resolveWsTokenResponse({
    ok: true,
    status: 200,
    async json() {
      return {
        broker_room_id: "room-a",
        device_id: "device-1",
        device_ws_token: "fresh-stale-token",
        device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
      };
    },
  });
  await connectPromise;

  assert.equal(state.remoteProfiles["relay-1"], undefined);
  assert.equal(state.remoteAuth, null);
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.ok(
    fetchCalls.filter((call) => call.options?.method === "DELETE")
      .every((call) => /\/api\/public\/device\/room-a\/session$/.test(call.url)),
    "stale refresh cleanup must only clear relay-1's scoped cookie"
  );
});

test("late device broker refresh cannot patch a newly re-paired same relay id", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  let resolveWsTokenResponse;
  const wsTokenResponse = new Promise((resolve) => {
    resolveWsTokenResponse = resolve;
  });
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options };
    fetchCalls.push(call);
    if (options?.method === "DELETE") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/session$/.test(call.url)) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { broker_room_id: "room-a", device_id: "device-old" };
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(call.url)) {
      return wsTokenResponse;
    }
    throw new Error(`unexpected fetch ${call.url}`);
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-old",
    deviceLabel: "Old Phone",
    payloadSecret: "payload-secret-old",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-old",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  const connectPromise = connectBroker("reconnect");
  await waitFor(() => fetchCalls.some((call) => /\/room-a\/ws-token$/.test(call.url)));

  saveRemoteAuth({
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-new",
    deviceLabel: "New Phone",
    payloadSecret: "payload-secret-new",
    deviceJoinTicket: "new-pairing-join-ticket",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    deviceRefreshToken: "device-refresh-new",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });

  resolveWsTokenResponse({
    ok: true,
    status: 200,
    async json() {
      return {
        broker_room_id: "room-a",
        device_id: "device-old",
        device_ws_token: "fresh-old-token",
        device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
      };
    },
  });
  await connectPromise;

  assert.equal(state.remoteProfiles["relay-1"].deviceId, "device-new");
  assert.equal(state.remoteProfiles["relay-1"].payloadSecret, "payload-secret-new");
  assert.equal(state.remoteProfiles["relay-1"].deviceJoinTicket, "new-pairing-join-ticket");
  assert.equal(state.remoteProfiles["relay-1"].deviceRefreshToken, "device-refresh-new");
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.ok(
    fetchCalls.some(
      (call) =>
        call.options?.method === "DELETE" &&
        /\/api\/public\/device\/room-a\/session$/.test(call.url)
    ),
    "stale response must trigger scoped cookie cleanup"
  );
});

test("device broker refresh scopes static rooms with URL-sensitive characters", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
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
          broker_room_id: "team/prod",
          device_id: "device-1",
          device_ws_token: "fresh-device-ws-token",
          device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      },
    };
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-static",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "team/prod",
    relayPeerId: "relay-static",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  await connectBroker("static room refresh");
  await waitFor(() => FakeWebSocket.instances.length === 1);

  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/team%2Fprod\/session$/);
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/team%2Fprod\/ws-token$/);
  assert.match(FakeWebSocket.instances[0].url, /\/ws\/team%2Fprod\?/);
});

test("device broker refresh falls back to legacy endpoints when a scoped route is unavailable", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({
      url: String(url),
      options,
    });
    if (/\/api\/public\/device\/room-a\//.test(String(url))) {
      return {
        ok: false,
        status: 404,
        async json() {
          return { error: "not_found" };
        },
      };
    }
    return {
      ok: true,
      status: 200,
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

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  await connectBroker("old broker fallback");
  await waitFor(() => FakeWebSocket.instances.length === 1);

  assert.equal(fetchCalls.length, 3);
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/room-a\/session$/);
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/room-a\/ws-token$/);
  assert.match(fetchCalls[2].url, /\/api\/public\/device\/ws-token$/);
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer device-refresh-1");
  assert.equal(fetchCalls[1].options.headers.Authorization, "Bearer device-refresh-1");
  assert.equal(fetchCalls[2].options.headers.Authorization, "Bearer device-refresh-1");
  assert.equal(state.remoteAuth.deviceRefreshMode, null);
  assert.equal(state.remoteAuth.deviceRefreshToken, "device-refresh-1");
  assert.equal(state.remoteAuth.deviceJoinTicket, "fresh-device-ws-token");
  assert.match(FakeWebSocket.instances[0].url, /\/ws\/room-a\?/);
});

test("device broker refresh uses bearer fallback when scoped session succeeds but ws-token 404s", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (/\/api\/public\/device\/room-a\/session$/.test(String(url))) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { broker_room_id: "room-a", device_id: "device-1" };
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(String(url))) {
      return {
        ok: false,
        status: 404,
        async json() {
          return { error: "not_found" };
        },
      };
    }
    return {
      ok: true,
      status: 200,
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

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  await connectBroker("mixed broker fallback");
  await waitFor(() => FakeWebSocket.instances.length === 1);

  assert.equal(fetchCalls.length, 3);
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/room-a\/session$/);
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/room-a\/ws-token$/);
  assert.match(fetchCalls[2].url, /\/api\/public\/device\/ws-token$/);
  assert.equal(fetchCalls[1].options.headers, undefined);
  assert.equal(fetchCalls[2].options.headers.Authorization, "Bearer device-refresh-1");
  assert.equal(state.remoteAuth.deviceRefreshMode, null);
  assert.equal(state.remoteAuth.deviceRefreshToken, "device-refresh-1");
  assert.equal(state.remoteAuth.deviceJoinTicket, "fresh-device-ws-token");
});

function seedCookieOnlyRoomAProfile(state, saveRemoteAuth) {
  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: null,
    deviceJoinTicketExpiresAt: null,
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);
}

test("cookie-mode scoped 404 falls back to legacy ws-token against an old broker", async () => {
  // Old broker (rollback / staggered deploy) lacks the scoped routes → 404. A
  // not-yet-migrated cookie profile still holds the legacy origin-wide cookie, so
  // the legacy ws-token succeeds and the device reconnects.
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    const target = String(url);
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(target)) {
      return { ok: false, status: 404, async json() { return { error: "not_found" }; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          device_ws_token: "legacy-fallback-token",
          device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
          broker_room_id: "room-a",
          device_id: "device-1",
        };
      },
    };
  };

  const { state, saveRemoteAuth, canRefreshDeviceJoinTicket } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");
  seedCookieOnlyRoomAProfile(state, saveRemoteAuth);

  await connectBroker("rollback non-migrated");

  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /\/api\/public\/device\/room-a\/ws-token$/);
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/ws-token$/);
  assert.equal(state.remoteAuth.deviceSessionExpired, false);
  assert.equal(canRefreshDeviceJoinTicket(), true);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.match(FakeWebSocket.instances[0].url, /join_ticket=legacy-fallback-token/);
});

test("cookie-mode scoped 404 with a dead legacy cookie marks the session expired", async () => {
  // Same rollback, but a MIGRATED profile: the legacy cookie was already cleared,
  // so the legacy ws-token 401s. Instead of a silent retry loop, mark the session
  // expired so the re-pair prompt fires.
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    const target = String(url);
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(target)) {
      return { ok: false, status: 404, async json() { return { error: "not_found" }; } };
    }
    return {
      ok: false,
      status: 401,
      async json() {
        return { error: "unauthorized", message: "missing bearer token" };
      },
    };
  };

  const { state, saveRemoteAuth, canRefreshDeviceJoinTicket } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");
  seedCookieOnlyRoomAProfile(state, saveRemoteAuth);

  await connectBroker("rollback migrated");

  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1].url, /\/api\/public\/device\/ws-token$/);
  assert.equal(state.remoteAuth.deviceSessionExpired, true);
  assert.equal(canRefreshDeviceJoinTicket(), false);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test("device broker refresh rejects ws-token responses for a different room or device", async () => {
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (options?.method === "DELETE") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {};
        },
      };
    }
    if (/\/api\/public\/device\/room-a\/session$/.test(String(url))) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { broker_room_id: "room-a", device_id: "device-1" };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          broker_room_id: "room-b",
          device_id: "device-1",
          device_ws_token: "wrong-room-token",
          device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      },
    };
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceJoinTicket: "expired-device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) - 5,
    deviceRefreshToken: "device-refresh-1",
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  await connectBroker("mismatched refresh response");

  assert.equal(state.remoteAuth.deviceJoinTicket, "expired-device-ws-token");
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.ok(
    fetchCalls.some(
      (call) =>
        call.options?.method === "DELETE" &&
        /\/api\/public\/device\/room-a\/session$/.test(call.url)
    ),
    "mismatched response must clear the scoped session cookie it may have set"
  );
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
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "connecting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "dev-room",
      pairing_id: "pair-expired-ticket",
      pairing_join_ticket: "expired-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    },
  });

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

test("cookie-mode ws-token 401 marks the device session expired and halts the retry loop", async () => {
  installBrowserStubs();
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: false,
      status: 401,
      async json() {
        return { error: "unauthorized", message: "missing bearer token" };
      },
    };
  };

  const { state, saveRemoteAuth, canRefreshDeviceJoinTicket } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: null,
    deviceJoinTicketExpiresAt: null,
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  // A cookie-mode profile with no join ticket: the client believes it can refresh.
  assert.equal(canRefreshDeviceJoinTicket(), true);

  await connectBroker("initial boot");

  // The per-room device session cookie is gone → ws-token 401. Instead of looping
  // silently forever, the profile is marked expired so the "re-pair this device"
  // path takes over and canRefreshDeviceJoinTicket() reports false.
  assert.ok(
    fetchCalls.some((call) => /\/api\/public\/device\/room-a\/ws-token$/.test(call.url)),
    "expected a room-scoped ws-token refresh attempt"
  );
  assert.equal(state.remoteAuth.deviceSessionExpired, true);
  assert.equal(canRefreshDeviceJoinTicket(), false);
});

test("bearer-mode ws-token 401 marks the device session expired and halts the retry loop", async () => {
  installBrowserStubs();
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (/\/session$/.test(String(url))) {
      return {
        ok: false,
        status: 503,
        async json() {
          return { error: "unavailable" };
        },
      };
    }
    return {
      ok: false,
      status: 401,
      async json() {
        return { error: "unauthorized", message: "device refresh token is invalid" };
      },
    };
  };

  const { state, saveRemoteAuth, canRefreshDeviceJoinTicket } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: null,
    deviceRefreshToken: "revoked-device-refresh-token",
    deviceJoinTicket: null,
    deviceJoinTicketExpiresAt: null,
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  assert.equal(canRefreshDeviceJoinTicket(), true);

  await connectBroker("initial boot");

  assert.ok(
    fetchCalls.some(
      (call) =>
        /\/api\/public\/device\/room-a\/ws-token$/.test(call.url) &&
        call.options?.headers?.Authorization === "Bearer revoked-device-refresh-token"
    ),
    "expected a bearer ws-token refresh fallback"
  );
  assert.equal(state.remoteAuth.deviceRefreshToken, "revoked-device-refresh-token");
  assert.equal(state.remoteAuth.deviceSessionExpired, true);
  assert.equal(canRefreshDeviceJoinTicket(), false);
});

test("scoped session failure + scoped ws-token bearer success converts to cookie mode", async () => {
  // The /session establish fails, but the scoped /ws-token with the bearer
  // succeeds — the broker sets the per-room cookie on that success, so the client
  // must switch to cookie mode (else a reload loses the never-persisted bearer).
  installBrowserStubs();
  FakeWebSocket.instances = [];
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    const target = String(url);
    if (/\/api\/public\/device\/room-a\/session$/.test(target)) {
      return { ok: false, status: 500, async json() { return { error: "server_error" }; } };
    }
    if (/\/api\/public\/device\/room-a\/ws-token$/.test(target)) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            device_ws_token: "scoped-bearer-token",
            device_ws_token_expires_at: Math.floor(Date.now() / 1000) + 300,
            broker_room_id: "room-a",
            device_id: "device-1",
          };
        },
      };
    }
    return { ok: false, status: 500, async json() { return {}; } };
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { connectBroker } = await import("./broker-client.js");

  state.activeRelayId = null;
  state.remoteAuth = null;
  state.remoteProfiles = {};
  state.relayDirectory = [];
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: null,
    deviceRefreshToken: "device-refresh-1",
    deviceJoinTicket: null,
    deviceJoinTicketExpiresAt: null,
    securityMode: "private",
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  seedPairingState(state);
  seedSocketState(state);

  await connectBroker("bearer ws-token converts to cookie");

  // The ws-token used the bearer (session failed) but was scoped and succeeded.
  assert.ok(
    fetchCalls.some(
      (call) =>
        /\/api\/public\/device\/room-a\/ws-token$/.test(call.url) &&
        call.options?.headers?.Authorization === "Bearer device-refresh-1"
    ),
    "the ws-token should have been sent with the bearer after the session failed"
  );
  assert.equal(state.remoteAuth.deviceRefreshMode, "cookie");
  assert.equal(state.remoteAuth.deviceRefreshToken, null);
  assert.equal(state.remoteAuth.deviceSessionExpired, false);
  const stored = JSON.parse(browserLocalStorageGet());
  const profile = stored.remoteProfiles["relay-1"];
  assert.equal(profile.deviceRefreshToken, undefined);
  assert.equal(profile.deviceRefreshMode, "cookie");
});

function browserLocalStorageGet() {
  return globalThis.window.localStorage.getItem("agent-relay.remote-state");
}
