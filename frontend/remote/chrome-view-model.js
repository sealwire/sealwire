import { formatTimestamp, shortId, workspaceBasename } from "./utils.js";
import { providerLabel } from "../shared/provider-labels.js";
import {
  isReviewInProgressForThread,
  reviewStatusBadge,
} from "../shared/review-state.js";
import {
  isWorkflowBlocked,
  isWorkflowInProgressForThread,
} from "../shared/workflow-state.js";
import {
  isProgressStalled,
  progressPhaseLabel,
} from "../progress-verbs.js";
import { sessionIsWorking } from "../shared/thread-attention.js";
import { describeSessionStatus } from "../shared/session-status.js";
import {
  normalizeWorkspaceRepairPlan,
  readWorkspaceRepair,
  workspaceRepairAction,
  workspaceRepairHint,
  workspaceRepairSummary,
} from "./workspace-repair.js";

// Nothing is claiming the banner. Every branch returns this SHAPE (never a subset) so
// the renderer can read `repair`/`summaryTitle` without guarding each field.
const NO_CONTROL_BANNER = Object.freeze({
  hidden: true,
  hint: "",
  repair: null,
  summary: "",
  summaryTitle: "",
  takeOverHidden: true,
});

function isSessionOffline(currentState, session) {
  return Boolean(
    currentState.serverConnectionState === "disconnected"
      || currentState.serverConnectionMessage
      || !currentState.socketConnected
      || !session.provider_connected
  );
}

export function isCurrentDeviceActiveController({ remoteAuth, session }) {
  return Boolean(
    session?.active_thread_id &&
      session.active_controller_device_id &&
      session.active_controller_device_id === remoteAuth?.deviceId
  );
}

export function canCurrentDeviceWrite({ remoteAuth, session }) {
  if (!session?.active_thread_id) {
    return false;
  }

  return !session.active_controller_device_id || session.active_controller_device_id === remoteAuth?.deviceId;
}

export function selectSessionChromeRenderModel(currentState, session) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  const workspaceName = session.current_cwd
    ? workspaceBasename(session.current_cwd)
    : workspaceTitle(currentState);
  const headerPath = currentHeaderPath(currentState, session);

  return {
    agentWorkingIndicator: deriveAgentWorkingIndicator(currentState, session, approval),
    controlBanner: selectControlBannerRenderModel(currentState, session),
    header: {
      sessionPath: headerPath,
      subtitle: "",
      subtitleHidden: true,
      subtitleTitle: "",
      title: hasActiveSession ? workspaceName : workspaceTitle(currentState),
      titleTitle: session.current_cwd || "",
    },
    sessionMeta: selectSessionMetaRenderModel(currentState, session),
    statusBadge: deriveStatusBadge(currentState, session, approval),
  };
}

function deriveStatusBadge(currentState, session, approval) {
  if (approval) {
    return headerStatusBadge("Approval required", "alert");
  }
  if (selectedRelayNeedsRepair(currentState)) {
    return headerStatusBadge("Re-pair required", "alert");
  }
  if (isSessionOffline(currentState, session)) {
    return headerStatusBadge("Offline", "offline");
  }
  // Surface the under-review state in the header (parity with local) — the remote
  // surface previously only froze the composer, so a remote user had no "Review in
  // progress / blocked" indicator. Shared helper → identical wording/tone to local.
  if (isWorkflowBlocked(session)) {
    return headerStatusBadge("Code Flow blocked — action needed", "alert");
  }
  const review = reviewStatusBadge(session, session.active_thread_id);
  if (review) {
    return headerStatusBadge(review.label, review.tone);
  }
  if (isWorkflowInProgressForThread(session, session.active_thread_id)) {
    return headerStatusBadge("Code Flow in progress", "alert");
  }
  // Task wording comes from the shared session-status seam so it matches the local
  // surface (No active task / Idle / Working) instead of a remote-only Standby/Live.
  // Provider/transport outage is handled above by isSessionOffline — broader than the
  // seam's provider-only `providers` subject — so we borrow only the TASK subject here.
  return quietStatusBadge(describeSessionStatus(session).task.label);
}

function headerStatusBadge(label, tone) {
  return { label, tone, headerVisible: true };
}

function quietStatusBadge(label, tone = "ready") {
  return { label, tone, headerVisible: false };
}

function deriveAgentWorkingIndicator(currentState, session, approval) {
  if (approval) return { hidden: true, label: "", tone: "ready" };
  if (isSessionOffline(currentState, session)) return { hidden: true, label: "", tone: "ready" };
  if (!session.active_thread_id || !session.current_phase) {
    return { hidden: true, label: "", tone: "ready" };
  }
  if (isProgressStalled(session)) {
    return { hidden: false, label: "Stalled?", tone: "alert" };
  }
  const label = progressPhaseLabel(
    session.current_phase,
    session.current_tool,
    currentState.progressVerb ?? null,
  );
  if (!label) return { hidden: true, label: "", tone: "ready" };
  return { hidden: false, label, tone: "ready" };
}

export function selectDeviceChromeRenderModel(currentState) {
  // A pairing failure has to be shown even when there is no ticket to hang it on. The
  // link that gets rejected hardest is a legacy `?pairing=` one — rejected precisely
  // BECAUSE its secret already reached the broker — and parsing is what failed there, so
  // no ticket was ever built. Gating this card on `pairingTicket` hid the only actionable
  // instruction ("generate a fresh QR") behind the generic unpaired screen.
  const showPairingCard = Boolean(currentState.pairingTicket)
    || currentState.pairingPhase === "error";
  const emptyMessage = !currentState.remoteAuth && !showPairingCard
    ? currentState.relayDirectory?.length
      ? "Open one of your relays from home or the sidebar to enter its remote surface."
      : "No paired remote device is stored in this browser yet."
    : null;

  const cards = [];
  if (showPairingCard) {
    const ticket = currentState.pairingTicket;
    const badge = pairingBadge(currentState);
    cards.push({
      badges: [
        {
          label: badge.label,
          tone: badge.tone,
        },
      ],
      metaLines: [
        ...(ticket
          ? [`${shortId(ticket.pairing_id)} · expires ${formatTimestamp(ticket.expires_at)}`]
          : []),
        pairingCopy(currentState),
        ...(currentState.pairingPhase === "requesting" && currentState.pairingFingerprint
          ? [`Fingerprint ${currentState.pairingFingerprint}`]
          : []),
      ],
      title: pairingHeading(currentState),
    });
  }

  if (currentState.remoteAuth) {
    cards.push({
      badges: [
        {
          label: selectedRelayNeedsRepair(currentState) ? "Re-pair required" : "Paired",
          tone: selectedRelayNeedsRepair(currentState) ? "alert" : "ready",
        },
        {
          label: securityModeLabel(currentState, currentState.session),
          tone: "ready",
        },
        {
          label: remoteAccessStatusText(currentState),
          tone: remoteAccessBadgeTone(currentState),
        },
      ],
      metaLines: [
        `Device ${shortId(currentState.remoteAuth.deviceId)}`,
        `Broker ${currentState.remoteAuth.brokerChannelId} via ${shortId(currentState.remoteAuth.relayPeerId)}`,
        remoteAccessLabel(currentState),
      ],
      title: currentState.remoteAuth.deviceLabel,
    });
  }

  return {
    deviceMeta: {
      cards,
      emptyMessage,
    },
    homeButton: {
      hidden: !currentState.remoteAuth || !(currentState.relayDirectory?.length),
    },
    pairingControls: {
      connectDisabled:
        Boolean(currentState.pairingTicket) && currentState.pairingPhase !== "error",
      connectLabel:
        Boolean(currentState.pairingTicket) && currentState.pairingPhase !== "error"
          ? pairingButtonLabel(currentState)
          : "Pair",
      pairingInputReadOnly:
        Boolean(currentState.pairingTicket) && currentState.pairingPhase !== "error",
    },
    workspaceHeading: currentState.session?.active_thread_id
      ? null
      : {
          sessionPath: "",
          subtitle: workspaceSubtitle(currentState),
          subtitleHidden: !workspaceSubtitle(currentState),
          subtitleTitle: workspaceSubtitle(currentState),
          title: workspaceTitle(currentState),
          titleTitle: "",
        },
  };
}

export function selectStatusBadgeRenderModel(currentState, session = currentState.session) {
  if (selectedRelayNeedsRepair(currentState)) {
    return headerStatusBadge("Re-pair required", "alert");
  }

  if (session) {
    if (session.pending_approvals?.length) {
      return headerStatusBadge("Approval required", "alert");
    }

    if (
      currentState.serverConnectionState === "disconnected"
      || currentState.serverConnectionMessage
      || !currentState.socketConnected
      || !session.provider_connected
    ) {
      return headerStatusBadge("Offline", "offline");
    }

    return quietStatusBadge(session.current_status || "Ready");
  }

  if (currentState.remoteAuth && (
    currentState.serverConnectionState === "disconnected"
      || currentState.serverConnectionMessage
      || (currentState.socketConnected && !currentState.relayConnected && currentState.relayConnectionMessage)
  )) {
    return headerStatusBadge("Server disconnected", "offline");
  }

  if (currentState.socketConnected) {
    return quietStatusBadge("Connected");
  }

  if (currentState.pairingTicket) {
    return pairingBadge(currentState);
  }

  if (!currentState.remoteAuth && currentState.relayDirectory?.length) {
    return quietStatusBadge("Home");
  }

  return headerStatusBadge(currentState.remoteAuth ? "Connecting" : "Offline", "offline");
}

export function selectResetChromeRenderModel(currentState) {
  return {
    controlBanner: { ...NO_CONTROL_BANNER },
    header: {
      sessionPath: "",
      subtitle: workspaceSubtitle(currentState),
      subtitleHidden: !workspaceSubtitle(currentState),
      subtitleTitle: workspaceSubtitle(currentState),
      title: workspaceTitle(currentState),
      titleTitle: "",
    },
    sessionMeta: {
      chips: [],
      emptyMessage: "Pair a remote device to start streaming session details.",
    },
  };
}

function selectSessionMetaRenderModel(currentState, session) {
  return {
    chips: [
      { label: "Status", value: currentStatusLabel(currentState, session) },
      { label: "Security", value: securityModeLabel(currentState, session) },
      { label: "Visibility", value: contentVisibilityLabel(session) },
      { label: "Broker", value: brokerStatusLabel(currentState, session) },
      { label: "Device", value: currentState.remoteAuth?.deviceLabel || "Unpaired" },
      ...(session.provider ? [{ label: "Provider", value: providerLabel(session.provider) }] : []),
      ...(session.model ? [{ label: "Model", value: session.model }] : []),
      ...(session.reasoning_effort ? [{ label: "Effort", value: session.reasoning_effort }] : []),
      {
        label: "Control",
        value: session.view_only
          ? "View only"
          : !session.active_turn_id
          ? "Available"
          : session.active_controller_device_id
          ? controllerLabel(currentState, session.active_controller_device_id)
          : "Unclaimed",
      },
      ...(session.active_thread_id
        ? [{ label: "Session", value: shortId(session.active_thread_id) }]
        : []),
    ],
    emptyMessage: session.active_thread_id ? null : "No live session yet.",
  };
}

/**
 * The banner slot has several claimants and exactly one button, so the priority lives
 * HERE — one ordered function — rather than spread across the renderer.
 *
 * The missing workspace is FIRST, ahead of every control-related claimant. Take-over
 * and the background session's "stop it or take over" both offer to move this device
 * into the session, and there is nothing to move into: the directory the thread records
 * is gone, so a send dies before it reaches the provider. Offering "Take over" there
 * hands the user a button that cannot help and hides the one that can.
 */
function selectControlBannerRenderModel(currentState, session) {
  const repairBanner = selectWorkspaceRepairBanner(currentState, session);
  if (repairBanner) {
    return repairBanner;
  }

  const activeUnderReview = isReviewInProgressForThread(session, session.active_thread_id);
  const activeUnderWorkflow = isWorkflowInProgressForThread(session, session.active_thread_id);
  const activeLockedByAgent = activeUnderReview || activeUnderWorkflow;
  const sessionWorking = sessionIsWorking(session);
  if (session.view_only && sessionWorking && !activeLockedByAgent) {
    return {
      hidden: false,
      hint: "This background session is still running. Stop it or take over to continue here.",
      repair: null,
      summary: "Background session is running",
      summaryTitle: "",
      takeOverHidden: false,
    };
  }
  if (
    !session.active_thread_id
    || !session.active_controller_device_id
    || (!sessionWorking && !activeLockedByAgent)
  ) {
    return { ...NO_CONTROL_BANNER };
  }

  if (isCurrentDeviceActiveController({ remoteAuth: currentState.remoteAuth, session })) {
    return { ...NO_CONTROL_BANNER };
  }

  // Only the thread actually owned by review/workflow is off-limits for take-over.
  return {
    hidden: false,
    hint: activeLockedByAgent
      ? activeUnderWorkflow
        ? "This session is locked by Code Flow; it unlocks when the workflow finishes."
        : "This session is being reviewed; it unlocks when the review finishes."
      : "Read-only for sending until you take over. Approvals can still be handled here.",
    repair: null,
    summary: `Controlled by ${controllerLabel(currentState, session.active_controller_device_id)}`,
    summaryTitle: "",
    takeOverHidden: activeLockedByAgent,
  };
}

/**
 * The viewed thread's workspace is gone → the repair banner, or `null` when there is
 * nothing wrong (in which case the control banner decides as it always did).
 *
 * The verdict comes straight off the snapshot — the relay decides it on the paths that
 * touch the workspace and caches it on the thread runtime — while the BUTTON's state
 * (in flight, last failure) is keyed by thread, so a repair settling after the user
 * swiped away cannot brand the wrong session as broken.
 */
function selectWorkspaceRepairBanner(currentState, session) {
  const threadId = session?.active_thread_id || "";
  if (!threadId) {
    return null;
  }

  const record = readWorkspaceRepair(currentState, threadId);
  const plan = normalizeWorkspaceRepairPlan(session?.workspace_missing);
  if (!plan) {
    return null;
  }

  const { summary, summaryTitle } = workspaceRepairSummary(plan);
  return {
    hidden: false,
    hint: workspaceRepairHint(plan),
    repair: workspaceRepairAction(plan, {
      error: record.error,
      pending: record.pending,
      threadId,
    }),
    summary,
    summaryTitle,
    // There is nothing to take over into until the directory exists again.
    takeOverHidden: true,
  };
}

function securityModeLabel() {
  return "Private";
}

function contentVisibilityLabel() {
  return "E2EE broker-blind";
}

function brokerStatusLabel(currentState, session) {
  if (!session?.broker_channel_id) {
    return currentState.socketConnected ? "Connected" : "Connecting";
  }

  const brokerState = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${brokerState} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${brokerState} · ${channel}`;
}

function controllerLabel(currentState, deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === currentState.remoteAuth?.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function remoteAccessLabel(currentState) {
  if (!currentState.remoteAuth) {
    return "Unpaired";
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return "This browser still knows this relay, but its local encrypted credentials are unavailable. Pair it again on this device to restore remote access.";
  }

  if (!currentState.session?.active_thread_id) {
    return "Standby until you start or open a session";
  }

  if (!currentState.session.active_controller_device_id) {
    return "Standby until you send the first message";
  }

  if (currentState.session.active_controller_device_id === currentState.remoteAuth.deviceId) {
    if (!currentState.remoteAuth.sessionClaim) {
      return "Ready here; control refresh happens automatically when you type";
    }

    if (!currentState.remoteAuth.sessionClaimExpiresAt) {
      return "Ready to type from this browser";
    }

    return `Ready here until ${formatTimestamp(currentState.remoteAuth.sessionClaimExpiresAt)}`;
  }

  return `Viewing while ${controllerLabel(currentState, currentState.session.active_controller_device_id)} has control. Approvals can still be handled here.`;
}

function remoteAccessStatusText(currentState) {
  if (!currentState.remoteAuth) {
    return "Unpaired";
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return "Re-pair required";
  }

  if (!currentState.session?.active_thread_id) {
    return "Standby";
  }

  if (!currentState.session.active_controller_device_id) {
    return "Auto-control";
  }

  if (currentState.session.active_controller_device_id === currentState.remoteAuth.deviceId) {
    return "Ready";
  }

  return "View only";
}

function remoteAccessBadgeTone(currentState) {
  if (!currentState.remoteAuth) {
    return "offline";
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return "alert";
  }

  if (
    currentState.session?.active_thread_id &&
    currentState.session.active_controller_device_id &&
    currentState.session.active_controller_device_id !== currentState.remoteAuth.deviceId
  ) {
    return "alert";
  }

  return "ready";
}

function workspaceTitle(currentState) {
  if (currentState.remoteAuth) {
    return currentState.remoteAuth.relayLabel || "Remote surface ready";
  }
  if (currentState.pairingTicket) {
    return currentState.pairingPhase === "error" ? "Pairing failed" : "Pairing this browser";
  }
  if (currentState.relayDirectory?.length) {
    return "My relays";
  }
  return currentState.clientAuth ? "No relays yet" : "Pair this browser";
}

function workspaceSubtitle(currentState) {
  if (currentState.remoteAuth) {
    if (selectedRelayNeedsRepair(currentState)) {
      return "Local encrypted credentials are unavailable in this browser. Pair this relay again on this device to restore remote access.";
    }
    return "Remote device paired. Start a session, open one from history, or wait for a live session.";
  }
  if (currentState.pairingTicket) {
    return pairingCopy(currentState);
  }
  if (currentState.relayDirectory?.length) {
    return "This browser already has access to one or more relays. Open one from the home view or sidebar, or pair another from your local relay.";
  }
  return currentState.clientAuth
    ? "This browser has a client identity but no relay grants yet. Pair a relay from your local machine to add one here."
    : "Open a pairing QR from your local relay to control Codex remotely.";
}

function currentHeaderPath(currentState, session = currentState.session) {
  if (session?.current_cwd) {
    return session.current_cwd;
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return "Re-pair this relay on this device to restore access.";
  }

  return "";
}

function currentStatusLabel(currentState, session = currentState.session) {
  if (session?.pending_approvals?.length) {
    return "Approval required";
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return "Re-pair required";
  }

  if (session) {
    if (!currentState.socketConnected || !session.provider_connected) {
      return "Offline";
    }

    // Same task language as the alert-only header badge and the local overview — the
    // details panel must not show a raw provider word ("idle"/"active") while
    // everything else reads "Idle"/"Working". Approval / offline / re-pair are
    // handled above; this is the live tail.
    return describeSessionStatus(session).task.label;
  }

  if (currentState.socketConnected) {
    return "Connected";
  }

  if (currentState.pairingTicket) {
    return pairingBadge(currentState).label;
  }

  if (!currentState.remoteAuth && currentState.relayDirectory?.length) {
    return "Home";
  }

  return currentState.remoteAuth ? "Connecting" : "Offline";
}

function pairingHeading(currentState) {
  if (currentState.pairingPhase === "error") {
    return "Pairing needs attention";
  }
  if (currentState.pairingPhase === "requesting") {
    return "Waiting for local approval";
  }
  return "Pairing this browser";
}

function pairingCopy(currentState) {
  if (currentState.pairingPhase === "error") {
    return currentState.pairingError || "Pairing could not complete. Retry from this page or rescan the QR.";
  }
  if (currentState.pairingPhase === "requesting") {
    return "This browser sent its device key to the local relay. Approve it there only if the computer shows the same fingerprint.";
  }
  return "This page is connecting to the broker with the scanned pairing ticket. You should not need to press Pair again.";
}

function pairingBadge(currentState) {
  if (currentState.pairingPhase === "error") {
    return headerStatusBadge("Pairing failed", "alert");
  }
  if (currentState.pairingPhase === "requesting") {
    return headerStatusBadge("Approval pending", "ready");
  }
  return headerStatusBadge("Pairing…", "alert");
}

function pairingButtonLabel(currentState) {
  if (currentState.pairingPhase === "requesting") {
    return "Waiting...";
  }
  return "Pairing...";
}

export function selectedRelayNeedsRepair(currentState) {
  return Boolean(
    currentState.remoteAuth &&
      (currentState.remoteAuth.payloadSecret === null ||
        currentState.remoteAuth.deviceSessionExpired === true)
  );
}
