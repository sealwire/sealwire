// Remote-surface Projects transport. The read path is the dedicated `fetch_projects`
// broker action (mirrors `fetch_workspace_diff`/`fetch_reviews`); the write path is a
// single `project_action` broker action carrying a `{ input: { action, ... } }` body.
// The broker discards the write receipt, so callers refresh via the projects_revision
// snapshot bump (or an explicit fetchRemoteProjects) — same policy as reviews.
import { dispatchOrRecover } from "./actions.js";

/** GET the dedicated Projects payload ({ projects_revision, projects, thread_project_id }). */
export async function fetchRemoteProjects() {
  const result = await dispatchOrRecover("fetch_projects", {});
  return result?.projects;
}

/** POST one Projects mutation over the broker. */
export const dispatchRemoteProjectAction = (action) =>
  dispatchOrRecover("project_action", { input: action });

export const createRemoteProject = (name) =>
  dispatchRemoteProjectAction({ action: "create", name });

export const renameRemoteProject = (projectId, name) =>
  dispatchRemoteProjectAction({ action: "rename", project_id: projectId, name });

export const deleteRemoteProject = (projectId) =>
  dispatchRemoteProjectAction({ action: "delete", project_id: projectId });

export const assignRemoteThreadToProject = (threadId, projectId) =>
  dispatchRemoteProjectAction({ action: "assign", thread_id: threadId, project_id: projectId });

export const unassignRemoteThread = (threadId) =>
  dispatchRemoteProjectAction({ action: "unassign", thread_id: threadId });

/**
 * Set (`name`) or clear (`null`) a session's user-chosen title.
 *
 * Its own broker action rather than a `project_action` variant: renaming a session is a
 * different noun from renaming the project it sits in. Like `project_action` it takes no
 * session claim — a rename never runs a turn, so it must not fight the active controller
 * for the relay-wide lease and must work while that session is mid-turn.
 *
 * The broker drops the receipt (ack-only), so the caller repaints optimistically and
 * lets the bumped `threads_revision` reconcile everyone, including this device.
 */
export const renameRemoteThread = (threadId, name) =>
  dispatchOrRecover("rename_thread", {
    thread_id: threadId,
    input: { name: name ?? null },
  });

/** Set or clear a session's follow-up flag. Ack-only, same shape as rename above. */
export const setRemoteThreadFlag = (threadId, flagged) =>
  dispatchOrRecover("set_thread_flag", {
    thread_id: threadId,
    input: { flagged: Boolean(flagged) },
  });

// Not claim-gated: a paired device must see what it is about to launch into
// without taking control of whatever session is running.
export async function fetchRemoteWorkspaceGitContext(cwd) {
  const result = await dispatchOrRecover("fetch_workspace_git_context", { cwd });
  return result?.workspace_git_context || null;
}

// Its own action rather than the transcript response, which also carries settings
// but pays a provider fetch to produce them.
export async function fetchRemoteThreadSettings(threadId) {
  const result = await dispatchOrRecover("fetch_thread_settings", { thread_id: threadId });
  return result?.thread_settings || null;
}
