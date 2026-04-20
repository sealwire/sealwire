import { dispatchOrRecover, scheduleClaimRefresh } from "./actions.js";
import {
  isCurrentDeviceActiveController,
  renderLog,
  renderSession,
} from "./render.js";
import {
  TRANSCRIPT_PAGE_FETCH_INTERVAL_MS,
  state,
} from "./state.js";
import {
  clearTranscriptHydration,
  restoreHydratedTranscript,
} from "./transcript/store.js";
import { hydrateRemoteTranscript } from "./transcript/hydration.js";
import { createTranscriptPageFetcher } from "./transcript/api.js";
import { remoteUiRefs } from "./ui-refs.js";
import {
  applyRemoteSurfacePatch,
  createRemoteThreadsPatch,
  createTranscriptScrollModePatch,
} from "./surface-state.js";

const fetchTranscriptPage = createTranscriptPageFetcher(dispatchOrRecover);

export function applySessionSnapshot(snapshot) {
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
  const message = `[scroll] applySessionSnapshot thread=${snapshot?.active_thread_id || "-"} in_truncated=${snapshot?.transcript_truncated ? "1" : "0"} out_truncated=${effectiveSnapshot?.transcript_truncated ? "1" : "0"} restored=${restored} hydration=${state.transcriptHydrationStatus} older_cursor=${state.transcriptHydrationOlderCursor ?? "-"} entries=${effectiveSnapshot?.transcript?.length || 0} top=${scrollTop} height=${scrollHeight} client=${clientHeight} winY=${windowY}`;
  renderLog(message);
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
    fetchIntervalMs: TRANSCRIPT_PAGE_FETCH_INTERVAL_MS,
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

function applyRenderedSession(
  session,
  { hydrateTranscript = true, hydrationSnapshot = session } = {}
) {
  renderSession(session);
  scheduleClaimRefresh();
  if (hydrateTranscript) {
    void hydrateActiveTranscript(hydrationSnapshot);
  }
}

export { sendHeartbeat };
