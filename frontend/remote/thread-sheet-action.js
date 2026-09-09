// Executes one action picked from the per-session actions sheet.
//
// Split out of RemoteApp and taking its collaborators as arguments so the branching —
// especially "create a project and move the session into it" — is testable without a
// browser. That branch is the subtle one: local reads the new project's id straight off
// the create receipt, but the broker DISCARDS write receipts on this surface, so the id
// has to come from a refetch-and-diff instead.

import { pickNewProjectId } from "../shared/project-menu.js";

/**
 * @param {object} item      descriptor from buildThreadSheetSections
 * @param {string} threadId  the session the sheet was opened for
 * @param {Array}  projects  the projects known BEFORE the action (for the create diff)
 * @param {string} currentName the session's CURRENT user-chosen title (its override),
 *                             or null — seeds the rename prompt's "reset" semantics
 * @param {boolean} currentFlagged whether the session is CURRENTLY flagged — decides
 *                             which way the flag toggle goes
 * @param {object} deps      { assign, unassign, create, fetchProjects, promptName,
 *                             openFork, refresh, log, rename, promptRename, refreshThreads,
 *                             setFlag }
 */
export async function runThreadSheetAction({
  item,
  threadId,
  projects = [],
  currentName = null,
  currentFlagged = false,
  deps,
} = {}) {
  // A refused entry (running session, projects not loaded) is rendered disabled, but
  // never trust the view for that — the descriptor is the authority.
  if (!item || item.disabled || !threadId || !deps) return;
  const {
    assign,
    unassign,
    create,
    fetchProjects,
    promptName,
    openFork,
    refresh,
    log,
    rename,
    promptRename,
    refreshThreads,
    setFlag,
  } = deps;
  try {
    if (item.kind === "fork") {
      openFork(threadId);
      return;
    }
    if (item.kind === "rename" || item.kind === "rename-reset") {
      // A reset skips the prompt entirely — the menu entry already said what it does.
      const next = item.kind === "rename-reset" ? null : promptRename?.(currentName);
      // `undefined` is a cancelled prompt; `null` is a deliberate reset. Only the
      // former means "do nothing".
      if (next === undefined) return;
      await rename(threadId, next);
      log(next ? `Renamed session to "${next}".` : "Session name reset.");
      // Titles live on the thread list, not the projects payload, so `refresh()` (which
      // refetches projects) would not repaint the row that just changed. This surface
      // also drops broker write receipts, so the list has to be re-asked for.
      //
      // Caught separately: the rename has already SUCCEEDED by this point, and letting a
      // failed repaint fall into the outer handler would report "Session action failed"
      // for a rename the relay accepted and persisted. The list self-heals on the next
      // poll either way.
      try {
        await refreshThreads?.();
      } catch (error) {
        log(`Renamed, but the session list did not refresh: ${error.message}`);
      }
      return;
    }
    if (item.kind === "flag") {
      const next = !currentFlagged;
      await setFlag(threadId, next);
      log(next ? "Flagged for follow-up." : "Unflagged.");
      // Same reasoning as rename above: the flag lives on the thread list, this
      // surface drops broker write receipts, and the flag has already succeeded by
      // this point — a refresh failure here must not read as "Session action failed".
      try {
        await refreshThreads?.();
      } catch (error) {
        log(`Flag updated, but the session list did not refresh: ${error.message}`);
      }
      return;
    }
    if (item.kind === "assign") {
      // Re-picking the project a session already lives in is a no-op, not a pointless
      // round trip that also churns the projects revision.
      if (item.isCurrent) return;
      await assign(threadId, item.projectId);
      log(`Moved session to "${item.label}".`);
    } else if (item.kind === "unassign") {
      await unassign(threadId);
      log("Removed session from its project.");
    } else if (item.kind === "create") {
      const name = promptName();
      if (!name) return;
      await create(name);
      // Diff ids rather than matching on name: two projects may share a name, and only
      // an id can be assigned. Must be the awaited fetch — the store's `refresh` is
      // fire-and-forget and resolves to undefined, which would leave every freshly
      // created project unassigned.
      const after = await fetchProjects();
      const createdId = pickNewProjectId(projects, after?.projects || []);
      if (!createdId) {
        // Created, but the id was ambiguous — leave the session where it is rather than
        // guess at membership. The refresh still surfaces the new (empty) project.
        log(`Created project "${name}" (move the session from its menu).`);
        refresh();
        return;
      }
      await assign(threadId, createdId);
      log(`Created project "${name}" and moved the session into it.`);
    } else {
      return;
    }
    refresh();
  } catch (error) {
    log(`Session action failed: ${error.message}`);
  }
}
