import { providerOptions } from "./provider-settings.js";
import { isReviewInProgress } from "./review-state.js";
import { isWorkingThreadStatus } from "./thread-status.js";

const TERMINAL_WORKFLOW_STATUSES = new Set([
  "done",
  "escalated",
  "failed",
  "interrupted",
  "cancelled",
]);

const WORKFLOW_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  resolving: "Resolving",
  done: "Approved",
  escalated: "Needs attention",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

const WORKFLOW_STEP_LABELS = {
  execute: "Authoring",
  review: "Reviewing",
  revise: "Revising",
};

const CODE_FLOW_REVIEWER_PROVIDERS = new Set(["codex", "fake"]);

export function isTerminalWorkflowStatus(status) {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function workflowStatusLabel(status) {
  return WORKFLOW_STATUS_LABELS[status] || status || "Running";
}

export function workflowStepLabel(step) {
  return WORKFLOW_STEP_LABELS[step] || step || "";
}

export function workflowChipTone(status) {
  if (
    status === "failed" ||
    status === "escalated" ||
    status === "interrupted" ||
    status === "blocked"
  ) {
    return "alert";
  }
  if (status === "done") return "ready";
  return "active";
}

function activeWorkflowRunning(session) {
  return (session?.active_workflow_runs || []).some(
    (run) => !TERMINAL_WORKFLOW_STATUSES.has(run?.status)
  );
}

export function isWorkflowBlocked(session) {
  return (session?.active_workflow_runs || []).some((run) => run?.status === "blocked");
}

export function isWorkflowInProgressForThread(session, threadId) {
  if (!threadId) return false;
  const runs = session?.active_workflow_runs || [];
  if (runs.some((run) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(run?.status)) return false;
    if (run?.parent_thread_id === threadId) return true;
    return Array.isArray(run?.locked_thread_ids) && run.locked_thread_ids.includes(threadId);
  })) {
    return true;
  }
  const hasWorkflowSnapshot = Array.isArray(session?.active_workflow_runs);
  const anyActiveWorkflow = runs.some((run) => !TERMINAL_WORKFLOW_STATUSES.has(run?.status));
  if (hasWorkflowSnapshot && !anyActiveWorkflow) {
    return false;
  }
  return Boolean(session?.workflow_locked && session?.active_thread_id === threadId);
}

function activeThreadBusy(session) {
  if (!session?.active_thread_id) return false;
  if (session.active_turn_id) return true;
  if (isWorkingThreadStatus(session.current_status)) return true;
  return (session.thread_activity || []).some(
    (entry) => entry?.thread_id === session.active_thread_id
  );
}

export function canStartWorkflow(session) {
  if (!session?.active_thread_id) return false;
  if (activeThreadBusy(session)) return false;
  if (isReviewInProgress(session)) return false;
  if (activeWorkflowRunning(session)) return false;
  if (
    Array.isArray(session.pending_approvals) &&
    session.pending_approvals.some((approval) => approval?.thread_id === session.active_thread_id)
  ) {
    return false;
  }
  return true;
}

export function workflowRunsForThread(session, threadId) {
  if (!threadId) return [];
  return (session?.active_workflow_runs || []).filter(
    (run) => run?.parent_thread_id === threadId
  );
}

export function selectWorkflowLaunchModel({
  providers = [],
  providerModels = {},
  session = null,
} = {}) {
  const reviewerProviders = (providers || []).filter((provider) =>
    CODE_FLOW_REVIEWER_PROVIDERS.has(provider)
  );
  const defaultProvider =
    reviewerProviders.find((provider) => provider !== session?.provider) ||
    reviewerProviders[0] ||
    "";
  const models = [];
  const seen = new Set();
  for (const provider of reviewerProviders) {
    for (const model of providerModels?.[provider] || []) {
      if (!model?.model) continue;
      const key = `${provider} ${model.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ ...model, provider });
    }
  }
  return {
    providerOptions: providerOptions(reviewerProviders),
    models,
    defaultProvider,
  };
}
