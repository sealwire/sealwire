import React, {
  useEffect,
  useLayoutEffect,
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
import { ThemePickerRow } from "../shared/theme-picker.js";
import { selectWorkspaceSuggestionsModel } from "../shared/workspace-suggestions.js";
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
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  setLiveTranscriptEntryDetail,
} from "./transcript/details.js";
import {
  captureTranscriptScrollSnapshot,
  restoreTranscriptScrollPosition,
} from "./transcript-scroll.js";
import { useRemoteSessionRuntime } from "./use-remote-session-runtime.js";
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
  ConversationEmptyState,
} from "../shared/conversation.js";
import { SessionSettingsButton } from "../shared/session-settings-panel.js";
import { attachTranscriptHistoryLoader } from "../shared/transcript-history-loader.js";
import { ThreadGroupList } from "../shared/thread-list-react.js";
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
  const [remoteUiStore] = useState(() => createRemoteUiStore());
  const remoteUi = useRemoteUiStoreState(remoteUiStore);
  const [threadListStore] = useState(() => createThreadListStore());
  const threadListUi = useThreadListStoreState(threadListStore);
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
        // Pre-fetch models for all providers so the dropdown is populated immediately
        for (const provider of normalized) {
          handlers.onFetchProviderModels?.(provider)
            .then((models) => {
              if (!cancelled) remoteUiStore.getState().setProviderModels(provider, models || []);
            })
            .catch(() => {});
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
    handlers.onFetchProviderModels?.(selectedProvider)
      .then((models) => {
        if (cancelled) return;
        remoteUiStore.getState().setProviderModels(selectedProvider, models || []);
        const draft = remoteUiStore.getState().sessionDraft;
        if (draft.provider === selectedProvider && (!draft.model || draft.model === defaultModelForProvider(selectedProvider))) {
          const nextModel = models?.find((model) => model.is_default)?.model
            || models?.[0]?.model
            || defaultModelForProvider(selectedProvider);
          remoteUiStore.getState().setSessionDraftField("model", nextModel);
          remoteUiStore.getState().setSessionDraftField(
            "effort",
            resolveReasoningEffortValue(models || [], nextModel, draft.effort)
          );
          return;
        }
        remoteUiStore.getState().setSessionDraftField(
          "effort",
          resolveReasoningEffortValue(
            models || [],
            draft.model || defaultModelForProvider(selectedProvider),
            draft.effort
          )
        );
      })
      .catch(() => {});
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
    ? selectSessionChromeRenderModel(currentState, session)
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
  });
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
  }, [session?.active_thread_id]);

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
    const nextComposerEffort = resolveReasoningEffortValue(
      availableModels,
      remoteUi.composerModel || session?.model || "",
      remoteUi.composerEffort
    );
    if (nextComposerEffort !== remoteUi.composerEffort) {
      remoteUiStore.getState().setComposerEffort(nextComposerEffort);
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

  useRemoteSessionRuntime({
    remoteAuth: currentState.remoteAuth,
    sendHeartbeat,
    session,
  });

  useEffect(() => {
    void bootRemoteRuntime();
    const cleanupSidebarDebug = installSidebarGestureDebug();
    return () => {
      cleanupSidebarDebug?.();
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
        remoteUi.composerEffort,
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
        className: "app-shell remote-app-shell",
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
          headerOverflowOpen: remoteUi.headerOverflowOpen,
          onCloseOverflow() {
            remoteUiStore.getState().closeHeaderOverflow();
          },
          onOpenInfo() {
            remoteUiStore.getState().closeHeaderOverflow();
            remoteUiStore.getState().setRemoteInfoModalOpen(true);
          },
          onReturnHome() {
            void handlers.onReturnHome();
          },
          onToggleNavigation() {
            toggleRemoteNavigation();
          },
          onToggleOverflow() {
            remoteUiStore.getState().toggleHeaderOverflow();
          },
          statusBadgeModel,
        }),
        h(RemoteThreadPanel, {
          composerModel,
          composerDraft: remoteUi.composerDraft,
          composerEffort: remoteUi.composerEffort,
          onComposerDraftChange(value) {
            remoteUiStore.getState().setComposerDraft(value);
          },
          onComposerEffortChange(value) {
            remoteUiStore.getState().setComposerEffort(value);
          },
          onComposerModelChange(value) {
            const nextEffort = resolveReasoningEffortValue(
              session?.available_models || [],
              value,
              remoteUi.composerEffort
            );
            remoteUiStore.getState().setComposerModel(value);
            remoteUiStore.getState().setComposerEffort(nextEffort);
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
          onSubmitDecision(decision, scope) {
            void handlers.onSubmitDecision(decision, scope);
          },
          onTakeOver() {
            void handlers.onTakeOver();
          },
          onUpdateSessionSettings(payload) {
            return handlers.onUpdateSessionSettings?.(payload);
          },
          session,
          sessionView,
          transcriptDetailEntries,
          uiState: transcriptUiState,
        }),
        h(RemoteClientLogDrawer, {
          lines: currentState.clientLogs,
        })
      )
    ),
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
            updateSessionDraft({
              effort: resolveReasoningEffortValue(models, model, uiState.sessionDraft.effort),
              model,
              provider: value,
            });
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
        })
      )
    ),
    usesDrawer
      ? h(
          "section",
          { className: "sidebar-footer remote-sidebar-actions" },
          h(
            "button",
            {
              className: "sidebar-link-button",
              id: "remote-sidebar-open-session-details",
              onClick: onOpenInfo,
              type: "button",
            },
            "Session details"
          ),
          h(ThemePickerRow)
        )
      : null
  );
}

function RemoteHeaderOverflowIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16" },
    h("circle", { cx: "3", cy: "8", fill: "currentColor", r: "1.5" }),
    h("circle", { cx: "8", cy: "8", fill: "currentColor", r: "1.5" }),
    h("circle", { cx: "13", cy: "8", fill: "currentColor", r: "1.5" })
  );
}

function RemoteHeader({
  currentState,
  deviceChromeModel,
  headerModel,
  headerOverflowOpen,
  onCloseOverflow,
  onOpenInfo,
  onReturnHome,
  onToggleNavigation,
  onToggleOverflow,
  statusBadgeModel,
}) {
  const usesDrawer = currentState.remoteNavMode === "drawer";
  const navOpen = currentState.remoteNavOpen;
  const navLabel = navOpen ? "Close sidebar" : "Open sidebar";
  const overflowWrapRef = useRef(null);

  useEffect(() => {
    if (usesDrawer && headerOverflowOpen) onCloseOverflow?.();
  }, [usesDrawer, headerOverflowOpen, onCloseOverflow]);

  useEffect(() => {
    if (!headerOverflowOpen) return undefined;
    function handlePointerDown(event) {
      if (overflowWrapRef.current?.contains(event.target)) return;
      onCloseOverflow?.();
    }
    function handleKey(event) {
      if (event.key === "Escape") onCloseOverflow?.();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [headerOverflowOpen, onCloseOverflow]);

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
        { className: "chat-heading", id: "remote-chat-heading" },
        h(WorkspaceHeading, {
          header: headerModel,
          statusBadge: statusBadgeModel,
        })
      )
    ),
    h(
      "div",
      { className: "chat-header-actions" },
      h(
        "button",
        {
          className: "header-button",
          hidden: deviceChromeModel.homeButton.hidden,
          id: "remote-home-button",
          onClick: onReturnHome,
          type: "button",
        },
        "All relays"
      ),
      h(
        "div",
        { className: "header-overflow-wrap", hidden: usesDrawer, ref: overflowWrapRef },
        h(
          "button",
          {
            "aria-expanded": String(Boolean(headerOverflowOpen)),
            "aria-haspopup": "menu",
            "aria-label": "More options",
            className: "header-button header-overflow-button",
            id: "remote-header-overflow-button",
            onClick: onToggleOverflow,
            title: "More options",
            type: "button",
          },
          h(RemoteHeaderOverflowIcon)
        ),
        h(
          "div",
          {
            className: "header-overflow-menu",
            hidden: !headerOverflowOpen,
            id: "remote-header-overflow-menu",
            role: "menu",
          },
          h(
            "button",
            {
              className: "overflow-menu-item",
              id: "remote-open-session-details",
              onClick: onOpenInfo,
              role: "menuitem",
              type: "button",
            },
            "Session details"
          ),
          h(ThemePickerRow)
        )
      )
    )
  );
}

function RemoteThreadPanel({
  composerModel,
  composerDraft,
  composerEffort,
  controlBannerModel,
  currentState,
  emptyStateModel,
  onComposerDraftChange,
  onComposerEffortChange,
  onComposerModelChange,
  onSelectRelay,
  onSendMessage,
  onStopTurn,
  onToggleExpandableBlock,
  onToggleTranscriptItem,
  onSubmitDecision,
  onTakeOver,
  onUpdateSessionSettings,
  session,
  sessionView,
  transcriptDetailEntries,
  uiState,
}) {
  return h(
    "section",
    { className: "remote-thread-panel" },
    h(
      "section",
      {
        className: "control-banner",
        hidden: controlBannerModel.hidden,
        id: "remote-control-banner",
      },
      h(ControlBanner, {
        model: controlBannerModel,
        onTakeOver,
      })
    ),
    h(
      "section",
      { className: "thread-shell" },
      h(RemoteTranscriptPanel, {
        currentState,
        emptyStateModel,
        onSelectRelay,
        onToggleExpandableBlock,
        onToggleTranscriptItem,
        onSubmitDecision,
        session,
        transcriptDetailEntries,
        uiState,
        sessionView,
      })
    ),
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
  onSelectRelay,
  onToggleExpandableBlock,
  onSubmitDecision,
  onToggleTranscriptItem,
  session,
  sessionView,
  transcriptDetailEntries,
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
        expandedItemIds: uiState.transcriptExpandedItemIds,
        expandedKeys: uiState.transcriptExpandedItemIds,
        loadingItemIds: uiState.transcriptLoadingItemIds,
      },
      onTranscriptInteract: (event) => {
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
