import { providerOptions } from "./provider-settings.js";
import { isReviewInProgress, isThreadBusy } from "./review-state.js";
import { pendingApprovalForThread } from "./session-view-model.js";

// Code Flow is hidden from the UI for now — it is not part of the maintainer's working
// loop, and its cards were competing with review results for the same panel.
//
// This is a PRESENTATION switch only. A workflow run that exists on the server still
// locks its threads exactly as before (see workflowLockedThreadIds / isThreadBusy below);
// turning the display off must not quietly turn the safety off with it, or a hidden run
// would leave a thread locked with nothing on screen explaining why.
//
// It lives here, next to the vocabulary it gates, because there are THREE entry points
// (the launcher, the run rows, and the right-rail tab's in-progress dot) and they have to
// come back together. Flip to `true` to restore all of them.
export const CODE_FLOW_ENABLED = false;

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

export function workflowActivity(session) {
  return Array.isArray(session?.workflow_activity)
    ? session.workflow_activity
    : session?.active_workflow_runs || [];
}

function activeWorkflowRunning(session) {
  return workflowActivity(session).some(
    (run) => !TERMINAL_WORKFLOW_STATUSES.has(run?.status)
  );
}

export function isWorkflowBlocked(session) {
  return workflowActivity(session).some((run) => run?.status === "blocked");
}

export function isWorkflowInProgressForThread(session, threadId) {
  if (!threadId) return false;
  const runs = workflowActivity(session);
  if (runs.some((run) => {
    if (TERMINAL_WORKFLOW_STATUSES.has(run?.status)) return false;
    if (run?.parent_thread_id === threadId) return true;
    return Array.isArray(run?.locked_thread_ids) && run.locked_thread_ids.includes(threadId);
  })) {
    return true;
  }
  const hasWorkflowSnapshot =
    Array.isArray(session?.workflow_activity) || Array.isArray(session?.active_workflow_runs);
  const anyActiveWorkflow = runs.some((run) => !TERMINAL_WORKFLOW_STATUSES.has(run?.status));
  if (hasWorkflowSnapshot && !anyActiveWorkflow) {
    return false;
  }
  return Boolean(session?.workflow_locked && session?.active_thread_id === threadId);
}

// Whether Code Flow can be launched against `viewedThreadId` (default: the active
// thread). Deliberately mirrors `canRequestReview`: the gate targets the VIEWED
// thread — its own liveness (`isThreadBusy`) and pending approvals — so viewing an
// idle background thread while the active chat is busy still allows a launch, the
// same way Request review does. Workflow/review mutual exclusion stays GLOBAL to
// match the backend (`has_active_workflow`/`has_active_review`).
export function canStartWorkflow(session, viewedThreadId = null) {
  const target = viewedThreadId || session?.active_thread_id || null;
  if (!target) return false;
  if (isThreadBusy(session, target)) return false;
  if (isReviewInProgress(session)) return false;
  if (activeWorkflowRunning(session)) return false;
  if (pendingApprovalForThread(session, target)) {
    return false;
  }
  return true;
}

export function workflowRunsForThread(workflows, threadId) {
  if (!threadId) return [];
  const runs = Array.isArray(workflows?.workflow_runs)
    ? workflows.workflow_runs
    : workflows?.active_workflow_runs || [];
  return runs.filter(
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
