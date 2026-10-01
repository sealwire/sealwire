// Pure helpers for the local Projects CRUD affordances (the "+ New project" button
// and the per-session "assign to project" context-menu section). Side-effect free so
// they unit-test without a DOM; app.js renders buttons from these descriptors and
// wires the actual API calls.

/**
 * Ordered descriptors for the thread menu's "Project ›" submenu: the thread's OWN
 * Project first (marked current, so the submenu opens showing where the thread lives),
 * then the other Projects alphabetically (one click = move), then "create" (new Project
 * + assign) and, only when assigned, a trailing "unassign".
 *
 * Current-first — not strictly alphabetical — because the list is primarily a "where am
 * I / move me" control: membership must be readable without scanning, and the checkmark
 * alone doesn't survive a long Project list inside a scrolling menu.
 */
export function buildProjectMenuItems({ projects, currentProjectId } = {}) {
  const current = currentProjectId || null;
  const sorted = (Array.isArray(projects) ? projects : [])
    .filter((project) => project && project.id)
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const items = [];
  for (const project of [
    ...sorted.filter((project) => project.id === current),
    ...sorted.filter((project) => project.id !== current),
  ]) {
    items.push({
      kind: "assign",
      projectId: project.id,
      label: project.name || project.id,
      isCurrent: project.id === current,
    });
  }
  items.push({ kind: "create", label: "New project…" });
  if (current) {
    items.push({ kind: "unassign", label: "Remove from project" });
  }
  return items;
}

/**
 * The value text for the "Projects ›" submenu trigger: the name of the Project this
 * thread belongs to, or null when it belongs to none. Resolved against the Projects
 * payload (never from membership alone), so a stale/dangling membership id reads as
 * "no project" instead of inventing a label the submenu wouldn't be able to check.
 */
export function currentProjectLabel({ projects, currentProjectId } = {}) {
  const current = currentProjectId || null;
  if (!current) return null;
  const match = (Array.isArray(projects) ? projects : []).find(
    (project) => project && project.id === current
  );
  return match ? match.name || match.id : null;
}

/**
 * The id of the Project that appeared after a create action, by set-diffing the
 * before/after id sets. A diff (not find-by-name) so it stays correct even if two
 * Projects share a name. Returns null unless exactly one new id appeared.
 */
export function pickNewProjectId(beforeProjects, afterProjects) {
  const before = new Set(
    (Array.isArray(beforeProjects) ? beforeProjects : [])
      .map((project) => project && project.id)
      .filter(Boolean)
  );
  const fresh = (Array.isArray(afterProjects) ? afterProjects : [])
    .map((project) => project && project.id)
    .filter((id) => id && !before.has(id));
  return fresh.length === 1 ? fresh[0] : null;
}

/** Normalize a raw prompt value into a trimmed Project name, or null to abort. */
export function normalizeProjectName(raw) {
  if (raw == null) return null;
  const name = String(raw).trim();
  return name || null;
}

/**
 * Whether the Projects payload is fresh enough to present membership + mutation
 * controls. The context menu mirrors the sidebar's fail-closed rule: false while a
 * fetch is pending, after an error, or before the first successful load — so we never
 * expose stale/unknown assign/unassign controls or a wrong "current" marker.
 */
export function projectsMenuReady({ projectsLoaded, projectsError, projectsLoading } = {}) {
  return Boolean(projectsLoaded) && !projectsError && !projectsLoading;
}

/**
 * Viewport coordinates for the second-level Projects flyout (a `position: fixed` panel).
 *
 * Horizontally it hangs off the MENU's box, not the trigger's, so it clears the menu's
 * own padding instead of overlapping it; it flips to the menu's far side when the right
 * has no room. Vertically it anchors to the trigger row — lifted by the panel's padding
 * so the first row lines up with that row — then clamps, which is what makes a long list
 * on a low row open upward instead of off the bottom edge.
 *
 * Pure so the flip and both clamps are testable: the sidebar is left-anchored, so a
 * browser test can only ever reach the open-right case.
 *
 * @returns {{ left: number, top: number, opensLeft: boolean }}
 */
export function placeProjectSubmenu({
  menuRect,
  triggerRect,
  submenuWidth = 0,
  submenuHeight = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  gap = 4,
  margin = 8,
  padding = 4,
} = {}) {
  const menu = menuRect || { left: 0, right: 0 };
  const trigger = triggerRect || { top: 0 };
  const openRight = menu.right + gap + submenuWidth <= viewportWidth - margin;
  const desiredLeft = openRight ? menu.right + gap : menu.left - gap - submenuWidth;
  // `margin` is the floor in both clamps: when the panel is bigger than the space it has
  // to live in, pin it to the top/left margin rather than let the max drive it negative.
  const maxLeft = Math.max(margin, viewportWidth - margin - submenuWidth);
  const maxTop = Math.max(margin, viewportHeight - margin - submenuHeight);
  return {
    left: Math.min(Math.max(margin, desiredLeft), maxLeft),
    top: Math.min(Math.max(margin, trigger.top - padding), maxTop),
    opensLeft: !openRight,
  };
}

/**
 * Whether a context-menu Project action may execute. The clicked button captured the
 * Projects-state sequence token when it was built; the action runs only if that token
 * still matches the current one (no transition since) AND the state is fresh. This is
 * the execution-time guard that stops a button built from now-stale Project state from
 * overwriting newer membership, even in the tiny window between click and handler.
 */
export function projectMenuActionAllowed({
  builtSeq,
  currentSeq,
  projectsLoaded,
  projectsError,
  projectsLoading,
} = {}) {
  return builtSeq === currentSeq && projectsMenuReady({ projectsLoaded, projectsError, projectsLoading });
}
