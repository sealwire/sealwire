import { dispatchOrRecover, scheduleClaimRefresh } from "./actions.js";
import {
  isCurrentDeviceActiveController,
  renderLog,
  renderSession,
} from "./render.js";
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
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./transcript/details.js";
import { remoteUiRefs } from "./ui-refs.js";
import {
  applyRemoteSurfacePatch,
  createRemoteThreadsPatch,
  createTranscriptScrollModePatch,
} from "./surface-state.js";

const fetchTranscriptPage = createTranscriptPageFetcher(dispatchOrRecover);
const fetchTranscriptEntryDetailRequest =
  createTranscriptEntryDetailFetcher(dispatchOrRecover);

function transcriptDeltaKindToEntryKind(deltaKind) {
  switch (deltaKind) {
    case "command_output":
      return "command";
    case "agent_text":
    default:
      return "agent_text";
  }
}

export function applyTranscriptDelta({ thread_id, item_id, turn_id, delta, delta_kind, kind }) {
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

  const transcript = state.session.transcript;
  if (!Array.isArray(transcript)) return;
  const resolvedKind = transcriptDeltaKindToEntryKind(delta_kind || kind);

  const entry = transcript.find((e) => e.item_id === item_id);
  if (entry) {
    entry.text = `${entry.text ?? ""}${delta ?? ""}`;
    entry.status = "running";
    if (!entry.kind) {
      entry.kind = resolvedKind;
    }
    if (!entry.turn_id && turn_id) {
      entry.turn_id = turn_id;
    }
  } else {
    transcript.push({
      item_id,
      turn_id: turn_id ?? null,
      text: delta ?? "",
      kind: resolvedKind,
      status: "running",
      tool: null,
    });
  }

  renderSession(state.session);
}

export function applySessionSnapshot(snapshot) {
  if (typeof window !== "undefined" && typeof window.__snapshotCount === "number") {
    window.__snapshotCount++;
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

export async function syncRemoteSnapshot(reason, silent = false) {
  if (!silent) {
    renderLog(`Syncing remote session (${reason}).`);
  }

  try {
    await dispatchOrRecover("heartbeat", {
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
    remoteUiRefs.remoteCwdInput?.focus();
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
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
    return false;
  }
}

export async function refreshRemoteThreads(reason, options = {}) {
  const { filterValue = "", silent = false } = options;
  if (!state.remoteAuth) {
    applyRemoteSurfacePatch(createRemoteThreadsPatch([]));
    return;
  }

  if (!silent) {
    renderLog(`Fetching remote thread list (${reason}).`);
  }

  try {
    await dispatchOrRecover("list_threads", {
      query: {
        cwd: filterValue.trim() || null,
        limit: 80,
      },
    });
  } catch (error) {
    if (!silent) {
      renderLog(`Remote thread refresh failed: ${error.message}`);
    }
    throw error;
  }
}

export async function resumeRemoteSession(threadId, sessionDraftOverride = null) {
  if (!threadId) {
    return;
  }
  const sessionDraft = sessionDraftOverride;
  if (!sessionDraft) {
    throw new Error("resumeRemoteSession requires a session draft");
  }

  renderLog(`Resuming remote thread ${threadId}.`);

  try {
    await dispatchOrRecover("resume_session", {
      input: {
        thread_id: threadId,
        approval_policy: sessionDraft.approvalPolicy,
        sandbox: sessionDraft.sandbox,
        effort: sessionDraft.effort,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
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

export async function sendMessage(messageDraft, effort) {
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
        effort,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
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

export function clearSessionRuntime() {
  clearTranscriptHydration(state);
  applyRemoteSurfacePatch(createTranscriptScrollModePatch("follow-latest"));
}

async function sendHeartbeat() {
  if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
    return;
  }

  try {
    await dispatchOrRecover("heartbeat", {
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
  const transcript = remoteUiRefs.remoteTranscript;
  if (!transcript || transcript.scrollTop > 80) {
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
