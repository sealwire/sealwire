import test from "node:test";
import assert from "node:assert/strict";

import {
  selectEmptyStateRenderModel,
  selectRelayDirectoryRenderModel,
  selectSessionRenderModel,
  selectThreadsRenderModel,
} from "../view-model.js";

test("selectSessionRenderModel derives composer state from controller/session flags", () => {
  const model = selectSessionRenderModel({
    session: {
      active_thread_id: "thread-1",
      current_cwd: "/Users/luchi/git/agent-relay",
      current_status: "idle",
      pending_approvals: [{ request_id: "approval-1" }],
      transcript: [{ item_id: "item-1" }],
      transcript_truncated: true,
    },
    previousSession: {
      active_thread_id: "thread-0",
    },
    hasControllerLease: false,
  });

  assert.equal(model.approval?.request_id, "approval-1");
  assert.equal(model.currentApprovalId, "approval-1");
  assert.equal(model.hasActiveSession, true);
  assert.equal(model.canWrite, false);
  assert.equal(model.composerDisabled, true);
  assert.match(model.messagePlaceholder, /Another device has control/);
  assert.deepEqual(model.scrollDebug, {
    thread: "thread-1",
    prevThread: "thread-0",
    entries: 1,
    truncated: "1",
    status: "idle",
  });
});

test("selectThreadsRenderModel returns empty copy for unauthenticated state", () => {
  const unauthenticated = selectThreadsRenderModel({
    threads: [],
    activeThreadId: null,
    remoteAuth: null,
    relayDirectory: [{ relayId: "relay-1" }],
  });
  assert.equal(unauthenticated.countLabel, "Remote session history");
  assert.match(unauthenticated.emptyMessage, /Open a relay/);

  const empty = selectThreadsRenderModel({
    threads: [],
    activeThreadId: "thread-1",
    remoteAuth: { relayId: "relay-1" },
    relayDirectory: [],
  });
  assert.match(empty.emptyMessage, /No remote sessions/);
});

test("selectThreadsRenderModel injects the active session thread until remote history catches up", () => {
  const model = selectThreadsRenderModel({
    threads: [],
    activeThreadId: "thread-1",
    remoteAuth: { relayId: "relay-1" },
    relayDirectory: [],
    session: {
      active_thread_id: "thread-1",
      current_cwd: "/tmp/project-alpha",
      current_status: "idle",
      provider: "claude_code",
    },
  });

  assert.equal(model.emptyMessage, null);
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].cwd, "/tmp/project-alpha");
  assert.equal(model.groups[0].threads.length, 1);
  assert.equal(model.groups[0].threads[0].id, "thread-1");
  assert.equal(model.groups[0].threads[0].provider, "claude_code");
  assert.match(model.groups[0].threads[0].preview, /Current session/);
});

test("selectThreadsRenderModel keeps provider threads that do not report a cwd", () => {
  const model = selectThreadsRenderModel({
    threads: [
      {
        id: "claude-thread-1",
        cwd: "",
        provider: "claude_code",
        preview: "Claude history",
        updated_at: 1700000000,
      },
    ],
    activeThreadId: null,
    remoteAuth: { relayId: "relay-1" },
    relayDirectory: [],
  });

  assert.equal(model.emptyMessage, null);
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].label, "Unknown workspace");
  assert.equal(model.groups[0].threads.length, 1);
  assert.equal(model.groups[0].threads[0].id, "claude-thread-1");
  assert.equal(model.groups[0].threads[0].provider, "claude_code");
});

test("selectRelayDirectoryRenderModel builds action labels and active flags", () => {
  const model = selectRelayDirectoryRenderModel({
    activeRelayId: "relay-1",
    relayDirectory: [
      {
        relayId: "relay-1",
        relayLabel: "Dev Relay",
        brokerRoomId: "room-a",
        hasLocalProfile: true,
      },
      {
        relayId: "relay-2",
        relayLabel: "Cold Relay",
        brokerRoomId: "room-b",
        hasLocalProfile: false,
        needsLocalRePairing: true,
      },
    ],
  });

  assert.equal(model.countLabel, "2 relays");
  assert.equal(model.items[0].active, true);
  assert.equal(model.items[0].actionLabel, "Open relay");
  assert.equal(model.items[1].actionLabel, "Re-pair relay");
  assert.equal(model.items[1].isEnabled, false);
});

test("selectRelayDirectoryRenderModel prefers client nicknames over relayLabel", () => {
  const model = selectRelayDirectoryRenderModel({
    activeRelayId: "relay-1",
    nicknames: { "relay-1": "Mac mini" },
    relayDirectory: [
      {
        relayId: "relay-1",
        relayLabel: "Dev Relay",
        brokerRoomId: "room-a",
        hasLocalProfile: true,
      },
      {
        relayId: "relay-2",
        relayLabel: "Cold Relay",
        brokerRoomId: "room-b",
        hasLocalProfile: true,
      },
    ],
  });
  assert.equal(model.items[0].title, "Mac mini");
  assert.equal(model.items[1].title, "Cold Relay");
});

test("selectRelayDirectoryRenderModel exposes relay id in meta only when nickname overrides title", () => {
  const model = selectRelayDirectoryRenderModel({
    activeRelayId: null,
    nicknames: { "relay-1": "Mac mini" },
    relayDirectory: [
      {
        relayId: "relay-1",
        brokerRoomId: "dev-room",
        hasLocalProfile: true,
      },
      {
        relayId: "relay-2",
        brokerRoomId: "dev-room",
        hasLocalProfile: true,
      },
    ],
  });
  assert.equal(model.items[0].meta, "relay-1");
  assert.equal(model.items[1].meta, "");
});

test("selectEmptyStateRenderModel exposes relay-home and re-pair branches", () => {
  const relayHome = selectEmptyStateRenderModel({
    clientAuth: { clientId: "client-1" },
    pairingTicket: null,
    relayDirectory: [],
    remoteAuth: null,
  });
  assert.equal(relayHome.showRelayHome, true);
  assert.equal(relayHome.showMissingCredentials, false);

  const missingCredentials = selectEmptyStateRenderModel({
    clientAuth: { clientId: "client-1" },
    pairingTicket: null,
    relayDirectory: [],
    remoteAuth: {
      relayId: "relay-1",
      payloadSecret: null,
    },
  });
  assert.equal(missingCredentials.showRelayHome, false);
  assert.equal(missingCredentials.showMissingCredentials, true);
});

test("selectEmptyStateRenderModel exposes server disconnected state", () => {
  const brokerDisconnected = selectEmptyStateRenderModel({
    clientAuth: { clientId: "client-1" },
    pairingTicket: null,
    relayDirectory: [],
    remoteAuth: {
      relayId: "relay-1",
      payloadSecret: "payload-secret-1",
    },
    serverConnectionMessage: "Server disconnected. Retrying connection.",
    serverConnectionState: "disconnected",
    socketConnected: false,
  });

  assert.equal(brokerDisconnected.showServerDisconnected, true);
  assert.match(brokerDisconnected.serverDisconnectedCopy, /Server disconnected/);

  const relayDisconnected = selectEmptyStateRenderModel({
    clientAuth: { clientId: "client-1" },
    pairingTicket: null,
    relayConnected: false,
    relayConnectionMessage: "Relay server disconnected. Waiting for it to reconnect.",
    relayDirectory: [],
    remoteAuth: {
      relayId: "relay-1",
      payloadSecret: "payload-secret-1",
    },
    socketConnected: true,
  });

  assert.equal(relayDisconnected.showServerDisconnected, true);
  assert.match(relayDisconnected.serverDisconnectedCopy, /Relay server disconnected/);
});
