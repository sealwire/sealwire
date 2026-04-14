import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    className: "",
    placeholder: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    focus() {},
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
    elements,
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

test("applySessionSnapshot hydrates truncated transcript with chunked remote fetches", async () => {
  installBrowserStubs();

  const fullText = "A".repeat(9000);
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

  state.remoteAuth = {
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
  };
  saveRemoteAuth(state.remoteAuth);
  state.socketConnected = true;
  state.socketPeerId = "surface-peer-1";
  state.pendingActions.clear();
  state.transcriptHydrationPromise = null;
  state.transcriptHydrationSignature = null;
  state.transcriptHydrationResolvedSignature = null;
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      const cursor = frame.payload.request?.input?.cursor || 0;
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            chunks:
              cursor === 0
                ? [
                    {
                      entry_index: 0,
                      item_id: "item-1",
                      role: "assistant",
                      status: "completed",
                      turn_id: "turn-1",
                      chunk_index: 0,
                      chunk_count: 2,
                      text: fullText.slice(0, 4000),
                    },
                  ]
                : [
                    {
                      entry_index: 0,
                      item_id: "item-1",
                      role: "assistant",
                      status: "completed",
                      turn_id: "turn-1",
                      chunk_index: 1,
                      chunk_count: 2,
                      text: fullText.slice(4000),
                    },
                    {
                      entry_index: 1,
                      item_id: "item-2",
                      role: "user",
                      status: "completed",
                      turn_id: "turn-2",
                      chunk_index: 0,
                      chunk_count: 1,
                      text: "thanks",
                    },
                  ],
            next_cursor: cursor === 0 ? 1 : null,
          },
        });
      });
    },
  };

  applySessionSnapshot({
    active_thread_id: "thread-1",
    active_controller_device_id: null,
    active_controller_last_seen_at: null,
    active_flags: [],
    active_turn_id: "turn-1",
    allowed_roots: [],
    approval_policy: "untrusted",
    audit_enabled: false,
    available_models: [],
    broker_can_read_content: true,
    broker_channel_id: "room-a",
    broker_connected: true,
    broker_peer_id: "relay-1",
    codex_connected: true,
    controller_lease_expires_at: null,
    controller_lease_seconds: 15,
    current_cwd: "/tmp/project",
    current_status: "idle",
    device_records: [],
    e2ee_enabled: false,
    logs: [],
    model: "gpt-5.4",
    paired_devices: [],
    pending_approvals: [],
    pending_pairing_requests: [],
    provider: "codex",
    reasoning_effort: "medium",
    sandbox: "workspace-write",
    security_mode: "managed",
    service_ready: true,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-1",
        role: "assistant",
        text: `${"A".repeat(1200)}...`,
        status: "completed",
        turn_id: "turn-1",
      },
    ],
  });

  await waitFor(() => state.session?.transcript_truncated === false);

  assert.equal(state.session.transcript[0].text, fullText);
  assert.equal(state.session.transcript[1].text, "thanks");
  assert.equal(
    sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length,
    2
  );
  assert.equal(sentPayloads[0].request.input.thread_id, "thread-1");
  assert.equal(sentPayloads[0].session_claim, undefined);
});
