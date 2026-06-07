/**
 * Client-side "needs attention" tracker for threads.
 *
 * The relay's SessionSnapshot describes only the ACTIVE thread in its top-level
 * fields (`active_turn_id` / `current_status` / `pending_*`), plus a
 * `thread_activity` array for any backgrounded thread that still has an
 * in-flight turn. From a stream of snapshots we derive, per thread, whether it
 * is (a) currently working and (b) waiting on user input — then flag the
 * transitions that deserve the user's attention:
 *
 *   - "needs_input": a thread started waiting for an approval / ask-user answer.
 *   - "completed":   a thread stopped working (turn ended) without needing input.
 *
 * Attention (and the matching browser notification) is suppressed for the
 * thread the user is actively looking at in a focused tab — they don't need a
 * nudge to notice what's on screen.
 *
 * This module is intentionally pure (no DOM, no globals beyond the exported
 * singleton) so the diffing logic can be unit-tested in isolation.
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

  // Ask-user questions carry their own thread_id (a backgrounded thread can ask).
  if (Array.isArray(snapshot.pending_ask_user_questions)) {
    for (const question of snapshot.pending_ask_user_questions) {
      const entry = ensure(question?.thread_id || activeThreadId);
      if (entry) {
        entry.needsInput = true;
      }
    }
  }

  // Approvals don't carry a thread_id; the relay forces the awaited thread
  // active, so attribute them (and the waiting flags) to the active thread.
  const flags = Array.isArray(snapshot.active_flags) ? snapshot.active_flags : [];
  const hasApprovals =
    Array.isArray(snapshot.pending_approvals) && snapshot.pending_approvals.length > 0;
  if (
    activeThreadId &&
    (hasApprovals ||
      flags.includes("waitingOnApproval") ||
      flags.includes("waitingOnAskUser"))
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
  }

  /**
   * Feed the next snapshot. Updates the attention map and returns the
   * attention-worthy transition events (for browser notifications). The first
   * snapshot only establishes a baseline and returns no events.
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

        if (!kind) {
          continue;
        }

        // The user is staring at this exact thread in a focused tab — no nudge.
        const away = !(isForeground && threadId === viewedThreadId);
        if (away) {
          // needs_input outranks a prior "completed" flag on the same thread.
          if (kind === "needs_input" || this.attention.get(threadId) !== "needs_input") {
            this.attention.set(threadId, kind);
          }
          events.push({ threadId, kind, notify: true });
        } else {
          this.attention.delete(threadId);
          events.push({ threadId, kind, notify: false });
        }
      }
    }

    // A thread that resumed working is no longer "waiting" on the user, so drop a
    // stale "completed" flag. Keep "needs_input" (it stays active during approval).
    for (const [threadId, st] of next) {
      if (st.working && !st.needsInput && this.attention.get(threadId) === "completed") {
        this.attention.delete(threadId);
      }
    }

    // Returning to a thread in the foreground clears its dot, even with no
    // transition this tick (covers tab-refocus and plain navigation).
    if (isForeground && viewedThreadId) {
      this.attention.delete(viewedThreadId);
    }

    this.prev = next;
    return events;
  }

  /** Remove a thread's attention flag (e.g. the user opened it). */
  clear(threadId) {
    if (threadId) {
      this.attention.delete(threadId);
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

  /** Drop all state (tests / hard resets). */
  reset() {
    this.prev = null;
    this.attention.clear();
  }
}

/** Per-page singleton used by the app surfaces. */
export const threadAttention = new ThreadAttentionTracker();
