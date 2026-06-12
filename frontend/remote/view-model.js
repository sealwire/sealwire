import {
  buildThreadGroups,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";
import { workspaceBasename } from "./utils.js";

function createActiveSessionThread(session) {
  if (!session?.active_thread_id || !session.current_cwd) {
    return null;
  }

  return {
    cwd: session.current_cwd,
    id: session.active_thread_id,
    name: workspaceBasename(session.current_cwd),
    provider: session.provider || "",
    preview: session.current_status
      ? `Current session · ${session.current_status}`
      : "Current remote session",
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export function selectSessionRenderModel({ session, previousSession, hasControllerLease }) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  // The active thread is frozen only when it is itself being reviewed; a
  // background review on another thread leaves this conversation usable.
  const activeThreadFrozen = isReviewInProgressForThread(session, session.active_thread_id);
  // A client-local saved-thread projection deliberately has no controller
  // lease. Only the composer gets a targeted-send exception: sending is the
  // take-over, while other writes (for example file rollback/reapply) stay
  // disabled until this device actually controls the live session.
  const viewOnlyComposable = Boolean(session.view_only && !activeThreadFrozen);
  const canWrite = hasControllerLease && !activeThreadFrozen;
  const canCompose = (canWrite || viewOnlyComposable) && hasActiveSession;

  return {
    approval,
    canCompose,
    canWrite,
    composerDisabled: !canCompose,
    currentApprovalId: approval?.request_id || null,
    hasActiveSession,
    hasControllerLease,
    messagePlaceholder: activeThreadFrozen
      ? "This thread is being reviewed…"
      : !hasActiveSession
      ? "Start a remote session first."
      : viewOnlyComposable
        ? "Message this thread to take control..."
      : hasControllerLease
        ? "Message Codex remotely..."
        : "Another device has control. Take over to reply.",
    scrollDebug: {
      thread: session.active_thread_id || "-",
      prevThread: previousSession?.active_thread_id || "-",
      entries: session.transcript?.length || 0,
      truncated: session.transcript_truncated ? "1" : "0",
      status: session.current_status || "-",
    },
  };
}

export function selectThreadsRenderModel({
  threads,
  activeThreadId,
  error,
  loading,
  remoteAuth,
  relayDirectory,
  session,
}) {
  let normalizedThreads = Array.isArray(threads) ? [...threads] : [];
  if (
    session?.active_thread_id
    && !normalizedThreads.some((thread) => thread?.id === session.active_thread_id)
  ) {
    const activeSessionThread = createActiveSessionThread(session);
    if (activeSessionThread) {
      normalizedThreads = [activeSessionThread, ...normalizedThreads];
    }
  }

  const groups = buildThreadGroups(normalizedThreads, {
    includeUnknownWorkspace: true,
  });

  if (!remoteAuth) {
    return {
      activeThreadId,
      countLabel: "Remote session history",
      emptyMessage: relayDirectory?.length
        ? "Open a relay to view its session history."
        : "Pair a relay, then refresh remote history.",
      groups: [],
    };
  }

  if (error) {
    return {
      activeThreadId,
      countLabel: "Error",
      emptyMessage: error,
      groups: [],
    };
  }

  return {
    activeThreadId,
    countLabel: loading ? "Loading..." : summarizeThreadGroups(groups),
    emptyMessage: groups.length ? null : "No remote sessions found yet.",
    groups,
  };
}

export function selectRelayDirectoryRenderModel({ relayDirectory, activeRelayId, nicknames }) {
  const relays = relayDirectory || [];
  const nicknameMap = nicknames || {};

  return {
    countLabel: `${relays.length} ${relays.length === 1 ? "relay" : "relays"}`,
    emptyMessage: relays.length
      ? null
      : "Pair a relay from your local machine to add it here.",
    items: relays.map((relay) => {
      const id = relay.relayId || relay.brokerRoomId || relay.deviceId || "";
      const nickname = nicknameMap[relay.relayId] || null;
      return {
        active: activeRelayId === relay.relayId,
        actionLabel: relay.hasLocalProfile
          ? "Open relay"
          : relay.needsLocalRePairing
            ? "Re-pair relay"
            : "Pair again",
        id,
        isEnabled: Boolean(relay.hasLocalProfile && id),
        meta: nickname ? (relay.relayId || relay.brokerRoomId || relay.deviceId || "") : "",
        relay,
        title:
          nickname
          || relay.relayLabel
          || relay.relayId
          || relay.brokerRoomId
          || relay.deviceLabel
          || relay.deviceId
          || "Unknown relay",
      };
    }),
  };
}

export function selectEmptyStateRenderModel({
  clientAuth,
  pairingTicket,
  relayDirectory,
  remoteAuth,
  relayConnected,
  relayConnectionMessage,
  serverConnectionMessage,
  serverConnectionState,
  socketConnected,
}) {
  const showServerDisconnected = Boolean(
    remoteAuth
      && (
        serverConnectionState === "disconnected"
        || serverConnectionMessage
        || (socketConnected && !relayConnected && relayConnectionMessage)
      )
  );

  return {
    clientAuth,
    relayDirectory,
    remoteAuth,
    showMissingCredentials: Boolean(remoteAuth && !remoteAuth.payloadSecret && !pairingTicket),
    showRelayHome: Boolean(!remoteAuth && !pairingTicket),
    showServerDisconnected,
    serverDisconnectedCopy:
      serverConnectionMessage
      || relayConnectionMessage
      || "Server disconnected. Waiting for it to reconnect.",
  };
}
