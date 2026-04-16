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
  TRANSCRIPT_PAGE_FETCH_INTERVAL_MS,
  state,
} from "./state.js";
import { escapeHtml } from "./utils.js";

export function applySessionSnapshot(snapshot) {
  const effectiveSnapshot = restoreHydratedTranscript(snapshot);
  applyRenderedSession(effectiveSnapshot);
  const scrollTop = dom.remoteTranscript?.scrollTop || 0;
  const scrollHeight = dom.remoteTranscript?.scrollHeight || 0;
  const clientHeight = dom.remoteTranscript?.clientHeight || 0;
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
  state.transcriptHydrationThreadId = null;
  state.transcriptHydrationBaseSnapshot = null;
  state.transcriptHydrationOlderCursor = null;
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationStatus = "idle";
  state.transcriptHydrationLastFetchAt = 0;
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
  if (
    state.transcriptHydrationThreadId !== snapshot.active_thread_id
    || state.transcriptHydrationSignature !== signature
  ) {
    resetTranscriptHydration(snapshot, signature);
  } else {
    state.transcriptHydrationBaseSnapshot = snapshot;
  }

  if (state.transcriptHydrationStatus === "complete") {
    return;
  }
  if (state.transcriptHydrationPromise) {
    return state.transcriptHydrationPromise;
  }

  state.transcriptHydrationStatus = "loading";
  applyTranscriptHydrationProgress();
  state.transcriptHydrationPromise = (async () => {
    try {
      await hydrateRemoteTranscriptPages(snapshot.active_thread_id, signature);
    } catch (error) {
      state.transcriptHydrationStatus = "idle";
      renderLog(`Remote full transcript sync failed: ${error.message}`);
    } finally {
      if (state.transcriptHydrationSignature === signature) {
        state.transcriptHydrationPromise = null;
      }
    }
  })();

  return state.transcriptHydrationPromise;
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
      entry.kind || "",
      entry.status || "",
      entry.turn_id || "",
      entry.tool?.item_type || "",
      entry.tool?.name || "",
      entry.tool?.path || "",
      entry.tool?.url || "",
      entry.tool?.command || ""
    );
  }

  return parts.join("|");
}

function restoreHydratedTranscript(snapshot) {
  if (!snapshot?.active_thread_id || !snapshot.transcript_truncated) {
    return snapshot;
  }

  const signature = transcriptHydrationSignature(snapshot);
  if (
    state.transcriptHydrationThreadId !== snapshot.active_thread_id
    || state.transcriptHydrationSignature !== signature
    || !state.transcriptHydrationEntries.size
  ) {
    return snapshot;
  }

  return buildHydratedTranscriptSnapshot(snapshot);
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

function resetTranscriptHydration(snapshot, signature) {
  state.transcriptHydrationSignature = signature;
  state.transcriptHydrationThreadId = snapshot.active_thread_id;
  state.transcriptHydrationBaseSnapshot = snapshot;
  state.transcriptHydrationOlderCursor = null;
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationStatus = "idle";
  state.transcriptHydrationLastFetchAt = 0;
}

async function hydrateRemoteTranscriptPages(threadId, signature) {
  while (state.transcriptHydrationThreadId === threadId) {
    if (state.transcriptHydrationStatus === "complete") {
      state.transcriptHydrationStatus = "complete";
      applyTranscriptHydrationProgress();
      return;
    }

    await waitForTranscriptFetchWindow();

    const result = await dispatchOrRecover("fetch_thread_transcript", {
      input: {
        thread_id: threadId,
        before: state.transcriptHydrationOlderCursor,
      },
    });
    state.transcriptHydrationLastFetchAt = Date.now();

    const page = result.thread_transcript;
    if (!page || page.thread_id !== threadId) {
      throw new Error("remote transcript response is incomplete");
    }

    mergeTranscriptHydrationPage(page);
    state.transcriptHydrationOlderCursor = page.prev_cursor ?? null;
    state.transcriptHydrationStatus =
      page.prev_cursor == null ? "complete" : "loading";
    applyTranscriptHydrationProgress();

    if (state.transcriptHydrationSignature !== signature) {
      return;
    }
  }
}

function mergeTranscriptHydrationPage(page) {
  for (const entryPage of page.entries || []) {
    if (!state.transcriptHydrationEntries.has(entryPage.entry_index)) {
      state.transcriptHydrationEntries.set(entryPage.entry_index, {
        item_id: entryPage.item_id,
        kind: entryPage.kind,
        status: entryPage.status,
        turn_id: entryPage.turn_id || null,
        tool: entryPage.tool || null,
        parts: new Array(entryPage.part_count),
      });
    }

    const entry = state.transcriptHydrationEntries.get(entryPage.entry_index);
    entry.item_id = entryPage.item_id;
    entry.kind = entryPage.kind;
    entry.status = entryPage.status;
    entry.turn_id = entryPage.turn_id || null;
    entry.tool = entryPage.tool || null;
    if (entryPage.part_count > entry.parts.length) {
      entry.parts.length = entryPage.part_count;
    }

    for (const part of entryPage.parts || []) {
      if (part.part_index >= entry.parts.length) {
        entry.parts.length = entryPage.part_count;
      }
      entry.parts[part.part_index] = part.text || "";
    }
  }
}

function applyTranscriptHydrationProgress() {
  const snapshot = state.transcriptHydrationBaseSnapshot;
  if (!snapshot || state.session?.active_thread_id !== snapshot.active_thread_id) {
    return;
  }

  applyRenderedSession(buildHydratedTranscriptSnapshot(snapshot), {
    hydrateTranscript: false,
  });
}

function buildHydratedTranscriptSnapshot(snapshot) {
  const loadedEntries = buildHydratedTranscriptEntries();
  const resolvedTailEntries = new Map(
    loadedEntries
      .filter((entry) => entry.complete && entry.item_id)
      .map((entry) => [entry.item_id, entry])
  );
  const tailEntries = (snapshot.transcript || []).map((entry) => {
    const resolved = entry.item_id ? resolvedTailEntries.get(entry.item_id) : null;
    if (!resolved) {
      return entry;
    }

    const { complete, ...nextEntry } = resolved;
    return nextEntry;
  });
  const tailItemIds = new Set((snapshot.transcript || []).map((entry) => entry.item_id).filter(Boolean));
  const olderLoadedEntries = loadedEntries
    .filter((entry) => !tailItemIds.has(entry.item_id))
    .map(({ complete, ...entry }) => entry);

  return {
    ...snapshot,
    transcript: [...olderLoadedEntries, ...tailEntries],
    transcript_truncated: state.transcriptHydrationStatus !== "complete",
  };
}

function buildHydratedTranscriptEntries() {
  return [...state.transcriptHydrationEntries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => {
      let complete = true;
      let text = "";
      for (const part of entry.parts) {
        if (typeof part !== "string") {
          complete = false;
          continue;
        }
        text += part;
      }

      return {
        item_id: entry.item_id,
        kind: entry.kind,
        text: text || null,
        status: entry.status,
        turn_id: entry.turn_id,
        tool: entry.tool,
        complete,
      };
    });
}

async function waitForTranscriptFetchWindow() {
  const elapsedMs = Date.now() - state.transcriptHydrationLastFetchAt;
  const delayMs = Math.max(0, TRANSCRIPT_PAGE_FETCH_INTERVAL_MS - elapsedMs);
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}
