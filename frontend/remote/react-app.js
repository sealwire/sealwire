import React, {
  useCallback,
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
import { createTranscriptInteractionHandler } from "../shared/transcript-interactions.js";
import { StartSessionSplitButton } from "../shared/start-session-split-button.js";
import { ConversationHeader } from "../shared/conversation-header.js";
import { ClientLog } from "../shared/client-log.js";
import { createAskUserQuestionDetailLoader } from "../shared/ask-user-question-detail-loader.js";
import { stableTranscriptOptions } from "../shared/transcript-options-identity.js";
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
  providerOptions,
  providerSettings,
} from "../shared/provider-settings.js";
import { RefreshButton } from "../shared/refresh-button.js";
import { ForkSessionDialog } from "../shared/fork-session-dialog.js";
import {
  applyForkProviderChange,
  canForkInSession,
  defaultForkFields,
  forkPointIsTranscriptTip,
  resolveForkSourceThread,
  threadIsBusyForFork,
} from "../shared/fork-fields.js";
import { copyTextToClipboard } from "../shared/clipboard.js";
import { installThreadListWheelProxy } from "../shared/thread-list-scroll.js";
import { selectWorkspaceSuggestionsModel } from "../shared/workspace-suggestions.js";
import { createProjectAndSelect } from "../shared/project-create.js";
import { createVerbCycler } from "../progress-verbs.js";
import {
  buildProviderStatusModel,
  selectDeviceChromeRenderModel,
  selectResetChromeRenderModel,
  selectSessionChromeRenderModel,
  selectStatusBadgeRenderModel,
  selectedRelayNeedsRepair,
} from "./chrome-view-model.js";
import { selectRemoteHeaderProjectSwitcherModel } from "./header-project-switcher-model.js";
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
  visiblePendingAskUserQuestions,
} from "./view-model.js";
import {
  bootRemoteRuntime,
  createRemoteAppHandlers,
  initializeRemoteSurface,
  installSidebarGestureDebug,
} from "./remote-runtime.js";
import { getRemoteServiceWorkerRegistration } from "./pwa.js";
import {
  ensurePushSubscription,
  hasActiveSubscription,
} from "./push-subscribe.js";
import { remoteNotificationsHint, shouldAutoSubscribe } from "./notifications-view.js";
import {
  fetchTranscriptEntryDetail as fetchRemoteTranscriptEntryDetail,
  fetchRemoteReviews,
  fetchRemoteWorkflows,
  maybeLoadOlderTranscriptHistory,
  sendHeartbeat,
  queueRemoteThreadSearch,
  searchRemoteThreads,
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
  ensureModelPickerCatalogs,
  ensureProviderModels,
  ensureProviders,
  fetchModelsWithRetry,
} from "./provider-model-fetch.js";
import { useRemoteSessionRuntime } from "./use-remote-session-runtime.js";
import { useRemoteTranscriptScrollBookkeeping } from "./use-transcript-scroll-bookkeeping.js";
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
  buildReviewingThreadSet,
  canRequestReview,
  isReviewBlocked,
  isReviewInProgressForThread,
  selectReviewLaunchModel,
} from "../shared/review-state.js";
// BELL_SVG / SEARCH_SVG / X_SVG left with the controls that used them — they are drawn by
// `shared/sidebar-chrome.js` now, on both surfaces.
import { SETTINGS_SVG } from "../svg.js";
import { selectThreadState } from "../shared/thread-dot.js";
import {
  composeListChrome,
  nextRetainedStates,
  selectThreadFilterView,
} from "../shared/thread-filter.js";
import {
  findVisibleThread,
  isThreadSearchActive,
  selectThreadListView,
} from "../shared/thread-search.js";
import {
  canStartWorkflow,
  isWorkflowBlocked,
  selectWorkflowLaunchModel,
  workflowRunsForThread,
} from "../shared/workflow-state.js";
import { ReviewLauncher } from "../shared/review-panel.js";
import {
  createReviewsCache,
  reviewCardsForViewedThread,
  reusableReviewersFromReviews,
} from "../shared/reviews-cache.js";
import { createWorkflowsCache } from "../shared/workflows-cache.js";
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
import { attachProjectSummaries } from "../shared/project-overview-model.js";
import { threadAttention } from "../shared/thread-attention.js";
import {
  configureThreadNotifications,
  ensureNotificationPermission,
  isDocumentForeground,
  notificationPermission,
} from "../shared/thread-notify.js";

// Stable refs for useSyncExternalStore so the thread list re-renders on
// out-of-band attention changes (clear-on-open, tab refocus) — not just on
// session snapshots.
const subscribeThreadAttention = (listener) => threadAttention.subscribe(listener);
const getThreadAttentionVersion = () => threadAttention.getVersion();
import {
  createThreadListStore,
  readActiveProjectId,
  readSearchUi,
  readThreadFilter,
} from "../shared/thread-list-store.js";
import { ProjectSwitcher } from "../shared/project-switcher.js";
import {
  SidebarBellToggle,
  SidebarBrand,
  SidebarCollapseToggle,
  SidebarResizeHandle,
  SidebarSearchField,
  SidebarSearchToggle,
} from "../shared/sidebar-chrome.js";
// The `Remote`-prefixed copies of these were byte-for-byte identical to local's.
import {
  BackArrowIcon,
  ComposeIcon,
  ProjectTagIcon,
  ToggleLeftPanelIcon,
  ToggleRightPanelIcon,
} from "../shared/panel-icons.js";
import { resetRelayScopedState } from "./relay-scoped-state.js";
import { selectPinnedProjectId } from "../shared/thread-groups.js";
import {
  useRemoteProjects,
  notifyRemoteProjects,
  refreshRemoteProjects,
  getRemoteProjectsStore,
} from "./projects-host.js";
import {
  assignRemoteThreadToProject,
  createRemoteProject,
  fetchRemoteProjects,
  fetchRemoteThreadSettings,
  fetchRemoteWorkspaceGitContext,
  renameRemoteProject,
  renameRemoteThread,
  deleteRemoteProject,
  unassignRemoteThread,
} from "./project-actions.js";
import {
  normalizeThreadName,
  threadCustomName,
  threadNameDraft,
} from "../shared/thread-rename.js";
import { normalizeProjectName, projectsMenuReady } from "../shared/project-menu.js";
import { selectThreadSheet } from "../shared/thread-actions-model.js";
import { runThreadSheetAction } from "./thread-sheet-action.js";
import { ManagedDialog } from "../shared/managed-dialog.js";
import { RemoteSettingsModal } from "./settings-modal.js";
import { TranscriptPane } from "../shared/transcript-pane.js";
import { renderLog } from "./session-surface.js";
import { formatRelativeTime, formatTimestamp, shortId } from "./utils.js";
import { SessionTabStrip, buildSessionTabItems } from "../shared/session-tab-strip.js";
import { layoutThreadIds } from "../shared/tab-layout.js";
import { sessionViewContextKey } from "../shared/session-view-state.js";
import { BOOT_RESTORE_REASON, useRemoteSessionTabs } from "./session-tabs-host.js";

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

// activeProjectId lives as a SIBLING field of `threadList`, so useThreadListStoreState
// (which snapshots only `threadList`) never re-renders when it changes. Snapshot the id
// directly so picking a project in the switcher updates the list immediately. The value
// is a stable string-or-null between changes, so this only re-renders on a real
// selection — returning a fresh object here would spin useSyncExternalStore forever.
function useActiveProjectId(store) {
  return useSyncExternalStore(
    store.subscribe,
    () => readActiveProjectId(store),
    () => readActiveProjectId(store)
  );
}

// The bell, also a SIBLING of `threadList`, so it needs its own snapshot for the same
// reason `activeProjectId` does. `readThreadFilter` returns the stored object rather than
// a normalized copy precisely so this stays identity-stable between changes.
function useThreadFilter(store) {
  return useSyncExternalStore(
    store.subscribe,
    () => readThreadFilter(store),
    () => readThreadFilter(store)
  );
}

// The search field's open/draft state, snapshotted for the same reason: it is a sibling of
// `threadList`, so `useThreadListStoreState` never sees it change.
function useSearchUi(store) {
  return useSyncExternalStore(
    store.subscribe,
    () => readSearchUi(store),
    () => readSearchUi(store)
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
  // A binding, not just a sidebar prop: the create-project callback below calls it
  // directly, and as a prop-only method that was a ReferenceError.
  const updateSessionDraft = useCallback(
    (nextPatch) => {
      for (const [field, value] of Object.entries(nextPatch)) {
        remoteUiStore.getState().setSessionDraftField(field, value);
      }
    },
    [remoteUiStore]
  );
  const [threadListStore] = useState(() => createThreadListStore());
  const threadListUi = useThreadListStoreState(threadListStore);
  // Dedicated Projects payload (list + membership), fetched off the snapshot's
  // projects_revision via the `fetch_projects` broker action. Re-renders the sidebar
  // as it loads/errors.
  const remoteProjects = useRemoteProjects();
  const activeProjectId = useActiveProjectId(threadListStore);
  const threadFilter = useThreadFilter(threadListStore);
  // Which session the actions sheet is open for (null = closed). Held by id, not by
  // object, so the sheet keeps tracking the thread across list refreshes.
  const [actionsSheetThreadId, setActionsSheetThreadId] = useState(null);
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

  // On-demand loader for truncated ("long") AskUserQuestion detail. Imperative and
  // re-sync-safe: re-rendering never cancels an in-flight fetch (the previous inline
  // effect listed the state it mutated in its deps, so it re-triggered itself and its
  // cleanup discarded the in-flight fetch, leaving the UI stuck on "Loading question
  // detail" until a manual refresh — see ../shared/ask-user-question-detail-loader.js).
  // It owns details/loading/errors and mirrors them into React state via onChange.
  const askUserDetailFetchRef = useRef(null);
  askUserDetailFetchRef.current = handlers?.onFetchAskUserQuestionDetail;
  // NOTE: lazy-init in render + dispose() on unmount is NOT StrictMode-safe. The
  // remote root renders without StrictMode (see the createRoot call below), so a
  // real unmount destroys this ref and a remount recreates the loader. If
  // StrictMode is ever adopted, its mount→unmount→remount double-invoke runs the
  // dispose cleanup but does NOT re-run this render body, leaving a permanently
  // disposed loader (sync/reset become no-ops). The fix then is to create the
  // loader inside a mount useEffect and dispose in its cleanup (not a guard here —
  // the render body doesn't re-run between the two effect setups).
  const askUserDetailLoaderRef = useRef(null);
  if (!askUserDetailLoaderRef.current) {
    askUserDetailLoaderRef.current = createAskUserQuestionDetailLoader({
      fetchDetail: (requestId) => {
        const fetchDetail = askUserDetailFetchRef.current;
        return fetchDetail ? fetchDetail(requestId) : Promise.resolve(null);
      },
      onChange: (next) => {
        setAskUserQuestionDetails(next.details);
        setAskUserQuestionDetailLoading(next.loading);
        setAskUserQuestionDetailErrors(next.errors);
      },
    });
  }

  const selectedProvider = remoteUi.sessionDraft.provider || defaultProvider(remoteUi.providers);
  const selectedProviderModels = remoteUi.providerModels[selectedProvider] || [];
  const selectedProviderSettings = providerSettings(selectedProvider);

  // Fetch one provider's model catalog on demand (retry + status), reusing the
  // same path as the boot pre-fetch. The review dialog calls this when its
  // cross-agent reviewer provider's catalog is missing — that provider's models
  // never ride the session snapshot, so without an on-demand fetch the picker
  // would stay empty for the whole session.
  const ensureRemoteProviderModels = React.useCallback(
    (provider) =>
      ensureProviderModels(remoteUiStore, provider, (p) => handlers.onFetchProviderModels?.(p)),
    [handlers]
  );

  // Keyed on the socket too: the payload secret is a local IndexedDB read, so this
  // fires while the broker socket is still connecting and every dispatch throws.
  // Nothing is stored on failure, so the connect re-runs it and it heals itself.
  useEffect(() => {
    if (!currentState.remoteAuth?.payloadSecret) return undefined;
    if (remoteUiStore.getState().providers.length) return undefined;
    let cancelled = false;
    void (async () => {
      const normalized = await ensureProviders(remoteUiStore, () =>
        handlers.onFetchProviders?.()
      );
      if (cancelled || !normalized.length) return;
      const draftProvider = remoteUiStore.getState().sessionDraft.provider;
      if (!draftProvider || !normalized.includes(draftProvider)) {
        // The MODEL must move with the provider: `provider` alone left a
        // `codex/gpt-5.5` draft as `claude_code/gpt-5.5` on a Claude-only relay.
        remoteUiStore
          .getState()
          .patchSessionDraft(
            providerDraftPatch(remoteUiStore.getState(), defaultProvider(normalized))
          );
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
    })();
    return () => {
      cancelled = true;
    };
  }, [
    currentState.remoteAuth?.relayId,
    currentState.remoteAuth?.payloadSecret,
    currentState.socketConnected,
  ]);

  // Debounced and generation-guarded: the field is free text, so a probe per
  // keystroke would spawn a git subprocess per character on the HOST.
  const launchCwd = remoteUi.sessionDraft?.cwd || "";
  useEffect(() => {
    if (!currentState.remoteAuth?.payloadSecret) return undefined;
    const target = String(launchCwd || "").trim();
    // Clear first: a stale chip is worse than no chip, and the effect re-runs on
    // every cwd change so this is the only place that sees the transition.
    remoteUiStore.getState().setLaunchGitContext(null);
    if (!target) {
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchRemoteWorkspaceGitContext(target)
        .then((context) => {
          if (!cancelled) remoteUiStore.getState().setLaunchGitContext(context);
        })
        // A failed probe is not worth surfacing: the chip is an extra and the
        // dialog is fully usable without it.
        .catch(() => {
          if (!cancelled) remoteUiStore.getState().setLaunchGitContext(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [launchCwd, currentState.remoteAuth?.payloadSecret]);

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
    if (!remoteUi.forkDialog?.open) return;
    const dialog = document.getElementById("remote-fork-session-dialog");
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [remoteUi.forkDialog?.open]);

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
        composerErrors: currentState.composerErrors,
        composerModel: remoteUi.composerModel,
        fallbackModels: remoteUi.providerModels[session.provider] || [],
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
    // Both the bell and a search cut ACROSS the pin, exactly as on local. The policy
    // for when a pin stands down is `selectPinnedProjectId` rather than a condition
    // written out here, because the plausible reading — "the bell just narrows rows,
    // so a pinned group survives it" — is wrong: `buildThreadStateGroups` REPLACES
    // the group structure with state buckets. A search is a different failure again;
    // it swaps the row source for a server-side slice, so there is nothing coherent
    // to lift out of.
    pinnedProjectId: selectPinnedProjectId({
      activeProjectId,
      filtering: Boolean(threadFilter.on),
      searching: isThreadSearchActive(currentState.threadSearch),
    }),
    projects: remoteProjects.projects,
    threadProjectId: remoteProjects.threadProjectId,
  });
  // Whether the Projects payload is fresh enough to expose mutation controls
  // (mirrors the local fail-closed rule for the toolbar + header actions).
  const remoteProjectsReady = projectsMenuReady({
    projectsLoaded: remoteProjects.loaded,
    projectsError: remoteProjects.error,
    projectsLoading: remoteProjects.loading,
  });
  const promptRemoteProjectName = (current = "") =>
    normalizeProjectName(window.prompt("Project name", current));
  // Straight through the session-view controller, exactly as local's switcher does: each
  // context owns its own workspace and its own remembered focus, so selecting a project
  // has to MOVE the location or the strip would describe a workspace nobody is in. The
  // sidebar's pinned id is then written back from the committed context by the projection
  // effect below, which keeps one source of truth instead of two.
  const setActiveProject = (projectId) => {
    void sessionTabsHost.selectProject(projectId);
  };
  const setThreadFilter = (next) => threadListStore.getState().setThreadFilter(next);
  const setThreadFilterRetained = (retained) =>
    threadListStore.getState().setThreadFilterRetained(retained);

  // Every thread the user can currently SEE: the authoritative list plus anything a
  // search surfaced from beyond it. LOOKUPS only — iteration stays on
  // `currentState.threads`, or search results would leak into the resting view.
  const findVisible = (threadId) =>
    findVisibleThread(
      { threads: currentState.threads, search: currentState.threadSearch },
      threadId
    );

  // The session tab set, keyed by the selected project exactly as local keys its own.
  // The host owns the store/controller lifecycle per relay; see session-tabs-host.js.
  const { host: sessionTabsHost, viewState: sessionTabsView } = useRemoteSessionTabs(
    currentState.remoteAuth?.relayId || null
  );
  // Membership, held in a ref: it is an INPUT to filing a tab, not a trigger for it.
  const threadProjectIdRef = useRef(null);
  threadProjectIdRef.current = remoteProjects.threadProjectId || null;
  // The RELAY's live thread, read from realSession rather than the rendered projection —
  // the projection rewrites active_thread_id to whatever is pinned, so reading it here
  // would make "fall back to the live thread" mean "fall back to the one just closed".
  const liveThreadIdRef = useRef(null);
  liveThreadIdRef.current = currentState.realSession?.active_thread_id || null;
  // The canonical answer to "which tab set is on screen", exactly as on local: the
  // LOCATION owns it, and the sidebar's pinned project is a projection of it (see the
  // onCommit hook in the host wiring below). Deriving it the other way — from the pin —
  // files sessions into whichever project happens to be selected, which is the bug
  // `selectOwningContext` was written to fix.
  const sessionTabsContext = sessionTabsView.location.context;

  // Whether the field is open, and what has been typed into it, both live in
  // `threadListStore` — the same place local reads them from. They were a pair of
  // `useState` hooks here and DOM properties over there, which is two definitions of one
  // control's state.
  //
  // The field is controlled by that DRAFT, never by the executed query. Binding it to
  // `threadSearch.query` — which only advances after the debounce fires — makes React
  // restore the previous value after every keystroke, so typing a word char by char
  // ends up searching for its last letter. `page.fill()` sets the value in one shot and
  // hides this completely; only real key-by-key input shows it.
  const searchUi = useSearchUi(threadListStore);
  const searchOpen = searchUi.open;
  const searchDraft = searchUi.draft;
  // The DEBOUNCE is not held here. A timer owned by the component is invisible to the
  // surface reset, so a keystroke typed just before a re-pair would fire against
  // whatever connection replaced the one it was typed into. `session-ops` owns it, next
  // to the request it triggers, and cancels both together.
  const onSearchInput = (value) => {
    threadListStore.getState().setSearchDraft(value);
    queueRemoteThreadSearch(value);
  };
  const onSetSearchOpen = (open) => {
    // "Closing also clears the draft" is enforced by the store, so what is left here is
    // the half that is remote's: telling the relay the query is gone.
    threadListStore.getState().setSearchOpen(open);
    if (!open) {
      queueRemoteThreadSearch("");
    }
  };

  // Every teardown path — relay switch, re-pair, forget device — cancels the search
  // through the reset transaction and bumps this token. `setSearchOpen(false)` clears the
  // draft with it, which is the whole reset.
  const searchCancelToken = currentState.threadSearchCancelToken || 0;
  useEffect(() => {
    threadListStore.getState().setSearchOpen(false);
  }, [searchCancelToken, threadListStore]);

  // Retention is keyed by thread id alone, and thread ids are only unique WITHIN a
  // relay. Switching relays would otherwise let one relay's remembered states decide
  // which of another's sessions the bell shows. The surface reset already forgets
  // fetched Projects for the same reason (surface-state.js: "A different relay may
  // advertise an equal projects_revision"); this is that hazard for the filter.
  const activeRelayId = currentState.remoteAuth?.relayId || null;
  useEffect(() => {
    resetRelayScopedState({ threadListStore });
  }, [activeRelayId, threadListStore]);
  // Refresh rides the projects_revision snapshot bump, but the broker drops the write
  // receipt, so also refetch eagerly for snappier remote feedback.
  // Must SELECT it, not just refresh the list.
  const createRemoteProjectForDraft = async (apply, isCurrent) => {
    const name = promptRemoteProjectName();
    if (!name) return;
    try {
      const projectId = await createProjectAndSelect({
        apply,
        create: createRemoteProject,
        isCurrent,
        name,
        store: getRemoteProjectsStore(),
      });
      renderLog(
        projectId
          ? `Created project "${name}".`
          : `Created project "${name}", but could not tell which one is new — pick it manually.`
      );
    } catch (error) {
      renderLog(`Failed to create project: ${error.message}`);
    }
  };

  const createRemoteProjectFromToolbar = async () => {
    const name = promptRemoteProjectName();
    if (!name) return;
    try {
      await createRemoteProject(name);
      refreshRemoteProjects();
      renderLog(`Created project "${name}".`);
    } catch (error) {
      renderLog(`Failed to create project: ${error.message}`);
    }
  };
  const handleRenameRemoteProject = async (projectId, currentName) => {
    const name = promptRemoteProjectName(currentName || "");
    if (!name || name === currentName) return;
    try {
      await renameRemoteProject(projectId, name);
      refreshRemoteProjects();
      renderLog(`Renamed project to "${name}".`);
    } catch (error) {
      renderLog(`Failed to rename project: ${error.message}`);
    }
  };
  const handleDeleteRemoteProject = async (projectId, name) => {
    const confirmed = window.confirm(
      `Delete project "${name}"?\n\nIts sessions become Unassigned — the sessions themselves are not deleted.`
    );
    if (!confirmed) return;
    try {
      await deleteRemoteProject(projectId);
      // Move the LOCATION out of the dead project, before the refetch. Writing the
      // sidebar pin here instead would desync the two: the pin is a projection of the
      // context and its effect is edge-triggered ON the context, so clearing the pin
      // directly leaves the strip rendering — and every close/pin/move aiming at — a
      // workspace whose project no longer exists.
      await sessionTabsHost.forgetProject(projectId);
      refreshRemoteProjects();
      renderLog(`Deleted project "${name}".`);
    } catch (error) {
      renderLog(`Failed to delete project: ${error.message}`);
    }
  };
  const hasRelay = Boolean(currentState.remoteAuth);
  const hasUsableRelay = Boolean(
    currentState.remoteAuth?.payloadSecret && !selectedRelayNeedsRepair(currentState)
  );
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
    // The merged pill lists EVERY provider's catalogue, not one flattened array.
    gitContext: remoteUi.launchGitContext,
    providers: remoteUi.providers,
    providerModels: remoteUi.providerModels,
    // Still needed by the sidebar split button's agent menu, which starts a
    // session AS a provider without opening the dialog.
    providerOptions: providerOptions(remoteUi.providers),
    // Set on the draft, not derived here, so an in-dialog choice survives a render.
    projects: remoteProjects.projects,
    threads: currentState.threads,
    threadProjectId: remoteProjects.threadProjectId,
    onCreateProject: remoteProjectsReady
      ? () => {
          const opening = remoteUi.launchDialogGeneration;
          return createRemoteProjectForDraft(
            (projectId) => updateSessionDraft({ projectId }),
            () =>
              remoteUiStore.getState().launchDialogGeneration === opening
              && document.getElementById("remote-start-session-dialog")?.open === true
          );
        }
      : null,
    // When we have a real catalog the picker is authoritative; otherwise expose
    // the fetch status so the dialog can say "loading"/"failed" instead of
    // presenting the single fallback model as if it were the only choice.
    modelsStatus: selectedProviderModels.length
      ? "ready"
      : remoteUi.providerModelsStatus[selectedProvider] || "loading",
    onOpenModelPicker() {
      void ensureModelPickerCatalogs(
        remoteUiStore,
        (provider) => handlers.onFetchProviderModels?.(provider),
        { fetchProviders: () => handlers.onFetchProviders?.() }
      );
    },
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
        ? "Start or open a remote session first."
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
    askUserDetailLoaderRef.current?.reset();
  }, [session?.active_thread_id]);

  // Drive detail loading from the pending set. Re-sync only when the pending
  // signature actually changes; the loader is idempotent and prunes by request id,
  // and (unlike the old effect) never cancels an in-flight fetch on re-render.
  useEffect(() => {
    const requestIds = pendingAskUserQuestions
      .filter((request) => (
        request?.request_id
        && request.questions_inline_complete === false
        && request.detail_available !== false
      ))
      .map((request) => request.request_id);
    askUserDetailLoaderRef.current?.sync(requestIds);
  }, [pendingAskUserSignature]);

  useEffect(() => () => askUserDetailLoaderRef.current?.dispose(), []);

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

  // Switching to a different session drops any per-surface effort/model override
  // so the composer/panel/send fall back to the newly-active session's values.
  // Without the model reset, a model picked on a Codex thread (e.g. gpt-5.5)
  // stays selected after switching to a Claude thread, where it isn't even a
  // valid option — buildModelOptions then pins it atop the Claude catalog.
  useEffect(() => {
    remoteUiStore.getState().setComposerEffort("");
    remoteUiStore.getState().setComposerModel("");
  }, [session?.active_thread_id]);

  useRemoteSessionRuntime({
    realSession: currentState.realSession,
    remoteAuth: currentState.remoteAuth,
    sendHeartbeat,
    session,
  });

  useEffect(() => {
    notifyRemoteSessionUpdated(session);
    notifyRemoteProjects(session);
  }, [session]);

  // Session titles ride the separately-fetched thread list, not the snapshot, so a
  // rename made anywhere else (desktop tab strip, another phone) is invisible here
  // until the list is re-asked for. `threads_revision` is that signal — the remote
  // analog of the same hook in app.js.
  //
  // The first observation only SEEDS the baseline: the initial list fetch already
  // carries the current titles, so refetching there would be pure duplication. Silent,
  // because nobody asked for a refresh — the list must not flash a spinner.
  const lastThreadsRevisionRef = useRef(null);
  const threadsRevision = session?.threads_revision || 0;
  useEffect(() => {
    const seeding = lastThreadsRevisionRef.current === null;
    if (lastThreadsRevisionRef.current === threadsRevision) {
      return;
    }
    lastThreadsRevisionRef.current = threadsRevision;
    if (seeding) {
      return;
    }
    void runThreadRefresh("session renamed", { silent: true, fresh: true }).catch(() => {});
  }, [threadsRevision]);

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
      onStartWorkflow: (values) => handlersRef.current.onStartWorkflow?.(values),
      onResolveReview: (reviewJobId) =>
        handlersRef.current.onResolveReview?.(reviewJobId),
      onResolveWorkflow: (workflowRunId) =>
        handlersRef.current.onResolveWorkflow?.(workflowRunId),
      onDeleteReview: (reviewId) => handlersRef.current.onDeleteReview?.(reviewId),
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
  const remoteViewedThreadId = session?.active_thread_id || null;
  // Subscribe so a pin in Changes re-filters the Reviewer picker in the same frame.
  const remoteWorkspace = useSyncExternalStore(
    useCallback((onChange) => getRemoteWorkspaceDiffStore().subscribe(onChange), []),
    () => getRemoteWorkspaceDiffStore().getState().workspace,
    () => getRemoteWorkspaceDiffStore().getState().workspace
  );
  const remoteWorkspaceCwd = remoteWorkspace?.cwd || null;


  // The two halves of keeping the strip honest. They are separate because the causes
  // are: one is the user steering, the other is the world moving underneath.
  //
  // 1. Controller -> screen. A committed location change performs the view.
  //
  // A CLOSE that lands on no thread (it emptied the workspace) still has to put something
  // on screen: remote always shows a conversation, so it falls back to the relay's live
  // thread, which re-opens a tab for it. Skipping instead would leave the just-closed
  // session rendered under a strip claiming nothing is open.
  //
  // Scoped to CLOSE_TAB, and that scope is load-bearing. A context SWITCH also lands on
  // no thread whenever the project you picked has no tabs yet — and falling back there
  // would immediately re-file the live thread into ITS owning context, yanking you back
  // out of the project you just selected. That reads as "the project switcher does
  // nothing", which is how it was found.
  //
  // Two consequences worth knowing, both accepted rather than overlooked:
  //
  //   - Closing the LIVE thread's only tab re-creates it, so the × looks inert there.
  //     It is the strip refusing to lie: that conversation is still on screen, and remote
  //     has no home screen to close it in favour of.
  //   - Selecting an empty project leaves the previous conversation under an empty strip.
  //     Local expresses this state as the sessions-home overview; remote has no such
  //     screen, so this is the least-bad of the available shapes rather than a good one.
  useEffect(
    () =>
      sessionTabsHost.controller.subscribe((change) => {
        if (!change.locationChanged) return;
        const threadId = change.next.location.threadId;
        if (threadId) {
          const viewed = handlersRef.current.onViewThread?.(threadId);
          // Repair for the ONE navigation nobody asked for: the boot restore.
          //
          // It routes to a session the surface has not fetched yet, so it can fail — the
          // broker may still be settling. Left alone, that leaves the location naming a
          // thread the screen is not showing, and the strip highlighting it. Clicking that
          // tab then does nothing at all: the location already IS that thread, so the
          // command commits no change and never re-fires this subscriber. Falling back to
          // the live thread costs the restore and returns a surface that works.
          //
          // Scoped to the restore, and that scope is the point. A project selection that
          // failed the same way must NOT fall back — it would drag the user out of the
          // project they just chose, which is the trap the CLOSE_TAB branch below spells
          // out at length.
          if (change.action?.reason === BOOT_RESTORE_REASON) {
            void Promise.resolve(viewed).then((shown) => {
              // The decision itself lives on the host (`shouldRepairBootRestore`), where it
              // is checkable without rendering — notably the part that makes `false` safe
              // to act on, since `viewRemoteThread` returns it both for a failed fetch and
              // for one a newer navigation superseded.
              const liveThreadId = liveThreadIdRef.current;
              if (!sessionTabsHost.shouldRepairBootRestore({ shown, liveThreadId })) return;
              void sessionTabsHost.adoptViewedThread({
                threadId: liveThreadId,
                threadProjectId: threadProjectIdRef.current,
              });
            });
          }
          return;
        }
        const liveThreadId = liveThreadIdRef.current;
        if (change.action?.type === "CLOSE_TAB" && liveThreadId) {
          void sessionTabsHost.adoptViewedThread({
            threadId: liveThreadId,
            threadProjectId: threadProjectIdRef.current,
          });
        }
      }),
    [sessionTabsHost]
  );

  // The sidebar's pinned project is a PROJECTION of the committed context, never a second
  // source of truth — the same one-way sync local does in `syncThreadListViewFromContext`.
  // Guarded on inequality so this cannot ping-pong with `selectProject`.
  const contextProjectId =
    sessionTabsContext?.kind === "project" ? sessionTabsContext.projectId : null;
  useEffect(() => {
    if (readActiveProjectId(threadListStore) !== contextProjectId) {
      threadListStore.getState().setActiveProject(contextProjectId);
    }
  }, [contextProjectId, threadListStore]);

  // Boot hydration. Every other command reads persistence as a side effect of doing
  // something; with no active thread nothing would ever dispatch, so a populated database
  // would render as an empty strip until the user happened to click a session.
  useEffect(() => {
    void sessionTabsHost.hydrate();
  }, [sessionTabsHost]);

  // 2. Screen -> controller. Remote's viewed thread is NOT owned by the controller —
  // boot shows the relay's active thread, another client can move it, and a Claude
  // pending id gets promoted mid-turn. Mirroring it back guarantees the strip always
  // describes what is actually rendered, which is the invariant five review rounds on
  // the local surface were spent establishing.
  //
  // `preview` is deliberately omitted rather than passed: omitting it routes without
  // re-flagging an already-open tab, so a session the user chose to KEEP is not demoted
  // back to a peek by the snapshot that follows.
  // The relay's own lineage field. It is the ONLY signal that separates a Claude
  // pending->real promotion from another device switching threads; without it the pending
  // tab would survive beside its promoted self, persisted, one per session.
  //
  // Held in a ref for the same reason as the others: it is an INPUT to how the change is
  // classified, never a reason to re-classify. Reading it inline would be correct — it
  // comes from the same render's `session` as `remoteViewedThreadId` — but it would read
  // as a missing dependency to everyone after this.
  const promotedFromRef = useRef(null);
  promotedFromRef.current = session?.active_thread_promoted_from || null;
  useEffect(() => {
    if (!remoteViewedThreadId) return;
    void sessionTabsHost.adoptViewedThread({
      threadId: remoteViewedThreadId,
      promotedFrom: promotedFromRef.current,
      threadProjectId: threadProjectIdRef.current,
    });
  }, [remoteViewedThreadId, sessionTabsHost]);

  // 5. Dead-workspace GC. A deleted project's tab set is COLD data — nothing renders it,
  // so nothing would ever notice it, and `validHistoryWorkspaces` (the only thing in the
  // codebase that deletes a whole workspace bucket) runs on RESTORE_HISTORY alone. Remote
  // had no boot restore to dispatch one, so those buckets accumulated in IndexedDB
  // forever. This reconciles on the same signal local does (`app.js`'s projects
  // subscriber) with the same remedy: re-run the current location as a restore.
  //
  // Two gates, and they are not redundant. This effect only fires on a SETTLED payload;
  // the controller's `getProjectIds()` independently reports "not authoritative" until
  // then, which disables the sweep inside the reduction. Either one alone would be a
  // single point of failure for an operation whose failure mode is deleting live tab
  // sets — the sweep is an allowlist diffed against disk, so every key it omits is a
  // delete, and a payload that is merely still loading looks exactly like "every project
  // was deleted".
  //
  // Fires on every SETTLED payload; the host decides whether that payload is a new
  // project set. Deliberately not deduped here: a refresh passes through `loading: true`,
  // so any signature computed in this component goes X -> null -> X and re-fires anyway,
  // and a ref holding the last one would outlive a relay switch (RemoteApp never
  // remounts) while the rule it implements is per relay. `reconcileProjects` owns it.
  const projectsSettled =
    remoteProjects.loaded && !remoteProjects.loading && !remoteProjects.error;
  useEffect(() => {
    if (!projectsSettled) return;
    void sessionTabsHost.reconcileProjects();
  }, [projectsSettled, remoteProjects.projects, sessionTabsHost]);

  // 6. Close tabs whose session is gone — ONCE per boot, and only after the thread list
  // has arrived so its ids can spare the probe the sessions it already proves are alive.
  //
  // Once, deliberately. This is the one operation here that closes something the user
  // opened, its input is a network answer, and repeating it on every list poll would keep
  // re-asking a question whose answer only changes when someone deletes a session on
  // another device. A reload is soon enough for that, and it is when the tabs are being
  // rebuilt from storage anyway.
  // `currentState.threads` and not `threadsModel`: the render model returns GROUPS, with
  // no flat list on it, so keying this off the model would compile, read fine, and never
  // fire. The raw list is also the honest input — the ids that came back from the relay,
  // before any grouping or pin policy touched them.
  const remoteThreadList = currentState.threads;
  const sweptMissingRef = useRef(null);
  useEffect(() => {
    if (sweptMissingRef.current === sessionTabsHost) return;
    if (!remoteThreadList?.length) return;
    sweptMissingRef.current = sessionTabsHost;
    void sessionTabsHost.sweepMissingThreads({
      knownThreadIds: remoteThreadList.map((thread) => thread?.id).filter(Boolean),
      probeThreads: (ids) => handlersRef.current.onProbeThreadsExist?.(ids),
    });
  }, [remoteThreadList, sessionTabsHost]);

  // Reviewer-panel data over the dedicated (uncompacted) `fetch_reviews` channel, cached and
  // re-fetched only when the snapshot's `reviews_revision` changes.
  const remoteReviewsCacheRef = useRef(null);
  if (!remoteReviewsCacheRef.current) {
    remoteReviewsCacheRef.current = createReviewsCache();
  }
  const [remoteReviews, setRemoteReviews] = useState(null);
  useEffect(() => {
    void remoteReviewsCacheRef.current.sync(
      session?.reviews_revision,
      () => fetchRemoteReviews(),
      () => setRemoteReviews(remoteReviewsCacheRef.current.current())
    );
  }, [session?.reviews_revision]);
  const remoteWorkflowsCacheRef = useRef(null);
  if (!remoteWorkflowsCacheRef.current) {
    remoteWorkflowsCacheRef.current = createWorkflowsCache();
  }
  const [remoteWorkflows, setRemoteWorkflows] = useState(null);
  useEffect(() => {
    void remoteWorkflowsCacheRef.current.sync(
      session?.workflows_revision,
      () => fetchRemoteWorkflows(),
      () => setRemoteWorkflows(remoteWorkflowsCacheRef.current.current())
    );
  }, [session?.workflows_revision]);
  useEffect(() => {
    const reviewsData = remoteReviews || { review_jobs: [], reviewer_threads: [] };
    const workflowsData = remoteWorkflows || { workflow_runs: [] };
    const remoteThreadWorkflowRuns = workflowRunsForThread(workflowsData, remoteViewedThreadId);
    getRemoteWorkspaceDiffStore().setReview({
      reviewJobs: reviewCardsForViewedThread(reviewsData, remoteViewedThreadId),
      workflowRuns: remoteThreadWorkflowRuns,
      reviewModel: {
        ...selectReviewLaunchModel({
          providers: remoteUi.providers,
          providerModels: remoteUi.providerModels,
          session,
        }),
        // Let the dialog distinguish "loading"/"failed" from "no models", and
        // fetch a cross-agent provider's catalog that the boot pre-fetch missed.
        providerModelsStatus: remoteUi.providerModelsStatus,
        activeProvider: session?.provider || "",
        onEnsureProviderModels: ensureRemoteProviderModels,
      },
      workflowModel: {
        ...selectWorkflowLaunchModel({
          providers: remoteUi.providers,
          providerModels: remoteUi.providerModels,
          session,
        }),
        providerModelsStatus: remoteUi.providerModelsStatus,
        activeProvider: session?.provider || "",
        onEnsureProviderModels: ensureRemoteProviderModels,
      },
      // Filter reuse by working tree: a reviewer bound to a tree the work has left is refused.
      reusableReviewers: reusableReviewersFromReviews(
        reviewsData,
        remoteViewedThreadId,
        null,
        remoteWorkspaceCwd
      ),
      // Full reviewer-thread list so each card can show its reviewer thread's
      // (long, truncated-with-tooltip) name by joining on reviewer_thread_id.
      reviewerThreads: reviewsData.reviewer_threads || [],
      // The thread the panel is showing (on remote this is the active/viewed thread):
      // sent as the review's parent so the backend reviews this thread explicitly.
      parentThreadId: remoteViewedThreadId,
      canRequest: canRequestReview(session, remoteDeviceId, remoteViewedThreadId),
      canStartWorkflow: hasControllerLease && canStartWorkflow(session, remoteViewedThreadId),
      blocked:
        isReviewBlocked(session) || isWorkflowBlocked(session),
    });
  }, [
    session,
    remoteReviews,
    remoteWorkflows,
    remoteUi.providers,
    remoteUi.providerModels,
    remoteUi.providerModelsStatus,
    remoteDeviceId,
    remoteWorkspaceCwd,
    hasControllerLease,
  ]);

  // Built once per render and shared by the sidebar's group roll-up, its per-row dots,
  // and the tab strip — the same hoist local does (render-session.js), one level up now
  // that a second region needs them. Beyond the wasted rebuild, `snapshotMap()` copies
  // mutable state on every call, so two copies could let a tab's dot disagree with the
  // sidebar row for the same session.
  const threadActivityMap = buildThreadActivityMap(session);
  const threadAttentionMap = threadAttention.snapshotMap();
  const threadReviewingSet = buildReviewingThreadSet(session, remoteReviews);

  // The strip's view model. `workspace` is the tab set for the CURRENT context, so
  // selecting a project swaps the whole strip, exactly as on local.
  const sessionTabItems = buildSessionTabItems({
    workspace: sessionTabsView.workspaces[sessionViewContextKey(sessionTabsContext)] || {
      tabs: [],
      focusedTabId: null,
    },
    layoutThreadIds,
    // A tab can outlive the thread it names — the list is paginated and a session can
    // be deleted from another surface — so an unresolvable id still gets a readable
    // label rather than vanishing from a strip that is meant to describe the screen.
    resolveThread(threadId) {
      const thread = findVisible(threadId);
      if (!thread) {
        return { title: shortId(threadId), tooltip: threadId };
      }
      return {
        title: thread.name || thread.preview || shortId(thread.id),
        tooltip: thread.cwd || thread.name || thread.id,
        provider: thread.provider || "",
      };
    },
    threadActivity: threadActivityMap,
    threadAttention: threadAttentionMap,
    threadReviewing: threadReviewingSet,
  });

  // Inputs for the composer idle nudge ("Want a second opinion on these
  // changes?"), mirroring the local surface. Plain render-time derivations — not
  // effect deps — so recomputing each render is fine.
  const reviewLaunchModel = {
    ...selectReviewLaunchModel({
      providers: remoteUi.providers,
      providerModels: remoteUi.providerModels,
      session,
    }),
    providerModelsStatus: remoteUi.providerModelsStatus,
    activeProvider: session?.provider || "",
    onEnsureProviderModels: ensureRemoteProviderModels,
  };
  const canRequestRemoteReview = canRequestReview(session, remoteDeviceId, remoteViewedThreadId);
  const forkDialog = remoteUi.forkDialog || {};
  // Gated on the dialog actually being open: RemoteApp re-renders on every
  // snapshot/transcript delta while streaming, and this derivation used to run
  // on all of them for a dialog that is almost always closed.
  const forkView = React.useMemo(() => {
    if (!forkDialog.open) return null;
    const fields = forkDialog.fields || {};
    const provider = fields.provider || forkDialog.sourceThread?.provider || "";
    const models = remoteUi.providerModels[provider] || [];
    return {
      fields,
      provider,
      models,
      settings: providerSettings(provider),
      modelsStatus: models.length
        ? "ready"
        : remoteUi.providerModelsStatus[provider] || "loading",
    };
  }, [
    forkDialog.open,
    forkDialog.fields,
    forkDialog.sourceThread,
    remoteUi.providerModels,
    remoteUi.providerModelsStatus,
  ]);

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

  // The funnel for "the list went stale because something CHANGED it" — rename, fork,
  // start. The 12s poll goes straight to `refreshRemoteThreads` and does not come
  // through here, which is why re-running an open search is safe to do at this point:
  // it follows known mutations rather than turning search into a second polling loop.
  async function runThreadRefresh(reason, { silent = false, fresh = false } = {}) {
    let completed = false;
    if (!silent) {
      threadListStore.getState().startRefresh();
    }

    try {
      await handlers.onRefreshThreads({ reason, silent, fresh });
      // Search results are a separate snapshot. Refreshing only the authoritative list
      // would leave the rows actually ON SCREEN showing the old title — a rename would
      // look like it did nothing — and for a row past the first 80 that refresh cannot
      // reach it at all.
      const openQuery = currentState.threadSearch?.query;
      if (openQuery) {
        await searchRemoteThreads(openQuery);
      }
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

  function handleOpenForkDialog(threadId, upToItemId = "") {
    // See resolveForkSourceThread: the thread list may not be loaded (or may
    // not contain an older thread) when the transcript already shows its fork
    // buttons. Bailing here used to fail silently on this surface.
    const visible = findVisible(threadId);
    const thread = resolveForkSourceThread({
      threadId,
      // The search slice too: a result from beyond the authoritative page is exactly
      // the kind of older thread this resolver's fallbacks exist for, and forking it is
      // one of the reasons to have gone looking.
      threads: visible ? [visible, ...(currentState.threads || [])] : currentState.threads,
      session,
    });
    if (!thread) return;
    // Match the relay's guard up front instead of failing on submit; a
    // BACKGROUND thread can be mid-turn too.
    if (threadIsBusyForFork(thread, session)) {
      remoteUiStore.getState().setForkDialog({
        open: true,
        pending: false,
        sourceThread: thread,
        fields: {
          ...defaultForkFields({ thread, models: [], session }),
          upToItemId,
        },
        error: "Cannot fork a session while a turn is in progress.",
      });
      return;
    }
    const models = remoteUiStore.getState().providerModels[thread.provider] || [];
    remoteUiStore.getState().beginForkDialogOpening();
    remoteUiStore.getState().setForkDialog({
      open: true,
      pending: false,
      sourceThread: thread,
      fields: {
        ...defaultForkFields({ thread, models, session }),
        cwd: thread.cwd || session?.current_cwd || "",
        upToItemId,
        forkPointIsTip: forkPointIsTranscriptTip(session?.transcript || [], upToItemId),
      },
      error: "",
    });
    // The source thread's provider is usually not the active session's, and
    // nothing else fetches that catalog — without this the model select sits
    // on "Loading models..." forever.
    void ensureRemoteProviderModels(thread.provider);
    // Not awaited: the dialog opens on inherited fields and re-seeds when this lands.
    void refreshRemoteForkSourceSettings(thread.id);
  }

  // Only untouched (INHERIT) fields are replaced, and only while the dialog still
  // shows the same source — it can be reopened on another thread mid-flight.
  async function refreshRemoteForkSourceSettings(threadId) {
    try {
      const settings = await fetchRemoteThreadSettings(threadId);
      if (!settings) return;
      const dialog = remoteUiStore.getState().forkDialog;
      if (!dialog?.open || dialog.sourceThread?.id !== threadId) return;

      // DISPLAY only: writing these into `fields` would submit them, freezing a
      // permission the source may tighten while the dialog is open.
      remoteUiStore.getState().setForkDialog({ ...dialog, sourceSettings: settings });
    } catch {
      // Leaves the fields inherited, which is still a correct request.
    }
  }

  // --- per-session actions sheet ----------------------------------------------
  //
  // Remote's only reachable session-actions entry on a phone: `contextmenu` never
  // fires for a touch long-press, so before this the row's right-click binding was
  // dead on iOS and fork was reachable only from a transcript message.
  const selectSheetFor = (threadId) => {
    // A row reached through search is routinely absent from the authoritative list; with
    // a bare lookup its "⋯" would report no actions and do nothing.
    const visible = findVisible(threadId);
    return selectThreadSheet({
      threadId,
      threads: visible ? [visible, ...(currentState.threads || [])] : currentState.threads,
      session,
      projects: remoteProjects.projects,
      threadProjectId: remoteProjects.threadProjectId,
      projectsLoaded: remoteProjects.loaded,
      projectsError: remoteProjects.error,
      projectsLoading: remoteProjects.loading,
    });
  };
  const { thread: actionsSheetThread, sections: actionsSheetSections } =
    selectSheetFor(actionsSheetThreadId);

  const openActionsSheet = (threadId) => {
    // Decide at TAP time. Deriving openness from the live sections instead would let a
    // tap that found nothing re-open the sheet by itself moments later, when a slow
    // projects payload landed — a sheet the user never asked for a second time.
    if (!selectSheetFor(threadId).hasActions) {
      renderLog("No actions available for that session yet.");
      return;
    }
    setActionsSheetThreadId(threadId);
  };
  const closeActionsSheet = () => setActionsSheetThreadId(null);
  const actionsSheetOpen = Boolean(actionsSheetThreadId);

  function handleThreadSheetAction(item) {
    const threadId = actionsSheetThreadId;
    // Read the session BEFORE closing the sheet — `actionsSheetThread` is derived from
    // the open sheet's id and is null by the time the rename branch needs its name.
    const sheetThread = actionsSheetThread;
    // Close first: every branch either opens another dialog or awaits the network, and
    // leaving the sheet up over the fork dialog would stack two modals.
    closeActionsSheet();
    // The projects known BEFORE the action — the create branch diffs against these to
    // recover the new project's id.
    const before = remoteProjects.projects;
    return runThreadSheetAction({
      item,
      threadId,
      projects: before,
      currentName: threadCustomName(sheetThread),
      deps: {
        assign: assignRemoteThreadToProject,
        unassign: unassignRemoteThread,
        create: createRemoteProject,
        fetchProjects: fetchRemoteProjects,
        promptName: () => promptRemoteProjectName(),
        openFork: (id) => handleOpenForkDialog(id),
        refresh: refreshRemoteProjects,
        log: renderLog,
        rename: renameRemoteThread,
        // Seeded from the DISPLAYED title, so a never-renamed session opens with the
        // agent's name to edit rather than an empty box. Returns `undefined` when
        // cancelled and `null` when the user cleared it (a reset) — the two are
        // different intents and the action branch relies on telling them apart.
        promptRename: () => {
          const answer = window.prompt(
            "Rename this session.\n\nLeave it blank to go back to the name the agent picked.",
            threadNameDraft(sheetThread, shortId(threadId))
          );
          return answer === null ? undefined : normalizeThreadName(answer);
        },
        refreshThreads: () =>
          runThreadRefresh("session renamed", { silent: true, fresh: true }),
      },
    });
  }

  function handleForkFieldChange(field, value) {
    const dialog = remoteUiStore.getState().forkDialog;
    let next = { ...dialog.fields, [field]: value };
    if (field === "provider") {
      const models = remoteUiStore.getState().providerModels[value] || [];
      next = applyForkProviderChange(next, value, models);
      void ensureRemoteProviderModels(value);
    }
    remoteUiStore.getState().setForkDialog({ fields: next, error: "" });
  }

  // See submitForkDialog on the local surface: the dialog hands back its
  // NORMALIZED fields, which are what the user actually sees.
  async function handleForkSession(submittedFields = null) {
    const dialog = remoteUiStore.getState().forkDialog;
    if (!dialog.sourceThread?.id || dialog.pending) return false;
    remoteUiStore.getState().setForkDialog({ pending: true });
    try {
      const result = await handlers.onForkSession?.({
        ...(submittedFields || dialog.fields),
        sourceThreadId: dialog.sourceThread.id,
      });
      if (result?.ok) {
        closeRemoteNavigation();
        remoteUiStore.getState().closeForkDialog();
        await runThreadRefresh("post-fork refresh", { silent: true });
        return true;
      }
      remoteUiStore.getState().setForkDialog({
        error: result?.error || "Failed to fork session.",
      });
      return false;
    } finally {
      remoteUiStore.getState().setForkDialog({ pending: false });
    }
  }

  // The strip renames in place (right-click or F2) rather than through the actions
  // sheet, so it commits a raw string here. An empty commit is a RESET to the agent's
  // own name, which is why the normalized value falls back to `null` rather than being
  // rejected — the same two intents `promptRename` distinguishes for the sheet.
  async function handleRenameThreadInline(threadId, rawName) {
    try {
      await renameRemoteThread(threadId, normalizeThreadName(rawName) || null);
      await runThreadRefresh("session renamed", { silent: true, fresh: true });
    } catch (error) {
      renderLog(`Rename failed: ${error?.message || error}`);
    }
  }

  // `preview` comes from the shared row: a single click peeks (reusing the one preview
  // tab), a double click keeps. It used to be dropped here because remote had no strip.
  async function handleResumeThread(threadId, { preview } = {}) {
    closeRemoteNavigation();
    // Opening a thread clears its attention dot; treat the click as the user
    // gesture that unlocks notification permission for later events. Store the
    // result so the auto-enroll effect can react to a grant made here (e.g. after
    // the user dismissed the prompt during pairing).
    threadAttention.clear(threadId);
    void requestAndStorePermission();
    // Navigation goes through the controller so the tab set and what is on screen can
    // never disagree; the subscriber below performs the actual view change. The host
    // files it under the thread's OWNING project, not the pinned one.
    await sessionTabsHost.openThread({
      threadId,
      threadProjectId: threadProjectIdRef.current,
      preview,
    });
  }

  // VAPID public key arrives on the session snapshot (null until the server
  // advertises it). The push subscription manager needs it for `subscribe`.
  const vapidPublicKey = session?.push_vapid_public_key || null;

  // Centralize permission requests so every gesture path (pairing, thread-open)
  // writes the result into the store. The auto-enroll effect keys off
  // `pushPermission`, so a grant that isn't stored would never trigger subscribe.
  async function requestAndStorePermission() {
    const permission = await ensureNotificationPermission();
    remoteUiStore.getState().setPushPermission(permission);
    return permission;
  }

  async function resolvePushRegistration() {
    const captured = getRemoteServiceWorkerRegistration();
    if (captured) {
      return captured;
    }
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.ready) {
      try {
        return await navigator.serviceWorker.ready;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Auto-enroll: once notification permission is granted (typically the moment
  // the user pairs this device) and the relay has advertised a VAPID key, this
  // device subscribes on its own — there is no in-app "Enable"/"Disable"; the
  // browser permission is the on/off switch. Also reconciles the state on load,
  // since a push subscription persists in the SW across reloads. Re-runs when the
  // VAPID key arrives or the permission flips (set at pairing / thread-open).
  useEffect(() => {
    if (
      !shouldAutoSubscribe({
        supported: remoteUi.pushSupported,
        hasVapidKey: Boolean(vapidPublicKey),
        permissionGranted: notificationPermission() === "granted",
      })
    ) {
      return;
    }
    void (async () => {
      const registration = await resolvePushRegistration();
      // Always (re-)assert the subscription to the relay. The browser subscription
      // persists across reloads, but the relay may have missed the original
      // register (it's fire-and-forget and can be lost in transit).
      // ensurePushSubscription reuses the existing browser subscription, and the
      // relay dedups an identical register, so this reconcile is idempotent and
      // cheap — one request per load, and the relay no-ops when nothing changed.
      const result = await ensurePushSubscription({ vapidPublicKey, registration });
      if (result?.ok) {
        remoteUiStore.getState().setPushSubscribed(true);
        return;
      }
      // The re-assert failed (e.g. offline). Still reflect an existing browser
      // subscription so the status isn't misleading; it re-asserts on the next load.
      const active = await hasActiveSubscription(registration);
      remoteUiStore.getState().setPushSubscribed(active);
    })();
  }, [vapidPublicKey, remoteUi.pushSupported, remoteUi.pushPermission, remoteUiStore]);

  // Re-register the subscription when the SW reports the push subscription
  // changed (browser-rotated endpoint). Permission must already be granted.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.addEventListener) {
      return undefined;
    }
    const onMessage = (event) => {
      if (event?.data?.type !== "pushsubscriptionchange") {
        return;
      }
      if (notificationPermission() === "granted" && vapidPublicKey) {
        void (async () => {
          const registration = await resolvePushRegistration();
          const result = await ensurePushSubscription({ vapidPublicKey, registration });
          remoteUiStore.getState().setPushSubscribed(Boolean(result?.ok));
        })();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [vapidPublicKey, remoteUiStore]);

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

  // Opening an individual file section calls this to pull omitted diff bodies.
  // Idempotent: skips when full detail is cached/live or a fetch is in flight.
  //
  // Hoisted via useCallback rather than a fresh function every render: this
  // flows into transcriptOptions (RemoteTranscriptPanel), where a fresh
  // reference every render defeated stableTranscriptOptions no matter how
  // stable every other field was. Depends on session?.active_thread_id, not
  // `session` itself, so a routine transcript delta (which replaces `session`
  // but not its active_thread_id) does not recreate this — the async
  // continuation's `session?.active_thread_id !== threadId` re-check below
  // still reads the CURRENT value correctly, because a real thread switch is
  // exactly the case that invalidates this dependency and recreates the
  // callback.
  const ensureFileChangeDetail = useCallback(
    async (itemId) => {
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
    },
    [session?.active_thread_id, currentState, transcriptUiState.transcriptLoadingItemIds, dispatchTranscriptUi]
  );

  // Same identity-stability reason as ensureFileChangeDetail above, and the
  // same fix already established for the reviewer actions bundle nearby
  // (handlersRef + useMemo([])): `handlers` itself is rebuilt every render
  // (createRemoteAppHandlers() above), so reading the latest through a ref
  // inside a permanently-stable callback is what keeps this out of
  // transcriptOptions's way instead of merely moving the instability here.
  const handleSubmitAskUserAnswers = useCallback((requestId, answers) => {
    void handlersRef.current.onSubmitAskUserAnswers?.(requestId, answers);
  }, []);

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
    // Fold notification opt-in into pairing so there's no separate "Enable" step.
    // The browser permission prompt must be the first awaited call in the gesture
    // (iOS rule), so request it before the pairing round-trip. Actual push
    // subscription then happens automatically once the device is paired and
    // permission is granted (see the auto-subscribe effect below).
    await requestAndStorePermission();
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
        threadActivityMap,
        threadAttentionMap,
        threadReviewingSet,
        onOpenInfo() {
          closeRemoteNavigation();
          remoteUiStore.getState().setRemoteInfoModalOpen(true);
        },
        onOpenPairing() {
          remoteUiStore.getState().setPairingModalOpen(true);
        },
        onOpenSettings() {
          // Closes the drawer first on phones: the modal renders over the shell,
          // and leaving the nav open behind it means dismissing Settings drops
          // you back onto a drawer you did not ask to reopen.
          closeRemoteNavigation();
          remoteUiStore.getState().setSettingsModalOpen(true);
        },
        onRefreshRelayDirectory() {
          void handlers.onRefreshRelayDirectory();
        },
        onRefreshThreads() {
          void runThreadRefresh("manual refresh");
        },
        onResumeThread: handleResumeThread,
        // Right-click keeps its long-standing shortcut straight to the fork dialog on
        // the desktop-sized remote view; the sheet below is the entry that also works
        // on touch, where `contextmenu` never fires.
        onContextThread: handleOpenForkDialog,
        onThreadActions: openActionsSheet,
        threadFilter,
        onSetThreadFilter: setThreadFilter,
        onSetThreadFilterRetained: setThreadFilterRetained,
        threadSearch: currentState.threadSearch,
        searchOpen,
        searchQuery: searchDraft,
        onSetSearchOpen,
        onSearchInput,
        activeProjectId,
        projects: remoteProjects.projects,
        projectsReady: remoteProjectsReady,
        onSelectProject: setActiveProject,
        onCreateProject: createRemoteProjectFromToolbar,
        onRenameProject: handleRenameRemoteProject,
        onDeleteProject: handleDeleteRemoteProject,
        onSelectRelay(relayId) {
          closeRemoteNavigation();
          void handlers.onSelectRelay(relayId);
        },
        onStartSession() {
          void handleStartSession();
        },
        onOpenStartSessionDialog(projectId = null) {
          openRemoteStartSessionDialog(remoteUiStore, projectId);
        },
        onToggleGroup(cwd) {
          threadListStore.getState().toggleCollapsedGroup(cwd);
        },
        onToggleExpandedGroup(cwd) {
          threadListStore.getState().toggleExpandedGroup(cwd);
        },
        relayDirectoryModel,
        remoteReviews,
        remoteUiState: remoteUi,
        session,
        sessionPanelModel,
        sessionPanelOpen: remoteUi.sessionPanelOpen,
        sessionToggleLabel,
        threadListUi,
        threadsModel,
        updateSessionDraft,
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
          activeProjectId,
          hasUsableRelay,
          projects: remoteProjects.projects,
          projectsError: remoteProjects.error,
          projectsLoaded: remoteProjects.loaded,
          projectsReady: remoteProjectsReady,
          onCreateProject: createRemoteProjectFromToolbar,
          onDeleteProject: handleDeleteRemoteProject,
          onRenameProject: handleRenameRemoteProject,
          onSelectProject: setActiveProject,
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
        // Desktop-pointer only. On touch the strip is ABSENT rather than inert: its pin
        // and close controls are hover-revealed and reordering needs a hold-and-drag,
        // so a finger would get a row of controls it cannot reach. The tab set is still
        // maintained underneath, so attaching a mouse reveals a correct strip rather
        // than an empty one.
        currentState.remotePointerClass === "desktop"
          ? h(SessionTabStrip, {
              items: sessionTabItems,
              // Derived from the VIEWED thread, with no fallback to the workspace's
              // remembered focus or to active_thread_id. A fallback is how the strip
              // starts disagreeing with the screen.
              focusedTabId:
                sessionTabItems.find((item) => item.threadId === remoteViewedThreadId)
                  ?.tabId || null,
              onFocus(tabId) {
                const item = sessionTabItems.find((entry) => entry.tabId === tabId);
                if (item) void handleResumeThread(item.threadId, { preview: undefined });
              },
              onClose(tabId) {
                void sessionTabsHost.controller.closeTab(tabId, {
                  context: sessionTabsContext,
                });
              },
              onPromote(tabId) {
                void sessionTabsHost.controller.promoteTab(tabId, {
                  context: sessionTabsContext,
                });
              },
              onTogglePin(tabId, pinned) {
                void sessionTabsHost.controller.pinTab(tabId, pinned, {
                  context: sessionTabsContext,
                });
              },
              onMove(tabId, toIndex) {
                void sessionTabsHost.controller.moveTab(tabId, toIndex, {
                  context: sessionTabsContext,
                });
              },
              onRename: handleRenameThreadInline,
              emptyMessage: "No open sessions. Pick one from the sidebar.",
            })
          : null,
        h(RemoteThreadPanel, {
          agentWorkingIndicatorModel,
          onForkFromMessage: handleOpenForkDialog,
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
          onSubmitAskUserAnswers: handleSubmitAskUserAnswers,
          onApplyFileChange(itemId, direction) {
            void handlers.onApplyFileChange?.(itemId, direction);
          },
          onTakeOver() {
            void handlers.onTakeOver();
          },
          // The banner passes the thread it is describing, not "the current one": a
          // repair must target the session whose path the user just read.
          onRepairWorkspace(threadId) {
            void handlers.onRepairWorkspace?.(threadId);
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
            // The composer nudge launcher needs the reusable-reviewer list too, or it shows
            // no "reuse an existing reviewer" option. Source it from the dedicated reviews
            // cache (same as the panel) so it survives live-turn compaction; fall back to the
            // snapshot until the cache loads.
            reusableReviewers: reusableReviewersFromReviews(
              remoteReviews || { reviewer_threads: [] },
              remoteViewedThreadId,
              null,
              remoteWorkspaceCwd
            ),
            parentThreadId: remoteViewedThreadId,
            workspace: remoteWorkspace,
            onPinWorkspace: (path) => getRemoteWorkspaceDiffStore().pinWorkspace(path),
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
    forkDialog.open && forkView
      ? h(ForkSessionDialog, {
          id: "remote-fork-session-dialog",
          sourceThread: forkDialog.sourceThread,
          onCreateProject: remoteProjectsReady
            ? () => {
                // The generation, not the source id: reopening on the SAME thread is
                // still a different opening.
                const opening = forkDialog.generation || 0;
                return createRemoteProjectForDraft(
                  (projectId) => handleForkFieldChange("projectId", projectId),
                  () => {
                    const current = remoteUiStore.getState().forkDialog;
                    return current?.open && (current.generation || 0) === opening;
                  }
                );
              }
            : null,
          projects: remoteProjects.projects,
          threadProjectId: remoteProjects.threadProjectId,
          threads: currentState.threads,
          fields: forkView.fields,
          pending: forkDialog.pending,
          error: forkDialog.error || "",
          // Every provider's catalogue: a cross-provider fork is chosen from the
          // same merged menu the launch dialog uses.
          providers: remoteUi.providers,
          providerModels: remoteUi.providerModels,
          modelsStatus: forkView.modelsStatus,
          workspaceSuggestions: selectWorkspaceSuggestionsModel({
            selectedCwd: forkView.fields.cwd || "",
            session,
            threads: currentState.threads,
          }),
          onSelectModel: ({ provider, model }) => {
            // Not re-resolving effort for the inherit row: that one stays null.
            const catalog = remoteUi.providerModels[provider] || [];
            handleForkFieldChange("provider", provider);
            handleForkFieldChange("model", model);
            if (model) {
              handleForkFieldChange(
                "effort",
                resolveReasoningEffortValue(catalog, model, forkView.fields.effort)
              );
            }
          },
          approvalOptions: forkView.settings.approvalOptions,
          effortOptions: buildReasoningEffortOptions(
            forkView.models,
            forkView.fields.model,
            forkView.provider
          ),
          forkCapabilities: session?.provider_fork_capabilities || [],
          sourceSettings: forkDialog.sourceSettings || null,
          sourceProjectId: remoteProjects.threadProjectId?.[forkDialog.sourceThread?.id] || null,
          onFieldChange: handleForkFieldChange,
          onFork: (submitted) => void handleForkSession(submitted),
          onRequestClose() {
            remoteUiStore.getState().closeForkDialog();
          },
        })
      : null,
    h(ThreadActionsSheet, {
      open: actionsSheetOpen,
      sections: actionsSheetSections,
      threadTitle: actionsSheetThread?.name || "Session",
      onClose: closeActionsSheet,
      onSelect: (item) => void handleThreadSheetAction(item),
    }),
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
    h(RemoteSettingsModal, {
      open: remoteUi.settingsModalOpen,
      providerModel: buildProviderStatusModel(session),
      onClose() {
        remoteUiStore.getState().setSettingsModalOpen(false);
      },
    }),
    h(RemoteInfoModal, {
      open: remoteUi.remoteInfoModalOpen,
      onClose() {
        remoteUiStore.getState().setRemoteInfoModalOpen(false);
      },
      sessionMetaModel,
      sessionPath: headerModel.sessionPath || "No workspace path yet.",
      pushModel: {
        supported: remoteUi.pushSupported,
        permission: remoteUi.pushPermission,
        subscribed: remoteUi.pushSubscribed,
        hasVapidKey: Boolean(vapidPublicKey),
      },
    })
  );
}

function findThreadNameInGroups(groups, threadId) {
  if (!threadId || !Array.isArray(groups)) {
    return null;
  }
  for (const group of groups) {
    const thread = group?.threads?.find?.((entry) => entry?.id === threadId);
    if (thread) {
      return thread.name || thread.preview || shortId(threadId);
    }
  }
  return null;
}

// The bell has no pills on either surface — turning it on re-groups the list by state,
// and the bucket headers underneath already carry those four labels.

// Switching agent is not just "set provider": the model, the reasoning effort and the
// approval policy are all per-agent, so the draft has to move together or the dialog opens
// with one agent selected and another agent's model still in the box. Hoisted because two
// controls now perform this switch — the dialog's own select and the sidebar split
// button's menu — and they must not drift.

// Store passed in: this is module scope, but the store is created per-mount inside
// RemoteApp, so naming it here was a ReferenceError.
function openRemoteStartSessionDialog(store, activeProjectId = null) {
  store.getState().beginLaunchDialogOpening();
  // At open time, not per render: otherwise an unrelated re-render snaps the chip
  // back over a choice made inside the dialog.
  store.getState().setSessionDraftField("projectId", activeProjectId || null);
  document.getElementById("remote-start-session-dialog")?.showModal();
}

function providerDraftPatch(uiState, value) {
  const models = uiState.providerModels[value] || [];
  const model = models.find((option) => option.is_default)?.model
    || models[0]?.model
    || defaultModelForProvider(value);
  const storedEffort = loadLastEffort(value);
  const storedApproval = loadLastApprovalPolicy(value);
  const patch = {
    effort: resolveReasoningEffortValue(models, model, storedEffort || uiState.sessionDraft.effort),
    model,
    provider: value,
  };
  if (storedApproval) patch.approvalPolicy = storedApproval;
  return patch;
}

function RemoteSidebar({
  currentState,
  hasRelay,
  hasUsableRelay,
  threadActivityMap,
  threadAttentionMap,
  threadReviewingSet,
  onOpenInfo,
  onOpenPairing,
  onOpenSettings,
  onRefreshRelayDirectory,
  onRefreshThreads,
  remoteUiState,
  onResumeThread,
  onContextThread,
  onThreadActions,
  threadFilter,
  onSetThreadFilter,
  onSetThreadFilterRetained,
  threadSearch,
  searchOpen,
  searchQuery,
  onSetSearchOpen,
  onSearchInput,
  activeProjectId,
  projects,
  projectsReady,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onSelectRelay,
  onStartSession,
  onOpenStartSessionDialog,
  onToggleExpandedGroup,
  onToggleGroup,
  relayDirectoryModel,
  remoteReviews,
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

  // Re-render when the attention map changes out-of-band (clear-on-open, tab
  // refocus). Snapshot-driven changes already re-render via the session prop.
  useSyncExternalStore(subscribeThreadAttention, getThreadAttentionVersion, getThreadAttentionVersion);

  // Clear the viewed thread's dot when the tab regains focus, even with no new
  // snapshot for an idle thread.
  useEffect(() => {
    const clearViewedDot = () => threadAttention.clearViewedOnFocus(isDocumentForeground());
    window.addEventListener("focus", clearViewedDot);
    document.addEventListener("visibilitychange", clearViewedDot);
    return () => {
      window.removeEventListener("focus", clearViewedDot);
      document.removeEventListener("visibilitychange", clearViewedDot);
    };
  }, []);

  // Keep notifications pointed at the client-local thread navigation handler.
  configureThreadNotifications({
    resolveThreadName: (threadId) => findThreadNameInGroups(threadsModel?.groups, threadId),
    onActivateThread: (threadId) => {
      void onResumeThread?.(threadId);
    },
  });

  // The bell re-buckets the SAME rows by state. It belongs here for the same reason the
  // roll-up does: this is where all three per-thread maps are in scope. Doing it in the
  // render model would mean recomputing them there, and two copies of `snapshotMap()`
  // can disagree.
  const stateOf = (thread) =>
    selectThreadState({
      activity: threadActivityMap.get(thread.id) || null,
      attentionKind: threadAttentionMap.get(thread.id) || null,
      reviewing: threadReviewingSet.has?.(thread.id),
    });
  // Search swaps the SOURCE of the rows; the bell narrows whatever that source is. Same
  // composition as local, which is what lets the two controls coexist instead of
  // competing for the list.
  const listView = selectThreadListView({
    threadGroups: threadsModel.groups,
    search: threadSearch,
    groupBy: "cwd",
  });

  // Retention is a monotonic accumulator. Local writes it during render because its
  // state is a plain mutable object; here it lives in a store, so writing it inline
  // would be a set() during render — React's cardinal sin. An effect keeps it out of the
  // render pass, and because the map only ever grows toward a fixed point, the extra
  // pass settles immediately instead of looping.
  const retainedNext = nextRetainedStates(
    threadFilter.retained,
    listView.groups,
    threadFilter,
    stateOf
  );
  useEffect(() => {
    // Identity is the whole test: `nextRetainedStates` returns the same instance when
    // nothing changed. Comparing `size` instead would miss a row MOVING between states
    // — value changes, size does not — and the row would snap back to its old bucket
    // the moment it went stateless.
    if (retainedNext !== threadFilter.retained) {
      onSetThreadFilterRetained(retainedNext);
    }
  });

  const filterView = selectThreadFilterView({
    groups: listView.groups,
    filter: { ...threadFilter, retained: retainedNext },
    stateOf,
  });
  const listChrome = composeListChrome(listView, filterView);

  // Hoisted so the chip and the list read the SAME decorated groups. Deriving the
  // chip's name from `projects` and its badges from the groups would let the two
  // disagree for a render whenever a project is renamed or deleted elsewhere.
  const decoratedGroups = attachProjectSummaries(filterView.groups, {
    threadActivity: threadActivityMap,
    threadAttention: threadAttentionMap,
    threadReviewing: threadReviewingSet,
  });
  const pinnedProject = decoratedGroups.find((group) => group.pinned) || null;

  return h(
    "aside",
    {
      "aria-hidden": String(!navOpen),
      className: "sidebar",
    },
    h(
      "div",
      { className: "sidebar-top-bar" },
      h(SidebarCollapseToggle, { id: "remote-sidebar-top-toggle" }),
      h(SidebarBrand),
      h(
        "div",
        { className: "sidebar-top-actions" },
        // Switching projects is a LOW-FREQUENCY act on a phone — the drawer defaults to
        // sessions and search/filter are the fast paths — so this is one icon beside
        // them rather than a heading above the list. The name it would have displayed
        // lives on the chip below, which only exists while a project is actually
        // pinned.
        //
        // Drawer widths only: the chat header carries the full switcher at every width
        // (RemoteHeader's `titleNode`), so this icon is that same control a second time
        // unless the drawer is covering it.
        usesDrawer
          ? h(ProjectSwitcher, {
              activeProjectId,
              className: "project-switcher-top",
              onCreateProject: projectsReady ? () => onCreateProject() : null,
              onDeleteProject: projectsReady ? onDeleteProject : null,
              onRenameProject: projectsReady ? onRenameProject : null,
              onSelectProject,
              projects,
              renderHeading: false,
              // The same tag the tree marks project groups with. This used to be a
              // bespoke folder outline, on the reasoning that a second mark at 16px
              // would be noise — which held only while projects and cwds shared a
              // glyph. They no longer do, so a folder here would name the wrong kind.
              triggerIcon: h(ProjectTagIcon),
            })
          : null,
        // No `shortcutHint`: remote is a phone surface with no ⌘F to promise.
        h(SidebarSearchToggle, { open: searchOpen, onToggle: onSetSearchOpen }),
        h(SidebarBellToggle, {
          on: threadFilter.on,
          onToggle: (on) => onSetThreadFilter({ on }),
        })
      )
    ),
    h(SidebarSearchField, {
      open: searchOpen,
      query: searchQuery,
      onInput: onSearchInput,
      onClose: () => onSetSearchOpen(false),
      // No `focusOnOpen`, deliberately: on a phone, focusing pops the on-screen keyboard
      // over the very list the user just asked to search. `focusSignal` is therefore
      // irrelevant here — the component ignores it without the policy flag.
    }),
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
    h(StartSessionSplitButton, {
      activeProvider: sessionPanelModel?.fields?.provider || "",
      buttonId: "remote-session-toggle",
      disabled: !hasUsableRelay,
      menuId: "remote-start-session-agent-menu",
      onStart: () => onOpenStartSessionDialog(activeProjectId),
      onStartWithProvider(provider) {
        updateSessionDraft(providerDraftPatch(remoteUiState, provider));
        onOpenStartSessionDialog(activeProjectId);
      },
      providerOptions: sessionPanelModel?.providerOptions || [],
    }),
    // The Providers health panel used to sit here, between the primary action and
    // the relay list. It is now a Settings tab — the same place local files it.
    // Provider is per-session and immutable once a session starts, so nothing on
    // this panel is ever acted on from the sidebar; it was spending permanent
    // column space to answer a question you ask about twice a week.
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
        onSelectModel({ provider, model }) {
          // One patch: effort is per MODEL, and the second of two sequential
          // callbacks would still be reading the previous render's catalogue.
          const uiState = remoteUiState;
          const catalog = uiState.providerModels[provider] || [];
          const patch =
            provider !== uiState.sessionDraft.provider
              ? providerDraftPatch(uiState, provider)
              : {};
          updateSessionDraft({
            ...patch,
            effort: resolveReasoningEffortValue(catalog, model, uiState.sessionDraft.effort),
            model,
            provider,
          });
        },
        onFieldChange(field, value) {
          const uiState = remoteUiState;
          if (field === "provider") {
            updateSessionDraft(providerDraftPatch(uiState, value));
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
        h("p", { className: "sidebar-caption", id: "remote-threads-count" }, listChrome.countLabel),
        h(RefreshButton, {
          id: "remote-threads-refresh-button",
          label: "Refresh sessions",
          disabled: threadsModel.loading || !hasUsableRelay,
          onClick: () => onRefreshThreads(),
        })
      ),
      // The pinned project, said once and quietly. Without it the lifted sessions sit
      // at the top of the list with no group header and nothing saying why — every
      // other group has one, so they read as a rendering fault rather than a selection.
      pinnedProject
        ? h(PinnedProjectChip, {
            name: pinnedProject.label,
            summary: pinnedProject.summary || null,
            onClear: () => onSelectProject(null),
          })
        : null,
      h(
        "div",
        { className: "conversation-list", id: "remote-threads-list" },
        h(ThreadGroupList, {
          activeThreadId: threadsModel.activeThreadId,
          collapsedGroupCwds: threadListUi?.collapsedGroupCwds || new Set(),
          // Both group kinds fold away — a project header carries its collapse
          // chevron alongside the rename/delete actions.
          collapsible: true,
          emptyMessage: listChrome.emptyMessage,
          expandedGroupCwds: threadListUi?.expandedGroupCwds || new Set(),
          formatThreadMeta(thread) {
            return formatRelativeTime(thread.updated_at);
          },
          // Same activity roll-up the local project headers show ("2 working" /
          // "1 needs input"). Attached here rather than in the render model because this
          // is where all three per-thread maps are in scope.
          // `attachProjectSummaries` only decorates groups carrying a projectId, so the
          // bell's state buckets pass through it untouched.
          groups: decoratedGroups,
          includePreview: true,
          onContextThread,
          onThreadActions,
          // The pinned group renders NO header: the chip above the list already names
          // it, and a header row whose only content is a string already on screen was
          // the duplication that got local's title rewritten. Dropped at the ROW level
          // rather than hidden in CSS — the list is virtualized and reserves height for
          // every row it emits.
          hidePinnedGroupHeader: true,
          onResumeThread,
          onToggleExpandedGroup,
          onToggleGroup,
          threadActivity: threadActivityMap,
          threadAttention: threadAttentionMap,
          threadReviewing: threadReviewingSet,
        })
      )
    ),
    // Footer, matching local's: what you are connected to on the left, the way
    // into Settings on the right. The theme picker used to be the footer's only
    // occupant — one preference, permanently on screen, with no home to belong
    // to. It is now the Appearance tab.
    h(
      "div",
      { className: "sidebar-bottom-bar" },
      h(
        "button",
        {
          className: "sidebar-settings-button",
          id: "remote-sidebar-settings",
          onClick: onOpenSettings,
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
        },
        h("span", {
          className: "inline-icon",
          "aria-hidden": "true",
          dangerouslySetInnerHTML: { __html: SETTINGS_SVG },
        })
      )
    ),
    h(SidebarResizeHandle, { id: "remote-sidebar-resize" })
  );
}

// The pinned project, named once. Carries the same activity roll-up the group header
// it replaced used to show, because "which project has something going on" is the one
// thing the header said that the chip would otherwise drop.
function PinnedProjectChip({ name, onClear, summary }) {
  return h(
    "div",
    { className: "pinned-project-chip", id: "remote-pinned-project" },
    h("span", { className: "pinned-project-chip-name", title: name }, name),
    summary?.working
      ? h(
          "span",
          { className: "project-sidebar-badge is-working" },
          `${summary.working} working`
        )
      : null,
    summary?.needsInput
      ? h(
          "span",
          { className: "project-sidebar-badge is-attention" },
          `${summary.needsInput} needs input`
        )
      : null,
    h(
      "button",
      {
        type: "button",
        className: "pinned-project-chip-clear",
        id: "remote-pinned-project-clear",
        title: "Back to the default workspace",
        "aria-label": "Back to the default workspace",
        onClick: onClear,
      },
      "\u00d7"
    )
  );
}





function RemoteHeader({
  currentState,
  deviceChromeModel,
  headerModel,
  activeProjectId,
  hasUsableRelay = false,
  projects = [],
  projectsError = null,
  projectsLoaded = false,
  projectsReady = false,
  onCreateProject,
  onDeleteProject,
  onOpenInfo,
  onOpenStartSession,
  onRenameProject,
  onReturnHome,
  onSelectProject,
  onToggleNavigation,
  statusBadgeModel,
}) {
  const usesDrawer = currentState.remoteNavMode === "drawer";
  const navOpen = currentState.remoteNavOpen;
  const navLabel = navOpen ? "Close sidebar" : "Open sidebar";
  const {
    label: switcherLabel,
    labelTooltip: switcherTooltip,
  } = selectRemoteHeaderProjectSwitcherModel({
    activeProjectId,
    headerModel,
    projects,
    projectsError,
    projectsLoaded,
  });
  const titleNode = hasUsableRelay
    ? h(ProjectSwitcher, {
        activeProjectId,
        label: switcherLabel,
        labelTooltip: switcherTooltip,
        onCreateProject: projectsReady ? onCreateProject : null,
        onDeleteProject: projectsReady ? onDeleteProject : null,
        onRenameProject: projectsReady ? onRenameProject : null,
        onSelectProject,
        projects,
        titleId: "remote-workspace-title",
      })
    : null;

  return h(ConversationHeader, {
    // Remote-only: the drawer hamburger. Local has no drawer, so this slot is the one
    // structural thing the two headers genuinely do not share.
    navToggle: h(
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
    // The back button goes somewhere different here than on local — the relay list, not
    // the console — which is why the label travels with the handler.
    backButtonId: "remote-home-button",
    backHidden: deviceChromeModel.homeButton.hidden,
    backLabel: "All relays",
    onBack: onReturnHome,
    composeButtonId: "remote-new-session-compose-button",
    onCompose: onOpenStartSession,
    leftPanelToggleId: "remote-toggle-left-panel",
    headingId: "remote-chat-heading",
    heading: h(WorkspaceHeading, {
      header: headerModel,
      onOpenInfo,
      statusBadge: statusBadgeModel,
      titleNode,
    }),
    actions: h(
      "button",
      {
        "aria-label": "Toggle side panel",
        className: "header-button header-panel-toggle header-panel-toggle-right",
        id: "remote-toggle-right-panel",
        title: "Toggle side panel (\u2325\u2318B)",
        type: "button",
      },
      h(ToggleRightPanelIcon)
    ),
  });
}

function RemoteThreadPanel({
  onForkFromMessage,
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
  onRepairWorkspace,
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
        onForkFromMessage,
        onSelectRelay,
        onToggleExpandableBlock,
        onToggleTranscriptItem,
        onEnsureFileChangeDetail,
        onSubmitDecision,
        onSubmitAskUserAnswers,
        pendingAskUserQuestions: visiblePendingAskUserQuestions(
          sessionView,
          pendingAskUserQuestions
        ),
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
            // Open the panel straight on the Changes tab — otherwise tapping
            // Changes after Reviewer would land on whatever tab was last open.
            getRemoteWorkspaceDiffStore().setActiveTab("changes");
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
        onRepairWorkspace,
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
            // Mobile: the button label carries the whole meaning, so we drop the
            // longer "Want a second opinion?" copy that wraps to two lines on a
            // narrow composer (the desktop nudge keeps it — it has the room).
            h(ReviewLauncher, {
              panelId: "review-panel-remote-nudge",
              label: "Request reviewer",
              providerOptions: reviewNudgeModel.reviewModel?.providerOptions || [],
              models: reviewNudgeModel.reviewModel?.models || [],
              defaultProvider: reviewNudgeModel.reviewModel?.defaultProvider || "",
              // Same catalog self-heal as the main panel: without these the nudge
              // dialog would show a stuck empty/loading picker for a cross-agent
              // provider whose catalog the boot pre-fetch missed.
              providerModelsStatus: reviewNudgeModel.reviewModel?.providerModelsStatus || {},
              activeProvider: reviewNudgeModel.reviewModel?.activeProvider || "",
              onEnsureProviderModels: reviewNudgeModel.reviewModel?.onEnsureProviderModels,
              reusableReviewers: reviewNudgeModel.reusableReviewers || [],
              parentThreadId: reviewNudgeModel.parentThreadId || null,
              workspace: reviewNudgeModel.workspace || null,
              onPinWorkspace: reviewNudgeModel.onPinWorkspace,
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
          && (!session?.view_only || session?.settings_writable)
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

export function RemoteTranscriptPanel({
  currentState,
  emptyStateModel,
  onApplyFileChange,
  onForkFromMessage,
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
  const transcriptOptionsRef = useRef(null);

  const approval = sessionView?.approval || null;
  const entries = session?.transcript || [];
  const hydrationLoading = Boolean(
    session?.transcript_truncated
      && currentState.transcriptHydrationBaseSnapshot
      && currentState.transcriptHydrationThreadId === session.active_thread_id
      && currentState.transcriptHydrationStatus === "loading"
  );

  // Hoisted via useCallback rather than defined inline below: an inline
  // arrow is a fresh function every render, which would fail
  // transcriptOptionValueEqual's Object.is check on this one field and
  // defeat stableTranscriptOptions no matter how stable everything else is.
  const handleSubmitAskUserAnswers = useCallback(
    (requestId, answers) => {
      void onSubmitAskUserAnswers?.(requestId, answers);
    },
    [onSubmitAskUserAnswers]
  );

  transcriptOptionsRef.current = stableTranscriptOptions(transcriptOptionsRef.current, {
    currentCwd: session?.current_cwd || "",
    detailEntries: transcriptDetailEntries,
    // sessionView is deliberately null for the no-session/relay-home/
    // server-disconnected empty states (see the `sessionView = session ?
    // ... : null` construction above) — this object is built unconditionally
    // on every render now, including those, so this must be null-safe. See
    // remote-transcript-panel-empty-states.test.mjs.
    enableFileChangeActions: Boolean(sessionView?.canWrite),
    expandedItemIds: uiState.transcriptExpandedItemIds,
    expandedKeys: uiState.transcriptExpandedItemIds,
    loadingItemIds: uiState.transcriptLoadingItemIds,
    // The per-message fork button is the ONLY fork entry that works on
    // iOS: thread-row contextmenu never fires for touch long-press.
    canFork: canForkInSession(session),
    // Stamps each agent message with the mark of whoever wrote it.
    provider: session?.provider || "",
    onEnsureFileChangeDetail,
    pendingAskUserQuestions,
    onSubmitAskUserAnswers: handleSubmitAskUserAnswers,
    askUserSubmittingRequestId: uiState.askUserSubmittingRequestId || "",
    askUserErrors: uiState.askUserErrors instanceof Map ? uiState.askUserErrors : new Map(),
    askUserDetailErrors: askUserDetailErrors instanceof Map ? askUserDetailErrors : new Map(),
    askUserDetailLoadingRequestIds:
      askUserDetailLoadingRequestIds instanceof Set
        ? askUserDetailLoadingRequestIds
        : new Set(),
  });
  const transcriptOptions = transcriptOptionsRef.current;

  useRemoteTranscriptScrollBookkeeping({
    currentState,
    entries,
    session,
    threadId: session?.active_thread_id || null,
    transcriptRef,
  });

  let body = null;

  if (emptyStateModel.showMissingCredentials) {
    body = h(MissingCredentialsState, {
      remoteAuth: emptyStateModel.remoteAuth,
    });
  } else if (!session?.active_thread_id) {
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
    } else {
      body = h(ConversationEmptyState, {
        copy: "After pairing, this page will stream the live relay transcript through the broker.",
        title: "No remote session yet",
      });
    }
  } else {
    body = h(TranscriptPane, {
      approval,
      canWrite: sessionView.canCompose,
      emptyContent: null,
      entries,
      hydrationLoading,
      readyState: {
        readyCopy: "The remote session is live. Send the first prompt below when you're ready.",
        session,
        shortId,
        waitingCopy: "This session is already open, but another device currently has control. You can still approve or decline requests here; take over only if you want to send messages from this device.",
      },
      transcriptOptions,
      // The same dispatcher the local surface uses. This chain had drifted from
      // that one in ways nobody chose: it alone handled a bare `data-expand-key`
      // summary, and it alone called preventDefault. Both are preserved here —
      // the drift is now visible as which keys this surface supplies.
      onTranscriptInteract: createTranscriptInteractionHandler({
        copyMessage: ({ text, element }, event) => {
          event.preventDefault();
          void copyTextToClipboard(text, element);
        },
        forkFromItem: ({ itemId }, event) => {
          event.preventDefault();
          onForkFromMessage?.(session?.active_thread_id || "", itemId);
        },
        fileChangeAction: ({ itemId, action }, event) => {
          event.preventDefault();
          if (itemId && (action === "rollback" || action === "reapply")) {
            void onApplyFileChange?.(itemId, action);
          }
        },
        approvalDecision: ({ decision, scope }) => onSubmitDecision(decision, scope),
        // A group header carries an expand key AND a toggle attribute; this
        // surface has always treated both as the same gesture.
        toggleGroup: ({ expandKey }, event) => {
          event.preventDefault();
          onToggleExpandableBlock?.(expandKey);
        },
        expandBlock: ({ expandKey }, event) => {
          event.preventDefault();
          onToggleExpandableBlock?.(expandKey);
        },
        toggleEntry: ({ itemId }) => void onToggleTranscriptItem?.(itemId),
      }),
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
  pushModel,
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
      h(RemoteNotificationsSection, {
        pushModel,
      }),
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

function RemoteNotificationsSection({ pushModel }) {
  // Purely informational: enrollment rides device pairing and the browser's own
  // notification permission is the on/off switch, so there's no in-app control.
  const hint = remoteNotificationsHint(pushModel || {});

  return h(
    "section",
    { className: "details-section" },
    h("h3", { className: "details-heading" }, "Notifications"),
    hint ? h("p", { className: "details-hint", id: "remote-push-status" }, hint) : null
  );
}

// The per-session actions sheet — remote's answer to local's right-click menu.
//
// A bottom sheet rather than a cursor-anchored popover: there is no cursor on a phone,
// the drawer is too narrow to hang a menu off a row, and a sheet puts the targets within
// thumb reach. Built on ManagedDialog so it inherits Esc/backdrop dismissal and the
// no-showModal fallback the other two remote modals already rely on.
//
// It renders descriptors and nothing else — what a session offers is decided by
// selectThreadSheet. Two different rules apply there: an action with no remote
// transport (archive, delete) is absent entirely, while one that merely cannot run
// right now (fork on a running session) is present and disabled, saying why.
function ThreadActionsSheet({ onClose, onSelect, open, sections, threadTitle }) {
  return h(
    ManagedDialog,
    {
      className: "panel-modal thread-actions-sheet",
      id: "remote-thread-actions-sheet",
      open,
      onRequestClose: onClose,
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, threadTitle || "Session"),
      h(
        "button",
        {
          type: "button",
          className: "header-button close-modal-btn",
          id: "close-thread-actions-sheet",
          onClick: onClose,
          "aria-label": "Close",
        },
        "×"
      )
    ),
    h(
      "div",
      { className: "panel-modal-body" },
      // Openness is decided at tap time against a session that HAD actions, but that
      // session can disappear underneath an open sheet (archived elsewhere, list
      // refreshed). Say so rather than leave a blank sheet on screen.
      sections.length
        ? null
        : h("p", { className: "thread-actions-empty" }, "This session is no longer available."),
      ...sections.map((section) =>
        h(
          "div",
          { className: "thread-actions-group", key: section.kind },
          h("p", { className: "thread-actions-group-label" }, section.label),
          ...section.items.map((item, index) =>
            h(
              "button",
              {
                type: "button",
                // The thread's own project is marked rather than filtered out, so the
                // list answers "where does this live" as well as "where can it go".
                className: `thread-actions-item${item.isCurrent ? " is-current" : ""}`,
                key: `${item.kind}:${item.projectId || index}`,
                // Present but refused — the label says why (a running session cannot be
                // forked; the projects payload is not trustworthy yet). Actions remote
                // has no transport for are absent entirely rather than disabled here.
                disabled: Boolean(item.disabled),
                onClick: item.disabled ? undefined : () => onSelect(item),
              },
              h("span", { className: "thread-actions-item-label" }, item.label),
              item.isCurrent
                ? h("span", { className: "thread-actions-item-check", "aria-label": "Current project" }, "✓")
                : null
            )
          )
        )
      )
    )
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
