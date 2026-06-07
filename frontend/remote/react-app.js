import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { fetchBuildInfo } from "../shared/build-badge.js";
import { ClientLog } from "../shared/client-log.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
  saveLastApprovalPolicy,
  saveLastEffort,
} from "../shared/last-used-settings.js";
import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "../shared/reasoning-efforts.js";
import {
  defaultModelForProvider,
  defaultProvider,
  normalizeProviderList,
  providerOptions,
  providerSettings,
} from "../shared/provider-settings.js";
import { RefreshButton } from "../shared/refresh-button.js";
import { copyTextToClipboard } from "../shared/clipboard.js";
import { ThemePickerRow } from "../shared/theme-picker.js";
import { installThreadListWheelProxy } from "../shared/thread-list-scroll.js";
import { selectWorkspaceSuggestionsModel } from "../shared/workspace-suggestions.js";
import { createVerbCycler } from "../progress-verbs.js";
import {
  selectDeviceChromeRenderModel,
  selectResetChromeRenderModel,
  selectSessionChromeRenderModel,
  selectStatusBadgeRenderModel,
} from "./chrome-view-model.js";
import { deriveSessionRuntime } from "./session-runtime.js";
import {
  closeRemoteNavigation,
  toggleRemoteNavigation,
} from "./navigation.js";
import {
  createInitialRemoteTranscriptUiState,
  reduceRemoteTranscriptUiState,
} from "./remote-ui-state.js";
import {
  createRemoteUiStore,
} from "./remote-ui-store.js";
import {
  readRemoteStateSnapshot,
  subscribeRemoteState,
} from "./state.js";
import {
  loadRelayNicknames,
  saveRelayNickname,
  subscribeRelayNicknames,
} from "./relay-nicknames.js";
import {
  selectEmptyStateRenderModel,
  selectRelayDirectoryRenderModel,
  selectSessionRenderModel,
  selectThreadsRenderModel,
} from "./view-model.js";
import {
  bootRemoteRuntime,
  createRemoteAppHandlers,
  initializeRemoteSurface,
  installSidebarGestureDebug,
} from "./remote-runtime.js";
import {
  fetchTranscriptEntryDetail as fetchRemoteTranscriptEntryDetail,
  maybeLoadOlderTranscriptHistory,
  sendHeartbeat,
} from "./session-ops.js";
import {
  buildExpandedTranscriptDetailEntries,
  cacheTranscriptEntryDetail,
  collectFileChangeDetailItemIds,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  isOmittedFileChangeDetail,
  setLiveTranscriptEntryDetail,
} from "./transcript/details.js";
import {
  captureTranscriptScrollSnapshot,
  restoreTranscriptScrollPosition,
} from "./transcript-scroll.js";
import { fetchModelsWithRetry } from "./provider-model-fetch.js";
import { useRemoteSessionRuntime } from "./use-remote-session-runtime.js";
import {
  RemoteReviewerChip,
  RemoteWorkspaceChangesRail,
  RemoteWorkspaceDiffChip,
  RemoteWorkspaceDiffModal,
  getRemoteWorkspaceDiffStore,
  notifyRemoteSessionUpdated,
  triggerRemoteWorkspaceDiffRefresh,
} from "./workspace-diff-host.js";
import {
  canRequestReview,
  isReviewBlocked,
  isReviewInProgressForThread,
  selectReviewLaunchModel,
} from "../shared/review-state.js";
import { ReviewLauncher } from "../shared/review-panel.js";
import { selectReusableReviewers } from "../shared/reviewer-threads.js";
import { createPanelControl } from "../local/panel-controls.js";
import { setupHeaderBandSync } from "../local/header-band-sync.js";
import {
  Composer,
  ControlBanner,
  DeviceMetaPanel,
  MissingCredentialsState,
  RelayDirectoryList,
  RelayHomeState,
  SessionMetaPanel,
  SessionPanel,
  WorkspaceHeading,
} from "./react-renderer.js";
import {
  AgentWorkingIndicator,
  ConversationEmptyState,
} from "../shared/conversation.js";
import { SessionSettingsButton } from "../shared/session-settings-panel.js";
import { attachTranscriptHistoryLoader } from "../shared/transcript-history-loader.js";
import { ThreadGroupList } from "../shared/thread-list-react.js";
import { buildThreadActivityMap } from "../shared/thread-activity.js";
import {
  createThreadListStore,
} from "../shared/thread-list-store.js";
import { TranscriptPane } from "../shared/transcript-pane.js";
import { setRemoteTranscriptElement } from "./ui-refs.js";
import { formatRelativeTime, formatTimestamp, shortId } from "./utils.js";

const h = React.createElement;
const LIVE_TRANSCRIPT_DETAIL_REFRESH_MS = 1000;

let remoteAppRoot = null;

function useThreadListStoreState(store) {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().threadList,
    () => store.getState().threadList
  );
}

function useRemoteUiStoreState(store) {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState(),
    () => store.getState()
  );
}

export function mountRemoteApp() {
  const container = document.querySelector("#remote-root");
  if (!container) {
    throw new Error("remote root container is missing");
  }

  initializeRemoteSurface();

  if (!remoteAppRoot) {
    remoteAppRoot = createRoot(container);
  }

  flushSync(() => {
    remoteAppRoot.render(h(RemoteApp));
  });
}

export function unmountRemoteApp() {
  remoteAppRoot?.unmount();
  remoteAppRoot = null;
}

function useRelayNicknames() {
  return useSyncExternalStore(
    subscribeRelayNicknames,
    loadRelayNicknames,
    loadRelayNicknames
  );
}

function mergeAskUserQuestionDetails(pendingRequests, detailByRequestId) {
  if (!Array.isArray(pendingRequests) || !pendingRequests.length) {
    return [];
  }
  return pendingRequests.map((request) => {
    const detail = detailByRequestId?.get?.(request?.request_id);
    if (!detail?.questions?.length) {
      return request;
    }
    return {
      ...request,
      ...detail,
      questions: detail.questions,
      questions_inline_complete: true,
      detail_available: true,
    };
  });
}

function filterAskUserDetailMap(map, activeRequestIds) {
  let changed = false;
  const next = new Map();
  for (const [requestId, value] of map || []) {
    if (activeRequestIds.has(requestId)) {
      next.set(requestId, value);
    } else {
      changed = true;
    }
  }
  return changed ? next : map;
}

function filterAskUserDetailSet(set, activeRequestIds) {
  let changed = false;
  const next = new Set();
  for (const requestId of set || []) {
    if (activeRequestIds.has(requestId)) {
      next.add(requestId);
    } else {
      changed = true;
    }
  }
  return changed ? next : set;
}

function RemoteApp() {
  const currentState = useSyncExternalStore(
    subscribeRemoteState,
    readRemoteStateSnapshot
  ).state;
  const relayNicknames = useRelayNicknames();
  const previousSessionRef = useRef(null);
  const [transcriptUiState, dispatchTranscriptUi] = useReducer(
    reduceRemoteTranscriptUiState,
    undefined,
    createInitialRemoteTranscriptUiState
  );
  const [askUserQuestionDetails, setAskUserQuestionDetails] = useState(() => new Map());
  const [askUserQuestionDetailLoading, setAskUserQuestionDetailLoading] = useState(() => new Set());
  const [askUserQuestionDetailErrors, setAskUserQuestionDetailErrors] = useState(() => new Map());
  const [remoteUiStore] = useState(() => createRemoteUiStore());
  const remoteUi = useRemoteUiStoreState(remoteUiStore);
  const [threadListStore] = useState(() => createThreadListStore());
  const threadListUi = useThreadListStoreState(threadListStore);
  const [progressVerb, setProgressVerb] = useState(null);
  const verbCyclerRef = useRef(null);
  if (!verbCyclerRef.current) verbCyclerRef.current = createVerbCycler();
  const sessionPhase = currentState.session?.current_phase ?? null;
  useEffect(() => {
    if (!sessionPhase) {
      setProgressVerb(null);
      verbCyclerRef.current?.reset?.();
      return undefined;
    }
    setProgressVerb(verbCyclerRef.current.next());
    const timer = setInterval(() => {
      setProgressVerb(verbCyclerRef.current.next());
    }, 2500);
    return () => clearInterval(timer);
  }, [sessionPhase]);
  const handlers = createRemoteAppHandlers();
  const selectedProvider = remoteUi.sessionDraft.provider || defaultProvider(remoteUi.providers);
  const selectedProviderModels = remoteUi.providerModels[selectedProvider] || [];
  const selectedProviderSettings = providerSettings(selectedProvider);

  useEffect(() => {
    if (!currentState.remoteAuth?.payloadSecret) return;
    let cancelled = false;
    handlers.onFetchProviders?.()
      .then((providers) => {
        if (cancelled) return;
        const normalized = normalizeProviderList(providers);
        remoteUiStore.getState().setProviders(normalized);
        const draftProvider = remoteUiStore.getState().sessionDraft.provider;
        if (!draftProvider || !normalized.includes(draftProvider)) {
          remoteUiStore.getState().setSessionDraftField("provider", defaultProvider(normalized));
        }
        // Pre-fetch models for all providers so the dropdown is populated
        // immediately. Worker-backed providers (Claude) can be cold right after
        // a restart, so retry with backoff and record the status instead of
        // silently falling back to a single default.
        for (const provider of normalized) {
          remoteUiStore.getState().setProviderModelsStatus(provider, "loading");
          fetchModelsWithRetry((p) => handlers.onFetchProviderModels?.(p), provider)
            .then((models) => {
              if (cancelled) return;
              remoteUiStore.getState().setProviderModels(provider, models || []);
              remoteUiStore.getState().setProviderModelsStatus(provider, "ready");
            })
            .catch(() => {
              if (!cancelled) remoteUiStore.getState().setProviderModelsStatus(provider, "error");
            });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentState.remoteAuth?.relayId, currentState.remoteAuth?.payloadSecret]);

  useEffect(() => {
    if (!currentState.remoteAuth?.payloadSecret || !selectedProvider) return;
    if (!remoteUi.providers.length || !remoteUi.providers.includes(selectedProvider)) return;
    let cancelled = false;
    remoteUiStore.getState().setProviderModelsStatus(selectedProvider, "loading");
    fetchModelsWithRetry((p) => handlers.onFetchProviderModels?.(p), selectedProvider)
      .then((models) => {
        if (cancelled) return;
        remoteUiStore.getState().setProviderModels(selectedProvider, models || []);
        remoteUiStore.getState().setProviderModelsStatus(selectedProvider, "ready");
        const draft = remoteUiStore.getState().sessionDraft;
        const storedEffort = loadLastEffort(selectedProvider);
        const storedApproval = loadLastApprovalPolicy(selectedProvider);
        if (storedApproval && draft.approvalPolicy !== storedApproval) {
          remoteUiStore.getState().setSessionDraftField("approvalPolicy", storedApproval);
        }
        // Prefer stored effort (last-used for this provider) before falling back
        // to draft.effort, which may be carried over from a different provider.
        const effortSeed = storedEffort || draft.effort;
        if (draft.provider === selectedProvider && (!draft.model || draft.model === defaultModelForProvider(selectedProvider))) {
          const nextModel = models?.find((model) => model.is_default)?.model
            || models?.[0]?.model
            || defaultModelForProvider(selectedProvider);
          remoteUiStore.getState().setSessionDraftField("model", nextModel);
          remoteUiStore.getState().setSessionDraftField(
            "effort",
            resolveReasoningEffortValue(models || [], nextModel, effortSeed)
          );
          return;
        }
        remoteUiStore.getState().setSessionDraftField(
          "effort",
          resolveReasoningEffortValue(
            models || [],
            draft.model || defaultModelForProvider(selectedProvider),
            effortSeed
          )
        );
      })
      .catch(() => {
        if (!cancelled) {
          remoteUiStore.getState().setProviderModelsStatus(selectedProvider, "error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentState.remoteAuth?.relayId, currentState.remoteAuth?.payloadSecret, selectedProvider, currentState.socketConnected, remoteUi.providers]);

  useEffect(() => {
    const models = currentState.session?.available_models;
    const provider = currentState.session?.provider;
    if (!models?.length || !provider) return;
    if (remoteUi.providerModels[provider]?.length >= models.length) return;
    remoteUiStore.getState().setProviderModels(provider, models);
    const draft = remoteUiStore.getState().sessionDraft;
    if (draft.provider === provider && (!draft.model || draft.model === defaultModelForProvider(provider))) {
      const nextModel = models.find((m) => m.is_default)?.model
        || models[0]?.model
        || defaultModelForProvider(provider);
      remoteUiStore.getState().setSessionDraftField("model", nextModel);
    }
  }, [currentState.session?.available_models, currentState.session?.provider]);

  const session = currentState.session;
  const previousSession = previousSessionRef.current;
  const hasControllerLease = !session?.view_only && (
    !session?.active_controller_device_id
    || session.active_controller_device_id === currentState.remoteAuth?.deviceId
  );
  const sessionView = session
    ? selectSessionRenderModel({
        hasControllerLease,
        previousSession,
        session,
      })
    : null;
  const sessionRuntime = sessionView
    ? deriveSessionRuntime({
        composerDraft: remoteUi.composerDraft,
        composerEffort: remoteUi.composerEffort,
        composerModel: remoteUi.composerModel,
        sendPending: remoteUi.sendPending,
        session,
        sessionView,
      })
    : null;
  const emptyStateModel = selectEmptyStateRenderModel({
    clientAuth: currentState.clientAuth,
    pairingTicket: currentState.pairingTicket,
    relayDirectory: currentState.relayDirectory,
    relayConnected: currentState.relayConnected,
    relayConnectionMessage: currentState.relayConnectionMessage,
    remoteAuth: currentState.remoteAuth,
    serverConnectionMessage: currentState.serverConnectionMessage,
    serverConnectionState: currentState.serverConnectionState,
    socketConnected: currentState.socketConnected,
  });
  const relayDirectoryModel = selectRelayDirectoryRenderModel({
    activeRelayId: currentState.remoteAuth?.relayId || null,
    nicknames: relayNicknames,
    relayDirectory: currentState.relayDirectory,
  });
  const threadsModel = selectThreadsRenderModel({
    activeThreadId: session?.active_thread_id || null,
    error: threadListUi.error,
    loading: threadListUi.loading,
    relayDirectory: currentState.relayDirectory,
    remoteAuth: currentState.remoteAuth,
    session,
    threads: currentState.threads,
  });
  const hasRelay = Boolean(currentState.remoteAuth);
  const hasUsableRelay = Boolean(currentState.remoteAuth?.payloadSecret);
  const sessionChromeModel = session
    ? selectSessionChromeRenderModel({ ...currentState, progressVerb }, session)
    : null;
  const resetChromeModel = selectResetChromeRenderModel(currentState);
  const deviceChromeModel = selectDeviceChromeRenderModel(currentState);
  const statusBadgeModel = session
    ? sessionChromeModel.statusBadge
    : selectStatusBadgeRenderModel(currentState);
  const headerModel = session ? sessionChromeModel.header : resetChromeModel.header;
  const sessionMetaModel = session ? sessionChromeModel.sessionMeta : resetChromeModel.sessionMeta;
  const controlBannerModel = session
    ? sessionChromeModel.controlBanner
    : resetChromeModel.controlBanner;
  const agentWorkingIndicatorModel = sessionChromeModel?.agentWorkingIndicator
    ?? { hidden: true, label: "", tone: "ready" };
  const sessionToggleLabel = !hasRelay
    ? "Select a relay first"
    : remoteUi.sessionPanelOpen
      ? "Close"
      : "New session";
  const sessionPanelModel = {
    fields: {
      ...remoteUi.sessionDraft,
      provider: selectedProvider,
      model: remoteUi.sessionDraft.model || defaultModelForProvider(selectedProvider),
      effort: resolveReasoningEffortValue(
        selectedProviderModels,
        remoteUi.sessionDraft.model || defaultModelForProvider(selectedProvider),
        remoteUi.sessionDraft.effort
      ),
    },
    effortOptions: buildReasoningEffortOptions(
      selectedProviderModels,
      remoteUi.sessionDraft.model || defaultModelForProvider(selectedProvider),
      selectedProvider
    ),
    labels: {
      approval: selectedProviderSettings.approvalLabel,
      effort: selectedProviderSettings.effortLabel,
      model: selectedProviderSettings.modelLabel,
      sandbox: selectedProviderSettings.sandboxLabel,
    },
    approvalOptions: selectedProviderSettings.approvalOptions,
    hasRemoteAuth: hasRelay,
    hasUsableRelay,
    providerOptions: providerOptions(remoteUi.providers),
    models: selectedProviderModels.length
      ? selectedProviderModels
      : [
          {
            display_name: remoteUi.sessionDraft.model || defaultModelForProvider(selectedProvider),
            model: remoteUi.sessionDraft.model || defaultModelForProvider(selectedProvider),
          },
        ],
    // When we have a real catalog the picker is authoritative; otherwise expose
    // the fetch status so the dialog can say "loading"/"failed" instead of
    // presenting the single fallback model as if it were the only choice.
    modelsStatus: selectedProviderModels.length
      ? "ready"
      : remoteUi.providerModelsStatus[selectedProvider] || "loading",
    startPending: remoteUi.sessionStartPending,
    workspaceSuggestions: selectWorkspaceSuggestionsModel({
      session,
      selectedCwd: remoteUi.sessionDraft?.cwd || "",
      threads: currentState.threads,
    }),
  };
  const composerModel = sessionRuntime || {
    composerDisabled: true,
    currentDraft: remoteUi.composerDraft,
    currentEffortValue: remoteUi.composerEffort,
    currentModelValue: remoteUi.composerModel,
    messagePlaceholder: !hasRelay
      ? currentState.relayDirectory?.length
        ? "Open a relay before sending messages."
        : "Pair this browser before sending messages."
      : hasUsableRelay
        ? "Start or resume a remote session first."
        : "Local credentials are unavailable. Pair this relay again in this browser.",
    sendPending: remoteUi.sendPending,
  };
  const transcriptDetailEntries = buildExpandedTranscriptDetailEntries(currentState, {
    expandedItemIds: transcriptUiState.transcriptExpandedItemIds,
    threadId: session?.active_thread_id || null,
    transientDetails: transcriptUiState.transcriptExpandedDetails,
    autoDetailItemIds: collectFileChangeDetailItemIds(session?.transcript),
  });
  const pendingAskUserQuestions = session?.pending_ask_user_questions || [];
  const pendingAskUserSignature = pendingAskUserQuestions
    .map((request) => [
      request?.request_id || "",
      request?.content_hash || "",
      request?.questions_inline_complete === false ? "0" : "1",
      Array.isArray(request?.questions) ? request.questions.length : 0,
    ].join(":"))
    .join("|");
  const mergedPendingAskUserQuestions = mergeAskUserQuestionDetails(
    pendingAskUserQuestions,
    askUserQuestionDetails
  );
  const transcriptEntriesByItemId = new Map(
    (session?.transcript || [])
      .filter((entry) => entry?.item_id)
      .map((entry) => [entry.item_id, entry])
  );
  const runningExpandedItemIds = [...transcriptUiState.transcriptExpandedItemIds]
    .filter((expandKey) => expandKey.startsWith("entry:"))
    .map((expandKey) => expandKey.slice("entry:".length))
    .filter((itemId) => {
      const entry = transcriptEntriesByItemId.get(itemId);
      return (
        entry
        && (entry.kind === "command" || entry.kind === "tool_call")
        && entry.status !== "completed"
      );
    });
  const runningExpandedItemIdsSignature = runningExpandedItemIds.join("|");

  useLayoutEffect(() => {
    if (document.body?.dataset) {
      document.body.dataset.remoteNavOpen = String(
        currentState.remoteNavMode === "drawer" && currentState.remoteNavOpen
      );
    }
  });

  useEffect(() => {
    previousSessionRef.current = session || null;
  }, [session]);

  useEffect(() => {
    dispatchTranscriptUi({
      type: "transcript/reset",
    });
    setAskUserQuestionDetails(new Map());
    setAskUserQuestionDetailLoading(new Set());
    setAskUserQuestionDetailErrors(new Map());
  }, [session?.active_thread_id]);

  useEffect(() => {
    const activeRequestIds = new Set(
      pendingAskUserQuestions
        .map((request) => request?.request_id)
        .filter(Boolean)
    );
    setAskUserQuestionDetails((prev) => filterAskUserDetailMap(prev, activeRequestIds));
    setAskUserQuestionDetailErrors((prev) => filterAskUserDetailMap(prev, activeRequestIds));
    setAskUserQuestionDetailLoading((prev) => filterAskUserDetailSet(prev, activeRequestIds));

    const requestsToLoad = pendingAskUserQuestions.filter((request) => (
      request?.request_id
      && request.questions_inline_complete === false
      && request.detail_available !== false
      && !askUserQuestionDetails.has(request.request_id)
      && !askUserQuestionDetailLoading.has(request.request_id)
    ));
    if (!requestsToLoad.length) {
      return undefined;
    }

    let cancelled = false;
    for (const request of requestsToLoad) {
      const requestId = request.request_id;
      setAskUserQuestionDetailLoading((prev) => {
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });
      handlers.onFetchAskUserQuestionDetail?.(requestId)
        .then((detail) => {
          if (cancelled || !detail?.request_id) return;
          setAskUserQuestionDetails((prev) => {
            const next = new Map(prev);
            next.set(requestId, detail);
            return next;
          });
          setAskUserQuestionDetailErrors((prev) => {
            if (!prev.has(requestId)) return prev;
            const next = new Map(prev);
            next.delete(requestId);
            return next;
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setAskUserQuestionDetailErrors((prev) => {
            const next = new Map(prev);
            next.set(requestId, error?.message || "Failed to load question details.");
            return next;
          });
        })
        .finally(() => {
          if (cancelled) return;
          setAskUserQuestionDetailLoading((prev) => {
            const next = new Set(prev);
            next.delete(requestId);
            return next;
          });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    pendingAskUserSignature,
    askUserQuestionDetails,
    askUserQuestionDetailLoading,
  ]);

  useEffect(() => {
    if (!session?.active_thread_id) {
      return undefined;
    }

    if (!runningExpandedItemIds.length) {
      return undefined;
    }

    let cancelled = false;
    let timerId = null;

    const refreshLiveDetails = async () => {
      for (const itemId of runningExpandedItemIds) {
        if (cancelled || transcriptUiState.transcriptLoadingItemIds.has(itemId)) {
          continue;
        }

        dispatchTranscriptUi({
          type: "transcript/startLoadingDetail",
          itemId,
        });

        try {
          const detail = await fetchRemoteTranscriptEntryDetail(
            session.active_thread_id,
            itemId
          );
          if (!detail || cancelled) {
            continue;
          }

          const { cached } = cacheTranscriptEntryDetail(
            currentState,
            session.active_thread_id,
            detail
          );
          if (!cached) {
            setLiveTranscriptEntryDetail(currentState, session.active_thread_id, detail);
          }
        } finally {
          dispatchTranscriptUi({
            type: "transcript/finishLoadingDetail",
            itemId,
          });
        }
      }

      if (!cancelled) {
        timerId = window.setTimeout(refreshLiveDetails, LIVE_TRANSCRIPT_DETAIL_REFRESH_MS);
      }
    };

    timerId = window.setTimeout(refreshLiveDetails, LIVE_TRANSCRIPT_DETAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    session?.active_thread_id,
    runningExpandedItemIdsSignature,
    transcriptUiState.transcriptLoadingItemIds,
  ]);

  useEffect(() => {
    threadListStore.getState().clearError();
  }, [currentState.remoteAuth?.relayId, currentState.threads, threadListStore]);

  useEffect(() => {
    const availableModels = session?.available_models || [];
    // Only re-validate an *explicitly chosen* composer effort against the
    // current model. Leave an empty (unset) effort alone — turning it into a
    // model default here would re-break the "follow the session" fallback.
    if (remoteUi.composerEffort) {
      const nextComposerEffort = resolveReasoningEffortValue(
        availableModels,
        remoteUi.composerModel || session?.model || "",
        remoteUi.composerEffort
      );
      if (nextComposerEffort !== remoteUi.composerEffort) {
        remoteUiStore.getState().setComposerEffort(nextComposerEffort);
      }
    }

    const nextSessionEffort = resolveReasoningEffortValue(
      availableModels,
      remoteUi.sessionDraft.model,
      remoteUi.sessionDraft.effort
    );
    if (nextSessionEffort !== remoteUi.sessionDraft.effort) {
      remoteUiStore.getState().setSessionDraftField("effort", nextSessionEffort);
    }
  }, [
    remoteUi.composerEffort,
    remoteUi.composerModel,
    remoteUi.sessionDraft.effort,
    remoteUi.sessionDraft.model,
    session?.available_models,
    session?.model,
  ]);

  // Switching to a different session drops any per-surface effort override so
  // the composer/panel/send fall back to the newly-active session's effort.
  useEffect(() => {
    remoteUiStore.getState().setComposerEffort("");
  }, [session?.active_thread_id]);

  useRemoteSessionRuntime({
    remoteAuth: currentState.remoteAuth,
    sendHeartbeat,
    session,
  });

  useEffect(() => {
    notifyRemoteSessionUpdated(session);
  }, [session]);

  // Reviewer-tab actions, bound to the broker-backed remote handlers. `handlers`
  // is rebuilt every render, so we keep the latest in a ref and expose a STABLE
  // action object via useMemo([]). Stability matters: `fetchReviewerTranscript`
  // is a useEffect dependency in ReviewerJobCard, so a fresh identity each render
  // would re-dispatch full transcript fetches on every routine remote render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const reviewerActions = useMemo(
    () => ({
      onRequestReview: (values) => handlersRef.current.onRequestReview?.(values),
      onResolveReview: () => handlersRef.current.onResolveReview?.(),
      onDismissReview: (reviewId) => handlersRef.current.onDismissReview?.(reviewId),
      fetchReviewerTranscript: (threadId) =>
        Promise.resolve(handlersRef.current.onFetchReviewerTranscript?.(threadId)).then(
          (entries) => entries || []
        ),
    }),
    []
  );

  // Push the review slice onto the remote workspace-diff store so the Reviewer
  // tab (rail + modal) and the mobile chip badge stay in sync with the session.
  const remoteDeviceId = currentState.remoteAuth?.deviceId;
  useEffect(() => {
    getRemoteWorkspaceDiffStore().setReview({
      reviewJobs: session?.active_review_jobs || [],
      reviewModel: selectReviewLaunchModel({
        providers: remoteUi.providers,
        providerModels: remoteUi.providerModels,
        session,
      }),
      // Remote snapshots carry only the ACTIVE parent's reviewer_threads (scoped for
      // the broker frame budget), which is exactly what the reuse picker needs.
      reusableReviewers: selectReusableReviewers(
        session?.reviewer_threads,
        session?.active_thread_id,
        null
      ),
      canRequest: canRequestReview(session, remoteDeviceId),
      blocked: isReviewBlocked(session),
    });
  }, [session, remoteUi.providers, remoteUi.providerModels, remoteDeviceId]);

  // Inputs for the composer idle nudge ("Want a second opinion on these
  // changes?"), mirroring the local surface. Plain render-time derivations — not
  // effect deps — so recomputing each render is fine.
  const reviewLaunchModel = selectReviewLaunchModel({
    providers: remoteUi.providers,
    providerModels: remoteUi.providerModels,
    session,
  });
  const canRequestRemoteReview = canRequestReview(session, remoteDeviceId);

  useEffect(() => {
    void bootRemoteRuntime();
    const cleanupSidebarDebug = installSidebarGestureDebug();
    const cleanupThreadsWheel = installThreadListWheelProxy({
      root: document.querySelector(".remote-history-shell"),
      scrollElement: document.querySelector("#remote-threads-list"),
    });
    const cleanupRelaysWheel = installThreadListWheelProxy({
      root: document.querySelector(".remote-relay-shell"),
      scrollElement: document.querySelector("#remote-relays-list"),
    });

    const leftPanelControl = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: "agent-relay:remote-sidebar-width",
      openWidthStorageKey: "agent-relay:remote-sidebar-open-width",
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    const rightPanelControl = createPanelControl({
      cssVarName: "--right-rail-width",
      widthStorageKey: "agent-relay:remote-rail-width",
      openWidthStorageKey: "agent-relay:remote-rail-open-width",
      minOpenWidth: 260,
      maxOpenWidth: 560,
      defaultOpenWidth: 320,
      side: "right",
    });
    const leftResize = leftPanelControl.attachResizeHandle(
      document.getElementById("remote-sidebar-resize")
    );
    const leftToggle = leftPanelControl.attachToggleButton(
      document.getElementById("remote-toggle-left-panel")
    );
    const leftTopToggle = leftPanelControl.attachToggleButton(
      document.getElementById("remote-sidebar-top-toggle")
    );
    const sidebarCollapseSync = leftPanelControl.subscribe(({ isOpen }) => {
      document.body.classList.toggle("sidebar-collapsed", !isOpen);
    });
    const rightResize = rightPanelControl.attachResizeHandle(
      document.getElementById("remote-right-rail-resize")
    );
    const rightToggle = rightPanelControl.attachToggleButton(
      document.getElementById("remote-toggle-right-panel")
    );
    const rightTopToggle = rightPanelControl.attachToggleButton(
      document.getElementById("remote-rail-top-toggle")
    );
    const railCollapseSync = rightPanelControl.subscribe(({ isOpen }) => {
      document.body.classList.toggle("rail-collapsed", !isOpen);
    });

    const headerBandSync = setupHeaderBandSync({
      chatHeader: document.querySelector(".remote-chat-shell > .chat-header"),
    });

    function onKeyDown(event) {
      const isKeyB = event.key === "b" || event.key === "B" || event.code === "KeyB";
      if (!isKeyB) return;
      const metaLike = event.metaKey || event.ctrlKey;
      if (!metaLike || event.shiftKey) return;
      if (event.altKey) {
        event.preventDefault();
        rightPanelControl.toggle();
      } else {
        event.preventDefault();
        leftPanelControl.toggle();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      cleanupSidebarDebug?.();
      cleanupThreadsWheel?.();
      cleanupRelaysWheel?.();
      leftResize?.destroy?.();
      leftToggle?.destroy?.();
      leftTopToggle?.destroy?.();
      sidebarCollapseSync?.();
      rightResize?.destroy?.();
      rightToggle?.destroy?.();
      rightTopToggle?.destroy?.();
      railCollapseSync?.();
      headerBandSync?.destroy?.();
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function runThreadRefresh(reason, { silent = false } = {}) {
    let completed = false;
    if (!silent) {
      threadListStore.getState().startRefresh();
    }

    try {
      await handlers.onRefreshThreads({ reason, silent });
      completed = true;
    } catch (error) {
      if (!silent) {
        threadListStore.getState().failRefresh(error.message);
      }
      throw error;
    } finally {
      if (!silent && completed) {
        threadListStore.getState().finishRefresh();
      }
    }
  }

  async function handleStartSession() {
    remoteUiStore.getState().setSessionStartPending(true);
    // StartSessionDialog auto-closes itself on Start click; no manual close needed here.
    try {
      const started = await handlers.onStartSession(remoteUi.sessionDraft);
      if (started) {
        closeRemoteNavigation();
        remoteUiStore.getState().setSessionPanelOpen(false);
        await runThreadRefresh("post-start refresh", { silent: true });
      }
      return started;
    } finally {
      remoteUiStore.getState().setSessionStartPending(false);
    }
  }

  async function handleResumeThread(threadId) {
    closeRemoteNavigation();
    if (threadId === session?.active_thread_id) {
      return;
    }
    // resume_session is mutating (calls bridge.resume_thread, overwrites runtime).
    // If the target thread is review-locked the backend would reject it. Use the
    // view-only path instead so the user can still navigate to the parent thread
    // (or any other locked thread) while a background review is running.
    if (isReviewInProgressForThread(session, threadId)) {
      await handlers.onViewThread?.(threadId);
      return;
    }
    const resumed = await handlers.onResumeThread(threadId, remoteUi.sessionDraft);
    if (resumed) {
      await runThreadRefresh("post-resume refresh", { silent: true });
    }
  }

  async function handleSendMessage() {
    remoteUiStore.getState().setSendPending(true);
    try {
      const sent = await handlers.onSendMessage(
        remoteUi.composerDraft,
        remoteUi.composerEffort || session?.reasoning_effort || "",
        remoteUi.composerModel || session?.model || ""
      );
      if (sent) {
        remoteUiStore.getState().clearComposerDraft();
      }
      return sent;
    } finally {
      remoteUiStore.getState().setSendPending(false);
    }
  }

  async function handleStopTurn() {
    return handlers.onStopTurn();
  }

  async function handleTranscriptToggle(itemId) {
    if (!itemId || !session?.active_thread_id) {
      return;
    }

    const expandKey = `entry:${itemId}`;
    const cachedDetail = getCachedTranscriptEntryDetail(
      currentState,
      session.active_thread_id,
      itemId
    );
    const liveDetail = getLiveTranscriptEntryDetail(
      currentState,
      session.active_thread_id,
      itemId
    );
    const isExpanded = transcriptUiState.transcriptExpandedItemIds.has(expandKey);

    if (isExpanded) {
      dispatchTranscriptUi({
        type: "transcript/collapse",
        dropTransient: !cachedDetail && !liveDetail,
        itemId: expandKey,
      });
      return;
    }

    dispatchTranscriptUi({
      type: "transcript/expand",
      itemId: expandKey,
    });
    if (cachedDetail || liveDetail || transcriptUiState.transcriptExpandedDetails.has(itemId)) {
      return;
    }

    dispatchTranscriptUi({
      type: "transcript/startLoadingDetail",
      itemId,
    });

    try {
      const detail = await fetchRemoteTranscriptEntryDetail(
        session.active_thread_id,
        itemId
      );
      if (!detail) {
        return;
      }

      const { cached } = cacheTranscriptEntryDetail(
        currentState,
        session.active_thread_id,
        detail
      );
      if (!cached) {
        setLiveTranscriptEntryDetail(currentState, session.active_thread_id, detail);
      }
      dispatchTranscriptUi({
        type: "transcript/setExpandedDetail",
        detail: null,
        itemId,
      });
    } finally {
      dispatchTranscriptUi({
        type: "transcript/finishLoadingDetail",
        itemId,
      });
    }
  }

  // File-change entries render diffs inline and have no expand control, so when
  // the snapshot only carries the file-change summary (file_changes_omitted) the
  // shared renderer calls this to pull the full diffs on demand. Idempotent:
  // skips when the detail is already cached/live or a fetch is in flight.
  async function ensureFileChangeDetail(itemId) {
    if (!itemId || !session?.active_thread_id) {
      return;
    }
    const threadId = session.active_thread_id;
    // Skip only when we already hold the FULL detail — a stripped summary parked
    // in the live store (running turnDiff) must not block the fetch.
    const cached = getCachedTranscriptEntryDetail(currentState, threadId, itemId);
    const live = getLiveTranscriptEntryDetail(currentState, threadId, itemId);
    const hasFullDetail =
      (cached && !isOmittedFileChangeDetail(cached))
      || (live && !isOmittedFileChangeDetail(live));
    if (hasFullDetail || transcriptUiState.transcriptLoadingItemIds.has(itemId)) {
      return;
    }

    dispatchTranscriptUi({ type: "transcript/startLoadingDetail", itemId });
    try {
      const detail = await fetchRemoteTranscriptEntryDetail(threadId, itemId);
      if (!detail || session?.active_thread_id !== threadId) {
        return;
      }
      const { cached } = cacheTranscriptEntryDetail(currentState, threadId, detail);
      if (!cached) {
        setLiveTranscriptEntryDetail(currentState, threadId, detail);
      }
    } catch (error) {
      // The shared renderer fires this without awaiting, so swallow the
      // rejection here to avoid an unhandled promise rejection; the entry stays
      // on its "Loading diff…" summary until a new load edge (such as remounting
      // the entry) tries again.
      console.warn(`[file-change] diff load failed for ${itemId}:`, error);
    } finally {
      dispatchTranscriptUi({ type: "transcript/finishLoadingDetail", itemId });
    }
  }

  function handleExpandableBlockToggle(expandKey) {
    if (!expandKey) {
      return;
    }

    const isExpanded = transcriptUiState.transcriptExpandedItemIds.has(expandKey);
    dispatchTranscriptUi({
      type: isExpanded ? "transcript/collapse" : "transcript/expand",
      dropTransient: false,
      itemId: expandKey,
    });
  }

  async function handleBeginPairing(rawValue) {
    const started = await handlers.onBeginPairing(rawValue, remoteUi.deviceLabelDraft);
    if (started) {
      remoteUiStore.getState().setPairingModalOpen(false);
      remoteUiStore.getState().resetPairingInput();
    }
    return started;
  }

  return h(
    React.Fragment,
    null,
    h(
      "div",
      {
        className: "app-shell app-shell-with-rail remote-app-shell",
        "data-remote-nav-mode": currentState.remoteNavMode,
        "data-remote-nav-state": currentState.remoteNavOpen ? "open" : "closed",
        "data-view": "conversation",
      },
      h(RemoteSidebar, {
        currentState,
        hasRelay,
        hasUsableRelay,
        onOpenInfo() {
          closeRemoteNavigation();
          remoteUiStore.getState().setRemoteInfoModalOpen(true);
        },
        onOpenPairing() {
          remoteUiStore.getState().setPairingModalOpen(true);
        },
        onRefreshRelayDirectory() {
          void handlers.onRefreshRelayDirectory();
        },
        onRefreshThreads() {
          void runThreadRefresh("manual refresh");
        },
        onResumeThread: handleResumeThread,
        onSelectRelay(relayId) {
          closeRemoteNavigation();
          void handlers.onSelectRelay(relayId);
        },
        onStartSession() {
          void handleStartSession();
        },
        onToggleGroup(cwd) {
          threadListStore.getState().toggleCollapsedGroup(cwd);
        },
        onToggleExpandedGroup(cwd) {
          threadListStore.getState().toggleExpandedGroup(cwd);
        },
        relayDirectoryModel,
        remoteUiState: remoteUi,
        session,
        sessionPanelModel,
        sessionPanelOpen: remoteUi.sessionPanelOpen,
        sessionToggleLabel,
        threadListUi,
        threadsModel,
        updateSessionDraft(nextPatch) {
          for (const [field, value] of Object.entries(nextPatch)) {
            remoteUiStore.getState().setSessionDraftField(field, value);
          }
        },
        setSessionPanelOpenLocal(open) {
          remoteUiStore.getState().setSessionPanelOpen(open);
        },
      }),
      h("div", {
        className: "remote-nav-backdrop",
        hidden: currentState.remoteNavMode !== "drawer",
        "aria-hidden": String(!currentState.remoteNavOpen),
        id: "remote-nav-backdrop",
        onClick: () => {
          closeRemoteNavigation();
        },
      }),
      h(
        "main",
        {
          className: "chat-shell remote-chat-shell",
          "data-view": "conversation",
        },
        h(RemoteHeader, {
          currentState,
          deviceChromeModel,
          headerModel,
          onOpenInfo() {
            remoteUiStore.getState().setRemoteInfoModalOpen(true);
          },
          onReturnHome() {
            void handlers.onReturnHome();
          },
          onToggleNavigation() {
            toggleRemoteNavigation();
          },
          onOpenStartSession() {
            remoteUiStore.getState().setSessionPanelOpen(true);
          },
          statusBadgeModel,
        }),
        h(RemoteThreadPanel, {
          agentWorkingIndicatorModel,
          composerModel,
          composerDraft: remoteUi.composerDraft,
          composerEffort: remoteUi.composerEffort,
          onComposerDraftChange(value) {
            remoteUiStore.getState().setComposerDraft(value);
          },
          onComposerEffortChange(value) {
            remoteUiStore.getState().setComposerEffort(value);
            if (session?.provider) saveLastEffort(session.provider, value);
          },
          onComposerModelChange(value) {
            const nextEffort = resolveReasoningEffortValue(
              session?.available_models || [],
              value,
              remoteUi.composerEffort
            );
            remoteUiStore.getState().setComposerModel(value);
            remoteUiStore.getState().setComposerEffort(nextEffort);
            if (session?.provider) saveLastEffort(session.provider, nextEffort);
            void handlers.onUpdateSessionSettings?.({ model: value, effort: nextEffort });
          },
          controlBannerModel,
          currentState,
          emptyStateModel,
          onSelectRelay(relayId) {
            closeRemoteNavigation();
            void handlers.onSelectRelay(relayId);
          },
          onSendMessage() {
            void handleSendMessage();
          },
          onStopTurn() {
            void handleStopTurn();
          },
          onToggleExpandableBlock: handleExpandableBlockToggle,
          onToggleTranscriptItem: handleTranscriptToggle,
          onEnsureFileChangeDetail: ensureFileChangeDetail,
          onSubmitDecision(decision, scope) {
            void handlers.onSubmitDecision(decision, scope);
          },
          onSubmitAskUserAnswers(requestId, answers) {
            void handlers.onSubmitAskUserAnswers?.(requestId, answers);
          },
          onApplyFileChange(itemId, direction) {
            void handlers.onApplyFileChange?.(itemId, direction);
          },
          onTakeOver() {
            void handlers.onTakeOver();
          },
          onUpdateSessionSettings(payload) {
            const provider = session?.provider;
            if (provider && payload) {
              if (payload.approval_policy) saveLastApprovalPolicy(provider, payload.approval_policy);
              if (payload.effort) saveLastEffort(provider, payload.effort);
            }
            return handlers.onUpdateSessionSettings?.(payload);
          },
          reviewNudgeModel: {
            canRequest: canRequestRemoteReview,
            reviewModel: reviewLaunchModel,
            onRequestReview: reviewerActions.onRequestReview,
          },
          session,
          sessionView,
          transcriptDetailEntries,
          pendingAskUserQuestions: mergedPendingAskUserQuestions,
          askUserDetailLoadingRequestIds: askUserQuestionDetailLoading,
          askUserDetailErrors: askUserQuestionDetailErrors,
          uiState: transcriptUiState,
        }),
        h(RemoteClientLogDrawer, {
          lines: currentState.clientLogs,
        })
      ),
      h(RemoteWorkspaceChangesRail, { reviewer: reviewerActions })
    ),
    h(RemoteWorkspaceDiffModal, { reviewer: reviewerActions }),
    h(PairingModal, {
      deviceChromeModel,
      deviceLabel: remoteUi.deviceLabelDraft,
      pairingInputValue: remoteUi.pairingInputValue,
      pairingModalOpen: remoteUi.pairingModalOpen,
      onBeginPairing(rawValue) {
        void handleBeginPairing(rawValue);
      },
      onClose() {
        remoteUiStore.getState().setPairingModalOpen(false);
      },
      onDeviceLabelChange(value) {
        remoteUiStore.getState().setDeviceLabelDraft(value);
      },
      onForgetDevice() {
        handlers.onForgetDevice();
      },
      onPairingInputChange(value) {
        remoteUiStore.getState().setPairingInputValue(value);
      },
    }),
    h(RemoteInfoModal, {
      open: remoteUi.remoteInfoModalOpen,
      onClose() {
        remoteUiStore.getState().setRemoteInfoModalOpen(false);
      },
      sessionMetaModel,
      sessionPath: headerModel.sessionPath || "No workspace path yet.",
    })
  );
}

function RemoteSidebar({
  currentState,
  hasRelay,
  hasUsableRelay,
  onOpenInfo,
  onOpenPairing,
  onRefreshRelayDirectory,
  onRefreshThreads,
  remoteUiState,
  onResumeThread,
  onSelectRelay,
  onStartSession,
  onToggleExpandedGroup,
  onToggleGroup,
  relayDirectoryModel,
  session,
  sessionPanelModel,
  sessionPanelOpen,
  sessionToggleLabel,
  threadListUi,
  threadsModel,
  updateSessionDraft,
  setSessionPanelOpenLocal,
}) {
  const usesDrawer = currentState.remoteNavMode === "drawer";
  const navOpen = currentState.remoteNavMode !== "drawer" || currentState.remoteNavOpen;

  return h(
    "aside",
    {
      "aria-hidden": String(!navOpen),
      className: "sidebar",
    },
    h(
      "div",
      { className: "sidebar-top-bar" },
      h(
        "button",
        {
          "aria-label": "Hide navigation panel",
          className: "header-button header-panel-toggle sidebar-top-toggle",
          id: "remote-sidebar-top-toggle",
          title: "Hide navigation panel (⌘B)",
          type: "button",
        },
        h(RemoteToggleLeftPanelIcon)
      )
    ),
    h(
      "div",
      { className: "sidebar-row" },
      h("p", { className: "sidebar-caption" }, "Device Pairing"),
      h(
        "button",
        {
          className: "sidebar-link-button",
          id: "open-pairing-modal",
          onClick: onOpenPairing,
          type: "button",
        },
        "Manage"
      )
    ),
    h(
      "button",
      {
        className: "start-session-button",
        disabled: !hasUsableRelay,
        id: "remote-session-toggle",
        onClick: () => document.getElementById("remote-start-session-dialog")?.showModal(),
        type: "button",
      },
      "New session"
    ),
    h(
      "section",
      { className: "remote-access-shell remote-relay-shell" },
      h(
        "div",
        { className: "sidebar-row" },
        h("p", { className: "sidebar-caption", id: "remote-relays-count" }, relayDirectoryModel.countLabel),
        h(RefreshButton, {
          id: "remote-relays-refresh-button",
          label: "Refresh relays",
          onClick: onRefreshRelayDirectory,
        })
      ),
      h(
        "div",
        { className: "conversation-list", id: "remote-relays-list" },
        h(RelayDirectoryList, { onSelectRelay, viewModel: relayDirectoryModel })
      )
    ),
    h(SessionPanel, {
        model: sessionPanelModel,
        onFieldChange(field, value) {
          const uiState = remoteUiState;
          if (field === "provider") {
            const models = uiState.providerModels[value] || [];
            const model = models.find((option) => option.is_default)?.model
              || models[0]?.model
              || defaultModelForProvider(value);
            const storedEffort = loadLastEffort(value);
            const storedApproval = loadLastApprovalPolicy(value);
            const patch = {
              effort: resolveReasoningEffortValue(
                models,
                model,
                storedEffort || uiState.sessionDraft.effort
              ),
              model,
              provider: value,
            };
            if (storedApproval) patch.approvalPolicy = storedApproval;
            updateSessionDraft(patch);
            return;
          }
          if (field === "model") {
            const selectedModels = uiState.providerModels[uiState.sessionDraft.provider] || [];
            updateSessionDraft({
              effort: resolveReasoningEffortValue(
                selectedModels,
                value,
                uiState.sessionDraft.effort
              ),
              model: value,
            });
            return;
          }

          const provider = uiState.sessionDraft.provider;
          if (provider && field === "effort") saveLastEffort(provider, value);
          if (provider && field === "approvalPolicy") saveLastApprovalPolicy(provider, value);
          updateSessionDraft({ [field]: value });
        },
        onStartSession,
      })
    ,
    h(
      "section",
      { className: "remote-access-shell remote-history-shell" },
      h(
        "div",
        { className: "sidebar-row" },
        h("p", { className: "sidebar-caption", id: "remote-threads-count" }, threadsModel.countLabel),
        h(RefreshButton, {
          id: "remote-threads-refresh-button",
          label: "Refresh threads",
          disabled: threadsModel.loading || !hasUsableRelay,
          onClick: () => onRefreshThreads(),
        })
      ),
      h(
        "div",
        { className: "conversation-list", id: "remote-threads-list" },
        h(ThreadGroupList, {
          activeThreadId: threadsModel.activeThreadId,
          collapsedGroupCwds: threadListUi?.collapsedGroupCwds || new Set(),
          collapsible: true,
          emptyMessage: threadsModel.emptyMessage,
          expandedGroupCwds: threadListUi?.expandedGroupCwds || new Set(),
          formatThreadMeta(thread) {
            return formatRelativeTime(thread.updated_at);
          },
          groups: threadsModel.groups || [],
          includePreview: true,
          onResumeThread,
          onToggleExpandedGroup,
          onToggleGroup,
          threadActivity: buildThreadActivityMap(session),
        })
      )
    ),
    h(
      "div",
      { className: "sidebar-bottom-bar" },
      h(ThemePickerRow)
    ),
    h("div", {
      className: "sidebar-resize",
      id: "remote-sidebar-resize",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize navigation panel",
      tabIndex: 0,
    })
  );
}

function RemoteToggleLeftPanelIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16", stroke: "currentColor", strokeWidth: "1.4" },
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "6", y1: "2.5", x2: "6", y2: "13.5" })
  );
}

function RemoteToggleRightPanelIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16", stroke: "currentColor", strokeWidth: "1.4" },
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "10", y1: "2.5", x2: "10", y2: "13.5" })
  );
}

function RemoteComposeIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "16",
      viewBox: "0 0 16 16",
      width: "16",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M2.5 13.5h4l6.5-6.5a1.8 1.8 0 0 0-2.5-2.5L4 11v2.5z" }),
    h("path", { d: "M10 5.5l2 2" })
  );
}

function RemoteBackArrowIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M10 3.5L5.5 8L10 12.5" })
  );
}

function RemoteHeader({
  currentState,
  deviceChromeModel,
  headerModel,
  onOpenInfo,
  onOpenStartSession,
  onReturnHome,
  onToggleNavigation,
  statusBadgeModel,
}) {
  const usesDrawer = currentState.remoteNavMode === "drawer";
  const navOpen = currentState.remoteNavOpen;
  const navLabel = navOpen ? "Close sidebar" : "Open sidebar";

  return h(
    "header",
    { className: "chat-header" },
    h(
      "div",
      { className: "chat-header-main" },
      h(
        "button",
        {
          "aria-expanded": String(navOpen),
          "aria-label": navLabel,
          className: "header-button remote-nav-toggle-button",
          "data-nav-state": navOpen ? "open" : "closed",
          hidden: !usesDrawer,
          id: "remote-nav-toggle-button",
          onClick: onToggleNavigation,
          title: navLabel,
          type: "button",
        },
        h(
          "span",
          { className: "remote-nav-toggle-icon", "aria-hidden": "true" },
          h("span", null),
          h("span", null),
          h("span", null)
        ),
        h("span", { className: "sr-only" }, "Toggle sidebar")
      ),
      h(
        "div",
        { className: "chat-header-collapsed-actions" },
        h(
          "button",
          {
            "aria-label": "Show navigation panel",
            className: "header-button header-panel-toggle header-panel-toggle-left",
            id: "remote-toggle-left-panel",
            title: "Show navigation panel (⌘B)",
            type: "button",
          },
          h(RemoteToggleLeftPanelIcon)
        ),
        h(
          "button",
          {
            "aria-label": "Start new session",
            className: "header-button header-compose-button",
            id: "remote-new-session-compose-button",
            type: "button",
            title: "Start new session",
            onClick: onOpenStartSession,
          },
          h(RemoteComposeIcon)
        )
      ),
      h(
        "button",
        {
          className: "header-icon-button chat-heading-back-button",
          hidden: deviceChromeModel.homeButton.hidden,
          id: "remote-home-button",
          onClick: onReturnHome,
          title: "All relays",
          "aria-label": "All relays",
          type: "button",
        },
        h(RemoteBackArrowIcon)
      ),
      h(
        "div",
        { className: "chat-heading", id: "remote-chat-heading" },
        h(WorkspaceHeading, {
          header: headerModel,
          statusBadge: statusBadgeModel,
          onOpenInfo,
        })
      )
    ),
    h(
      "div",
      { className: "chat-header-actions" },
      h(
        "button",
        {
          "aria-label": "Toggle side panel",
          className: "header-button header-panel-toggle header-panel-toggle-right",
          id: "remote-toggle-right-panel",
          title: "Toggle side panel (⌥⌘B)",
          type: "button",
        },
        h(RemoteToggleRightPanelIcon)
      )
    )
  );
}

function RemoteThreadPanel({
  agentWorkingIndicatorModel,
  composerModel,
  composerDraft,
  composerEffort,
  controlBannerModel,
  currentState,
  emptyStateModel,
  onApplyFileChange,
  onComposerDraftChange,
  onComposerEffortChange,
  onComposerModelChange,
  onSelectRelay,
  onSendMessage,
  onStopTurn,
  onToggleExpandableBlock,
  onToggleTranscriptItem,
  onEnsureFileChangeDetail,
  onSubmitDecision,
  onSubmitAskUserAnswers,
  onTakeOver,
  onUpdateSessionSettings,
  pendingAskUserQuestions,
  reviewNudgeModel,
  session,
  sessionView,
  transcriptDetailEntries,
  askUserDetailErrors,
  askUserDetailLoadingRequestIds,
  uiState,
}) {
  return h(
    "section",
    { className: "remote-thread-panel" },
    h(
      "section",
      { className: "thread-shell" },
      h(RemoteTranscriptPanel, {
        currentState,
        emptyStateModel,
        onApplyFileChange,
        onSelectRelay,
        onToggleExpandableBlock,
        onToggleTranscriptItem,
        onEnsureFileChangeDetail,
        onSubmitDecision,
        onSubmitAskUserAnswers,
        pendingAskUserQuestions,
        session,
        transcriptDetailEntries,
        askUserDetailErrors,
        askUserDetailLoadingRequestIds,
        uiState,
        sessionView,
      })
    ),
    h(AgentWorkingIndicator, { model: agentWorkingIndicatorModel }),
    h(
      "div",
      { className: "workspace-diff-chip-host" },
      h(
        "div",
        { className: "workspace-diff-chip-slot" },
        h(RemoteWorkspaceDiffChip, {
          onTap: () => {
            triggerRemoteWorkspaceDiffRefresh();
            const dialog = document.getElementById("remote-workspace-diff-modal");
            dialog?.showModal?.();
          },
        })
      ),
      h(
        "div",
        { className: "workspace-diff-chip-slot" },
        h(RemoteReviewerChip, {
          onTap: () => {
            // Open the panel straight on the Reviewer tab.
            getRemoteWorkspaceDiffStore().setActiveTab("reviewer");
            triggerRemoteWorkspaceDiffRefresh();
            const dialog = document.getElementById("remote-workspace-diff-modal");
            dialog?.showModal?.();
          },
        })
      )
    ),
    h(
      "section",
      {
        className: "control-banner control-banner-compact",
        hidden: controlBannerModel.hidden,
        id: "remote-control-banner",
      },
      h(ControlBanner, {
        model: controlBannerModel,
        onTakeOver,
      })
    ),
    reviewNudgeModel?.canRequest
      ? h(
          "div",
          { className: "review-idle-nudge", id: "remote-review-idle-nudge" },
          h(
            "div",
            { className: "review-idle-nudge-inner" },
            h(
              "span",
              { className: "review-idle-nudge-copy" },
              "Want a second opinion on these changes?"
            ),
            h(ReviewLauncher, {
              panelId: "review-panel-remote-nudge",
              label: "Request review",
              providerOptions: reviewNudgeModel.reviewModel?.providerOptions || [],
              models: reviewNudgeModel.reviewModel?.models || [],
              defaultProvider: reviewNudgeModel.reviewModel?.defaultProvider || "",
              disabled: false,
              onSubmit: (values) => reviewNudgeModel.onRequestReview?.(values),
            })
          )
        )
      : null,
    h(
      "form",
      {
        className: "composer-shell",
        id: "remote-message-form",
        onSubmit: (event) => {
          event.preventDefault();
          onSendMessage();
        },
      },
      h(Composer, {
        ...composerModel,
        actionsBeforeSend: session?.active_thread_id
          ? h(SessionSettingsButton, {
              session,
              buttonId: "remote-session-settings-button",
              composerEffort,
              onChangeEffort: (value) => {
                onComposerEffortChange?.(value);
                void onUpdateSessionSettings?.({ effort: value });
              },
              onUpdate: (payload) => {
                void onUpdateSessionSettings?.(payload);
              },
            })
          : null,
        onDraftChange(value) {
          onComposerDraftChange?.(value);
        },
        onEffortChange(value) {
          onComposerEffortChange?.(value);
        },
        onModelChange(value) {
          onComposerModelChange?.(value);
        },
        onStop() {
          onStopTurn?.();
        },
        stopButtonId: "remote-stop-button",
      })
    )
  );
}

function RemoteTranscriptPanel({
  currentState,
  emptyStateModel,
  onApplyFileChange,
  onSelectRelay,
  onToggleExpandableBlock,
  onSubmitDecision,
  onSubmitAskUserAnswers,
  onToggleTranscriptItem,
  onEnsureFileChangeDetail,
  pendingAskUserQuestions,
  session,
  sessionView,
  transcriptDetailEntries,
  askUserDetailErrors,
  askUserDetailLoadingRequestIds,
  uiState,
}) {
  const relayNicknames = useRelayNicknames();
  const transcriptRef = useRef(null);
  const previousRenderRef = useRef({
    activeThreadId: null,
    entries: [],
  });
  const anchoredUserIdsRef = useRef(new Map()); // threadId -> Set<userId>

  const approval = sessionView?.approval || null;
  const entries = session?.transcript || [];
  const hydrationLoading = Boolean(
    session?.transcript_truncated
      && currentState.transcriptHydrationBaseSnapshot
      && currentState.transcriptHydrationThreadId === session.active_thread_id
      && currentState.transcriptHydrationStatus === "loading"
  );

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    setRemoteTranscriptElement(transcript);
    if (!transcript) {
      previousRenderRef.current = {
        activeThreadId: session?.active_thread_id || null,
        entries,
      };
      return;
    }

    const previous = previousRenderRef.current;
    const remoteThreadId = session?.active_thread_id || null;
    // Reset anchored set when the active thread changes; otherwise carry it
    // forward so already-anchored user messages don't re-trigger anchor-user
    // on intermediate snapshots (mid-hydration, transient subset renders).
    if (previous?.activeThreadId && previous.activeThreadId !== remoteThreadId) {
      anchoredUserIdsRef.current.delete(previous.activeThreadId);
    }
    const anchorsForThread =
      anchoredUserIdsRef.current.get(remoteThreadId) || new Set();
    const action = restoreTranscriptScrollPosition({
      alreadyAnchoredUserIds: anchorsForThread,
      nextEntries: entries,
      nextThreadId: remoteThreadId,
      previousSnapshot: previous,
      scrollElement: transcript,
    });
    if (action?.kind === "anchor-user" && action.userEntryId) {
      anchorsForThread.add(action.userEntryId);
      anchoredUserIdsRef.current.set(remoteThreadId, anchorsForThread);
    }

    previousRenderRef.current = captureTranscriptScrollSnapshot({
      entries,
      scrollElement: transcript,
      threadId: remoteThreadId,
    });
    return () => {
      setRemoteTranscriptElement(null);
    };
  });

  let body = null;

  if (!session?.active_thread_id) {
    if (emptyStateModel.showServerDisconnected) {
      body = h(ConversationEmptyState, {
        copy: emptyStateModel.serverDisconnectedCopy,
        title: "Server disconnected",
      });
    } else if (emptyStateModel.showRelayHome) {
      body = h(RelayHomeState, {
        clientAuth: emptyStateModel.clientAuth,
        nicknames: relayNicknames,
        onRenameRelay: saveRelayNickname,
        onSelectRelay,
        relayDirectory: emptyStateModel.relayDirectory,
      });
    } else if (emptyStateModel.showMissingCredentials) {
      body = h(MissingCredentialsState, {
        remoteAuth: emptyStateModel.remoteAuth,
      });
    } else {
      body = h(ConversationEmptyState, {
        copy: "After pairing, this page will stream the live relay transcript through the broker.",
        title: "No remote session yet",
      });
    }
  } else {
    body = h(TranscriptPane, {
      approval,
      canWrite: sessionView.canWrite,
      emptyContent: null,
      entries,
      hydrationLoading,
      readyState: {
        readyCopy: "The remote session is live. Send the first prompt below when you're ready.",
        session,
        shortId,
        waitingCopy: "This thread is already open, but another device currently has control. You can still approve or decline requests here; take over only if you want to send messages from this device.",
      },
      transcriptOptions: {
        currentCwd: session?.current_cwd || "",
        detailEntries: transcriptDetailEntries,
        enableFileChangeActions: true,
        expandedItemIds: uiState.transcriptExpandedItemIds,
        expandedKeys: uiState.transcriptExpandedItemIds,
        loadingItemIds: uiState.transcriptLoadingItemIds,
        onEnsureFileChangeDetail,
        pendingAskUserQuestions,
        onSubmitAskUserAnswers: (requestId, answers) => {
          void onSubmitAskUserAnswers?.(requestId, answers);
        },
        askUserSubmittingRequestId: uiState.askUserSubmittingRequestId || "",
        askUserErrors: uiState.askUserErrors instanceof Map ? uiState.askUserErrors : new Map(),
        askUserDetailErrors: askUserDetailErrors instanceof Map ? askUserDetailErrors : new Map(),
        askUserDetailLoadingRequestIds:
          askUserDetailLoadingRequestIds instanceof Set
            ? askUserDetailLoadingRequestIds
            : new Set(),
      },
      onTranscriptInteract: (event) => {
        const copyButton = event.target.closest?.("[data-copy-message]");
        if (copyButton) {
          event.preventDefault();
          void copyTextToClipboard(copyButton.dataset.copyMessage || "", copyButton);
          return;
        }

        const fileChangeButton = event.target.closest?.("[data-file-change-action]");
        if (fileChangeButton) {
          event.preventDefault();
          const action = fileChangeButton.dataset.fileChangeAction;
          const itemId = fileChangeButton.dataset.itemId || "";
          if (itemId && (action === "rollback" || action === "reapply")) {
            void onApplyFileChange?.(itemId, action);
          }
          return;
        }

        const approvalButton = event.target.closest?.("[data-approval-decision]");
        if (!approvalButton) {
          const expandSummary = event.target.closest?.("[data-expand-key]");
          if (expandSummary) {
            event.preventDefault();
            onToggleExpandableBlock?.(expandSummary.dataset.expandKey || "");
            return;
          }
          const toggleButton = event.target.closest?.("[data-transcript-toggle]");
          if (!toggleButton) {
            return;
          }
          void onToggleTranscriptItem?.(toggleButton.dataset.itemId || "");
          return;
        }

        onSubmitDecision(
          approvalButton.dataset.approvalDecision,
          approvalButton.dataset.approvalScope || "once"
        );
      },
    });
  }

  // IntersectionObserver-driven prefetch (mirrors app.js for the local
  // surface). The transcript scroll container is owned by this component, so
  // we can scope the loader's lifetime to the effect rather than the page.
  const historyLoaderRef = useRef(null);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return undefined;
    }
    const loader = attachTranscriptHistoryLoader({
      onLoad: () => maybeLoadOlderTranscriptHistory(),
      scrollElement: transcript,
    });
    historyLoaderRef.current = loader;
    loader.sync();
    return () => {
      historyLoaderRef.current = null;
      loader.detach();
    };
  }, []);

  // The sentinel can be replaced when the TranscriptContent branch swaps
  // (entries ↔ empty ↔ ready). Re-sync after every render so the observer
  // stays attached to whichever sentinel is currently live.
  useLayoutEffect(() => {
    historyLoaderRef.current?.sync();
  });

  return h(
    "div",
    {
      className: "chat-thread",
      id: "remote-transcript",
      ref: transcriptRef,
    },
    body
  );
}

function BuildInfoLine({ surface = "remote" }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    fetchBuildInfo(surface).then(setInfo);
  }, [surface]);

  if (!info) {
    return null;
  }

  return h(
    "p",
    { className: "build-info-inline", title: info.title },
    info.label
  );
}

function PairingModal({
  deviceChromeModel,
  deviceLabel,
  onBeginPairing,
  onClose,
  onDeviceLabelChange,
  onForgetDevice,
  onPairingInputChange,
  pairingInputValue,
  pairingModalOpen,
}) {
  return h(
    ManagedDialog,
    {
      className: "security-modal",
      id: "pairing-modal",
      open: pairingModalOpen,
      onRequestClose: onClose,
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Remote Surface"),
      h(
        "button",
        {
          className: "header-button close-modal-btn",
          id: "close-pairing-modal",
          onClick: onClose,
          type: "button",
        },
        "\u00d7"
      )
    ),
    h(
      "section",
      { className: "remote-access-shell remote-surface-shell" },
      h(
        "form",
        {
          className: "workspace-form",
          id: "pairing-form",
          onSubmit: (event) => {
            event.preventDefault();
            onBeginPairing(pairingInputValue);
          },
        },
        h(
          "label",
          { className: "sidebar-label", htmlFor: "pairing-input" },
          "Pairing Link Or Code"
        ),
        h("textarea", {
          id: "pairing-input",
          onChange: (event) => onPairingInputChange?.(event.target.value),
          placeholder: "Paste the full pairing URL, or only the pairing payload.",
          readOnly: deviceChromeModel.pairingControls.pairingInputReadOnly,
          rows: 4,
          value: pairingInputValue,
        }),
        h(
          "label",
          { className: "sidebar-label", htmlFor: "device-label-input" },
          "Device Label"
        ),
        h(
          "div",
          { className: "workspace-picker" },
          h("input", {
            id: "device-label-input",
            onChange: (event) => onDeviceLabelChange?.(event.target.value),
            placeholder: "iPhone, Pixel, Safari on iPad",
            type: "text",
            value: deviceLabel,
          }),
          h(
            "button",
            {
              className: "load-button",
              disabled: deviceChromeModel.pairingControls.connectDisabled,
              id: "connect-button",
              type: "submit",
            },
            deviceChromeModel.pairingControls.connectLabel
          )
        )
      ),
      h(
        "div",
        { className: "sidebar-row" },
        h("p", { className: "sidebar-caption" }, "Current Device"),
        h(
          "button",
          {
            className: "sidebar-link-button",
            id: "forget-device-button",
            onClick: onForgetDevice,
            type: "button",
          },
          "Forget"
        )
      ),
      h(
        "div",
        { className: "paired-devices-list", id: "device-meta" },
        h(DeviceMetaPanel, { model: deviceChromeModel.deviceMeta })
      ),
      h(BuildInfoLine, { surface: "remote" })
    )
  );
}

function RemoteInfoModal({
  onClose,
  open,
  sessionMetaModel,
  sessionPath,
}) {
  return h(
    ManagedDialog,
    {
      className: "panel-modal",
      id: "remote-info-modal",
      open,
      onRequestClose: onClose,
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Session details"),
      h(
        "button",
        {
          className: "header-button close-modal-btn",
          id: "close-remote-info-modal",
          onClick: onClose,
          type: "button",
        },
        "\u00d7"
      )
    ),
    h(
      "div",
      { className: "panel-modal-body" },
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Workspace"),
        h("p", { className: "details-path", id: "remote-session-path" }, sessionPath)
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Session"),
        h(
          "section",
          { className: "session-meta", id: "remote-session-meta" },
          h(SessionMetaPanel, { model: sessionMetaModel })
        )
      )
    )
  );
}

function ManagedDialog({
  children,
  className,
  id,
  onRequestClose,
  open,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }

    if (dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    const handleCancel = (event) => {
      event.preventDefault();
      onRequestClose?.();
    };

    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, [onRequestClose]);

  return h(
    "dialog",
    {
      className,
      id,
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          onRequestClose?.();
        }
      },
      ref: dialogRef,
    },
    children
  );
}

function RemoteClientLogDrawer({ lines }) {
  return h(
    "details",
    { className: "log-drawer" },
    h("summary", null, "Remote log"),
    h(ClientLog, {
      id: "remote-client-log",
      lines,
    })
  );
}
