import { openSessionStream, sessionStreamUrl } from "../../session-stream.js";

export function createStreamController(ctx) {
  const {
    state,
    logLine,
    seedDefaults,
    renderSession,
    handleUnauthorized,
  } = ctx;
  const applySessionSnapshot = (...args) => ctx.applySessionSnapshot(...args);
  const cancelSessionPoll = (...args) => ctx.cancelSessionPoll(...args);
  const cancelStreamReconnect = (...args) => ctx.cancelStreamReconnect(...args);
  const scheduleSessionPoll = (...args) => ctx.scheduleSessionPoll(...args);
  const scheduleStreamReconnect = (...args) => ctx.scheduleStreamReconnect(...args);

  function connectSessionStream() {
    if (state.authRequired && !state.authenticated) {
      return;
    }

    if (typeof fetch !== "function" || typeof AbortController === "undefined") {
      logLine("Fetch streaming is unavailable. Falling back to polling.");
      state.streamConnected = false;
      scheduleSessionPoll();
      return;
    }

    if (state.sessionStream) {
      state.sessionStream.close();
    }

    const stream = openSessionStream({
      url: sessionStreamUrl(window.location.origin),
      apiToken: state.apiToken,
      onSession(data) {
        try {
          const snapshot = JSON.parse(data);
          state.streamConnected = true;
          cancelSessionPoll();
          seedDefaults(snapshot);
          // Attention + notifications are handled inside applySessionSnapshot
          // (the chokepoint shared with the polling fallback).
          applySessionSnapshot(snapshot);
        } catch (error) {
          logLine(`Stream payload failed: ${error.message}`);
        }
      },
      onEvent({ data, type }) {
        try {
          applySessionStreamEvent(type, JSON.parse(data));
        } catch (error) {
          logLine(`Stream event failed: ${error.message}`);
        }
      },
      onOpen() {
        if (!state.streamConnected) {
          logLine("Session stream connected.");
        }
        state.streamConnected = true;
        cancelSessionPoll();
        cancelStreamReconnect();
      },
      onError(error) {
        if (state.sessionStream !== stream) {
          return;
        }

        if (error?.code === "unauthorized") {
          state.sessionStream = null;
          handleUnauthorized("Local auth session expired. Sign in again.");
          return;
        }

        logLine("Session stream disconnected. Falling back to polling.");
        state.streamConnected = false;
        state.sessionStream = null;
        scheduleSessionPoll();
        scheduleStreamReconnect();
      },
    });
    state.sessionStream = stream;
  }

  function applySessionStreamEvent(type, event) {
    if (!state.session) {
      return;
    }
    const kind = event?.kind || type;
    if (kind === "session_meta_updated") {
      const { transcript: _transcript, transcript_truncated: _truncated, ...metadata } =
        event.session || event.patch || event;
      renderSession({
        ...state.session,
        ...metadata,
        transcript: state.session.transcript,
        transcript_truncated: state.session.transcript_truncated,
      });
      return;
    }
    if (kind === "approval_added" && event.approval?.request_id) {
      const approvals = state.session.pending_approvals || [];
      const nextApprovals = approvals.some((approval) => approval?.request_id === event.approval.request_id)
        ? approvals.map((approval) =>
            approval?.request_id === event.approval.request_id
              ? { ...approval, ...event.approval }
              : approval
          )
        : [...approvals, event.approval];
      renderSession({ ...state.session, pending_approvals: nextApprovals });
      return;
    }
    if (kind === "approval_resolved") {
      const requestId = event.request_id || event.approval?.request_id || null;
      if (requestId) {
        renderSession({
          ...state.session,
          pending_approvals: (state.session.pending_approvals || [])
            .filter((approval) => approval?.request_id !== requestId),
        });
      }
      return;
    }
    if (
      kind === "transcript_entry_started"
      || kind === "transcript_entry_delta"
      || kind === "transcript_entry_completed"
      || kind === "transcript_entry_patched"
    ) {
      if (kind === "transcript_entry_delta") {
        applyLocalTranscriptEntryDelta(event);
      } else {
        applyLocalTranscriptEntryPatch(event, {
          defaultStatus:
            kind === "transcript_entry_completed"
              ? "completed"
              : kind === "transcript_entry_started"
                ? "running"
                : null,
        });
      }
    }
  }

  function applyLocalTranscriptEntryDelta(event) {
    if (!event?.item_id || !Array.isArray(state.session?.transcript)) {
      return;
    }
    const currentThreadId = state.session.active_thread_id || null;
    if (event.thread_id && currentThreadId && event.thread_id !== currentThreadId) {
      return;
    }
    const entryIndex = state.session.transcript.findIndex(
      (candidate) => candidate?.item_id === event.item_id
    );
    const nextTranscript = entryIndex >= 0
      ? state.session.transcript.map((entry, index) =>
          index === entryIndex
            ? {
              ...entry,
              entry_seq: Number.isSafeInteger(event.entry_seq) && !Number.isSafeInteger(entry.entry_seq)
                ? event.entry_seq
                : entry.entry_seq,
              kind: entry.kind || normalizeLocalDeltaKind(event.delta_kind || event.entry_kind),
              status: "running",
              text: `${entry.text ?? ""}${event.delta ?? ""}`,
              turn_id: entry.turn_id || event.turn_id || null,
            }
            : entry
        )
      : [
          ...state.session.transcript,
          {
            entry_seq: Number.isSafeInteger(event.entry_seq) ? event.entry_seq : null,
            item_id: event.item_id,
            kind: normalizeLocalDeltaKind(event.delta_kind || event.entry_kind),
            status: "running",
            text: event.delta ?? "",
            tool: null,
            turn_id: event.turn_id || null,
          },
        ];
    renderSession({
      ...state.session,
      transcript: nextTranscript,
      transcript_revision: Number.isSafeInteger(event.revision)
        ? event.revision
        : state.session.transcript_revision,
    });
  }

  function normalizeLocalDeltaKind(kind) {
    return kind === "command_output" ? "command" : kind || "agent_text";
  }

  function applyLocalTranscriptEntryPatch(event, { defaultStatus = null } = {}) {
    const currentThreadId = state.session?.active_thread_id || null;
    const eventThreadId = event.thread_id || event.active_thread_id || event.entry?.thread_id || null;
    if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
      return;
    }
    const entry = event.entry || {
      item_id: event.item_id,
      entry_seq: event.entry_seq,
      kind: event.entry_kind,
      status: event.status,
      text: event.text,
      tool: event.tool,
      turn_id: event.turn_id,
    };
    if (!entry?.item_id || !Array.isArray(state.session?.transcript)) {
      return;
    }
    const patchedEntry = {
      ...entry,
      kind: entry.kind || event.entry_kind || null,
      status: entry.status || defaultStatus || "completed",
      turn_id: entry.turn_id || event.turn_id || null,
    };
    const entryIndex = state.session.transcript.findIndex(
      (candidate) => candidate?.item_id === patchedEntry.item_id
    );
    const nextTranscript = entryIndex >= 0
      ? state.session.transcript.map((candidate, index) =>
          index === entryIndex
            ? {
              ...candidate,
              ...patchedEntry,
              kind: patchedEntry.kind || candidate.kind || "agent_text",
              text: patchedEntry.text ?? candidate.text ?? null,
              tool: patchedEntry.tool ?? candidate.tool ?? null,
              turn_id: patchedEntry.turn_id || candidate.turn_id || null,
            }
            : candidate
        )
      : [
          ...state.session.transcript,
          {
            text: patchedEntry.text ?? "",
            tool: patchedEntry.tool ?? null,
            ...patchedEntry,
            kind: patchedEntry.kind || "agent_text",
          },
        ];
    renderSession({
      ...state.session,
      transcript: nextTranscript,
      transcript_revision: Number.isSafeInteger(event.revision)
        ? event.revision
        : state.session.transcript_revision,
    });
  }

  return {
    connectSessionStream,
    applySessionStreamEvent,
    applyLocalTranscriptEntryDelta,
    normalizeLocalDeltaKind,
    applyLocalTranscriptEntryPatch,
  };
}
