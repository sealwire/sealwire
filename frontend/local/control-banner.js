// The single control banner that sits between the transcript and the composer.
//
// One slot, several claimants, so the decision lives here rather than inline in the
// renderer: whoever claims it also decides what the user's one button does, and a
// priority that is spread across `if`s in a DOM function cannot be tested. The
// renderer only paints what this returns.

import { normalizeWorkspaceRepairPlan } from "../shared/workspace-repair.js";
import { t } from "../shared/i18n.js";

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
    ? t("Re-create worktree on {branch}", { branch: plan.branch })
    : t("Create folder");
  return {
    error: error || "",
    kind: plan.kind,
    label: pending
      ? plan.kind === "worktree"
        ? t("Re-creating worktree…")
        : t("Creating folder…")
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
    const worktree = plan.kind === "worktree";
    return {
      hidden: false,
      hint: worktree
        ? t("Re-creating it checks {branch} back out at that path.", { branch: plan.branch })
        : t("Re-creating it lets this session run there again."),
      repair: workspaceRepairAction(plan, { error: repairError, pending: repairPending }),
      // Names the directory: the user has just watched sends vanish, and which path
      // is missing is the only fact that explains it.
      summary: worktree
        ? t("This session's worktree is gone: {path}", { path: plan.recordedCwd })
        : t("This session's folder is gone: {path}", { path: plan.recordedCwd }),
      summaryTitle: plan.recordedCwd,
    };
  }

  if (!lockedByAgent) {
    return HIDDEN;
  }

  return {
    hidden: false,
    hint: lockedByWorkflow
      ? t("This session is locked by Code Flow; it unlocks when the workflow finishes.")
      : t("This session is being reviewed; it unlocks when the review finishes."),
    repair: null,
    summary: lockedByWorkflow ? t("Code Flow in progress") : t("Review in progress"),
    summaryTitle: "",
  };
}
