import { formatTimestamp, shortId, workspaceBasename } from "./utils.js";

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
  const headerSubtitle = headerPath || workspaceSubtitle(currentState);

  return {
    controlBanner: selectControlBannerRenderModel(currentState, session),
    header: {
      sessionPath: headerPath,
      subtitle: headerSubtitle,
      subtitleHidden: !headerSubtitle,
      subtitleTitle: headerPath || headerSubtitle,
      title: hasActiveSession ? workspaceName : workspaceTitle(currentState),
      titleTitle: session.current_cwd || "",
    },
    sessionMeta: selectSessionMetaRenderModel(currentState, session),
    statusBadge: approval
      ? { label: "Approval required", tone: "alert" }
      : !currentState.socketConnected || !session.codex_connected
        ? { label: "Offline", tone: "offline" }
        : { label: session.current_status || "Ready", tone: "ready" },
  };
}

export function selectDeviceChromeRenderModel(currentState) {
  const emptyMessage = !currentState.remoteAuth && !currentState.pairingTicket
    ? currentState.relayDirectory?.length
      ? "Open one of your relays from home or the sidebar to enter its remote surface."
      : "No paired remote device is stored in this browser yet."
    : null;

  const cards = [];
  if (currentState.pairingTicket) {
    cards.push({
      badges: [
        {
          label: pairingBadgeText(currentState),
          tone: pairingBadgeTone(currentState),
        },
      ],
      metaLines: [
        `${shortId(currentState.pairingTicket.pairing_id)} · expires ${formatTimestamp(currentState.pairingTicket.expires_at)}`,
        pairingCopy(currentState),
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
          tone: currentState.remoteAuth.securityMode === "managed" ? "alert" : "ready",
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
  if (session) {
    if (session.pending_approvals?.length) {
      return { label: "Approval required", tone: "alert" };
    }

    if (!currentState.socketConnected || !session.codex_connected) {
      return { label: "Offline", tone: "offline" };
    }

    return { label: session.current_status || "Ready", tone: "ready" };
  }

  if (currentState.socketConnected) {
    return { label: "Connected", tone: "ready" };
  }

  if (currentState.pairingTicket) {
    return {
      label: pairingBadgeText(currentState),
      tone: pairingBadgeTone(currentState),
    };
  }

  if (!currentState.remoteAuth && currentState.relayDirectory?.length) {
    return { label: "Home", tone: "ready" };
  }

  if (selectedRelayNeedsRepair(currentState)) {
    return { label: "Re-pair required", tone: "alert" };
  }

  return {
    label: currentState.remoteAuth ? "Connecting" : "Offline",
    tone: "offline",
  };
}

export function selectResetChromeRenderModel(currentState) {
  return {
    controlBanner: {
      hidden: true,
      hint: "",
      summary: "",
      takeOverHidden: true,
    },
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
      {
        label: "Control",
        value: session.active_controller_device_id
          ? controllerLabel(currentState, session.active_controller_device_id)
          : "Unclaimed",
      },
      ...(session.active_thread_id
        ? [{ label: "Thread", value: shortId(session.active_thread_id) }]
        : []),
    ],
    emptyMessage: session.active_thread_id ? null : "No live session yet.",
  };
}

function selectControlBannerRenderModel(currentState, session) {
  if (!session.active_thread_id || !session.active_controller_device_id) {
    return {
      hidden: true,
      hint: "",
      summary: "",
      takeOverHidden: true,
    };
  }

  if (isCurrentDeviceActiveController({ remoteAuth: currentState.remoteAuth, session })) {
    return {
      hidden: true,
      hint: "",
      summary: "",
      takeOverHidden: true,
    };
  }

  return {
    hidden: false,
    hint: "Read-only for sending until you take over. Approvals can still be handled here.",
    summary: `Controlled by ${controllerLabel(currentState, session.active_controller_device_id)}`,
    takeOverHidden: false,
  };
}

function securityModeLabel(currentState, session) {
  const mode = session?.security_mode || currentState.remoteAuth?.securityMode || "private";
  return mode === "managed" ? "Managed" : "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Org-readable + audit" : "Readable";
  }
  return session?.e2ee_enabled ? "E2EE broker-blind" : "Broker-blind";
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
    return "Standby until you start or resume a session";
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
    return "Remote device paired. Start a session, resume one from history, or wait for a live thread.";
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
    if (!currentState.socketConnected || !session.codex_connected) {
      return "Offline";
    }

    return session.current_status || "Ready";
  }

  if (currentState.socketConnected) {
    return "Connected";
  }

  if (currentState.pairingTicket) {
    return pairingBadgeText(currentState);
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
    return "This browser sent its device key to the local relay and is waiting for local approval.";
  }
  return "This page is connecting to the broker with the scanned pairing ticket. You should not need to press Pair again.";
}

function pairingBadgeText(currentState) {
  if (currentState.pairingPhase === "error") {
    return "Pairing failed";
  }
  if (currentState.pairingPhase === "requesting") {
    return "Approval pending";
  }
  return "Pairing…";
}

function pairingBadgeTone(currentState) {
  if (currentState.pairingPhase === "error") {
    return "alert";
  }
  if (currentState.pairingPhase === "requesting") {
    return "ready";
  }
  return "alert";
}

function pairingButtonLabel(currentState) {
  if (currentState.pairingPhase === "requesting") {
    return "Waiting...";
  }
  return "Pairing...";
}

function selectedRelayNeedsRepair(currentState) {
  return Boolean(currentState.remoteAuth && !currentState.remoteAuth.payloadSecret);
}
