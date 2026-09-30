// The bell: filter the session list down to what is actually going on.
//
// It is a FILTER, not a second page. The list has one source of truth and the bell
// narrows it — which is the whole reason it can be composed with search, and the reason
// there is never a second place showing "the same sessions but different".
//
// Buckets come from `selectThreadState`, the same ladder the per-row dot uses, so a row
// showing an amber dot is necessarily in the "Needs input" bucket. Idle threads have no
// state and no bucket: the bell shows everything that is NOT idle.
//
// It is ON or OFF, with no per-state selection. There used to be a row of state pills
// above the list; they said exactly what the bucket headers underneath already said
// (the same four labels, in the same order, over the same rows), so the pills were a
// second reading of the list sitting on top of the list. Whichever state you want, its
// bucket is already right there — scroll, don't narrow.

import { THREAD_STATES, THREAD_STATE_LABELS, selectThreadState } from "./thread-dot.js";

/** The bell at rest: off, remembering nothing. */
export const EMPTY_THREAD_FILTER = Object.freeze({
  on: false,
  retained: new Map(),
});

/**
 * A FRESH bell at rest — the seed for a new thread-list store.
 *
 * Deliberately not `EMPTY_THREAD_FILTER`. `Object.freeze` seals the wrapper but not the
 * `Map` inside it, so seeding every store from the constant would hand every store the
 * same `retained` instance. On remote that is precisely the cross-relay leak
 * `relay-scoped-state.js` exists to prevent — one relay's remembered states deciding
 * which of another's sessions the bell keeps listed — and it would be silent, because
 * the ids that collide are legitimate ids in both relays.
 *
 * `EMPTY_THREAD_FILTER` stays: it is the right value for a read fallback (frozen, shared,
 * never written) and for tests that want a stable literal.
 */
export function createThreadFilter() {
  return { on: false, retained: new Map() };
}

export function isThreadFilterActive(filter) {
  return Boolean(filter?.on);
}

function flattenThreads(groups) {
  return (groups || []).flatMap((group) => group?.threads || []);
}

/**
 * The monotonic retention map: thread id → the state it was last seen in.
 *
 * A row must not vanish from under the pointer because the agent answered while you were
 * reaching for it. So membership only ever GROWS while a filter is on: a thread that has
 * matched once stays listed until the filter is turned off or its selection changes.
 *
 * It remembers the STATE, not just the id, because a thread can leave the ladder
 * entirely. The sharpest case is the one the user is most likely to be watching: a
 * thread that finishes while you are looking at it gets no `completed` badge at all
 * (`thread-attention.js` drops the badge for the viewed foreground thread), so it goes
 * working → stateless. With only an id to go on there would be no bucket to keep it in
 * and the row would vanish anyway. A request that goes straight from pending to
 * idle is different: it must remain listed, but retaining `needs_input` would
 * claim an already-answered request still needs the user. Move that memory to
 * `completed` when no live state remains.
 *
 * New matches join live — that half must stay immediate, or the bell would show a
 * snapshot of the past rather than what is going on. Every non-idle thread is admitted:
 * the bell has no selection to gate on.
 *
 * A `Map`, not a plain object. Thread ids are arbitrary strings on the wire —
 * `ThreadSummaryView.id` is a bare `String` and no parser constrains it — so an id of
 * `"toString"` or `"constructor"` would read as already-present on an object literal and
 * be admitted past the selection, while `"__proto__"` could never be stored at all.
 *
 * Returns the next map, or the SAME instance when nothing changed. That identity
 * contract is load-bearing for React callers, which accumulate this in an effect and
 * need a cheap "did anything change?" test. `size` is not that test — a row moving
 * between states changes only a value — and a size-guarded write drops the update, so
 * the row snaps back to its old bucket the moment it goes stateless.
 */
export function nextRetainedStates(previous, groups, filter, stateOf) {
  const prev = previous instanceof Map ? previous : new Map();
  if (!isThreadFilterActive(filter)) {
    return prev.size ? new Map() : prev;
  }
  const next = new Map(prev);
  let changed = false;
  for (const thread of flattenThreads(groups)) {
    const id = thread?.id;
    const state = id ? stateOf(thread) : null;
    if (!state) {
      if (id && next.get(id) === "needs_input") {
        next.set(id, "completed");
        changed = true;
      }
      continue;
    }
    // Every live state refreshes the memory, so a row is remembered where it ACTUALLY
    // was last — not where it first joined. Otherwise a row that moved buckets would
    // snap back to the old one the moment it went stateless.
    if (next.get(id) !== state) {
      next.set(id, state);
      changed = true;
    }
  }
  return changed ? next : prev;
}

/**
 * Re-bucket the list by state, dropping idle threads.
 *
 * Groups come back in the ladder's order — not by recency — because that order IS the
 * urgency order, and a bell whose first bucket moved around would stop being scannable.
 */
export function buildThreadStateGroups(groups, { stateOf, retained = new Map() } = {}) {
  const buckets = new Map();

  for (const thread of flattenThreads(groups)) {
    const live = stateOf(thread);
    const remembered = (retained?.get?.(thread?.id)) || null;
    // A live state always wins, so a retained row moves to where it actually is rather
    // than being frozen where it entered. A retained row with no live state left keeps
    // its last bucket — that is what stops it vanishing when it goes idle.
    const state = live || remembered;
    if (!state) {
      // Never matched. Retention keeps rows, it does not admit new ones.
      continue;
    }
    // Anything off the ladder never reaches the output: the return below walks
    // THREAD_STATES, so a bucket keyed by something else is simply not emitted.
    if (!buckets.has(state)) {
      buckets.set(state, {
        key: `state:${state}`,
        // Empty on purpose: `ThreadGroupHeader` only makes a header clickable when it
        // carries a real cwd, so a state bucket folds but its label stays inert and can
        // never be written into the workspace input as a path.
        cwd: "",
        label: THREAD_STATE_LABELS[state],
        state,
        latestUpdatedAt: 0,
        threads: [],
      });
    }
    const bucket = buckets.get(state);
    bucket.threads.push(thread);
    bucket.latestUpdatedAt = Math.max(bucket.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return THREAD_STATES.filter((state) => buckets.has(state)).map((state) => {
    const bucket = buckets.get(state);
    return {
      ...bucket,
      threads: [...bucket.threads].sort(
        (left, right) => (right.updated_at || 0) - (left.updated_at || 0)
      ),
    };
  });
}

/**
 * What the list renders once the bell is applied.
 *
 * `groups` is whatever the list would otherwise show — the resting cwd groups, or the
 * search results. The bell narrows that, which is what lets the two compose.
 */
export function selectThreadFilterView({ groups = [], filter = null, stateOf = () => null } = {}) {
  if (!isThreadFilterActive(filter)) {
    return { filtering: false, groups };
  }

  const filtered = buildThreadStateGroups(groups, {
    stateOf,
    retained: filter.retained || new Map(),
  });
  const shown = filtered.reduce((total, group) => total + group.threads.length, 0);

  return {
    filtering: true,
    groups: filtered,
    countLabel: shown === 1 ? "1 session" : `${shown} sessions`,
    emptyMessage: "Nothing is running or waiting on you.",
  };
}

/**
 * Reconcile the count line and empty-state copy of the two narrowing controls.
 *
 * They can both have something to say about the same list, and picking one wholesale
 * produces a lie in either direction: take the search's count while the bell has
 * filtered the rows and it claims sessions that are not on screen ("2 results · partial"
 * over an empty list); take the bell's and an unreachable provider silently reads as an
 * all-clear.
 *
 * So: the NUMBER always describes what is rendered, and the WARNING always survives.
 * Loading and error are the exception — there the rows are stale or absent, so counting
 * them would be counting nothing, and the search's own words are the honest ones.
 */
export function composeListChrome(listView, filterView) {
  const status = listView?.status || "ok";
  if (status === "loading" || status === "error" || !filterView?.filtering) {
    return { countLabel: listView.countLabel, emptyMessage: listView.emptyMessage };
  }
  if (status === "partial") {
    return {
      countLabel: `${filterView.countLabel} · partial`,
      emptyMessage: listView.emptyMessage,
    };
  }
  return { countLabel: filterView.countLabel, emptyMessage: filterView.emptyMessage };
}

export { THREAD_STATES, THREAD_STATE_LABELS, selectThreadState };
