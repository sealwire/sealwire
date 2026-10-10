// The single control banner that sits between the transcript and the composer.
//
// One slot, several claimants, so the decision lives here rather than inline in the
// renderer: whoever claims it also decides what the user's one button does, and a
// priority that is spread across `if`s in a DOM function cannot be tested. The
// renderer only paints what this returns.

import { normalizeWorkspaceRepairPlan } from "../shared/workspace-repair.js";

// Re-exported so this module stays the one import a banner test (or a future surface)
// needs: the decision and the shape it decides on belong together.
export { normalizeWorkspaceRepairPlan };

const HIDDEN = Object.freeze({
  hidden: true,
  hint: "",
  repair: null,
  summary: "",
  summaryTitle: "",
});

/**
 * The repair action's copy. The button names the ACT, not the problem — and for a
 * worktree it names the branch, because "re-create" would otherwise sound like the
 * user is about to get an empty directory back instead of their work.
 */
export function workspaceRepairAction(plan, { pending = false, error = "" } = {}) {
  if (!plan) {
    return null;
  }
  const idleLabel = plan.kind === "worktree"
    ? `Re-create worktree on ${plan.branch}`
    : "Create folder";
  return {
    error: error || "",
    kind: plan.kind,
    label: pending
      ? plan.kind === "worktree"
        ? "Re-creating worktree…"
        : "Creating folder…"
      : idleLabel,
    pending: Boolean(pending),
    recordedCwd: plan.recordedCwd,
  };
}

// Takes derived facts rather than the raw snapshot, so the priority between claimants
// can be tested without a renderer.
export function selectControlBannerModel({
  hasActiveThread = false,
  lockedByAgent = false,
  lockedByWorkflow = false,
  repairError = "",
  repairPending = false,
  viewingConversation = false,
  workspaceMissing = null,
} = {}) {
  if (!hasActiveThread || !viewingConversation) {
    return HIDDEN;
  }

  // Ahead of the lock: the directory the thread records is gone, so a send dies
  // before it reaches the provider and the repair is the only action that helps.
  const plan = normalizeWorkspaceRepairPlan(workspaceMissing);
  if (plan) {
    const noun = plan.kind === "worktree" ? "worktree" : "folder";
    return {
      hidden: false,
      hint: plan.kind === "worktree"
        ? `Re-creating it checks ${plan.branch} back out at that path.`
        : "Re-creating it lets this session run there again.",
      repair: workspaceRepairAction(plan, { error: repairError, pending: repairPending }),
      // Names the directory: the user has just watched sends vanish, and which path
      // is missing is the only fact that explains it.
      summary: `This session's ${noun} is gone: ${plan.recordedCwd}`,
      summaryTitle: plan.recordedCwd,
    };
  }

  if (!lockedByAgent) {
    return HIDDEN;
  }

  return {
    hidden: false,
    hint: lockedByWorkflow
      ? "This session is locked by Code Flow; it unlocks when the workflow finishes."
      : "This session is being reviewed; it unlocks when the review finishes.",
    repair: null,
    summary: lockedByWorkflow ? "Code Flow in progress" : "Review in progress",
    summaryTitle: "",
  };
}
