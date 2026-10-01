// Pure row model for the project menu shared by the top-bar switcher and both launch
// dialogs. Counts and order come from the loaded session list; no server field needed.

import { ALL_SESSIONS_LABEL } from "./project-labels.js";
import { countMembers } from "./thread-groups.js";

/**
 * `activeProjectId` is resolved against the list, not trusted: an id deleted on
 * another device marks the default row instead of leaving nothing ticked.
 *
 * Projects are ordered by their most recent session, newest first, so the place you
 * were just working is near the top; projects with no sessions follow by name.
 *
 * @returns {{ defaultRow: {id: null, label: string, count: number|null, active: boolean},
 *             projectRows: Array<{id: string, label: string, count: number, members: number,
 *                                 active: boolean}> }}
 */
export function buildProjectPickerRows({
  projects = [],
  threads = [],
  threadProjectId = {},
  activeProjectId = null,
  defaultLabel = ALL_SESSIONS_LABEL,
  // The switcher counts every session on its default row; the pickers leave it bare.
  defaultCount = null,
} = {}) {
  const list = (projects || []).filter((project) => project?.id);
  const resolvedId =
    activeProjectId && list.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : null;

  const counts = new Map();
  const latest = new Map();
  for (const thread of threads || []) {
    const projectId = threadProjectId?.[thread?.id];
    if (!projectId) {
      continue;
    }
    counts.set(projectId, (counts.get(projectId) || 0) + 1);
    latest.set(projectId, Math.max(latest.get(projectId) || 0, Number(thread.updated_at) || 0));
  }

  const projectRows = list
    .map((project) => ({
      id: project.id,
      // A project can legitimately hold an empty name (renamed to blank on another
      // client); showing its id beats showing nothing at all.
      label: project.name || project.id,
      count: counts.get(project.id) || 0,
      // Every member, loaded or not — what deleting the project would actually touch.
      members: countMembers(threadProjectId, project.id),
      active: project.id === resolvedId,
      latest: latest.get(project.id) || 0,
    }))
    .sort((a, b) => b.latest - a.latest || a.label.localeCompare(b.label))
    .map(({ latest: _latest, ...row }) => row);

  return {
    defaultRow: {
      id: null,
      label: defaultLabel,
      count: defaultCount,
      active: resolvedId === null,
    },
    projectRows,
  };
}

/** Case-insensitive substring match on the label. */
export function filterProjectRows(rows, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter((row) => String(row.label).toLowerCase().includes(needle));
}
