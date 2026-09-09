import {
  buildNavigationThreadGroups,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";
import { isWorkflowInProgressForThread } from "../shared/workflow-state.js";
import { canComposeThread } from "../shared/thread-compose.js";
import { providerLabel } from "../shared/provider-labels.js";
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

// A frozen thread (under review / Code Flow) is driven by the orchestrator, so
// its AskUser prompts are not the human's to answer — hide them. `sessionView`
// is null until a session exists (fresh remote.html load) and the transcript
// panel renders before then, so this must never assume a model is there.
//
// The thread filter is the other half of the same rule, and it has to be enforced
// here rather than left to the transcript: a question whose row has not loaded is
// rendered from the REQUEST, so there is no entry to imply which conversation it
// belongs to. `activeThreadId` is optional only so the frozen check stays usable
// before a session exists.
export function visiblePendingAskUserQuestions(
  sessionView,
  pendingAskUserQuestions,
  activeThreadId = null
) {
  if (sessionView?.activeThreadFrozen) {
    return [];
  }
  const requests = Array.isArray(pendingAskUserQuestions) ? pendingAskUserQuestions : [];
  if (!activeThreadId) {
    return pendingAskUserQuestions;
  }
  return requests.filter(
    (request) => (request?.thread_id || activeThreadId) === activeThreadId
  );
}

export function selectSessionRenderModel({ session, previousSession, hasControllerLease }) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  // The active thread is frozen only when it is itself owned by review/workflow;
  // background work on another thread leaves this conversation usable.
  const activeThreadUnderReview = isReviewInProgressForThread(session, session.active_thread_id);
  const activeThreadUnderWorkflow = isWorkflowInProgressForThread(
    session,
    session.active_thread_id
  );
  const activeThreadFrozen = activeThreadUnderReview || activeThreadUnderWorkflow;
  const canWrite = hasControllerLease && !activeThreadFrozen;
  // Sending to an idle thread is itself the atomic claim. The relay serializes
  // concurrent sends, so no separate take-over step is needed.
  const taskReviewer = Boolean(session.active_thread_task_reviewer);
  const canCompose = canComposeThread({
    activeTurnId: session.active_turn_id,
    hasActiveSession,
    hasControllerLease,
    reviewLocked: activeThreadFrozen,
    taskReviewer,
  });

  return {
    approval,
    canCompose,
    canWrite,
    composerDisabled: !canCompose,
    currentApprovalId: approval?.request_id || null,
    hasActiveSession,
    hasControllerLease,
    activeThreadFrozen,
    activeThreadUnderWorkflow,
    taskReviewer,
    // Checked before `activeThreadFrozen` so a reviewer that is also mid-review
    // still reads as permanently closed rather than temporarily busy.
    messagePlaceholder: taskReviewer
      ? "This is a task reviewer — read only."
      : activeThreadFrozen
      ? activeThreadUnderWorkflow
        ? "This session is locked by Code Flow…"
        : "This session is being reviewed…"
      : !hasActiveSession
      ? "Start a remote session first."
      : canCompose
        // Derive the agent name from the active thread's own provider — a Claude
        // thread must read "Message Claude...", never a hardcoded "Codex".
        ? (providerLabel(session.provider)
          ? `Message ${providerLabel(session.provider)} remotely...`
          : "Message remotely...")
        : "This session is currently running on another device.",
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
  // The Project switcher's selection, ALREADY run through `selectPinnedProjectId`
  // by the caller — that policy is where "a search or the bell stands the pin down"
  // lives, and it is deliberately not re-decided here.
  //
  // This replaced a `viewMode` that swapped the grouping axis between cwd and
  // project. A pin is additive instead: it lifts one project's sessions to the top
  // and leaves everything else exactly where it was, so there is no mode in which
  // the list is anything but complete.
  pinnedProjectId = null,
  projects = [],
  threadProjectId = {},
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

  // No fail-closed gate on the Projects payload any more, and that is a deliberate
  // reversal rather than an omission. Projects MODE had to withhold the list until
  // the payload was fresh, because a stale membership map would have mis-grouped
  // every row. A pin can only mis-place the rows it lifts: an unresolved project id
  // degrades to plain cwd grouping (`resolvePinnedProject`), which shows every
  // session correctly and merely fails to lift one group. Blanking a complete list
  // behind "Loading projects…" is the worse answer to "not yet sorted" — and on a
  // phone it also meant a refresh emptied a sidebar that was entirely correct.
  const groups = buildNavigationThreadGroups(normalizedThreads, {
    pinnedProjectId,
    projects,
    threadProjectId,
  });

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
  const showMissingCredentials = Boolean(
    remoteAuth &&
      (remoteAuth.payloadSecret === null || remoteAuth.deviceSessionExpired === true) &&
      !pairingTicket
  );
  const showServerDisconnected = Boolean(
    remoteAuth
      && !showMissingCredentials
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
    showMissingCredentials,
    showRelayHome: Boolean(!remoteAuth && !pairingTicket),
    showServerDisconnected,
    serverDisconnectedCopy:
      serverConnectionMessage
      || relayConnectionMessage
      || "Server disconnected. Waiting for it to reconnect.",
  };
}
