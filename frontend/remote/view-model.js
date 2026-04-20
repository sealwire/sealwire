import {
  buildThreadGroups,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import { workspaceBasename } from "./utils.js";

function createActiveSessionThread(session) {
  if (!session?.active_thread_id || !session.current_cwd) {
    return null;
  }

  return {
    cwd: session.current_cwd,
    id: session.active_thread_id,
    name: workspaceBasename(session.current_cwd),
    preview: session.current_status
      ? `Current session · ${session.current_status}`
      : "Current remote session",
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export function selectSessionRenderModel({ session, previousSession, hasControllerLease }) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);

  return {
    approval,
    canWrite: hasControllerLease,
    composerDisabled: !hasActiveSession || !hasControllerLease,
    currentApprovalId: approval?.request_id || null,
    hasActiveSession,
    hasControllerLease,
    cwdFilterHint: session.current_cwd
      ? {
          placeholder: `Optional exact path filter (current: ${workspaceBasename(session.current_cwd)})`,
          title: session.current_cwd,
        }
      : null,
    messagePlaceholder: !hasActiveSession
      ? "Start a remote session first."
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
  filterValue,
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

  const groups = buildThreadGroups(normalizedThreads);

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
    emptyMessage: groups.length
      ? null
      : filterValue
        ? "No remote sessions found for this workspace filter."
        : "No remote sessions found yet.",
    groups,
  };
}

export function selectRelayDirectoryRenderModel({ relayDirectory, activeRelayId }) {
  const relays = relayDirectory || [];

  return {
    countLabel: `${relays.length} ${relays.length === 1 ? "relay" : "relays"}`,
    emptyMessage: relays.length
      ? null
      : "Pair a relay from your local machine to add it here.",
    items: relays.map((relay) => ({
      active: activeRelayId === relay.relayId,
      actionLabel: relay.hasLocalProfile
        ? "Open relay"
        : relay.needsLocalRePairing
          ? "Re-pair relay"
          : "Pair again",
      id: relay.relayId || relay.brokerRoomId || relay.deviceId || "",
      isEnabled: Boolean(relay.hasLocalProfile && (relay.relayId || relay.brokerRoomId || relay.deviceId)),
      meta: relay.brokerRoomId || relay.relayId || relay.deviceId || "",
      relay,
      title:
        relay.relayLabel
        || relay.relayId
        || relay.brokerRoomId
        || relay.deviceLabel
        || relay.deviceId
        || "Unknown relay",
    })),
  };
}

export function selectEmptyStateRenderModel({
  clientAuth,
  pairingTicket,
  relayDirectory,
  remoteAuth,
}) {
  return {
    clientAuth,
    relayDirectory,
    remoteAuth,
    showMissingCredentials: Boolean(remoteAuth && !remoteAuth.payloadSecret && !pairingTicket),
    showRelayHome: Boolean(!remoteAuth && !pairingTicket),
  };
}
