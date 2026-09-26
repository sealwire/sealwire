import { isWorkingThreadStatus } from "./thread-status.js";

export const VIEW_ONLY_CONTROLLER_DEVICE_ID = "__view_only__";

export function selectDisplayedSessionModel({
  liveSession = null,
  viewedThreadId = null,
  viewedThread = null,
  liveActivityServerTime = null,
  viewOnlySessionPatch = null,
} = {}) {
  if (!liveSession) {
    return {
      liveSession,
      viewedThread: null,
      displayedSession: null,
      mode: "none",
    };
  }

  const threadId = stringId(viewedThreadId);
  if (
    !threadId
    || !viewedThread
    || viewedThread.threadId !== threadId
    || threadId === liveSession.active_thread_id
  ) {
    return {
      liveSession,
      viewedThread: null,
      displayedSession: scopeApprovalsToActiveThread(liveSession),
      mode: "live",
    };
  }

  const normalized = normalizeViewedThread(viewedThread, threadId);
  const activity = (liveSession.thread_activity || []).find(
    (entry) => entry?.thread_id === threadId
  );
  const explicitTurnId = normalized.activeTurnId || null;
  const explicitStatus =
    normalized.currentStatus == null ? "" : String(normalized.currentStatus).trim();
  const hasExplicitThreadState = Boolean(explicitTurnId || explicitStatus);
  const explicitWorking = Boolean(
    explicitTurnId || (explicitStatus && isWorkingThreadStatus(explicitStatus))
  );
  const refreshTime = serverTimeSeconds(normalized.refreshServerTime);
  const snapshotTime = serverTimeSeconds(
    liveActivityServerTime ?? liveSession.thread_activity_server_time ?? liveSession.server_time
  );
  const activityFreshEnough = !refreshTime || !snapshotTime || snapshotTime >= refreshTime;
  const isWorking = explicitWorking || Boolean(
    activity && (!hasExplicitThreadState || activityFreshEnough)
  );
  const currentPhase = isWorking
    ? normalized.currentPhase ?? activity?.phase ?? null
    : null;
  const currentTool = isWorking
    ? normalized.currentTool ?? activity?.tool ?? null
    : null;

  const displayedSession = {
    ...liveSession,
    active_thread_id: threadId,
    active_turn_id: explicitTurnId || (isWorking ? `view:${threadId}` : null),
    pending_approvals: filterThreadItems(liveSession.pending_approvals, threadId),
    pending_ask_user_questions: filterThreadItems(
      liveSession.pending_ask_user_questions,
      threadId
    ),
    active_controller_device_id: VIEW_ONLY_CONTROLLER_DEVICE_ID,
    transcript: normalized.entries,
    transcript_truncated: normalized.transcriptTruncated,
    current_status: normalized.currentStatus
      || (isWorking ? "active" : settledThreadStatus(normalized.status)),
    current_phase: currentPhase,
    current_tool: currentTool,
    last_progress_at: normalized.lastProgressAt ?? null,
    current_cwd: normalized.currentCwd ?? "",
    thread_workspace_cwd: normalized.threadWorkspaceCwd ?? "",
    provider: normalized.provider ?? "",
    model: normalized.model ?? "",
    reasoning_effort: normalized.reasoningEffort ?? "",
    approval_policy: normalized.approvalPolicy ?? "",
    sandbox: normalized.sandbox ?? "",
    available_models: normalized.availableModels,
    reviewer_threads: normalized.reviewerThreads ?? liveSession.reviewer_threads ?? [],
    review_locked: Boolean(normalized.reviewLocked),
    workflow_locked: Boolean(normalized.workflowLocked),
    settings_writable: Boolean(normalized.settingsWritable),
    active_thread_task_reviewer: Boolean(normalized.taskReviewer),
    view_only: true,
    ...(viewOnlySessionPatch || {}),
  };

  if (normalized.transcriptRevision !== undefined) {
    displayedSession.transcript_revision = normalized.transcriptRevision;
  }

  return {
    liveSession,
    viewedThread: normalized,
    displayedSession,
    mode: "viewed",
  };
}

export function selectDisplayedSession(args = {}) {
  return selectDisplayedSessionModel(args).displayedSession;
}

export function settledThreadStatus(status) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return normalized === "active" || normalized === "running" || normalized === "working"
    ? "idle"
    : status || "idle";
}

export function serverTimeSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function normalizeViewedThread(viewedThread, threadId) {
  const hasTranscriptTruncated = typeof viewedThread.transcriptTruncated === "boolean";
  const hasReviewerThreads = hasOwn(viewedThread, "reviewerThreads");
  return {
    threadId,
    entries: Array.isArray(viewedThread.entries) ? viewedThread.entries : [],
    transcriptRevision: viewedThread.transcriptRevision,
    transcriptTruncated: hasTranscriptTruncated
      ? viewedThread.transcriptTruncated
      : viewedThread.olderCursor != null,
    activeTurnId: viewedThread.activeTurnId || null,
    currentStatus: viewedThread.currentStatus,
    currentPhase: viewedThread.currentPhase ?? null,
    currentTool: viewedThread.currentTool ?? null,
    lastProgressAt: viewedThread.lastProgressAt ?? null,
    currentCwd: viewedThread.currentCwd ?? "",
    threadWorkspaceCwd: viewedThread.threadWorkspaceCwd ?? "",
    provider: viewedThread.provider ?? "",
    model: viewedThread.model ?? "",
    reasoningEffort: viewedThread.reasoningEffort ?? "",
    approvalPolicy: viewedThread.approvalPolicy ?? "",
    sandbox: viewedThread.sandbox ?? "",
    availableModels: viewedThread.availableModels || [],
    reviewerThreads: hasReviewerThreads
      ? (Array.isArray(viewedThread.reviewerThreads) ? viewedThread.reviewerThreads : [])
      : undefined,
    reviewLocked: Boolean(viewedThread.reviewLocked),
    workflowLocked: Boolean(viewedThread.workflowLocked),
    settingsWritable: Boolean(viewedThread.settingsWritable),
    taskReviewer: Boolean(viewedThread.taskReviewer),
    status: viewedThread.status,
    refreshServerTime: viewedThread.refreshServerTime,
  };
}

function filterThreadItems(items, threadId) {
  return (items || []).filter((entry) => entry?.thread_id === threadId);
}

// No fallback for a missing thread id: the relay declines any approval it cannot
// attribute, so guessing here could only put one in the wrong session.
function approvalBelongsToThread(approval, threadId) {
  return Boolean(threadId) && approval?.thread_id === threadId;
}

export function pendingApprovalForThread(session, threadId) {
  return (
    (session?.pending_approvals || []).find((approval) =>
      approvalBelongsToThread(approval, threadId)
    ) || null
  );
}

// The snapshot lists every thread's approvals; a background thread's must not
// land in the conversation on screen, where Approve would answer it blind.
export function scopeApprovalsToActiveThread(session) {
  const approvals = session?.pending_approvals;
  if (!Array.isArray(approvals)) {
    return session;
  }
  const activeThreadId = session.active_thread_id || null;
  const own = approvals.filter((approval) => approvalBelongsToThread(approval, activeThreadId));
  // Same object when nothing is hidden, so memoized consumers do not re-render.
  return own.length === approvals.length ? session : { ...session, pending_approvals: own };
}

function stringId(value) {
  return typeof value === "string" && value ? value : null;
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(Object(object), property);
}
