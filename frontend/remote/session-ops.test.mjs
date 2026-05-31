import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  seedRemoteAuth,
  seedSocketState,
  seedTranscriptHydrationState,
} from "./test-support/state-fixtures.mjs";

let activeBrowser = null;

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

  activeBrowser = {
    elements,
    runNextTimer() {
      while (pendingTimers.length) {
        const callback = pendingTimers.shift();
        if (callback) {
          callback();
          break;
        }
      }
    },
    runTimers() {
      while (pendingTimers.length) {
        const callback = pendingTimers.shift();
        if (callback) {
          callback();
        }
      }
    },
  };

  return activeBrowser;
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

test("applySessionSnapshot hydrates truncated transcript with full tail entries", async () => {
  const browser = activeBrowser || installBrowserStubs();

  const fullText = "A".repeat(9000);
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: fullText,
                status: "completed",
                turn_id: "turn-1",
                tool: null,
              },
              {
                item_id: "item-2",
                kind: "user_text",
                text: "thanks",
                status: "completed",
                turn_id: "turn-2",
                tool: null,
              },
            ],
            prev_cursor: null,
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
        kind: "agent_text",
        text: `${"A".repeat(1200)}...`,
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
      {
        item_id: "item-2",
        kind: "user_text",
        text: "thanks",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  });

  await waitFor(() => state.transcriptHydrationTailReady === true);
  await waitFor(() => state.transcriptHydrationPromise === null);

  assert.equal(state.session.transcript[0].text, fullText);
  assert.equal(state.session.transcript[1].text, "thanks");
  assert.equal(state.session.transcript_truncated, false);
  assert.equal(
    sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length,
    1
  );
  assert.equal(sentPayloads[0].request.input.thread_id, "thread-1");
  assert.equal(sentPayloads[0].request.input.before, null);
  assert.equal(sentPayloads[0].session_claim, undefined);

  const resumedSnapshot = {
    ...state.transcriptHydrationBaseSnapshot,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: `${"A".repeat(1200)}...`,
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
      {
        item_id: "item-2",
        kind: "user_text",
        text: "thanks",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };
  applySessionSnapshot(resumedSnapshot);

  assert.equal(state.session.transcript_truncated, false);
  assert.equal(state.session.transcript[0].text, fullText);
  assert.equal(
    sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length,
    1
  );
});

test("resumeRemoteSession sends only thread id so relay restores per-thread settings", async () => {
  activeBrowser = installBrowserStubs();
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { resumeRemoteSession } = await import("./session-ops.js");

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
    sessionClaim: "session-claim-1",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.pendingActions.clear();
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_session_result",
          action_id: frame.payload.action_id,
          action: "resume_session",
          ok: true,
          snapshot: {
            active_thread_id: "thread-a",
            active_controller_device_id: "device-1",
            active_controller_last_seen_at: 1,
            active_flags: [],
            active_turn_id: null,
            allowed_roots: [],
            approval_policy: "bypass",
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
            model: "fake-echo",
            paired_devices: [],
            pending_approvals: [],
            pending_pairing_requests: [],
            provider: "fake",
            reasoning_effort: "high",
            sandbox: "workspace-write",
            security_mode: "managed",
            service_ready: true,
            transcript_truncated: false,
            transcript: [],
          },
        });
      });
    },
  };

  const ok = await resumeRemoteSession("thread-a", {
    approvalPolicy: "untrusted",
    effort: "low",
    sandbox: "read-only",
  });

  assert.equal(ok, true);
  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(sentPayloads[0].request, {
    type: "resume_session",
    input: {
      thread_id: "thread-a",
    },
  });
});

test("transcript hydration retries after an incomplete entry fetch", async () => {
  const browser = activeBrowser || installBrowserStubs();
  const sentPayloads = [];
  let allowSecondFetch = false;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            entries: allowSecondFetch
              ? [
                  {
                    item_id: "item-1",
                    kind: "agent_text",
                    text: `${"hello ".repeat(600)}world`,
                    status: "completed",
                    turn_id: "turn-1",
                    tool: null,
                  },
                ]
              : [],
            prev_cursor: null,
          },
        });
      });
    },
  };

  const snapshot = {
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
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applySessionSnapshot(snapshot);
  await waitFor(() => state.transcriptHydrationPromise === null);
  browser.runTimers();
  assert.equal(state.transcriptHydrationStatus, "idle");
  assert.equal(state.transcriptHydrationTailReady, false);

  allowSecondFetch = true;
  applySessionSnapshot(snapshot);
  await waitFor(() => state.session?.transcript_truncated === false);

  const fetchRequests = sentPayloads
    .filter((payload) => payload.request?.type === "fetch_thread_transcript")
    .map((payload) => payload.request.input.before);
  assert.deepEqual(fetchRequests, [null, null]);
  assert.equal(state.session.transcript[0].text, `${"hello ".repeat(600)}world`);
});

test("hydrated transcript stays expanded when a later snapshot changes only the tail preview text", async () => {
  const browser = activeBrowser || installBrowserStubs();
  const sentPayloads = [];
  const fullText = `${"A".repeat(4000)}${"B".repeat(4000)}`;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: fullText,
                status: "completed",
                turn_id: "turn-1",
                tool: null,
              },
            ],
            prev_cursor: null,
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
        kind: "agent_text",
        text: `${"A".repeat(1200)}...`,
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  });

  await waitFor(() => state.transcriptHydrationTailReady === true);
  await waitFor(() => state.transcriptHydrationPromise === null);
  assert.equal(state.session.transcript[0].text, fullText);
  assert.equal(state.session.transcript_truncated, false);
  assert.equal(sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length, 1);

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
        kind: "agent_text",
        text: `${"A".repeat(900)}...`,
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  });

  assert.equal(state.session.transcript_truncated, false);
  assert.equal(state.session.transcript[0].text, fullText);
  assert.equal(
    sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length,
    1
  );
});

test("remote hydration backfills a compact user-only tail until agent text is visible", async () => {
  activeBrowser || installBrowserStubs();

  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);

  const pages = new Map([
    [
      null,
      {
        entries: [
          {
            item_id: "user-346",
            kind: "user_text",
            text: "last user tail",
            status: "completed",
            turn_id: "turn-346",
            tool: null,
          },
        ],
        prev_cursor: 345,
      },
    ],
    [
      345,
      {
        entries: [
          {
            item_id: "user-345",
            kind: "user_text",
            text: "middle user tail",
            status: "completed",
            turn_id: "turn-345",
            tool: null,
          },
        ],
        prev_cursor: 344,
      },
    ],
    [
      344,
      {
        entries: [
          {
            item_id: "user-344",
            kind: "user_text",
            text: "first visible user tail",
            status: "completed",
            turn_id: "turn-344",
            tool: null,
          },
        ],
        prev_cursor: 343,
      },
    ],
    [
      343,
      {
        entries: [
          {
            item_id: "assistant-343",
            kind: "agent_text",
            text: "Recovered agent response before the compacted tail",
            status: "completed",
            turn_id: "turn-343",
            tool: null,
          },
        ],
        prev_cursor: null,
      },
    ],
  ]);

  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      const before = frame.payload.request?.input?.before ?? null;
      setImmediate(async () => {
        const page = pages.get(before);
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            entries: page?.entries || [],
            prev_cursor: page?.prev_cursor ?? null,
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
    active_turn_id: "turn-346",
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
        item_id: "user-344",
        kind: "user_text",
        text: "first visible user tail",
        status: "completed",
        turn_id: "turn-344",
        tool: null,
      },
      {
        item_id: "user-345",
        kind: "user_text",
        text: "middle user tail",
        status: "completed",
        turn_id: "turn-345",
        tool: null,
      },
      {
        item_id: "user-346",
        kind: "user_text",
        text: "last user tail",
        status: "completed",
        turn_id: "turn-346",
        tool: null,
      },
    ],
  });

  await waitFor(() => state.transcriptHydrationPromise === null);

  assert.deepEqual(
    sentPayloads.map((payload) => payload.request?.input?.before ?? null),
    [null, 345, 344, 343]
  );
  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    ["assistant-343", "user-344", "user-345", "user-346"]
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.kind === "agent_text")?.text,
    "Recovered agent response before the compacted tail"
  );
  assert.equal(state.session.transcript_truncated, false);
});

test("reapplying the same compact snapshot while hydration is loading does not restart from tail", async () => {
  activeBrowser || installBrowserStubs();

  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
    },
  };

  const snapshot = {
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
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applySessionSnapshot(snapshot);
  await waitFor(() => sentPayloads.length >= 1);

  assert.deepEqual(
    sentPayloads.map((payload) => payload.request?.type),
    ["fetch_thread_transcript"]
  );

  applySessionSnapshot(snapshot);
  await nextTick();

  assert.deepEqual(
    sentPayloads.map((payload) => payload.request?.type),
    ["fetch_thread_transcript"]
  );

  await handleRemoteBrokerPayload({
    kind: "remote_action_result",
    action_id: sentPayloads[0].action_id,
    action: "fetch_thread_transcript",
    ok: true,
    snapshot: {},
    thread_transcript: {
      thread_id: "thread-1",
      entries: [
        {
          item_id: "item-1",
          kind: "agent_text",
          text: "hello world",
          status: "completed",
          turn_id: "turn-1",
          tool: null,
        },
      ],
      prev_cursor: null,
    },
  });
});

test("hydration stops automatically once the tail entries are complete", async () => {
  activeBrowser || installBrowserStubs();

  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: "hello world",
                status: "completed",
                turn_id: "turn-1",
                tool: null,
              },
            ],
            prev_cursor: null,
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
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  });

  await waitFor(() => state.transcriptHydrationTailReady === true);
  await waitFor(() => state.transcriptHydrationPromise === null);
  await nextTick();

  assert.equal(state.session.transcript[0].text, "hello world");
  assert.equal(state.transcriptHydrationStatus, "complete");
  assert.equal(state.transcriptHydrationOlderCursor, null);
  assert.deepEqual(
    sentPayloads.map((payload) => payload.request?.type),
    ["fetch_thread_transcript"]
  );
});

test("maybeLoadOlderTranscriptHistory prepends older complete transcript pages", async () => {
  activeBrowser || installBrowserStubs();

  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const {
    applySessionSnapshot,
    maybeLoadOlderTranscriptHistory,
  } = await import("./session-ops.js");
  const { setRemoteTranscriptElement } = await import("./ui-refs.js");

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
  seedTranscriptHydrationState(state);

  let fetchCount = 0;
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      setImmediate(async () => {
        fetchCount += 1;
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: fetchCount === 1
            ? {
                thread_id: "thread-1",
                entries: [
                  {
                    item_id: "item-2",
                    kind: "agent_text",
                    text: "latest reply",
                    status: "completed",
                    turn_id: "turn-2",
                    tool: null,
                  },
                  {
                    item_id: "item-3",
                    kind: "user_text",
                    text: "thanks",
                    status: "completed",
                    turn_id: "turn-3",
                    tool: null,
                  },
                ],
                prev_cursor: 1,
              }
            : {
                thread_id: "thread-1",
                entries: [
                  {
                    item_id: "item-1",
                    kind: "user_text",
                    text: "older question",
                    status: "completed",
                    turn_id: "turn-1",
                    tool: null,
                  },
                ],
                prev_cursor: null,
              },
        });
      });
    },
  };

  setRemoteTranscriptElement({
    scrollTop: 0,
  });

  applySessionSnapshot({
    active_thread_id: "thread-1",
    active_controller_device_id: null,
    active_controller_last_seen_at: null,
    active_flags: [],
    active_turn_id: "turn-3",
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
        item_id: "item-2",
        kind: "agent_text",
        text: "latest...",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
      {
        item_id: "item-3",
        kind: "user_text",
        text: "thanks",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  });

  await waitFor(() => state.transcriptHydrationTailReady === true);
  await waitFor(() => state.transcriptHydrationOlderCursor === 1);
  assert.equal(state.session.transcript_truncated, true);

  await maybeLoadOlderTranscriptHistory();
  await waitFor(() => state.transcriptHydrationOlderCursor === null);

  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    ["item-1", "item-2", "item-3"]
  );
  assert.equal(state.session.transcript[0].text, "older question");
  assert.equal(state.session.transcript_truncated, false);
  assert.deepEqual(
    sentPayloads.map((payload) => payload.request?.input?.before ?? null),
    [null, 1]
  );
});

test("startRemoteSession re-enables the start button when the relay does not reply", async () => {
  const browser = activeBrowser || installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { startRemoteSession } = await import("./session-ops.js");

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
  const sessionDraft = {
    approvalPolicy: "on-request",
    cwd: "/tmp/demo",
    effort: "medium",
    initialPrompt: "",
    model: "gpt-5.4",
    sandbox: "workspace-write",
  };
  state.socket = {
    readyState: 1,
    send() {},
  };

  const pending = startRemoteSession(sessionDraft);

  browser.runTimers();
  assert.equal(await pending, false);
});

test("refreshRemoteThreads clears loading state and records an error when the relay does not reply", async () => {
  const browser = activeBrowser || installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { refreshRemoteThreads } = await import("./session-ops.js");

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
  state.threads = [];
  state.socket = {
    readyState: 1,
    send() {},
  };

  const pending = refreshRemoteThreads("unit-test refresh").catch((error) => error);

  browser.runTimers();
  const result = await pending;

  assert.match(result.message, /timed out/i);
});

test("sendMessage clears pending state when the relay does not reply", async () => {
  activeBrowser || installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { sendMessage } = await import("./session-ops.js");

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
    sessionClaim: "claim-token-1",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.pendingActions.clear();
  state.socket = {
    readyState: 1,
    send() {
      throw new Error("socket write failed");
    },
  };

  const pending = sendMessage("hello remote", "medium");

  assert.equal(await pending, false);
});

test("applyTranscriptDelta updates existing transcript entries using text and status fields", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "completed",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
  });

  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript[0].status, "running");
  assert.equal(state.session.transcript[0].kind, "agent_text");
});

test("applyTranscriptDelta does not mutate the previous session snapshot", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  const entry = {
    item_id: "item-1",
    kind: "agent_text",
    status: "completed",
    text: "Hello",
    turn_id: "turn-1",
    tool: null,
  };
  const previousSession = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [entry],
  };
  state.session = previousSession;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 1,
    revision: 2,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
  });

  assert.equal(previousSession.transcript[0], entry);
  assert.equal(previousSession.transcript[0].text, "Hello");
  assert.notEqual(state.session, previousSession);
  assert.notEqual(state.session.transcript, previousSession.transcript);
  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript_revision, 2);
});

test("applyTranscriptDelta requires matching base revision when present", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "completed",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 4,
    revision: 5,
    entry_seq: 1,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " stale",
    delta_kind: "agent_text",
  });

  assert.equal(state.session.transcript[0].text, "Hello");
  assert.equal(state.session.transcript_revision, 5);

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    entry_seq: 1,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
  });

  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript_revision, 6);
  assert.equal(state.session.transcript[0].entry_seq, 1);
});

test("applyTranscriptDelta ignores deltas for a different active thread", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "completed",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-2",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wrong",
    delta_kind: "agent_text",
  });

  assert.equal(state.session.transcript[0].text, "Hello");
  assert.equal(state.session.transcript[0].status, "completed");
});

test("applySessionSnapshot ignores stale snapshots for the active thread", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "completed",
        text: "fresh",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applySessionSnapshot({
    active_thread_id: "thread-1",
    transcript_revision: 4,
    transcript_truncated: false,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "completed",
        text: "stale",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  });

  assert.equal(state.session.transcript_revision, 5);
  assert.equal(state.session.transcript[0].text, "fresh");
});

test("applyTranscriptEvent patches entries without replacing visible transcript", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptEvent } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 7,
    transcript: [
      {
        item_id: "item-1",
        kind: "user_text",
        status: "completed",
        text: "older question",
        turn_id: "turn-1",
        tool: null,
      },
      {
        item_id: "item-2",
        kind: "command",
        status: "running",
        text: "npm test",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };

  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    revision: 8,
    item_id: "item-2",
    entry_kind: "command",
    status: "completed",
    text: "npm test\npassed",
    turn_id: "turn-2",
  });

  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    ["item-1", "item-2"]
  );
  assert.equal(state.session.transcript[1].status, "completed");
  assert.equal(state.session.transcript[1].text, "npm test\npassed");
  assert.equal(state.session.transcript_revision, 8);
});

test("applyTranscriptEvent updates approvals as metadata only", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptEvent } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "completed",
        text: "visible history",
        turn_id: "turn-1",
        tool: null,
      },
    ],
    pending_approvals: [],
  };

  applyTranscriptEvent({
    kind: "approval_added",
    approval: {
      request_id: "approval-1",
      summary: "Run command",
    },
  });

  assert.equal(state.session.pending_approvals[0].request_id, "approval-1");
  assert.equal(state.session.transcript[0].text, "visible history");

  applyTranscriptEvent({
    kind: "approval_resolved",
    request_id: "approval-1",
  });

  assert.deepEqual(state.session.pending_approvals, []);
  assert.equal(state.session.transcript[0].text, "visible history");
});

test("sendHeartbeat dispatches a heartbeat when the current device holds control", async () => {
  const browser = activeBrowser || installBrowserStubs();

  const sentPayloads = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { sendHeartbeat } = await import("./session-ops.js");

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
    sessionClaim: "claim-token-1",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-1",
  });
  state.pendingActions.clear();
  state.session = {
    active_thread_id: "thread-1",
    active_controller_device_id: "device-1",
  };
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
    },
  };

  const pending = sendHeartbeat();
  await nextTick();

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].request.type, "heartbeat");
  assert.equal(state.pendingActions.size, 0);
  await pending;
});

test("applySessionSnapshot re-hydrates a long final message added after the first hydration", async () => {
  // Regression for the streaming-tail bug: an early oversized snapshot hydrates
  // and marks the thread "complete"; the long FINAL assistant message then
  // arrives as a new entry in a later truncated snapshot and must still be
  // hydrated to full text (previously it stayed frozen on its "…" preview until
  // the user switched threads and back).
  const browser = activeBrowser || installBrowserStubs();
  void browser;
  const sentPayloads = [];
  const replyOne = `${"A".repeat(4000)}${"B".repeat(2000)}`;
  const replyTwo = `${"C".repeat(4000)}${"D".repeat(2000)}`;

  // Authoritative full transcript on the "backend"; grows as the turn proceeds.
  let backendEntries = [
    { item_id: "item-1", kind: "agent_text", text: replyOne, status: "completed", turn_id: "turn-1", tool: null },
  ];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot } = await import("./session-ops.js");

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
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      if (frame.payload.request?.type !== "fetch_thread_transcript") {
        return;
      }
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            entries: backendEntries.map((entry) => ({ ...entry })),
            prev_cursor: null,
          },
        });
      });
    },
  };

  const fetchCount = () =>
    sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length;
  const snap = (transcript) => ({
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
    transcript,
  });

  // Snapshot 1: only the first long reply, truncated -> hydrates to full text.
  applySessionSnapshot(
    snap([
      { item_id: "item-1", kind: "agent_text", text: `${"A".repeat(1200)}...`, status: "completed", turn_id: "turn-1", tool: null },
    ])
  );
  await waitFor(() => state.transcriptHydrationTailReady === true);
  await waitFor(() => state.transcriptHydrationPromise === null);
  assert.equal(state.session.transcript.find((entry) => entry.item_id === "item-1")?.text, replyOne);
  assert.equal(fetchCount(), 1);

  // The long FINAL message arrives as a new entry.
  backendEntries = [
    { item_id: "item-1", kind: "agent_text", text: replyOne, status: "completed", turn_id: "turn-1", tool: null },
    { item_id: "item-2", kind: "agent_text", text: replyTwo, status: "completed", turn_id: "turn-1", tool: null },
  ];
  applySessionSnapshot(
    snap([
      { item_id: "item-1", kind: "agent_text", text: `${"A".repeat(1200)}...`, status: "completed", turn_id: "turn-1", tool: null },
      { item_id: "item-2", kind: "agent_text", text: `${"C".repeat(1200)}...`, status: "completed", turn_id: "turn-1", tool: null },
    ])
  );
  await waitFor(
    () => state.session.transcript.find((entry) => entry.item_id === "item-2")?.text === replyTwo
  );

  assert.equal(state.session.transcript.find((entry) => entry.item_id === "item-2")?.text, replyTwo);
  assert.equal(state.session.transcript_truncated, false);
  assert.equal(fetchCount(), 2, "the new final message triggered exactly one more fetch");
});
