import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
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
  globalThis.WebSocket = { OPEN: 1 };
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

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await nextTick();
  }
  throw new Error("timed out waiting for async browser state");
}

test("ensureRemoteClaim performs challenge-response without rotating payload secrets", async () => {
  const browser = installBrowserStubs();
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { ensureRemoteClaim, handleRemoteBrokerPayload } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
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
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.pendingActions.clear();
  state.claimPromise = null;
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        if (frame.payload.request?.type === "claim_challenge") {
          await handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "claim_challenge",
            ok: true,
            snapshot: {},
            claim_challenge_id: "challenge-1",
            claim_challenge: "server-challenge",
            claim_challenge_expires_at: Math.floor(Date.now() / 1000) + 60,
          });
          return;
        }

        if (frame.payload.request?.type === "claim_device") {
          await handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "claim_device",
            ok: true,
            snapshot: {},
            session_claim: "session-claim-2",
            session_claim_expires_at: Math.floor(Date.now() / 1000) + 300,
          });
        }
      });
    },
  };

  const sessionClaim = await ensureRemoteClaim({
    force: true,
    reason: "unit test",
    syncAfterClaim: false,
  });
  await nextTick();

  assert.equal(sessionClaim, "session-claim-2");
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[0].request.type, "claim_challenge");
  assert.equal(sentPayloads[0].device_id, "device-1");
  assert.ok(typeof sentPayloads[0].request.proof === "string");
  assert.ok(sentPayloads[0].request.proof.length > 20);
  assert.equal(sentPayloads[1].request.type, "claim_device");
  assert.equal(sentPayloads[1].request.challenge_id, "challenge-1");
  assert.ok(typeof sentPayloads[1].request.proof === "string");
  assert.ok(sentPayloads[1].request.proof.length > 20);
  assert.equal(sentPayloads[1].device_id, "device-1");
  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");
  assert.equal(state.remoteAuth.sessionClaim, "session-claim-2");

  const storedAuth = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
  const storedProfile = storedAuth.remoteProfiles["relay-1"];
  assert.equal("payloadSecret" in storedProfile, false);
  assert.equal(storedProfile.hasStoredPayloadSecret, true);
  assert.equal(storedProfile.deviceRefreshToken, undefined);
  assert.equal(storedProfile.deviceJoinTicket, undefined);
});

test("encrypted remote action results decrypt with the persisted payload secret", async () => {
  const browser = installBrowserStubs();

  const { encryptJson } = await import("./crypto.js");
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
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
  });
  seedSocketState(state, {
    socketPeerId: "surface-peer-1",
  });

  const envelope = await encryptJson("payload-secret-1", {
    action: "claim_device",
    ok: true,
    snapshot: {},
    session_claim: "session-claim-3",
    session_claim_expires_at: Math.floor(Date.now() / 1000) + 300,
  });

  await handleRemoteBrokerPayload({
    kind: "encrypted_remote_action_result",
    action_id: "action-1",
    target_peer_id: "surface-peer-1",
    device_id: "device-1",
    envelope,
  });
  await nextTick();

  assert.equal(state.remoteAuth.payloadSecret, "payload-secret-1");
  assert.equal(state.remoteAuth.sessionClaim, "session-claim-3");

  await waitFor(() => {
    const storedAuth = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
    return storedAuth?.remoteProfiles?.["relay-1"]?.hasStoredPayloadSecret === true;
  });

  const storedAuth = JSON.parse(browser.localStorage.getItem(REMOTE_STATE_STORAGE_KEY));
  assert.equal("payloadSecret" in storedAuth.remoteProfiles["relay-1"], false);
  assert.equal(storedAuth.remoteProfiles["relay-1"].hasStoredPayloadSecret, true);
});

test("list_threads uses device access without pre-claiming control", async () => {
  installBrowserStubs();
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { dispatchOrRecover, handleRemoteBrokerPayload } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
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
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "list_threads",
          ok: true,
          snapshot: {},
          threads: {
            threads: [
              {
                id: "thread-1",
                updated_at: Math.floor(Date.now() / 1000),
                preview: "hello",
              },
            ],
          },
        });
      });
    },
  };

  const result = await dispatchOrRecover("list_threads", {
    query: {
      limit: 20,
      cwd: "/tmp/demo",
    },
  });

  assert.equal(result.threads.threads.length, 1);
  const listThreadsPayload = sentPayloads.find(
    (payload) => payload.request?.type === "list_threads"
  );
  assert.ok(listThreadsPayload);
  assert.equal(listThreadsPayload.session_claim, undefined);
  assert.equal(listThreadsPayload.device_id, "device-1");
});

test("remote actions time out when the relay never replies", async () => {
  const browser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { dispatchOrRecover } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
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
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.pendingActions.clear();
  state.socket = {
    readyState: 1,
    send() {},
  };

  const pending = dispatchOrRecover("start_session", {
    input: {
      cwd: "/tmp/demo",
    },
  });

  browser.runTimers();

  await assert.rejects(
    pending,
    /remote start_session timed out waiting for relay response/
  );
  assert.equal(state.pendingActions.size, 0);
});

test("recoverRemoteSession only auto-claims when this device still controls the thread", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const {
    configureRemoteActions,
    recoverRemoteSession,
  } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: "old-claim",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.session = {
    active_thread_id: "thread-1",
    active_controller_device_id: "device-2",
  };

  let syncReason = null;
  configureRemoteActions({
    onSyncRemoteSnapshot: async (reason) => {
      syncReason = reason;
      state.session = {
        active_thread_id: "thread-1",
        active_controller_device_id: "device-2",
      };
    },
  });

  await recoverRemoteSession("unit test");

  assert.equal(syncReason, "recovery sync (unit test)");
  assert.equal(state.remoteAuth.sessionClaim, null);
  assert.equal(state.recoverPromise, null);
});

test("handleRemoteBrokerPayload routes transcript_delta to onApplyTranscriptDelta", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  const received = [];
  configureRemoteActions({
    onApplyTranscriptDelta: (delta) => received.push(delta),
  });

  await handleRemoteBrokerPayload({
    kind: "transcript_delta",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "Hello",
    delta_kind: "agent_text",
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].item_id, "item-1");
  assert.equal(received[0].delta, "Hello");
  assert.equal(received[0].delta_kind, "agent_text");
});

test("handleRemoteBrokerPayload decrypts encrypted transcript deltas with delta_kind", async () => {
  installBrowserStubs();

  const { encryptJson } = await import("./crypto.js");
  const { state, saveRemoteAuth } = await import("./state.js");
  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
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
  });
  seedSocketState(state, {
    socketPeerId: "surface-peer-1",
  });

  const received = [];
  configureRemoteActions({
    onApplyTranscriptDelta: (delta) => received.push(delta),
  });

  const envelope = await encryptJson("payload-secret-1", {
    item_id: "item-9",
    turn_id: "turn-9",
    delta: "Hello",
    delta_kind: "agent_text",
  });

  await handleRemoteBrokerPayload({
    kind: "encrypted_transcript_delta",
    target_peer_id: "surface-peer-1",
    device_id: "device-1",
    envelope,
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].item_id, "item-9");
  assert.equal(received[0].delta_kind, "agent_text");
});

test("handleRemoteBrokerPayload does not apply snapshot for heartbeat action result", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  let snapshotApplied = false;
  configureRemoteActions({
    onApplySessionSnapshot: () => { snapshotApplied = true; },
  });

  await handleRemoteBrokerPayload({
    kind: "remote_action_result",
    action_id: "action-1",
    action: "heartbeat",
    ok: true,
    snapshot: { active_thread_id: "thread-1" },
  });

  assert.equal(snapshotApplied, false);
});

test("handleRemoteBrokerPayload does not apply snapshot for claim_challenge action result", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  let snapshotApplied = false;
  configureRemoteActions({
    onApplySessionSnapshot: () => { snapshotApplied = true; },
  });

  await handleRemoteBrokerPayload({
    kind: "remote_action_result",
    action_id: "action-2",
    action: "claim_challenge",
    ok: true,
    snapshot: { active_thread_id: "thread-1" },
    claim_challenge_id: "challenge-1",
    claim_challenge: "server-challenge",
    claim_challenge_expires_at: Math.floor(Date.now() / 1000) + 60,
  });

  assert.equal(snapshotApplied, false);
});
