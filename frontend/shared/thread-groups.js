function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

export function canonicalizeWorkspace(cwd) {
  return String(cwd || "").trim().replace(/[\\/]+$/, "");
}

export const UNKNOWN_WORKSPACE_CWD = "__unknown_workspace__";
export const UNKNOWN_WORKSPACE_LABEL = "Unknown workspace";

// `UNKNOWN_WORKSPACE_CWD` is a DISPLAY grouping key, not a directory. It must
// never flow into a cwd operation: the local group header is clickable and its
// handler writes the value straight into the workspace input, so an unguarded
// sentinel would be sent to the relay as a path when starting a session.
export function isUnknownWorkspace(cwd) {
  return cwd === UNKNOWN_WORKSPACE_CWD;
}

export const UNASSIGNED_PROJECT_KEY = "__unassigned__";
export const UNASSIGNED_PROJECT_LABEL = "Unassigned";

// Like UNKNOWN_WORKSPACE_CWD, the "Unassigned" bucket key is a DISPLAY grouping
// sentinel, not a real project id: it must never be sent to an assign/unassign
// action as a project_id. Null `project_id` membership collapses to this ONE
// bucket (never split by cwd).
export function isUnassignedProject(key) {
  return key === UNASSIGNED_PROJECT_KEY;
}

// Navigation policy, shared by every surface that renders the thread list.
//
// A thread whose cwd could not be recovered must still be REACHABLE. cwd
// recovery is best-effort at both layers (the relay's runtime/cache memory, and
// the worker's local-JSONL scan), so an empty cwd is always possible: the
// session file may be gone, the id may not match the scan pattern, or the relay
// may have restarted. Dropping those rows made a real forked session vanish
// from the sidebar with no error while it existed on disk and in the relay —
// and, because the local refresh writes the grouped result back to
// `state.threads`, it also became unforkable and unopenable.
//
// This exists as a function rather than an option each caller remembers to
// pass: local surfaces did not pass it while remote did, so the same thread was
// visible on the phone and gone on the desktop.
export function buildNavigationThreadGroups(threads, options = {}) {
  return buildThreadGroups(threads, { includeUnknownWorkspace: true, ...options });
}

// Every group carries a neutral `key` (canonical cwd in cwd mode, project id or the
// "__unassigned__" sentinel in project mode) so downstream collapse/row state can be
// keyed uniformly regardless of grouping mode.
//
// `options.pinnedProjectId` (cwd mode only) is the Project switcher: it LIFTS that
// project's sessions out of their cwd groups into one group at the top, and leaves
// every other session exactly where it was. It is not a filter — the list stays
// full in every mode, so selecting the wrong project can never hide a session.
//
// Pinning is the ONE mode that mixes the two key spaces — a project id alongside
// cwd keys — and `key` is both the React key and the virtualizer's `getItemKey`,
// so a collision would corrupt the list rather than merely mislabel it. They are
// disjoint by construction, not by convention: project ids are server-generated
// (`proj_<16 hex>`, state/app/projects.rs) while cwd keys are absolute paths or
// the `__unknown_workspace__` sentinel. `group keys stay unique when a project is
// pinned` in thread-groups-pinned-project.test.mjs holds that assumption down —
// if ids ever become caller-chosen, that test is what will fail first.
export function buildThreadGroups(threads, options = {}) {
  if (options.groupBy === "project") {
    return buildProjectGroups(threads, options);
  }

  const pinnedProject = resolvePinnedProject(options);
  if (!pinnedProject) {
    return buildCwdGroups(threads, options);
  }

  return buildCwdGroupsWithPinnedProject(threads, options, pinnedProject);
}

/**
 * When the Project switcher's selection is allowed to pin, and when it stands down.
 *
 * A policy rather than an inline condition, because "the pin composes with the
 * bell" is exactly the plausible-but-wrong assumption this guards: the bell does
 * NOT narrow rows within groups, it re-buckets the list by state
 * (`buildThreadStateGroups` replaces the group structure outright), so a pinned
 * group cannot survive it. A search is a different failure: it swaps the row
 * SOURCE for a server-side slice that can contain sessions absent from the
 * authoritative list, so there is nothing coherent to lift out of.
 *
 * In both cases the honest answer is to stand the pin down rather than render a
 * selection that visibly does nothing.
 */
export function selectPinnedProjectId({
  activeProjectId = null,
  filtering = false,
  searching = false,
} = {}) {
  if (!activeProjectId || searching || filtering) {
    return null;
  }

  return activeProjectId;
}

// A selected project can be deleted from another device while it is still
// selected. That must fail OPEN — drop back to plain cwd grouping — because the
// sessions themselves are all still there; failing closed would blank a list that
// has nothing wrong with it.
function resolvePinnedProject(options) {
  if (!options.pinnedProjectId) {
    return null;
  }

  return (
    (options.projects || []).find((project) => project.id === options.pinnedProjectId) || null
  );
}

function buildCwdGroupsWithPinnedProject(threads, options, project) {
  const threadProjectId = options.threadProjectId || {};
  const members = [];
  const rest = [];

  for (const thread of threads || []) {
    // Membership is read live, so a session removed from the project falls back
    // into its own cwd group on the very next render — no separate teardown.
    if (threadProjectId[thread.id] === project.id) {
      members.push(thread);
    } else {
      rest.push(thread);
    }
  }

  // The pinned group is prepended rather than sorted in: it leads regardless of
  // recency, because its position is what tells you which project is selected.
  // An empty project still renders — a switcher whose selection shows nothing at
  // all reads as broken rather than as empty.
  const pinnedGroup = {
    key: project.id,
    cwd: "",
    projectId: project.id,
    pinned: true,
    label: project.name || project.id,
    // From the full membership map, not `members`: the list holds only the most recent
    // sessions, and "nothing loaded" must not read as "nothing in it".
    memberCount: countMembers(threadProjectId, project.id),
    latestUpdatedAt: members.reduce(
      (latest, thread) => Math.max(latest, Number(thread.updated_at) || 0),
      0,
    ),
    threads: [...members].sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0)),
  };

  return [pinnedGroup, ...buildCwdGroups(rest, options)];
}

function buildCwdGroups(threads, options) {
  const includeUnknownWorkspace = options.includeUnknownWorkspace === true;
  const groups = new Map();

  for (const thread of threads || []) {
    const knownCwd = canonicalizeWorkspace(thread.cwd);
    const cwd = knownCwd || (includeUnknownWorkspace ? UNKNOWN_WORKSPACE_CWD : "");
    if (!cwd) {
      continue;
    }

    if (!groups.has(cwd)) {
      groups.set(cwd, {
        key: cwd,
        cwd,
        label: knownCwd ? workspaceBasename(cwd) : UNKNOWN_WORKSPACE_LABEL,
        // No `restricted` flag, deliberately. `thread.workspace_trusted` is on every
        // granted row (omitted, not `false`, on the rest — read it as falsy, never
        // `=== false`) and hoisting it here would be easy. But the sidebar renders
        // because sessions exist, not because anyone asked about a workspace: most
        // workspaces are legitimately ungranted, nothing about the session is blocked by
        // it, so a tag would sit on most groups forever and be tuned out — spending the
        // attention the in-context offer (diff panel / review dialog) needs. Carrying
        // the flag no further is what keeps a renderer from being tempted by it.
        latestUpdatedAt: 0,
        threads: [],
      });
    }

    const group = groups.get(cwd);
    group.threads.push(thread);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return sortThreadGroups([...groups.values()]);
}

// Group by Project (thread_project_id membership). Every known project seeds a
// group so an empty project stays visible/navigable; a thread with no project — or
// an ORPHANED membership whose project was deleted — collapses into ONE
// "__unassigned__" bucket (never split by cwd).
function buildProjectGroups(threads, options) {
  const threadProjectId = options.threadProjectId || {};
  const projectsById = new Map((options.projects || []).map((project) => [project.id, project]));
  const groups = new Map();

  const ensureGroup = (key, label, projectId) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        cwd: "",
        projectId: projectId ?? null,
        label,
        latestUpdatedAt: 0,
        threads: [],
      });
    }
    return groups.get(key);
  };

  for (const project of options.projects || []) {
    ensureGroup(project.id, project.name || project.id, project.id).memberCount =
      countMembers(threadProjectId, project.id);
  }

  for (const thread of threads || []) {
    const rawId = threadProjectId[thread.id] || null;
    const project = rawId ? projectsById.get(rawId) : null;
    const group = project
      ? ensureGroup(project.id, project.name || project.id, project.id)
      : ensureGroup(UNASSIGNED_PROJECT_KEY, UNASSIGNED_PROJECT_LABEL, null);
    group.threads.push(thread);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return sortThreadGroups([...groups.values()]);
}

export function countMembers(threadProjectId, projectId) {
  return Object.values(threadProjectId || {}).filter((id) => id === projectId).length;
}

function sortThreadGroups(groups) {
  return groups
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0)),
    }))
    .sort((left, right) => {
      if (right.latestUpdatedAt !== left.latestUpdatedAt) {
        return right.latestUpdatedAt - left.latestUpdatedAt;
      }

      return left.label.localeCompare(right.label);
    });
}

/**
 * Pick the most recent thread, preferring one in `preferredCwd`.
 *
 * @deprecated No application code calls this. Its only caller was
 * `resumeLatestSession()`, which backed the sidebar's "Continue latest" button;
 * both were removed when that button was retired. What remains is this function
 * and the four assertions covering it in thread-groups.test.mjs.
 *
 * Kept deliberately for now rather than deleted, so the removal is a decision
 * someone makes on purpose. If nothing has adopted it by the next cleanup pass,
 * delete it together with its tests — a tested function with no callers reads
 * like a supported API and invites new callers to a dead path.
 */
export function findLatestThread(threads, preferredCwd) {
  if (!threads?.length) {
    return null;
  }

  const normalizedCwd = canonicalizeWorkspace(preferredCwd);
  if (!normalizedCwd) {
    return threads[0] || null;
  }

  return (
    threads.find((thread) => canonicalizeWorkspace(thread.cwd) === normalizedCwd) || null
  );
}

export function summarizeThreadGroups(groups, options = {}) {
  const safeGroups = groups || [];
  const totalThreads = safeGroups.reduce((count, group) => count + (group.threads?.length || 0), 0);

  if (totalThreads === 0 && safeGroups.length === 0) {
    return "No saved sessions yet.";
  }

  const sessions = `${totalThreads} ${totalThreads === 1 ? "session" : "sessions"}`;

  if (options.groupBy === "project") {
    // The "__unassigned__" bucket is NOT a project — count only real projects.
    const projectCount = safeGroups.filter((group) => group.projectId).length;
    return `${projectCount} ${projectCount === 1 ? "project" : "projects"} · ${sessions}`;
  }

  // A pinned project group is not a folder. Counting it as one would make this
  // line disagree with the list right above it — and the session total already
  // covers its rows, so nothing goes uncounted by leaving it out here. The
  // project's own name is on the switcher, so it needs no second mention.
  const folderCount = safeGroups.filter((group) => !group.projectId).length;
  return `${folderCount} ${folderCount === 1 ? "folder" : "folders"} · ${sessions}`;
}
