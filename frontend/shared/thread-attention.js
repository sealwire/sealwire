import { isWorkingThreadStatus } from "./thread-status.js";

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
 * map reflects current state. Completion badges are suppressed for the thread
 * the user is actively looking at in a focused tab; pending input remains live
 * until the request is answered. Notifications are suppressed for that thread.
 *
 * The module is framework-agnostic: it exposes a tiny observable (subscribe /
 * getVersion) so React (useSyncExternalStore) and the imperative local renderer
 * can both react to out-of-band changes (clear-on-open, tab refocus). The pure
 * diff logic stays unit-testable.
 */

// Mirrors `thread_status_is_working` on the Rust side: any status other than
// these counts as "working". `completed`/`unknown` are settled vocabulary (a
// saved-but-not-running Codex thread parses to `unknown`, Claude reports
// `completed`); classifying them as working made saved threads look busy
// forever and showed a Stop the backend then rejects with "no running
// turn". The vocabulary itself lives in shared/thread-status.js so this cannot
// drift from the backend (or from the other frontend predicates) again.
export function statusIsWorking(status) {
  return isWorkingThreadStatus(status);
}

// Single source of truth for "is this thread working?", mirroring
// `ThreadRuntime::is_working` (relay/runtime.rs): an in-flight turn OR a working
// provider status. `current_phase` is deliberately EXCLUDED — it is a
// descriptive label refreshed only for the active thread, so a thread that goes
// background mid-turn can keep a stale phase forever. The backend never treats a
// leftover phase as liveness, so neither must the UI: a phase-only "working"
// shows a Stop that the backend can't honor (deadlock).
export function sessionIsWorking(session) {
  return (
    Boolean(session && session.active_turn_id != null) ||
    statusIsWorking(session?.current_status)
  );
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
  // turn or a working status; a leftover phase does NOT count, see sessionIsWorking).
  if (activeThreadId && sessionIsWorking(snapshot)) {
    ensure(activeThreadId).working = true;
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

  // Each request carries its own thread_id, so a backgrounded thread's request
  // lands on that thread. One without it is never guessed onto the active
  // thread: the relay declines any request it cannot attribute.
  if (Array.isArray(snapshot.pending_approvals)) {
    for (const approval of snapshot.pending_approvals) {
      const entry = approval?.thread_id ? ensure(approval.thread_id) : null;
      if (entry) {
        entry.needsInput = true;
      }
    }
  }
  if (Array.isArray(snapshot.pending_ask_user_questions)) {
    for (const question of snapshot.pending_ask_user_questions) {
      const entry = question?.thread_id ? ensure(question.thread_id) : null;
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
 * Stable ids for every request currently blocking THIS thread on the reader, in
 * arrival order — an approval or an AskUser question. Same sources as
 * `computeThreadStates`' `needsInput`, but identities rather than a boolean,
 * because the transcript scroller uses them as fire-once keys
 * (`decideTranscriptScrollAction`): bring an arriving request into view, then
 * leave the reader alone for as long as those same requests are pending.
 *
 * Plural on purpose. Nothing constrains a thread to one pending question — the
 * relay and the worker both key them by id — so a second request arriving while
 * the first is still outstanding has to be able to fire its own scroll, and a
 * single render must be able to claim ALL of them at once.
 *
 * Ids are namespaced by source so an approval and a question that happen to
 * share a request_id stay distinct, and so they can share the per-thread
 * "already handled" Set with transcript item ids without ever colliding.
 *
 * Falls back to the waiting flags for budget-compacted snapshots that dropped
 * the request arrays; that fallback is keyed by turn so it, too, fires once.
 *
 * @param {object} snapshot
 * @param {string | null} threadId  defaults to the snapshot's active thread
 * @returns {string[]}
 */
export function findPendingInputRequestIds(snapshot, threadId = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  const activeThreadId = snapshot.active_thread_id || null;
  const target = threadId || activeThreadId;
  if (!target) {
    return [];
  }

  const ids = [];
  for (const source of ["pending_approvals", "pending_ask_user_questions"]) {
    const requests = Array.isArray(snapshot[source]) ? snapshot[source] : [];
    for (const request of requests) {
      // No thread_id means no thread (see computeThreadStates).
      if (request?.thread_id !== target) {
        continue;
      }
      if (request?.request_id) {
        ids.push(`${source}:${request.request_id}`);
      }
    }
  }
  if (ids.length) {
    return ids;
  }

  const flags = Array.isArray(snapshot.active_flags) ? snapshot.active_flags : [];
  if (
    target === activeThreadId
    && (flags.includes("waitingOnApproval") || flags.includes("waitingOnAskUser"))
  ) {
    return [`waiting:${target}:${snapshot.active_turn_id || ""}`];
  }

  return [];
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

    // 2. needs_input badge is LIVE: present iff the thread is currently waiting.
    //    Looking at a request does not answer it, and the bell reads this same map
    //    to put the session in its "Needs input" bucket. Reconcile every snapshot.
    for (const [threadId, st] of next) {
      if (st.needsInput) {
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

    // 5. A completed thread needs no dot once the user is viewing it. A pending
    //    request still needs an answer, so it keeps its dot and bell bucket.
    if (isForeground && viewedThreadId && this.attention.get(viewedThreadId) === "completed") {
      dropKind(viewedThreadId);
    }

    this.lastViewed = viewedThreadId || this.lastViewed;
    this.prev = next;
    if (changed) {
      this._bump();
    }
    return events;
  }

  /** Opening a thread acknowledges completion, but cannot answer pending input. */
  clear(threadId) {
    if (threadId && this.attention.get(threadId) === "completed") {
      this.attention.delete(threadId);
      this._bump();
    }
  }

  /**
   * Clear a completed badge when the tab regains focus, even without a snapshot.
   * A pending input request remains visible until it is answered.
   */
  clearViewedOnFocus(isForeground) {
    if (isForeground && this.lastViewed && this.attention.get(this.lastViewed) === "completed") {
      this.attention.delete(this.lastViewed);
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

/**
 * The AskUserQuestion requests belonging to ONE thread.
 *
 * A question belongs to the thread that asked it, and the renderer treats "a
 * matching pending request exists" as the authoritative signal that the
 * question is still open (transcript-react.js:862). Hand a pane the whole
 * snapshot's list and it will render an answer box for a question asked
 * somewhere else; hand it nothing and a genuinely-blocked thread renders as the
 * read-only "Answered" card instead.
 *
 * A question without `thread_id` belongs to no thread, as in
 * `findPendingInputRequestIds` above.
 *
 * @param {object|null} snapshot
 * @param {string|null} threadId defaults to the snapshot's active thread
 * @returns {object[]}
 */
export function pendingAskUserQuestionsForThread(snapshot, threadId = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  const activeThreadId = snapshot.active_thread_id || null;
  const target = threadId || activeThreadId;
  if (!target) {
    return [];
  }
  const requests = Array.isArray(snapshot.pending_ask_user_questions)
    ? snapshot.pending_ask_user_questions
    : [];
  return requests.filter((request) => request?.thread_id === target);
}
