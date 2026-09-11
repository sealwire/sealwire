import { useLayoutEffect, useRef } from "react";

import { findPendingInputRequestIds } from "../shared/thread-attention.js";
import { createTranscriptScrollBookkeeping } from "../shared/transcript-scroll-bookkeeping.js";

// Per-thread scroll bookkeeping for the local transcript pane, built on the
// engine shared with the remote pane (transcript-scroll-bookkeeping.js). What
// stays here is this surface's own timing: it renders through flushSync with
// no StrictMode, so its pre-swap read can happen directly in the render body
// instead of needing a continuous scroll listener. See .sealwire/PLAN.md.
export function useLocalTranscriptScrollBookkeeping({
  activeThreadId,
  entries,
  mode,
  promotion,
  resetEpoch,
  scrollElement,
  session,
}) {
  const engineRef = useRef(null);
  if (!engineRef.current) {
    engineRef.current = createTranscriptScrollBookkeeping();
  }
  const engine = engineRef.current;
  const pendingCommitRef = useRef(null);
  const appliedPromotionRef = useRef(null);
  // Seeded from the first render's value, not a hardcoded 0 — otherwise mount
  // itself would read as a reset if the caller's epoch already started > 0.
  const seenResetEpochRef = useRef(resetEpoch);

  // Before anything retained is read or rekeyed: a new run renames the same
  // messages, so a snapshot/position/anchor set from the old one anchors to ids
  // that no longer exist. Same-generation promotion below is untouched.
  engine.syncGeneration(session?.transcript_generation);

  // One-shot by IDENTITY: the caller never clears this field, so every render
  // until the next promotion hands back the same object, and re-running the
  // rekey against a since-reused `from` id would move someone else's data.
  if (promotion && appliedPromotionRef.current !== promotion) {
    appliedPromotionRef.current = promotion;
    engine.retarget({
      fromKey: promotion.from,
      toKey: promotion.to,
      fromThreadId: promotion.from,
      toThreadId: promotion.to,
    });
  }

  if (resetEpoch !== seenResetEpochRef.current) {
    seenResetEpochRef.current = resetEpoch;
    engine.reset();
  }

  // Runs in the render body, not an effect: this root only mutates its DOM at
  // commit (flushSync, no StrictMode), so scrollElement here still holds the
  // PREVIOUS commit's content — the one point that can see the leaving
  // thread's geometry before the swap clamps it.
  pendingCommitRef.current = null;

  if (mode === "empty-ready") {
    // Leaving another thread for this empty one: retain its offset BEFORE
    // rendering the empty state, or the swap's clamped scrollTop overwrites
    // the reader's actual place with a false (usually zero) one.
    const emptyThreadId = activeThreadId;
    const previousEmptySnapshot = engine.getSnapshot();
    if (
      previousEmptySnapshot?.activeThreadId
      && previousEmptySnapshot.activeThreadId !== emptyThreadId
    ) {
      engine.rememberView(previousEmptySnapshot.scrollKey, scrollElement);
    }

    // Record the (empty) snapshot for this genuinely-empty thread so its
    // first entries classify as a same-thread new message (jump-bottom that
    // fires once) instead of a thread switch that may restore stale history.
    pendingCommitRef.current = (element) => {
      engine.commitSnapshot({
        key: emptyThreadId,
        threadId: emptyThreadId,
        entries: [],
        scrollElement: element,
      });
    };
  } else if (mode === "entries") {
    const previousSnapshot = engine.getSnapshot();
    const localThreadId = activeThreadId;
    let restoredScrollPosition = null;
    if (
      previousSnapshot?.activeThreadId
      && previousSnapshot.activeThreadId !== localThreadId
    ) {
      engine.rememberView(previousSnapshot.scrollKey, scrollElement);
      restoredScrollPosition = engine.readRestoreIntent(localThreadId);
    }

    pendingCommitRef.current = (element) => {
      engine.applyRestore({
        key: localThreadId,
        nextEntries: entries,
        nextThreadId: localThreadId,
        pendingInputRequestIds: findPendingInputRequestIds(session, localThreadId),
        restoredScrollPosition,
        scrollElement: element,
      });
      engine.commitSnapshot({
        key: localThreadId,
        threadId: localThreadId,
        entries,
        scrollElement: element,
      });
    };
  }

  // Dep-less on purpose: this must run after every commit, mirroring the old
  // flushSync body. Cleared before running so a stale closure can never fire.
  useLayoutEffect(() => {
    const commit = pendingCommitRef.current;
    pendingCommitRef.current = null;
    commit?.(scrollElement);
  });
}
