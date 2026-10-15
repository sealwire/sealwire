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
import { describeSessionStatus } from "../shared/session-status.js";
import {
  normalizeWorkspaceRepairPlan,
  readWorkspaceRepair,
  workspaceRepairAction,
  workspaceRepairHint,
  workspaceRepairSummary,
} from "./workspace-repair.js";
import { surfaceText } from "./surface-wording.js";
import { t } from "../shared/i18n.js";

// Nothing is claiming the banner. Every branch returns this SHAPE (never a subset) so
// the renderer can read `repair`/`summaryTitle` without guarding each field.
const NO_CONTROL_BANNER = Object.freeze({
  hidden: true,
  hint: "",
  repair: null,
  summary: "",
  summaryTitle: "",
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
    return headerStatusBadge(t("Approval required"), "alert");
  }
  if (selectedRelayNeedsRepair(currentState)) {
    return headerStatusBadge(t("Re-pair required"), "alert");
  }
  if (isSessionOffline(currentState, session)) {
    return headerStatusBadge(t("Offline"), "offline");
  }
  // Surface the under-review state in the header (parity with local) — the remote
  // surface previously only froze the composer, so a remote user had no "Review in
  // progress / blocked" indicator. Shared helper → identical wording/tone to local.
  if (isWorkflowBlocked(session)) {
    return headerStatusBadge(t("Code Flow blocked — action needed"), "alert");
  }
  const review = reviewStatusBadge(session, session.active_thread_id);
  if (review) {
    return headerStatusBadge(review.label, review.tone);
  }
  if (isWorkflowInProgressForThread(session, session.active_thread_id)) {
    return headerStatusBadge(t("Code Flow in progress"), "alert");
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
    return { hidden: false, label: t("Stalled?"), tone: "alert" };
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
      ? t("Open one of your relays from home or the sidebar to enter its remote surface.")
      : t(surfaceText("No paired remote device is stored in this browser yet."))
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
          ? [
              t("{id} · expires {time}", {
                id: shortId(ticket.pairing_id),
                time: formatTimestamp(ticket.expires_at),
              }),
            ]
          : []),
        pairingCopy(currentState),
        ...(currentState.pairingPhase === "requesting" && currentState.pairingFingerprint
          ? [t("Fingerprint {fingerprint}", { fingerprint: currentState.pairingFingerprint })]
          : []),
      ],
      title: pairingHeading(currentState),
    });
  }

  if (currentState.remoteAuth) {
    cards.push({
      badges: [
        {
          label: selectedRelayNeedsRepair(currentState) ? t("Re-pair required") : t("Paired"),
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
        t("Device {id}", { id: shortId(currentState.remoteAuth.deviceId) }),
        t("Broker {channel} via {peer}", {
          channel: currentState.remoteAuth.brokerChannelId,
          peer: shortId(currentState.remoteAuth.relayPeerId),
        }),
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
          : t("Pair"),
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
    return headerStatusBadge(t("Re-pair required"), "alert");
  }

  if (session) {
    if (session.pending_approvals?.length) {
      return headerStatusBadge(t("Approval required"), "alert");
    }

    if (
      currentState.serverConnectionState === "disconnected"
      || currentState.serverConnectionMessage
      || !currentState.socketConnected
      || !session.provider_connected
    ) {
      return headerStatusBadge(t("Offline"), "offline");
    }

    return quietStatusBadge(session.current_status || t("Ready"));
  }

  if (currentState.remoteAuth && (
    currentState.serverConnectionState === "disconnected"
      || currentState.serverConnectionMessage
      || (currentState.socketConnected && !currentState.relayConnected && currentState.relayConnectionMessage)
  )) {
    return headerStatusBadge(t("Server disconnected"), "offline");
  }

  if (currentState.socketConnected) {
    return quietStatusBadge(t("Connected"));
  }

  if (currentState.pairingTicket) {
    return pairingBadge(currentState);
  }

  if (!currentState.remoteAuth && currentState.relayDirectory?.length) {
    return quietStatusBadge(t("Home"));
  }

  return headerStatusBadge(currentState.remoteAuth ? t("Connecting") : t("Offline"), "offline");
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
      emptyMessage: t("Pair a remote device to start streaming session details."),
    },
  };
}

function selectSessionMetaRenderModel(currentState, session) {
  return {
    chips: [
      { label: t("Status"), value: currentStatusLabel(currentState, session) },
      { label: t("Security"), value: securityModeLabel(currentState, session) },
      { label: t("Visibility"), value: contentVisibilityLabel(session) },
      { label: "Broker", value: brokerStatusLabel(currentState, session) },
      { label: t("Device"), value: currentState.remoteAuth?.deviceLabel || t("Unpaired") },
      ...(session.provider ? [{ label: t("Provider"), value: providerLabel(session.provider) }] : []),
      ...(session.model ? [{ label: t("Model"), value: session.model }] : []),
      ...(session.reasoning_effort ? [{ label: t("Effort"), value: session.reasoning_effort }] : []),
      ...(session.active_thread_id
        ? [{ label: t("Session"), value: shortId(session.active_thread_id) }]
        : []),
    ],
    emptyMessage: session.active_thread_id ? null : t("No live session yet."),
  };
}

// The missing workspace outranks the lock: until the directory is back, nothing sent
// to this thread can reach the provider, and the repair button is the only way forward.
function selectControlBannerRenderModel(currentState, session) {
  const repairBanner = selectWorkspaceRepairBanner(currentState, session);
  if (repairBanner) {
    return repairBanner;
  }

  const threadId = session.active_thread_id;
  if (isWorkflowInProgressForThread(session, threadId)) {
    return {
      ...NO_CONTROL_BANNER,
      hidden: false,
      hint: t("This session is locked by Code Flow; it unlocks when the workflow finishes."),
      summary: t("Code Flow in progress"),
    };
  }
  if (isReviewInProgressForThread(session, threadId)) {
    return {
      ...NO_CONTROL_BANNER,
      hidden: false,
      hint: t("This session is being reviewed; it unlocks when the review finishes."),
      summary: t("Review in progress"),
    };
  }
  return { ...NO_CONTROL_BANNER };
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
  };
}

function securityModeLabel() {
  return t("Private");
}

function contentVisibilityLabel() {
  return t("E2EE broker-blind");
}

function brokerStatusLabel(currentState, session) {
  if (!session?.broker_channel_id) {
    return currentState.socketConnected ? t("Connected") : t("Connecting");
  }

  const brokerState = session.broker_connected ? t("Connected") : t("Offline");
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${brokerState} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${brokerState} · ${channel}`;
}

function remoteAccessLabel(currentState) {
  if (!currentState.remoteAuth) {
    return t("Unpaired");
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return t(surfaceText("This browser still knows this relay, but its local encrypted credentials are unavailable. Pair it again on this device to restore remote access."));
  }

  if (!currentState.session?.active_thread_id) {
    return t("Standby until you start or open a session");
  }

  if (!currentState.remoteAuth.sessionClaim) {
    return t("Ready here; access refreshes automatically when you type");
  }

  if (!currentState.remoteAuth.sessionClaimExpiresAt) {
    return t(surfaceText("Ready to type from this browser"));
  }

  return t("Ready here until {time}", {
    time: formatTimestamp(currentState.remoteAuth.sessionClaimExpiresAt),
  });
}

function remoteAccessStatusText(currentState) {
  if (!currentState.remoteAuth) {
    return t("Unpaired");
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return t("Re-pair required");
  }

  if (!currentState.session?.active_thread_id) {
    return t("Standby");
  }

  return t("Ready");
}

function remoteAccessBadgeTone(currentState) {
  if (!currentState.remoteAuth) {
    return "offline";
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return "alert";
  }

  return "ready";
}

function workspaceTitle(currentState) {
  if (currentState.remoteAuth) {
    return currentState.remoteAuth.relayLabel || t("Remote surface ready");
  }
  if (currentState.pairingTicket) {
    return currentState.pairingPhase === "error" ? t("Pairing failed") : t(surfaceText("Pairing this browser"));
  }
  if (currentState.relayDirectory?.length) {
    return t("My relays");
  }
  return currentState.clientAuth ? t("No relays yet") : t(surfaceText("Pair this browser"));
}

function workspaceSubtitle(currentState) {
  if (currentState.remoteAuth) {
    if (selectedRelayNeedsRepair(currentState)) {
      return t(surfaceText("Local encrypted credentials are unavailable in this browser. Pair this relay again on this device to restore remote access."));
    }
    return t("Remote device paired. Start a session, open one from history, or wait for a live session.");
  }
  if (currentState.pairingTicket) {
    return pairingCopy(currentState);
  }
  if (currentState.relayDirectory?.length) {
    return t(surfaceText("This browser already has access to one or more relays. Open one from the home view or sidebar, or pair another from your local relay."));
  }
  return currentState.clientAuth
    ? t(surfaceText("This browser has a client identity but no relay grants yet. Pair a relay from your local machine to add one here."))
    : t("Open a pairing QR from your local relay to control Codex remotely.");
}

function currentHeaderPath(currentState, session = currentState.session) {
  if (session?.current_cwd) {
    return session.current_cwd;
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return t("Re-pair this relay on this device to restore access.");
  }

  return "";
}

function currentStatusLabel(currentState, session = currentState.session) {
  if (session?.pending_approvals?.length) {
    return t("Approval required");
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return t("Re-pair required");
  }

  if (session) {
    if (!currentState.socketConnected || !session.provider_connected) {
      return t("Offline");
    }

    // Same task language as the alert-only header badge and the local overview — the
    // details panel must not show a raw provider word ("idle"/"active") while
    // everything else reads "Idle"/"Working". Approval / offline / re-pair are
    // handled above; this is the live tail.
    return describeSessionStatus(session).task.label;
  }

  if (currentState.socketConnected) {
    return t("Connected");
  }

  if (currentState.pairingTicket) {
    return pairingBadge(currentState).label;
  }

  if (!currentState.remoteAuth && currentState.relayDirectory?.length) {
    return t("Home");
  }

  return currentState.remoteAuth ? t("Connecting") : t("Offline");
}

function pairingHeading(currentState) {
  if (currentState.pairingPhase === "error") {
    return t("Pairing needs attention");
  }
  if (currentState.pairingPhase === "requesting") {
    return t("Waiting for local approval");
  }
  return t(surfaceText("Pairing this browser"));
}

function pairingCopy(currentState) {
  if (currentState.pairingPhase === "error") {
    return currentState.pairingError || t("Pairing could not complete. Retry from this page or rescan the QR.");
  }
  if (currentState.pairingPhase === "requesting") {
    return t(surfaceText("This browser sent its device key to the local relay. Approve it there only if the computer shows the same fingerprint."));
  }
  return t("This page is connecting to the broker with the scanned pairing ticket. You should not need to press Pair again.");
}

function pairingBadge(currentState) {
  if (currentState.pairingPhase === "error") {
    return headerStatusBadge(t("Pairing failed"), "alert");
  }
  if (currentState.pairingPhase === "requesting") {
    return headerStatusBadge(t("Approval pending"), "ready");
  }
  return headerStatusBadge(t("Pairing…"), "alert");
}

function pairingButtonLabel(currentState) {
  if (currentState.pairingPhase === "requesting") {
    return t("Waiting...");
  }
  return t("Pairing...");
}

export function selectedRelayNeedsRepair(currentState) {
  return Boolean(
    currentState.remoteAuth &&
      (currentState.remoteAuth.payloadSecret === null ||
        currentState.remoteAuth.deviceSessionExpired === true)
  );
}
