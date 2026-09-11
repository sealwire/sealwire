import { useLayoutEffect, useRef } from "react";

import { findPendingInputRequestIds } from "../shared/thread-attention.js";
import { createTranscriptScrollBookkeeping } from "../shared/transcript-scroll-bookkeeping.js";
import { setRemoteTranscriptElement } from "./ui-refs.js";

// Per-thread scroll bookkeeping for the remote transcript pane, built on the
// engine shared with the local pane (transcript-scroll-bookkeeping.js). Its
// scroll key is relay-scoped (`relayId:threadId`, since one pane shows
// threads from whichever relay is active); everything else here is this
// surface's own lifecycle timing.
//
// Lives in its own module because the ordering it has to respect — React
// commits child DOM mutations BEFORE running a parent's layout-effect cleanup —
// is only observable through the real hook, so the regression test drives this
// hook directly (use-transcript-scroll-bookkeeping.dom.test.mjs).
export function useRemoteTranscriptScrollBookkeeping({
  currentState,
  entries,
  session,
  threadId,
  transcriptRef,
}) {
  const engineRef = useRef(null);
  if (!engineRef.current) {
    engineRef.current = createTranscriptScrollBookkeeping();
  }
  const engine = engineRef.current;
  const renderedScrollKeyRef = useRef(null);

  // Before anything retained is read: the relay-scoped scroll key does not carry
  // the generation, so a reconnect that renumbers the same thread would restore
  // a position anchored to ids the new run never issued.
  engine.syncGeneration(session?.transcript_generation);

  const remoteThreadId = threadId || null;
  const remoteScrollKey = remoteThreadId
    ? `${currentState.activeRelayId || "-"}:${remoteThreadId}`
    : null;
  // The key of the thread the LATEST render is committing. Written during
  // render on purpose: a layout-effect cleanup runs after React has already
  // mutated the scroller's children, so this is the only handle the cleanup
  // has on "whose content is in the DOM right now". A render that never
  // commits can only make the check fail closed (we skip a redundant
  // re-record), never the other way around.
  renderedScrollKeyRef.current = remoteScrollKey;

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    setRemoteTranscriptElement(transcript);
    if (!transcript) {
      // No scrollKey (pass key: null): the next run reads that as "no
      // previous key" via the scrollKey-guarded checks below, since there is
      // no scroll element to file one against.
      engine.commitSnapshot({
        key: null,
        threadId: remoteThreadId,
        entries,
        scrollElement: null,
      });
      return undefined;
    }

    const previous = engine.getSnapshot();

    // Deferred-Claude promotion (send path sets the one-shot alias): same
    // logical thread under a new public id — rekey the retained bookkeeping
    // instead of treating it as a thread switch, so the first reply keeps the
    // send-anchor instead of jump-bottom briefly re-enabling live follow.
    const promotion = currentState.promotedThreadAlias || null;
    if (
      promotion
      && previous?.activeThreadId === promotion.from
      && remoteThreadId === promotion.to
    ) {
      engine.retarget({
        fromKey: `${currentState.activeRelayId || "-"}:${promotion.from}`,
        toKey: remoteScrollKey,
        fromThreadId: promotion.from,
        toThreadId: remoteThreadId,
      });
      // Consumed: the alias is one-shot. (An alias whose transition this pane
      // never renders stays until the next promotion overwrites it — pending
      // ids are unique, so it can never match anything else.)
      currentState.promotedThreadAlias = null;
    }

    let restoredScrollPosition = null;
    if (previous?.scrollKey && previous.scrollKey !== remoteScrollKey) {
      // The prior layout-effect cleanup and scroll listener retained the old
      // thread against its own DOM. Do not overwrite it here using the newly
      // rendered thread's geometry; that can turn a history-reading offset into
      // a false bottom-follow marker (or vice versa).
      if (!engine.hasPosition(previous.scrollKey)) {
        engine.rememberView(previous.scrollKey, previous);
      }
      restoredScrollPosition = engine.readRestoreIntent(remoteScrollKey);
    }

    engine.applyRestore({
      key: remoteScrollKey,
      nextEntries: entries,
      nextThreadId: remoteThreadId,
      // An approval / AskUser question is not a transcript entry, so it needs its
      // own trigger to be brought into view when it arrives (it renders last, at
      // the bottom). Fire-once, keyed on the request ids — plural because a
      // second question can arrive while the first is still outstanding.
      pendingInputRequestIds: findPendingInputRequestIds(session, remoteThreadId),
      restoredScrollPosition,
      scrollElement: transcript,
    });

    const rememberCurrentPosition = () => {
      // Only the thread currently in the DOM may write its own geometry. On a
      // thread switch this cleanup fires with the NEXT thread's content already
      // committed, and recording then would file that content's numbers (an
      // empty projection reads as "at the bottom") under the leaving thread's
      // key — silently converting a history-reading offset into bottom-follow.
      // The leaving thread's own entry is already current: the scroll listener
      // and this render's own call recorded it against its own DOM.
      if (renderedScrollKeyRef.current !== remoteScrollKey) {
        return;
      }
      engine.rememberView(remoteScrollKey, transcript);
    };
    rememberCurrentPosition();
    transcript.addEventListener("scroll", rememberCurrentPosition, { passive: true });

    engine.commitSnapshot({
      key: remoteScrollKey,
      threadId: remoteThreadId,
      entries,
      scrollElement: transcript,
    });
    return () => {
      rememberCurrentPosition();
      transcript.removeEventListener("scroll", rememberCurrentPosition);
      setRemoteTranscriptElement(null);
    };
  });
}
