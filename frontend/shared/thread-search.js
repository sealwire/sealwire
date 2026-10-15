// Title search over the session list.
//
// The list a client holds is TRUNCATED (`GET /api/threads?limit=`), so search is a
// server round trip, not a filter over the loaded rows: the session you need to find is
// by definition the one that scrolled off the page. That is why results arrive as their
// own slice rather than by narrowing `state.threads`.
//
// This module is the pure half: what the sidebar should show given the authoritative
// groups plus the current search slice. It knows nothing about fetching or the DOM.

import { t } from "./i18n.js";
import { summarizeThreadGroups } from "./thread-groups.js";

/** The "not searching" slice. Shared so every reset writes the same shape. */
export const EMPTY_THREAD_SEARCH = Object.freeze({
  query: "",
  groups: [],
  loading: false,
  error: null,
  unavailableProviders: [],
});

/**
 * Trim a raw input value into a query, or "" for "not searching".
 *
 * Whitespace-only is not a search: it would ask the relay for every thread whose title
 * contains a space. Mirrors `normalize_thread_query` in
 * `crates/relay-server/src/state/app/threads.rs`.
 */
export function normalizeThreadSearchQuery(raw) {
  return String(raw ?? "").trim();
}

export function isThreadSearchActive(search) {
  return Boolean(normalizeThreadSearchQuery(search?.query));
}

/**
 * Find a thread among the current search results.
 *
 * Search deliberately surfaces threads from BEYOND the authoritative page, so a result
 * is routinely absent from `state.threads`. Every "does this thread exist / what is its
 * title" lookup has to consult this too, or the rows the feature exists to uncover
 * behave as if they were deleted: the context menu closes on right-click, tabs label
 * themselves with a short id, and rename/fork/archive/delete find nothing to act on.
 */
export function findThreadInSearchResults(search, threadId) {
  if (!threadId) {
    return null;
  }
  for (const group of search?.groups || []) {
    const hit = (group?.threads || []).find((thread) => thread?.id === threadId);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * Every thread the user can currently SEE: the authoritative list plus anything a search
 * surfaced from beyond it.
 *
 * For LOOKUPS only. Iteration — grouping, the sidebar's resting render, the
 * adjacent-session fallback after a delete — must stay on the authoritative list, or
 * search results leak into the resting view and into "which session do I open next".
 *
 * The authoritative row wins when both hold one: it is the fresher of the two (the 12s
 * poll rewrites it; search results are a snapshot from whenever the query ran).
 */
export function findVisibleThread({ threads = [], search = null } = {}, threadId) {
  if (!threadId) {
    return null;
  }
  return (
    (threads || []).find((thread) => thread?.id === threadId)
    || findThreadInSearchResults(search, threadId)
    || null
  );
}

/**
 * Decide what the session list renders.
 *
 * Returns the groups to render plus the count-line and empty-state copy, so the
 * searching and resting states cannot drift apart in two call sites.
 *
 * `collapseGroups` is false while searching on purpose: group collapse is a resting-state
 * preference, and honouring it during a search would hide the very row the user asked
 * for behind a folded header they cannot see the reason for.
 */
export function selectThreadListView({ threadGroups = [], search = null, groupBy = "cwd" } = {}) {
  if (!isThreadSearchActive(search)) {
    const groups = threadGroups || [];
    return {
      searching: false,
      // "ok" means nothing here needs to speak over a downstream narrowing (the bell).
      status: "ok",
      collapseGroups: true,
      groups,
      countLabel: summarizeThreadGroups(groups, { groupBy }),
      emptyMessage: t("Start or open a session to build workspace groups."),
    };
  }

  const query = normalizeThreadSearchQuery(search.query);
  const groups = search.groups || [];
  const matches = groups.reduce((total, group) => total + (group.threads?.length || 0), 0);
  const unreachable = search.unavailableProviders || [];

  if (search.loading) {
    return {
      searching: true,
      status: "loading",
      collapseGroups: false,
      // Keep the previous results on screen while a newer query is in flight. Blanking
      // the list on every keystroke makes the sidebar strobe as you type.
      groups,
      countLabel: t("Searching…"),
      emptyMessage: t("Searching…"),
    };
  }

  if (search.error) {
    return {
      searching: true,
      status: "error",
      collapseGroups: false,
      groups: [],
      countLabel: t("Search failed"),
      emptyMessage: t("Search failed: {error}", { error: search.error }),
    };
  }

  // A provider that could not be listed was dropped from the merge, so this answer is
  // not "what exists" — it is "what we could see". Saying "no matches" here would be a
  // positive claim of absence about sessions we never looked at, and the user would
  // conclude a session they own is gone.
  if (unreachable.length) {
    const names = unreachable.join(", ");
    return {
      searching: true,
      status: "partial",
      collapseGroups: false,
      groups,
      countLabel: matches === 1
        ? t("{count} result · partial", { count: matches })
        : t("{count} results · partial", { count: matches }),
      emptyMessage: matches
        ? t("Couldn’t search {names}. Some sessions may be missing.", { names })
        : t("Couldn’t search {names}. No results from the providers that answered.", { names }),
      incomplete: true,
      unavailableProviders: unreachable,
    };
  }

  return {
    searching: true,
    status: "ok",
    collapseGroups: false,
    groups,
    countLabel: matches === 1 ? t("{count} result", { count: matches }) : t("{count} results", { count: matches }),
    emptyMessage: t("No sessions match “{query}”.", { query }),
  };
}
