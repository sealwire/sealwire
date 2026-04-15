import * as dom from "./dom.js";
import { dispatchOrRecover, scheduleClaimRefresh } from "./actions.js";
import { closeRemoteNavigation } from "./navigation.js";
import {
  isCurrentDeviceActiveController,
  renderLog,
  renderSession,
  renderThreads,
  setRemoteSessionPanelOpen,
} from "./render.js";
import {
  CONTROL_HEARTBEAT_MS,
  LEASE_EXPIRY_REFRESH_SKEW_MS,
  state,
} from "./state.js";
import { escapeHtml } from "./utils.js";

export function applySessionSnapshot(snapshot) {
  const effectiveSnapshot = restoreHydratedTranscript(snapshot);
  renderSession(effectiveSnapshot);
  scheduleControllerHeartbeat(effectiveSnapshot);
  scheduleControllerLeaseRefresh(effectiveSnapshot);
  scheduleClaimRefresh();
  void hydrateActiveTranscript(effectiveSnapshot);
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
  const cwd = dom.remoteCwdInput.value.trim();
  if (!cwd) {
    renderLog("Choose a workspace before starting a remote session.");
    dom.remoteCwdInput.focus();
    return;
  }

  dom.remoteStartSessionButton.disabled = true;
  renderLog(`Starting remote session in ${cwd}.`);

  try {
    await dispatchOrRecover("start_session", {
      input: {
        cwd,
        initial_prompt: dom.remoteStartPromptInput.value.trim() || null,
        model: dom.remoteModelInput.value.trim() || null,
        approval_policy: dom.remoteApprovalPolicyInput.value,
        sandbox: dom.remoteSandboxInput.value,
        effort: dom.remoteStartEffortInput.value,
      },
    });
    closeRemoteNavigation();
    setRemoteSessionPanelOpen(false);
    await refreshRemoteThreads("post-start refresh", { silent: true });
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
  } finally {
    dom.remoteStartSessionButton.disabled = false;
  }
}

export async function refreshRemoteThreads(reason, options = {}) {
  const { silent = false } = options;
  if (!state.remoteAuth) {
    renderThreads([]);
    return;
  }

  dom.remoteThreadsRefreshButton.disabled = true;
  dom.remoteThreadsCount.textContent = "Loading...";
  if (!silent) {
    renderLog(`Fetching remote thread list (${reason}).`);
  }

  try {
    await dispatchOrRecover("list_threads", {
      query: {
        cwd: dom.remoteThreadsCwdInput.value.trim() || null,
        limit: 80,
      },
    });
  } catch (error) {
    dom.remoteThreadsCount.textContent = "Error";
    dom.remoteThreadsList.innerHTML = `<p class="sidebar-empty">${escapeHtml(error.message)}</p>`;
    if (!silent) {
      renderLog(`Remote thread refresh failed: ${error.message}`);
    }
    throw error;
  } finally {
    dom.remoteThreadsRefreshButton.disabled = false;
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
        approval_policy: dom.remoteApprovalPolicyInput.value,
        sandbox: dom.remoteSandboxInput.value,
        effort: dom.remoteStartEffortInput.value,
      },
    });
    await refreshRemoteThreads("post-resume refresh", { silent: true });
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
  }
}

export async function sendMessage() {
  const text = dom.remoteMessageInput.value.trim();
  if (!text) {
    renderLog("Message is empty.");
    return;
  }

  dom.remoteSendButton.disabled = true;

  try {
    await dispatchOrRecover("send_message", {
      input: {
        text,
        effort: dom.remoteMessageEffort.value,
      },
    });
    dom.remoteMessageInput.value = "";
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
  } finally {
    dom.remoteSendButton.disabled = false;
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
  state.transcriptHydrationPromise = null;
  state.transcriptHydrationSignature = null;
  state.transcriptHydrationResolvedSignature = null;
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
  if (!snapshot?.active_thread_id || !snapshot.transcript_truncated) {
    return;
  }

  const signature = transcriptHydrationSignature(snapshot);
  if (state.transcriptHydrationResolvedSignature === signature) {
    return;
  }
  if (
    state.transcriptHydrationPromise &&
    state.transcriptHydrationSignature === signature
  ) {
    return state.transcriptHydrationPromise;
  }

  state.transcriptHydrationSignature = signature;
  state.transcriptHydrationPromise = (async () => {
    try {
      const transcript = await fetchFullRemoteTranscript(snapshot.active_thread_id);
      if (state.session?.active_thread_id !== snapshot.active_thread_id) {
        return;
      }
      state.transcriptHydrationResolvedSignature = signature;
      applySessionSnapshot({
        ...state.session,
        transcript,
        transcript_truncated: false,
      });
    } catch (error) {
      renderLog(`Remote full transcript sync failed: ${error.message}`);
    } finally {
      if (state.transcriptHydrationSignature === signature) {
        state.transcriptHydrationPromise = null;
      }
    }
  })();

  return state.transcriptHydrationPromise;
}

export async function fetchFullRemoteTranscript(threadId) {
  const assembledEntries = new Map();
  let cursor = 0;

  while (true) {
    const result = await dispatchOrRecover("fetch_thread_transcript", {
      input: {
        thread_id: threadId,
        cursor,
      },
    });
    const page = result.thread_transcript;
    if (!page || page.thread_id !== threadId) {
      throw new Error("remote transcript response is incomplete");
    }

    for (const chunk of page.chunks || []) {
      if (!assembledEntries.has(chunk.entry_index)) {
        assembledEntries.set(chunk.entry_index, {
          item_id: chunk.item_id,
          role: chunk.role,
          status: chunk.status,
          turn_id: chunk.turn_id || null,
          parts: new Array(chunk.chunk_count).fill(""),
        });
      }

      const entry = assembledEntries.get(chunk.entry_index);
      entry.item_id = chunk.item_id;
      entry.role = chunk.role;
      entry.status = chunk.status;
      entry.turn_id = chunk.turn_id || null;
      if (chunk.chunk_index >= entry.parts.length) {
        entry.parts.length = chunk.chunk_count;
      }
      entry.parts[chunk.chunk_index] = chunk.text || "";
    }

    if (page.next_cursor == null) {
      break;
    }
    cursor = page.next_cursor;
  }

  return [...assembledEntries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => ({
      item_id: entry.item_id,
      role: entry.role,
      text: entry.parts.join(""),
      status: entry.status,
      turn_id: entry.turn_id,
    }));
}

function transcriptHydrationSignature(snapshot) {
  const parts = [
    snapshot.active_thread_id || "",
    snapshot.active_turn_id || "",
    String(snapshot.transcript?.length || 0),
  ];

  for (const entry of snapshot.transcript || []) {
    parts.push(
      entry.item_id || "",
      entry.role || "",
      entry.status || "",
      String((entry.text || "").length)
    );
  }

  return parts.join("|");
}

function restoreHydratedTranscript(snapshot) {
  if (!snapshot?.active_thread_id || !snapshot.transcript_truncated) {
    return snapshot;
  }

  const signature = transcriptHydrationSignature(snapshot);
  if (state.transcriptHydrationResolvedSignature !== signature) {
    return snapshot;
  }
  if (
    state.session?.active_thread_id !== snapshot.active_thread_id ||
    state.session?.transcript_truncated !== false ||
    !Array.isArray(state.session?.transcript)
  ) {
    return snapshot;
  }

  return {
    ...snapshot,
    transcript: state.session.transcript,
    transcript_truncated: false,
  };
}
