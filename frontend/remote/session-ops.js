import { dispatchOrRecover, scheduleClaimRefresh } from "./actions.js";
import { closeRemoteNavigation } from "./navigation.js";
import {
  isCurrentDeviceActiveController,
  renderLog,
  renderSession,
} from "./render.js";
import {
  CONTROL_HEARTBEAT_MS,
  LEASE_EXPIRY_REFRESH_SKEW_MS,
  TRANSCRIPT_PAGE_FETCH_INTERVAL_MS,
  patchRemoteState,
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
  createTranscriptScrollModePatch,
} from "./surface-state.js";
import {
  setSessionPanelOpen,
  setThreads,
} from "./store-actions.js";

const fetchTranscriptPage = createTranscriptPageFetcher(dispatchOrRecover);

export function applySessionSnapshot(snapshot) {
  const effectiveSnapshot = restoreHydratedTranscript(state, snapshot);
  applyRenderedSession(effectiveSnapshot);
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

export async function startRemoteSession() {
  const cwd = state.sessionDraft.cwd.trim();
  if (!cwd) {
    renderLog("Choose a workspace before starting a remote session.");
    remoteUiRefs.remoteCwdInput?.focus();
    return;
  }

  patchRemoteState({
    sessionStartPending: true,
  });
  renderLog(`Starting remote session in ${cwd}.`);

  try {
    await dispatchOrRecover("start_session", {
      input: {
        cwd,
        initial_prompt: state.sessionDraft.initialPrompt.trim() || null,
        model: state.sessionDraft.model.trim() || null,
        approval_policy: state.sessionDraft.approvalPolicy,
        sandbox: state.sessionDraft.sandbox,
        effort: state.sessionDraft.effort,
      },
    });
    closeRemoteNavigation();
    setSessionPanelOpen(false);
    await refreshRemoteThreads("post-start refresh", { silent: true });
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
  } finally {
    patchRemoteState({
      sessionStartPending: false,
    });
  }
}

export async function refreshRemoteThreads(reason, options = {}) {
  const { silent = false } = options;
  if (!state.remoteAuth) {
    setThreads([]);
    return;
  }

  patchRemoteState({
    threadsError: null,
    threadsRefreshPending: true,
  });
  if (!silent) {
    renderLog(`Fetching remote thread list (${reason}).`);
  }

  try {
    await dispatchOrRecover("list_threads", {
      query: {
        cwd: state.threadsFilterValue.trim() || null,
        limit: 80,
      },
    });
  } catch (error) {
    patchRemoteState({
      threads: [],
      threadsError: error.message,
    });
    setThreads([]);
    if (!silent) {
      renderLog(`Remote thread refresh failed: ${error.message}`);
    }
    throw error;
  } finally {
    patchRemoteState({
      threadsRefreshPending: false,
    });
  }
}

export async function resumeRemoteSession(threadId) {
  if (!threadId) {
    return;
  }

  renderLog(`Resuming remote thread ${threadId}.`);

  try {
    await dispatchOrRecover("resume_session", {
      input: {
        thread_id: threadId,
        approval_policy: state.sessionDraft.approvalPolicy,
        sandbox: state.sessionDraft.sandbox,
        effort: state.sessionDraft.effort,
      },
    });
    await refreshRemoteThreads("post-resume refresh", { silent: true });
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
  }
}

export async function sendMessage() {
  const text = state.composerDraft.trim();
  if (!text) {
    renderLog("Message is empty.");
    return;
  }

  patchRemoteState({
    sendPending: true,
  });

  try {
    await dispatchOrRecover("send_message", {
      input: {
        text,
        effort: state.composerEffort,
      },
    });
    patchRemoteState({
      composerDraft: "",
    });
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
  } finally {
    patchRemoteState({
      sendPending: false,
    });
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
  cancelControllerHeartbeat();
  cancelControllerLeaseRefresh();
  clearTranscriptHydration(state);
  applyRemoteSurfacePatch(createTranscriptScrollModePatch("follow-latest"));
}

function scheduleControllerHeartbeat(session) {
  cancelControllerHeartbeat();

  if (!session?.active_thread_id || !isCurrentDeviceActiveController(session)) {
    return;
  }

  state.controllerHeartbeatTimer = window.setTimeout(() => {
    void sendHeartbeat();
  }, CONTROL_HEARTBEAT_MS);
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
  } finally {
    if (state.session?.active_thread_id && isCurrentDeviceActiveController(state.session)) {
      scheduleControllerHeartbeat(state.session);
    }
  }
}

function cancelControllerHeartbeat() {
  if (!state.controllerHeartbeatTimer) {
    return;
  }

  window.clearTimeout(state.controllerHeartbeatTimer);
  state.controllerHeartbeatTimer = null;
}

function scheduleControllerLeaseRefresh(session) {
  cancelControllerLeaseRefresh();

  if (
    !session?.active_thread_id ||
    !session.active_controller_device_id ||
    isCurrentDeviceActiveController(session) ||
    !session.controller_lease_expires_at
  ) {
    return;
  }

  const delayMs = Math.max(
    LEASE_EXPIRY_REFRESH_SKEW_MS,
    session.controller_lease_expires_at * 1000 - Date.now() + LEASE_EXPIRY_REFRESH_SKEW_MS
  );

  state.controllerLeaseRefreshTimer = window.setTimeout(() => {
    const next = {
      ...state.session,
      active_controller_device_id: null,
      active_controller_last_seen_at: null,
      controller_lease_expires_at: null,
    };
    applySessionSnapshot(next);
    renderLog("Remote control lease expired locally. The next sender can reclaim control.");
  }, delayMs);
}

function cancelControllerLeaseRefresh() {
  if (!state.controllerLeaseRefreshTimer) {
    return;
  }

  window.clearTimeout(state.controllerLeaseRefreshTimer);
  state.controllerLeaseRefreshTimer = null;
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

function applyRenderedSession(session, { hydrateTranscript = true } = {}) {
  renderSession(session);
  scheduleControllerHeartbeat(session);
  scheduleControllerLeaseRefresh(session);
  scheduleClaimRefresh();
  if (hydrateTranscript) {
    void hydrateActiveTranscript(session);
  }
}
