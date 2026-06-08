import {
  approvalPolicyInput,
  cwdInput,
  messageEffort,
  messageInput,
  messageModel,
  modelInput,
  providerInput,
  sandboxInput,
  sendButton,
  startEffortInput,
  startPromptInput,
  threadsList,
} from "../dom.js";
import {
  requestReview as requestReviewApi,
  resolveReview as resolveReviewApi,
  dismissReview as dismissReviewApi,
} from "../api.js";
import { loadLastEffort, saveLastApprovalPolicy } from "../../shared/last-used-settings.js";
import { buildThreadGroups, findLatestThread } from "../../shared/thread-groups.js";
import { createThreadListQueryOptions } from "../../shared/thread-queries.js";
import { readThreadListUi } from "../../shared/thread-list-store.js";
import { shouldRenderThreadListLoadingPlaceholder } from "../../shared/thread-list-state.js";
import { syncLiveTranscriptEntryDetailsFromSnapshot } from "../transcript/details.js";
import { clearTranscriptHydration, restoreHydratedTranscript } from "../transcript/store.js";
import { threadAttention } from "../../shared/thread-attention.js";
import { isDocumentForeground, notifyThreadEvents } from "../../shared/thread-notify.js";

export function createLifecycleController(ctx) {
  const {
    state,
    apiFetch,
    queryClient,
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
    setStartControlsBusy,
    liveElement,
    isViewingConversation,
  } = ctx;
  const cancelControllerHeartbeat = (...args) => ctx.cancelControllerHeartbeat(...args);
  const cancelControllerLeaseRefresh = (...args) => ctx.cancelControllerLeaseRefresh(...args);
  const resetTranscriptHydrationState = (...args) => ctx.resetTranscriptHydrationState(...args);
  const scheduleSessionPoll = (...args) => ctx.scheduleSessionPoll(...args);
  const scheduleThreadsPoll = (...args) => ctx.scheduleThreadsPoll(...args);

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
        clearTranscriptHydration(state);
        renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
        logLine(`Session fetch blocked by local auth: ${error.message}`);
        return;
      }

      state.session = null;
      resetTranscriptHydrationState();
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
    state.threadListStore.getState().startRefresh();
    if (
      shouldRenderThreadListLoadingPlaceholder(
        readThreadListUi(state.threadListStore),
        state.threadGroups,
        state.threads
      )
    ) {
      renderThreadListMessage("Loading...", "Loading saved workspace groups...");
    }
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
      state.threadListStore.getState().finishRefresh();
      renderThreads();
      renderOverviewState(state.session);
    } catch (error) {
      state.threadListStore.getState().failRefresh(error.message);
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
    const liveCwdInput = liveElement("cwd-input", cwdInput);
    const liveStartPromptInput = liveElement("start-prompt", startPromptInput);
    const liveProviderInput = liveElement("provider-input", providerInput);
    const liveModelInput = liveElement("model-input", modelInput);
    const liveApprovalPolicyInput = liveElement("approval-policy-input", approvalPolicyInput);
    // sandbox-input was removed from the UI when the file-access dropdown
    // was collapsed into the permission level. Fall back to workspace-write
    // so the session-start protocol stays unchanged.
    const liveSandboxInput = liveElement("sandbox-input", sandboxInput);
    const sandboxValue = liveSandboxInput?.value || "workspace-write";
    const liveStartEffortInput = liveElement("start-effort", startEffortInput);
    const cwd = liveCwdInput.value.trim();

    if (!cwd) {
      logLine("Choose a directory before starting a session.");
      liveCwdInput.focus();
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
          initial_prompt: liveStartPromptInput.value.trim() || null,
          model: liveModelInput.value.trim() || null,
          approval_policy: liveApprovalPolicyInput.value,
          sandbox: sandboxValue,
          effort: liveStartEffortInput.value,
          device_id: state.deviceId,
          provider: liveProviderInput?.value || null,
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

  async function updateSessionSettings({ approval_policy, sandbox, effort, model } = {}) {
    if (!state.session?.active_thread_id) {
      return;
    }
    const body = { device_id: state.deviceId };
    if (typeof approval_policy === "string" && approval_policy) {
      body.approval_policy = approval_policy;
    }
    if (typeof sandbox === "string" && sandbox) {
      body.sandbox = sandbox;
    }
    if (typeof effort === "string" && effort) {
      body.effort = effort;
    }
    if (typeof model === "string" && model) {
      body.model = model;
    }
    if (
      !("approval_policy" in body)
      && !("sandbox" in body)
      && !("effort" in body)
      && !("model" in body)
    ) {
      return;
    }

    try {
      const response = await apiFetch("/api/session/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to update session settings");
      }
      applySessionSnapshot(payload.data);
      if (body.approval_policy && state.session?.provider) {
        saveLastApprovalPolicy(state.session.provider, body.approval_policy);
      }
      const parts = [];
      if (body.approval_policy) parts.push(`approval=${body.approval_policy}`);
      if (body.sandbox) parts.push(`sandbox=${body.sandbox}`);
      if (body.effort) parts.push(`effort=${body.effort}`);
      if (body.model) parts.push(`model=${body.model}`);
      logLine(`Updated session settings: ${parts.join(", ")}`);
    } catch (error) {
      logLine(`Settings update failed: ${error.message}`);
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
          model: messageModel?.value,
          effort: messageEffort?.value
            || loadLastEffort(state.session?.provider || "")
            || state.session?.reasoning_effort
            || "",
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

  async function requestReview({
    reviewerProvider,
    reviewerModel,
    reviewerEffort,
    instructions,
    reviewerThreadId,
    maxRounds,
  } = {}) {
    if (!reviewerProvider) {
      logLine("Pick a reviewer provider before starting a review.");
      return null;
    }

    logLine(
      reviewerThreadId
        ? `Requesting ${reviewerProvider} re-review`
        : `Requesting ${reviewerProvider} review`
    );

    try {
      const receipt = await requestReviewApi(
        apiFetch,
        {
          reviewer_provider: reviewerProvider,
          reviewer_model: reviewerModel || null,
          // Optional reasoning-effort override (clean or reuse).
          reviewer_effort: reviewerEffort || null,
          instructions: instructions || null,
          // Phase 3: reuse an existing reviewer thread when chosen.
          reviewer_thread_id: reviewerThreadId || null,
          // Phase 5: round budget for the iterative reviewer↔author loop.
          max_rounds: maxRounds || 1,
        },
        state.deviceId
      );
      logLine(receipt?.message || "Review started.");
      // Reflect the new review chip immediately; the stream keeps it updated.
      await loadSession("post-review-request");
      return receipt;
    } catch (error) {
      // Log AND re-raise: the request modal surfaces the relay's reason inline so a
      // rejected review (e.g. "another thread is running in this workspace") no longer
      // looks like a silent no-op buried in the activity log.
      logLine(`Review request failed: ${error.message}`);
      throw error;
    }
  }

  async function resolveReview() {
    logLine("Stopping the blocked reviewer…");
    try {
      const receipt = await resolveReviewApi(apiFetch, state.deviceId);
      logLine(receipt?.message || "Reviewer stopped; workspace unlocked.");
      await loadSession("post-review-resolve");
      return receipt;
    } catch (error) {
      logLine(`Resolve failed: ${error.message}`);
      return null;
    }
  }

  async function dismissReview(reviewId) {
    if (!reviewId) {
      logLine("No review to dismiss.");
      return null;
    }
    logLine("Dismissing review…");
    try {
      const receipt = await dismissReviewApi(apiFetch, reviewId, state.deviceId);
      logLine(receipt?.message || "Review dismissed.");
      await loadSession("post-review-dismiss");
      return receipt;
    } catch (error) {
      logLine(`Dismiss failed: ${error.message}`);
      return null;
    }
  }

  async function stopActiveTurn() {
    if (!state.session?.active_thread_id || !state.session.active_turn_id) {
      logLine("There is no running Codex turn to stop.");
      return;
    }

    logLine("Requesting Codex stop");

    try {
      const response = await apiFetch("/api/session/stop", {
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
        throw new Error(payload?.error?.message || "Failed to stop Codex");
      }

      applySessionSnapshot(payload.data);
      logLine("Stop request sent to Codex");
    } catch (error) {
      logLine(`Stop failed: ${error.message}`);
    }
  }

  function applySessionSnapshot(snapshot) {
    const previousThreadId = state.session?.active_thread_id || null;
    if (snapshot?.active_thread_id !== state.transcriptHydrationThreadId) {
      resetTranscriptHydrationState();
    }
    if (snapshot?.active_thread_id !== previousThreadId) {
      state.localUiStore.getState().clearTranscriptDetailLoading();
      // Scroll state belongs to the previous thread — drop it when the
      // active thread actually changes so the new thread starts fresh
      // (jump-to-bottom on first render of the new conversation).
      state.localTranscriptScrollSnapshot = null;
      if (state.localTranscriptScrollAnchors && previousThreadId) {
        state.localTranscriptScrollAnchors.delete(previousThreadId);
      }
    }

    // Deferred-start Claude threads get promoted server-side when the first
    // message is sent: the public id changes from `claude-pending-…` to the
    // real Anthropic session id. Keep the URL aligned (replace, not push, so
    // we don't trap the back button) so isViewingConversation stays true.
    // Scoped to the pending-prefix transition so initial loads with a seeded
    // active_thread_id don't auto-enter conversation view.
    if (
      previousThreadId
      && previousThreadId.startsWith("claude-pending-")
      && snapshot?.active_thread_id
      && snapshot.active_thread_id !== previousThreadId
      && state.viewThreadId === previousThreadId
    ) {
      setThreadRoute(snapshot.active_thread_id, { replace: true });
    }

    // Update per-thread attention + fire notifications here — the single
    // chokepoint every snapshot path flows through (SSE, polling fallback,
    // pairing, initial load) — so the feature keeps working when streaming is
    // unavailable. Runs before renderSession so the dot paints the same frame.
    try {
      const events = threadAttention.ingest(snapshot, {
        viewedThreadId: state.viewThreadId || snapshot?.active_thread_id || null,
        isForeground: isDocumentForeground(),
      });
      notifyThreadEvents(events);
    } catch (error) {
      logLine(`Thread attention update failed: ${error.message}`);
    }

    syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot);
    const merged = restoreHydratedTranscript(state, snapshot);
    renderSession(merged);
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

  return {
    loadSession,
    loadThreads,
    startSession,
    resumeSession,
    updateSessionSettings,
    resumeLatestSession,
    sendMessage,
    requestReview,
    resolveReview,
    dismissReview,
    stopActiveTurn,
    applySessionSnapshot,
    fetchThreadList,
  };
}
