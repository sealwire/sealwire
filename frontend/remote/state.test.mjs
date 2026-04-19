import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";
const REMOTE_STATE_SCHEMA_VERSION = 1;
const DEPRECATED_REMOTE_STATE_STORAGE_KEY_V2 = "agent-relay.remote-state-v2";
const DEPRECATED_REMOTE_STATE_STORAGE_KEY_V3 = "agent-relay.remote-state-v3";

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
                  request.result = undefined;
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

function installBrowserStubs(options = {}) {
  const { protectedCrypto = true } = options;
  const storage = new Map();
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

  const cryptoValue = protectedCrypto ? webcrypto : { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };

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
    crypto: cryptoValue,
    indexedDB: createIndexedDbStub(),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoValue,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: window.indexedDB,
  });

  return { localStorage };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for async browser state");
}

test("remote auth storage keeps durable metadata while payload secrets move to protected storage", async () => {
  const browser = installBrowserStubs();

  const { loadStoredPayloadSecret } = await import("./secret-store.js");
  const { ensureDeviceIdentity, saveRemoteAuth, state } = await import("./state.js");

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
    deviceJoinTicket: "join-ticket-1",
    deviceJoinTicketExpiresAt: 123,
    sessionClaim: "session-claim-1",
    sessionClaimExpiresAt: 456,
  };
  saveRemoteAuth(state.remoteAuth);
  await waitFor(() => {
    const stored = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
    return stored?.remoteProfiles?.["relay-1"]?.hasStoredPayloadSecret === true;
  });
  await waitFor(async () => {
    return (await loadStoredPayloadSecret("relay-1")) === "payload-secret-1";
  });

  assert.equal(state.remoteAuth.deviceId, "device-1");
  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");

  const stored = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
  assert.equal(stored.schemaVersion, REMOTE_STATE_SCHEMA_VERSION);
  const profile = stored.remoteProfiles["relay-1"];
  assert.equal(profile.deviceId, "device-1");
  assert.equal("payloadSecret" in profile, false);
  assert.equal(profile.deviceRefreshMode, "cookie");
  assert.equal(profile.hasStoredPayloadSecret, true);
  assert.equal("deviceJoinTicket" in profile, false);
  assert.equal("sessionClaim" in profile, false);

  const reloaded = await import(`./state.js?reload-${Date.now()}`);
  assert.equal(reloaded.state.remoteAuth?.payloadSecret, null);
  await reloaded.hydrateStoredRemoteSecrets();
  assert.equal(reloaded.state.remoteAuth?.payloadSecret, "payload-secret-1");

  await ensureDeviceIdentity();
  assert.ok(state.deviceKeypair);
  assert.match(state.requestedDeviceId, /^mobile-/);
  assert.equal(browser.localStorage.getItem("agent-relay.remote-device-keypair"), null);
});

test("remote auth storage can persist and hydrate payload secrets without protected crypto", async () => {
  const browser = installBrowserStubs({ protectedCrypto: false });

  const { loadStoredPayloadSecret } = await import(`./secret-store.js?software-${Date.now()}`);
  const { hydrateStoredRemoteSecrets, saveRemoteAuth, state } = await import(
    `./state.js?software-${Date.now()}`
  );

  state.remoteAuth = {
    relayId: "relay-http",
    brokerUrl: "ws://192.168.1.10:8788",
    brokerChannelId: "room-http",
    relayPeerId: "relay-http",
    securityMode: "private",
    deviceId: "device-http",
    deviceLabel: "Phone",
    payloadSecret: "payload-secret-http",
    deviceRefreshMode: null,
    deviceRefreshToken: null,
    deviceJoinTicket: "join-ticket-http",
    deviceJoinTicketExpiresAt: 123,
    sessionClaim: null,
    sessionClaimExpiresAt: null,
  };
  saveRemoteAuth(state.remoteAuth);

  await waitFor(() => {
    const stored = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
    return stored?.remoteProfiles?.["relay-http"]?.hasStoredPayloadSecret === true;
  });
  await waitFor(async () => {
    return (await loadStoredPayloadSecret("relay-http")) === "payload-secret-http";
  });

  const reloaded = await import(`./state.js?software-reload-${Date.now()}`);
  assert.equal(reloaded.state.remoteAuth?.payloadSecret, null);
  await reloaded.hydrateStoredRemoteSecrets();
  assert.equal(reloaded.state.remoteAuth?.payloadSecret, "payload-secret-http");
});

test("deprecated storage keys are ignored on load", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    DEPRECATED_REMOTE_STATE_STORAGE_KEY_V2,
    JSON.stringify({
      activeRelayId: "relay-1",
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          payloadSecret: "payload-secret-1",
          deviceRefreshToken: "refresh-token-1",
          deviceJoinTicket: "self-hosted-join-ticket",
          deviceJoinTicketExpiresAt: 123456,
        },
      },
      clientAuth: {
        clientId: "client-1",
        clientRefreshToken: "client-refresh-1",
        brokerControlUrl: "https://broker.example.test",
      },
    })
  );
  browser.localStorage.setItem(
    DEPRECATED_REMOTE_STATE_STORAGE_KEY_V3,
    JSON.stringify({
      activeRelayId: "relay-legacy-v3",
    })
  );

  const { state } = await import(`./state.js?legacy-${Date.now()}`);

  assert.equal(state.remoteAuth, null);
  assert.notEqual(browser.localStorage.getItem(DEPRECATED_REMOTE_STATE_STORAGE_KEY_V2), null);
  assert.notEqual(browser.localStorage.getItem(DEPRECATED_REMOTE_STATE_STORAGE_KEY_V3), null);
  assert.equal(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY), null);
});

test("unsupported browser storage schema version is discarded on load", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    REMOTE_STATE_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 999,
      activeRelayId: "relay-1",
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          hasStoredPayloadSecret: true,
        },
      },
    })
  );

  const { state } = await import(`./state.js?old-schema-${Date.now()}`);

  assert.equal(state.remoteAuth, null);
  assert.equal(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY), null);
});

test("missing protected payload secret keeps relay metadata but disables auto-recovery", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    REMOTE_STATE_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
      activeRelayId: "relay-1",
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          hasStoredPayloadSecret: true,
        },
      },
    })
  );

  const { hydrateStoredRemoteSecrets, state } = await import(`./state.js?missing-secret-${Date.now()}`);

  assert.equal(state.remoteAuth?.relayId, "relay-1");
  assert.equal(state.remoteAuth?.payloadSecret, null);

  await hydrateStoredRemoteSecrets();

  assert.equal(state.remoteAuth?.relayId, "relay-1");
  assert.equal(state.remoteAuth?.payloadSecret, null);
  assert.equal(state.remoteAuth?.hasStoredPayloadSecret, false);

  const stored = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
  assert.equal(stored.remoteProfiles["relay-1"].relayId, "relay-1");
  assert.equal(stored.remoteProfiles["relay-1"].hasStoredPayloadSecret, false);
});

test("explicit relay home selection persists without auto-opening a stored relay", async () => {
  const browser = installBrowserStubs();
  browser.localStorage.setItem(
    REMOTE_STATE_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
      activeRelayId: null,
      remoteProfiles: {
        "relay-1": {
          relayId: "relay-1",
          brokerUrl: "ws://broker.example.test",
          brokerChannelId: "room-a",
          relayPeerId: "relay-1",
          securityMode: "private",
          deviceId: "device-1",
          deviceLabel: "Primary Phone",
          hasStoredPayloadSecret: true,
        },
      },
    })
  );

  const { clearActiveRelaySelection, selectRelayProfile, state } = await import("./state.js?home-selection");

  assert.equal(state.activeRelayId, null);
  assert.equal(state.remoteAuth, null);

  assert.equal(selectRelayProfile("relay-1"), true);
  assert.equal(state.activeRelayId, "relay-1");
  assert.equal(state.remoteAuth?.relayId, "relay-1");

  clearActiveRelaySelection();
  assert.equal(state.activeRelayId, null);
  assert.equal(state.remoteAuth, null);

  const stored = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
  assert.equal(stored.activeRelayId, null);
  assert.equal(stored.remoteProfiles["relay-1"].relayId, "relay-1");
});

test("relay directory ignores malformed server entries without relay ids", async () => {
  installBrowserStubs();

  const { setRelayDirectory, state } = await import(`./state.js?directory-${Date.now()}`);

  setRelayDirectory([
    {
      broker_room_id: "room-bad",
      device_id: "device-bad",
      relay_label: "Broken Relay",
    },
  ]);

  assert.deepEqual(state.relayDirectory, []);
});

test("remote store exposes patch and subscribe hooks for transient UI state", async () => {
  installBrowserStubs();

  const { patchRemoteState, readRemoteState, subscribeRemoteState } = await import(
    `./state.js?store-${Date.now()}`
  );

  const updates = [];
  const unsubscribe = subscribeRemoteState((currentState, patch) => {
    updates.push({
      patch,
      socketPeerId: currentState.socketPeerId,
    });
  });

  patchRemoteState({
    socketPeerId: "surface-peer-1",
  });
  unsubscribe();
  patchRemoteState({
    socketPeerId: null,
  });

  assert.deepEqual(updates, [
    {
      patch: {
        socketPeerId: "surface-peer-1",
      },
      socketPeerId: "surface-peer-1",
    },
  ]);
  assert.equal(readRemoteState().socketPeerId, null);
});
