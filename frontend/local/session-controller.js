import {
  allowedRootsInput,
  approvalPolicyInput,
  cwdInput,
  loadDirectoryButton,
  messageEffort,
  messageInput,
  modelInput,
  openLaunchSettingsButton,
  pairingLinkInput,
  resumeLatestButton,
  saveAllowedRootsButton,
  sandboxInput,
  sendButton,
  startEffortInput,
  startPairingButton,
  startPromptInput,
  startSessionButton,
  takeOverButton,
  transcript,
  threadsList,
} from "./dom.js";
import { renderAllowedRoots, renderPairingPanel } from "./render-security.js";
import { openSessionStream, sessionStreamUrl } from "../session-stream.js";
import { buildThreadGroups, findLatestThread } from "../shared/thread-groups.js";
import {
  fetchTranscriptEntryDetailViaRequester,
} from "../shared/transcript-entry-detail.js";
import { normalizeThreadTranscriptPage } from "../shared/transcript-page.js";
import {
  cacheTranscriptEntryDetail,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  setLiveTranscriptEntryDetail,
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./transcript/details.js";
import {
  hydrateLocalTranscript,
  loadOlderLocalTranscript,
} from "./transcript/hydration.js";
import {
  clearTranscriptHydration,
  restoreHydratedTranscript,
} from "./transcript/store.js";
import {
  createThreadListQueryOptions,
  createThreadTranscriptPageQueryOptions,
} from "../shared/thread-queries.js";

const CONTROL_HEARTBEAT_MS = 5000;
const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;

export function createSessionController({
  state,
  apiFetch,
  queryClient = null,
  shortId,
  logLine,
  seedDefaults,
  setSelectedCwd,
  setThreadRoute,
  canCurrentDeviceWrite,
  renderSession,
  renderOverviewState,
  renderSessionUnavailable,
  renderThreadListMessage,
  renderThreads,
  renderAuthRequiredState,
  runViewTransition,
  handleUnauthorized,
}) {
  function setStartControlsBusy(busy) {
    [
      loadDirectoryButton,
      startSessionButton,
      resumeLatestButton,
      openLaunchSettingsButton,
      cwdInput,
      startPromptInput,
      modelInput,
      approvalPolicyInput,
      sandboxInput,
      startEffortInput,
    ].forEach((element) => {
      element.disabled = busy;
    });
  }

  function scheduleSessionPoll() {
    if (state.streamConnected || (state.authRequired && !state.authenticated)) {
      return;
    }

    if (state.sessionPollTimer) {
      window.clearTimeout(state.sessionPollTimer);
    }

    state.sessionPollTimer = window.setTimeout(() => {
      void loadSession("poll");
    }, nextSessionPollDelay());
  }

  function scheduleThreadsPoll() {
    if (state.authRequired && !state.authenticated) {
      cancelThreadsPoll();
      return;
    }

    if (state.threadsPollTimer) {
      window.clearTimeout(state.threadsPollTimer);
    }

    state.threadsPollTimer = window.setTimeout(() => {
      void loadThreads("poll");
    }, 12000);
  }

  function cancelThreadsPoll() {
    if (!state.threadsPollTimer) {
      return;
    }

    window.clearTimeout(state.threadsPollTimer);
    state.threadsPollTimer = null;
  }

  function scheduleControllerHeartbeat(session) {
    cancelControllerHeartbeat();

    if (!session?.active_thread_id || !isCurrentDeviceActiveController(session)) {
      return;
    }

    state.controllerHeartbeatTimer = window.setTimeout(() => {
      void sendSessionHeartbeat();
    }, CONTROL_HEARTBEAT_MS);
  }

  async function sendSessionHeartbeat() {
    if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
      return;
    }

    try {
      const response = await apiFetch("/api/session/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to refresh control lease");
      }
    } catch (error) {
      logLine(`Control heartbeat failed: ${error.message}`);
    } finally {
      if (state.session?.active_thread_id && isCurrentDeviceActiveController(state.session)) {
        scheduleControllerHeartbeat(state.session);
      }
    }
  }

  async function saveAllowedRoots() {
    const allowed_roots = (allowedRootsInput?.value || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (saveAllowedRootsButton) {
      saveAllowedRootsButton.disabled = true;
    }
    if (allowedRootsInput) {
      allowedRootsInput.disabled = true;
    }

    logLine(
      allowed_roots.length
        ? `Saving ${allowed_roots.length} allowed workspace root${allowed_roots.length === 1 ? "" : "s"}.`
        : "Clearing relay workspace restrictions."
    );

    try {
      const response = await apiFetch("/api/allowed-roots", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          allowed_roots,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to save allowed roots");
      }

      state.allowedRootsDraftDirty = false;
      renderAllowedRoots(payload.data.allowed_roots || [], {
        draftDirty: state.allowedRootsDraftDirty,
      });
      await loadSession("post-allowed-roots refresh");
      await loadThreads("post-allowed-roots refresh");
      logLine(payload.data?.message || "Relay workspace restrictions saved.");
    } catch (error) {
      logLine(`Allowed roots update failed: ${error.message}`);
    } finally {
      if (saveAllowedRootsButton) {
        saveAllowedRootsButton.disabled = false;
      }
      if (allowedRootsInput) {
        allowedRootsInput.disabled = false;
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
      void loadSession("controller lease expiry");
    }, delayMs);
  }

  function cancelControllerLeaseRefresh() {
    if (!state.controllerLeaseRefreshTimer) {
      return;
    }

    window.clearTimeout(state.controllerLeaseRefreshTimer);
    state.controllerLeaseRefreshTimer = null;
  }

  function isViewingConversation(session) {
    return Boolean(session?.active_thread_id && state.viewThreadId === session.active_thread_id);
  }

  function resetTranscriptHydrationState() {
    clearTranscriptHydration(state);
    state.transcriptPreserveScroll = false;
  }

  function applySessionSnapshot(snapshot) {
    const previousThreadId = state.session?.active_thread_id || null;
    if (snapshot?.active_thread_id !== state.transcriptHydrationThreadId) {
      resetTranscriptHydrationState();
    }
    if (snapshot?.active_thread_id !== previousThreadId) {
      state.transcriptLoadingItemIds = new Set();
    }

    syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot);
    const merged = restoreHydratedTranscript(state, snapshot);
    renderSession(merged);
  }

  async function requestTranscriptEntryDetail(threadId, itemId, { field = null, cursor = null } = {}) {
    const url = new URL(
      `/api/threads/${encodeURIComponent(threadId)}/entries/${encodeURIComponent(itemId)}/detail`,
      window.location.origin
    );
    if (field) {
      url.searchParams.set("field", field);
    }
    if (typeof cursor === "number") {
      url.searchParams.set("cursor", String(cursor));
    }

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load transcript entry detail");
    }

    return payload.data;
  }

  async function fetchTranscriptEntryDetail(threadId, itemId) {
    return fetchTranscriptEntryDetailViaRequester({
      itemId,
      requestDetail: ({ cursor, field, itemId: requestItemId, threadId: requestThreadId }) =>
        requestTranscriptEntryDetail(requestThreadId, requestItemId, { cursor, field }),
      threadId,
    });
  }

  async function fetchTranscriptPage(threadId, { before = null } = {}) {
    const fetchPage = async () => {
      const url = new URL(
        `/api/threads/${encodeURIComponent(threadId)}/transcript`,
        window.location.origin
      );
      if (before != null) {
        url.searchParams.set("before", String(before));
      }

      const response = await apiFetch(url);
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to load transcript history");
      }

      return normalizeThreadTranscriptPage(payload.data);
    };

    if (!queryClient) {
      return fetchPage();
    }

    return queryClient.fetchQuery(
      createThreadTranscriptPageQueryOptions({
        before,
        fetchPage,
        scope: "local",
        surface: "local",
        threadId,
      })
    );
  }

  async function fetchThreadList({ limit = 120 } = {}) {
    const url = new URL(
      "/api/threads",
      window.location.origin
    );
    url.searchParams.set("limit", String(limit));

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load threads");
    }

    return payload.data?.threads || [];
  }

  async function ensureConversationTranscript(session = state.session) {
    if (!session?.active_thread_id || !isViewingConversation(session)) {
      return;
    }

    return hydrateLocalTranscript(state, session, {
      fetchPage: ({ threadId, before }) => fetchTranscriptPage(threadId, { before }),
      onProgress(hydratedSnapshot) {
        renderSession(hydratedSnapshot);
      },
      onError(error) {
        if (state.session) {
          renderSession(restoreHydratedTranscript(state, state.session));
        }
        logLine(`Transcript sync failed: ${error.message}`);
      },
    });
  }

  async function maybeLoadOlderTranscript() {
    if (
      !transcript ||
      transcript.scrollTop > 80 ||
      !state.session?.active_thread_id ||
      !isViewingConversation(state.session) ||
      state.transcriptHydrationOlderCursor == null
    ) {
      return;
    }

    const previousScrollHeight = transcript.scrollHeight;
    const previousScrollTop = transcript.scrollTop;
    state.transcriptPreserveScroll = true;

    return loadOlderLocalTranscript(state, {
      fetchPage: ({ threadId, before }) => fetchTranscriptPage(threadId, { before }),
      onProgress(hydratedSnapshot) {
        renderSession(hydratedSnapshot);
        window.requestAnimationFrame(() => {
          const nextScrollHeight = transcript.scrollHeight;
          transcript.scrollTop = Math.max(
            0,
            nextScrollHeight - previousScrollHeight + previousScrollTop
          );
          state.transcriptPreserveScroll = false;
          renderSession(hydratedSnapshot);
        });
      },
      onError(error) {
        state.transcriptPreserveScroll = false;
        if (state.session) {
          renderSession(restoreHydratedTranscript(state, state.session));
        }
        logLine(`Older transcript load failed: ${error.message}`);
      },
    });
  }

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
          applySessionSnapshot(snapshot);
        } catch (error) {
          logLine(`Stream payload failed: ${error.message}`);
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

  function cancelSessionPoll() {
    if (!state.sessionPollTimer) {
      return;
    }

    window.clearTimeout(state.sessionPollTimer);
    state.sessionPollTimer = null;
  }

  function scheduleStreamReconnect() {
    cancelStreamReconnect();
    state.streamReconnectTimer = window.setTimeout(() => {
      connectSessionStream();
    }, 1500);
  }

  function cancelStreamReconnect() {
    if (!state.streamReconnectTimer) {
      return;
    }

    window.clearTimeout(state.streamReconnectTimer);
    state.streamReconnectTimer = null;
  }

  function nextSessionPollDelay() {
    const session = state.session;
    if (!session || !session.active_thread_id) {
      return 2200;
    }

    if (session.pending_approvals?.length) {
      return 700;
    }

    if (session.active_turn_id) {
      return 700;
    }

    if (session.current_status && session.current_status !== "idle") {
      return 1100;
    }

    return 2200;
  }

  function isCurrentDeviceActiveController(session) {
    if (!session?.active_thread_id || !session.active_controller_device_id) {
      return false;
    }

    return session.active_controller_device_id === state.deviceId;
  }

  async function loadSession(reason) {
    logLine(`Fetching session snapshot (${reason})`);

    try {
      const response = await apiFetch("/api/session");
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to load session");
      }

      seedDefaults(payload.data);
      applySessionSnapshot(payload.data);
    } catch (error) {
      if (state.authRequired && !state.authenticated) {
        resetTranscriptPaging(null);
        renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
        logLine(`Session fetch blocked by local auth: ${error.message}`);
        return;
      }

      state.session = null;
      resetTranscriptPaging(null);
      cancelControllerHeartbeat();
      cancelControllerLeaseRefresh();
      renderSessionUnavailable(error.message);
      logLine(`Session fetch failed: ${error.message}`);
    } finally {
      if (!state.streamConnected) {
        scheduleSessionPoll();
      }
    }
  }

  async function loadThreads(reason) {
    renderThreadListMessage("Loading...", "Loading saved workspace groups...");
    logLine(`Fetching thread list across saved workspaces (${reason})`);

    try {
      const threads = queryClient
        ? await queryClient.fetchQuery(
            createThreadListQueryOptions({
              fetchThreads: fetchThreadList,
              limit: 120,
              scope: "local",
              surface: "local",
            })
          )
        : await fetchThreadList({ limit: 120 });

      state.threadGroups = buildThreadGroups(threads);
      state.threads = state.threadGroups.flatMap((group) => group.threads);
      renderThreads();
      renderOverviewState(state.session);
    } catch (error) {
      if (state.authRequired && !state.authenticated) {
        state.threadGroups = [];
        state.threads = [];
        renderThreadListMessage("Sign in", "Enter RELAY_API_TOKEN to load threads.");
        logLine(`Thread fetch blocked by local auth: ${error.message}`);
        return;
      }

      state.threadGroups = [];
      state.threads = [];
      renderThreadListMessage("Error", error.message);
      logLine(`Thread fetch failed: ${error.message}`);
    } finally {
      scheduleThreadsPoll();
    }
  }

  async function startSession() {
    const cwd = cwdInput.value.trim();

    if (!cwd) {
      logLine("Choose a directory before starting a session.");
      cwdInput.focus();
      return;
    }

    setSelectedCwd(cwd);
    setStartControlsBusy(true);
    logLine(`Starting a new Codex thread in ${cwd}`);

    try {
      const response = await apiFetch("/api/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cwd,
          initial_prompt: startPromptInput.value.trim() || null,
          model: modelInput.value.trim() || null,
          approval_policy: approvalPolicyInput.value,
          sandbox: sandboxInput.value,
          effort: startEffortInput.value,
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to start session");
      }

      state.defaultsSeeded = false;
      await runViewTransition(() => {
        setSelectedCwd(payload.data.current_cwd || cwd);
        setThreadRoute(payload.data.active_thread_id || null);
        seedDefaults(payload.data);
        applySessionSnapshot(payload.data);
      });
      if (canCurrentDeviceWrite(payload.data)) {
        messageInput.focus();
      }
      await loadThreads("post-start refresh");
      logLine("Started a new Codex thread");
    } catch (error) {
      logLine(`Session start failed: ${error.message}`);
    } finally {
      setStartControlsBusy(false);
    }
  }

  async function resumeSession(threadId) {
    logLine(`Resuming thread ${threadId}`);
    state.pendingThreadHistoryScrollTop = threadsList?.scrollTop || state.threadHistoryScrollTop || 0;

    try {
      const response = await apiFetch("/api/session/resume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          thread_id: threadId,
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to resume session");
      }

      state.defaultsSeeded = false;
      await runViewTransition(() => {
        setSelectedCwd(payload.data.current_cwd || state.selectedCwd);
        setThreadRoute(payload.data.active_thread_id || threadId);
        seedDefaults(payload.data);
        applySessionSnapshot(payload.data);
      });
      if (canCurrentDeviceWrite(payload.data)) {
        messageInput.focus();
      }
      logLine(`Resumed thread ${threadId}`);
    } catch (error) {
      logLine(`Resume failed: ${error.message}`);
    } finally {
      state.pendingThreadHistoryScrollTop = null;
    }
  }

  async function resumeLatestSession() {
    const cwd = cwdInput.value.trim();

    if (cwd && cwd !== state.selectedCwd) {
      setSelectedCwd(cwd);
      await loadThreads("continue latest");
    } else if (!state.threads.length) {
      await loadThreads("continue latest");
    }

    const latestThread = findLatestThread(state.threads, cwd || state.selectedCwd);
    if (!latestThread) {
      logLine(
        cwd || state.selectedCwd
          ? "No recent sessions were found for this workspace."
          : "No recent sessions were found."
      );
      return;
    }

    await resumeSession(latestThread.id);
  }

  async function sendMessage() {
    const text = messageInput.value.trim();

    if (!text) {
      logLine("Message is empty.");
      return;
    }

    sendButton.disabled = true;
    logLine("Sending prompt to Codex");

    try {
      const response = await apiFetch("/api/session/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          effort: messageEffort.value,
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to send prompt");
      }

      messageInput.value = "";
      applySessionSnapshot(payload.data);
      logLine("Prompt accepted by relay");
    } catch (error) {
      logLine(`Prompt failed: ${error.message}`);
    } finally {
      sendButton.disabled = false;
    }
  }

  async function startPairing() {
    startPairingButton.disabled = true;
    logLine("Creating a broker pairing ticket.");

    try {
      const response = await apiFetch("/api/pairing/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to start pairing");
      }

      state.currentPairing = payload.data;
      renderPairingPanel(state.currentPairing);
      logLine(`Pairing ticket ${payload.data.pairing_id} is ready.`);
    } catch (error) {
      logLine(`Pairing failed: ${error.message}`);
    } finally {
      startPairingButton.disabled = false;
    }
  }

  async function copyPairingLink() {
    const pairingUrl = state.currentPairing?.pairing_url;
    if (!pairingUrl) {
      logLine("No pairing link is available yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(pairingUrl);
      logLine("Copied pairing link to clipboard.");
    } catch (error) {
      pairingLinkInput.focus();
      pairingLinkInput.select();
      logLine(`Clipboard copy failed: ${error.message}`);
    }
  }

  async function revokePairedDevice(deviceId) {
    if (!deviceId) {
      return;
    }

    if (!window.confirm(`Revoke paired device ${deviceId}?`)) {
      return;
    }

    logLine(`Revoking paired device ${shortId(deviceId)}.`);

    try {
      const response = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to revoke paired device");
      }

      await loadSession("post-device-revoke refresh");
      logLine(`Revoked paired device ${shortId(deviceId)}.`);
    } catch (error) {
      logLine(`Revoke failed: ${error.message}`);
    }
  }

  async function revokeOtherDevices(keepDeviceId) {
    if (!keepDeviceId) {
      return;
    }

    if (!window.confirm(`Keep ${keepDeviceId} and revoke every other paired device?`)) {
      return;
    }

    logLine(`Keeping ${shortId(keepDeviceId)} and revoking every other paired device.`);

    try {
      const response = await apiFetch(
        `/api/devices/${encodeURIComponent(keepDeviceId)}/revoke-others`,
        {
          method: "POST",
        }
      );
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to revoke other paired devices");
      }

      await loadSession("post-bulk-device-revoke refresh");
      logLine(
        payload.data.revoked_count > 0
          ? `Revoked ${payload.data.revoked_count} other device(s); kept ${shortId(keepDeviceId)}.`
          : `No other paired devices were active; kept ${shortId(keepDeviceId)}.`
      );
    } catch (error) {
      logLine(`Bulk revoke failed: ${error.message}`);
    }
  }

  async function decidePairingRequest(pairingId, decision) {
    if (!pairingId || !decision) {
      return;
    }

    logLine(`Submitting ${decision} for pairing ${shortId(pairingId)}.`);

    try {
      const response = await apiFetch(`/api/pairings/${encodeURIComponent(pairingId)}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Pairing decision failed");
      }

      logLine(payload.data.message);
      await loadSession("post-pairing-decision refresh");
    } catch (error) {
      logLine(`Pairing decision failed: ${error.message}`);
    }
  }

  async function takeOverControl() {
    if (!state.session?.active_thread_id) {
      logLine("There is no active session to take over.");
      return;
    }

    takeOverButton.disabled = true;
    logLine(`Taking control from device ${shortId(state.deviceId)}`);

    try {
      const response = await apiFetch("/api/session/take-over", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to take control");
      }

      applySessionSnapshot(payload.data);
      messageInput.focus();
      logLine("This device now has control.");
    } catch (error) {
      logLine(`Take over failed: ${error.message}`);
    } finally {
      takeOverButton.disabled = false;
    }
  }

  async function submitDecision(decision, scope) {
    if (!state.currentApprovalId) {
      logLine("No pending approval to submit.");
      return;
    }

    logLine(`Submitting ${decision} for ${state.currentApprovalId}`);

    try {
      const response = await apiFetch(`/api/approvals/${encodeURIComponent(state.currentApprovalId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          decision,
          scope,
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Approval submission failed");
      }

      logLine(payload.data.message);
      await loadSession("post-decision refresh");
    } catch (error) {
      logLine(`Approval failed: ${error.message}`);
    }
  }

  async function toggleTranscriptEntry(itemId) {
    if (!itemId) {
      return;
    }
    const expandKey = `entry:${itemId}`;
    if (!state.transcriptExpandedItemIds) {
      state.transcriptExpandedItemIds = new Set();
    }
    if (state.transcriptExpandedItemIds.has(expandKey)) {
      state.transcriptExpandedItemIds.delete(expandKey);
    } else {
      state.transcriptExpandedItemIds.add(expandKey);
    }
    if (state.session) {
      renderSession(state.session);
    }

    if (
      !state.transcriptExpandedItemIds.has(expandKey)
      || !state.session?.active_thread_id
      || getCachedTranscriptEntryDetail(state, state.session.active_thread_id, itemId)
      || getLiveTranscriptEntryDetail(state, state.session.active_thread_id, itemId)
      || state.transcriptLoadingItemIds.has(itemId)
    ) {
      return;
    }

    const snapshot = restoreHydratedTranscript(state, state.session);
    const entry = (snapshot?.transcript || []).find((candidate) => candidate?.item_id === itemId);
    if (!entry || (entry.kind !== "tool_call" && entry.kind !== "command")) {
      return;
    }

    state.transcriptLoadingItemIds = new Set(state.transcriptLoadingItemIds).add(itemId);
    renderSession(state.session);

    try {
      const detailThreadId = state.session.active_thread_id;
      const detail = await fetchTranscriptEntryDetail(detailThreadId, itemId);
      if (!detail || state.session?.active_thread_id !== detailThreadId) {
        return;
      }
      const { cached } = cacheTranscriptEntryDetail(state, detailThreadId, detail);
      if (!cached) {
        setLiveTranscriptEntryDetail(state, detailThreadId, detail);
      }
    } catch (error) {
      logLine(`Transcript detail load failed: ${error.message}`);
    } finally {
      const nextLoading = new Set(state.transcriptLoadingItemIds);
      nextLoading.delete(itemId);
      state.transcriptLoadingItemIds = nextLoading;
      if (state.session) {
        renderSession(state.session);
      }
    }
  }

  async function applyFileChange(itemId, direction) {
    if (!itemId) {
      logLine("No file change selected.");
      return;
    }

    logLine(`${direction === "rollback" ? "Rolling back" : "Reapplying"} file change ${itemId}`);

    try {
      const response = await apiFetch(`/api/file-changes/${encodeURIComponent(itemId)}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          direction,
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "File change action failed");
      }

      logLine(payload.data.message);
      await loadSession("post-file-change action");
    } catch (error) {
      logLine(`File change action failed: ${error.message}`);
    }
  }

  return {
    cancelControllerHeartbeat,
    cancelControllerLeaseRefresh,
    cancelSessionPoll,
    cancelStreamReconnect,
    cancelThreadsPoll,
    connectSessionStream,
    copyPairingLink,
    decidePairingRequest,
    ensureConversationTranscript,
    loadSession,
    loadThreads,
    maybeLoadOlderTranscript,
    resumeLatestSession,
    resumeSession,
    revokeOtherDevices,
    revokePairedDevice,
    saveAllowedRoots,
    scheduleControllerHeartbeat,
    scheduleControllerLeaseRefresh,
    scheduleSessionPoll,
    scheduleThreadsPoll,
    sendMessage,
    startPairing,
    startSession,
    submitDecision,
    takeOverControl,
    toggleTranscriptEntry,
    applyFileChange,
  };
}
