/**
 * Client-side "needs attention" tracker for threads.
 *
 * The relay's SessionSnapshot describes the ACTIVE thread in its top-level
 * fields, plus a `thread_activity` array for any backgrounded thread that still
 * has an in-flight turn, plus global `pending_approvals` /
 * `pending_ask_user_questions` arrays (each carrying its own `thread_id`). From
 * a stream of snapshots we derive, per thread, whether it is (a) currently
 * working and (b) waiting on user input, then maintain two kinds of badge:
 *
 *   - "needs_input": LIVE — shown while a thread is waiting for an approval /
 *                    ask-user answer, cleared as soon as the wait resolves.
 *   - "completed":   STICKY — set when a thread finishes its turn (stops working
 *                    without needing input) and kept until the user opens it.
 *
 * Browser notifications fire on the *transitions* into those states; the badge
 * map reflects current state. Both are suppressed for the thread the user is
 * actively looking at in a focused tab.
 *
 * The module is framework-agnostic: it exposes a tiny observable (subscribe /
 * getVersion) so React (useSyncExternalStore) and the imperative local renderer
 * can both react to out-of-band changes (clear-on-open, tab refocus). The pure
 * diff logic stays unit-testable.
 */

// Mirrors `thread_status_is_working` on the Rust side: any status other than
// these counts as "working".
const NON_WORKING_STATUSES = new Set(["", "idle", "viewing"]);

export function statusIsWorking(status) {
  return typeof status === "string" && !NON_WORKING_STATUSES.has(status);
}

const DEFAULT_STATE = { working: false, needsInput: false };

/**
 * Derive a per-thread `{ working, needsInput }` map from a single snapshot.
 *
 * @param {object} snapshot
 * @returns {Map<string, { working: boolean, needsInput: boolean }>}
 */
export function computeThreadStates(snapshot) {
  const states = new Map();
  if (!snapshot || typeof snapshot !== "object") {
    return states;
  }

  const ensure = (threadId) => {
    if (!threadId) {
      return null;
    }
    let entry = states.get(threadId);
    if (!entry) {
      entry = { working: false, needsInput: false };
      states.set(threadId, entry);
    }
    return entry;
  };

  const activeThreadId = snapshot.active_thread_id || null;

  // Active thread working state — mirrors ThreadRuntime::is_working (an in-flight
  // turn, a live phase, or a working status all count).
  if (activeThreadId) {
    const entry = ensure(activeThreadId);
    if (
      snapshot.active_turn_id != null ||
      snapshot.current_phase != null ||
      statusIsWorking(snapshot.current_status)
    ) {
      entry.working = true;
    }
  }

  // Backgrounded threads that still have an in-flight turn.
  if (Array.isArray(snapshot.thread_activity)) {
    for (const item of snapshot.thread_activity) {
      const entry = ensure(item?.thread_id);
      if (entry) {
        entry.working = true;
      }
    }
  }

  // Approvals and ask-user questions each carry their own thread_id, so a
  // backgrounded thread's request is attributed to *that* thread rather than the
  // active one. (Older snapshots without thread_id fall back to the active
  // thread, matching the relay's "force the awaited thread active" behavior.)
  if (Array.isArray(snapshot.pending_approvals)) {
    for (const approval of snapshot.pending_approvals) {
      const entry = ensure(approval?.thread_id || activeThreadId);
      if (entry) {
        entry.needsInput = true;
      }
    }
  }
  if (Array.isArray(snapshot.pending_ask_user_questions)) {
    for (const question of snapshot.pending_ask_user_questions) {
      const entry = ensure(question?.thread_id || activeThreadId);
      if (entry) {
        entry.needsInput = true;
      }
    }
  }

  // Fallback: the active thread's waiting flags catch cases where the request
  // arrays were compacted out of a budget-limited snapshot.
  const flags = Array.isArray(snapshot.active_flags) ? snapshot.active_flags : [];
  if (
    activeThreadId &&
    (flags.includes("waitingOnApproval") || flags.includes("waitingOnAskUser"))
  ) {
    const entry = ensure(activeThreadId);
    if (entry) {
      entry.needsInput = true;
    }
  }

  return states;
}

function stateFor(map, threadId) {
  return map.get(threadId) || DEFAULT_STATE;
}

/**
 * @typedef {"needs_input" | "completed"} AttentionKind
 * @typedef {{ threadId: string, kind: AttentionKind, notify: boolean }} AttentionEvent
 */

export class ThreadAttentionTracker {
  constructor() {
    /** @type {Map<string, { working: boolean, needsInput: boolean }> | null} */
    this.prev = null;
    /** @type {Map<string, AttentionKind>} */
    this.attention = new Map();
    /** Thread the user was last viewing (for focus-driven clearing). */
    this.lastViewed = null;
    /** Bumped on every attention-map change; the observable "snapshot". */
    this.version = 0;
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /**
   * Feed the next snapshot. Returns the *transition* events worth a browser
   * notification, and updates the badge map to reflect current state. The first
   * snapshot only establishes a baseline (no events).
   *
   * @param {object} snapshot
   * @param {{ viewedThreadId?: string | null, isForeground?: boolean }} [ctx]
   * @returns {AttentionEvent[]}
   */
  ingest(snapshot, { viewedThreadId = null, isForeground = true } = {}) {
    const next = computeThreadStates(snapshot);
    const prev = this.prev;
    /** @type {AttentionEvent[]} */
    const events = [];
    let changed = false;

    const setKind = (id, kind) => {
      if (this.attention.get(id) !== kind) {
        this.attention.set(id, kind);
        changed = true;
      }
    };
    const dropKind = (id) => {
      if (this.attention.delete(id)) {
        changed = true;
      }
    };
    // "Away" = the user is NOT staring at this exact thread in a focused tab.
    const away = (id) => !(isForeground && id === viewedThreadId);

    // 1. Notification events come from state *transitions* (skip the baseline).
    if (prev) {
      const threadIds = new Set([...prev.keys(), ...next.keys()]);
      for (const threadId of threadIds) {
        const before = stateFor(prev, threadId);
        const after = stateFor(next, threadId);
        let kind = null;
        if (after.needsInput && !before.needsInput) {
          kind = "needs_input";
        } else if (before.working && !after.working && !after.needsInput) {
          kind = "completed";
        }
        if (kind) {
          events.push({ threadId, kind, notify: away(threadId) });
        }
      }
    }

    // 2. needs_input badge is LIVE: present iff the thread is currently waiting
    //    (and the user isn't looking at it). Reconcile every snapshot.
    for (const [threadId, st] of next) {
      if (st.needsInput && away(threadId)) {
        setKind(threadId, "needs_input");
      } else if (this.attention.get(threadId) === "needs_input") {
        dropKind(threadId);
      }
    }
    // Threads that dropped out of the snapshot entirely no longer need input.
    for (const [threadId, kind] of [...this.attention]) {
      if (kind === "needs_input" && !next.get(threadId)?.needsInput) {
        dropKind(threadId);
      }
    }

    // 3. completed badge is STICKY: set on the work→idle transition, never over
    //    a live needs_input flag.
    for (const event of events) {
      if (event.kind === "completed" && event.notify && this.attention.get(event.threadId) !== "needs_input") {
        setKind(event.threadId, "completed");
      }
    }

    // 4. A thread that resumed working drops its stale "completed" flag.
    for (const [threadId, st] of next) {
      if (st.working && !st.needsInput && this.attention.get(threadId) === "completed") {
        dropKind(threadId);
      }
    }

    // 5. Whatever the user is viewing in the foreground needs no dot.
    if (isForeground && viewedThreadId) {
      dropKind(viewedThreadId);
    }

    this.lastViewed = viewedThreadId || this.lastViewed;
    this.prev = next;
    if (changed) {
      this._bump();
    }
    return events;
  }

  /** Remove a thread's badge (e.g. the user opened it). */
  clear(threadId) {
    if (threadId && this.attention.delete(threadId)) {
      this._bump();
    }
  }

  /**
   * Clear the last-viewed thread's badge when the tab regains focus — backs the
   * "refocus clears the dot" behavior even when no snapshot arrives.
   */
  clearViewedOnFocus(isForeground) {
    if (isForeground && this.lastViewed && this.attention.delete(this.lastViewed)) {
      this._bump();
    }
  }

  /** @returns {AttentionKind | null} */
  kindFor(threadId) {
    return this.attention.get(threadId) || null;
  }

  /** A stable copy of the attention map, for passing into renderers. */
  snapshotMap() {
    return new Map(this.attention);
  }

  /** Subscribe to attention-map changes. Returns an unsubscribe fn. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Monotonic version, usable as a useSyncExternalStore snapshot. */
  getVersion() {
    return this.version;
  }

  /** Drop all state (tests / hard resets). */
  reset() {
    this.prev = null;
    this.attention.clear();
    this.lastViewed = null;
    this._bump();
  }

  _bump() {
    this.version += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A bad subscriber must not break the tracker.
      }
    }
  }
}

/** Per-page singleton used by the app surfaces. */
export const threadAttention = new ThreadAttentionTracker();
