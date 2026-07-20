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

test("selectDeviceChromeRenderModel exposes re-pair state for expired device sessions", () => {
  const model = selectDeviceChromeRenderModel({
    clientAuth: { clientId: "client-1", brokerControlUrl: "https://broker.example.test" },
    pairingError: null,
    pairingPhase: null,
    pairingTicket: null,
    relayDirectory: [],
    remoteAuth: {
      relayId: "relay-1",
      relayLabel: "Work Mac",
      brokerChannelId: "room-a",
      relayPeerId: "relay-peer-1",
      securityMode: "private",
      deviceId: "device-1",
      deviceLabel: "Primary Phone",
      payloadSecret: "payload-secret-1",
      deviceSessionExpired: true,
    },
    session: null,
  });

  assert.equal(model.deviceMeta.cards[0].badges[0].label, "Re-pair required");
  assert.equal(model.deviceMeta.cards[0].badges[0].tone, "alert");
  assert.match(model.deviceMeta.cards[0].metaLines[2], /pair it again/i);
});

test("selectSessionChromeRenderModel prioritizes re-pair over offline for expired device sessions", () => {
  const state = {
    remoteAuth: {
      relayId: "relay-1",
      deviceId: "device-1",
      payloadSecret: "payload-secret-1",
      deviceSessionExpired: true,
    },
    serverConnectionState: "disconnected",
    socketConnected: false,
  };
  const session = {
    active_thread_id: "thread-1",
    current_status: "idle",
    pending_approvals: [],
    provider_connected: false,
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Re-pair required");
  assert.equal(model.statusBadge.tone, "alert");
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
  assert.equal(model.statusBadge.label, "Live");
  assert.equal(model.agentWorkingIndicator.hidden, true);
  assert.equal(model.controlBanner.hidden, true);
  assert.equal(model.controlBanner.takeOverHidden, true);
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Thread").value, "thread-1");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Provider").value, "Codex");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Model").value, "gpt-5.4");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Effort").value, "medium");
  assert.equal(model.sessionMeta.chips.find((chip) => chip.label === "Control").value, "Available");
});

test("remote control banner remains visible while another device is running the thread", () => {
  const state = {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
    active_controller_device_id: "device-2",
    current_status: "active",
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.controlBanner.hidden, false);
  assert.equal(model.controlBanner.takeOverHidden, false);
  assert.match(model.controlBanner.hint, /read-only/i);
});

test("remote control banner hides take over while the active thread is being reviewed", () => {
  const state = {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-1",
    active_controller_device_id: "device-2",
    // The review's parent IS the active thread, so it's locked.
    active_review_jobs: [
      { id: "review-1", status: "waiting_for_reviewer", parent_thread_id: "thread-1" },
    ],
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.controlBanner.hidden, false);
  assert.equal(model.controlBanner.takeOverHidden, true);
  assert.match(model.controlBanner.hint, /being reviewed/i);
});

test("remote view-only busy projection exposes targeted take over", () => {
  const state = {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-viewed",
    active_turn_id: "view:thread-viewed",
    active_controller_device_id: "__view_only__",
    current_cwd: "/tmp/viewed",
    current_status: "active",
    pending_approvals: [],
    provider_connected: true,
    view_only: true,
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.controlBanner.hidden, false);
  assert.equal(model.controlBanner.takeOverHidden, false);
  assert.equal(
    model.sessionMeta.chips.find((chip) => chip.label === "Control").value,
    "View only"
  );
});

test("remote status badge surfaces 'Review in progress' when the active thread is under review", () => {
  const state = { remoteAuth: { deviceId: "device-1" }, socketConnected: true };
  const session = {
    active_thread_id: "thread-1",
    active_review_jobs: [
      { id: "review-1", status: "waiting_for_reviewer", parent_thread_id: "thread-1" },
    ],
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Review in progress");
  assert.equal(model.statusBadge.tone, "alert");
});

test("remote status badge surfaces 'Review blocked' regardless of which thread is active", () => {
  const state = { remoteAuth: { deviceId: "device-1" }, socketConnected: true };
  const session = {
    active_thread_id: "thread-2",
    // A blocked review on ANOTHER thread still needs attention → badge it.
    active_review_jobs: [
      { id: "review-1", status: "blocked", parent_thread_id: "thread-1" },
    ],
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Review blocked — action needed");
  assert.equal(model.statusBadge.tone, "alert");
});

test("remote status badge stays 'Live' when a review runs on a non-active thread", () => {
  const state = { remoteAuth: { deviceId: "device-1" }, socketConnected: true };
  const session = {
    active_thread_id: "thread-2",
    active_review_jobs: [
      { id: "review-1", status: "waiting_for_reviewer", parent_thread_id: "thread-1" },
    ],
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Live");
  assert.equal(model.statusBadge.tone, "ready");
});

test("remote control banner allows take over when the review is on another thread", () => {
  const state = {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-2",
    active_turn_id: "turn-2",
    active_controller_device_id: "device-2",
    // A background review owns a DIFFERENT thread — take-over stays allowed.
    active_review_jobs: [
      { id: "review-1", status: "waiting_for_reviewer", parent_thread_id: "thread-1" },
    ],
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.controlBanner.hidden, false);
  assert.equal(model.controlBanner.takeOverHidden, false);
});

test("remote view-only stale working status exposes targeted take over", () => {
  const model = selectSessionChromeRenderModel({
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  }, {
    active_thread_id: "thread-2",
    active_turn_id: null,
    active_controller_device_id: "__view_only__",
    active_review_jobs: [],
    current_status: "active",
    pending_approvals: [],
    provider_connected: true,
    view_only: true,
  });

  assert.equal(model.controlBanner.hidden, false);
  assert.equal(model.controlBanner.takeOverHidden, false);
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

test("selectSessionChromeRenderModel surfaces phase verb in the working indicator", () => {
  const state = {
    pairingError: null,
    pairingPhase: null,
    pairingTicket: null,
    relayDirectory: [],
    remoteAuth: { relayId: "relay-1", payloadSecret: "x" },
    session: null,
    socketConnected: true,
    progressVerb: "Pondering",
  };
  const session = {
    active_thread_id: "thread-1",
    current_cwd: "/tmp",
    current_status: "active",
    current_phase: "thinking",
    current_tool: null,
    last_progress_at: Math.floor(Date.now() / 1000),
    provider: "claude_code",
    model: "claude-sonnet-4-6",
    reasoning_effort: "medium",
    provider_connected: true,
    broker_connected: true,
    broker_channel_id: "room",
    broker_peer_id: "peer",
    security_mode: "private",
    e2ee_enabled: true,
    broker_can_read_content: false,
    audit_enabled: false,
    pending_approvals: [],
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Live");
  assert.equal(model.statusBadge.tone, "ready");
  assert.equal(model.agentWorkingIndicator.hidden, false);
  assert.equal(model.agentWorkingIndicator.label, "Pondering…");
  assert.equal(model.agentWorkingIndicator.tone, "ready");
});

test("selectSessionChromeRenderModel surfaces tool gerund in the working indicator", () => {
  const state = {
    relayDirectory: [],
    remoteAuth: { relayId: "relay-1", payloadSecret: "x" },
    session: null,
    socketConnected: true,
    progressVerb: "Pondering",
  };
  const session = {
    active_thread_id: "thread-1",
    current_cwd: "/tmp",
    current_status: "active",
    current_phase: "tool",
    current_tool: "Bash",
    last_progress_at: Math.floor(Date.now() / 1000),
    provider: "claude_code",
    model: "claude-sonnet-4-6",
    reasoning_effort: "medium",
    provider_connected: true,
    pending_approvals: [],
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Live");
  assert.equal(model.agentWorkingIndicator.label, "Bashing…");
});

test("selectSessionChromeRenderModel flips to Stalled? when last_progress_at goes stale", () => {
  const state = {
    relayDirectory: [],
    remoteAuth: { relayId: "relay-1", payloadSecret: "x" },
    session: null,
    socketConnected: true,
    progressVerb: "Pondering",
  };
  const session = {
    active_thread_id: "thread-1",
    current_cwd: "/tmp",
    current_status: "active",
    current_phase: "thinking",
    current_tool: null,
    last_progress_at: 1000,
    server_time: 1100,
    provider: "claude_code",
    model: "claude-sonnet-4-6",
    reasoning_effort: "medium",
    provider_connected: true,
    pending_approvals: [],
  };

  const model = selectSessionChromeRenderModel(state, session);
  assert.equal(model.statusBadge.label, "Live");
  assert.equal(model.statusBadge.tone, "ready");
  assert.equal(model.agentWorkingIndicator.hidden, false);
  assert.equal(model.agentWorkingIndicator.label, "Stalled?");
  assert.equal(model.agentWorkingIndicator.tone, "alert");
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

// The user-visible regression behind the `notLoaded` status bug: a saved Codex
// thread (view-only, no turn in flight) read as "working", so the remote surface
// claimed a background thread was running and offered Stop / Take-over that the
// backend then rejects with "no running turn".
test("a view-only Codex thread reported as notLoaded shows no running banner", () => {
  const state = {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-saved",
    active_turn_id: null,
    active_controller_device_id: "__view_only__",
    view_only: true,
    current_status: "notLoaded", // exactly what Codex sends
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.controlBanner.summary === "Background thread is running", false);
  assert.equal(model.agentWorkingIndicator.hidden, true, "no working indicator");
});

test("a view-only thread that IS running still shows the banner", () => {
  const state = {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
  };
  const session = {
    active_thread_id: "thread-bg",
    active_turn_id: "turn-7",
    active_controller_device_id: "__view_only__",
    view_only: true,
    current_status: "active",
    pending_approvals: [],
    provider_connected: true,
  };

  const model = selectSessionChromeRenderModel(state, session);

  assert.equal(model.controlBanner.summary, "Background thread is running");
  assert.equal(model.controlBanner.hidden, false);
});
