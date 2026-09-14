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
  const pendingTimers = new Map();
  let nextTimerId = 1;
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
    setTimeout(callback, delay = 0) {
      const id = nextTimerId;
      nextTimerId += 1;
      pendingTimers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pendingTimers.delete(id);
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
    scheduledTimerDelays() {
      return Array.from(pendingTimers.values(), (timer) => timer.delay);
    },
    runTimers() {
      while (pendingTimers.size) {
        const [id, timer] = pendingTimers.entries().next().value;
        pendingTimers.delete(id);
        timer.callback();
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

test("broker socket reconnect backs off with jitter and resets after a stable connection", async () => {
  const browser = installBrowserStubs();
  FakeWebSocket.instances = [];
  const originalDateNow = Date.now;
  let nowMs = originalDateNow();
  Date.now = () => nowMs;

  try {
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
      deviceJoinTicket: "device-ws-token",
      deviceJoinTicketExpiresAt: Math.floor(nowMs / 1000) + 300,
      securityMode: "private",
      sessionClaim: null,
      sessionClaimExpiresAt: null,
    });
    seedPairingState(state);
    seedSocketState(state);

    await connectBroker("initial boot");
    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].emit("open");
    FakeWebSocket.instances[0].emit("close", { code: 1006, reason: "restart" });

    let delays = browser.scheduledTimerDelays();
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 750 && delays[0] <= 1500);

    browser.runTimers();
    assert.equal(FakeWebSocket.instances.length, 2);
    FakeWebSocket.instances[1].emit("close", { code: 1006, reason: "outage" });

    delays = browser.scheduledTimerDelays();
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 1500 && delays[0] <= 3000);

    browser.runTimers();
    assert.equal(FakeWebSocket.instances.length, 3);
    FakeWebSocket.instances[2].emit("open");
    nowMs += 60_001;
    FakeWebSocket.instances[2].emit("close", { code: 1006, reason: "stable restart" });

    delays = browser.scheduledTimerDelays();
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 750 && delays[0] <= 1500);
  } finally {
    Date.now = originalDateNow;
    FakeWebSocket.instances = [];
  }
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

  // A ticket whose `expires_at` has already passed is refused locally, so no
  // socket is opened at all: the broker answers every failed join with a generic
  // "broker join rejected", so spending a round trip to learn nothing — and then
  // reconnecting forever because the ticket is still the connection target — is
  // strictly worse than deciding it here.
  assert.equal(
    FakeWebSocket.instances.length,
    0,
    "an already-expired pairing ticket must not be presented to the broker"
  );
  assert.equal(state.pairingPhase, "error");
  assert.equal(
    state.pairingRetired,
    true,
    "the dead ticket must be retired so the reconnect loop stops"
  );
  assert.match(
    state.pairingError,
    /QR code or pairing link has expired.*Generate a new QR code/i
  );

  // ...and the reconnect path must now find nothing to present.
  await connectBroker("reconnect");
  assert.equal(
    FakeWebSocket.instances.length,
    0,
    "a retired pairing ticket must not be retried"
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

test("a superseded pairing ticket is terminal: no reconnect is scheduled and the fragment is scrubbed", async () => {
  // SECURITY: the broker seats one peer per pairing ticket, so a later join evicts
  // the earlier holder. If the loser merely logs the error, the socket close
  // schedules a reconnect that re-presents the same ticket — two clients sharing
  // one QR then evict each other until it expires and neither ever pairs. The
  // ticket must also leave the URL, or a reload resurrects it and the old client
  // evicts its successor all over again.
  const browser = installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  let replacedUrl = null;
  globalThis.window.history.replaceState = (_state, _title, url) => {
    replacedUrl = String(url);
    globalThis.window.location.href = replacedUrl;
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");

  // Keep a REAL paired device profile: this is the dangerous state. `connectionTarget`
  // falls back to it once the pairing ticket is retired, so the connection succeeds and
  // any "are we pairing?" check that only tests `state.pairingTicket` would fire the
  // pairing handshake against this device's room instead.
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-existing",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "existing-room",
    relayPeerId: "relay-peer",
    deviceId: "device-existing",
    deviceLabel: "Old Phone",
    payloadSecret: "payload-secret",
    deviceJoinTicket: "device-join-ticket",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 600,
  });
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "connecting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "dev-room",
      pairing_id: "pair-superseded",
      pairing_join_ticket: "shared-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({});
  const socketsBeforeConnect = FakeWebSocket.instances.length;
  await connectBroker("pairing");
  assert.equal(
    FakeWebSocket.instances.length,
    socketsBeforeConnect + 1,
    "a live ticket should open a socket"
  );
  const socket = FakeWebSocket.instances.at(-1);

  socket.emit("message", {
    data: JSON.stringify({
      type: "error",
      code: "pairing_ticket_superseded",
      message: "another client joined with this pairing ticket",
    }),
  });
  await waitFor(() => state.pairingPhase === "error");
  socket.emit("close", { code: 1000, reason: "" });

  assert.equal(state.pairingPhase, "error");
  assert.equal(state.pairingRetired, true, "the ticket must be retired");
  assert.ok(state.pairingTicket, "the ticket stays so its error card remains visible");
  assert.match(state.pairingError, /Another device took over/i);
  assert.deepEqual(
    browser.scheduledTimerDelays(),
    [],
    "the close must not schedule a reconnect for a superseded ticket"
  );
  assert.ok(replacedUrl, "the pairing fragment must be scrubbed from the URL");
  assert.ok(
    !replacedUrl.includes("pairing="),
    `a reload must not be able to resurrect the ticket; got ${replacedUrl}`
  );

  // The existing device profile must remain usable — a hijacked pairing attempt should
  // not cost the user the relay they were already paired with — but the reconnect must
  // go to the DEVICE's room with the DEVICE's ticket, never back to the dead pairing.
  const socketsBefore = FakeWebSocket.instances.length;
  await connectBroker("reconnect");
  assert.equal(
    FakeWebSocket.instances.length,
    socketsBefore + 1,
    "the paired device should still reconnect"
  );
  const fallback = FakeWebSocket.instances.at(-1);
  assert.match(
    fallback.url,
    /join_ticket=device-join-ticket/,
    `the fallback must use the device ticket; got ${fallback.url}`
  );
  assert.ok(
    !fallback.url.includes("shared-join-ticket"),
    `a superseded pairing ticket must never be re-presented; got ${fallback.url}`
  );
  assert.match(
    fallback.url,
    /\/ws\/existing-room/,
    `the fallback must target the device's room, not the pairing room; got ${fallback.url}`
  );
  assert.equal(state.pairingRetired, true, "retirement must survive the fallback connect");
});

test("booting an expired #pairing fragment scrubs it from the URL and never connects", async () => {
  // The payload sits in the fragment, so a reload re-reads it. If the expired-at-boot
  // path only sets an error flag, the spent secret stays in the address bar and history
  // and re-enters broker/proxy logs on every refresh — and boot returns before
  // `connectBroker`'s retire path could clean up.
  const browser = installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });

  const expiredPayload = Buffer.from(
    JSON.stringify({
      version: 1,
      pairing_id: "pair-expired-boot",
      pairing_secret: "secret-must-not-linger",
      broker_url: "ws://broker.example.test",
      broker_channel_id: "dev-room",
      pairing_join_ticket: "expired-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) - 5,
    }),
    "utf8"
  ).toString("base64url");

  globalThis.window.location.href = `https://remote.example.test/#pairing=${expiredPayload}`;
  let replacedUrl = null;
  globalThis.window.history.replaceState = (_state, _title, url) => {
    replacedUrl = String(url);
    globalThis.window.location.href = replacedUrl;
  };

  const { state } = await import("./state.js");
  const { beginPairing } = await import("./pairing.js");

  state.remoteAuth = null;
  seedSocketState(state);
  seedPairingState(state);

  const socketsBefore = FakeWebSocket.instances.length;
  const started = await beginPairing(expiredPayload, { auto: true });

  assert.equal(started, false, "an expired ticket must not start a pairing");
  assert.equal(
    FakeWebSocket.instances.length,
    socketsBefore,
    "no socket should be opened for an already-expired ticket"
  );
  assert.equal(state.pairingRetired, true, "the expired ticket must be retired");
  assert.match(state.pairingError, /expired.*Generate a new QR code/i);
  assert.ok(replacedUrl, "the fragment must be scrubbed at boot, not only on connect");
  assert.ok(
    !replacedUrl.includes("pairing="),
    `the spent secret must leave the URL; got ${replacedUrl}`
  );
  assert.deepEqual(
    browser.scheduledTimerDelays(),
    [],
    "nothing should be scheduled for a dead ticket"
  );
});

test("a relay-rejected pairing result is terminal: retired, scrubbed, socket released", async () => {
  // The relay consumes the pending pairing the moment it decides — approve OR reject —
  // so once a failure result arrives the ticket is already gone server-side. Retrying it
  // can only fail, and holding the socket keeps this client occupying a room seat.
  const browser = installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  let replacedUrl = null;
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = (_state, _title, url) => {
    replacedUrl = String(url);
    globalThis.window.location.href = replacedUrl;
  };

  const { state } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");

  const pairingSecret = "pairing-secret-from-qr";
  state.remoteAuth = null;
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "dev-room",
      pairing_id: "pair-rejected",
      pairing_secret: pairingSecret,
      pairing_join_ticket: "join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({});
  await connectBroker("pairing");
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("message", {
    data: JSON.stringify({
      type: "welcome",
      protocol_version: 1,
      channel_id: "dev-room",
      peer_id: "surface-self",
      peers: [],
    }),
  });
  await waitFor(() => state.socketPeerId === "surface-self");

  await handleEncryptedPairingResult({
    kind: "encrypted_pairing_result",
    pairing_id: "pair-rejected",
    target_peer_id: "surface-self",
    envelope: await encryptJson(pairingSecret, {
      ok: false,
      error: "pairing request was rejected on the local relay",
    }),
  });

  assert.equal(state.pairingPhase, "error");
  assert.equal(state.pairingRetired, true, "a rejected pairing must be retired");
  assert.match(state.pairingError, /rejected/i);
  assert.ok(replacedUrl && !replacedUrl.includes("pairing="), "the fragment must be scrubbed");
  assert.equal(state.socket, null, "the socket must be released, not left holding a seat");
  assert.deepEqual(
    browser.scheduledTimerDelays(),
    [],
    "a rejected pairing must not schedule a reconnect"
  );
});

test("a pairing ticket that expires after the socket opens retires that socket, not the old session", async () => {
  // The broker only validates expiry at JOIN, so an already-open socket is not closed
  // the instant its ticket lapses. That leaves a window between `open` and
  // Welcome/Error in which a global "is a pairing active?" predicate flips to false
  // while the socket in hand is still very much the pairing socket. Deciding per-frame
  // from that predicate makes Welcome recover the OLD profile over the PAIRING room.
  const browser = installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  let replacedUrl = null;
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = (_s, _t, url) => {
    replacedUrl = String(url);
    globalThis.window.location.href = replacedUrl;
  };

  const { state, saveRemoteAuth } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");

  let recoveries = 0;
  let pairingRequests = 0;
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-existing",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "existing-room",
    relayPeerId: "relay-peer",
    deviceId: "device-existing",
    deviceLabel: "Old Phone",
    payloadSecret: "payload-secret",
    deviceJoinTicket: "device-join-ticket",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 600,
  });
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "connecting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "pairing-room",
      pairing_id: "pair-lapses",
      pairing_join_ticket: "pairing-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({
    onBrokerReady(_frame, _reason, connection) {
      if (connection?.kind === "pairing") {
        pairingRequests += 1;
        return;
      }
      recoveries += 1;
    },
  });
  await connectBroker("pairing");
  const socket = FakeWebSocket.instances.at(-1);
  assert.match(socket.url, /join_ticket=pairing-join-ticket/);
  socket.emit("open", {});

  // Time passes: the ticket lapses while the socket is already established.
  state.pairingTicket.expires_at = Math.floor(Date.now() / 1000) - 1;

  socket.emit("message", {
    data: JSON.stringify({
      type: "welcome",
      protocol_version: 1,
      channel_id: "pairing-room",
      peer_id: "surface-self",
      peers: [{ peer_id: "relay-peer", role: "relay" }],
    }),
  });
  await waitFor(() => state.pairingRetired === true);

  assert.equal(
    recoveries,
    0,
    "the old device session must NOT be recovered over the pairing room's socket"
  );
  assert.equal(pairingRequests, 0, "a lapsed ticket must not send a pairing request either");
  assert.equal(state.pairingPhase, "error");
  assert.match(state.pairingError, /expired.*Generate a new QR code/i);
  assert.ok(replacedUrl && !replacedUrl.includes("pairing="), "the fragment must be scrubbed");
  assert.equal(state.socket, null, "the pairing socket must be released, not left holding a seat");
});

test("a superseded error is still honored on a socket whose ticket just lapsed", async () => {
  // Same window, error path: classifying broker errors from a time-varying predicate
  // means a `pairing_ticket_superseded` arriving a moment after expiry is ignored, so
  // the ticket is never retired and the fragment never scrubbed.
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  let replacedUrl = null;
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = (_s, _t, url) => {
    replacedUrl = String(url);
  };

  const { state } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");

  state.remoteAuth = null;
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "connecting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "pairing-room",
      pairing_id: "pair-lapse-superseded",
      pairing_join_ticket: "pairing-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({});
  await connectBroker("pairing");
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("open", {});
  state.pairingTicket.expires_at = Math.floor(Date.now() / 1000) - 1;

  socket.emit("message", {
    data: JSON.stringify({
      type: "error",
      code: "pairing_ticket_superseded",
      message: "another client joined with this pairing ticket",
    }),
  });
  await waitFor(() => state.pairingRetired === true);

  assert.equal(state.pairingPhase, "error");
  assert.ok(replacedUrl && !replacedUrl.includes("pairing="), "the fragment must be scrubbed");
});

test("scanning an expired QR must not close a healthy device connection", async () => {
  // `hashchange` re-scans happen in a tab that may already hold a working device
  // socket. Retiring a pairing attempt must only tear down that attempt's own socket:
  // closing whatever is current drops a live session, and because the close handler is
  // suppressed by the socket-replacement guard it never reconnects on its own.
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/";
  globalThis.window.history.replaceState = () => {};

  const { state, saveRemoteAuth } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");
  const { beginPairing } = await import("./pairing.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-live",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "live-room",
    relayPeerId: "relay-peer",
    deviceId: "device-live",
    deviceLabel: "Working Phone",
    payloadSecret: "payload-secret",
    deviceJoinTicket: "device-join-ticket",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 600,
  });
  seedSocketState(state);
  seedPairingState(state);

  configureBrokerClient({});
  await connectBroker("initial boot");
  const deviceSocket = FakeWebSocket.instances.at(-1);
  deviceSocket.emit("open", {});
  assert.match(deviceSocket.url, /join_ticket=device-join-ticket/);
  assert.equal(state.socket, deviceSocket, "the device socket should be current");

  const expiredPayload = Buffer.from(
    JSON.stringify({
      version: 1,
      pairing_id: "pair-stale-scan",
      pairing_secret: "secret",
      broker_url: "ws://broker.example.test",
      broker_channel_id: "pairing-room",
      pairing_join_ticket: "stale-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) - 5,
    }),
    "utf8"
  ).toString("base64url");

  const started = await beginPairing(expiredPayload, { auto: true });

  assert.equal(started, false, "an expired QR cannot start a pairing");
  assert.equal(state.pairingRetired, true, "the scanned ticket is retired");
  assert.equal(
    state.socket,
    deviceSocket,
    "the healthy device connection must survive an invalid QR scan"
  );
  assert.notEqual(deviceSocket.readyState, FakeWebSocket.CLOSED, "and must not be closed");
});

test("a pairing request in flight during retirement is never sent to the wrong room", async () => {
  // `sendPairingRequest` awaits device identity and an Ed25519 signature before it
  // publishes. Checking "is a pairing active?" only on entry means a superseded error
  // (or a second QR scan) arriving during those awaits still lets the old frame go out:
  // either onto a closed socket — an unhandled rejection, since the caller does
  // `void sendPairingRequest()` — or onto whatever socket is current by then, which may
  // be a fallback device connection in a completely different room.
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = () => {};

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  try {
    const { state } = await import("./state.js");
    const { configureBrokerClient, connectBroker } = await import("./broker-client.js");
    const { sendPairingRequest } = await import("./pairing.js");

    state.remoteAuth = null;
    seedSocketState(state);
    seedPairingState(state, {
      pairingPhase: "connecting",
      pairingTicket: {
        broker_url: "ws://broker.example.test",
        broker_channel_id: "pairing-room",
        pairing_id: "pair-inflight",
        pairing_secret: "secret",
        pairing_join_ticket: "pairing-join-ticket",
        expires_at: Math.floor(Date.now() / 1000) + 120,
      },
    });

    configureBrokerClient({});
    await connectBroker("pairing");
    const socket = FakeWebSocket.instances.at(-1);
    socket.emit("open", {});
    const sent = [];
    socket.send = (data) => sent.push(data);

    // Hold the signing step open so the superseded error lands mid-flight.
    let releaseIdentity;
    state.deviceKeypair = null;
    state.deviceIdentityPromise = new Promise((resolve) => {
      releaseIdentity = resolve;
    });

    const inFlight = sendPairingRequest();

    socket.emit("message", {
      data: JSON.stringify({
        type: "error",
        code: "pairing_ticket_superseded",
        message: "another client joined with this pairing ticket",
      }),
    });
    await waitFor(() => state.pairingRetired === true);

    releaseIdentity({ verifyKey: "dGVzdC12ZXJpZnkta2V5", sign: async () => "c2ln" });
    await inFlight;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      sent,
      [],
      "a pairing request whose attempt was retired mid-flight must never be published"
    );
    assert.deepEqual(unhandled, [], `no unhandled rejection; got ${unhandled}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    // The injected identity promise resolves to a stub whose `sign` returns a string;
    // leaving it in module state breaks any later test that signs for real.
    const { state } = await import("./state.js");
    state.deviceIdentityPromise = null;
    state.deviceKeypair = null;
  }
});

// `installBrowserStubs()` resets localStorage, but these fields are in-memory
// and outlive the test that wrote them.
function resetRemoteIdentityState(state) {
  state.remoteAuth = null;
  state.clientAuth = null;
  state.remoteProfiles = {};
  state.activeRelayId = null;
  state.relayDirectory = [];
  state.claimPromise = null;
  state.recoverPromise = null;
  for (const pending of state.pendingActions.values()) {
    window.clearTimeout(pending.timeoutId);
  }
  state.pendingActions.clear();
  state.pendingActionChunks?.clear?.();
}

function pairedResultBundle(overrides = {}) {
  return {
    ok: true,
    device: { device_id: "device-fresh", label: "New Phone" },
    payload_secret: "fresh-payload-secret",
    device_join_ticket: "fresh-device-join-ticket",
    device_join_ticket_expires_at: Math.floor(Date.now() / 1000) + 600,
    relay_id: "relay-fresh",
    relay_label: "Fresh Relay",
    ...overrides,
  };
}

test("after a successful pairing the same socket keeps working instead of being retired", async () => {
  // The success path deliberately REUSES the pairing socket for the post-pairing claim,
  // and it clears `pairingTicket` first. A socket judged by the descriptor it was opened
  // with therefore still looks like a pairing socket, and `pairingTicketIsLive(null)` is
  // false — so the very next frame (the claim response) was reported as an expired ticket
  // and the socket closed under a device that had just paired successfully.
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = () => {};

  const { state } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");

  const secret = "success-secret";
  state.remoteAuth = null;
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "pairing-room",
      relay_peer_id: "relay-peer",
      security_mode: "private",
      pairing_id: "pair-success",
      pairing_secret: secret,
      pairing_join_ticket: "pairing-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({});
  await connectBroker("pairing");
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("open", {});
  socket.emit("message", {
    data: JSON.stringify({
      type: "welcome",
      protocol_version: 1,
      channel_id: "pairing-room",
      peer_id: "surface-self",
      peers: [{ peer_id: "relay-peer", role: "relay" }],
    }),
  });
  await waitFor(() => state.socketPeerId === "surface-self");

  // Not awaited: the post-pairing claim waits on a relay response that never arrives
  // under stubs. What matters here is the socket lifecycle once credentials are adopted.
  void handleEncryptedPairingResult({
    pairing_id: "pair-success",
    target_peer_id: "surface-self",
    envelope: await encryptJson(secret, pairedResultBundle()),
  }).catch(() => {});
  await waitFor(() => state.remoteAuth?.deviceId === "device-fresh");

  assert.equal(state.remoteAuth?.deviceId, "device-fresh", "pairing should have succeeded");
  assert.equal(state.pairingTicket, null, "the ticket is consumed on success");

  // The claim response arrives on this same socket.
  socket.emit("message", {
    data: JSON.stringify({
      type: "message",
      from_peer_id: "relay-peer",
      from_role: "relay",
      payload: { kind: "remote_control_result", action_id: "a1", target_peer_id: "surface-self", ok: true },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(
    socket.readyState,
    FakeWebSocket.CLOSED,
    "a successfully paired socket must not be closed by the pairing-expiry guard"
  );
  assert.equal(state.socket, socket, "and must remain the current connection");
  assert.equal(
    state.pairingError,
    null,
    `a paired device must not be shown a pairing-expired error; got ${state.pairingError}`
  );
});

test("a pairing result settling after a second scan cannot touch the new attempt", async () => {
  // The result handler awaits a device-session network round trip and only afterwards
  // reads `state.pairingTicket` for the broker URL. If attempt B starts during that wait,
  // attempt A resumes and reads B's ticket, saves A's credentials against B's broker, and
  // clears B's pairing state.
  installBrowserStubs();
  globalThis.window.location.href = "https://remote.example.test/#pairing=payload-b";
  let replacedUrl = null;
  globalThis.window.history.replaceState = (_s, _t, url) => {
    replacedUrl = String(url);
  };

  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await fetchGate;
    return { ok: true, async json() { return {}; } };
  };

  const { state } = await import("./state.js");
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");
  const { nextPairingAttemptId } = await import("./state.js");

  const secretA = "secret-a";
  seedSocketState(state, { socketPeerId: "surface-a" });
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: {
      broker_url: "ws://broker-a.example.test",
      broker_channel_id: "room-a",
      relay_peer_id: "relay-a",
      security_mode: "private",
      pairing_id: "pair-a",
      pairing_secret: secretA,
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });
  state.remoteAuth = null;

  const inFlight = handleEncryptedPairingResult({
    pairing_id: "pair-a",
    target_peer_id: "surface-a",
    envelope: await encryptJson(secretA, pairedResultBundle({
      device_refresh_token: "dref-a",
    })),
  });
  await waitFor(() => fetchCalls > 0);

  // Attempt B begins while A is parked on the network.
  nextPairingAttemptId();
  const ticketB = {
    broker_url: "ws://broker-b.example.test",
    broker_channel_id: "room-b",
    relay_peer_id: "relay-b",
    security_mode: "private",
    pairing_id: "pair-b",
    pairing_secret: "secret-b",
    expires_at: Math.floor(Date.now() / 1000) + 120,
  };
  seedPairingState(state, { pairingPhase: "connecting", pairingTicket: ticketB });

  releaseFetch();
  await inFlight.catch(() => {});

  assert.equal(
    state.pairingTicket,
    ticketB,
    "the superseded attempt must not clear or replace the new attempt's ticket"
  );
  assert.equal(state.pairingPhase, "connecting", "and must not touch its phase");
  assert.notEqual(
    state.remoteAuth?.brokerUrl,
    "ws://broker-b.example.test",
    "credentials from attempt A must never be filed against attempt B's broker"
  );
  assert.equal(
    replacedUrl,
    null,
    `the superseded attempt must not scrub the new attempt's pairing URL; got ${replacedUrl}`
  );
});

test("scanning an expired QR while a pairing socket is open releases that socket", async () => {
  // Starting a new attempt abandons the old one, so the old attempt's socket must be let
  // go. Otherwise it keeps a seat in the broker room while every frame on it is ignored
  // for attempt mismatch, until the server's idle timeout.
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/";
  globalThis.window.history.replaceState = () => {};

  const { state } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");
  const { beginPairing } = await import("./pairing.js");

  state.remoteAuth = null;
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "connecting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "room-a",
      pairing_id: "pair-a-open",
      pairing_secret: "secret",
      pairing_join_ticket: "a-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({});
  await connectBroker("pairing");
  const socketA = FakeWebSocket.instances.at(-1);
  socketA.emit("open", {});
  assert.equal(state.socket, socketA);

  const expiredB = Buffer.from(
    JSON.stringify({
      version: 1,
      pairing_id: "pair-b-expired",
      pairing_secret: "secret-b",
      broker_url: "ws://broker.example.test",
      broker_channel_id: "room-b",
      pairing_join_ticket: "b-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) - 5,
    }),
    "utf8"
  ).toString("base64url");

  await beginPairing(expiredB, { auto: true });

  assert.equal(
    socketA.readyState,
    FakeWebSocket.CLOSED,
    "the abandoned attempt's socket must be released, not left squatting the room"
  );
  assert.equal(state.socket, null, "and must not remain the current connection");
});

test("retirement during a session request cannot leave a half-paired, disconnected state", async () => {
  // A superseded frame retires the attempt and CLOSES the socket while the result handler
  // is parked on an HTTP round trip. Whatever the resolution is, it must be coherent: no
  // credentials saved next to a live terminal error, no claim attempted on a dead socket,
  // and no unhandled rejection.
  installBrowserStubs();
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = () => {};

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  try {
    let releaseDeviceSession;
    const deviceGate = new Promise((resolve) => {
      releaseDeviceSession = resolve;
    });
    let deviceCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/public/device/")) {
        deviceCalls += 1;
        await deviceGate;
      }
      return { ok: true, async json() { return {}; } };
    };

    const { state } = await import("./state.js");
    const { configureBrokerClient, connectBroker } = await import("./broker-client.js");
    const { handleEncryptedPairingResult } = await import("./pairing.js");
    const { encryptJson } = await import("./crypto.js");

    const secret = "retire-mid-flight";
    resetRemoteIdentityState(state);
    state.deviceIdentityPromise = null;
    state.deviceKeypair = null;
    seedSocketState(state);
    seedPairingState(state, {
      pairingPhase: "requesting",
      pairingTicket: {
        broker_url: "ws://broker.example.test",
        broker_channel_id: "pairing-room",
        relay_peer_id: "relay-peer",
        security_mode: "private",
        pairing_id: "pair-retire-race",
        pairing_secret: secret,
        pairing_join_ticket: "pairing-join-ticket",
        expires_at: Math.floor(Date.now() / 1000) + 120,
      },
    });

    configureBrokerClient({});
    await connectBroker("pairing");
    const socket = FakeWebSocket.instances.at(-1);
    socket.emit("open", {});
    state.socketPeerId = "surface-self";

    const inFlight = handleEncryptedPairingResult({
      pairing_id: "pair-retire-race",
      target_peer_id: "surface-self",
      envelope: await encryptJson(secret, pairedResultBundle({ device_refresh_token: "dref" })),
    });
    await waitFor(() => deviceCalls > 0);

    socket.emit("message", {
      data: JSON.stringify({
        type: "error",
        code: "pairing_ticket_superseded",
        message: "another client joined with this pairing ticket",
      }),
    });
    await waitFor(() => state.pairingRetired === true);
    assert.equal(socket.readyState, FakeWebSocket.CLOSED, "retirement closed the socket");

    releaseDeviceSession();
    await inFlight;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], `no unhandled rejection; got ${unhandled}`);
    // Retirement wins: nothing durable is written, so there is no half-paired state and
    // no claim attempted on the socket retirement already closed.
    assert.equal(state.remoteAuth, null, "no device credentials may be persisted");
    assert.equal(state.clientAuth, null, "no client authorization may be persisted");
    assert.equal(state.pairingRetired, true, "the retirement stands");
    assert.match(state.pairingError, /took over/i, "and its reason stays on screen");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a retired pairing cannot resurrect a profile an earlier pairing left in memory", async () => {
  // Storage is per-test; `remoteProfiles` is not.
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = () => {};

  const { state, saveRemoteAuth } = await import("./state.js");

  saveRemoteAuth({
    relayId: "relay-fresh",
    relayLabel: "Fresh Relay",
    brokerUrl: "ws://broker.example.test",
    brokerChannelId: "pairing-room",
    relayPeerId: "relay-peer",
    securityMode: "private",
    deviceId: "device-fresh",
    deviceLabel: "New Phone",
    payloadSecret: "fresh-payload-secret",
    deviceRefreshMode: null,
    deviceRefreshToken: null,
    deviceJoinTicket: "fresh-device-join-ticket",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 600,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  assert.ok(state.remoteProfiles["relay-fresh"], "precondition: the profile is in memory");

  resetRemoteIdentityState(state);

  assert.equal(state.remoteAuth, null, "the clean slate must actually be clean");
  assert.deepEqual(
    state.remoteProfiles,
    {},
    "the leftover profile is what resurrects credentials in a later test"
  );
});

test("a stale attempt cannot overwrite persisted client authorization", async () => {
  // `saveClientAuth` used to run straight after the client-session round trip, before the
  // next ownership recheck, so attempt A could persist broker A's client id and control
  // URL after attempt B had begun.
  installBrowserStubs();
  globalThis.window.location.href = "https://remote.example.test/";
  globalThis.window.history.replaceState = () => {};

  let releaseClientSession;
  const clientGate = new Promise((resolve) => {
    releaseClientSession = resolve;
  });
  let clientCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/public/client/claim")) {
      return {
        ok: true,
        async json() {
          return { client_id: "client-a", client_refresh_token: "cref-a" };
        },
      };
    }
    if (String(url).includes("/api/public/client/session")) {
      clientCalls += 1;
      await clientGate;
    }
    return { ok: true, async json() { return {}; } };
  };

  const { state, nextPairingAttemptId } = await import("./state.js");
  const { handleEncryptedPairingResult } = await import("./pairing.js");
  const { encryptJson } = await import("./crypto.js");

  const secretA = "client-auth-secret-a";
  state.remoteAuth = null;
  state.clientAuth = null;
  state.deviceIdentityPromise = null;
  state.deviceKeypair = null;
  seedSocketState(state, { socketPeerId: "surface-a" });
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: {
      broker_url: "ws://broker-a.example.test",
      broker_channel_id: "room-a",
      relay_peer_id: "relay-a",
      security_mode: "private",
      pairing_id: "pair-client-a",
      pairing_secret: secretA,
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  const inFlight = handleEncryptedPairingResult({
    pairing_id: "pair-client-a",
    target_peer_id: "surface-a",
    envelope: await encryptJson(secretA, pairedResultBundle({
      client_claim_id: "claim-a",
      client_claim_nonce: "nonce-a",
    })),
  });
  await waitFor(() => clientCalls > 0);

  nextPairingAttemptId();
  seedPairingState(state, {
    pairingPhase: "connecting",
    pairingTicket: {
      broker_url: "ws://broker-b.example.test",
      broker_channel_id: "room-b",
      pairing_id: "pair-client-b",
      pairing_secret: "secret-b",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  releaseClientSession();
  await inFlight.catch(() => {});

  assert.equal(
    state.clientAuth,
    null,
    `a superseded attempt must not persist client authorization; got ${JSON.stringify(state.clientAuth)}`
  );
  assert.equal(state.remoteAuth, null, "nor device credentials");
});

// The companion to actions.js's ignore path. `[broker-inbound]` is logged BEFORE
// anything knows whether the frame is for this surface, so every frame broadcast to
// the room — including all of another surface's chunked action results — paid a
// `renderLog`, i.e. a `patchRemoteState`, i.e. a full RemoteApp re-render. The
// high-volume mute list only covered `transcript_delta` / `encrypted_transcript_delta`,
// so `encrypted_remote_action_result_chunk` (a dozen frames per workspace diff) went
// through at full price.
test("an inbound frame for another surface does not notify the remote store", async () => {
  installBrowserStubs();
  globalThis.fetch = async () => ({ ok: true, async json() { return {}; } });
  globalThis.window.location.href = "https://remote.example.test/#pairing=abc";
  globalThis.window.history.replaceState = () => {};

  const { state, subscribeRemoteState } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");

  state.remoteAuth = null;
  seedSocketState(state);
  seedPairingState(state, {
    pairingPhase: "requesting",
    pairingTicket: {
      broker_url: "ws://broker.example.test",
      broker_channel_id: "pairing-room",
      relay_peer_id: "relay-peer",
      security_mode: "private",
      pairing_id: "pair-inbound-noise",
      pairing_secret: "secret",
      pairing_join_ticket: "pairing-join-ticket",
      expires_at: Math.floor(Date.now() / 1000) + 120,
    },
  });

  configureBrokerClient({ async onBrokerPayload() {} });
  await connectBroker("pairing");
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("open", {});
  socket.emit("message", {
    data: JSON.stringify({
      type: "welcome",
      protocol_version: 1,
      channel_id: "pairing-room",
      peer_id: "surface-mine",
      peers: [{ peer_id: "relay-peer", role: "relay" }],
    }),
  });
  await waitFor(() => state.socketPeerId === "surface-mine");

  let notifications = 0;
  const unsubscribe = subscribeRemoteState(() => {
    notifications += 1;
  });

  try {
    // One chunked action result belonging to a different surface of this device.
    for (let index = 0; index < 12; index += 1) {
      socket.emit("message", {
        data: JSON.stringify({
          type: "message",
          from_peer_id: "relay-peer",
          from_role: "relay",
          payload: {
            kind: "encrypted_remote_action_result_chunk",
            // Relay payload version (2), not the broker frame version above (1). An
            // unsupported payload version is logged, and logging is what this test counts.
            protocol_version: 2,
            action_id: "action-for-another-surface",
            action: "fetch_workspace_diff",
            chunk_index: index,
            chunk_count: 12,
            target_peer_id: "surface-other",
            device_id: "device-1",
            envelope: "envelope-that-must-not-be-opened",
          },
        }),
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    unsubscribe();
  }

  assert.equal(
    notifications,
    0,
    "an inbound frame addressed elsewhere must not notify the store: every "
      + "notification is a full RemoteApp re-render for a frame we throw away"
  );
});

// Every peer in the room receives every ordinary payload, and a paired phone is a peer.
// Nothing here checked who sent one, so any paired device could put words in the relay's
// mouth — a forged snapshot, a forged action result, a forged "still working" that holds
// another phone's request open indefinitely.
test("a payload from another surface is not treated as if the relay had sent it", async () => {
  installBrowserStubs();
  const { state, saveRemoteAuth } = await import("./state.js");
  const { configureBrokerClient, connectBroker } = await import("./broker-client.js");

  const delivered = [];
  configureBrokerClient({
    onBrokerPayload(payload) {
      delivered.push(payload?.kind);
    },
  });

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-sender-check",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-peer",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  });
  void connectBroker("sender check");
  await waitFor(() => FakeWebSocket.instances.length > 0);
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("open", {});
  socket.emit("message", {
    data: JSON.stringify({
      type: "welcome",
      protocol_version: 1,
      channel_id: "room-a",
      peer_id: "surface-self",
      peers: [{ peer_id: "relay-peer", role: "relay" }],
    }),
  });
  await waitFor(() => state.socketPeerId === "surface-self");

  socket.emit("message", {
    data: JSON.stringify({
      type: "message",
      from_peer_id: "surface-attacker",
      from_role: "surface",
      payload: {
        kind: "session_snapshot",
        protocol_version: 2,
        snapshot: { current_status: "idle", transcript: [], logs: [] },
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    delivered,
    [],
    "a payload from a peer that is not the relay must not reach the surface at all"
  );

  socket.emit("message", {
    data: JSON.stringify({
      type: "message",
      from_peer_id: "relay-peer",
      from_role: "relay",
      payload: {
        kind: "session_snapshot",
        protocol_version: 2,
        snapshot: { current_status: "idle", transcript: [], logs: [] },
      },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(delivered, ["session_snapshot"], "and the relay's own still does");
});
