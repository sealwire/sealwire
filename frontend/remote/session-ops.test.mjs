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

test("view-only thread stays pinned across live snapshots and review completion", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, viewRemoteThread } = await import("./session-ops.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-view",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "parent-view-1",
            entries: [
              {
                item_id: "p1",
                kind: "agent_text",
                text: "parent body",
                status: "completed",
                turn_id: "t1",
                tool: null,
              },
            ],
            prev_cursor: null,
          },
        });
      });
    },
  };

  const snapshot = (overrides) => ({
    active_controller_device_id: "device-2",
    active_controller_last_seen_at: 1,
    active_flags: [],
    active_turn_id: null,
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
    transcript_truncated: false,
    transcript: [],
    ...overrides,
  });

  const reviewing = [
    { id: "rev-1", status: "waiting_for_reviewer", parent_thread_id: "parent-view-1" },
  ];

  // 1. Live session is on another thread; a review is running on parent-view-1.
  applySessionSnapshot(
    snapshot({
      active_thread_id: "thread-other",
      active_review_jobs: reviewing,
      thread_activity: [
        { thread_id: "parent-view-1", phase: "thinking", tool: null },
      ],
    })
  );
  assert.equal(state.session.active_thread_id, "thread-other");
  state.threads = [{ id: "parent-view-1", cwd: "/tmp/project" }];

  // 2. View the reviewed parent read-only (resume would be backend-rejected).
  const ok = await viewRemoteThread("parent-view-1");
  assert.equal(ok, true);
  assert.equal(state.session.active_thread_id, "parent-view-1", "view-only shows the parent");
  assert.equal(
    state.session.current_status,
    "active",
    "transcript hydration must not settle a working viewed thread to idle"
  );
  assert.equal(state.session.current_phase, "thinking");
  assert.equal(state.session.active_turn_id, "view:parent-view-1");

  // 3. A live snapshot for the OTHER active thread (review still running) must NOT
  //    overwrite the pinned view-only projection.
  applySessionSnapshot(
    snapshot({ active_thread_id: "thread-other", active_review_jobs: reviewing })
  );
  assert.equal(
    state.session.active_thread_id,
    "parent-view-1",
    "the pinned parent stays displayed while the review runs"
  );

  // 4. Review completion is still just another background snapshot; viewing
  //    remains client-local until the user sends or navigates elsewhere.
  applySessionSnapshot(
    snapshot({
      active_thread_id: "thread-other",
      active_review_jobs: [
        { id: "rev-1", status: "complete", parent_thread_id: "parent-view-1" },
      ],
    })
  );
  assert.equal(
    state.session.active_thread_id,
    "parent-view-1",
    "review completion must not move the user's view"
  );
});

test("viewing the live thread stays pinned when another client moves live focus", async () => {
  activeBrowser = installBrowserStubs();

  const { state } = await import("./state.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
    viewRemoteThread,
  } = await import("./session-ops.js");

  clearSessionRuntime();
  state.session = null;
  state.threads = [
    { id: "thread-a", cwd: "/tmp/a", status: "active" },
    { id: "thread-b", cwd: "/tmp/b", status: "active" },
  ];
  seedTranscriptHydrationState(state);

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_cwd: "/tmp/a",
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "a-1", text: "thread A" }],
    transcript_truncated: false,
  });
  assert.equal(await viewRemoteThread("thread-a"), true);

  applySessionSnapshot({
    active_thread_id: "thread-b",
    active_turn_id: "turn-b",
    current_cwd: "/tmp/b",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [{ thread_id: "thread-b", phase: "thinking", tool: null }],
    transcript: [{ item_id: "b-1", text: "thread B" }],
    transcript_truncated: false,
  });

  assert.equal(state.realSession.active_thread_id, "thread-b");
  assert.equal(state.session.active_thread_id, "thread-a");
  assert.equal(state.session.view_only, true);
  assert.equal(state.session.current_status, "idle");
  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    ["a-1"]
  );

  applyTranscriptDelta({
    thread_id: "thread-b",
    item_id: "b-1",
    turn_id: "turn-b",
    delta: " live",
    delta_kind: "agent_text",
    revision: 1,
  });
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.realSession.transcript[0].text, "thread B live");
  assert.equal(state.session.active_thread_id, "thread-a");
  assert.equal(state.session.transcript[0].text, "thread A");
});

test("remote view of an idle saved Codex thread stays composable despite stale activity", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { canComposeThread } = await import("../shared/thread-compose.js");
  const { sessionIsWorking } = await import("../shared/thread-attention.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    clearSessionRuntime,
    viewRemoteThread,
  } = await import("./session-ops.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-view-idle",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  state.threads = [
    { id: "saved-codex", cwd: "/tmp/saved", provider: "codex", status: "unknown" },
  ];
  seedTranscriptHydrationState(state);
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "saved-codex",
            server_time: 101,
            entries: [{ item_id: "tail", kind: "agent_text", text: "done", status: "completed" }],
            prev_cursor: null,
            thread_state: {
              active_turn_id: null,
              current_cwd: "/tmp/saved",
              current_phase: null,
              current_status: "notLoaded",
              current_tool: null,
              provider: "codex",
              review_locked: false,
              settings_writable: true,
            },
          },
        });
      });
    },
  };

  const staleLiveSnapshot = {
    active_thread_id: "live-thread",
    active_turn_id: "turn-live",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    server_time: 100,
    thread_activity: [{ thread_id: "saved-codex", phase: "thinking", tool: "bash" }],
    transcript: [],
    transcript_truncated: false,
  };
  applySessionSnapshot(staleLiveSnapshot);

  assert.equal(await viewRemoteThread("saved-codex"), true);
  assert.equal(state.session.active_thread_id, "saved-codex");
  assert.equal(state.session.active_turn_id, null);
  assert.equal(state.session.current_status, "notLoaded");
  assert.equal(state.session.current_phase, null);
  assert.equal(state.session.current_tool, null);
  assert.equal(state.session.view_last_refresh_server_time, 101);
  assert.equal(sessionIsWorking(state.session), false);
  assert.equal(
    canComposeThread({
      activeTurnId: state.session.active_turn_id,
      hasActiveSession: Boolean(state.session.active_thread_id),
      hasControllerLease: false,
      reviewLocked: false,
    }),
    true
  );

  applySessionSnapshot(staleLiveSnapshot);
  assert.equal(state.session.active_turn_id, null);
  assert.equal(state.session.current_phase, null);
  assert.equal(state.session.view_last_refresh_server_time, 101);

  applyTranscriptDelta({
    thread_id: "live-thread",
    item_id: "live-delta",
    turn_id: "turn-live",
    delta: "still live",
    delta_kind: "agent_text",
    revision: 1,
    server_time: 102,
  });
  assert.equal(state.realSession.server_time, 102);
  assert.equal(state.realSession.thread_activity_server_time, 100);
  assert.equal(state.session.active_turn_id, null);
  assert.equal(state.session.current_phase, null);

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
});

test("successful first send follows a promoted Claude pending thread id", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { ensureRemoteRuntimeConfigured } = await import("./remote-runtime.js");
  const {
    applySessionSnapshot,
    clearSessionRuntime,
    sendMessage,
    viewRemoteThread,
  } = await import("./session-ops.js");

  ensureRemoteRuntimeConfigured();
  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-pending-promotion",
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
  seedTranscriptHydrationState(state);

  const pendingId = "claude-pending-abc";
  const realId = "claude-real-123";
  applySessionSnapshot({
    active_thread_id: pendingId,
    active_turn_id: null,
    current_cwd: "/tmp/project",
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [],
    transcript_truncated: false,
  });
  assert.equal(await viewRemoteThread(pendingId), true);

  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_session_result",
          action_id: frame.payload.action_id,
          action: "send_message",
          ok: true,
          snapshot: {
            active_thread_id: realId,
            active_turn_id: "claude-turn-1",
            current_cwd: "/tmp/project",
            current_status: "active",
            pending_approvals: [],
            pending_ask_user_questions: [],
            transcript: [
              {
                item_id: "user-1",
                kind: "user_text",
                status: "completed",
                text: "hello",
                turn_id: "claude-turn-1",
                tool: null,
              },
            ],
            transcript_truncated: false,
          },
        });
      });
    },
  };

  assert.equal(await sendMessage("hello", "medium"), true);
  assert.equal(state.realSession.active_thread_id, realId);
  assert.equal(state.session.active_thread_id, realId);
  assert.equal(state.session.view_only, undefined);
  assert.equal(state.session.transcript[0].text, "hello");
  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
});

test("remote send clamps a foreign effort the codex model rejects", async () => {
  // REGRESSION: the remote composer forwards the live session effort verbatim.
  // A codex thread carrying a Claude-only "max" (codex rejects `unknown variant
  // max`) would 400 every send -> "codex can't send at all" on mobile. The send
  // must clamp the effort to the target model's supported set before dispatch,
  // mirroring the local lifecycle fix.
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { ensureRemoteRuntimeConfigured } = await import("./remote-runtime.js");
  const { applySessionSnapshot, clearSessionRuntime, sendMessage } = await import(
    "./session-ops.js"
  );

  ensureRemoteRuntimeConfigured();
  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-codex-clamp",
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
  seedTranscriptHydrationState(state);

  applySessionSnapshot({
    active_thread_id: "codex-thread-1",
    active_turn_id: null,
    current_cwd: "/tmp/project",
    current_status: "idle",
    model: "gpt-5.3-codex",
    reasoning_effort: "max",
    available_models: [
      {
        model: "gpt-5.3-codex",
        provider: "codex",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
        default_reasoning_effort: "medium",
      },
    ],
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [],
    transcript_truncated: false,
  });

  let sentEffort = "<none>";
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      // Only the send_message frame carries an effort. The surface also emits
      // watch_threads frames to declare what it has on screen, and capturing
      // whichever frame happened to go last would read null off one of those.
      if (frame.payload?.request?.type !== "send_message") {
        return;
      }
      sentEffort = frame.payload?.request?.input?.effort ?? null;
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_session_result",
          action_id: frame.payload.action_id,
          action: "send_message",
          ok: true,
          snapshot: {
            active_thread_id: "codex-thread-1",
            active_turn_id: "codex-turn-1",
            current_cwd: "/tmp/project",
            current_status: "active",
            pending_approvals: [],
            pending_ask_user_questions: [],
            transcript: [],
            transcript_truncated: false,
          },
        });
      });
    },
  };

  // The composer carries the live session effort "max" (poisoned onto a codex
  // thread); it must reach the relay as the model default, never as "max".
  assert.equal(await sendMessage("hi", "max", "gpt-5.3-codex"), true);
  assert.equal(sentEffort, "medium");

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
});

test("stale view-only fetch cannot override a newer resume", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const {
    applySessionSnapshot,
    resumeRemoteSession,
    viewRemoteThread,
  } = await import("./session-ops.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-view-race",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  seedTranscriptHydrationState(state);

  let resolveViewFetch;
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      if (frame.payload.request?.type === "fetch_thread_transcript") {
        resolveViewFetch = () => {
          void handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "fetch_thread_transcript",
            ok: true,
            snapshot: {},
            thread_transcript: {
              thread_id: "parent-view-race",
              entries: [
                {
                  item_id: "parent-entry",
                  kind: "agent_text",
                  text: "stale parent body",
                  status: "completed",
                  turn_id: "parent-turn",
                  tool: null,
                },
              ],
              prev_cursor: null,
            },
          });
        };
        return;
      }
      if (frame.payload.request?.type === "resume_session") {
        setImmediate(() => {
          void handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "resume_session",
            ok: true,
            snapshot: {},
          });
        });
      }
    },
  };

  const reviewing = [
    {
      id: "review-race",
      status: "waiting_for_reviewer",
      parent_thread_id: "parent-view-race",
    },
  ];
  applySessionSnapshot({
    active_controller_device_id: "device-1",
    active_review_jobs: reviewing,
    active_thread_id: "thread-live",
    active_turn_id: null,
    current_cwd: "/tmp/project",
    current_status: "idle",
    pending_approvals: [],
    transcript: [],
    transcript_truncated: false,
  });
  state.threads = [
    { id: "parent-view-race", cwd: "/tmp/project" },
    { id: "thread-new-live", cwd: "/tmp/project" },
  ];

  const pendingView = viewRemoteThread("parent-view-race");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof resolveViewFetch, "function", "view transcript fetch is pending");

  const resumed = await resumeRemoteSession("thread-new-live");
  assert.equal(resumed, true);
  applySessionSnapshot({
    active_controller_device_id: "device-1",
    active_review_jobs: reviewing,
    active_thread_id: "thread-new-live",
    active_turn_id: null,
    current_cwd: "/tmp/project",
    current_status: "idle",
    pending_approvals: [],
    transcript: [{ item_id: "live-entry", text: "new live body" }],
    transcript_truncated: false,
  });

  resolveViewFetch();
  assert.equal(await pendingView, false, "the stale view response is discarded");
  assert.equal(
    state.session.active_thread_id,
    "thread-new-live",
    "the stale view does not replace the newer live navigation"
  );
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

test("startRemoteSession carries the chosen project so a phone can file a session too", async () => {
  // Remote cannot do what local used to: its start_session returns no thread id,
  // so the start input is the only place a phone can name a project.
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();

  const sent = [];
  state.socket = {
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };

  const pending = startRemoteSession({
    approvalPolicy: "on-request",
    cwd: "/tmp/demo",
    effort: "medium",
    initialPrompt: "",
    model: "gpt-5.4",
    projectId: "proj_00ff",
    sandbox: "workspace-write",
  });
  browser.runTimers();
  await pending;

  const input = sent
    .map((frame) => frame?.payload?.request?.input)
    .find((candidate) => candidate && "project_id" in candidate);
  assert.ok(input, "the start action must carry an input with a project_id");
  assert.equal(input.project_id, "proj_00ff");
});

test("an unfiled remote session sends a null project rather than omitting it", async () => {
  // Absent and null both mean unassigned today, but sending the key means the wire
  // always shows what the dialog decided.
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();

  const sent = [];
  state.socket = {
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };

  const pending = startRemoteSession({
    approvalPolicy: "on-request",
    cwd: "/tmp/demo",
    effort: "medium",
    initialPrompt: "",
    model: "gpt-5.4",
    projectId: null,
    sandbox: "workspace-write",
  });
  browser.runTimers();
  await pending;

  const input = sent
    .map((frame) => frame?.payload?.request?.input)
    .find((candidate) => candidate && "project_id" in candidate);
  assert.ok(input, "the key must be present even when nothing is chosen");
  assert.equal(input.project_id, null);
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

test("remote thread list auto-refreshes on a poll without a manual refresh", async () => {
  // Regression guard: the remote sidebar must auto-update its timestamps and
  // reorder like the local sidebar (which re-polls /api/threads every 12s).
  // Before this fix, refreshRemoteThreads only ran on the manual refresh button
  // or on recovery, so the left list froze until the user pressed refresh.
  const browser = installBrowserStubs();
  activeBrowser = browser;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const sessionOps = await import("./session-ops.js");
  const { refreshRemoteThreads } = sessionOps;

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-poll",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-poll",
    relayPeerId: "relay-poll",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-poll",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: "claim-token-poll",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-poll",
  });
  state.pendingActions.clear();
  state.threads = [];
  state.remoteThreadsPollTimer = null;

  // Two successive thread-list snapshots: the second moves thread-2 to the top
  // with a fresher updated_at — i.e. "I just chatted in thread-2 from another
  // device" — which the poll must surface without a manual refresh.
  const threadRevisions = [
    [
      { id: "thread-1", cwd: "/tmp/demo", provider: "codex", updated_at: 1000 },
      { id: "thread-2", cwd: "/tmp/demo", provider: "codex", updated_at: 900 },
    ],
    [
      { id: "thread-2", cwd: "/tmp/demo", provider: "codex", updated_at: 2000 },
      { id: "thread-1", cwd: "/tmp/demo", provider: "codex", updated_at: 1000 },
    ],
  ];
  const listThreadsSent = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      if (frame.payload?.request?.type !== "list_threads") {
        return;
      }
      const threads =
        threadRevisions[Math.min(listThreadsSent.length, threadRevisions.length - 1)];
      listThreadsSent.push(frame.payload);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "list_threads",
          ok: true,
          snapshot: {},
          threads: { threads },
        });
      });
    },
  };

  // The initial refresh (as recovery performs) seeds the list AND must arm the
  // recurring poll — mirroring local loadThreads() scheduling the next poll.
  await refreshRemoteThreads("recovery sync");
  assert.equal(listThreadsSent.length, 1);
  assert.equal(state.threads[0].id, "thread-1");
  assert.ok(
    state.remoteThreadsPollTimer,
    "refreshRemoteThreads should arm the recurring remote thread poll"
  );

  // Fire the scheduled poll. No manual refresh button is pressed here.
  browser.runNextTimer();
  await waitFor(() => listThreadsSent.length >= 2);
  await waitFor(() => state.threads[0]?.id === "thread-2");

  assert.equal(state.threads[0].id, "thread-2");
  assert.equal(state.threads[0].updated_at, 2000);

  sessionOps.cancelRemoteThreadsPoll?.();
});

test("cancelRemoteThreadsPoll stops the recurring remote thread poll", async () => {
  // Teardown paths (broker disconnect / relay switch / return home) must be able
  // to stop the loop so it does not keep firing list_threads after the surface is
  // torn down.
  const browser = installBrowserStubs();
  activeBrowser = browser;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { scheduleRemoteThreadsPoll, cancelRemoteThreadsPoll } = await import("./session-ops.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-cancel",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-cancel",
    relayPeerId: "relay-cancel",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-cancel",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: "claim-token-cancel",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: true,
    socketPeerId: "surface-peer-cancel",
  });
  state.pendingActions.clear();
  state.remoteThreadsPollTimer = null;

  const sentTypes = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      sentTypes.push(JSON.parse(frameText).payload?.request?.type || null);
    },
  };

  scheduleRemoteThreadsPoll();
  assert.ok(state.remoteThreadsPollTimer, "poll should be armed");

  cancelRemoteThreadsPoll();
  assert.equal(state.remoteThreadsPollTimer, null, "cancel should clear the timer");

  // Draining timers must not fire a poll after cancellation.
  browser.runTimers();
  assert.equal(
    sentTypes.filter((type) => type === "list_threads").length,
    0,
    "no thread list request should be sent after the poll is cancelled"
  );
});

test("the remote thread poll idles without a network round trip while disconnected", async () => {
  // While the broker socket is down a fired poll must skip the (doomed) request
  // but keep the loop alive so polling resumes on reconnect.
  const browser = installBrowserStubs();
  activeBrowser = browser;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { scheduleRemoteThreadsPoll, cancelRemoteThreadsPoll } = await import("./session-ops.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-offline",
    brokerUrl: "wss://broker.example.test",
    brokerChannelId: "room-offline",
    relayPeerId: "relay-offline",
    securityMode: "managed",
    deviceId: "device-1",
    deviceLabel: "Primary Phone",
    payloadSecret: "payload-secret-offline",
    deviceRefreshMode: "cookie",
    deviceRefreshToken: null,
    deviceJoinTicket: "device-ws-token",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 300,
    sessionClaim: "claim-token-offline",
    sessionClaimExpiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  seedSocketState(state, {
    socketConnected: false,
    socketPeerId: null,
  });
  state.pendingActions.clear();
  state.remoteThreadsPollTimer = null;

  const sentTypes = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      sentTypes.push(JSON.parse(frameText).payload?.request?.type || null);
    },
  };

  scheduleRemoteThreadsPoll();
  browser.runNextTimer();

  assert.equal(
    sentTypes.filter((type) => type === "list_threads").length,
    0,
    "a disconnected poll must not send a list_threads request"
  );
  assert.ok(
    state.remoteThreadsPollTimer,
    "the poll loop must stay armed so it resumes after reconnect"
  );

  cancelRemoteThreadsPoll();
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

test("a failed remote send records the reason for the composer, not just the log", async () => {
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  state.composerErrors = {};
  state.session = { active_thread_id: "thread-1", available_models: [], model: "gpt-5.5" };
  state.socket = {
    readyState: 1,
    send() {
      throw new Error("socket write failed");
    },
  };

  assert.equal(await sendMessage("hello remote", "medium"), false);
  // Keyed by the thread it was sent to: the phone switches sessions freely,
  // and a failure that outlives the switch must not surface on the session the
  // user is now looking at (it would even name the wrong thread).
  assert.match(
    String(state.composerErrors?.["thread-1"]),
    /socket write failed/,
    "the phone must be able to show WHY the send failed"
  );

  // A later attempt on a DIFFERENT thread must not silence it: same inverse
  // race the local surface had, where one thread's clear wiped another's.
  state.session = { active_thread_id: "thread-2", available_models: [], model: "gpt-5.5" };
  await sendMessage("hello again", "medium");

  assert.match(
    String(state.composerErrors?.["thread-1"]),
    /socket write failed/,
    "thread-1's failure survives an attempt aimed at thread-2"
  );
  assert.match(String(state.composerErrors?.["thread-2"]), /socket write failed/);
});

test("a workspace repair the relay accepted is reported as success, not as a script error", async (t) => {
  activeBrowser || installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { repairRemoteWorkspace } = await import("./session-ops.js");
  const { readWorkspaceRepair } = await import("./workspace-repair.js");

  // Tests in this file share one module-level `state`, and the socket stub below
  // answers exactly two actions for one hard-coded thread. Left installed it would
  // silently become the transport for every later test that does not bring its own
  // — they would hang waiting for a reply it never sends. Restored from `t.after`
  // rather than the end of the body so a failed assertion cannot skip it.
  const previousSocket = state.socket;
  const previousSession = state.session;
  t.after(() => {
    state.socket = previousSocket;
    state.session = previousSession;
    state.pendingActions.clear();
  });

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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  state.workspaceRepairByThread = new Map();
  state.session = { active_thread_id: "thread-repair-1", available_models: [], model: "fake-echo" };

  const dispatched = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      const requestType = frame.payload.request?.type;
      dispatched.push(requestType);
      setImmediate(async () => {
        // Answer BOTH actions. The refresh this repair kicks off is deduplicated by
        // an in-flight key, so leaving it unanswered parks a promise that never
        // settles and every later test asking for the same page waits on it.
        if (requestType === "fetch_thread_transcript") {
          await handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "fetch_thread_transcript",
            ok: true,
            snapshot: {},
            thread_transcript: {
              thread_id: "thread-repair-1",
              entries: [],
              has_more: false,
              next_before: null,
            },
          });
          return;
        }
        await handleRemoteBrokerPayload({
          kind: "remote_session_result",
          action_id: frame.payload.action_id,
          action: "repair_workspace",
          ok: true,
        });
      });
    },
  };

  const repaired = await repairRemoteWorkspace("thread-repair-1");

  // The relay accepted the repair — the directory is back. Anything this function
  // does AFTER that point runs inside its own try block, so a throw there is
  // caught by the failure path and reported as if the repair itself had failed:
  // the user is told to go fix a workspace that is already fixed, and the
  // transcript refresh that would have cleared the banner never runs.
  assert.equal(repaired, true, "a repair the relay accepted must report success");
  // The refresh is not incidental: the banner goes away on the relay's own verdict
  // in the next transcript payload, so a repair that never reaches this line leaves
  // a "workspace is gone" banner sitting over a workspace that is back.
  assert.deepEqual(dispatched, ["repair_workspace", "fetch_thread_transcript"]);
  assert.equal(
    readWorkspaceRepair(state, "thread-repair-1").error,
    "",
    "a successful repair must leave no error on the banner"
  );
});

test("applyTranscriptDelta updates existing transcript entries using text and status fields", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");

  // No hydration window for this test — it exercises the array fallback.
  // Reset explicitly: an earlier test in this file may have left the window
  // loaded for "thread-1" (hydration is a module-level singleton), which
  // would otherwise make applyTranscriptDelta take the window path against
  // an unrelated item-1 the array below never carries.
  state.transcriptHydrationThreadId = null;
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

  // No window loaded — the array fallback updates synchronously. The flush
  // below is a no-op here; it only matters for the render, not the state.
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript[0].status, "running");
  assert.equal(state.session.transcript[0].kind, "agent_text");
});

test("applyTranscriptDelta applies offsetless empty deltas on Remote", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");

  state.transcriptHydrationThreadId = null;
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
  state.realSession = state.session;

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "",
    delta_kind: "agent_text",
    revision: 2,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello");
  assert.equal(state.session.transcript[0].status, "running");
  assert.equal(state.session.transcript_revision, 2);
});

test("remote transcript deltas notify the React store once per frame", async () => {
  installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  state.session = {
    active_thread_id: "thread-frame",
    transcript_revision: 0,
    transcript: [{
      item_id: "item-frame",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-frame",
      tool: null,
    }],
  };
  state.realSession = state.session;

  for (const [revision, delta] of [[1, "one"], [2, " two"], [3, " three"]]) {
    applyTranscriptDelta({
      thread_id: "thread-frame",
      revision,
      item_id: "item-frame",
      turn_id: "turn-frame",
      delta,
      delta_kind: "agent_text",
    });
  }

  // The array itself lags in the buffer until flush — only the notification
  // count (nothing painted yet) is observable before it.
  assert.equal(notifications.length, 0);
  flushRemoteTranscriptRenderForTest();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].transcript[0].text, "one two three");
  assert.equal(state.session.transcript[0].text, "one two three");
  unsubscribe();
});

test("an authoritative snapshot cancels a queued remote delta render", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  seedTranscriptHydrationState(state);
  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  state.session = {
    active_thread_id: "thread-frame-snapshot",
    transcript_revision: 0,
    transcript_truncated: false,
    transcript: [{
      item_id: "item-frame-snapshot",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-frame-snapshot",
      tool: null,
    }],
  };
  state.realSession = state.session;

  applyTranscriptDelta({
    thread_id: "thread-frame-snapshot",
    revision: 1,
    item_id: "item-frame-snapshot",
    turn_id: "turn-frame-snapshot",
    delta: "partial",
    delta_kind: "agent_text",
  });
  applySessionSnapshot({
    active_thread_id: "thread-frame-snapshot",
    active_turn_id: null,
    current_cwd: "/tmp/project",
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_revision: 2,
    transcript_truncated: false,
    transcript: [{
      item_id: "item-frame-snapshot",
      kind: "agent_text",
      status: "completed",
      text: "authoritative",
      turn_id: "turn-frame-snapshot",
      tool: null,
    }],
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].transcript[0].text, "authoritative");
  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the stale delta frame must not render again after the snapshot"
  );
  unsubscribe();
});

test("a queued delta render is cancelled by an immediate thread switch", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
    viewRemoteThread,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  // A prior test's view-only pin (viewOnlyThreadId) is module-private state
  // this test does not otherwise touch — reset it so neither this test's
  // start nor its own pin below leaks into whatever runs next.
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 0,
    transcript: [{
      item_id: "item-live",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-live",
      tool: null,
    }],
  };
  state.session = state.realSession;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-live",
    revision: 1,
    item_id: "item-live",
    turn_id: "turn-live",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the delta must still be coalescing, not yet painted");

  // viewRemoteThread's same-thread branch renders synchronously via
  // applyRenderedSession — the same path a real thread switch, hydration
  // progress step, promotion, or settings update takes.
  const switched = await viewRemoteThread("thread-live");
  assert.equal(switched, true);

  assert.equal(notifications.length, 1, "the switch must render exactly once, immediately");
  assert.equal(
    notifications[0].transcript[0].text,
    "partial",
    "the switch's render must include the pending delta text, not stale text"
  );

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the delta timer left over from before the switch must not render a second time"
  );

  unsubscribe();
  // This test's own pin (viewOnlyThreadId = "thread-live") is module-private
  // state that would otherwise leak into whatever test runs next.
  clearSessionRuntime();
});

// The four tests below mirror local's lifecycle-snapshot-flush.test.mjs
// coverage (approval/ask-user/completion flush on the same tick) using this
// file's own established technique for proving it — subscribeRemoteState's
// notification COUNT, not just the eventual data — for the immediate-class
// events local's snapshot path bundles into one signal but remote receives
// as their own distinct event kinds.

test("a queued delta render is cancelled by an immediate approval_added event", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 0,
    pending_approvals: [],
    transcript: [{
      item_id: "item-live",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-live",
      tool: null,
    }],
  };
  state.session = state.realSession;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-live",
    revision: 1,
    item_id: "item-live",
    turn_id: "turn-live",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the delta must still be coalescing, not yet painted");

  applyTranscriptEvent({
    kind: "approval_added",
    approval: { request_id: "approval-1", summary: "Run a thing" },
  });

  assert.equal(notifications.length, 1, "an approval must render exactly once, immediately");
  assert.equal(
    notifications[0].transcript[0].text,
    "partial",
    "the approval's render must include the pending delta text, not stale text"
  );
  assert.equal(notifications[0].pending_approvals[0].request_id, "approval-1");

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the delta timer left over from before the approval must not render a second time"
  );

  unsubscribe();
  clearSessionRuntime();
});

test("a queued delta render is cancelled by an immediate approval_resolved event", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 0,
    pending_approvals: [{ request_id: "approval-1", summary: "Run a thing" }],
    transcript: [{
      item_id: "item-live",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-live",
      tool: null,
    }],
  };
  state.session = state.realSession;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-live",
    revision: 1,
    item_id: "item-live",
    turn_id: "turn-live",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the delta must still be coalescing, not yet painted");

  applyTranscriptEvent({ kind: "approval_resolved", request_id: "approval-1" });

  assert.equal(notifications.length, 1, "resolving an approval must render exactly once, immediately");
  assert.deepEqual(notifications[0].pending_approvals, []);
  assert.equal(
    notifications[0].transcript[0].text,
    "partial",
    "the resolve's render must include the pending delta text, not stale text"
  );

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the delta timer left over from before the resolve must not render a second time"
  );

  unsubscribe();
  clearSessionRuntime();
});

test("a queued delta render is cancelled by an immediate AskUserQuestion arriving via session_meta_updated", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 0,
    pending_ask_user_questions: [],
    transcript: [{
      item_id: "item-live",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-live",
      tool: null,
    }],
  };
  state.session = state.realSession;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-live",
    revision: 1,
    item_id: "item-live",
    turn_id: "turn-live",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the delta must still be coalescing, not yet painted");

  // Remote has no dedicated AskUserQuestion event — it rides the same
  // generic metadata patch as approvals and turn/error status (see
  // applySessionMetadataPatch's own comment in session-ops.js).
  applyTranscriptEvent({
    kind: "session_meta_updated",
    session: {
      pending_ask_user_questions: [{ request_id: "ask-1", questions: [] }],
    },
  });

  assert.equal(notifications.length, 1, "an incoming AskUserQuestion must render exactly once, immediately");
  assert.equal(notifications[0].pending_ask_user_questions[0].request_id, "ask-1");
  assert.equal(
    notifications[0].transcript[0].text,
    "partial",
    "the AskUserQuestion's render must include the pending delta text, not stale text"
  );

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the delta timer left over from before the AskUserQuestion must not render a second time"
  );

  unsubscribe();
  clearSessionRuntime();
});

test("a completed transcript entry flushes immediately, but a merely-started one still coalesces", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 0,
    transcript: [{
      item_id: "item-live",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-live",
      tool: null,
    }],
  };
  state.session = state.realSession;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-live",
    revision: 1,
    item_id: "item-live",
    turn_id: "turn-live",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the delta must still be coalescing, not yet painted");

  // A "started" patch on a DIFFERENT item is a routine in-flight update — it
  // must join the same coalescing window as the delta above, not flush it.
  applyTranscriptEvent({
    kind: "transcript_entry_started",
    thread_id: "thread-live",
    item_id: "item-tool",
    entry_kind: "tool_call",
    turn_id: "turn-live",
    revision: 2,
  });
  assert.equal(notifications.length, 0, "a merely-started entry must not flush the pending delta early");

  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-live",
    item_id: "item-live",
    entry_kind: "agent_text",
    text: "done",
    turn_id: "turn-live",
    revision: 3,
  });

  assert.equal(notifications.length, 1, "a completed entry must render exactly once, immediately");
  assert.equal(
    notifications[0].transcript.find((entry) => entry.item_id === "item-live")?.text,
    "done",
    "the completion's own text must win over the pending delta text it absorbed"
  );

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the delta timer left over from before the completion must not render a second time"
  );

  unsubscribe();
  clearSessionRuntime();
});

test("a completed transcript entry without entry_kind renders as agent text", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const {
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 1,
    transcript: [],
  };
  state.session = state.realSession;

  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-live",
    item_id: "item-live",
    status: "completed",
    text: "done",
    turn_id: "turn-live",
    revision: 2,
  });

  const entry = state.session.transcript.at(-1);
  assert.equal(entry.kind, "agent_text");
  assert.equal(entry.text, "done");
  assert.equal(state.session.transcript_revision, 2);

  clearSessionRuntime();
});

// P2: completion/approval/AskUserQuestion all had this same-tick,
// one-render, pending-timer-cancellation proof; a failed/error entry patch
// did not. Remote has no dedicated "error" event kind — a turn/tool error
// arrives as a transcript_entry_patched with status: "failed", which is
// exactly the entryPatch.status !== "running" branch every other terminal
// status takes.
test("a failed transcript entry flushes immediately, exactly like a completed one, and cancels the pending delta timer", async () => {
  const browser = installBrowserStubs();
  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();
  clearSessionRuntime();

  state.realSession = {
    active_thread_id: "thread-live",
    transcript_revision: 0,
    transcript: [{
      item_id: "item-live",
      kind: "tool_call",
      status: "running",
      text: "",
      turn_id: "turn-live",
      tool: null,
    }],
  };
  state.session = state.realSession;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-live",
    revision: 1,
    item_id: "item-live",
    turn_id: "turn-live",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the delta must still be coalescing, not yet painted");

  applyTranscriptEvent({
    kind: "transcript_entry_patched",
    thread_id: "thread-live",
    item_id: "item-live",
    entry_kind: "tool_call",
    status: "failed",
    text: "command exited 1",
    turn_id: "turn-live",
    revision: 2,
  });

  assert.equal(notifications.length, 1, "a failed entry must render exactly once, immediately");
  assert.equal(
    notifications[0].transcript.find((entry) => entry.item_id === "item-live")?.status,
    "failed"
  );
  assert.equal(
    notifications[0].transcript.find((entry) => entry.item_id === "item-live")?.text,
    "command exited 1",
    "the failure's own text must win over the pending delta text it absorbed"
  );

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the delta timer left over from before the failure must not render a second time"
  );

  unsubscribe();
  clearSessionRuntime();
});

test("applyTranscriptDelta does not mutate the previous session snapshot", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

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
  // The array rebuild (and with it, a fresh array reference) is deferred to
  // flush — before that, state.session.transcript still IS previousSession's
  // array, with the append sitting in the buffer instead.
  flushRemoteTranscriptRenderForTest();
  assert.notEqual(state.session.transcript, previousSession.transcript);
  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript_revision, 2);
});

test("applyTranscriptDelta requires matching base revision when present", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

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

  // Rejected for a base_revision mismatch — nothing buffered, so this is
  // observable without a flush.
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

  flushRemoteTranscriptRenderForTest();
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

test("applyTranscriptDelta appends agent text contiguously using text_offset", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript[0].status, "running");
  assert.equal(state.session.transcript_revision, 6);
});

test("applyTranscriptDelta applies agent deltas by text_offset even when base_revision is not contiguous", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  // A snapshot (or an interleaved command stream) bumped the revision far past
  // this delta's base_revision. The offset still matches our text, so the delta
  // must apply instead of being rejected as a base_revision mismatch.
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 40,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 41,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript_revision, 41);
});

test("applyTranscriptDelta ignores a duplicate agent delta by text_offset", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 6,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello world",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  // Re-delivery of a chunk we already hold (offset 5 + " world" ends at 11 == have).
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  assert.equal(state.session.transcript[0].text, "Hello world");
});

test("applyTranscriptDelta appends only the missing tail on a partial re-delivery", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 6,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello wor",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  // Have 9 chars; delta starts at offset 5 (" world"), so only "ld" is missing.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
});

test("applyTranscriptDelta repairs when the text_offset overlap does not match local text", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  window.__transcriptGapRepairCount = 0;

  // Local text is long enough to look like a duplicate by length, but its bytes
  // diverged from the server. Length-only logic would silently keep the wrong
  // text; the overlap check must catch it and force a repair.
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello XXXXX",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };
  state.socket = null;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  // Corrupted text is neither extended nor accepted as a duplicate...
  assert.equal(state.session.transcript[0].text, "Hello XXXXX");
  // ...the mismatch forces an authoritative repair.
  assert.equal(window.__transcriptGapRepairCount, 1);

  delete window.__transcriptGapRepairCount;
});

test("applyTranscriptDelta repairs instead of freezing on a text_offset gap", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  window.__transcriptGapRepairCount = 0;

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  // No responding socket here: this test only asserts the gap is detected and a
  // repair is scheduled. The full fetch -> converge path has its own test below;
  // nulling the socket keeps the best-effort repair fetch from mutating state
  // asynchronously.
  state.socket = null;

  // A chunk was dropped on the wire: this delta starts at offset 11 but we only
  // hold 5 chars. The old code silently froze here; now it must request repair.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 10,
    revision: 11,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " again",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  // Never splice the delta in at the wrong offset...
  assert.equal(state.session.transcript[0].text, "Hello");
  // ...and detect the gap + request an authoritative repair pull.
  assert.equal(window.__transcriptGapRepairCount, 1);

  delete window.__transcriptGapRepairCount;
});

test("applyTranscriptDelta repairs instead of dropping on a base_revision gap when no offset is present", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

  window.__transcriptGapRepairCount = 0;

  // Command-output / legacy deltas carry no text_offset; a broken base_revision
  // chain (a dropped command chunk) must trigger repair, not the old silent drop.
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [
      {
        item_id: "cmd-1",
        kind: "command",
        status: "running",
        text: "$ ls",
        turn_id: null,
        tool: null,
      },
    ],
  };

  state.socket = null;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 7,
    revision: 8,
    item_id: "cmd-1",
    delta: "\noutput",
    delta_kind: "command_output",
  });

  assert.equal(state.session.transcript[0].text, "$ ls");
  assert.equal(window.__transcriptGapRepairCount, 1);

  delete window.__transcriptGapRepairCount;
});

test("applyTranscriptDelta gap repair fetches the authoritative tail and converges on a non-truncated session", async () => {
  activeBrowser || installBrowserStubs();
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  window.__transcriptGapRepairCount = 0;

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
            revision: 12,
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: "Hello world again",
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

  // A non-truncated live session with an in-flight agent message.
  state.session = {
    active_thread_id: "thread-1",
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  // A dropped chunk: the delta sits at text_offset 11 but we hold only 5 chars.
  // Repair must actually dispatch fetch_thread_transcript (NOT no-op through the
  // truncated-snapshot hydration gate) and converge to the authoritative text.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 10,
    revision: 11,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " again",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  await waitFor(() => state.session.transcript[0].text === "Hello world again");

  assert.equal(
    sentPayloads.filter((payload) => payload.request?.type === "fetch_thread_transcript").length,
    1
  );
  assert.equal(sentPayloads[0].request.input.thread_id, "thread-1");
  assert.equal(sentPayloads[0].request.input.before, null);
  assert.equal(state.session.transcript[0].text, "Hello world again");
  assert.equal(state.session.transcript_revision, 12);
  assert.equal(state.session.transcript_truncated, false);

  delete window.__transcriptGapRepairCount;
  // Don't leak a thread-1 query/socket into later shared-state tests.
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

test("gap repair updates the live session while preserving a view-only thread", async () => {
  activeBrowser = installBrowserStubs();
  const sentPayloads = [];

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    clearSessionRuntime,
    viewRemoteThread,
  } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-view-gap",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  state.threads = [
    { id: "thread-a", cwd: "/tmp/a", status: "idle" },
    { id: "thread-b", cwd: "/tmp/b", status: "active" },
  ];

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_cwd: "/tmp/a",
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "a-1", text: "thread A" }],
    transcript_revision: 1,
    transcript_truncated: false,
  });
  assert.equal(await viewRemoteThread("thread-a"), true);
  applySessionSnapshot({
    active_thread_id: "thread-b",
    active_turn_id: "turn-b",
    current_cwd: "/tmp/b",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [
      {
        item_id: "b-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-b",
        tool: null,
      },
    ],
    transcript_revision: 5,
    transcript_truncated: false,
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
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-b",
            revision: 12,
            entries: [
              {
                item_id: "b-1",
                kind: "agent_text",
                text: "Hello world again",
                status: "completed",
                turn_id: "turn-b",
                tool: null,
              },
            ],
            prev_cursor: null,
          },
        });
      });
    },
  };

  applyTranscriptDelta({
    thread_id: "thread-b",
    base_revision: 10,
    revision: 11,
    item_id: "b-1",
    turn_id: "turn-b",
    delta: " again",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  await waitFor(() => state.realSession?.transcript?.[0]?.text === "Hello world again");
  assert.equal(sentPayloads.length, 1);
  assert.equal(state.realSession.active_thread_id, "thread-b");
  assert.equal(state.realSession.transcript_revision, 12);
  assert.equal(state.session.active_thread_id, "thread-a");
  assert.equal(state.session.transcript[0].text, "thread A");
  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

test("applyTranscriptDelta gap repair retries after a transient fetch failure and still converges", async () => {
  activeBrowser || installBrowserStubs();
  const sentPayloads = [];
  let fetchAttempts = 0;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  window.__transcriptGapRepairCount = 0;

  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      if (frame.payload.request?.type !== "fetch_thread_transcript") {
        return;
      }
      fetchAttempts += 1;
      const attempt = fetchAttempts;
      setImmediate(async () => {
        if (attempt === 1) {
          // First repair fetch fails transiently; the loop must retry, not bail.
          await handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "fetch_thread_transcript",
            ok: false,
            error: "transient broker hiccup",
          });
          return;
        }
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            revision: 12,
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: "Hello world again",
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

  state.session = {
    active_thread_id: "thread-1",
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 10,
    revision: 11,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " again",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  await waitFor(() => state.session.transcript[0].text === "Hello world again");

  // The first fetch failed, so the loop must have issued at least a second one.
  assert.ok(fetchAttempts >= 2, `expected a retry after the transient failure, got ${fetchAttempts}`);
  assert.equal(state.session.transcript[0].text, "Hello world again");

  delete window.__transcriptGapRepairCount;
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

test("applyTranscriptDelta gap repair honors a higher-revision gap that arrives while a repair is in flight", async () => {
  activeBrowser || installBrowserStubs();
  const sentPayloads = [];
  let fetchAttempts = 0;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  window.__transcriptGapRepairCount = 0;

  // First fetch returns a partial tail at revision 11; the second (driven by the
  // higher-revision gap injected mid-flight) returns the fuller tail at rev 20.
  const tailByAttempt = [
    { revision: 11, text: "Hello world" },
    { revision: 20, text: "Hello world again!!" },
  ];

  let injectedHigherGap = false;
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      if (frame.payload.request?.type !== "fetch_thread_transcript") {
        return;
      }
      fetchAttempts += 1;
      const attempt = fetchAttempts;
      // While the FIRST repair fetch is still in flight, a higher-revision gap
      // arrives. It must not be swallowed by the in-flight repair.
      if (attempt === 1 && !injectedHigherGap) {
        injectedHigherGap = true;
        applyTranscriptDelta({
          thread_id: "thread-1",
          base_revision: 19,
          revision: 20,
          item_id: "item-1",
          turn_id: "turn-1",
          delta: "!!",
          delta_kind: "agent_text",
          text_offset: 17,
        });
      }
      const tail = tailByAttempt[Math.min(attempt, tailByAttempt.length) - 1];
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-1",
            revision: tail.revision,
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: tail.text,
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

  state.session = {
    active_thread_id: "thread-1",
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  // First gap (rev 11) starts a repair; the mock injects a rev-20 gap while it
  // is in flight.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 10,
    revision: 11,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  // Must end on the HIGHER target's content, proving the in-flight gap drove a
  // second fetch rather than being dropped.
  await waitFor(() => state.session.transcript[0].text === "Hello world again!!");

  assert.equal(fetchAttempts, 2);
  assert.equal(state.session.transcript[0].text, "Hello world again!!");
  assert.equal(state.session.transcript_revision, 20);

  delete window.__transcriptGapRepairCount;
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

test("applyTranscriptDelta gap repair retries when fetch returns an incomplete (wrong-thread) page", async () => {
  activeBrowser || installBrowserStubs();
  const sentPayloads = [];
  let fetchAttempts = 0;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  window.__transcriptGapRepairCount = 0;

  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      sentPayloads.push(frame.payload);
      if (frame.payload.request?.type !== "fetch_thread_transcript") {
        return;
      }
      fetchAttempts += 1;
      const attempt = fetchAttempts;
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            // First response is for the WRONG thread — an incomplete/garbled
            // page that must NOT be treated as a successful repair.
            thread_id: attempt === 1 ? "thread-OTHER" : "thread-1",
            revision: 12,
            entries: [
              {
                item_id: "item-1",
                kind: "agent_text",
                text: "Hello world again",
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

  state.session = {
    active_thread_id: "thread-1",
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 10,
    revision: 11,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " again",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  await waitFor(() => state.session.transcript[0].text === "Hello world again");

  // The wrong-thread page was rejected (not silently accepted), so a retry ran.
  assert.equal(fetchAttempts, 2);
  assert.equal(state.session.transcript[0].text, "Hello world again");

  delete window.__transcriptGapRepairCount;
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
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

test("applySessionSnapshot does not replace longer live text with a compact preview", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applySessionSnapshot, applyTranscriptDelta } = await import("./session-ops.js");

  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 9,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello partial full tail",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applySessionSnapshot({
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
    transcript_revision: 10,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello partial...",
        turn_id: "turn-1",
        tool: null,
        content_state: "preview",
      },
    ],
  });

  assert.equal(state.session.transcript_revision, 10);
  assert.equal(state.session.transcript[0].text, "Hello partial full tail");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 9,
    revision: 10,
    entry_seq: 1,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " full tail",
    delta_kind: "agent_text",
  });

  assert.equal(state.session.transcript[0].text, "Hello partial full tail");
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

test("applyTranscriptEvent repairs a rejected completion revision instead of freezing partial text", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptEvent } = await import("./session-ops.js");

  window.__transcriptGapRepairCount = 0;
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 10,
    transcript_truncated: false,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hello, world th",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  };

  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    base_revision: 9,
    revision: 10,
    item_id: "item-1",
    entry_kind: "agent_text",
    status: "completed",
    text: "Hello, world this is the end.",
    turn_id: "turn-1",
  });

  assert.equal(
    window.__transcriptGapRepairCount,
    1,
    "a rejected completion must schedule authoritative tail repair"
  );
  delete window.__transcriptGapRepairCount;
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

test("applyTranscriptEvent flushes immediately and schedules repair on transcript_stream_lagged", async () => {
  const browser = activeBrowser || installBrowserStubs();

  const { state, subscribeRemoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  flushRemoteTranscriptRenderForTest();

  window.__transcriptGapRepairCount = 0;
  // No responding socket: this test only asserts the gap-repair scheduling and
  // the immediate flush, not the fetch -> converge path (that has its own
  // coverage elsewhere).
  state.socket = null;
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [{
      item_id: "item-1",
      kind: "agent_text",
      status: "running",
      text: "",
      turn_id: "turn-1",
      tool: null,
    }],
  };
  state.realSession = state.session;

  const notifications = [];
  const unsubscribe = subscribeRemoteState((_nextState, patch) => {
    if (patch.session) {
      notifications.push(patch.session);
    }
  });

  applyTranscriptDelta({
    thread_id: "thread-1",
    revision: 2,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "partial",
    delta_kind: "agent_text",
  });
  assert.equal(notifications.length, 0, "the ordinary delta must still coalesce");

  applyTranscriptEvent({
    kind: "transcript_stream_lagged",
    thread_id: "thread-1",
    dropped: 2,
  });

  assert.equal(
    window.__transcriptGapRepairCount,
    1,
    "a lagged stream must schedule an authoritative tail repair"
  );
  assert.equal(notifications.length, 1, "the lagged signal must flush immediately");
  assert.equal(notifications[0].transcript[0].text, "partial");

  browser.runNextTimer();
  assert.equal(
    notifications.length,
    1,
    "the stale coalesced timer must not render a second time"
  );

  unsubscribe();
  delete window.__transcriptGapRepairCount;
});

test("approval events merge against the live session while another thread is viewed", async () => {
  activeBrowser = installBrowserStubs();

  const { state } = await import("./state.js");
  const {
    applySessionSnapshot,
    applyTranscriptEvent,
    clearSessionRuntime,
    viewRemoteThread,
  } = await import("./session-ops.js");

  clearSessionRuntime();
  state.threads = [
    { id: "thread-a", cwd: "/tmp/a", status: "idle" },
    { id: "thread-b", cwd: "/tmp/b", status: "active" },
  ];
  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_cwd: "/tmp/a",
    current_status: "idle",
    pending_approvals: [
      { request_id: "approval-a", thread_id: "thread-a", summary: "A" },
    ],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "a-1", text: "thread A" }],
    transcript_truncated: false,
  });
  assert.equal(await viewRemoteThread("thread-a"), true);
  applySessionSnapshot({
    active_thread_id: "thread-b",
    active_turn_id: "turn-b",
    current_cwd: "/tmp/b",
    current_status: "active",
    pending_approvals: [
      { request_id: "approval-a", thread_id: "thread-a", summary: "A" },
      { request_id: "approval-b1", thread_id: "thread-b", summary: "B1" },
    ],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "b-1", text: "thread B" }],
    transcript_truncated: false,
  });

  applyTranscriptEvent({
    kind: "approval_added",
    approval: {
      request_id: "approval-b2",
      thread_id: "thread-b",
      summary: "B2",
    },
  });

  assert.deepEqual(
    state.realSession.pending_approvals.map((approval) => approval.request_id),
    ["approval-a", "approval-b1", "approval-b2"]
  );
  assert.deepEqual(
    state.session.pending_approvals.map((approval) => approval.request_id),
    ["approval-a"],
    "the projected thread still shows only its own approval"
  );

  applyTranscriptEvent({
    kind: "approval_resolved",
    request_id: "approval-b1",
  });

  assert.deepEqual(
    state.realSession.pending_approvals.map((approval) => approval.request_id),
    ["approval-a", "approval-b2"],
    "resolving one live approval must not drop unrelated approvals"
  );
  assert.deepEqual(
    state.session.pending_approvals.map((approval) => approval.request_id),
    ["approval-a"]
  );
  clearSessionRuntime();
});

test("sendHeartbeat dispatches a heartbeat when the current device holds control", async () => {
  const browser = activeBrowser || installBrowserStubs();

  const sentPayloads = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { clearSessionRuntime, sendHeartbeat } = await import("./session-ops.js");

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
  clearSessionRuntime();
  state.socket = null;
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
      { item_id: "item-1", kind: "agent_text", text: `${"A".repeat(1200)}...`, status: "completed", turn_id: "turn-1", tool: null, content_state: "preview" },
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
      { item_id: "item-1", kind: "agent_text", text: `${"A".repeat(1200)}...`, status: "completed", turn_id: "turn-1", tool: null, content_state: "preview" },
      { item_id: "item-2", kind: "agent_text", text: `${"C".repeat(1200)}...`, status: "completed", turn_id: "turn-1", tool: null, content_state: "preview" },
    ])
  );
  await waitFor(
    () => state.session.transcript.find((entry) => entry.item_id === "item-2")?.text === replyTwo
  );

  assert.equal(state.session.transcript.find((entry) => entry.item_id === "item-2")?.text, replyTwo);
  assert.equal(state.session.transcript_truncated, false);
  assert.equal(fetchCount(), 2, "the new final message triggered exactly one more fetch");
});

test("getRemoteViewedWorkspaceKey changes when only the remembered tree is observed", async () => {
  activeBrowser = installBrowserStubs();
  const { getRemoteViewedWorkspaceKey } = await import("./session-ops.js");
  const { state } = await import("./state.js");
  const previous = state.session;
  try {
    state.session = {
      active_thread_id: "thread-1",
      current_cwd: "/repo",
      thread_workspace_cwd: "/repo",
    };
    const before = getRemoteViewedWorkspaceKey();
    state.session = {
      ...state.session,
      thread_workspace_cwd: "/repo/.worktrees/feature",
    };
    const after = getRemoteViewedWorkspaceKey();
    assert.notEqual(
      after,
      before,
      "an observation-only move must look like a new workspace to an already-open panel"
    );
  } finally {
    state.session = previous;
  }
});

test("projectRemoteViewedSession surfaces the viewed thread's own reviewers, not the global set", async () => {
  activeBrowser = installBrowserStubs();
  const { projectRemoteViewedSession } = await import("./session-ops.js");

  // The live (global) session carries only the ACTIVE thread's reviewer — remote
  // snapshots scope reviewer_threads to the active parent for the broker frame.
  const realSession = {
    active_thread_id: "live-thread",
    reviewer_threads: [
      { reviewer_thread_id: "rev-of-live", parent_thread_id: "live-thread" },
    ],
  };
  // The per-thread read for the VIEWED (non-active) thread carries its own reviewers.
  const currentView = {
    active_thread_id: "viewed-thread",
    thread_state: {
      reviewers: [
        { reviewer_thread_id: "rev-of-viewed", parent_thread_id: "viewed-thread" },
      ],
    },
  };

  const projected = projectRemoteViewedSession(realSession, "viewed-thread", currentView);

  assert.ok(
    (projected.reviewer_threads || []).some(
      (reviewer) => reviewer.reviewer_thread_id === "rev-of-viewed"
    ),
    "view-only projection must surface the viewed thread's own reviewers from thread_state"
  );
});

test("projectRemoteViewedSession keeps the viewed thread's reviewers across re-projection (snapshot/delta)", async () => {
  activeBrowser = installBrowserStubs();
  const { projectRemoteViewedSession } = await import("./session-ops.js");

  const realSession = {
    active_thread_id: "live-thread",
    reviewer_threads: [
      { reviewer_thread_id: "rev-of-live", parent_thread_id: "live-thread" },
    ],
  };

  // 1. Initial view entry: currentView carries thread_state.reviewers (backend).
  const entry = projectRemoteViewedSession(realSession, "viewed-thread", {
    active_thread_id: "viewed-thread",
    thread_state: {
      reviewers: [
        { reviewer_thread_id: "rev-of-viewed", parent_thread_id: "viewed-thread" },
      ],
    },
  });
  assert.ok(
    entry.reviewer_threads.some((r) => r.reviewer_thread_id === "rev-of-viewed"),
    "entry projection populates the viewed thread's reviewers"
  );

  // 2. Next snapshot/delta re-projects with the PREVIOUSLY PROJECTED session as
  // currentView — it has reviewer_threads (no thread_state, no `reviewers` key),
  // exactly like call sites 2/3 (session-ops.js:532, 864).
  const reprojected = projectRemoteViewedSession(realSession, "viewed-thread", entry);
  assert.ok(
    reprojected.reviewer_threads.some((r) => r.reviewer_thread_id === "rev-of-viewed"),
    "re-projection (snapshot/delta) must KEEP the viewed thread's reviewers, not collapse to []"
  );
});

test("projectRemoteViewedSession preserves the viewed thread workflow lock", async () => {
  activeBrowser = installBrowserStubs();
  const { projectRemoteViewedSession } = await import("./session-ops.js");

  const realSession = { active_thread_id: "live-thread" };
  const entry = projectRemoteViewedSession(realSession, "viewed-thread", {
    active_thread_id: "viewed-thread",
    thread_state: {
      workflow_locked: true,
      current_status: "notLoaded",
    },
  });
  assert.equal(entry.workflow_locked, true);

  const reprojected = projectRemoteViewedSession(realSession, "viewed-thread", entry);
  assert.equal(
    reprojected.workflow_locked,
    true,
    "snapshot/delta re-projection should not lose the per-thread workflow lock"
  );
});

test("projectRemoteViewedSession keeps same-second activity authoritative", async () => {
  activeBrowser = installBrowserStubs();
  const { projectRemoteViewedSession } = await import("./session-ops.js");
  const { sessionIsWorking } = await import("../shared/thread-attention.js");

  const projected = projectRemoteViewedSession(
    {
      active_thread_id: "live-thread",
      server_time: 200,
      thread_activity: [{ thread_id: "viewed-thread", phase: "tool", tool: "bash" }],
    },
    "viewed-thread",
    {
      active_thread_id: "viewed-thread",
      view_last_refresh_server_time: 200,
      thread_state: {
        active_turn_id: null,
        current_status: "notLoaded",
      },
    }
  );

  assert.equal(projected.active_turn_id, "view:viewed-thread");
  assert.equal(projected.current_phase, "tool");
  assert.equal(projected.current_tool, "bash");
  assert.equal(sessionIsWorking(projected), true);
});

test("projectRemoteViewedSession keeps activity authoritative without server_time", async () => {
  activeBrowser = installBrowserStubs();
  const { projectRemoteViewedSession } = await import("./session-ops.js");
  const { sessionIsWorking } = await import("../shared/thread-attention.js");

  const projected = projectRemoteViewedSession(
    {
      active_thread_id: "live-thread",
      thread_activity: [{ thread_id: "viewed-thread", phase: "thinking", tool: null }],
    },
    "viewed-thread",
    {
      active_thread_id: "viewed-thread",
      view_last_refresh_server_time: 200,
      thread_state: {
        active_turn_id: null,
        current_status: "notLoaded",
      },
    }
  );

  assert.equal(projected.active_turn_id, "view:viewed-thread");
  assert.equal(sessionIsWorking(projected), true);
});

// A thread being read view-only used to be a POLLED snapshot: the relay streamed
// deltas only for the single globally-active thread, so a phone watching a background
// thread saw text arrive in lumps whenever a refresh happened to land. Now that the
// relay streams every thread this surface declares it is watching, a delta for the
// pinned thread must land in the projection instead of being discarded.
test("a delta for the view-only thread updates the projection, not the live session", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
    viewRemoteThread,
  } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-view-delta",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  state.threads = [
    { id: "thread-a", cwd: "/tmp/a", status: "active" },
    { id: "thread-b", cwd: "/tmp/b", status: "active" },
  ];

  // thread-a is active and gets pinned; then thread-b takes over as the live thread,
  // leaving thread-a as the background thread being read view-only.
  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [
      {
        item_id: "a-1",
        kind: "agent_text",
        status: "running",
        text: "Hello",
        turn_id: "turn-a",
        tool: null,
      },
    ],
    transcript_revision: 1,
    transcript_truncated: false,
  });
  assert.equal(await viewRemoteThread("thread-a"), true);
  applySessionSnapshot({
    active_thread_id: "thread-b",
    active_turn_id: "turn-b",
    current_cwd: "/tmp/b",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "b-1", kind: "agent_text", text: "thread B", turn_id: "turn-b" }],
    transcript_revision: 5,
    transcript_truncated: false,
  });

  assert.equal(state.session.view_only, true, "thread-a must now be a view-only projection");
  assert.equal(state.session.active_thread_id, "thread-a");
  assert.equal(state.realSession.active_thread_id, "thread-b");

  applyTranscriptDelta({
    thread_id: "thread-a",
    base_revision: 1,
    revision: 2,
    item_id: "a-1",
    turn_id: "turn-a",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();
  const viewedEntry = state.session.transcript.find((entry) => entry.item_id === "a-1");
  assert.equal(
    viewedEntry.text,
    "Hello world",
    "the watched background thread's delta must reach the projection"
  );
  // The live session belongs to thread-b. Folding thread-a's text into it would
  // corrupt the transcript the user sees on switching back.
  assert.equal(state.realSession.active_thread_id, "thread-b");
  assert.equal(state.realSession.transcript[0].text, "thread B");

  clearSessionRuntime();
  state.socket = null;
});

// The routing must stay narrow: only the PINNED thread is rescued from the drop. A
// third thread's delta has nowhere to render, and letting it through would splice one
// thread's text into another's transcript.
test("a delta for a thread that is neither live nor pinned is still ignored", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { applySessionSnapshot, applyTranscriptDelta, clearSessionRuntime, viewRemoteThread } =
    await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-view-delta-2",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();
  seedTranscriptHydrationState(state);
  state.threads = [
    { id: "thread-a", cwd: "/tmp/a", status: "active" },
    { id: "thread-b", cwd: "/tmp/b", status: "active" },
  ];

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "Hello", turn_id: "turn-a" }],
    transcript_revision: 1,
    transcript_truncated: false,
  });
  assert.equal(await viewRemoteThread("thread-a"), true);
  applySessionSnapshot({
    active_thread_id: "thread-b",
    active_turn_id: "turn-b",
    current_cwd: "/tmp/b",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "b-1", kind: "agent_text", text: "thread B", turn_id: "turn-b" }],
    transcript_revision: 5,
    transcript_truncated: false,
  });

  const viewedBefore = JSON.stringify(state.session.transcript);
  const liveBefore = JSON.stringify(state.realSession.transcript);

  applyTranscriptDelta({
    thread_id: "thread-c",
    base_revision: 1,
    revision: 2,
    item_id: "c-1",
    turn_id: "turn-c",
    delta: "stray text",
    delta_kind: "agent_text",
    text_offset: 0,
  });

  assert.equal(JSON.stringify(state.session.transcript), viewedBefore, "projection untouched");
  assert.equal(JSON.stringify(state.realSession.transcript), liveBefore, "live session untouched");

  clearSessionRuntime();
  state.socket = null;
});

function seedRemoteViewedTerminalRefreshFixture(state, saveRemoteAuth) {
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-viewed-terminal",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  seedTranscriptHydrationState(state);
  state.threads = [
    { id: "thread-a", cwd: "/tmp/a", status: "active" },
    { id: "thread-b", cwd: "/tmp/b", status: "active" },
  ];
}

function createDeferredTranscriptFetchSocket(handleRemoteBrokerPayload) {
  const pending = [];
  let fetchCount = 0;

  return {
    get fetchCount() {
      return fetchCount;
    },
    socket: {
      readyState: 1,
      send(frameText) {
        const frame = JSON.parse(frameText);
        if (frame.payload.request?.type !== "fetch_thread_transcript") {
          return;
        }
        fetchCount += 1;
        const threadId = frame.payload.request.input.thread_id;
        pending.push(() => {
          void handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "fetch_thread_transcript",
            ok: true,
            snapshot: {},
            thread_transcript: {
              thread_id: threadId,
              entries: [
                {
                  item_id: `${threadId}-1`,
                  kind: "agent_text",
                  text: "viewed tail",
                  status: "running",
                  turn_id: `turn-${threadId}`,
                  tool: null,
                },
              ],
              prev_cursor: null,
              revision: fetchCount,
            },
          });
        });
      },
    },
    completeNext() {
      const resolve = pending.shift();
      assert.ok(resolve, "expected a pending viewed-thread transcript fetch");
      resolve();
    },
  };
}

test("maybeRefreshRemoteViewedThread triggers viewRemoteThread when background thread_activity clears", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, clearSessionRuntime, viewRemoteThread } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteViewedTerminalRefreshFixture(state, saveRemoteAuth);
  const transcriptFetch = createDeferredTranscriptFetchSocket(handleRemoteBrokerPayload);
  state.socket = transcriptFetch.socket;
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 1,
    transcript_truncated: false,
  });

  const initialView = viewRemoteThread("thread-b");
  await nextTick();
  transcriptFetch.completeNext();
  assert.equal(await initialView, true);
  await nextTick();
  assert.equal(transcriptFetch.fetchCount, 1, "initial view must fetch the background thread");

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [{ thread_id: "thread-b", phase: "thinking", tool: null }],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 2,
    transcript_truncated: false,
  });

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 3,
    transcript_truncated: false,
  });

  await waitFor(() => transcriptFetch.fetchCount >= 2);
  assert.equal(
    transcriptFetch.fetchCount,
    2,
    "maybeRefreshRemoteViewedThread must refetch when the viewed background thread stops working"
  );

  transcriptFetch.completeNext();
  await nextTick();
  await nextTick();
  assert.equal(
    transcriptFetch.fetchCount,
    2,
    "completing the terminal refresh must not immediately retrigger another fetch"
  );

  clearSessionRuntime();
  state.socket = null;
});

test("viewOnlyWasWorking seeds from the viewed thread thread_activity, not the live active_turn_id", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, clearSessionRuntime, viewRemoteThread } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteViewedTerminalRefreshFixture(state, saveRemoteAuth);
  const transcriptFetch = createDeferredTranscriptFetchSocket(handleRemoteBrokerPayload);
  state.socket = transcriptFetch.socket;
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_cwd: "/tmp/a",
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [{ thread_id: "thread-b", phase: "tool", tool: "bash" }],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 1,
    transcript_truncated: false,
  });

  const initialView = viewRemoteThread("thread-b");
  await nextTick();
  transcriptFetch.completeNext();
  assert.equal(await initialView, true);
  await nextTick();

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_cwd: "/tmp/a",
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 2,
    transcript_truncated: false,
  });

  await waitFor(() => transcriptFetch.fetchCount >= 2);
  assert.equal(
    transcriptFetch.fetchCount,
    2,
    "a viewed background thread that was already working at view time must still get a terminal refresh"
  );

  clearSessionRuntime();
  state.socket = null;
});

test("a delta during an in-flight terminal viewRemoteThread preserves wasWorking and re-arms refresh", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    clearSessionRuntime,
    viewRemoteThread,
  } = await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteViewedTerminalRefreshFixture(state, saveRemoteAuth);
  const transcriptFetch = createDeferredTranscriptFetchSocket(handleRemoteBrokerPayload);
  state.socket = transcriptFetch.socket;
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 1,
    transcript_truncated: false,
  });

  const initialView = viewRemoteThread("thread-b");
  await nextTick();
  transcriptFetch.completeNext();
  assert.equal(await initialView, true);
  await nextTick();
  assert.equal(transcriptFetch.fetchCount, 1);

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [{ thread_id: "thread-b", phase: "thinking", tool: null }],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 2,
    transcript_truncated: false,
  });

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 3,
    transcript_truncated: false,
  });
  await nextTick();
  assert.equal(transcriptFetch.fetchCount, 2, "working→idle must start a terminal refresh");

  applyTranscriptDelta({
    thread_id: "thread-b",
    base_revision: 1,
    revision: 4,
    item_id: "b-1",
    turn_id: "turn-b",
    delta: "still going",
    delta_kind: "agent_text",
    text_offset: 0,
  });

  transcriptFetch.completeNext();
  await nextTick();

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: "turn-a",
    current_cwd: "/tmp/a",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    thread_activity: [],
    transcript: [{ item_id: "a-1", kind: "agent_text", text: "live A", turn_id: "turn-a" }],
    transcript_revision: 5,
    transcript_truncated: false,
  });

  await waitFor(() => transcriptFetch.fetchCount >= 3);
  assert.equal(
    transcriptFetch.fetchCount,
    3,
    "a delta during terminal refresh must preserve wasWorking for the next working→idle edge"
  );

  clearSessionRuntime();
  state.socket = null;
});

// `applySessionSnapshot` ended with a TODO-marked debug line, and building that line
// read `scrollTop` / `scrollHeight` / `clientHeight` off the live transcript element.
// Reading `scrollHeight` forces a synchronous layout of the whole transcript subtree,
// and the `renderLog` that followed is a `patchRemoteState` — a full RemoteApp
// re-render. Both were paid on EVERY snapshot, including the identical idle snapshots
// a relay repeats for a thread this surface is not even displaying (a real trace showed
// `status=idle turn=- entries=3` arriving over and over with byte-identical geometry).
test("applying a snapshot does not force a layout just to build a debug line", async () => {
  installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { applySessionSnapshot } = await import("./session-ops.js");
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  seedTranscriptHydrationState(state);

  const geometryReads = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  setRemoteTranscriptElement({
    get scrollTop() {
      geometryReads.scrollTop += 1;
      return 0;
    },
    get scrollHeight() {
      geometryReads.scrollHeight += 1;
      return 1000;
    },
    get clientHeight() {
      geometryReads.clientHeight += 1;
      return 500;
    },
    addEventListener() {},
    removeEventListener() {},
  });

  try {
    applySessionSnapshot({
      active_thread_id: "thread-a",
      current_status: "idle",
      active_turn_id: null,
      transcript: [],
      transcript_truncated: false,
      transcript_revision: 1,
      revision: 1,
    });
  } finally {
    setRemoteTranscriptElement(null);
  }

  assert.equal(
    geometryReads.scrollHeight,
    0,
    "reading scrollHeight forces a synchronous layout of the whole transcript; a "
      + "debug string is not worth one on every snapshot"
  );
});

// The companion to the suppression above: the geometry read and the trace must both
// come back when someone is actually debugging snapshot scroll restoration.
test("verbose broker logging restores the snapshot scroll trace", async () => {
  installBrowserStubs();
  globalThis.window.__agentRelayVerboseBrokerLogs = true;

  const { state, saveRemoteAuth } = await import("./state.js");
  const { applySessionSnapshot } = await import("./session-ops.js");
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  seedTranscriptHydrationState(state);

  let scrollHeightReads = 0;
  setRemoteTranscriptElement({
    get scrollTop() { return 0; },
    get scrollHeight() {
      scrollHeightReads += 1;
      return 1000;
    },
    get clientHeight() { return 500; },
    addEventListener() {},
    removeEventListener() {},
  });

  try {
    applySessionSnapshot({
      active_thread_id: "thread-a",
      current_status: "idle",
      active_turn_id: null,
      transcript: [],
      transcript_truncated: false,
      transcript_revision: 1,
      revision: 1,
    });
  } finally {
    setRemoteTranscriptElement(null);
    delete globalThis.window.__agentRelayVerboseBrokerLogs;
  }

  assert.equal(
    scrollHeightReads,
    1,
    "with the flag on the trace must come back — otherwise the gate is a delete"
  );
});

// -- Sub-task: remote deltas write the hydration window ----------------------
//
// applyTranscriptDelta now adopts local's structure: when the hydration
// window is loaded for a delta's OWN thread, the delta writes into it in
// O(1) and the array projection is deferred to settle (once per flush).
// Every OTHER place that reads or rewrites either state.realSession.transcript
// or state.session.transcript must settle first, or a pending append is
// either dropped (an interleaved read/rewrite reads the stale array and its
// own rebuild — a patch, a snapshot merge — has no idea the window moved on)
// or wrongly reverted (a later settle rebuilds purely from the window, which
// never learned about that interleaved write). One test per boundary below.

// Shared setup for the pin-related boundary tests: thread-b starts live and
// gets pinned view-only, then the relay moves the live thread on to
// thread-a — the shape every one of those tests needs (a background pin with
// its own loaded window, distinct from the live thread's).
async function pinBackgroundThreadWithWindow() {
  const { state } = await import("./state.js");
  const { applySessionSnapshot, clearSessionRuntime, viewRemoteThread } =
    await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-b",
    transcript_revision: 1,
    transcript: [
      { item_id: "b-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-b", tool: null },
    ],
  };
  state.socket = null;

  assert.equal(await viewRemoteThread("thread-b"), true, "precondition: pin thread-b while it is live");

  applySessionSnapshot({
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 1,
    transcript: [
      { item_id: "a-1", kind: "agent_text", status: "running", text: "Live", turn_id: "turn-a", tool: null },
    ],
  });

  assert.equal(state.realSession.active_thread_id, "thread-a", "precondition: the live thread moved on");
  assert.equal(state.session.active_thread_id, "thread-b", "precondition: thread-b stays pinned");
  assert.equal(state.session.view_only, true, "precondition: thread-b renders as a view-only projection");

  // The hydration window follows the PIN (the pinned-thread trade-off —
  // .sealwire/PLAN.md) — set up directly here rather than depending on a
  // real fetch to populate it.
  state.transcriptHydrationThreadId = "thread-b";
  state.transcriptHydrationEntries = new Map([["b-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["b-1"];

  return { state };
}

test("applySessionSnapshot settles before merging — a pending delta and a snapshot-introduced entry both survive", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applySessionSnapshot,
    applyTranscriptDelta,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([["item-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["item-1"];

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // Still deferred — nothing has settled yet.
  assert.equal(state.realSession.transcript[0].text, "Hello");

  // An ordinary snapshot arrives: a compacted preview for item-1 (shorter
  // than what the pending delta is about to grow it to) plus a BRAND NEW
  // entry the window has never seen. Settling must happen BEFORE this merge
  // runs, or a later settle (which rebuilds the array purely from the
  // window) would discard item-2 entirely once the pending delta above is
  // materialised.
  applySessionSnapshot({
    active_thread_id: "thread-1",
    active_turn_id: null,
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 2,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: "Hel",
        content_state: "preview",
        turn_id: "turn-1",
        tool: null,
      },
      {
        item_id: "item-2",
        kind: "agent_text",
        status: "completed",
        text: "a brand new entry",
        turn_id: "turn-1",
        tool: null,
      },
    ],
  });

  flushRemoteTranscriptRenderForTest();

  const ids = state.session.transcript.map((entry) => entry.item_id);
  assert.ok(ids.includes("item-2"), "the snapshot's brand-new entry must not disappear when the pending delta settles");
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "item-1")?.text,
    "Hello world",
    "the pending delta's text must survive the snapshot's compacted preview"
  );
});

test("repairActiveTranscriptTail resyncs the loaded window to the repaired text instead of leaving a stale trusted copy", async () => {
  activeBrowser = installBrowserStubs();
  const sentPayloads = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, applyTranscriptDelta, clearSessionRuntime } =
    await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-repair-window",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  });
  // A small (non-truncated) snapshot does not itself load the hydration
  // window — hydration is gated on transcript_truncated (see
  // .sealwire/PLAN.md). Load it directly so this test exercises the "window
  // loaded for this thread" precondition repairActiveTranscriptTail must
  // invalidate.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["item-1", { ...state.session.transcript[0], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["item-1"];

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
            revision: 8,
            entries: [
              { item_id: "item-1", kind: "agent_text", text: "Hello world", status: "completed", turn_id: "turn-1", tool: null },
            ],
            prev_cursor: null,
          },
        });
      });
    },
  };

  // A genuine offset gap — beyond what either the array or the window holds
  // — forces repairActiveTranscriptTail.
  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!!",
    delta_kind: "agent_text",
    text_offset: 99,
  });

  await waitFor(() => state.realSession?.transcript?.[0]?.text === "Hello world");
  assert.equal(sentPayloads.length, 1);
  // The item IS covered by the repaired page, so its window copy must be
  // resynced to the repaired text and re-marked full — not merely downgraded
  // to preview while still holding the pre-repair, now-wrong-length text (a
  // stale copy there would falsely fail the NEXT delta's offset check; see
  // "a delta immediately after a tail repair..." below).
  assert.equal(
    state.transcriptHydrationEntries.get("item-1")?.text,
    "Hello world",
    "the window's cached copy must be resynced to the just-repaired text, not left holding the pre-repair body"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("item-1")?.content_state,
    "full",
    "content covered by the repair is authoritative — the same as any hydration/snapshot merge"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("item-1")?.status,
    "completed",
    "the repaired entry's own fields (status, etc.) must land in the window too, not just its text"
  );

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

// Regression for the shared authoritative-tail-merge primitive
// (shared/authoritative-tail-merge.js): repairActiveTranscriptTail's merge is
// now delegated to it end to end, replacing the old hand-rolled
// olderKept/repairedTail block. This proves three of the primitive's
// invariants actually reach `state.realSession.transcript` through that
// seam, not just an internal patch:
//   - an entry AFTER the page's intersection point stays after it — the old
//     merge put every non-page entry first regardless of which side it was on;
//   - a shorter authoritative page body never shortens already-visible text;
//   - an entry with no item_id (Remote's array alone can hold these; they are
//     not addressable) keeps its original relative position instead of being
//     dropped by the id-keyed merge.
test("repairActiveTranscriptTail's order/never-shorten/positionless invariants reach the rendered transcript", async () => {
  activeBrowser = installBrowserStubs();
  const sentPayloads = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, applyTranscriptDelta, clearSessionRuntime } =
    await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-repair-order-flip",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-order-flip" });
  state.pendingActions.clear();
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-order-flip",
    active_turn_id: "turn-1",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      { item_id: "item-before", kind: "agent_text", status: "completed", text: "Before", turn_id: "turn-0", tool: null },
      // No item_id — not addressable by id, and must keep its place.
      { kind: "system_notice", text: "connection restored" },
      {
        item_id: "item-shared",
        kind: "agent_text",
        status: "running",
        text: "Hello world, the full streamed message",
        turn_id: "turn-1",
        tool: null,
      },
      { item_id: "item-after", kind: "agent_text", status: "completed", text: "After", turn_id: "turn-2", tool: null },
    ],
  });
  state.transcriptHydrationThreadId = "thread-order-flip";
  state.transcriptHydrationEntries = new Map([
    ["item-before", { ...state.session.transcript[0], content_state: "full" }],
    ["item-shared", { ...state.session.transcript[2], content_state: "full" }],
    ["item-after", { ...state.session.transcript[3], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["item-before", "item-shared", "item-after"];

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
            thread_id: "thread-order-flip",
            revision: 8,
            // Only refreshes item-shared, with a body SHORTER than what is
            // already visible — never-shorten must keep the longer one.
            entries: [
              { item_id: "item-shared", kind: "agent_text", text: "Hello", status: "completed", turn_id: "turn-1", tool: null },
            ],
            prev_cursor: null,
          },
        });
      });
    },
  };

  // A genuine offset gap forces the tail repair.
  applyTranscriptDelta({
    thread_id: "thread-order-flip",
    item_id: "item-shared",
    turn_id: "turn-1",
    delta: "!!",
    delta_kind: "agent_text",
    text_offset: 999,
  });

  await waitFor(() =>
    state.realSession?.transcript?.find((entry) => entry.item_id === "item-shared")?.status === "completed"
  );
  assert.equal(sentPayloads.length, 1);

  assert.deepEqual(
    state.realSession.transcript.map((entry) => entry.item_id || entry.kind),
    ["item-before", "system_notice", "item-shared", "item-after"],
    "item-after must stay AFTER the repaired entry, and the id-less entry must keep its original position"
  );
  assert.equal(
    state.realSession.transcript.find((entry) => entry.item_id === "item-shared")?.text,
    "Hello world, the full streamed message",
    "a shorter authoritative page body must not shorten already-visible text"
  );

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

// The resync above must not become a blanket "trust everything again": an
// item the bounded repair page does NOT reach (still tracked in the window
// from before, e.g. retained older history) has nothing authoritative to
// resync from, so it must stay invalidated — the original safety net
// invalidateTranscriptWindowForRepair provides.
test("repairActiveTranscriptTail still invalidates a window entry the repair page does not cover", async () => {
  activeBrowser = installBrowserStubs();
  const sentPayloads = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, applyTranscriptDelta, clearSessionRuntime } =
    await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-repair-partial-coverage",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-partial" });
  state.pendingActions.clear();
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-partial-coverage",
    active_turn_id: "turn-1",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      { item_id: "item-older", kind: "agent_text", status: "completed", text: "Older", turn_id: "turn-0", tool: null },
      { item_id: "item-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  });
  state.transcriptHydrationThreadId = "thread-partial-coverage";
  state.transcriptHydrationEntries = new Map([
    ["item-older", { ...state.session.transcript[0], content_state: "full" }],
    ["item-1", { ...state.session.transcript[1], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["item-older", "item-1"];

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
            thread_id: "thread-partial-coverage",
            revision: 8,
            // The bounded tail page reaches only item-1 — item-older is
            // outside its window and keeps its place in the array untouched.
            entries: [
              { item_id: "item-1", kind: "agent_text", text: "Hello world", status: "completed", turn_id: "turn-1", tool: null },
            ],
            prev_cursor: "cursor-before-item-older",
          },
        });
      });
    },
  };

  applyTranscriptDelta({
    thread_id: "thread-partial-coverage",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!!",
    delta_kind: "agent_text",
    text_offset: 99,
  });

  await waitFor(() => state.realSession?.transcript?.find((e) => e.item_id === "item-1")?.text === "Hello world");
  assert.equal(sentPayloads.length, 1);
  assert.equal(
    state.transcriptHydrationEntries.get("item-1")?.content_state,
    "full",
    "the repaired item resyncs to full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("item-older")?.content_state,
    "preview",
    "an item outside the repair page's coverage must still be invalidated, not left trusted"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("item-older")?.text,
    "Older",
    "invalidation for an uncovered item still only downgrades content_state, matching the lagged-stream case — there is nothing authoritative to resync it FROM"
  );

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

// P1 (review): repairActiveTranscriptTail only downgraded the window's cached
// content_state after a repair; it left the STALE (pre-repair) text in place
// and the window stayed "loaded". The very next delta's offset check
// (applyTranscriptDelta, session-ops.js) reads that stale, now-too-short text
// as `have` — even though the array was JUST corrected to the true, longer
// authoritative text by the repair that ran a moment ago. A delta that is
// perfectly valid against the repaired array was therefore wrongly reported
// as ANOTHER offset_gap, forcing a second, unnecessary repair round-trip.
test("a delta immediately after a tail repair is checked against the REPAIRED text, not the pre-repair stale window copy", async () => {
  activeBrowser = installBrowserStubs();
  const sentPayloads = [];
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, applyTranscriptDelta, clearSessionRuntime, flushRemoteTranscriptRenderForTest } =
    await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-repair-window-2",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-2" });
  state.pendingActions.clear();
  remoteQueryClient.clear();

  applySessionSnapshot({
    active_thread_id: "thread-repair-followup",
    active_turn_id: "turn-1",
    current_status: "active",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 5,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  });
  state.transcriptHydrationThreadId = "thread-repair-followup";
  state.transcriptHydrationEntries = new Map([
    ["item-1", { ...state.session.transcript[0], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["item-1"];

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
            thread_id: "thread-repair-followup",
            revision: 8,
            entries: [
              { item_id: "item-1", kind: "agent_text", text: "Hello world", status: "running", turn_id: "turn-1", tool: null },
            ],
            prev_cursor: null,
          },
        });
      });
    },
  };

  // A genuine offset gap forces the tail repair.
  applyTranscriptDelta({
    thread_id: "thread-repair-followup",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!!",
    delta_kind: "agent_text",
    text_offset: 99,
  });

  await waitFor(() => state.realSession?.transcript?.[0]?.text === "Hello world");
  assert.equal(sentPayloads.length, 1, "the first delta's gap must trigger exactly one repair fetch");

  // A delta that is perfectly valid against the JUST-REPAIRED array (11
  // chars, "Hello world") must be accepted immediately, not treated as a
  // second gap.
  applyTranscriptDelta({
    thread_id: "thread-repair-followup",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!!",
    delta_kind: "agent_text",
    text_offset: 11,
  });
  flushRemoteTranscriptRenderForTest();

  assert.equal(
    sentPayloads.length,
    1,
    "a delta valid against the repaired array must not trigger a second repair fetch"
  );
  assert.equal(state.session.transcript[0].text, "Hello world!!");

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

test("applyTranscriptEntryPatch invalidates the window entry, not just the array — the patch survives a later delta re-arming the pending projection", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    applyTranscriptEvent,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-1", tool: null },
      { item_id: "item-2", kind: "agent_text", status: "running", text: "", turn_id: "turn-2", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["item-1", { ...state.session.transcript[0] }],
    ["item-2", { ...state.session.transcript[1] }],
  ]);
  state.transcriptHydrationOrder = ["item-1", "item-2"];

  // A delta arrives for item-1 (window-loaded, deferred).
  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  // A completion patch lands for item-2, BEFORE the delta above ever
  // flushes.
  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    item_id: "item-2",
    entry_kind: "agent_text",
    text: "done",
    turn_id: "turn-2",
    revision: 2,
  });

  // A SECOND delta for item-1 re-arms the pending projection the patch's own
  // settle-before-read already cleared once — if the patch's item-2 entry
  // were left "full" in the window, the eventual settle (rebuilding the
  // array purely from the window, falling back to the array only for
  // invalidated/absent entries) would revert it here.
  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!",
    delta_kind: "agent_text",
    text_offset: 11,
  });

  flushRemoteTranscriptRenderForTest();

  assert.equal(state.session.transcript.find((entry) => entry.item_id === "item-1")?.text, "Hello world!");
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "item-2")?.text,
    "done",
    "the patch must survive the later delta re-arming the window projection — the invalidated window entry must fall back to the array, not to its own stale copy"
  );
  assert.equal(state.session.transcript.find((entry) => entry.item_id === "item-2")?.status, "completed");
});

// P1: a completion patch introducing an item the loaded window has never
// tracked used to write ONLY the array. The very next delta for a DIFFERENT,
// already window-tracked item re-arms the deferred projection, and settling
// it rebuilds the array purely from the window (settleTranscriptProjection)
// — which never heard of the patched item, so it silently vanished.
// P1 (review): this test used to assert the window absorbed a patch-introduced
// item directly ("the window must pick up the new item directly, not just
// the array") — but a patch carries no content_state field at all, so that
// absorption defaults the missing field to "full" via contentStateOf, which
// is safe only by accident when (as here) the patch happens to carry real
// text. A status-only completion with no body poisons the window with an
// empty-but-"full" entry, permanently suppressing the real fetch. Inverted
// per .sealwire/PLAN.md, "Invalidate; do not write" -> "Invalidate and
// refetch instead of merging a patch-derived session": the window must no
// longer learn about a patch-introduced item at all; the array fallback
// (renderedTranscriptFromWindow) is what keeps it visible and survives a
// later settle.
test("a completion patch for an item a LOADED window has never seen stays array-only, and still survives a later delta's settle", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const { applyTranscriptDelta, applyTranscriptEvent, clearSessionRuntime, flushRemoteTranscriptRenderForTest } =
    await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    // The window is only ever loaded because an earlier snapshot already
    // said this thread was truncated — true in practice for as long as the
    // window stays loaded, since the relay's own truncation flag never
    // clears once a thread's real history exceeds the budget.
    transcript_truncated: true,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "completed", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["item-1", { ...state.session.transcript[0], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["item-1"];

  // A completion patch introduces item-2, which the window has never tracked.
  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    item_id: "item-2",
    entry_kind: "agent_text",
    text: "brand new",
    turn_id: "turn-2",
    revision: 2,
  });

  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "item-2"),
    "the new entry must still be visible right away"
  );
  assert.ok(
    !state.transcriptHydrationOrder.includes("item-2"),
    "a patch must never teach the window about a new item directly — only a real hydration/snapshot merge may"
  );

  // A delta for item-1 (already window-tracked) re-arms the deferred
  // projection; flushing settles it by rebuilding the array purely from the
  // window. Before the fix, item-2 was never in the window, so this step
  // silently dropped it.
  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  flushRemoteTranscriptRenderForTest();

  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "item-2"),
    "the patch-introduced item must survive a later delta's settle, not just the first render"
  );
});

// P1 (review): a status-only completion for an item the window has NEVER
// tracked — no text at all, unlike the "brand new" text in the test above.
// Before the fix, hydrateActiveTranscript(nextSession) fed this item's
// fabricated array entry (content_state undefined -> "full" via
// contentStateOf) straight into the window, poisoning it with an
// empty-but-"full" entry that permanently suppresses ever fetching the real
// body (see .sealwire/PLAN.md, "Invalidate; do not write" -> "Never route
// non-authoritative data through the authoritative path").
test("a status-only completion for an item a LOADED window has never seen must not poison the window with a full-but-empty entry", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const { applyTranscriptEvent, clearSessionRuntime } = await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript_truncated: true,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "completed", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["item-1", { ...state.session.transcript[0], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["item-1"];

  // A status-only completion for a NEW item, never delta-streamed and
  // carrying no body of its own — the real text, if any, lives only server-side.
  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    item_id: "item-2",
    entry_kind: "agent_text",
    turn_id: "turn-2",
    revision: 2,
  });

  const windowEntry = state.transcriptHydrationEntries.get("item-2");
  assert.ok(
    !windowEntry || windowEntry.content_state !== "full",
    "a status-only patch must never poison the window with a 'full' entry that has no real body"
  );
  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "item-2"),
    "the new entry must still be visible right away via the array"
  );
});

// P1: applyTranscriptEntryPatch merged patchedEntry into the window with
// content_state forced to "full" unconditionally — including for a
// status-only completion (no text field at all). For an item whose real body
// was never delivered (still "omitted"/"preview" in the window), that forced
// promotion tells snapshotTailNeedsFullText the body is already authoritative,
// so a subsequent snapshot describing the same item as non-full never
// re-arms hydration — the real body is never fetched.
test("a status-only completion patch must not promote an omitted window entry to 'full' — hydration must still be able to fetch the real body", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const { applyTranscriptEvent, clearSessionRuntime } = await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: null, turn_id: "turn-1", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    [
      "item-1",
      {
        item_id: "item-1",
        kind: "agent_text",
        status: "running",
        text: null,
        turn_id: "turn-1",
        tool: null,
        content_state: "omitted",
      },
    ],
  ]);
  state.transcriptHydrationOrder = ["item-1"];

  // A completion event carrying no body text — the true final text was
  // never streamed as a delta and still lives only on the server.
  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    item_id: "item-1",
    entry_kind: "agent_text",
    turn_id: "turn-1",
    revision: 2,
  });

  assert.equal(
    state.transcriptHydrationEntries.get("item-1")?.content_state,
    "omitted",
    "a status-only patch must never promote the cached body to full — it does not own a body"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "item-1")?.status,
    "completed",
    "the status change itself must still be visible immediately, independent of the content_state fix"
  );
});

// P1: applyTranscriptEntryPatch wrote unconditionally into the window
// whenever transcriptHydrationThreadId was set, with no check that the
// window actually held anything yet. A patch landing while hydration was
// merely ARMED for this thread (order still empty) therefore created a
// one-entry "loaded" window — transcriptWindowIsLoaded starts returning true
// off that single patched item — and the very next delta for a DIFFERENT,
// already-visible item rebuilds the array purely from that one-entry window,
// silently dropping every other row on screen.
test("a completion patch before hydration has loaded anything must not turn an empty window into a one-entry one", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const { applyTranscriptDelta, applyTranscriptEvent, clearSessionRuntime, flushRemoteTranscriptRenderForTest } =
    await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: "", turn_id: "turn-1", tool: null },
      { item_id: "item-2", kind: "agent_text", status: "running", text: "", turn_id: "turn-2", tool: null },
      { item_id: "item-3", kind: "agent_text", status: "running", text: "", turn_id: "turn-3", tool: null },
    ],
  };
  state.socket = null;
  // Hydration has been armed for this thread but nothing has landed yet.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationOrder = [];

  applyTranscriptEvent({
    kind: "transcript_entry_completed",
    thread_id: "thread-1",
    item_id: "item-3",
    entry_kind: "agent_text",
    text: "done",
    turn_id: "turn-3",
    revision: 2,
  });

  assert.equal(
    state.transcriptHydrationOrder.length,
    0,
    "a patch alone must never be the thing that makes an unhydrated window look loaded"
  );

  // A delta for a DIFFERENT item, still visible in the array — if the patch
  // above had wrongly loaded the window, this would settle the array down to
  // just the window's one entry.
  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "X",
    delta_kind: "agent_text",
    text_offset: 0,
  });
  flushRemoteTranscriptRenderForTest();

  const rendered = state.session.transcript;
  assert.equal(rendered.length, 3, "item-2 must not have been dropped by a window the patch alone should never have loaded");
  assert.ok(rendered.some((entry) => entry.item_id === "item-2"));
});

test("commitLiveSession settles before publishing a re-projection for a pinned background thread", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await pinBackgroundThreadWithWindow();
  const { applyTranscriptDelta, applyTranscriptEvent } = await import("./session-ops.js");

  // A delta lands for the PINNED (viewed) thread — window-loaded, deferred.
  applyTranscriptDelta({
    thread_id: "thread-b",
    item_id: "b-1",
    turn_id: "turn-b",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(state.session.transcript[0].text, "Hello", "still deferred");

  // An approval event for the LIVE thread (thread-a) commits via
  // commitLiveSession, which re-derives state.session (the pinned
  // projection) via projectRemoteViewedSession — reading state.session's own
  // transcript. It must settle first, or that read is the stale one above.
  applyTranscriptEvent({
    kind: "approval_added",
    approval: { request_id: "approval-1", summary: "Run a thing" },
  });

  assert.equal(
    state.session.transcript[0].text,
    "Hello world",
    "the pinned thread's pending delta must be visible once the live thread's own event re-publishes the projection"
  );
  assert.equal(state.session.active_thread_id, "thread-b", "the projection is still for the pinned thread");
});

test("applyRenderedSession settles before rendering — reached here via viewRemoteThread's fetch-free (already-live) branch", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const { applyTranscriptDelta, clearSessionRuntime, viewRemoteThread } =
    await import("./session-ops.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-b",
    transcript_revision: 1,
    transcript: [
      { item_id: "b-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-b", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-b";
  state.transcriptHydrationEntries = new Map([["b-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["b-1"];

  applyTranscriptDelta({
    thread_id: "thread-b",
    item_id: "b-1",
    turn_id: "turn-b",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(state.session.transcript[0].text, "Hello", "still deferred");

  // Pinning the thread that is ALREADY live takes viewRemoteThread's
  // fetch-free branch, which renders via applyRenderedSession(state.realSession)
  // directly and synchronously — no scheduler flush runs first.
  assert.equal(await viewRemoteThread("thread-b"), true);

  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "b-1")?.text,
    "Hello world",
    "the render must show the settled text, not the pre-projection array"
  );
});

test("invalidateViewOnlyNavigation discards a pending projection for the abandoned pin instead of stranding it", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await pinBackgroundThreadWithWindow();
  const { applyTranscriptDelta, resumeRemoteSession, applyTranscriptEvent } =
    await import("./session-ops.js");

  // A delta lands for the pinned thread-b — window-loaded, deferred.
  applyTranscriptDelta({
    thread_id: "thread-b",
    item_id: "b-1",
    turn_id: "turn-b",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(state.session.transcript[0].text, "Hello", "still deferred");

  // Resuming a (different) session is an explicit live action: it abandons
  // the view-only pin via invalidateViewOnlyNavigation. dispatchOrRecover has
  // no real transport here and will fail — that is fine, the invalidation
  // itself runs synchronously before the dispatch.
  await resumeRemoteSession("thread-c").catch(() => {});

  // The live thread (thread-a) gets an unrelated event next. If the
  // abandoned pin's pending projection had been left stranded rather than
  // discarded, thread-b's window content could still leak onto whatever
  // session is current the next time something settles.
  applyTranscriptEvent({
    kind: "approval_added",
    approval: { request_id: "approval-1", summary: "Run a thing" },
  });

  assert.equal(state.realSession.active_thread_id, "thread-a", "the live thread is unaffected by the abandoned pin");
  assert.equal(
    state.realSession.transcript.find((entry) => entry.item_id === "b-1"),
    undefined,
    "the abandoned pin's thread-b content must never leak onto the live thread's transcript"
  );
});

test("clearSessionRuntime discards a pending projection explicitly", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await pinBackgroundThreadWithWindow();
  const { applyTranscriptDelta, clearSessionRuntime, applySessionSnapshot } =
    await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-b",
    item_id: "b-1",
    turn_id: "turn-b",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(state.session.transcript[0].text, "Hello", "still deferred");

  clearSessionRuntime();
  state.socket = null;

  assert.equal(state.realSession, null, "a genuine reset clears the live session");

  // A brand-new session for a thread that happens to reuse the same id must
  // not be corrupted by whatever was pending before the reset.
  applySessionSnapshot({
    active_thread_id: "thread-b",
    active_turn_id: null,
    current_status: "idle",
    pending_approvals: [],
    pending_ask_user_questions: [],
    transcript_truncated: false,
    transcript_revision: 1,
    transcript: [
      { item_id: "b-1", kind: "agent_text", status: "completed", text: "brand new session", turn_id: "turn-new", tool: null },
    ],
  });

  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "b-1")?.text,
    "brand new session",
    "the reset must leave nothing pending that could clobber the next session for the same thread id"
  );
});

test("mergeTranscriptHydrationPage does not double-apply a delta that is already pending settlement", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    clearSessionRuntime,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");
  const { mergeTranscriptHydrationPage } = await import("./transcript/store.js");

  clearSessionRuntime();
  state.realSession = state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 1,
    transcript: [
      { item_id: "item-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-1", tool: null },
    ],
  };
  state.socket = null;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([["item-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["item-1"];

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // Window already has the fresh text; the array is still deferred.
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello world");

  // An older-history page merges into the SAME window while the delta above
  // is still pending settlement. It must not see the delta's text twice, and
  // it must not disturb what the delta already wrote.
  mergeTranscriptHydrationPage(state, {
    thread_id: "thread-1",
    entries: [
      { item_id: "item-0", kind: "user_text", status: "completed", text: "an older message", turn_id: "turn-0", tool: null },
    ],
    prev_cursor: null,
  }, { prepend: true });

  assert.equal(
    state.transcriptHydrationEntries.get("item-1").text,
    "Hello world",
    "merging an older page must not touch or duplicate an unrelated item's pending text"
  );
  assert.deepEqual(state.transcriptHydrationOrder, ["item-0", "item-1"]);

  flushRemoteTranscriptRenderForTest();

  assert.deepEqual(
    state.session.transcript.map((entry) => ({ id: entry.item_id, text: entry.text })),
    [
      { id: "item-0", text: "an older message" },
      { id: "item-1", text: "Hello world" },
    ]
  );
});

test("pinning a background thread mid-stream still lands live-thread deltas correctly via the array fallback", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await pinBackgroundThreadWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  // The window follows the pin (thread-b), so the LIVE thread (thread-a) is
  // NOT window-loaded — "the rule": write the window only when it matches
  // the delta's own thread, otherwise the array fallback.
  applyTranscriptDelta({
    thread_id: "thread-a",
    item_id: "a-1",
    turn_id: "turn-a",
    delta: " stream",
    delta_kind: "agent_text",
    text_offset: 4,
  });

  // The array fallback is synchronous — no flush needed for the live
  // session, and thread-b's pinned projection must be completely unaffected.
  assert.equal(state.realSession.transcript.find((entry) => entry.item_id === "a-1")?.text, "Live stream");
  assert.equal(state.session.transcript.find((entry) => entry.item_id === "b-1")?.text, "Hello");

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.realSession.transcript.find((entry) => entry.item_id === "a-1")?.text, "Live stream");
});

// REVIEW P1: viewRemoteThread's fetch path switches the hydration window to
// the newly-pinned thread BEFORE settling whatever was still pending for the
// thread the window is LEAVING. A pre-pin live delta's window write then
// becomes unreachable — settleTranscriptProjection can only ever rebuild
// whichever session matches the window's CURRENT thread, and that is now the
// pinned one, not the live thread the delta was actually for. The live
// array is left stale, so the very next live delta's text_offset reads as a
// gap against it and gets dropped pending repair instead of applied.
test("viewRemoteThread settles the outgoing live window before switching hydration threads, so live deltas both before and after the pin still land", async () => {
  activeBrowser = installBrowserStubs();
  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applyTranscriptDelta, clearSessionRuntime, viewRemoteThread } =
    await import("./session-ops.js");
  const { remoteQueryClient } = await import("./query-client.js");

  clearSessionRuntime();
  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-pin-settle",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  remoteQueryClient.clear();

  state.realSession = state.session = {
    active_thread_id: "thread-a",
    transcript_revision: 1,
    transcript: [
      { item_id: "a-1", kind: "agent_text", status: "running", text: "Hello", turn_id: "turn-a", tool: null },
    ],
  };
  // The window is loaded for the LIVE thread (thread-a) before any pin —
  // e.g. from an earlier hydration of the thread the user is currently on.
  state.transcriptHydrationThreadId = "thread-a";
  state.transcriptHydrationEntries = new Map([["a-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["a-1"];

  // A live delta lands BEFORE the pin — window-loaded, deferred (the array
  // still says "Hello").
  applyTranscriptDelta({
    thread_id: "thread-a",
    item_id: "a-1",
    turn_id: "turn-a",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  assert.equal(state.realSession.transcript[0].text, "Hello", "still deferred before the pin");

  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      setImmediate(async () => {
        await handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "thread-b",
            revision: 1,
            entries: [
              { item_id: "b-1", kind: "agent_text", text: "B", status: "completed", turn_id: "turn-b", tool: null },
            ],
            prev_cursor: null,
          },
        });
      });
    },
  };

  // Pin a DIFFERENT thread (thread-b) — this switches the hydration window
  // away from thread-a's, via the fetch path (thread-a is not yet live at
  // the fetch-free check, since we are pinning thread-b, not re-viewing
  // thread-a).
  assert.equal(await viewRemoteThread("thread-b"), true);

  assert.equal(
    state.realSession.transcript.find((entry) => entry.item_id === "a-1")?.text,
    "Hello world",
    "the pre-pin live delta must be settled into state.realSession before the window moves on"
  );

  // A SECOND live delta arrives AFTER the pin completes — the window now
  // tracks thread-b, so this takes the array fallback. It must read the
  // FRESH (already-settled) array, not the stale pre-settle one, or its
  // text_offset reads as a gap and the delta is dropped pending repair.
  applyTranscriptDelta({
    thread_id: "thread-a",
    item_id: "a-1",
    turn_id: "turn-a",
    delta: "!",
    delta_kind: "agent_text",
    text_offset: 11,
  });
  assert.equal(
    state.realSession.transcript.find((entry) => entry.item_id === "a-1")?.text,
    "Hello world!",
    "a live delta after the pin must still land via the array fallback, not be dropped as a false gap"
  );

  clearSessionRuntime();
  state.socket = null;
  state.pendingActions.clear();
  remoteQueryClient.clear();
});

// ---------------------------------------------------------------------------
// B5: the remote view-only generation transition, over the real broker harness.
//
// applySessionSnapshot projects a pin by SPREADING the incoming snapshot and
// injecting the previously rendered entries, so relabelling one across a run
// change hands the old run's ids the new run's generation and nothing
// downstream can tell. The pin must be released and REFETCHED — and a refetch
// that never lands is not convergence, so this counts the dispatches and waits
// for the re-pin instead of inferring it from a cleared pin.
// ---------------------------------------------------------------------------

function transitionEntry(itemId, text) {
  return {
    item_id: itemId,
    kind: "agent_text",
    text,
    status: "completed",
    turn_id: "turn-x",
    tool: null,
    order_seq: 1 << 20,
  };
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a run change releases the view-only pin, refetches once, and re-pins under the new run", async () => {
  activeBrowser = installBrowserStubs();

  const { state, saveRemoteAuth } = await import("./state.js");
  const { handleRemoteBrokerPayload } = await import("./actions.js");
  const { applySessionSnapshot, viewRemoteThread } = await import("./session-ops.js");

  seedRemoteAuth(state, saveRemoteAuth, {
    relayId: "relay-gen-transition",
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
  seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
  state.pendingActions.clear();
  seedTranscriptHydrationState(state);

  // The live thread is never the viewed one, so the pin stays a pin.
  const liveUnder = (generation) => ({
    active_thread_id: "live-thread",
    transcript_generation: generation,
    transcript_revision: 9,
    transcript: [transitionEntry(`${generation}-live`, "live row")],
    thread_activity: [],
  });

  let generationForPages = "gen-a";
  const transcriptFetches = [];
  state.socket = {
    readyState: 1,
    send(frameText) {
      const frame = JSON.parse(frameText);
      const request = frame.payload.request;
      if (request?.type !== "fetch_thread_transcript") {
        return;
      }
      transcriptFetches.push(request.thread_id ?? request.threadId ?? null);
      const generation = generationForPages;
      setImmediate(() => {
        void handleRemoteBrokerPayload({
          kind: "remote_action_result",
          action_id: frame.payload.action_id,
          action: "fetch_thread_transcript",
          ok: true,
          snapshot: {},
          thread_transcript: {
            thread_id: "viewed-thread",
            transcript_generation: generation,
            entries: [transitionEntry(`${generation}-viewed`, `${generation} viewed body`)],
            prev_cursor: null,
          },
        });
      });
    },
  };

  state.session = liveUnder("gen-a");
  state.realSession = liveUnder("gen-a");

  // Seed the gen-A pin the production way.
  await viewRemoteThread("viewed-thread");
  await settle();
  const fetchesAfterPin = transcriptFetches.length;
  assert.ok(fetchesAfterPin >= 1, "the pin was established by a real fetch");
  assert.ok(
    (state.session.transcript || []).some((entry) => entry.item_id === "gen-a-viewed"),
    "the gen-a viewed row is on screen"
  );

  // The relay restarts: same viewed thread, new run.
  generationForPages = "gen-b";
  applySessionSnapshot(liveUnder("gen-b"));
  await settle();

  assert.equal(
    transcriptFetches.length,
    fetchesAfterPin + 1,
    "exactly one refetch is dispatched for the transition"
  );
  const ids = (state.session.transcript || []).map((entry) => entry.item_id);
  assert.ok(ids.includes("gen-b-viewed"), `the gen-b viewed row is rendered: ${ids.join(",")}`);
  assert.ok(
    !ids.some((id) => String(id).startsWith("gen-a-")),
    `no gen-a id survives the transition: ${ids.join(",")}`
  );
  assert.equal(new Set(ids).size, ids.length, "and nothing is duplicated");

  // Further snapshots under the SAME run are ordinary renders.
  applySessionSnapshot(liveUnder("gen-b"));
  applySessionSnapshot(liveUnder("gen-b"));
  await settle();

  assert.equal(
    transcriptFetches.length,
    fetchesAfterPin + 1,
    "no further transition fetch — it converged instead of refetching forever"
  );
  assert.ok(
    (state.session.transcript || []).some((entry) => entry.item_id === "gen-b-viewed"),
    "and the pin is still held under gen-b"
  );
});

// An old relay stamps nothing and a new one does, so "" <-> "gen-x" is the same
// rename in either direction. Both must refetch and re-pin for real — a released
// pin that never comes back is not convergence.
for (const [fromGeneration, toGeneration, label] of [
  ["", "gen-b", "empty -> stamped (relay gained stamping)"],
  ["gen-a", "", "stamped -> empty (relay lost stamping)"],
]) {
  test(`the one-sided-empty boundary refetches and re-pins: ${label}`, async () => {
    activeBrowser = installBrowserStubs();

    const { state, saveRemoteAuth } = await import("./state.js");
    const { handleRemoteBrokerPayload } = await import("./actions.js");
    const { applySessionSnapshot, viewRemoteThread } = await import("./session-ops.js");

    seedRemoteAuth(state, saveRemoteAuth, {
      relayId: `relay-boundary-${fromGeneration || "empty"}`,
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
    seedSocketState(state, { socketConnected: true, socketPeerId: "surface-peer-1" });
    state.pendingActions.clear();
    seedTranscriptHydrationState(state);

    const tag = (generation) => `${generation || "none"}-viewed`;
    const liveUnder = (generation) => ({
      active_thread_id: "live-thread",
      transcript_generation: generation,
      transcript_revision: 9,
      transcript: [transitionEntry(`${generation || "none"}-live`, "live row")],
      thread_activity: [],
    });

    let generationForPages = fromGeneration;
    const transcriptFetches = [];
    state.socket = {
      readyState: 1,
      send(frameText) {
        const frame = JSON.parse(frameText);
        if (frame.payload.request?.type !== "fetch_thread_transcript") {
          return;
        }
        transcriptFetches.push(1);
        const generation = generationForPages;
        setImmediate(() => {
          void handleRemoteBrokerPayload({
            kind: "remote_action_result",
            action_id: frame.payload.action_id,
            action: "fetch_thread_transcript",
            ok: true,
            snapshot: {},
            thread_transcript: {
              thread_id: "viewed-thread",
              transcript_generation: generation,
              entries: [transitionEntry(tag(generation), "viewed body")],
              prev_cursor: null,
            },
          });
        });
      },
    };

    state.session = liveUnder(fromGeneration);
    state.realSession = liveUnder(fromGeneration);

    await viewRemoteThread("viewed-thread");
    await settle();
    const before = transcriptFetches.length;
    assert.ok(before >= 1, "pinned under the starting run");

    generationForPages = toGeneration;
    applySessionSnapshot(liveUnder(toGeneration));
    await settle();

    assert.equal(transcriptFetches.length, before + 1, "the boundary dispatched exactly one refetch");
    const ids = (state.session.transcript || []).map((entry) => entry.item_id);
    assert.ok(ids.includes(tag(toGeneration)), `re-pinned under the new run: ${ids.join(",")}`);
    assert.ok(
      !ids.includes(tag(fromGeneration)),
      `no row from the old run survives: ${ids.join(",")}`
    );
  });
}
