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

test("a fire-and-forget action cannot migrate to a replacement socket", async () => {
  installBrowserStubs();
  const oldSocketFrames = [];
  const replacementSocketFrames = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { dispatchRemoteActionWithoutReply } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-1",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-a",
    relayPeerId: "relay-1",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-1",
    sessionClaim: "claim-token-1",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.socket = {
    readyState: 1,
    send(frameText) {
      oldSocketFrames.push(frameText);
    },
  };

  const pending = dispatchRemoteActionWithoutReply("heartbeat", { input: {} });
  state.socket = {
    readyState: 1,
    send(frameText) {
      replacementSocketFrames.push(frameText);
    },
  };

  await assert.rejects(pending, /broker socket is not connected/);
  assert.equal(oldSocketFrames.length, 0);
  assert.equal(replacementSocketFrames.length, 0);
  state.socket = null;
});

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

test("encrypted remote action result chunks reassemble before resolving", async () => {
  installBrowserStubs();

  const { encryptJson } = await import("./crypto.js");
  const { state, saveRemoteAuth } = await import("./state.js");
  const { dispatchOrRecover, handleRemoteBrokerPayload } = await import("./actions.js");

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
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.pendingActions.clear();
  state.pendingActionChunks.clear();
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      setImmediate(async () => {
        const result = {
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {
            active_thread_id: "thread-1",
          },
          thread_transcript: {
            thread_id: "thread-1",
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: "chunked transcript payload",
                status: "completed",
                turn_id: "turn-1",
                tool: null,
              },
            ],
            next_cursor: null,
            prev_cursor: 10,
          },
        };
        // Text slices, not byte slices: chunks travel as JSON text now, so reassembly is
        // string concatenation. Deliberately delivered out of order — the relay paces
        // them, but nothing guarantees arrival order.
        const serialized = JSON.stringify(result);
        const midpoint = Math.ceil(serialized.length / 2);
        const chunks = [
          { chunk_index: 1, data: serialized.slice(midpoint) },
          { chunk_index: 0, data: serialized.slice(0, midpoint) },
        ];
        for (const chunk of chunks) {
          const envelope = await encryptJson("payload-secret-1", {
            action_id: frame.payload.action_id,
            action: "fetch_thread_transcript",
            chunk_index: chunk.chunk_index,
            chunk_count: chunks.length,
            data: chunk.data,
          });
          await handleRemoteBrokerPayload({
            kind: "encrypted_remote_action_result_chunk",
            action_id: frame.payload.action_id,
            target_peer_id: "surface-peer-1",
            device_id: "device-1",
            action: "fetch_thread_transcript",
            chunk_index: chunk.chunk_index,
            chunk_count: chunks.length,
            envelope,
          });
        }
      });
    },
  };

  const result = await dispatchOrRecover("fetch_thread_transcript", {
    input: {
      thread_id: "thread-1",
    },
  });
  await nextTick();

  assert.equal(result.thread_transcript.thread_id, "thread-1");
  assert.equal(result.thread_transcript.entries.length, 1);
  assert.equal(result.thread_transcript.entries[0].text, "chunked transcript payload");
  assert.equal(state.pendingActions.size, 0);
  assert.equal(state.pendingActionChunks.size, 0);
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
                cwd: "/tmp/demo",
                provider: "claude_code",
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
  assert.equal(result.threads.threads[0].provider, "claude_code");
  assert.equal(result.threads.threads[0].cwd, "/tmp/demo");
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
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "Hello",
    delta_kind: "agent_text",
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].item_id, "item-1");
  assert.equal(received[0].thread_id, "thread-1");
  assert.equal(received[0].delta, "Hello");
  assert.equal(received[0].delta_kind, "agent_text");
});

test("handleRemoteBrokerPayload routes typed transcript events", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  const received = [];
  configureRemoteActions({
    onApplyTranscriptEvent: (event) => received.push(event),
  });

  await handleRemoteBrokerPayload({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    item_id: "item-1",
    status: "completed",
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "transcript_entry_completed");
  assert.equal(received[0].item_id, "item-1");
});

test("handleRemoteBrokerPayload routes transcript_stream_lagged as a typed transcript event", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  const received = [];
  configureRemoteActions({
    onApplyTranscriptEvent: (event) => received.push(event),
  });

  await handleRemoteBrokerPayload({
    kind: "transcript_stream_lagged",
    thread_id: "thread-1",
    dropped: 3,
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "transcript_stream_lagged");
  assert.equal(received[0].dropped, 3);
});

test("handleRemoteBrokerPayload decrypts encrypted typed transcript events", async () => {
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
    onApplyTranscriptEvent: (event) => received.push(event),
  });

  const envelope = await encryptJson("payload-secret-1", {
    kind: "approval_resolved",
    request_id: "approval-1",
  });

  await handleRemoteBrokerPayload({
    kind: "encrypted_transcript_event",
    target_peer_id: "surface-peer-1",
    device_id: "device-1",
    envelope,
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].kind, "approval_resolved");
  assert.equal(received[0].request_id, "approval-1");
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
    thread_id: "thread-9",
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
  assert.equal(received[0].thread_id, "thread-9");
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

test("handleRemoteBrokerPayload keeps control results out of the transcript channel", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  let snapshotApplied = false;
  configureRemoteActions({
    onApplySessionSnapshot: () => { snapshotApplied = true; },
  });

  await handleRemoteBrokerPayload({
    kind: "remote_control_result",
    action_id: "action-control",
    action: "heartbeat",
    ok: true,
    snapshot: { active_thread_id: "thread-1" },
  });

  assert.equal(snapshotApplied, false);
});

test("handleRemoteBrokerPayload applies snapshots only from session results", async () => {
  installBrowserStubs();

  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");

  const applied = [];
  configureRemoteActions({
    onApplySessionSnapshot: (snapshot) => { applied.push(snapshot); },
  });

  await handleRemoteBrokerPayload({
    kind: "remote_session_result",
    action_id: "action-session",
    action: "start_session",
    ok: true,
    snapshot: { active_thread_id: "thread-1" },
  });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].active_thread_id, "thread-1");
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

// A surface receives every other surface's frames: the broker broadcasts remote
// action results and filters nothing, by design (`must_not_be_broadcast` in
// crates/relay-broker/src/state.rs lists only `encrypted_pairing_result`). That is
// fine as long as discarding one is FREE. It was not: the discard path logged, and
// `renderLog` is a `patchRemoteState`, which notifies the store that drives
// `useSyncExternalStore` — i.e. a full re-render of RemoteApp per frame thrown away.
//
// A real boot trace showed 21 such frames arriving before the first frame addressed
// to this surface, each one a chunk of another surface's `fetch_workspace_diff`.
test("a frame addressed to another surface does not notify the remote store", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth, subscribeRemoteState } = await import("./state.js");
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
  seedSocketState(state, { socketPeerId: "surface-mine" });

  let notifications = 0;
  const unsubscribe = subscribeRemoteState(() => {
    notifications += 1;
  });

  try {
    // One chunked action result belonging to a DIFFERENT surface of the same device.
    for (let index = 0; index < 12; index += 1) {
      await handleRemoteBrokerPayload({
        kind: "encrypted_remote_action_result_chunk",
        action_id: "action-for-another-surface",
        action: "fetch_workspace_diff",
        chunk_index: index,
        chunk_count: 12,
        target_peer_id: "surface-other",
        device_id: "device-1",
        // Never reached: the payload is filtered before any decrypt.
        envelope: "envelope-that-must-not-be-opened",
      });
    }
    await handleRemoteBrokerPayload({
      kind: "encrypted_remote_action_result",
      action_id: "action-for-another-surface",
      target_peer_id: "surface-other",
      device_id: "device-1",
      envelope: "envelope-that-must-not-be-opened",
    });
  } finally {
    unsubscribe();
  }

  assert.equal(
    notifications,
    0,
    "discarding another surface's frames must not notify the store: every "
      + "notification is a full RemoteApp re-render for a frame we throw away"
  );
});

// The suppression above is a gate, not a deletion. If the flag does not actually
// restore the trace, the diagnostics are gone for good and nobody debugging broker
// routing would find that out until they needed them.
test("verbose broker logging restores the discarded-frame trace", async () => {
  installBrowserStubs();
  globalThis.window.__agentRelayVerboseBrokerLogs = true;

  const { state, saveRemoteAuth, subscribeRemoteState } = await import("./state.js");
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
  seedSocketState(state, { socketPeerId: "surface-mine" });

  let notifications = 0;
  const unsubscribe = subscribeRemoteState(() => {
    notifications += 1;
  });

  try {
    await handleRemoteBrokerPayload({
      kind: "encrypted_remote_action_result_chunk",
      action_id: "action-for-another-surface",
      action: "fetch_workspace_diff",
      chunk_index: 0,
      chunk_count: 12,
      target_peer_id: "surface-other",
      device_id: "device-1",
      envelope: "envelope-that-must-not-be-opened",
    });
  } finally {
    unsubscribe();
    delete globalThis.window.__agentRelayVerboseBrokerLogs;
  }

  assert.equal(
    notifications,
    1,
    "with the flag on, the routing trace must come back — otherwise the gate is a delete"
  );
});

// A chunked reply is paced by the relay, so its wall time scales with the payload. The
// action deadline was armed once when the request went out and never moved, which makes
// a large-but-legitimate reply *deterministically* undeliverable: chunks are ~32KiB and
// paced 250ms apart, so 61 of them take the full 15s budget on their own. A ~2MB
// workspace diff reaches that, and the relay will happily produce a 4MB one.
//
// A chunk arriving is proof the relay is alive and working. The deadline should catch a
// STALLED transfer, not put a ceiling on a healthy one.
test("each chunk of a reply extends the action deadline", async () => {
  const browser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");

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
  seedSocketState(state, { socketPeerId: "surface-mine" });
  state.pendingActions.clear();
  state.pendingActionChunks.clear();

  // Stand in for a dispatched action awaiting its reply.
  let rejected = null;
  const timers = [];
  const realSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  state.pendingActions.set("action-big", {
    actionType: "fetch_workspace_diff",
    timeoutId: 0,
    reject: (error) => {
      rejected = error;
    },
    resolve: () => {},
  });

  const armedBefore = timers.length;
  await handleRemoteBrokerPayload({
    kind: "remote_action_result_chunk",
    action_id: "action-big",
    action: "fetch_workspace_diff",
    chunk_index: 0,
    chunk_count: 61,
    data: "payload",
  });
  globalThis.window.setTimeout = realSetTimeout;

  assert.equal(rejected, null, "a chunk must not settle the action");
  assert.ok(
    timers.length > armedBefore,
    "a chunk must re-arm the action deadline: without that, a reply the relay paces "
      + "over more than 15s can never be delivered no matter how healthy the link is"
  );
  void browser;
});

// The earlier fix only stopped OTHER surfaces' frames from re-rendering the app. A
// reply addressed to this surface still logged on the accepted path, and
// `encrypted_remote_action_result_chunk` was never in the high-volume mute list — so a
// 21-chunk workspace diff meant for this very tab still cost 21 full RemoteApp
// re-renders here, plus another 21 from the inbound log in broker-client.
test("this surface's own chunks do not each re-render the app", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth, subscribeRemoteState } = await import("./state.js");
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
  seedSocketState(state, { socketPeerId: "surface-mine" });
  state.pendingActions.clear();
  state.pendingActionChunks.clear();

  const { encryptJson } = await import("./crypto.js");
  const envelopes = [];
  for (let index = 0; index < 12; index += 1) {
    envelopes.push(
      await encryptJson("payload-secret-1", {
        action_id: "action-mine",
        action: "fetch_workspace_diff",
        chunk_index: index,
        chunk_count: 21,
        data: "payload",
      })
    );
  }

  let notifications = 0;
  const unsubscribe = subscribeRemoteState(() => {
    notifications += 1;
  });

  try {
    for (let index = 0; index < 12; index += 1) {
      await handleRemoteBrokerPayload({
        kind: "encrypted_remote_action_result_chunk",
        action_id: "action-mine",
        action: "fetch_workspace_diff",
        chunk_index: index,
        chunk_count: 21,
        target_peer_id: "surface-mine",
        device_id: "device-1",
        envelope: envelopes[index],
      });
    }
  } finally {
    unsubscribe();
  }

  assert.equal(
    notifications,
    0,
    "streaming a reply to this surface must not re-render the whole app once per chunk"
  );
});

// Extending the deadline on every chunk, rather than on every chunk that advances the
// transfer, hands a stalled action an unlimited lease: a peer that re-sends chunk 0
// forever keeps the action alive and its partial buffer retained, and it never fails.
// Only progress should count as proof of life.
test("a repeated chunk does not renew the action deadline", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");

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
  seedSocketState(state, { socketPeerId: "surface-mine" });
  state.pendingActions.clear();
  state.pendingActionChunks.clear();

  const timers = [];
  const realSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  state.pendingActions.set("action-stalled", {
    actionType: "fetch_workspace_diff",
    timeoutId: 0,
    reject: () => {},
    resolve: () => {},
  });

  const sendChunkZero = () =>
    handleRemoteBrokerPayload({
      kind: "remote_action_result_chunk",
      action_id: "action-stalled",
      action: "fetch_workspace_diff",
      chunk_index: 0,
      chunk_count: 61,
      data: "payload",
    });

  await sendChunkZero();
  const afterFirst = timers.length;
  await sendChunkZero();
  await sendChunkZero();
  globalThis.window.setTimeout = realSetTimeout;

  assert.equal(
    timers.length,
    afterFirst,
    "re-sending a chunk already held must not buy the action another full deadline"
  );
});

// Snapshots for this surface still logged on three separate paths — inbound, accepted,
// and decrypted — each one a `patchRemoteState`, i.e. a full RemoteApp re-render. A
// snapshot can arrive every 500ms, so an active session was paying several whole-app
// renders a second purely for tracing. Applying the snapshot legitimately notifies the
// store; the tracing around it should not.
test("this surface's own snapshots do not re-render the app just to be traced", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth, subscribeRemoteState } = await import("./state.js");
  const { configureRemoteActions, handleRemoteBrokerPayload } = await import("./actions.js");
  const { encryptJson } = await import("./crypto.js");

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
  seedSocketState(state, { socketPeerId: "surface-mine" });

  // The snapshot is swallowed, so anything the store hears is tracing, not rendering.
  configureRemoteActions({ onApplySessionSnapshot() {} });
  const envelope = await encryptJson("payload-secret-1", {
    active_thread_id: "thread-a",
    current_status: "idle",
    transcript: [],
  });

  let notifications = 0;
  const unsubscribe = subscribeRemoteState(() => {
    notifications += 1;
  });
  try {
    await handleRemoteBrokerPayload({
      kind: "encrypted_session_snapshot",
      target_peer_id: "surface-mine",
      device_id: "device-1",
      envelope,
    });
  } finally {
    unsubscribe();
  }

  assert.equal(
    notifications,
    0,
    "tracing a snapshot must not re-render the whole app; at one snapshot per 500ms "
      + "that is several full renders a second spent on diagnostics"
  );
});

// When a reply is lost, the client must be able to ask again WITHOUT the relay running
// the action a second time. The relay already supports exactly that: it caches a
// completed result under `(device_id, action_id)` and replays it instead of
// re-executing. But it can only do so if the client asks with the SAME action id — and
// the client minted a fresh one every time, so a retry of a write that had already
// succeeded would have sent the message, or applied the file change, twice.
test("resending an unanswered action reuses its original action id", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { dispatchOrRecover, resendPendingActions } = await import("./actions.js");

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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  state.pendingActionChunks.clear();

  const sentActionIds = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      // Never answered: this models the reply that got dropped.
      sentActionIds.push(frame.payload?.action_id);
    },
  };

  // Not awaited: the point is that it never settles.
  const pending = dispatchOrRecover("fetch_workspace_diff", {}).catch(() => {});
  await nextTick();
  assert.equal(sentActionIds.length, 1, "the action should have been sent once");

  await resendPendingActions();
  await nextTick();

  assert.equal(sentActionIds.length, 2, "an unanswered action should be resent");
  assert.equal(
    sentActionIds[1],
    sentActionIds[0],
    "the resend must carry the ORIGINAL action id, so the relay replays its cached "
      + "result instead of executing the action a second time"
  );
  void pending;
});

// While the relay is away we know exactly why a reply has not come, so letting the
// deadline fire is worse than useless: the action reports failure, the user redoes it,
// and the redo mints a NEW action id that misses the relay's replay cache — which is
// how a write gets executed twice. The pending action instead waits for the relay to
// come back, and is resent under its own id then.
test("a relay leaving suspends action deadlines rather than failing them", async () => {
  installBrowserStubs();

  const { state } = await import("./state.js");
  const { suspendPendingActionDeadlines } = await import("./actions.js");

  state.pendingActions.clear();
  const cleared = [];
  const realClearTimeout = globalThis.window.clearTimeout;
  globalThis.window.clearTimeout = (id) => {
    cleared.push(id);
  };

  let rejected = false;
  state.pendingActions.set("action-writing", {
    actionType: "send_message",
    request: { text: "hello" },
    timeoutId: 4242,
    reject: () => {
      rejected = true;
    },
    resolve: () => {},
  });

  suspendPendingActionDeadlines();
  globalThis.window.clearTimeout = realClearTimeout;

  assert.equal(rejected, false, "a relay leaving must not fail the action");
  assert.ok(
    cleared.includes(4242),
    "its deadline must be stood down while we know the relay is gone"
  );
  assert.ok(
    state.pendingActions.has("action-writing"),
    "and the action must be kept so it can be resent under the same id"
  );
});

// A registration the relay never received leaves the phone silent while the UI says it
// is subscribed. The browser socket being open is not evidence the relay heard anything:
// the broker accepts the frame whether or not a relay peer is in the room. Keeping the
// action pending is what makes it recoverable — it is resent on the relay's return, under
// its original id, so the relay's replay cache answers rather than registering twice.
test("a push registration stays pending until the relay answers it", async () => {
  installBrowserStubs();
  globalThis.window.isSecureContext = true;
  globalThis.window.PushManager = function PushManager() {};
  globalThis.window.Notification = { permission: "granted" };
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: {} },
    configurable: true,
    writable: true,
  });

  const { state, saveRemoteAuth } = await import("./state.js");
  const { ensurePushSubscription } = await import("./push-subscribe.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-push-pending",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-push" });
  state.pendingActions.clear();

  const sent = [];
  state.socket = {
    readyState: 1,
    // Never answers: this models a relay that was not in the room to hear it.
    send(frameText) {
      sent.push(JSON.parse(frameText));
    },
  };
  const registration = {
    pushManager: {
      async getSubscription() {
        return {
          toJSON: () => ({
            endpoint: "https://push.example.test/abc",
            keys: { p256dh: "p256dh-value", auth: "auth-value" },
          }),
        };
      },
    },
  };

  // Not awaited: with no answer it never settles, which is the point.
  const pending = ensurePushSubscription({
    vapidPublicKey: "BMgLU4l-tVY26rhHP0AG0HsQBpTrGrhL-eryvizKLryWHlRJJk1Z4rZS0Mjkm9DOLuZ9CUMC1dvxQ8llGGQ_Q9I",
    registration,
  }).catch(() => {});
  await nextTick();
  await nextTick();

  assert.equal(
    sent.filter((frame) => frame.payload?.request?.type === "register_push_subscription").length,
    1,
    "the registration is sent once"
  );
  assert.equal(
    state.pendingActions.size,
    1,
    "and is kept as pending, so the relay's return resends it instead of the phone "
      + "believing a frame nobody received had worked"
  );
  void pending;
  state.pendingActions.clear();
  state.socket = null;
});

// Same for the other half: dropping a subscription the relay never heard about leaves the
// phone receiving notifications it has already turned off.
test("a push unregistration stays pending until the relay answers it", async () => {
  installBrowserStubs();
  globalThis.window.isSecureContext = true;
  globalThis.window.PushManager = function PushManager() {};
  globalThis.window.Notification = { permission: "granted" };
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: {} },
    configurable: true,
    writable: true,
  });

  const { state, saveRemoteAuth } = await import("./state.js");
  const { disablePushSubscription } = await import("./push-subscribe.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-push-unregister",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-push-off" });
  state.pendingActions.clear();

  const sent = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      sent.push(JSON.parse(frameText));
    },
  };
  const registration = {
    pushManager: {
      async getSubscription() {
        return {
          endpoint: "https://push.example.test/abc",
          async unsubscribe() {
            return true;
          },
        };
      },
    },
  };

  const pending = disablePushSubscription({ registration }).catch(() => {});
  await nextTick();
  await nextTick();

  assert.equal(
    sent.filter((frame) => frame.payload?.request?.type === "unregister_push_subscription").length,
    1,
    "the unregistration is sent once"
  );
  assert.equal(
    state.pendingActions.size,
    1,
    "and is kept as pending, so a relay that never heard it is asked again rather than "
      + "the phone going on receiving notifications it turned off"
  );
  void pending;
  state.pendingActions.clear();
  state.socket = null;
});

// The relay's deadline for an action someone else is already running is far longer than
// this browser's, so without a word from the relay the phone reports a failure for a
// write that is about to land — and the retry the user then makes carries a NEW id that
// no replay cache recognises, which is how one message gets sent twice.
test("a relay saying it is still working restarts the phone's deadline", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-still-working",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-waiting" });
  state.pendingActions.clear();

  const cleared = [];
  const armedFor = [];
  let nextTimerId = 900;
  globalThis.window.setTimeout = (_handler, delay) => {
    armedFor.push(delay);
    nextTimerId += 1;
    return nextTimerId;
  };
  globalThis.window.clearTimeout = (id) => {
    cleared.push(id);
  };

  let rejected = false;
  state.pendingActions.set("action-waiting", {
    actionType: "send_message",
    request: { text: "hello" },
    timeoutId: 4242,
    reject: () => {
      rejected = true;
    },
    resolve: () => {},
  });

  await handleRemoteBrokerPayload({ kind: "remote_action_pending", action_id: "action-waiting" });

  assert.equal(rejected, false, "a relay still working on it must not fail the action");
  assert.ok(
    cleared.includes(4242),
    "the old deadline is stood down, so the phone is not counting against a reply the "
      + "relay has told it is still coming"
  );
  assert.notEqual(
    state.pendingActions.get("action-waiting")?.timeoutId,
    4242,
    "and a fresh one is armed in its place"
  );
  // For the FULL window, not a token amount: the relay repeats its notice on a shorter
  // cycle than this, so anything less would let the phone give up between two of them.
  assert.deepEqual(
    armedFor,
    [15_000],
    "the replacement deadline has to be a whole window, or the notice buys nothing"
  );
  state.pendingActions.clear();
});
