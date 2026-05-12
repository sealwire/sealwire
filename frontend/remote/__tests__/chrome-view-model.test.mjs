import test from "node:test";
import assert from "node:assert/strict";

import {
  selectDeviceChromeRenderModel,
  selectSessionChromeRenderModel,
  selectStatusBadgeRenderModel,
} from "../chrome-view-model.js";

test("selectDeviceChromeRenderModel exposes re-pair state and pairing controls", () => {
  const model = selectDeviceChromeRenderModel({
    clientAuth: { clientId: "client-1", brokerControlUrl: "https://broker.example.test" },
    pairingError: null,
    pairingPhase: null,
    pairingTicket: null,
    relayDirectory: [
      {
        relayId: "relay-1",
        hasLocalProfile: false,
        needsLocalRePairing: true,
      },
    ],
    remoteAuth: {
      relayId: "relay-1",
      relayLabel: "Work Mac",
      brokerChannelId: "room-a",
      relayPeerId: "relay-peer-1",
      securityMode: "private",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: null,
    },
    session: null,
  });

  assert.equal(model.deviceMeta.cards[0].badges[0].label, "Re-pair required");
  assert.match(model.deviceMeta.cards[0].metaLines[2], /local encrypted credentials are unavailable/i);
  assert.equal(model.homeButton.hidden, false);
  assert.equal(model.pairingControls.connectLabel, "Pair");
});

test("selectSessionChromeRenderModel derives header, status, and control banner", () => {
  const state = {
    pairingError: null,
    pairingPhase: null,
    pairingTicket: null,
    relayDirectory: [],
    remoteAuth: {
      relayId: "relay-1",
      relayLabel: "agent-relay",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: "payload-secret-1",
      securityMode: "private",
    },
    session: null,
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-1",
    current_cwd: "/Users/luchi/git/agent-relay",
    current_status: "idle",
    provider: "codex",
    model: "gpt-5.4",
    reasoning_effort: "medium",
    provider_connected: true,
    broker_connected: true,
    broker_channel_id: "room-a",
    broker_peer_id: "relay-peer-1",
    security_mode: "private",
    e2ee_enabled: true,
    broker_can_read_content: false,
    audit_enabled: false,
    active_controller_device_id: "device-2",
    pending_approvals: [],
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.header.title, "agent-relay");
  assert.equal(model.header.subtitle, "/Users/luchi/git/agent-relay");
  assert.equal(model.header.modelLabel, "Codex · gpt-5.4");
  assert.equal(model.header.modelTitle, "Codex · gpt-5.4 · effort medium");
  assert.equal(model.statusBadge.label, "idle");
  assert.equal(model.controlBanner.hidden, false);
  assert.match(model.controlBanner.hint, /Approvals can still be handled here/i);
  assert.equal(model.controlBanner.summary, "Controlled by device-2");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Thread").value, "thread-1");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Provider").value, "Codex");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Model").value, "gpt-5.4");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Effort").value, "medium");
});

test("selectStatusBadgeRenderModel falls back to home and pairing states without a session", () => {
  assert.deepEqual(
    selectStatusBadgeRenderModel({
      pairingError: null,
      pairingPhase: "requesting",
      pairingTicket: { pairing_id: "pair-1", expires_at: 1 },
      relayDirectory: [],
      remoteAuth: null,
      session: null,
      socketConnected: false,
    }),
    { label: "Approval pending", tone: "ready" }
  );

  assert.deepEqual(
    selectStatusBadgeRenderModel({
      pairingError: null,
      pairingPhase: null,
      pairingTicket: null,
      relayDirectory: [{ relayId: "relay-1" }],
      remoteAuth: null,
      session: null,
      socketConnected: false,
    }),
    { label: "Home", tone: "ready" }
  );
});

test("selectStatusBadgeRenderModel shows disconnected server state", () => {
  assert.deepEqual(
    selectStatusBadgeRenderModel({
      pairingError: null,
      pairingPhase: null,
      pairingTicket: null,
      relayConnected: false,
      relayConnectionMessage: "Relay server disconnected. Waiting for it to reconnect.",
      relayDirectory: [],
      remoteAuth: { relayId: "relay-1" },
      session: null,
      socketConnected: true,
    }),
    { label: "Server disconnected", tone: "offline" }
  );

  assert.deepEqual(
    selectStatusBadgeRenderModel({
      pairingError: null,
      pairingPhase: null,
      pairingTicket: null,
      relayDirectory: [],
      remoteAuth: { relayId: "relay-1" },
      serverConnectionMessage: "Server disconnected. Retrying connection.",
      serverConnectionState: "disconnected",
      session: null,
      socketConnected: false,
    }),
    { label: "Server disconnected", tone: "offline" }
  );
});
