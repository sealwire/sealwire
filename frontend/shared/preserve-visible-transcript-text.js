import { transcriptRowKey } from "./transcript-row-key.js";
// Guards a snapshot against regressing already-visible text — independent of
// the hydration window, unlike restoreHydratedTranscript (which is a no-op
// returning the snapshot verbatim whenever the window has never loaded for
// this thread). Deltas legitimately arrive before the first hydration fetch
// resolves, so the held session can already hold longer text than a compacted
// snapshot for the same entry. One implementation for both surfaces.

import { transcriptPageIsFromAnotherGeneration } from "./transcript-generation.js";

// Authoritative (`full`) content is anything not explicitly flagged
// `preview`/`omitted` by snapshot compaction — including a genuine body that
// ends in "...". String-suffix inference is intentionally gone.
function isFullSnapshotEntry(entry) {
  const state = entry?.content_state;
  return state !== "preview" && state !== "omitted";
}

function selectVisibleSnapshotEntry(current, incoming) {
  const currentText = current?.text;
  const incomingText = incoming?.text;
  // Take the incoming entry as-is when it is authoritative, or when we have no
  // full text of our own to protect.
  if (
    isFullSnapshotEntry(incoming)
    || typeof currentText !== "string"
    || !isFullSnapshotEntry(current)
  ) {
    return incoming;
  }
  // Omitted: the incoming shell text is meaningless, so keep our visible body —
  // but DO NOT promote content_state to full. The snapshot still says "omitted",
  // so the hydration store re-fetches the authoritative body (promoting it here
  // would defeat re-hydration and freeze a stale body).
  if (incoming?.content_state === "omitted") {
    return {
      ...incoming,
      text: currentText,
    };
  }
  // Preview: keep our visible body only if it is at least as long (more
  // complete); otherwise the grown preview is fresher. Either way the incoming
  // content_state (preview) is preserved so hydration still settles the entry.
  if (currentText.length >= incomingText.length) {
    return {
      ...incoming,
      text: currentText,
    };
  }
  return incoming;
}

export function preserveVisibleTranscriptText(currentSession, snapshot) {
  if (
    !currentSession?.active_thread_id
    || !snapshot?.active_thread_id
    || currentSession.active_thread_id !== snapshot.active_thread_id
    || !Array.isArray(currentSession.transcript)
    || !Array.isArray(snapshot.transcript)
    // Across a restart the same item id can name a different message, so there is
    // nothing of ours to protect — "preserving" would graft the old run's body on.
    || transcriptPageIsFromAnotherGeneration(currentSession, snapshot)
  ) {
    return snapshot;
  }

  const currentByItemId = new Map(
    currentSession.transcript
      .filter((entry) => transcriptRowKey(entry))
      .map((entry) => [transcriptRowKey(entry), entry])
  );
  let changed = false;
  const transcript = snapshot.transcript.map((entry) => {
    const current = currentByItemId.get(transcriptRowKey(entry));
    let resolved = selectVisibleSnapshotEntry(current, entry);
    // Absorbing: an out-of-order snapshot serialized before the withdrawal must
    // not resurrect a row this client already saw withdrawn.
    if (current?.withdrawn === true && resolved.withdrawn !== true) {
      resolved = { ...resolved, withdrawn: true };
    }
    if (resolved === entry) {
      return entry;
    }
    changed = true;
    return resolved;
  });

  return changed
    ? {
      ...snapshot,
      transcript,
    }
    : snapshot;
}
