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
  assert.equal(state.realSession.transcript[0].text, "thread B live");
  assert.equal(state.session.active_thread_id, "thread-a");
  assert.equal(state.session.transcript[0].text, "thread A");
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
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
  } = await import("./session-ops.js");

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
  flushRemoteTranscriptRenderForTest();
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

  assert.equal(state.session.transcript[0].text, "one two three");
  assert.equal(notifications.length, 0);
  flushRemoteTranscriptRenderForTest();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].transcript[0].text, "one two three");
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

test("applyTranscriptDelta appends agent text contiguously using text_offset", async () => {
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

  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript[0].status, "running");
  assert.equal(state.session.transcript_revision, 6);
});

test("applyTranscriptDelta applies agent deltas by text_offset even when base_revision is not contiguous", async () => {
  activeBrowser || installBrowserStubs();

  const { state } = await import("./state.js");
  const { applyTranscriptDelta } = await import("./session-ops.js");

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
  const { applyTranscriptDelta } = await import("./session-ops.js");

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
