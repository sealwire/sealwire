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
  startWorkflow as startWorkflowApi,
  resolveReview as resolveReviewApi,
  resolveWorkflow as resolveWorkflowApi,
  deleteReview as deleteReviewApi,
} from "../api.js";
import { loadLastEffort, saveLastApprovalPolicy } from "../../shared/last-used-settings.js";
import { retargetTranscriptScrollThread } from "../../shared/transcript-scroll.js";
import { detectDeferredThreadPromotion } from "../../shared/thread-promotion.js";
import { resolveOutgoingEffort } from "../../shared/reasoning-efforts.js";
import { providerLabel } from "../../shared/provider-labels.js";
import { forkFieldsToPayload } from "../../shared/fork-fields.js";
import { buildNavigationThreadGroups, findLatestThread } from "../../shared/thread-groups.js";
import { createThreadListQueryOptions } from "../../shared/thread-queries.js";
import { readThreadListUi } from "../../shared/thread-list-store.js";
import { shouldRenderThreadListLoadingPlaceholder } from "../../shared/thread-list-state.js";
import { syncLiveTranscriptEntryDetailsFromSnapshot } from "../transcript/details.js";
import {
  clearTranscriptHydration,
  restoreHydratedTranscript,
  switchTranscriptHydrationThread,
} from "../transcript/store.js";
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
    logLine(`Fetching session list across saved workspaces (${reason})`);

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

      state.threadGroups = buildNavigationThreadGroups(threads);
      state.threads = state.threadGroups.flatMap((group) => group.threads);
      state.threadListStore.getState().finishRefresh();
      renderThreads();
      renderOverviewState(state.session);
      // A read-only view-only pin sources its cwd/provider from the thread
      // summary, which may have just loaded — re-render the session so the
      // projection picks them up now instead of waiting for the next snapshot.
      if (state.viewOnlyThread && state.session) {
        renderSession(state.session);
      }
    } catch (error) {
      state.threadListStore.getState().failRefresh(error.message);
      if (state.authRequired && !state.authenticated) {
        state.threadGroups = [];
        state.threads = [];
        renderThreadListMessage("Sign in", "Enter RELAY_API_TOKEN to load sessions.");
        logLine(`Session list fetch blocked by local auth: ${error.message}`);
        return;
      }

      state.threadGroups = [];
      state.threads = [];
      renderThreadListMessage("Error", error.message);
      logLine(`Session list fetch failed: ${error.message}`);
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
    // Name the provider being started — not a hardcoded "Codex".
    const agentName = providerLabel(liveProviderInput?.value) || "agent";
    logLine(`Starting a new ${agentName} session in ${cwd}`);

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
      logLine(`Started a new ${agentName} session`);
    } catch (error) {
      logLine(`Session start failed: ${error.message}`);
    } finally {
      setStartControlsBusy(false);
    }
  }

  async function resumeSession(threadId) {
    logLine(`Resuming session ${threadId}`);
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
      logLine(`Resumed session ${threadId}`);
      return true;
    } catch (error) {
      logLine(`Resume failed: ${error.message}`);
      return false;
    } finally {
      state.pendingThreadHistoryScrollTop = null;
    }
  }

  async function forkSession(forkDraft) {
    const sourceThreadId = forkDraft?.sourceThreadId || "";
    if (!sourceThreadId) {
      return { ok: false, error: "Choose a session to fork." };
    }
    const cwd = String(forkDraft?.cwd || "").trim();
    if (!cwd) {
      return { ok: false, error: "Choose a directory before forking a session." };
    }
    const provider = forkDraft?.provider || null;
    const agentName = providerLabel(provider) || "agent";
    logLine(`Forking session ${sourceThreadId} into ${agentName}.`);

    try {
      const response = await apiFetch("/api/session/fork", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // Settings the user did not explicitly choose go out as null so the
        // relay resolves them from the SOURCE thread. Sending the live
        // session's values here would silently re-permission the fork.
        body: JSON.stringify({
          ...forkFieldsToPayload({ ...forkDraft, sourceThreadId, cwd }),
          device_id: state.deviceId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to fork session");
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
      await loadThreads("post-fork refresh");
      logLine(`Forked session ${sourceThreadId}`);
      return { ok: true };
    } catch (error) {
      logLine(`Fork failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async function updateSessionSettings({ approval_policy, sandbox, effort, model } = {}) {
    if (!state.session?.active_thread_id) {
      return;
    }
    const body = {
      device_id: state.deviceId,
      thread_id: state.viewOnlyThread?.threadId || state.session.active_thread_id,
    };
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
      if (state.viewOnlyThread?.threadId === body.thread_id) {
        state.viewOnlyThread = {
          ...state.viewOnlyThread,
          settings: {
            ...(state.viewOnlyThread.settings || {}),
            approval_policy:
              body.approval_policy || state.viewOnlyThread.settings?.approval_policy || "",
            sandbox: body.sandbox || state.viewOnlyThread.settings?.sandbox || "",
            reasoning_effort:
              body.effort || state.viewOnlyThread.settings?.reasoning_effort || "",
            model: body.model || state.viewOnlyThread.settings?.model || "",
          },
        };
        if (state.session) {
          renderSession(state.session);
        }
      }
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

    await runViewTransition(() => {
      setThreadRoute(latestThread.id);
      if (state.session) {
        renderSession(state.session);
      }
      renderThreads();
    });
  }

  async function sendMessage(textOverride, threadId, images = []) {
    // Accept an explicit, already-captured message (the composer captures the draft
    // at submit time so a later edit can't change what is sent). Fall back to the
    // live input value for the normal path.
    const text = (typeof textOverride === "string" ? textOverride : messageInput.value).trim();

    if (!text && images.length === 0) {
      logLine("Message is empty.");
      return false;
    }
    if (!threadId) {
      logLine("No session is selected.");
      return false;
    }

    sendButton.disabled = true;
    logLine(`Sending prompt to ${providerLabel(state.session?.provider) || "agent"}`);

    try {
      const response = await apiFetch("/api/session/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model: messageModel?.value,
          // The live session effort wins over the per-provider last-used memory,
          // and the result is clamped to the target model's supported set — so a
          // stale/foreign value (e.g. a "max" mis-bucketed under codex) can never
          // be forwarded and rejected with a 400.
          effort: resolveOutgoingEffort({
            override: messageEffort?.value || "",
            sessionEffort: state.session?.reasoning_effort || "",
            lastUsedEffort: loadLastEffort(state.session?.provider || ""),
            models: state.session?.available_models || [],
            model: messageModel?.value || state.session?.model || "",
          }),
          device_id: state.deviceId,
          // Target the thread captured at submit time. The relay starts the turn
          // directly there, so a concurrent navigation cannot redirect the message.
          thread_id: threadId,
          images,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to send prompt");
      }

      messageInput.value = "";
      applySessionSnapshot(payload.data);
      logLine("Prompt accepted by relay");
      return true;
    } catch (error) {
      logLine(`Prompt failed: ${error.message}`);
      return false;
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
    parentThreadId,
    maxRounds,
    recapSource,
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
          // The thread to review (the viewed thread). null lets the backend default
          // to the active thread.
          parent_thread_id: parentThreadId || null,
          // How to brief the reviewer ("last_message" default vs "recap").
          recap_source: recapSource || "last_message",
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
      // rejected review (e.g. "another session is running in this workspace") no longer
      // looks like a silent no-op buried in the activity log.
      logLine(`Review request failed: ${error.message}`);
      throw error;
    }
  }

  async function startWorkflow({
    taskPrompt,
    reviewerProvider,
    reviewerModel,
    reviewerInstructions,
    maxRounds,
    anchorItemId,
    parentThreadId,
  } = {}) {
    if (!taskPrompt?.trim()) {
      logLine("Enter a task before starting Code Flow.");
      return null;
    }
    if (!reviewerProvider) {
      logLine("Pick a reviewer provider before starting Code Flow.");
      return null;
    }

    logLine(`Starting Code Flow with ${reviewerProvider} reviewer`);

    try {
      const receipt = await startWorkflowApi(
        apiFetch,
        {
          workflow_id: "code_flow",
          task_prompt: taskPrompt.trim(),
          reviewer_provider: reviewerProvider,
          reviewer_model: reviewerModel || null,
          reviewer_instructions: reviewerInstructions || null,
          max_rounds: maxRounds || 2,
          anchor_item_id: anchorItemId || null,
          parent_thread_id: parentThreadId || null,
        },
        state.deviceId
      );
      logLine(receipt?.message || "Code Flow started.");
      await loadSession("post-workflow-start");
      return receipt;
    } catch (error) {
      logLine(`Code Flow start failed: ${error.message}`);
      throw error;
    }
  }

  async function resolveReview(reviewJobId) {
    logLine("Stopping the blocked reviewer…");
    try {
      const receipt = await resolveReviewApi(apiFetch, reviewJobId, state.deviceId);
      logLine(receipt?.message || "Reviewer stopped; workspace unlocked.");
      await loadSession("post-review-resolve");
      return receipt;
    } catch (error) {
      logLine(`Resolve failed: ${error.message}`);
      return null;
    }
  }

  async function resolveWorkflow(workflowRunId) {
    logLine("Stopping the blocked Code Flow…");
    try {
      const receipt = await resolveWorkflowApi(apiFetch, workflowRunId, state.deviceId);
      logLine(receipt?.message || "Code Flow stopped; workspace unlocked.");
      await loadSession("post-workflow-resolve");
      return receipt;
    } catch (error) {
      logLine(`Code Flow resolve failed: ${error.message}`);
      return null;
    }
  }

  async function deleteReview(reviewId) {
    if (!reviewId) {
      logLine("No review to delete.");
      return null;
    }
    logLine("Deleting review…");
    try {
      const receipt = await deleteReviewApi(apiFetch, reviewId, state.deviceId);
      logLine(receipt?.message || "Review deleted.");
      await loadSession("post-review-delete");
      return receipt;
    } catch (error) {
      logLine(`Delete failed: ${error.message}`);
      return null;
    }
  }

  async function stopActiveTurn() {
    // Name the active thread's own provider — never a hardcoded "Codex".
    const agentName = providerLabel(state.session?.provider) || "agent";
    if (!state.session?.active_thread_id || !state.session.active_turn_id) {
      logLine(`There is no running ${agentName} turn to stop.`);
      return;
    }

    logLine(`Requesting ${agentName} stop`);

    try {
      const response = await apiFetch("/api/session/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          device_id: state.deviceId,
          thread_id: state.viewOnlyThread?.threadId || state.session.active_thread_id,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || `Failed to stop ${agentName}`);
      }

      applySessionSnapshot(payload.data);
      logLine(`Stop request sent to ${agentName}`);
    } catch (error) {
      logLine(`Stop failed: ${error.message}`);
    }
  }

  function applySessionSnapshot(snapshot) {
    const previousThreadId = state.session?.active_thread_id || null;
    if (snapshot?.active_thread_id !== state.transcriptHydrationThreadId) {
      // Thread switch: retain the leaving thread's loaded window and restore the
      // target thread's retained window (if any) instead of clearing — so
      // switching away and back keeps the older history already scrolled into
      // view rather than reloading only the tail. The next snapshot/hydration
      // merges the fresh tail onto the restored window.
      switchTranscriptHydrationThread(state, snapshot?.active_thread_id || null);
      state.transcriptPreserveScroll = false;
    }
    if (snapshot?.active_thread_id !== previousThreadId) {
      state.localUiStore.getState().clearTranscriptDetailLoading();
    }

    // Deferred-start Claude threads get promoted server-side when the first
    // message is sent: the public id changes from `claude-pending-…` to the
    // real Anthropic session id. Keep the URL aligned (replace, not push, so
    // we don't trap the back button) so isViewingConversation stays true.
    // Scoped to the pending-prefix transition so initial loads with a seeded
    // active_thread_id don't auto-enter conversation view.
    const threadPromotion = detectDeferredThreadPromotion({
      previousThreadId,
      nextThreadId: snapshot?.active_thread_id || null,
      nextThreadPromotedFrom: snapshot?.active_thread_promoted_from || null,
    });
    if (threadPromotion) {
      // Same logical thread, new public id: move the scroll bookkeeping over,
      // or the first reply classifies as a thread switch (jump-bottom, which
      // briefly re-enables the stick-to-bottom follow) instead of keeping the
      // user's freshly anchored message in place.
      retargetTranscriptScrollThread(state, threadPromotion.from, threadPromotion.to);
      if (state.viewThreadId === threadPromotion.from) {
        setThreadRoute(threadPromotion.to, { replace: true });
      }
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
      logLine(`Session attention update failed: ${error.message}`);
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
      throw new Error(payload?.error?.message || "Failed to load sessions");
    }

    return payload.data?.threads || [];
  }

  return {
    loadSession,
    loadThreads,
    startSession,
    forkSession,
    resumeSession,
    updateSessionSettings,
    resumeLatestSession,
    sendMessage,
    requestReview,
    startWorkflow,
    resolveReview,
    resolveWorkflow,
    deleteReview,
    stopActiveTurn,
    applySessionSnapshot,
    fetchThreadList,
  };
}
