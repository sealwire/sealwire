import {
  dispatchOrRecover,
  dispatchRemoteActionWithoutReply,
  scheduleClaimRefresh,
} from "./actions.js";
import {
  isCurrentDeviceActiveController,
  renderLog,
  renderSession,
} from "./session-surface.js";
import {
  state,
} from "./state.js";
import {
  clearTranscriptHydration,
  restoreHydratedTranscript,
} from "./transcript/store.js";
import {
  hydrateRemoteTranscript,
  loadOlderRemoteTranscript,
} from "./transcript/hydration.js";
import {
  createTranscriptEntryDetailFetcher,
  createTranscriptPageFetcher,
} from "./transcript/api.js";
import {
  createThreadListQueryOptions,
  createThreadTranscriptPageQueryOptions,
} from "../shared/thread-queries.js";
import {
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./transcript/details.js";
import { remoteQueryClient } from "./query-client.js";
import { remoteUiRefs } from "./ui-refs.js";
import {
  applyRemoteSurfacePatch,
  createRemoteThreadsPatch,
} from "./surface-state.js";

const fetchRawTranscriptPage = createTranscriptPageFetcher(dispatchOrRecover);
const fetchTranscriptEntryDetailRequest =
  createTranscriptEntryDetailFetcher(dispatchOrRecover);

function remoteQueryScope() {
  return state.remoteAuth?.relayId || "unpaired";
}

function fetchTranscriptPage({ threadId, before }) {
  return remoteQueryClient.fetchQuery(
    createThreadTranscriptPageQueryOptions({
      before,
      fetchPage: fetchRawTranscriptPage,
      scope: remoteQueryScope(),
      surface: "remote",
      threadId,
    })
  );
}

function transcriptDeltaKindToEntryKind(deltaKind) {
  switch (deltaKind) {
    case "command_output":
      return "command";
    case "agent_text":
    default:
      return "agent_text";
  }
}

export function applyTranscriptDelta({
  thread_id,
  base_revision,
  revision,
  entry_seq,
  server_time,
  item_id,
  turn_id,
  delta,
  delta_kind,
  kind,
}) {
  if (typeof window !== "undefined" && typeof window.__transcriptDeltaCount === "number") {
    window.__transcriptDeltaCount++;
  }
  if (!state.session) return;
  const currentThreadId = state.session.active_thread_id || null;
  if (thread_id && currentThreadId && thread_id !== currentThreadId) {
    const message = `[transcript-delta] ignored thread=${thread_id} current=${currentThreadId} item=${item_id || "-"} kind=${delta_kind || kind || "-"}`;
    renderLog(message);
    // TODO(remote-monitor-debug): Remove this console mirror once transcript routing is stable.
    console.log(message);
    return;
  }
  const currentRevision = numericRevision(state.session.transcript_revision);
  const deltaBaseRevision = numericRevision(base_revision);
  const deltaRevision = numericRevision(revision);
  if (
    deltaRevision != null
    && currentRevision != null
    && deltaRevision < currentRevision
  ) {
    const message = `[transcript-delta] ignored stale revision=${deltaRevision} current=${currentRevision} thread=${thread_id || "-"} item=${item_id || "-"}`;
    renderLog(message);
    console.log(message);
    return;
  }
  if (
    deltaBaseRevision != null
    && currentRevision != null
    && deltaBaseRevision !== currentRevision
  ) {
    const message = `[transcript-delta] ignored base_revision=${deltaBaseRevision} current=${currentRevision} thread=${thread_id || "-"} item=${item_id || "-"}`;
    renderLog(message);
    console.log(message);
    return;
  }

  const currentSession = state.session;
  const transcript = currentSession.transcript;
  if (!Array.isArray(transcript)) return;
  const resolvedKind = transcriptDeltaKindToEntryKind(delta_kind || kind);

  const entryIndex = transcript.findIndex((e) => e.item_id === item_id);
  const nextTranscript = entryIndex >= 0
    ? transcript.map((entry, index) => {
        if (index !== entryIndex) {
          return entry;
        }
        return {
          ...entry,
          entry_seq: Number.isSafeInteger(entry_seq) && !Number.isSafeInteger(entry.entry_seq)
            ? entry_seq
            : entry.entry_seq,
          kind: entry.kind || resolvedKind,
          status: "running",
          text: `${entry.text ?? ""}${delta ?? ""}`,
          turn_id: entry.turn_id || turn_id || null,
        };
      })
    : [
        ...transcript,
        {
          item_id,
          turn_id: turn_id ?? null,
          text: delta ?? "",
          kind: resolvedKind,
          status: "running",
          tool: null,
          entry_seq: Number.isSafeInteger(entry_seq) ? entry_seq : null,
        },
      ];
  const nextSession = {
    ...currentSession,
    transcript: nextTranscript,
  };
  if (deltaRevision != null) {
    nextSession.transcript_revision = deltaRevision;
  }
  if (Number.isSafeInteger(server_time)) {
    nextSession.server_time = server_time;
  }

  renderSession(nextSession);
}

export function applyTranscriptEvent(event) {
  const eventKind = event?.kind || event?.type || "";
  if (!state.session) {
    return;
  }

  if (eventKind === "transcript_entry_delta") {
    applyTranscriptDelta({
      ...event,
      delta_kind: event.delta_kind || event.entry_kind || event.entry?.kind,
      kind: event.entry_kind || event.entry?.kind,
    });
    return;
  }

  if (
    eventKind === "transcript_entry_started"
    || eventKind === "transcript_entry_completed"
    || eventKind === "transcript_entry_patched"
  ) {
    applyTranscriptEntryPatch(event, {
      defaultStatus:
        eventKind === "transcript_entry_completed"
          ? "completed"
          : eventKind === "transcript_entry_started"
            ? "running"
            : null,
    });
    return;
  }

  if (eventKind === "approval_added") {
    const approval = event.approval || event.request || null;
    if (!approval?.request_id) {
      return;
    }
    applySessionMetadataPatch({
      pending_approvals: upsertApproval(state.session.pending_approvals || [], approval),
    });
    return;
  }

  if (eventKind === "approval_resolved") {
    const requestId = event.request_id || event.approval?.request_id || null;
    if (!requestId) {
      return;
    }
    applySessionMetadataPatch({
      pending_approvals: (state.session.pending_approvals || [])
        .filter((approval) => approval?.request_id !== requestId),
    });
    return;
  }

  if (eventKind === "session_meta_updated") {
    applySessionMetadataPatch(event.session || event.patch || event);
  }
}

export function applySessionSnapshot(snapshot) {
  if (typeof window !== "undefined" && typeof window.__snapshotCount === "number") {
    window.__snapshotCount++;
  }
  if (!shouldAcceptSessionSnapshot(snapshot)) {
    const currentRevision = numericRevision(state.session?.transcript_revision);
    const incomingRevision = numericRevision(snapshot?.transcript_revision);
    const message = `[session-snapshot] ignored stale revision=${incomingRevision ?? "-"} current=${currentRevision ?? "-"} thread=${snapshot?.active_thread_id || "-"}`;
    renderLog(message);
    console.log(message);
    return;
  }
  const previousThreadId = state.session?.active_thread_id || "-";
  syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot);
  const effectiveSnapshot = restoreHydratedTranscript(state, snapshot);
  applyRenderedSession(effectiveSnapshot, {
    hydrationSnapshot: snapshot,
  });
  const scrollTop = remoteUiRefs.remoteTranscript?.scrollTop || 0;
  const scrollHeight = remoteUiRefs.remoteTranscript?.scrollHeight || 0;
  const clientHeight = remoteUiRefs.remoteTranscript?.clientHeight || 0;
  const windowY =
    typeof window.scrollY === "number"
      ? window.scrollY
      : typeof window.pageYOffset === "number"
        ? window.pageYOffset
        : 0;
  const restored =
    effectiveSnapshot !== snapshot
      || (snapshot?.transcript_truncated && !effectiveSnapshot?.transcript_truncated)
      ? "1"
      : "0";
  const message = `[scroll] applySessionSnapshot prev=${previousThreadId} input=${snapshot?.active_thread_id || "-"} effective=${effectiveSnapshot?.active_thread_id || "-"} state=${state.session?.active_thread_id || "-"} in_truncated=${snapshot?.transcript_truncated ? "1" : "0"} out_truncated=${effectiveSnapshot?.transcript_truncated ? "1" : "0"} restored=${restored} hydration=${state.transcriptHydrationStatus} older_cursor=${state.transcriptHydrationOlderCursor ?? "-"} entries=${effectiveSnapshot?.transcript?.length || 0} top=${scrollTop} height=${scrollHeight} client=${clientHeight} winY=${windowY}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once snapshot scroll restoration is stable.
  console.log(message);
}

function shouldAcceptSessionSnapshot(snapshot) {
  if (!snapshot) {
    return false;
  }
  const incomingThreadId = snapshot.active_thread_id || null;
  const currentThreadId = state.session?.active_thread_id || null;
  if (!incomingThreadId || incomingThreadId !== currentThreadId) {
    return true;
  }

  const incomingRevision = numericRevision(snapshot.transcript_revision);
  const currentRevision = numericRevision(state.session?.transcript_revision);
  return incomingRevision == null || currentRevision == null || incomingRevision >= currentRevision;
}

function applyTranscriptEntryPatch(event, { defaultStatus = null } = {}) {
  const currentSession = state.session;
  if (!currentSession) {
    return;
  }
  const currentThreadId = currentSession.active_thread_id || null;
  const eventThreadId = event.thread_id || event.active_thread_id || event.entry?.thread_id || null;
  if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
    return;
  }
  if (!shouldAcceptTranscriptRevision(event)) {
    return;
  }

  const incoming = event.entry || {
    item_id: event.item_id,
    entry_seq: event.entry_seq,
    kind: event.entry_kind || event.kind,
    status: event.status,
    text: event.text,
    tool: event.tool,
    turn_id: event.turn_id,
  };
  const itemId = incoming.item_id || event.item_id;
  if (!itemId || !Array.isArray(currentSession.transcript)) {
    return;
  }

  const entryPatch = {
    ...incoming,
    item_id: itemId,
    kind: incoming.kind || event.entry_kind
      ? normalizeTranscriptEventEntryKind(incoming.kind || event.entry_kind)
      : null,
    status: incoming.status || defaultStatus || "completed",
    turn_id: incoming.turn_id || event.turn_id || null,
  };
  const entryIndex = currentSession.transcript.findIndex((entry) => entry.item_id === itemId);
  const nextTranscript = entryIndex >= 0
    ? currentSession.transcript.map((entry, index) => {
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
        };
      })
    : [
        ...currentSession.transcript,
        {
          text: entryPatch.text ?? "",
          tool: entryPatch.tool ?? null,
          ...entryPatch,
          kind: entryPatch.kind || "agent_text",
        },
      ];

  const nextSession = {
    ...currentSession,
    transcript: nextTranscript,
  };
  const eventRevision = numericRevision(event.revision ?? event.transcript_revision);
  if (eventRevision != null) {
    nextSession.transcript_revision = eventRevision;
  }
  if (Number.isSafeInteger(event.server_time)) {
    nextSession.server_time = event.server_time;
  }
  renderSession(nextSession);
}

function applySessionMetadataPatch(patch) {
  if (!state.session || !patch) {
    return;
  }
  const {
    kind: _kind,
    type: _type,
    transcript: _transcript,
    transcript_truncated: _transcriptTruncated,
    ...metadata
  } = patch;
  renderSession({
    ...state.session,
    ...metadata,
    transcript: state.session.transcript,
    transcript_truncated: state.session.transcript_truncated,
  });
}

function shouldAcceptTranscriptRevision(event) {
  const currentRevision = numericRevision(state.session?.transcript_revision);
  const eventBaseRevision = numericRevision(event.base_revision);
  const eventRevision = numericRevision(event.revision ?? event.transcript_revision);
  if (eventRevision != null && currentRevision != null && eventRevision < currentRevision) {
    return false;
  }
  return !(eventBaseRevision != null && currentRevision != null && eventBaseRevision !== currentRevision);
}

function normalizeTranscriptEventEntryKind(kind) {
  if (
    kind === "user_text"
    || kind === "agent_text"
    || kind === "command"
    || kind === "tool_call"
    || kind === "reasoning"
  ) {
    return kind;
  }
  return transcriptDeltaKindToEntryKind(kind || "agent_text");
}

function upsertApproval(approvals, incoming) {
  const existingIndex = approvals.findIndex(
    (approval) => approval?.request_id === incoming.request_id
  );
  if (existingIndex === -1) {
    return [...approvals, incoming];
  }
  return approvals.map((approval, index) =>
    index === existingIndex ? { ...approval, ...incoming } : approval
  );
}

function numericRevision(value) {
  return Number.isSafeInteger(value) ? value : null;
}

export async function syncRemoteSnapshot(reason, silent = false) {
  if (!silent) {
    renderLog(`Syncing remote session (${reason}).`);
  }

  try {
    await dispatchRemoteActionWithoutReply("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat sync failed: ${error.message}`);
  }

  try {
    await refreshRemoteThreads(reason, { silent: true });
  } catch (error) {
    renderLog(`Remote thread sync failed: ${error.message}`);
  }
}

export async function startRemoteSession(sessionDraftOverride = null) {
  const sessionDraft = sessionDraftOverride;
  if (!sessionDraft) {
    throw new Error("startRemoteSession requires a session draft");
  }
  const cwd = sessionDraft.cwd.trim();
  if (!cwd) {
    renderLog("Choose a workspace before starting a remote session.");
    return false;
  }

  renderLog(`Starting remote session in ${cwd}.`);

  try {
    await dispatchOrRecover("start_session", {
      input: {
        cwd,
        initial_prompt: sessionDraft.initialPrompt.trim() || null,
        model: sessionDraft.model.trim() || null,
        approval_policy: sessionDraft.approvalPolicy,
        sandbox: sessionDraft.sandbox,
        effort: sessionDraft.effort,
        provider: sessionDraft.provider,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
    return false;
  }
}

export async function fetchRemoteProviders() {
  if (!state.remoteAuth) {
    return [];
  }
  const result = await dispatchOrRecover("list_providers", {});
  return result.providers || [];
}

export async function fetchRemoteProviderModels(provider) {
  if (!state.remoteAuth || !provider) {
    return [];
  }
  const result = await dispatchOrRecover("list_provider_models", {
    provider,
  });
  return result.models || [];
}

export async function refreshRemoteThreads(reason, options = {}) {
  const { silent = false } = options;

  if (!silent) {
    renderLog(`Fetching remote thread list (${reason}).`);
  }

  try {
    const threads = await remoteQueryClient.fetchQuery(
      createThreadListQueryOptions({
        fetchThreads: fetchRemoteThreads,
        limit: 80,
        scope: remoteQueryScope(),
        surface: "remote",
      })
    );
    applyRemoteSurfacePatch(createRemoteThreadsPatch(threads));
    return threads;
  } catch (error) {
    if (!silent) {
      renderLog(`Remote thread refresh failed: ${error.message}`);
    }
    throw error;
  }
}

export async function fetchRemoteThreads({ limit = 80 } = {}) {
  if (!state.remoteAuth) {
    return [];
  }

  const result = await dispatchOrRecover("list_threads", {
    query: { limit },
  });
  return result.threads?.threads || [];
}

export async function resumeRemoteSession(threadId, _sessionDraftOverride = null) {
  if (!threadId) {
    return;
  }

  renderLog(`Resuming remote thread ${threadId}.`);

  try {
    await dispatchOrRecover("resume_session", {
      input: {
        thread_id: threadId,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
    return false;
  }
}

export async function updateRemoteSessionSettings({ approval_policy, sandbox, effort, model } = {}) {
  if (!state.session?.active_thread_id) {
    return false;
  }
  const input = {};
  if (typeof approval_policy === "string" && approval_policy) {
    input.approval_policy = approval_policy;
  }
  if (typeof sandbox === "string" && sandbox) {
    input.sandbox = sandbox;
  }
  if (typeof effort === "string" && effort) {
    input.effort = effort;
  }
  if (typeof model === "string" && model) {
    input.model = model;
  }
  if (
    !("approval_policy" in input)
    && !("sandbox" in input)
    && !("effort" in input)
    && !("model" in input)
  ) {
    return false;
  }

  try {
    await dispatchOrRecover("update_session_settings", { input });
    const parts = [];
    if (input.approval_policy) parts.push(`approval=${input.approval_policy}`);
    if (input.sandbox) parts.push(`sandbox=${input.sandbox}`);
    if (input.effort) parts.push(`effort=${input.effort}`);
    if (input.model) parts.push(`model=${input.model}`);
    renderLog(`Updated remote session settings: ${parts.join(", ")}`);
    return true;
  } catch (error) {
    renderLog(`Remote settings update failed: ${error.message}`);
    return false;
  }
}

export async function viewRemoteThread(threadId) {
  if (!threadId) {
    return false;
  }

  renderLog(`Viewing remote thread ${threadId}.`);

  try {
    const page = await fetchTranscriptPage({
      before: null,
      threadId,
    });
    if (!page || page.thread_id !== threadId) {
      throw new Error("remote transcript page response is incomplete");
    }

    const thread = (state.threads || []).find((candidate) => candidate?.id === threadId);
    clearTranscriptHydration(state);
    applyRenderedSession(
      {
        ...(state.session || {}),
        active_controller_device_id: "__view_only__",
        active_controller_last_seen_at: null,
        active_flags: [],
        active_thread_id: threadId,
        active_turn_id: null,
        controller_lease_expires_at: null,
        current_cwd: thread?.cwd || state.session?.current_cwd || "",
        current_status: "viewing",
        pending_approvals: [],
        transcript: page.entries || [],
        transcript_truncated: page.prev_cursor != null,
        view_only: true,
      },
      {
        hydrateTranscript: true,
      }
    );
    return true;
  } catch (error) {
    renderLog(`Remote thread view failed: ${error.message}`);
    return false;
  }
}

export async function sendMessage(messageDraft, effort, model = "") {
  if (typeof messageDraft !== "string" || typeof effort !== "string") {
    throw new Error("sendMessage requires a draft and effort");
  }
  const text = messageDraft.trim();
  if (!text) {
    renderLog("Message is empty.");
    return false;
  }

  try {
    await dispatchOrRecover("send_message", {
      input: {
        text,
        model,
        effort,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
    return false;
  }
}

export async function stopActiveTurn() {
  if (!state.session?.active_thread_id || !state.session.active_turn_id) {
    renderLog("There is no running Codex turn to stop.");
    return false;
  }

  try {
    await dispatchOrRecover("stop_turn", {
      input: {},
    });
    renderLog("Remote stop request sent to Codex.");
    return true;
  } catch (error) {
    renderLog(`Remote stop failed: ${error.message}`);
    return false;
  }
}

export async function takeOverControl() {
  try {
    await dispatchOrRecover("take_over", {
      input: {},
    });
  } catch (error) {
    renderLog(`Take over failed: ${error.message}`);
  }
}

export async function submitDecision(decision, scope) {
  if (!state.currentApprovalId) {
    renderLog("No pending approval to submit.");
    return;
  }

  try {
    await dispatchOrRecover("decide_approval", {
      request_id: state.currentApprovalId,
      input: {
        decision,
        scope,
      },
    });
  } catch (error) {
    renderLog(`Approval failed: ${error.message}`);
  }
}

// Submit the user's answer to a pending AskUserQuestion via the broker
// remote_action channel. `answers` is the {questionText: label | label[] | freeText}
// map the SDK expects in updatedInput.answers.
export async function submitAskUserAnswer(requestId, answers) {
  if (!requestId) {
    renderLog("No pending AskUserQuestion to answer.");
    return;
  }
  try {
    await dispatchOrRecover("submit_ask_user_answer", {
      request_id: requestId,
      input: { answers },
    });
  } catch (error) {
    renderLog(`AskUserQuestion submit failed: ${error.message}`);
    throw error;
  }
}

export async function applyFileChange(itemId, direction) {
  if (!itemId) {
    renderLog("No file change selected.");
    return;
  }

  renderLog(`${direction === "rollback" ? "Rolling back" : "Reapplying"} file change ${itemId}`);

  try {
    await dispatchOrRecover("apply_file_change", {
      item_id: itemId,
      input: {
        direction,
      },
    });
  } catch (error) {
    renderLog(`File change action failed: ${error.message}`);
  }
}

export async function fetchRemoteWorkspaceDiff() {
  const result = await dispatchOrRecover("fetch_workspace_diff", {});
  return result.workspace_diff;
}

export function clearSessionRuntime() {
  clearTranscriptHydration(state);
}

async function sendHeartbeat() {
  if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
    return;
  }

  try {
    await dispatchRemoteActionWithoutReply("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat failed: ${error.message}`);
  }
}

async function hydrateActiveTranscript(snapshot) {
  return hydrateRemoteTranscript(state, snapshot, {
    fetchPage: fetchTranscriptPage,
    onProgress(hydratedSnapshot) {
      applyRenderedSession(hydratedSnapshot, {
        hydrateTranscript: false,
      });
    },
    onError(error) {
      renderLog(`Remote full transcript sync failed: ${error.message}`);
    },
  });
}

export async function maybeLoadOlderTranscriptHistory() {
  // The IntersectionObserver in react-app.js fires when the sentinel comes
  // within ~600px of the top edge, so we drop the manual scrollTop check
  // here — the observer's rootMargin is the prefetch trigger.
  const transcript = remoteUiRefs.remoteTranscript;
  if (!transcript) {
    return null;
  }

  return loadOlderRemoteTranscript(state, {
    fetchPage: fetchTranscriptPage,
    onProgress(hydratedSnapshot) {
      applyRenderedSession(hydratedSnapshot, {
        hydrateTranscript: false,
      });
    },
    onError(error) {
      renderLog(`Remote older transcript sync failed: ${error.message}`);
    },
  });
}

export async function fetchTranscriptEntryDetail(threadId, itemId) {
  return fetchTranscriptEntryDetailRequest({
    itemId,
    threadId,
  });
}

function applyRenderedSession(
  session,
  { hydrateTranscript = true, hydrationSnapshot = session } = {}
) {
  const previousThreadId = state.session?.active_thread_id || "-";
  renderSession(session);
  const message = `[session-state] renderSession prev=${previousThreadId} next=${session?.active_thread_id || "-"} state=${state.session?.active_thread_id || "-"} entries=${session?.transcript?.length || 0} hydrate=${hydrateTranscript ? "1" : "0"} hydration_input=${hydrationSnapshot?.active_thread_id || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once session rendering is stable.
  console.log(message);
  scheduleClaimRefresh();
  if (hydrateTranscript) {
    void hydrateActiveTranscript(hydrationSnapshot);
  }
}

export { sendHeartbeat };
