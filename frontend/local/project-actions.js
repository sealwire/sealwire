// Local-surface transport for the relay-owned session METADATA the user edits directly:
// Projects (the write path is POST /api/projects with a `{ action, ... }` body, the read
// path GET /api/projects) and a session's own user-chosen title
// (POST /api/threads/:id/rename). Both go through `apiFetch`.
//
// They live together because they share a shape, not a noun: each is a persisted,
// relay-owned overlay on top of what the providers report, mutated by an explicit user
// action rather than by an agent. The remote surface mirrors each of them with a broker
// action (`project_action` / `rename_thread`) in `remote/project-actions.js`.

async function unwrap(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

/** POST a single Projects mutation; resolves to the ProjectActionReceipt. */
export async function postProjectAction(apiFetch, action) {
  const response = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  return unwrap(response);
}

export const createProject = (apiFetch, name) =>
  postProjectAction(apiFetch, { action: "create", name });

export const renameProject = (apiFetch, projectId, name) =>
  postProjectAction(apiFetch, { action: "rename", project_id: projectId, name });

export const deleteProject = (apiFetch, projectId) =>
  postProjectAction(apiFetch, { action: "delete", project_id: projectId });

export const assignThreadToProject = (apiFetch, threadId, projectId) =>
  postProjectAction(apiFetch, {
    action: "assign",
    thread_id: threadId,
    project_id: projectId,
  });

export const unassignThread = (apiFetch, threadId) =>
  postProjectAction(apiFetch, { action: "unassign", thread_id: threadId });

/**
 * Set (`name`) or clear (`null`) a session's user-chosen title.
 *
 * A separate route from the Projects ones because it is a different noun — this renames
 * the SESSION, not the group it belongs to. Resolves to the ThreadRenameReceipt, whose
 * `name` is the post-rename truth (trimmed, or `null` when reset), so the caller repaints
 * from the server's answer rather than its own optimistic guess.
 */
export async function renameThread(apiFetch, threadId, name) {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name ?? null }),
  });
  return unwrap(response);
}

/** Set or clear a session's follow-up flag. */
export async function setThreadFlag(apiFetch, threadId, flagged) {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/flag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flagged: Boolean(flagged) }),
  });
  return unwrap(response);
}

/** GET the dedicated Projects payload ({ projects_revision, projects, thread_project_id }). */
export async function fetchProjectsPayload(apiFetch) {
  const response = await apiFetch("/api/projects", { method: "GET" });
  return unwrap(response);
}
