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
  assert.equal(model.hasActiveSession, true);
  assert.equal(model.canWrite, false);
  assert.match(model.messagePlaceholder, /Another device has control/);
  assert.deepEqual(model.scrollDebug, {
    thread: "thread-1",
    prevThread: "thread-0",
    entries: 1,
    truncated: "1",
    status: "idle",
  });
});

test("selectThreadsRenderModel returns empty copy for unauthenticated and filtered states", () => {
  const unauthenticated = selectThreadsRenderModel({
    threads: [],
    filterValue: "",
    activeThreadId: null,
    remoteAuth: null,
    relayDirectory: [{ relayId: "relay-1" }],
  });
  assert.equal(unauthenticated.countLabel, "Remote session history");
  assert.match(unauthenticated.emptyMessage, /Open a relay/);

  const filtered = selectThreadsRenderModel({
    threads: [],
    filterValue: "/tmp/workspace",
    activeThreadId: "thread-1",
    remoteAuth: { relayId: "relay-1" },
    relayDirectory: [],
  });
  assert.match(filtered.emptyMessage, /workspace filter/);
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
