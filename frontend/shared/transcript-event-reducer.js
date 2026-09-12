import { transcriptRowKey } from "./transcript-row-key.js";
export function reduceTranscriptDeltaEvent({
  session = null,
  event = null,
  currentThreadId = session?.active_thread_id || null,
  currentEntry = undefined,
  hasCurrentEntry = undefined,
  buildTranscript = true,
  rejectStaleRevision = false,
  enforceBaseRevisionWithoutOffset = false,
  requireEventThreadId = false,
  useDeltaEventKindFallback = false,
  unknownDeltaKindFallback = "preserve",
  appendEmptyOffsetlessDelta = false,
} = {}) {
  const itemId = transcriptRowKey(event) || null;
  const eventThreadId = transcriptEventThreadId(event);
  const currentRevision = numericRevision(session?.transcript_revision);
  const eventRevision = numericRevision(event?.revision ?? event?.transcript_revision);
  const nextRevision = nextMonotonicRevision(currentRevision, eventRevision);

  if (!session || !Array.isArray(session.transcript)) {
    return deltaNoop("missing_session", { currentRevision, eventRevision, nextRevision });
  }
  if (!itemId) {
    return deltaNoop("missing_item", { currentRevision, eventRevision, nextRevision });
  }
  if (requireEventThreadId && !eventThreadId) {
    return deltaNoop("missing_thread", { itemId, currentRevision, eventRevision, nextRevision });
  }
  if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
    return deltaNoop("wrong_thread", {
      itemId,
      eventThreadId,
      currentThreadId,
      currentRevision,
      eventRevision,
      nextRevision,
    });
  }
  if (
    rejectStaleRevision
    && eventRevision != null
    && currentRevision != null
    && eventRevision < currentRevision
  ) {
    return deltaNoop("stale_revision", {
      itemId,
      eventThreadId,
      currentThreadId,
      currentRevision,
      eventRevision,
      nextRevision,
    });
  }

  const transcript = session.transcript;
  const entryIndex = hasCurrentEntry === undefined
    ? transcript.findIndex((entry) => transcriptRowKey(entry) === itemId)
    : (hasCurrentEntry ? 0 : -1);
  const entry = hasCurrentEntry === undefined
    ? transcript[entryIndex]
    : currentEntry;
  const hasEntry = entryIndex >= 0;
  const deltaText = event.delta ?? "";
  const offset = numericOffset(event.text_offset);
  const resolvedKind = normalizeTranscriptDeltaKind(
    event.delta_kind || event.entry_kind || (useDeltaEventKindFallback ? event.kind : null),
    { unknownKindFallback: unknownDeltaKindFallback }
  );

  if (offset != null) {
    const haveText = hasEntry ? entry?.text ?? "" : "";
    const have = haveText.length;
    if (have < offset) {
      return deltaNeedsRepair("offset_gap", {
        itemId,
        eventThreadId,
        currentThreadId,
        currentRevision,
        eventRevision,
        nextRevision,
        entryIndex,
        unknownItem: !hasEntry,
        detail: { item: itemId, offset, have },
      });
    }
    const appendText = resolveDeltaAppend(haveText, deltaText, offset);
    if (appendText == null) {
      return deltaNeedsRepair("offset_mismatch", {
        itemId,
        eventThreadId,
        currentThreadId,
        currentRevision,
        eventRevision,
        nextRevision,
        entryIndex,
        unknownItem: !hasEntry,
        detail: { item: itemId, offset, have },
      });
    }
    if (appendText === "") {
      return {
        kind: "duplicate",
        itemId,
        eventThreadId,
        currentThreadId,
        currentRevision,
        eventRevision,
        nextRevision,
        entryIndex,
        textLengthBefore: have,
        textLengthAfter: have,
      };
    }
    return deltaAppend({
      session,
      event,
      itemId,
      eventThreadId,
      currentThreadId,
      currentRevision,
      eventRevision,
      nextRevision,
      transcript,
      entry,
      entryIndex,
      appendText,
      resolvedKind,
      buildTranscript,
    });
  }

  const baseRevision = numericRevision(event.base_revision);
  if (
    enforceBaseRevisionWithoutOffset
    && baseRevision != null
    && currentRevision != null
    && baseRevision !== currentRevision
  ) {
    return deltaNeedsRepair("base_revision_gap", {
      itemId,
      eventThreadId,
      currentThreadId,
      currentRevision,
      eventRevision,
      nextRevision,
      entryIndex,
      unknownItem: !hasEntry,
      detail: { item: itemId, base_revision: baseRevision, current: currentRevision },
    });
  }

  if (deltaText === "" && !appendEmptyOffsetlessDelta) {
    const haveText = hasEntry ? entry?.text ?? "" : "";
    return deltaNoop("empty_offsetless_delta", {
      itemId,
      eventThreadId,
      currentThreadId,
      currentRevision,
      eventRevision,
      nextRevision,
      entryIndex,
      textLengthBefore: haveText.length,
      textLengthAfter: haveText.length,
      unknownItem: !hasEntry,
    });
  }

  return deltaAppend({
    session,
    event,
    itemId,
    eventThreadId,
    currentThreadId,
    currentRevision,
    eventRevision,
    nextRevision,
    transcript,
    entry,
    entryIndex,
    appendText: deltaText,
    resolvedKind,
    buildTranscript,
  });
}

export function reduceTranscriptEntryPatchEvent({
  session = null,
  event = null,
  currentThreadId = session?.active_thread_id || null,
  defaultStatus = null,
  rejectStaleRevision = false,
  enforceBaseRevision = false,
  useEventKindFallback = false,
  unknownEntryKindFallback = useEventKindFallback ? "agent_text" : "preserve",
  windowLoaded = false,
} = {}) {
  const currentRevision = numericRevision(session?.transcript_revision);
  const eventRevision = numericRevision(event?.revision ?? event?.transcript_revision);
  const nextRevision = nextMonotonicRevision(currentRevision, eventRevision);
  const eventThreadId = transcriptEventThreadId(event);

  if (!session || !Array.isArray(session.transcript)) {
    return patchRejected("missing_session", {
      currentRevision,
      eventRevision,
      nextRevision,
      eventThreadId,
    });
  }
  if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
    return patchRejected("wrong_thread", {
      currentRevision,
      eventRevision,
      nextRevision,
      eventThreadId,
      currentThreadId,
    });
  }
  if (
    rejectStaleRevision
    && eventRevision != null
    && currentRevision != null
    && eventRevision < currentRevision
  ) {
    return patchRejected("revision_mismatch", {
      currentRevision,
      eventRevision,
      nextRevision,
      eventThreadId,
      currentThreadId,
      repairDetail: revisionMismatchDetail(event, currentRevision),
    });
  }
  const baseRevision = numericRevision(event?.base_revision);
  if (
    enforceBaseRevision
    && baseRevision != null
    && currentRevision != null
    && baseRevision !== currentRevision
  ) {
    return patchRejected("revision_mismatch", {
      currentRevision,
      eventRevision,
      nextRevision,
      eventThreadId,
      currentThreadId,
      repairDetail: revisionMismatchDetail(event, currentRevision),
    });
  }

  const incoming = event?.entry || {
    // Carried so the fabricated row keys the same way the snapshot row will.
    // Without it this row lands under `item_id` and the next snapshot copy —
    // keyed on `row_id` — renders as a SECOND copy of the same message.
    row_id: event?.row_id,
    item_id: event?.item_id,
    entry_seq: event?.entry_seq,
    order_seq: event?.order_seq,
    kind: event?.entry_kind || (useEventKindFallback ? event?.kind : undefined),
    status: event?.status,
    text: event?.text,
    tool: event?.tool,
    turn_id: event?.turn_id,
  };
  const itemId = transcriptRowKey(incoming) || transcriptRowKey(event) || null;
  if (!itemId) {
    return patchRejected("missing_item", {
      currentRevision,
      eventRevision,
      nextRevision,
      eventThreadId,
      currentThreadId,
    });
  }

  const rawKind = incoming.kind || event?.entry_kind || null;
  const entryPatch = {
    ...incoming,
    item_id: itemId,
    kind: rawKind
      ? normalizeTranscriptEventEntryKind(rawKind, {
        unknownKindFallback: unknownEntryKindFallback,
      })
      : null,
    status: incoming.status || defaultStatus || "completed",
    turn_id: incoming.turn_id || event?.turn_id || null,
  };
  if (Number.isSafeInteger(incoming?.order_seq)) {
    entryPatch.order_seq = incoming.order_seq;
  }
  const entryIndex = session.transcript.findIndex(
    (entry) => transcriptRowKey(entry) === itemId
  );
  const patchIntroducesUntrackedItem = entryIndex < 0 && windowLoaded;
  const nextTranscript = entryIndex >= 0
    ? session.transcript.map((entry, index) => {
        if (index !== entryIndex) {
          return entry;
        }
        return {
          ...entry,
          ...entryPatch,
          kind: entryPatch.kind || entry.kind || "agent_text",
          text: entryPatch.text ?? entry.text ?? null,
          tool: entryPatch.tool ?? entry.tool ?? null,
          turn_id: entryPatch.turn_id || entry.turn_id || null,
          // Absorbing: a late unmarked copy must not resurrect a withdrawn row.
          ...(entry.withdrawn === true || entryPatch.withdrawn === true
            ? { withdrawn: true }
            : {}),
        };
      })
    : insertRowByOrderSeq(session.transcript, {
        text: entryPatch.text ?? "",
        tool: entryPatch.tool ?? null,
        ...entryPatch,
        kind: entryPatch.kind || "agent_text",
      });
  const nextSession = { ...session, transcript: nextTranscript };
  if (eventRevision != null) {
    nextSession.transcript_revision = nextRevision;
  }

  return {
    kind: "accepted_patch",
    itemId,
    eventThreadId,
    currentThreadId,
    currentRevision,
    eventRevision,
    nextRevision,
    entryIndex,
    entryPatch,
    nextTranscript,
    nextSession,
    patchIntroducesUntrackedItem,
    terminal: entryPatch.status !== "running",
  };
}

export function resolveDeltaAppend(haveText, deltaText, textOffset) {
  const offset = numericOffset(textOffset);
  if (offset == null) {
    return deltaText;
  }
  const have = haveText.length;
  if (have < offset) {
    return null;
  }
  const overlapLen = Math.min(have - offset, deltaText.length);
  if (
    overlapLen > 0
    && haveText.slice(offset, offset + overlapLen) !== deltaText.slice(0, overlapLen)
  ) {
    return null;
  }
  if (have >= offset + deltaText.length) {
    return "";
  }
  return deltaText.slice(have - offset);
}

export function normalizeTranscriptDeltaKind(kind, { unknownKindFallback = "preserve" } = {}) {
  if (!kind) {
    return "agent_text";
  }
  if (kind === "command_output") {
    return "command";
  }
  if (kind === "agent_text") {
    return "agent_text";
  }
  return unknownKindFallback === "agent_text" ? "agent_text" : kind;
}

export function normalizeTranscriptEventEntryKind(kind, { unknownKindFallback = "preserve" } = {}) {
  if (
    kind === "user_text"
    || kind === "agent_text"
    || kind === "command"
    || kind === "tool_call"
    || kind === "reasoning"
  ) {
    return kind;
  }
  return normalizeTranscriptDeltaKind(kind || "agent_text", { unknownKindFallback });
}

export function numericRevision(value) {
  return Number.isSafeInteger(value) ? value : null;
}

export function numericOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function nextMonotonicRevision(currentRevision, eventRevision) {
  if (eventRevision == null) {
    return currentRevision;
  }
  if (currentRevision == null) {
    return eventRevision;
  }
  return Math.max(currentRevision, eventRevision);
}

export function transcriptEventThreadId(event) {
  return event?.thread_id || event?.active_thread_id || event?.entry?.thread_id || null;
}

function deltaAppend({
  session,
  event,
  itemId,
  eventThreadId,
  currentThreadId,
  currentRevision,
  eventRevision,
  nextRevision,
  transcript,
  entry,
  entryIndex,
  appendText,
  resolvedKind,
  buildTranscript,
}) {
  const hasEntry = entryIndex >= 0;
  const haveText = hasEntry ? entry?.text ?? "" : "";
  const nextEntry = hasEntry
    ? {
      ...entry,
      entry_seq: Number.isSafeInteger(event.entry_seq) && !Number.isSafeInteger(entry.entry_seq)
        ? event.entry_seq
        : entry.entry_seq,
      kind: entry.kind || resolvedKind,
      status: "running",
      text: `${haveText}${appendText}`,
      turn_id: entry.turn_id || event.turn_id || null,
    }
    : {
      // Same reason as the patch path: a row born from a delta must carry the
      // relay's key, or the snapshot copy of it arrives as a separate row.
      ...(typeof event.row_id === "string" && event.row_id ? { row_id: event.row_id } : {}),
      item_id: itemId,
      turn_id: event.turn_id ?? null,
      text: appendText,
      kind: resolvedKind,
      status: "running",
      tool: null,
      entry_seq: Number.isSafeInteger(event.entry_seq) ? event.entry_seq : null,
      ...(Number.isSafeInteger(event.order_seq) ? { order_seq: event.order_seq } : {}),
    };
  const nextTranscript = buildTranscript
    ? (hasEntry
        ? transcript.map((candidate, index) => index === entryIndex ? nextEntry : candidate)
        : insertRowByOrderSeq(transcript, nextEntry))
    : null;
  const nextSession = buildTranscript
    ? {
      ...session,
      transcript: nextTranscript,
    }
    : null;
  if (nextSession && eventRevision != null) {
    nextSession.transcript_revision = nextRevision;
  }
  return {
    kind: "append",
    itemId,
    eventThreadId,
    currentThreadId,
    currentRevision,
    eventRevision,
    nextRevision,
    entryIndex,
    appendText,
    entryPatch: nextEntry,
    nextTranscript,
    nextSession,
    textLengthBefore: haveText.length,
    textLengthAfter: haveText.length + appendText.length,
    unknownItem: !hasEntry,
  };
}

function deltaNeedsRepair(reason, detail) {
  return {
    kind: "needs_repair",
    reason,
    ...detail,
  };
}

function deltaNoop(reason, detail = {}) {
  return {
    kind: "noop",
    reason,
    ...detail,
  };
}

function patchRejected(reason, detail = {}) {
  return {
    kind: "rejected_patch",
    reason,
    ...detail,
  };
}

function revisionMismatchDetail(event, currentRevision) {
  return {
    base_revision: event?.base_revision,
    current: currentRevision,
    item: transcriptRowKey(event) || transcriptRowKey(event?.entry),
  };
}

// Place a NEW row in a plain transcript array by its birth number.
//
// The array surfaces (the Orchestrator buffer, a view-only pin, an unhydrated
// remote session) have no window to merge into, so a new row was always pushed
// to the end — which renders two rows that stream at once in whichever order
// their first delta happened to arrive.
//
// Deliberately gives up and appends the moment it meets an unnumbered
// neighbour: a mixed array is an old relay's, where position is the only
// information there is, and reordering against a row that was never numbered
// would be a guess dressed up as a fact.
export function insertRowByOrderSeq(transcript, entry) {
  if (!Number.isSafeInteger(entry?.order_seq)) {
    return [...transcript, entry];
  }
  let index = transcript.length;
  while (index > 0) {
    const neighbour = transcript[index - 1];
    if (!Number.isSafeInteger(neighbour?.order_seq)) {
      return [...transcript, entry];
    }
    if (neighbour.order_seq <= entry.order_seq) {
      break;
    }
    index -= 1;
  }
  if (index >= transcript.length) {
    return [...transcript, entry];
  }
  return [...transcript.slice(0, index), entry, ...transcript.slice(index)];
}
