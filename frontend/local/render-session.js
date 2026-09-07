import {
  appShell,
  auditSummary,
  auditTimeline,
  chatShell,
  composerError,
  controlBanner,
  goConsoleHomeButton,
  sidebarHostStatus,
  sidebarHostLabel,
  localModelBadge,
  messageForm,
  messageInput,
  openSessionDetailsButton,
  overviewSecurityBadges,
  pairingApprovalHint,
  pairingApprovalModal,
  pendingActionBanner,
  providerStatusList,
  sendButton,
  sessionHistoryDrawer,
  sessionMeta,
  sessionDetailsPath,
  composerSettingsMount,
  reviewIdleNudge,
  messageEffort,
  statusBadge,
  stopButton,
  threadsCount,
  threadsList,
  projectOverviewMount,
  taskTeamMount,
  teamsLibraryMount,
  reviewScreenMount,
  usageReportMount,
  sidebarTaskListMount,
  sidebarTeamsListMount,
  sidebarNavMount,
  iconRailNavMount,
  sidebarTopActionsMount,
  sidebarSearchMount,
  transcript,
  workspaceSubtitle,
  workspaceSuggestionsList,
} from "./dom.js";
import {
  imageFileToDataUrl,
  pastedImageFiles,
  validateImageAttachments,
} from "./image-attachments.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  buildNavigationThreadGroups,
  canonicalizeWorkspace,
  selectPinnedProjectId,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import { selectOwningContext } from "../shared/session-view-state.js";
import { shouldShowAuditEntry } from "../shared/audit-log.js";
import { composerErrorFor, syncComposerError } from "./composer-error.js";
import { selectWorkspaceSuggestionsModel } from "../shared/workspace-suggestions.js";
import { isUnknownWorkspace } from "../shared/thread-groups.js";
import {
  findVisibleThread,
  isThreadSearchActive,
  selectThreadListView,
} from "../shared/thread-search.js";
import {
  composeListChrome,
  isThreadFilterActive,
  nextRetainedStates,
  selectThreadFilterView,
} from "../shared/thread-filter.js";
import { selectThreadState } from "../shared/thread-dot.js";
import { canForkInSession } from "../shared/fork-fields.js";
import {
  readActiveProjectId,
  readSearchUi,
  readThreadFilter,
  readThreadListContextMenu,
  readThreadListUi,
} from "../shared/thread-list-store.js";
import { ProjectOverview, ProjectSidebarList } from "../shared/project-overview-react.js";
import {
  attachProjectSummaries,
  selectProjectAgents,
  sortProjectCards,
  summarizeProjectActivity,
} from "../shared/project-overview-model.js";
import {
  loadProjectPrefs,
  toggleProjectPin,
  setProjectOrder,
} from "./project-overview-prefs.js";
import {
  readLocalUiState,
} from "./ui-store.js";
import { providerLabel, selectModelBadge } from "../shared/provider-labels.js";
import { providerStatusMeta } from "../shared/provider-status.js";
import { isProgressStalled } from "../progress-verbs.js";
import {
  earliestPairingExpiry,
  filterActivePairings,
  formatPendingPairingsBannerLabel,
  pairingNowSeconds,
} from "../shared/pairing-helpers.js";
import {
  buildExpandedTranscriptDetailEntries,
  collectFileChangeDetailItemIds,
} from "./transcript/details.js";
import { shouldShowTranscriptLoading } from "./transcript-loading.js";
import { adoptSettledTranscript } from "./transcript/store.js";
import {
  ConversationEmptyState,
} from "../shared/conversation.js";
import { SessionSettingsButton } from "../shared/session-settings-panel.js";
import {
  ReviewLauncher,
} from "../shared/review-panel.js";
import {
  createReviewsCache,
  reviewCardsForViewedThread,
  reusableReviewersFromReviews,
} from "../shared/reviews-cache.js";
import { createWorkflowsCache } from "../shared/workflows-cache.js";
import { createTeamsCache } from "../shared/teams-cache.js";
import {
  sortTeamRuns,
  teamsNeedingYou,
  teamsRevisionOf,
} from "../shared/task-team-model.js";
import { loadSeenTasks } from "./task-seen-prefs.js";
import { tasksLocked, usageLocked } from "../shared/beta-gate.js";
import { TaskSidebarList, TaskTeamScreen } from "../shared/task-team-react.js";
import { createOrchestratorChatActions } from "../shared/orchestrator-chat.js";
import { orchestratorCanWrite } from "../shared/orchestrator-write-gate.js";
import { TaskDiffPane } from "../shared/task-diff-react.js";
import { TaskReviewScreen } from "../shared/task-review-screen.js";
import {
  BUILTIN_TEAM_ID,
  listLibraryTeams,
  TeamsLibraryScreen,
  TeamsSidebarList,
} from "../shared/teams-library-react.js";
import { teamsFromCatalog } from "../shared/teams-library-model.js";
import { UsageReportScreen } from "../shared/usage-report-react.js";
import { windowForBucket } from "../shared/usage-windows.js";
import { SidebarNav, SidebarNavRail } from "../shared/sidebar-nav.js";
import {
  SidebarBellToggle,
  SidebarSearchField,
  SidebarSearchToggle,
} from "../shared/sidebar-chrome.js";
import {
  buildReviewingThreadSet,
  canRequestReview,
  isReviewBlocked,
  isReviewInProgressForThread,
  reviewStatusLabel,
  selectReviewLaunchModel,
} from "../shared/review-state.js";
import {
  canStartWorkflow,
  isWorkflowBlocked,
  isWorkflowInProgressForThread,
  selectWorkflowLaunchModel,
  workflowRunsForThread,
} from "../shared/workflow-state.js";
import {
  projectViewOnlySession,
  VIEW_ONLY_LOAD_RETRY_BACKOFF_MS,
} from "./view-only-thread.js";
import { selectControlBannerModel } from "./control-banner.js";
import { readWorkspaceRepair } from "./workspace-repair.js";
import { canComposeThread, composerButtonState } from "../shared/thread-compose.js";
import { saveLastEffort } from "../shared/last-used-settings.js";
import {
  AuditList,
  ControlBannerContent,
  OverviewBadges,
  SessionMetaPanel,
  TextContent,
} from "./react-session-panels.js";
import { ThreadGroupList } from "../shared/thread-list-react.js";
import { buildThreadActivityMap, threadActivityFor } from "../shared/thread-activity.js";
import {
  applyOlderOrchestratorPage,
  applyOrchestratorLoadFinally,
  applyRefreshedOrchestratorPage,
  beginOrchestratorLoad,
  nextOrchestratorRefreshObservations,
  nextOrchestratorWasWorking,
  orchestratorRefreshPin,
  orchestratorTranscriptRefreshDecision,
  takeDeferredOrchestratorRefresh,
} from "./orchestrator-transcript-refresh.js";
import { createViewedThreadRefreshLatch } from "../shared/viewed-thread-refresh.js";
import { copyTextToClipboard } from "../shared/clipboard.js";
import { attachTranscriptHistoryLoader } from "../shared/transcript-history-loader.js";
import { createTranscriptInteractionHandler } from "../shared/transcript-interactions.js";
import { describeStatusChips } from "../shared/session-status.js";
import { selectStatusBadge } from "./status-badge.js";
import { selectHeaderLabels } from "../shared/header-labels.js";
import { selectStandbyEmptyModel, buildStandbyEmptyActions } from "./standby-empty-state.js";
import {
  pendingAskUserQuestionsForThread,
  sessionIsWorking,
  threadAttention,
} from "../shared/thread-attention.js";
import {
  configureThreadNotifications,
  ensureNotificationPermission,
  isDocumentForeground,
} from "../shared/thread-notify.js";
import { LocalTranscriptPanel } from "./local-transcript-panel.js";

const h = React.createElement;
const reactRoots = new WeakMap();
let transcriptRoot = null;
let transcriptRootElement = null;
let attentionFocusListenerAttached = false;

function renderReactContent(element, content) {
  if (!element) {
    return;
  }

  let root = reactRoots.get(element);
  if (!root) {
    root = createRoot(element);
    reactRoots.set(element, root);
  }

  flushSync(() => {
    root.render(content);
  });
}

function renderConversationContent(content) {
  if (!transcript) {
    return;
  }

  if (transcriptRootElement !== transcript) {
    transcriptRoot?.unmount();
    transcriptRoot = createRoot(transcript);
    transcriptRootElement = transcript;
  }

  flushSync(() => {
    transcriptRoot.render(content);
  });
}

export function createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
  renderPairingApprovalModal,
  resolveActiveThread,
  setSelectedCwd,
  resumeSession,
  openThreadContextMenu,
  closeThreadContextMenu,
  onRenameProject,
  onDeleteProject,
  scheduleControllerHeartbeat,
  scheduleControllerLeaseRefresh,
  cancelControllerHeartbeat,
  cancelControllerLeaseRefresh,
  // Late-bound like the two above: the flush scheduler is owned by
  // session-controller.js, built from a `controller` app.js assigns after
  // this renderer. renderSession calls this itself (not just app.js's wrap
  // around the exported property) so internal closures below — teamsCache
  // /reviewsCache/workflowsCache callbacks, the pairing-expiry timer — that
  // call renderSession directly still clear a pending scheduler flush
  // instead of leaving it to double-render. See .sealwire/PLAN.md.
  cancelPendingTranscriptFlush = () => false,
  logLine,
  ingestRelayLogs,
  escapeHtml,
  formatTimestamp,
  formatRelativeTime,
  humanizeLabel,
  shortId,
  workspaceBasename,
  canCurrentDeviceWrite,
  controllerLabel,
  controllerStateLabel,
  isCurrentDeviceActiveController,
  isViewingConversation,
  securityModeLabel,
  contentVisibilityLabel,
  brokerStatusLabel,
  pairedDeviceCountLabel,
  ensureConversationTranscript,
  // Passed straight through to LocalTranscriptPanel's history loader — it
  // closes over app.js's late-bound `controller`/`loadOlderViewOnlyTranscript`,
  // the same late-binding as resumeSession/scheduleControllerHeartbeat above.
  loadOlderTranscript,
  syncComposerModel,
  updateSessionSettings,
  requestReview,
  startWorkflow,
  setReviewSlice,
  // Same ResolvedWorkspace the Changes/Reviewer panels read, so all three stay aligned.
  getThreadWorkspace = () => null,
  pinThreadWorkspace = null,
  // Grant this relay permission to run git in a tree, offered inside the review dialog
  // when the tree it is about to review is one the relay may not read. Local surface
  // only — the remote shell renders its own nudge and passes nothing here.
  trustThreadWorkspace = null,
  reviewsCache = createReviewsCache(),
  workflowsCache = createWorkflowsCache(),
  fetchReviews,
  fetchWorkflows,
  viewThread,
  // Re-render the open-session tab strip. Injected (rather than imported) because
  // it owns its own React sub-root over in app.js, same as the client log.
  renderProjectSwitcher = () => {},
  renderSessionTabs = () => {},
  enterProjectOverview,
  startProjectAgent,
  openProjectContextMenu,
  // ---- Task screen ----
  // `getViewContext` rather than a derived boolean: the context is the canonical
  // answer to "what is on screen", and the Task screen needs both halves of it
  // (which screen, and which task).
  teamsCache = createTeamsCache(),
  fetchTeams,
  fetchUsage,
  fetchTeamCatalog,
  ensureOrchestrator,
  resetOrchestrator,
  fetchTeamDiff,
  fetchTaskLineComments,
  createTaskLineComment,
  resolveTaskLineComment,
  handBackTaskLineComment,
  fetchTaskReviewTicks,
  tickTaskReviewFile,
  proposeOrchestratorTask,
  confirmOrchestratorProposal,
  reviseOrchestratorProposal,
  dismissOrchestratorProposal,
  sendMessage,
  fetchTranscriptPage,
  setUsageBudget,
  getViewContext = () => ({ kind: "sessions" }),
  // The sidebar nav's two destinations. Injected, not imported: the shared component
  // takes `current` in and emits these out, which is the entire seam that keeps it from
  // learning about local's `session-view-state.js` — a real state machine with
  // invariants that remote has no equivalent of.
  onOpenSessionsScreen = () => {},
  onOpenTasksScreen = () => {},
  onOpenUsageScreen = () => {},
  onOpenTeamsScreen = () => {},
  // Reached from a task's changes summary rather than from the sidebar, so it
  // carries the run id the other destinations do not need.
  onOpenReviewScreen = null,
  // The sidebar's narrowing controls. Injected because each carries a TRANSPORT: the
  // search field's debounce plus its HTTP query, and the bell's re-render of the list.
  // The components see neither — only these callbacks.
  onSetSearchOpen = () => {},
  onSearchInput = () => {},
  onToggleActivityFilter = () => {},
  onOpenTask,
  onBackToTasks,
  onTeamAction,
  onStartTask,
}) {
  // Look a thread up across everything the user can currently see — the authoritative
  // list plus any search result from beyond it. Lookups only; see `findVisibleThread`.
  const findVisible = (threadId) =>
    findVisibleThread({ threads: state.threads, search: state.threadSearch }, threadId);

  // Notifications navigate locally; looking at a thread never resumes it.
  configureThreadNotifications({
    resolveThreadName: (threadId) => {
      const thread = findVisible(threadId);
      return thread ? thread.name || thread.preview || shortId(threadId) : null;
    },
    onActivateThread: (threadId) => {
      if (typeof viewThread === "function") {
        viewThread(threadId);
      }
    },
  });

  // When the tab regains focus, clear the dot on the thread the user is looking
  // at (the tracker only does this on the next snapshot, which may not arrive
  // for an idle thread). Attached once per page.
  if (!attentionFocusListenerAttached && typeof window !== "undefined") {
    attentionFocusListenerAttached = true;
    const clearViewedDot = () => {
      threadAttention.clearViewedOnFocus(isDocumentForeground());
      renderThreads();
    };
    window.addEventListener("focus", clearViewedDot);
    document.addEventListener("visibilitychange", clearViewedDot);
  }

  function reviewChips(session) {
    // The session-details panel describes the active thread, so only surface its
    // OWN review(s) — not reviews running on (or lingering for) other threads.
    const activeThreadId = session?.active_thread_id || null;
    return (reviewsCache?.current()?.review_jobs || [])
      .filter((job) => job.parent_thread_id === activeThreadId)
      .map((job) => metaChip("Review", reviewStatusLabel(job.status)));
  }

  function reviewLaunchModel(session) {
    return selectReviewLaunchModel({
      providers: state.providers || [],
      providerModels: state.providerModels || {},
      session,
    });
  }

  function workflowLaunchModel(session) {
    return selectWorkflowLaunchModel({
      providers: state.providers || [],
      providerModels: state.providerModels || {},
      session,
    });
  }

  function renderSession(session) {
    // Must run before anything else: some call sites below (teamsCache.sync's
    // resolve, the pairing-expiry timer, …) read state.session as their
    // argument BEFORE settling ran, so it can still be the pre-projection
    // object — adoptSettledTranscript grafts the freshly-settled transcript
    // back in when that's the case.
    session = adoptSettledTranscript(state, session, cancelPendingTranscriptFlush());
    state.session = session;
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("agent-relay:session-updated"));
    }
    // From here down, render the (possibly read-only) projection — never `state.session`
    // directly — so ANY non-active thread the user is viewing shows its own
    // conversation read-only instead of the console home. `state.session` stays the
    // REAL session so heartbeat / lease / controller / nav keep using it.
    session = projectViewOnlySession(session, {
      viewThreadId: state.viewThreadId,
      viewOnlyThread: state.viewOnlyThread,
    });
    syncComposerModel?.(session);

    const approval = session.pending_approvals[0] || null;
    const pendingPairings = filterActivePairings(session.pending_pairing_requests || []);
    const activeThread = resolveActiveThread(session.active_thread_id);
    const hasActiveSession = Boolean(session.active_thread_id);
    const viewingConversation = isViewingConversation(session);
    const canWrite = canCurrentDeviceWrite(session);
    const turnRunning = Boolean(session.active_turn_id);
    const threadWorking = sessionIsWorking(session);
    const reviewBlocked = isReviewBlocked(session);
    const workflowBlocked = isWorkflowBlocked(session);
    // The composer is frozen only when the thread you're looking at is itself
    // owned by a review/workflow. Background work on another thread leaves the
    // active conversation usable.
    const activeThreadUnderReview = isReviewInProgressForThread(session, session.active_thread_id);
    const activeThreadUnderWorkflow = isWorkflowInProgressForThread(
      session,
      session.active_thread_id
    );
    const activeThreadFrozen = activeThreadUnderReview || activeThreadUnderWorkflow;
    // Not folded into `activeThreadFrozen`: that flag also hides Stop and gates
    // AskUser, and a reviewer's own turn is still stoppable while it runs.
    const taskReviewer = Boolean(session.active_thread_task_reviewer);
    // In a read-only view, the workspace is the saved thread's own cwd (or blank
    // when unknown) — never the user's currently-selected cwd, which would
    // misrepresent the saved thread.
    const workspace = session.view_only
      ? session.current_cwd || ""
      : session.current_cwd || state.selectedCwd || "";
    const viewingSessionDetails = Boolean(sessionMeta?.closest("dialog")?.open);
    const viewingSecurityDetails = Boolean(
      document.querySelector("#settings-modal")?.open
    );
    const threadListUi = readThreadListUi(state.threadListStore);
    state.currentApprovalId = approval?.request_id || null;

    const activeProjectId = readActiveProjectId(state.threadListStore);

    // Title/subtitle rules live in one tested place (header-labels.js): the title
    // names the CONTAINER (project in Projects mode, folder in Sessions mode) so it
    // stops duplicating the session tab strip underneath. See that module for the
    // rationale, including why the old "title = thread" rule was dropped.
    const threadLabel = session.active_thread_id
      ? activeThread?.name || activeThread?.preview || shortId(session.active_thread_id)
      : "";
    const activeProject = activeProjectId
      ? (state.projects || []).find((project) => project.id === activeProjectId) || null
      : null;
    const headerLabels = selectHeaderLabels({
      hasWorkspace: Boolean(workspace),
      activeThreadId: session.active_thread_id,
      viewingConversation,
      viewOnly: session.view_only,
      reviewInProgress: Boolean(state.viewOnlyThread?.review),
      threadLabel,
      projectId: activeProjectId,
      projectName: activeProject?.name || "",
      workspaceName: workspace ? workspaceBasename(workspace) : "",
      workspacePath: workspace,
    });
    // The title is the switcher's trigger now, so it is rendered rather than
    // written: one control, one owner. `header-labels.js` still decides the text.
    renderProjectSwitcher({
      label: headerLabels.title,
      labelTooltip: headerLabels.titleTooltip,
    });
    workspaceSubtitle.textContent = headerLabels.subtitle;

    // Three-way main view: a live/read-only conversation always wins; otherwise, in
    // Projects mode with a selected project, the card overview replaces the console
    // home. `mainView` drives the CSS show/hide of the three main-area layouts.
    // The main-area card overview is RETIRED FROM VIEW, not deleted. Sessions now live
    // nested under their project in the sidebar, so the cards would duplicate that list;
    // the component, its model and its pin/order prefs all stay because those prefs back
    // the sidebar rows and the card layout may return for another purpose. Flip this back
    // to `!viewingConversation && Boolean(activeProjectId)` to resurrect it — the
    // `projectsViewMode` half of that condition went with the Sessions/Projects toggle.
    const showProjectOverview = false;
    void activeProjectId;
    // The Task screen is decided by the CONTEXT, not by what is or is not open.
    // Its context routes no thread (SHOW_OVERVIEW sets threadId null), so
    // `viewingConversation` is already false whenever it is showing — but reading
    // the context first keeps the two from ever disagreeing about what is on
    // screen, which is the whole reason `location` is canonical.
    const viewKind = getViewContext()?.kind;
    const onTaskScreen = viewKind === "tasks";
    const onTeamsScreen = viewKind === "teams";
    const onUsageScreen = viewKind === "usage";
    const onReviewScreen = viewKind === "review";
    const mainView = onUsageScreen
      ? "usage"
      : onTeamsScreen
        ? "teams"
        : onReviewScreen
          ? "review"
          : onTaskScreen
            ? "tasks"
            : viewingConversation
              ? "conversation"
              : showProjectOverview
                ? "project-overview"
                : "console";
    if (chatShell) {
      chatShell.dataset.view = mainView;
    }
    if (appShell) {
      appShell.dataset.view = mainView;
    }
    // No `document.body.dataset.view` mirror any more, and no `aria-current` sweep over
    // the nav rows. Both existed to solve the same problem in two places: the nav was
    // static markup, so "which destination am I on" had to reach it from outside — as a
    // CSS selector on an ancestor attribute (`body[data-view]` for the rail,
    // `.app-shell[data-view]` for the rows) AND as an imperative accessibility write
    // here, because CSS cannot set `aria-current`. Two writes, one fact, free to
    // disagree.
    //
    // `renderSidebarNav()` below now passes the destination in as a prop, and the shared
    // component sets the class and `aria-current` from the same comparison. `appShell`
    // and `chatShell` keep their `data-view` because other rules genuinely switch on it
    // (which sidebar BODY shows, whether the transcript is mounted) — that is a layout
    // switch, not a duplicate of the nav's state.
    if (sessionHistoryDrawer) {
      // A pinned project keeps the drawer open: picking one is a request to see its
      // sessions, and the old rule (open only while viewing a conversation) left the
      // drawer collapsed — measurable but clipped — whenever no session was open,
      // hiding the whole list. `projectsViewMode` here became `activeProjectId` when the
      // toggle went; the reason is unchanged.
      sessionHistoryDrawer.open =
        viewingConversation || Boolean(activeProjectId) || Boolean(threadListUi.drawerOpen);
    }

    syncThreadHistoryScroll();

    // One salience-ordered decision in a single tested place (status-badge.js), so
    // the provider-outage and task labels come from the shared session-status seam
    // instead of a second hardcoded copy that silently drifts. Local-only transient
    // states (pairing, blocked/in-progress review, a stalled turn) layer on top.
    const statusBadgeModel = selectStatusBadge({
      session,
      approval,
      pendingPairingCount: pendingPairings.length,
      reviewBlocked,
      workflowBlocked,
      stalled: isProgressStalled(session),
      activeThreadFrozen,
      activeThreadWorkflowFrozen: activeThreadUnderWorkflow,
    });
    statusBadge.textContent = statusBadgeModel.text;
    statusBadge.className = `status-badge status-badge-${statusBadgeModel.tone}`;
    renderHeaderModelBadge(session);
    // Provider status is relay-global; read the real session, not the
    // (possibly view-only) projection above.
    renderProviderStatus(state.session);
    renderHostStatus();

    if (!viewingConversation) {
      renderOverviewState(session);
    }
    // "Recent events" now lives in the Settings > Log tab; keep it fresh in every
    // view (including while a conversation is open) so opening Settings shows current data.
    renderAuditTimeline(session.logs || []);
    if (showProjectOverview) {
      renderProjectOverview();
    }
    // Sync the Teams channel on EVERY render, not only while the Task screen is
    // open. It is revision-gated, so an unchanged run set costs nothing — and the
    // sidebar badge has to be able to say "a task is waiting on you" from wherever
    // the user happens to be, which is the whole point of walking away from one.
    // …unless Tasks is locked: the server returns an empty list, so this would
    // be one request per revision for a feature the user cannot open.
    if (typeof fetchTeams === "function" && !tasksLocked(session)) {
      void teamsCache.sync(
        teamsRevisionOf(session),
        () => fetchTeams(),
        () => renderSession(state.session || session),
        (error) => {
          // Reported, not swallowed: a relay answering 500 forever otherwise looks
          // exactly like a slow one. Re-render only on a CHANGE, or a failing
          // endpoint would drive a render per frame.
          const next = error ? error.message || String(error) : null;
          if (state.teamsError !== next) {
            state.teamsError = next;
            renderSession(state.session || session);
          }
        }
      );
    }
    renderSidebarNav();
    renderSidebarChrome();
    renderSidebarTaskList();
    renderSidebarTeamsList();
    if (!onTaskScreen) {
      // Cleared HERE, not in renderTaskTeam, which only ever runs while the
      // Tasks screen is up and so can never say "and now it isn't". Left set,
      // it would keep claiming the Orchestrator is on screen and send the
      // conversation's own detail fetches to the wrong thread.
      state.orchestratorOnScreenThreadId = null;
    }
    if (onTaskScreen) {
      renderTaskTeam(session);
      if (!state.teamCatalog && !state.teamCatalogLoading && !tasksLocked(session)) {
        state.teamCatalogLoading = true;
        void loadTeamCatalog().finally(() => {
          state.teamCatalogLoading = false;
        });
      }
    }
    if (onTeamsScreen) {
      renderTeamsLibrary(session);
      if (!state.teamCatalog && !state.teamCatalogLoading) {
        state.teamCatalogLoading = true;
        void loadTeamCatalog().finally(() => {
          state.teamCatalogLoading = false;
        });
      }
    }
    if (onReviewScreen) {
      renderReviewScreen();
    }
    if (onUsageScreen) {
      if (!state.usageReport && !state.usageLoading && !state.usageError) {
        void loadUsageReport(state.usageBucket || "day");
      } else {
        renderUsageReport();
      }
    }
    if (!viewingConversation || viewingSessionDetails) {
      renderSessionMeta(session);
    }
    if (!viewingConversation || viewingSecurityDetails) {
      renderAllowedRoots(session.allowed_roots || [], {
        draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
      });
      renderPairingPanel(state.currentPairing);
      renderDeviceRecords(session.device_records || []);
      renderPendingPairingRequests(pendingPairings, state.pendingPairingDecisions || {});
    }
    renderPairingApprovalModal(pendingPairings, state.pendingPairingDecisions || {});
    announceNewPendingPairings(pendingPairings);
    syncPairingApprovalDialog(pendingPairings);
    schedulePairingExpiryTick(pendingPairings);
    renderControlBanner(session);
    renderSessionSettingsPanel(session);
    renderReviewSlice(session);
    renderReviewIdleNudge(session);
    renderPendingActionBanner(approval, pendingPairings, session);
    renderWorkspaceSuggestions(session);
    renderTranscript(session, approval);
    renderLogs(session.logs);
    syncThreadSelection();
    syncThreadHistoryScroll();
    restoreThreadHistoryScroll();
    if (
      viewingConversation &&
      session.active_thread_id &&
      session.transcript_truncated &&
      // A read-only projection paginates through its own pin (app.js
      // loadOlderViewOnlyTranscript). Feeding the projection into the shared
      // hydration pipeline would re-key the hydration store — which belongs to
      // the LIVE thread — to the viewed thread and clobber it.
      !session.view_only
    ) {
      ensureConversationTranscript?.(session);
    }
    // Heartbeat/lease must track the REAL session, not the read-only projection.
    // The projection's controller is the "__view_only__" sentinel, so passing it
    // here would cancel the controller heartbeat and let the real lease expire
    // (15s) while you merely browse a saved thread — handing control to another
    // device. state.session is the real session (set at the top of renderSession).
    scheduleControllerHeartbeat(state.session);
    scheduleControllerLeaseRefresh(state.session);

    openSessionDetailsButton.disabled = false;
    if (goConsoleHomeButton) {
      goConsoleHomeButton.hidden = !viewingConversation;
    }
    messageForm.hidden = !viewingConversation;
    // An idle thread is open to either local or remote. The targeted send is the
    // atomic claim; only an already-running turn remains controller-gated.
    const canCompose = canComposeThread({
      activeTurnId: session.active_turn_id,
      hasActiveSession,
      hasControllerLease: canWrite,
      reviewLocked: activeThreadFrozen || Boolean(state.viewOnlyThread?.review),
      taskReviewer,
    });
    // Frozen while a submit is in flight (app.js runComposerSubmit) so a
    // draft edit or second submit can't change or duplicate the in-flight send.
    const submitInFlight = Boolean(state.composerSubmitInFlight);
    const composerReady = hasActiveSession && canCompose && viewingConversation;
    // Send and Stop are mutually exclusive: a running turn shows Stop, never Send
    // (no pending-message queue yet). The view-only observer of a background turn
    // gets Stop too, so Send must hide for them — not only for the controller.
    const buttons = composerButtonState({
      composerReady,
      turnRunning,
      threadWorking,
      activeThreadFrozen,
      canWrite,
      viewOnly: session.view_only,
      submitInFlight,
    });
    // A failure belongs to the thread it happened to. Re-deciding it here means
    // navigation alone hides it — no clearing hook to forget on a new route.
    syncComposerError(composerError, state.viewThreadId || session?.active_thread_id || null);
    sendButton.disabled = buttons.sendDisabled;
    sendButton.hidden = buttons.sendHidden;
    if (stopButton) {
      stopButton.hidden = buttons.stopHidden;
      stopButton.disabled = buttons.stopDisabled;
    }
    messageInput.disabled =
      !hasActiveSession ||
      !canCompose ||
      !viewingConversation ||
      activeThreadFrozen ||
      submitInFlight;
    messageInput.placeholder = taskReviewer
      ? "This is a task reviewer — read only."
      : activeThreadFrozen
      ? activeThreadUnderWorkflow
        ? "This session is locked by Code Flow…"
        : "This session is being reviewed…"
      : !hasActiveSession
      ? "Start or open a session first."
      : !viewingConversation
        ? "Open the session page to send a message."
        : canCompose
          // Name the active thread's own provider — never a hardcoded "Codex".
          ? (providerLabel(session?.provider)
            ? `Message ${providerLabel(session.provider)}...`
            : "Message...")
          : "This session is currently running on another device.";
  }

  function renderSessionUnavailable(message) {
    // The nav is chrome, not session content: an offline relay is still a moment where
    // the user needs to be able to move between Sessions and Tasks. It used to be static
    // markup in the shell and could not go missing; mounted, it has to be rendered by
    // every top-level state or it silently is not there.
    renderSidebarNav();
    renderSidebarChrome();
    renderOverviewState(null, message);
    renderWorkspaceSuggestions(null);
    renderHeaderModelBadge(null);
    renderProviderStatus(null);
    renderHostStatus();
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
    if (sessionDetailsPath) {
      sessionDetailsPath.textContent = "No workspace path yet.";
    }
    renderReactContent(
      sessionMeta,
      h(SessionMetaPanel, { emptyMessage: message })
    );
    renderConversationContent(
      h(ConversationEmptyState, {
        copy: message,
        title: "Relay unavailable",
      })
    );
  }

  function renderAuthRequiredState(message) {
    state.session = null;
    state.threads = [];
    state.threadGroups = [];
    // This path runs at BOOT whenever there is no API token, so it is the first thing a
    // signed-out user sees. Without this the sidebar rendered with no destinations in it
    // at all — the nav was static markup before it was a mount, so nothing had to think
    // about which states repaint it.
    renderSidebarNav();
    renderSidebarChrome();
    cancelControllerHeartbeat();
    cancelControllerLeaseRefresh();
    // Clear the independently-mounted Reviewer tab so it does not retain job
    // metadata or already-fetched review text after the user signs out.
    if (typeof setReviewSlice === "function") {
      setReviewSlice({
        reviewJobs: [],
        workflowRuns: [],
        reviewModel: {},
        workflowModel: {},
        canRequest: false,
        canStartWorkflow: false,
        blocked: false,
      });
    }
    openSessionDetailsButton.disabled = true;
    renderHostStatus();
    renderOverviewState(null, message);
    renderWorkspaceSuggestions(null);
    renderThreadListMessage("Sign in", "Enter RELAY_API_TOKEN to load sessions.");
    renderHeaderModelBadge(null);
    renderProviderStatus(null);
    statusBadge.textContent = "Sign in";
    statusBadge.className = "status-badge status-badge-offline";
    if (sessionDetailsPath) {
      sessionDetailsPath.textContent = "No workspace path yet.";
    }
    renderReactContent(
      sessionMeta,
      h(SessionMetaPanel, { emptyMessage: message })
    );
    renderConversationContent(
      h(ConversationEmptyState, {
        copy: message,
        title: "Authentication required",
      })
    );
  }

  let pairingExpiryTimer = null;
  let pairingHintTimer = null;
  function schedulePairingExpiryTick(requests) {
    if (pairingExpiryTimer) {
      clearTimeout(pairingExpiryTimer);
      pairingExpiryTimer = null;
    }
    if (!requests.length) {
      return;
    }
    const earliest = earliestPairingExpiry(requests);
    if (earliest === null) {
      return;
    }
    // +250ms buffer so the request is past its deadline when we re-render.
    const delay = Math.max(50, (earliest - pairingNowSeconds()) * 1000 + 250);
    pairingExpiryTimer = setTimeout(() => {
      pairingExpiryTimer = null;
      if (state.session) {
        renderSession(state.session);
      }
    }, delay);
  }

  function updatePairingHint(requests) {
    if (!pairingApprovalHint) {
      return;
    }
    const earliest = earliestPairingExpiry(requests);
    const remaining = earliest !== null ? Math.max(0, earliest - pairingNowSeconds()) : null;
    pairingApprovalHint.textContent = remaining !== null
      ? `A remote device is requesting access. ${remaining}s remaining before this request expires.`
      : "A remote device is requesting access.";
  }

  function syncPairingApprovalDialog(requests) {
    if (!pairingApprovalModal) {
      return;
    }
    if (pairingHintTimer) {
      clearInterval(pairingHintTimer);
      pairingHintTimer = null;
    }
    if (requests.length === 0) {
      if (pairingApprovalModal.open) {
        pairingApprovalModal.close();
      }
      return;
    }
    updatePairingHint(requests);
    if (pairingApprovalModal.open) {
      pairingHintTimer = setInterval(() => updatePairingHint(requests), 1000);
    }
  }

  function announceNewPendingPairings(requests) {
    const pendingIds = requests.map((request) => request.pairing_id);
    const localUi = readLocalUiState(state.localUiStore);
    const newRequests = requests.filter(
      (request) => !localUi.pendingPairingIds.includes(request.pairing_id)
    );
    state.localUiStore.getState().setPendingPairingIds(pendingIds);

    if (!newRequests.length) {
      return;
    }

    const labels = newRequests.map((request) => request.label || shortId(request.device_id));
    const summary = labels.length === 1 ? labels[0] : `${labels.length} devices`;
    logLine(`Local pairing approval required for ${summary}.`);

    if (pairingApprovalModal && !pairingApprovalModal.open) {
      try {
        pairingApprovalModal.showModal();
      } catch (error) {
        logLine(`Unable to surface pairing approval modal: ${error.message}`);
      }
    }
  }

  function renderHeaderModelBadge(session) {
    if (!localModelBadge) {
      return;
    }

    // Model is session-scoped — only relevant while actually viewing a conversation.
    // On the console/home view, the model badge is noise (session state leaking into
    // the monitor surface). Session details modal still surfaces it on demand.
    const inConversationView = chatShell?.dataset.view === "conversation";
    const badge = selectModelBadge({
      provider: session?.provider,
      model: session?.model,
      reasoningEffort: session?.reasoning_effort,
    });
    const shouldShow = Boolean(inConversationView && session?.active_thread_id && badge.show);
    localModelBadge.hidden = !shouldShow;
    localModelBadge.textContent = shouldShow ? badge.text : "";
    localModelBadge.title = shouldShow ? badge.title : "";
  }

  // Sidebar "Providers" panel: one row per configured provider from the
  // snapshot's `provider_status`, including any that failed to spawn (with the
  // reason as a hover title). Independent of which thread is being viewed, so it
  // reads the real session, not the view-only projection.
  // Sidebar footer reflects the LIVE (SSE) connection, matching its data source
  // (state.streamConnected). When the stream drops the client keeps working via the
  // /api/session polling fallback, so the degraded state is labelled "Polling" (the
  // relay is still reachable) rather than a misleading "Offline"/"Reconnecting".
  function renderHostStatus() {
    if (!sidebarHostStatus) {
      return;
    }
    // When auth is required but not yet completed, neither the stream nor the polling
    // fallback runs — so don't claim "Polling". Show a signed-out state instead.
    const signedOut = Boolean(state.authRequired && !state.authenticated);
    const live = !signedOut && Boolean(state.streamConnected);
    sidebarHostStatus.classList.toggle("is-degraded", !live);
    if (sidebarHostLabel) {
      sidebarHostLabel.textContent = signedOut
        ? "Local relay · Signed out"
        : live
          ? "Local relay · Live"
          : "Local relay · Polling";
    }
  }

  function renderProviderStatus(session) {
    if (!providerStatusList) {
      return;
    }
    const rows = Array.isArray(session?.provider_status)
      ? session.provider_status
      : [];
    // The Settings tab strip owns panel visibility now, so never hide the panel;
    // show an empty-state row instead of a blank tab when no providers are reported.
    providerStatusList.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("li");
      empty.className = "provider-status-row provider-status-empty";
      empty.textContent = "No providers connected.";
      providerStatusList.append(empty);
      return;
    }
    for (const row of rows) {
      const meta = providerStatusMeta(row.status);
      const item = document.createElement("li");
      item.className = "provider-status-row";
      item.dataset.provider = row.provider || "";
      item.dataset.status = row.status || "";
      if (row.reason) {
        item.title = row.reason;
      }

      const dot = document.createElement("span");
      dot.className = `provider-status-dot ${meta.dotClass}`;
      dot.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "provider-status-name";
      name.textContent =
        providerLabel(row.provider) || row.display_name || row.provider || "";

      const statusEl = document.createElement("span");
      statusEl.className = "provider-status-state";
      statusEl.textContent = meta.label;

      item.append(dot, name, statusEl);
      providerStatusList.append(item);
    }
  }

  function renderAuditTimeline(entries) {
    if (!auditTimeline || !auditSummary) {
      return;
    }

    if (!entries.length) {
      renderReactContent(auditSummary, h(TextContent, null, ""));
      renderReactContent(auditTimeline, h(AuditList));
      return;
    }

    const filteredEntries = entries.filter((entry) => shouldShowAuditEntry(entry));
    const visibleEntries = filteredEntries.slice(0, 8);
    const hiddenDebugCount = entries.length - filteredEntries.length;
    const significantCount = visibleEntries.filter(
      (entry) => classifyAuditEntry(entry) !== "neutral"
    ).length;
    const summaryParts = [`${visibleEntries.length} events`];
    if (significantCount > 0) summaryParts.push(`${significantCount} notable`);
    if (hiddenDebugCount > 0) summaryParts.push(`${hiddenDebugCount} hidden`);
    renderReactContent(
      auditSummary,
      h(TextContent, null, summaryParts.join(" · "))
    );

    if (!visibleEntries.length) {
      renderReactContent(
        auditTimeline,
        h(AuditList, { emptyMessage: "No relay-level audit events yet." })
      );
      return;
    }

    renderReactContent(
      auditTimeline,
      h(AuditList, {
        entries: visibleEntries.map((entry, index) => ({
          key: `${entry.created_at || index}:${entry.kind || "relay"}:${entry.message || ""}`,
          kind: humanizeLabel(entry.kind || "relay"),
          message: entry.message || "",
          time: formatTimestamp(entry.created_at),
          tone: classifyAuditEntry(entry),
        })),
      })
    );
  }

  function renderSessionMeta(session) {
    if (sessionDetailsPath) {
      sessionDetailsPath.textContent = session.current_cwd || "No workspace path yet.";
    }

    const securityChips = [
      metaChip("Access", securityModeLabel(session)),
      metaChip("Sharing", contentVisibilityLabel(session)),
      metaChip("Remote", brokerStatusLabel(session)),
      metaChip("Devices", pairedDeviceCountLabel(session)),
      metaChip(
        "Workspace access",
        session.allowed_roots?.length
          ? `${session.allowed_roots.length} configured`
          : "Unrestricted"
      ),
    ];

    if (!session.active_thread_id) {
      renderReactContent(
        sessionMeta,
        h(SessionMetaPanel, {
          chips: securityChips,
          emptyMessage: "Session details will appear here.",
        })
      );
      return;
    }

    renderReactContent(
      sessionMeta,
      h(SessionMetaPanel, {
        chips: [
          ...securityChips,
          metaChip("Provider", providerLabel(session.provider) || "Unknown"),
          metaChip("Model", session.model),
          metaChip("Permissions", session.approval_policy),
          metaChip("Effort", session.reasoning_effort),
          metaChip("Control", controllerStateLabel(session)),
          metaChip("Session", shortId(session.active_thread_id)),
          ...reviewChips(session),
        ],
      })
    );
  }

  function renderOverviewState(session, errorMessage = null) {
    const pendingPairings = session?.pending_pairing_requests?.length || 0;

    if (errorMessage) {
      renderReactContent(
        overviewSecurityBadges,
        h(OverviewBadges, { badges: [overviewBadge("Status", "Offline")] })
      );
      return;
    }

    // Status subjects first (Providers · Task, from the shared session-status seam) so the
    // standby dashboard names what's actually running instead of leaving it to one ambiguous
    // pill, then trust posture (Access · Sharing · Remote). Device count lives in the Devices
    // hero; Model/Control are session-scoped (surfaced in the chat header or transcript).
    const securityBadges = [
      ...describeStatusChips(session),
      ...(pendingPairings > 0 ? [overviewBadge("Pending", String(pendingPairings))] : []),
      overviewBadge("Access", securityModeLabel(session)),
      overviewBadge("Sharing", contentVisibilityLabel(session)),
      overviewBadge("Remote", brokerStatusLabel(session)),
    ];

    renderReactContent(overviewSecurityBadges, h(OverviewBadges, { badges: securityBadges }));
  }

  function renderSessionSettingsPanel(session) {
    if (!composerSettingsMount) {
      return;
    }
    if (!session?.active_thread_id || !isViewingConversation(session)) {
      renderReactContent(composerSettingsMount, null);
      return;
    }
    // The review trigger/progress/resolve now live in the right-panel Reviewer
    // tab (co-located with the diff). The composer keeps only the settings gear.
    renderReactContent(
      composerSettingsMount,
      h(SessionSettingsButton, {
        session,
        composerEffort: messageEffort?.value || session.reasoning_effort || "",
        onUpdate: (payload) => updateSessionSettings?.(payload),
        onChangeEffort: (value) => {
          if (messageEffort) messageEffort.value = value;
          if (session.provider) saveLastEffort(session.provider, value);
          updateSessionSettings?.({ effort: value });
        },
      })
    );
  }

  // Push the review slice onto the shared workspace-diff store so the Reviewer
  // tab (rail + mobile sheet) can render jobs, the launcher model, and gating.
  function renderReviewSlice(session) {
    if (typeof setReviewSlice !== "function") {
      return;
    }
    // The Reviewer panel belongs to the thread you're looking at: a review (and its
    // lingering terminal error) must only show on its own parent thread, never bleed
    // into every other thread's panel. Scope the DISPLAY to the viewed thread; the
    // the snapshot's review_activity stays authoritative for navigation/locking.
    const viewedThreadId = state.viewThreadId || session?.active_thread_id || null;

    // Refresh the dedicated (uncompacted) reviews channel only when the snapshot's
    // reviews_revision changes; re-render the slice when fresh data lands. This keeps the
    // panel populated without making cards compete with transcript bytes.
    if (typeof fetchReviews === "function") {
      void reviewsCache.sync(
        session?.reviews_revision,
        () => fetchReviews(),
        () => {
          renderSession(state.session || session);
          // The sidebar is rendered outside renderSession(). Its Reviewing dots
          // read this cache too, so the dedicated response must repaint the list
          // instead of waiting for an unrelated snapshot or polling tick.
          renderThreads();
        }
      );
    }
    if (typeof fetchWorkflows === "function") {
      void workflowsCache.sync(
        session?.workflows_revision,
        () => fetchWorkflows(),
        () => renderSession(state.session || session)
      );
    }
    const reviewsData = reviewsCache.current();
    const workflowsData = workflowsCache.current();
    const threadReviewJobs = reviewCardsForViewedThread(reviewsData, viewedThreadId);
    const threadWorkflowRuns = workflowRunsForThread(workflowsData, viewedThreadId);
    const viewingWritableAuthor =
      typeof startWorkflow === "function" &&
      isViewingConversation(session) &&
      canCurrentDeviceWrite(session);
    setReviewSlice({
      reviewJobs: threadReviewJobs,
      workflowRuns: threadWorkflowRuns,
      reviewModel: reviewLaunchModel(session),
      workflowModel: workflowLaunchModel(session),
      // Filter reuse by working tree here: the relay refuses a reviewer bound to another tree.
      reusableReviewers: reusableReviewersFromReviews(
        reviewsData,
        viewedThreadId,
        null,
        getThreadWorkspace()?.cwd || null
      ),
      // Full reviewer-thread list so each card can show its reviewer thread's
      // (long, truncated-with-tooltip) name by joining on reviewer_thread_id.
      reviewerThreads: reviewsData.reviewer_threads || [],
      // The thread the panel is showing: sent as the review's parent so a review
      // targets the VIEWED thread, not the relay's active thread.
      parentThreadId: viewedThreadId,
      canRequest:
        typeof requestReview === "function" &&
        canRequestReview(session, state.deviceId, viewedThreadId),
      canStartWorkflow: viewingWritableAuthor && canStartWorkflow(session, viewedThreadId),
      blocked: isReviewBlocked(session) || isWorkflowBlocked(session),
    });
  }

  // A lightweight idle prompt in the conversation footer: only when this device
  // can start a review (idle + controller). Points users at the relocated
  // feature without re-cluttering the composer. Its own modal id keeps it from
  // colliding with the rail/sheet launchers.
  function renderReviewIdleNudge(session) {
    if (!reviewIdleNudge) {
      return;
    }
    const show =
      typeof requestReview === "function" &&
      isViewingConversation(session) &&
      canRequestReview(
        session,
        state.deviceId,
        state.viewThreadId || session?.active_thread_id || null
      );
    reviewIdleNudge.hidden = !show;
    if (!show) {
      renderReactContent(reviewIdleNudge, null);
      return;
    }
    const reviewModel = reviewLaunchModel(session);
    const workspace = getThreadWorkspace();
    renderReactContent(
      reviewIdleNudge,
      h(
        "div",
        { className: "review-idle-nudge-inner" },
        h("span", { className: "review-idle-nudge-copy" }, "Want a second opinion on these changes?"),
        h(ReviewLauncher, {
          panelId: "review-panel-nudge",
          label: "Request reviewer",
          providerOptions: reviewModel.providerOptions,
          models: reviewModel.models,
          defaultProvider: reviewModel.defaultProvider,
          // Source the reuse list from the dedicated reviews cache (same as the panel) so it
          // survives live-turn compaction; fall back to the snapshot until the cache loads.
          reusableReviewers: reusableReviewersFromReviews(
            reviewsCache.current(),
            state.viewThreadId || session?.active_thread_id || null,
            null,
            workspace?.cwd || null
          ),
          parentThreadId: state.viewThreadId || session?.active_thread_id || null,
          workspace,
          onPinWorkspace: pinThreadWorkspace,
          onTrustWorkspace: trustThreadWorkspace,
          disabled: false,
          onSubmit: (values) => requestReview(values),
        })
      )
    );
  }

  // What the banner shows is decided in local/control-banner.js — including that a
  // missing workspace outranks take-over. This function only paints it.
  //
  // NOTE ON THE COMPOSER: it stays enabled while the workspace is missing, on
  // purpose. A send is harmless now (the relay keeps the message and appends a
  // visible error naming the directory instead of reaching the provider), and this
  // banner's `workspace_missing` is only as fresh as the last tail fetch. Disabling
  // the composer would make a STALE "missing" unfalsifiable: a user who re-created
  // the directory by hand would be locked out of a workspace that is actually back,
  // with no action left that could prove it. A send is exactly that proof — it
  // re-fetches the tail, so it either goes through or re-states the problem in the
  // transcript. The banner is the fast path; the composer is the one that self-heals.
  function renderControlBanner(session) {
    const activeUnderReview = isReviewInProgressForThread(session, session.active_thread_id);
    const activeUnderWorkflow = isWorkflowInProgressForThread(session, session.active_thread_id);
    const activeLockedByAgent = activeUnderReview || activeUnderWorkflow;
    const repair = readWorkspaceRepair(state, session.active_thread_id);
    const model = selectControlBannerModel({
      controllerName: session.active_controller_device_id
        ? controllerLabel(session.active_controller_device_id)
        : "",
      hasActiveThread: Boolean(session.active_thread_id),
      hasController: Boolean(session.active_controller_device_id),
      isController: isCurrentDeviceActiveController(session),
      // Review/workflow owns this turn sequence while non-terminal.
      lockedByAgent: activeLockedByAgent,
      lockedByWorkflow: activeUnderWorkflow,
      repairError: repair.error,
      repairPending: repair.pending,
      sessionWorking: sessionIsWorking(session),
      viewingConversation: isViewingConversation(session),
      viewOnly: Boolean(session.view_only),
      // Straight off the snapshot: the relay decides this on the paths that touch the
      // workspace and caches it on the thread runtime, so every render already has it.
      workspaceMissing: session.workspace_missing,
    });

    if (model.hidden) {
      controlBanner.hidden = true;
      return;
    }

    controlBanner.hidden = false;
    renderReactContent(
      controlBanner,
      h(ControlBannerContent, {
        hint: model.hint,
        repair: model.repair,
        showTakeOver: model.showTakeOver,
        summary: model.summary,
        summaryTitle: model.summaryTitle,
      })
    );
  }

  function renderPendingActionBanner(approval, pendingPairings, session = null) {
    if (!pendingActionBanner) {
      return;
    }

    if (approval) {
      pendingActionBanner.hidden = false;
      renderReactContent(
        pendingActionBanner,
        h(
          "div",
          { className: "pending-action-banner-inner pending-action-banner-approval" },
          h("span", { className: "pending-action-banner-text" }, approval.summary || "Approval required"),
          h(
            "div",
            { className: "pending-action-banner-actions" },
            h(
              "button",
              {
                className: "pending-action-btn pending-action-btn-primary",
                "data-approval-decision": "approve",
                "data-approval-scope": "once",
                type: "button",
              },
              "Approve"
            ),
            h(
              "button",
              {
                className: "pending-action-btn pending-action-btn-danger",
                "data-approval-decision": "deny",
                "data-approval-scope": "once",
                type: "button",
              },
              "Deny"
            )
          )
        )
      );
      return;
    }

    if (pendingPairings.length > 0) {
      const label = formatPendingPairingsBannerLabel(pendingPairings, shortId);
      pendingActionBanner.hidden = false;
      renderReactContent(
        pendingActionBanner,
        h(
          "div",
          { className: "pending-action-banner-inner pending-action-banner-pairing" },
          h("span", { className: "pending-action-banner-text" }, label),
          h(
            "button",
            {
              className: "pending-action-btn",
              "data-open-pairing-approval": "true",
              type: "button",
            },
            "Review"
          )
        )
      );
      return;
    }

    pendingActionBanner.hidden = true;
  }

  // #9 standby home: lead with the task, not with plumbing. On return, offer to continue
  // the most recent thread (same view-navigation as clicking it in the sidebar); on first
  // use, welcome + quick-start starters. Replaces the old "Start a session from the sidebar"
  // dead-end. Decision logic + action wiring are the pure standby-empty-state helpers; the
  // starters open the real New session dialog (data-start-session), handled in app.js — NOT
  // a composer prefill, which dead-ends in standby (no active thread → composer disabled).
  function buildStandbyEmptyContent() {
    const model = selectStandbyEmptyModel({
      threads: state.threads || [],
      selectedCwd: state.selectedCwd || "",
    });
    return h(ConversationEmptyState, {
      actions: buildStandbyEmptyActions(model),
      copy: model.copy,
      details: model.selectedCwd ? [`Selected workspace: ${model.selectedCwd}`] : [],
      title: model.title,
    });
  }

  // Hoisted once per renderer instance rather than defined inline in
  // transcriptOptions below: both only ever close over `state` (stable for
  // this renderer's whole lifetime), so a fresh closure every render would
  // do nothing but defeat stableTranscriptOptions's reference check on these
  // two fields.
  function handleEnsureFileChangeDetail(itemId) {
    void state.controller?.ensureFileChangeDetail?.(itemId);
  }
  function handleSubmitAskUserAnswers(requestId, answers) {
    void state.controller?.submitAskUserQuestionAnswer?.(requestId, answers);
  }

  // Hoisted once per renderer instance for the same reason as
  // handleEnsureFileChangeDetail above: LocalTranscriptPanel calls this only
  // in its entries branch and owns the stableTranscriptOptions cache itself,
  // so this closure's identity must stay stable across renders too.
  function buildTranscriptOptions({ activeThreadId, entries, session }) {
    const localUi = readLocalUiState(state.localUiStore);
    return {
      currentCwd: session?.current_cwd || state.selectedCwd || "",
      detailEntries: buildExpandedTranscriptDetailEntries(state, {
        expandedItemIds: localUi.transcriptExpandedItemIds,
        threadId: activeThreadId,
        autoDetailItemIds: collectFileChangeDetailItemIds(entries),
      }),
      // Hide rollback/reapply on a read-only view-only thread (the apply
      // endpoint resolves the item against the relay's REAL active thread, so
      // acting from a saved-thread view would mutate the wrong/live thread),
      // and while the active thread is itself under review.
      enableFileChangeActions:
        !session.view_only &&
        !isReviewInProgressForThread(session, session.active_thread_id) &&
        !isWorkflowInProgressForThread(session, session.active_thread_id),
      expandedKeys: localUi.transcriptExpandedItemIds,
      loadingItemIds: localUi.transcriptLoadingItemIds,
      // Enables the per-message "Fork from here" affordance on turn-final
      // agent messages. Saved/view-only threads included: forking reads a
      // thread's history into a NEW session, it never writes to the thread
      // you are looking at.
      canFork: canForkInSession(session),
      // Stamps each agent message with the mark of whoever wrote it. Read off
      // the session being VIEWED (a read-only projection carries its own
      // provider), so a saved codex thread never renders under Claude's logo.
      provider: session?.provider || "",
      onEnsureFileChangeDetail: handleEnsureFileChangeDetail,
      // Suppress the answer entry while the active thread is owned by
      // review/workflow; these orchestrators are non-interactive.
      pendingAskUserQuestions: isReviewInProgressForThread(
        session,
        session.active_thread_id
      ) || isWorkflowInProgressForThread(session, session.active_thread_id)
        ? []
        : session?.pending_ask_user_questions || [],
      onSubmitAskUserAnswers: handleSubmitAskUserAnswers,
      askUserSubmittingRequestId: localUi.askUserSubmittingRequestId || "",
      askUserErrors: localUi.askUserErrors instanceof Map ? localUi.askUserErrors : new Map(),
    };
  }

  function renderTranscript(session, approval) {
    const viewingConversation = isViewingConversation(session);
    const entries = session.transcript || [];
    const activeThreadId = session.active_thread_id || null;

    // Gated on !viewingConversation like the original branches below, so the
    // common "viewing a live conversation" path skips these lookups entirely.
    let viewedThreadWorkflowLocked = false;
    let viewedThreadLocked = false;
    let viewingDifferentThread = false;
    let requestedSessionLabel = "";
    let activeThreadLabel = "";
    if (!viewingConversation) {
      viewedThreadWorkflowLocked = isWorkflowInProgressForThread(session, state.viewThreadId);
      // Review/Code Flow briefly hands the active thread to hidden owned work. If
      // the user is sitting on the owned parent, keep the page calm instead of
      // flashing the "attached to a different session" message.
      viewedThreadLocked =
        isReviewInProgressForThread(session, state.viewThreadId) || viewedThreadWorkflowLocked;
      viewingDifferentThread =
        Boolean(state.viewThreadId) && state.viewThreadId !== session.active_thread_id;

      const activeThread = resolveActiveThread(session.active_thread_id);
      const requestedThread =
        resolveActiveThread(state.viewThreadId) || findVisible(state.viewThreadId);
      requestedSessionLabel = requestedThread
        ? requestedThread.name || requestedThread.preview || shortId(requestedThread.id)
        : shortId(state.viewThreadId);
      activeThreadLabel =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
    }

    renderConversationContent(
      h(LocalTranscriptPanel, {
        activeThreadId,
        activeThreadLabel,
        approval,
        buildTranscriptOptions,
        entries,
        entriesCanWrite: canComposeThread({
          activeTurnId: session.active_turn_id,
          hasActiveSession: Boolean(session.active_thread_id),
          hasControllerLease: canCurrentDeviceWrite(session),
          reviewLocked:
            isReviewInProgressForThread(session, session.active_thread_id) ||
            isWorkflowInProgressForThread(session, session.active_thread_id),
        }),
        getStandbyEmptyContent: buildStandbyEmptyContent,
        hydrationLoading: shouldShowTranscriptLoading(session, state),
        onLoadOlderTranscript: loadOlderTranscript,
        promotion: state.localTranscriptScrollPromotion,
        readyCopy: `${providerLabel(session?.provider) || "The agent"} is connected. Send the first prompt below when you're ready.`,
        requestedSessionLabel,
        resetEpoch: state.localTranscriptScrollResetEpoch,
        scrollElement: transcript,
        session,
        shortId,
        standbyCanWrite: canCurrentDeviceWrite(session),
        viewOnly: Boolean(session.view_only),
        viewOnlyReviewView: Boolean(state.viewOnlyThread?.review),
        viewedThreadLocked,
        viewedThreadWorkflowLocked,
        viewingConversation,
        viewingDifferentThread,
      })
    );
  }

  function renderThreads() {
    // The session tab strip shows the same per-thread activity as this list, so it
    // refreshes on the same beat — otherwise a tab's dot would lag the sidebar's.
    renderSessionTabs();
    const threadListUi = readThreadListUi(state.threadListStore);
    const selectedCwd = canonicalizeWorkspace(threadListUi.selectedCwd || state.selectedCwd);
    const viewedThreadId = state.viewThreadId || null;
    const previousScrollTop =
      appShell?.dataset.view === "conversation"
        ? state.pendingThreadHistoryScrollTop ??
          Math.max(state.threadHistoryScrollTop, threadsList?.scrollTop || 0)
        : 0;
    // Read the context-menu target so React can paint the `is-context-target`
    // highlight on the matching row below. If that thread has vanished (deleted
    // out from under an open menu), close the menu — but WITHOUT re-rendering,
    // since we're already inside renderThreads() and continue on to render the
    // list; then re-sync the local id so this pass doesn't highlight a ghost row.
    let openCtxThreadId = readThreadListContextMenu(state.threadListStore).threadId;
    if (openCtxThreadId && !findVisible(openCtxThreadId)) {
      closeThreadContextMenu({ rerender: false });
      openCtxThreadId = readThreadListContextMenu(state.threadListStore).threadId;
    }

    // Selecting a project PINS it: its sessions lift out of their cwd groups into one
    // group at the top, and everything else stays where it was. The list is therefore
    // always the full list — picking a project can never hide a session. That replaced
    // the old two-axis "Projects mode", which swapped cwd grouping out entirely.
    // A search cuts ACROSS the pin: it swaps the row SOURCE for a server-side slice
    // that can contain sessions absent from `state.threads` entirely, so there is
    // nothing coherent to lift out of.
    const searching = isThreadSearchActive(state.threadSearch);
    // The bell cuts across it too, and more bluntly: `buildThreadStateGroups` REPLACES
    // the group structure with state buckets rather than narrowing within it, so a
    // pinned group cannot survive it. Standing the pin down beats rendering a control
    // that visibly does nothing.
    const filtering = isThreadFilterActive(readThreadFilter(state.threadListStore));
    // Gated on the selection alone. It used to require `viewMode === "projects"` as
    // well, which was the toggle's last hold on the list: with the toggle gone that
    // condition is permanently false, so the pin would simply never apply.
    const pinnedProjectId = selectPinnedProjectId({
      activeProjectId: readActiveProjectId(state.threadListStore),
      searching,
      filtering,
    });

    // Regrouped at RENDER time, not at load time: the pin follows the selection, which
    // changes far more often than the thread list does. `state.threadGroups` stays the
    // UNPINNED cwd grouping — it is a display projection of `state.threads` and never
    // the source of it, so the authoritative list is untouched by any of this.
    //
    // Note this no longer fails closed while the Projects payload is missing or in
    // flight. It used to, because a stale membership map would have mis-grouped the
    // WHOLE list. A pin is additive: an unresolved project id degrades to plain cwd
    // grouping (see `resolvePinnedProject`), which shows every session correctly — just
    // not yet lifted. Blanking a complete list to a "Loading projects…" placeholder is
    // the worse answer once the failure mode is "not yet sorted" rather than "wrong".
    const threadGroups = pinnedProjectId
      ? buildNavigationThreadGroups(state.threads || [], {
          pinnedProjectId,
          projects: state.projects || [],
          threadProjectId: state.threadProjectId || {},
        })
      : state.threadGroups || [];

    // Searching swaps the SOURCE of the rows, not the row renderer: a result behaves
    // exactly like the same session listed at rest (same dots, same click/right-click).
    const listView = selectThreadListView({
      threadGroups,
      search: state.threadSearch,
    });

    // Hoisted: the bell needs the same three signals the row dots do, and computing
    // them twice would let the filter and the dots read different snapshots.
    const threadActivityMap = buildThreadActivityMap(state.session);
    const threadAttentionMap = threadAttention.snapshotMap();
    const threadReviewingSet = buildReviewingThreadSet(state.session, reviewsCache.current());

    // The bell narrows whatever the list would otherwise show — resting groups OR search
    // results — which is exactly what lets the two compose instead of competing for the
    // same surface.
    const stateOf = (thread) =>
      selectThreadState({
        activity: threadActivityMap.get(thread.id) || null,
        attentionKind: threadAttentionMap.get(thread.id) || null,
        reviewing: threadReviewingSet.has?.(thread.id),
      });
    // Monotonic accumulator, not derived state: it only ever grows while the filter is
    // on, so computing it here cannot cause a re-render loop.
    //
    // Written through the store's setter rather than by mutating `retained` in place.
    // Nothing on local SUBSCRIBES to this store — it is read with `getState()` from
    // imperative code — so a write during a render pass notifies nobody and cannot loop.
    // Remote, which does subscribe, keeps the same write in an effect for that reason.
    const threadFilter = readThreadFilter(state.threadListStore);
    const retainedNext = nextRetainedStates(
      threadFilter.retained,
      listView.groups,
      threadFilter,
      stateOf
    );
    if (retainedNext !== threadFilter.retained) {
      state.threadListStore.getState().setThreadFilterRetained(retainedNext);
    }
    const filterView = selectThreadFilterView({
      groups: listView.groups,
      filter: { ...threadFilter, retained: retainedNext },
      stateOf,
    });
    // The pinned group's header carries the same activity roll-up ("2 working" /
    // "1 needs input") the project headers showed before, so lifting a project to the
    // top does not cost it the badges it had. This is a no-op without a pin — only
    // groups carrying a projectId take a summary — so it needs no condition of its own.
    // The three maps are passed as the ONE snapshot this render already took, which is
    // what keeps a header from disagreeing with the rows beneath it.
    const groups = attachProjectSummaries(filterView.groups, {
      threadActivity: threadActivityMap,
      threadAttention: threadAttentionMap,
      threadReviewing: threadReviewingSet,
    });

    // Both controls can have something to say about this list; composeListChrome keeps
    // the count describing what is actually rendered while the search's warning survives.
    const { countLabel, emptyMessage } = composeListChrome(listView, filterView);

    renderWorkspaceSuggestions(state.session);
    threadsCount.textContent = countLabel;
    threadsCount.title = listView.searching || filterView.filtering
      ? countLabel
      : groups.map((group) => group.cwd || group.label).join("\n");

    renderReactContent(
      threadsList,
      h(ThreadGroupList, {
        activeThreadId: viewedThreadId,
        contextMenuThreadId: openCtxThreadId,
        // Workspace ("folder") groups fold away, same as remote and as Projects
        // mode. The header click still sets the active workspace — see
        // ThreadGroupHeader's collapsible branch.
        collapsible: true,
        collapsedGroupCwds: listView.collapseGroups
          ? threadListUi.collapsedGroupCwds || new Set()
          : new Set(),
        emptyMessage,
        expandedGroupCwds: threadListUi.expandedGroupCwds || new Set(),
        formatThreadMeta(thread) {
          return formatRelativeTime(thread.updated_at);
        },
        groups,
        onContextThread(threadId, clientX, clientY) {
          openThreadContextMenu(threadId, clientX, clientY);
        },
        // Rename/delete render only for a group carrying a projectId, which since the
        // switcher means exactly one group: the pinned one. That is now the surviving
        // home for both actions — they used to be reachable only inside the retired
        // Projects mode, so deleting that mode without this would have stranded them.
        activeProjectId: pinnedProjectId,
        onRenameProject,
        onDeleteProject,
        onContextProject(projectId, name, clientX, clientY) {
          if (typeof openProjectContextMenu === "function") {
            openProjectContextMenu(projectId, name, clientX, clientY);
          }
        },
        onResumeThread(threadId, { preview = true } = {}) {
          // Opening a thread clears its attention dot immediately; the click also
          // doubles as the user gesture that unlocks notification permission.
          threadAttention.clear(threadId);
          void ensureNotificationPermission();
          renderThreads();
          if (typeof viewThread === "function") {
            // Open INTO the owning context, so a session lands in ITS tab set
            // rather than the selected project's. A pinned list keeps every
            // session on screen — other projects' rows AND unassigned ones — so
            // the owner and the selection routinely differ.
            //
            // Always stated, never null: `setThreadRoute` reads a null context as
            // "keep the current one", which is how unassigned sessions were being
            // filed into the selected project. See `selectOwningContext`.
            //
            // A click is a peek, a double click keeps it — see ThreadGroupItem.
            // A peek skips the view transition: it swallows the second click of
            // the double click, and browsing wants a cut.
            viewThread(threadId, {
              context: selectOwningContext({
                threadId,
                threadProjectId: state.threadProjectId,
              }),
              preview,
              transition: !preview,
            });
          }
        },
        onSelectWorkspace(cwd) {
          // Defence in depth: the Unknown-workspace header is not rendered as a
          // button, but this value ends up in the workspace input verbatim, so
          // refuse the display sentinel here too. Project group headers carry an
          // empty cwd — they're not workspaces, so ignore them as well.
          if (!cwd || isUnknownWorkspace(cwd)) return;
          setSelectedCwd(cwd || "");
          renderThreads();
          renderOverviewState(state.session);
        },
        onToggleExpandedGroup(cwd) {
          state.threadListStore.getState().toggleExpandedGroup(cwd);
          renderThreads();
        },
        onToggleGroup(cwd) {
          state.threadListStore.getState().toggleCollapsedGroup(cwd);
          renderThreads();
        },
        selectedCwd,
        threadActivity: threadActivityMap,
        threadAttention: threadAttentionMap,
        threadReviewing: threadReviewingSet,
      })
    );

    window.requestAnimationFrame(() => {
      syncThreadHistoryScroll();
      if (appShell?.dataset.view === "conversation" && previousScrollTop > 0) {
        const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
        threadsList.scrollTop = Math.min(previousScrollTop, maxScrollTop);
        state.threadHistoryScrollTop = threadsList.scrollTop;
      }
    });
  }

  // The sidebar's destination nav, in both of its forms.
  //
  // This is local's HOST for `shared/sidebar-nav.js`: it binds a surface-agnostic
  // component to local's routing (`onOpenSessionsScreen` / `onOpenTasksScreen`, injected
  // rather than imported, so the nav never learns what `session-view-state.js` is) and to
  // local's notion of a waiting task. It replaced four id-addressed click listeners in
  // app.js, an `aria-current` sweep, and two hand-written copies of the same two buttons.
  //
  // Both mounts get the SAME props. The rail is not a second nav — it is the same nav
  // with the labels dropped, and it is the only one on screen while the sidebar is
  // collapsed, so a count that lived only in the sidebar would go quiet in exactly the
  // state where the user has the least on screen to notice it.
  //
  // The badge counts tasks WAITING ON A PERSON, not tasks that exist: a number meaning
  // "runs in the list" would never go away — a terminal run stays forever — so the badge
  // would stop meaning anything the first time one finished.
  // The sidebar's top-bar controls and the search field.
  //
  // Local's host for `shared/sidebar-chrome.js`. Three things used to carry this between
  // them: static markup in react-shell.js, five `getElementById` handles in app.js, and a
  // `syncActivityFilterChrome()` whose whole job was keeping `is-active`/`aria-pressed` in
  // step with the store. All of it collapses into "read the state, pass it as props".
  //
  // The field is ABSENT when closed rather than hidden — the change that let one component
  // serve both surfaces. Everything inside it lost its id in the process, which is what
  // makes it safe for remote to mount the same component without colliding.
  function renderSidebarChrome() {
    const searchUi = readSearchUi(state.threadListStore);
    const filter = readThreadFilter(state.threadListStore);
    renderReactContent(
      sidebarTopActionsMount,
      h(
        React.Fragment,
        null,
        h(SidebarSearchToggle, {
          open: searchUi.open,
          onToggle: onSetSearchOpen,
          // Local binds ⌘F (app.js); remote has no such key, so the hint is a prop rather
          // than baked into the label.
          shortcutHint: "⌘F",
        }),
        h(SidebarBellToggle, {
          on: filter.on,
          onToggle: (on) => onToggleActivityFilter({ on }),
        })
      )
    );
    renderReactContent(
      sidebarSearchMount,
      h(SidebarSearchField, {
        open: searchUi.open,
        query: searchUi.draft,
        onInput: onSearchInput,
        onClose: () => onSetSearchOpen(false),
        // Local reveals the field from a keyboard shortcut (⌘F), so focusing it is the
        // point. Remote leaves this off: on a phone, focusing pops the on-screen keyboard
        // over the list the user just asked to see.
        focusOnOpen: true,
        // The counter, so ⌘F focuses an ALREADY-OPEN field too. `open` does not change in
        // that case, so a mount-only `autoFocus` made the shortcut look dead.
        focusSignal: searchUi.focusSignal,
      })
    );
  }

  function renderSidebarNav() {
    const context = getViewContext() || {};
    // `loadSeenTasks()` is a localStorage read per render. It is a single small JSON
    // parse, and the alternative — caching it — needs an invalidation path for a value
    // the user changes by clicking, which is the more expensive kind of wrong.
    const locked = tasksLocked(state.session);
    const props = {
      // Full-area contexts own their destination key; everything else is Sessions.
      // Teams is reached from the Tasks footer (13a), so the Tasks row stays current.
      // Review is reached from inside a task, so the Tasks row stays current for
      // the same reason Teams does — the nav names where you came from, and
      // going one level deeper is not leaving.
      current:
        context.kind === "tasks" || context.kind === "teams" || context.kind === "review"
          ? "tasks"
          : context.kind === "usage"
            ? "usage"
            : "sessions",
      // Locked means nothing can be waiting on you.
      tasksWaitingCount: teamsNeedingYou(
        locked ? [] : teamsCache.current().teams,
        loadSeenTasks()
      ),
      tasksBeta: locked,
      usageBeta: usageLocked(state.session),
      onOpenSessions: onOpenSessionsScreen,
      onOpenTasks: onOpenTasksScreen,
      onOpenUsage: onOpenUsageScreen,
    };
    renderReactContent(sidebarNavMount, h(SidebarNav, props));
    renderReactContent(iconRailNavMount, h(SidebarNavRail, props));
  }

  // The task list in the sidebar — the Tasks tab's body, opposite the session
  // list. Rendered on every pass, not only while the Tasks view is showing: the
  // sidebar is CSS-gated, so keeping it current costs nothing and means switching
  // tabs never shows a stale or empty column for a frame.
  function renderSidebarTaskList() {
    if (!sidebarTaskListMount) {
      return;
    }
    const context = getViewContext() || {};
    const loaded = teamsCache.hasData();
    renderReactContent(
      sidebarTaskListMount,
      h(TaskSidebarList, {
        runs: loaded ? sortTeamRuns(teamsCache.current().teams) : null,
        loading: !loaded,
        // Without this the sidebar reads "Loading…" forever on a persistent
        // failure while the main area correctly says the relay is unreachable —
        // two surfaces disagreeing about the same fetch.
        error: state.teamsError || null,
        // The review screen is about one run, so its row stays selected in it —
        // otherwise opening the changes reads as navigating away from the task.
        selectedRunId:
          context.kind === "tasks" || context.kind === "review"
            ? context.teamRunId || null
            : null,
        locked: tasksLocked(state.session),
        seenAt: loadSeenTasks(),
        onOpenTask: (teamRunId) => onOpenTask?.(teamRunId),
        onStartTask: () => onStartTask?.(),
        onOpenTeams: () => onOpenTeamsScreen?.(),
        teamsSummary: (() => {
          const teams = teamsFromCatalog(state.teamCatalog);
          const n = teams.length;
          return `${n} team${n === 1 ? "" : "s"}`;
        })(),
      })
    );
  }

  function renderSidebarTeamsList() {
    if (!sidebarTeamsListMount) {
      return;
    }
    const context = getViewContext() || {};
    const teams = teamsFromCatalog(state.teamCatalog);
    renderReactContent(
      sidebarTeamsListMount,
      h(TeamsSidebarList, {
        teams,
        selectedTeamId: context.kind === "teams" ? context.teamId || BUILTIN_TEAM_ID : BUILTIN_TEAM_ID,
        locked: tasksLocked(state.session),
        onSelectTeam: (teamId) => onOpenTeamsScreen?.(teamId),
        onBackToTasks: () => onOpenTasksScreen?.(),
      })
    );
  }

  // Fill the Usage screen. Callers gate this on mainView === "usage".
  function renderUsageReport() {
    if (!usageReportMount) {
      return;
    }
    const bucket = state.usageBucket || "day";
    renderReactContent(
      usageReportMount,
      h(UsageReportScreen, {
        locked: usageLocked(state.session),
        budgetPending: state.usageBudgetPending === true,
        onSetBudget: (patch) => void saveUsageBudget(patch),
        report: state.usageReport ?? null,
        loading: state.usageLoading === true,
        error: state.usageError || null,
        bucket,
        onBucketChange: (next) => {
          if (next === bucket) return;
          state.usageBucket = next;
          void loadUsageReport(next);
        },
        onRetry: () => void loadUsageReport(bucket),
      })
    );
  }

  // Save a budget change, then re-read the report rather than patching the
  // local copy from the receipt. The screen shows a cap, a policy AND a
  // projection derived from both; reconciling those by hand is how a screen
  // starts disagreeing with the server it just wrote to.
  async function saveUsageBudget(patch) {
    if (typeof setUsageBudget !== "function" || usageLocked(state.session)) {
      return;
    }
    state.usageBudgetPending = true;
    renderUsageReport();
    try {
      await setUsageBudget(patch);
      state.usageBudgetPending = false;
      await loadUsageReport(state.usageBucket || "day");
    } catch (error) {
      state.usageBudgetPending = false;
      state.usageError = error?.message || "Failed to save the budget";
      renderUsageReport();
    }
  }

  async function loadUsageReport(bucket = state.usageBucket || "day") {
    // Ahead of every other check, including the transport one. The screen is
    // loaded from the render pass, from a bucket switch and from Retry; putting
    // the gate here rather than at those three call sites is what stops a fourth
    // one from quietly reaching the network. Read from the live snapshot so a
    // relay restarted without `--beta` re-locks a screen the user is standing on.
    if (usageLocked(state.session)) {
      state.usageLoading = false;
      state.usageError = null;
      renderUsageReport();
      return;
    }
    if (typeof fetchUsage !== "function") {
      state.usageError = "Usage API is not wired on this surface.";
      state.usageLoading = false;
      renderUsageReport();
      return;
    }
    const requestId = (state.usageRequestId || 0) + 1;
    state.usageRequestId = requestId;
    state.usageBucket = bucket;
    state.usageLoading = true;
    state.usageError = null;
    renderUsageReport();
    try {
      const window = windowForBucket(bucket);
      const report = await fetchUsage({
        ...window,
        compare: "previous",
      });
      if (state.usageRequestId !== requestId) return;
      state.usageReport = report;
      state.usageLoading = false;
      state.usageError = null;
    } catch (error) {
      if (state.usageRequestId !== requestId) return;
      state.usageLoading = false;
      state.usageError = error?.message || String(error);
    }
    renderUsageReport();
  }

  // Fill the Task screen. Callers gate this on mainView === "tasks".
  //
  // Reads the teams sidecar, which is keyed on the snapshot's `teams_revision` —
  // a content hash, so an unchanged run set costs no request and a sub-task
  // advancing costs exactly one.
  let orchestratorHistoryLoader = null;
  let orchestratorHistoryScroller = null;
  const orchestratorRefreshLatch = createViewedThreadRefreshLatch();

  function renderTaskTeam(session) {
    if (!taskTeamMount) {
      return;
    }
    const context = getViewContext() || {};
    const loaded = teamsCache.hasData();
    const teams = loaded ? sortTeamRuns(teamsCache.current().teams) : null;
    const seenAt = loadSeenTasks();
    const locked = tasksLocked(session);
    if (!locked) {
      void ensureOrchestratorReady(session);
    }
    const localUi = readLocalUiState(state.localUiStore);
    const orchId = state.orchestratorThreadId || session?.orchestrator_thread_id || null;
    // Declare, for the whole surface, that the thread on screen is this one.
    // Detail expansion and file-diff loading resolve against it (see
    // local/displayed-thread.js); without this they would silently query the
    // session's active thread while you are looking at the Orchestrator.
    state.orchestratorOnScreenThreadId = locked ? null : orchId;
    // The approval belonging to THIS thread. `pending_approvals[0]` is the
    // conversation's pick and can easily be another thread's.
    const orchApproval =
      (session?.pending_approvals || []).find(
        (request) => (request?.thread_id || session?.active_thread_id) === orchId
      ) || null;
    const orchIsActive = Boolean(orchId && session?.active_thread_id === orchId);
    const orchActivity = threadActivityFor(session, orchId);
    // Streamed deltas leave their entry `status: "running"`, and the settling
    // patch is only routed to the ACTIVE thread. The conversation's pin survives
    // that because something refreshes it periodically; the Orchestrator has no
    // such refresher, so its last message would read as forever-streaming.
    // So it needs the same refresh policy the conversation's pin gets, and that
    // policy is already a shared function — a tail repair every 300ms while the
    // thread works, plus one final pass when it stops. Asking it rather than
    // re-deriving "stopped working" here is the difference between the two panes
    // agreeing forever and agreeing until one of them is edited.
    //
    // Fired here rather than left for `ensureOrchestratorReady` to notice on a
    // later render: "another render will come along" is true right up until the
    // frame that ends the turn is the last one. The previous entries stay on
    // screen until the fetch lands, so there is no flash, and `wasWorking` is
    // already updated by then, so this cannot re-arm itself.
    // While the Orchestrator IS the active thread the pane draws
    // `session.transcript`, and the cached page goes stale underneath it. When
    // it stops being active, nothing refetched: the ensure guard sees the id it
    // already has, and the settle refresh needs a working->idle edge that an
    // already-idle thread will not produce. So the pane reverted to the
    // pre-send conversation and stayed there. Three clicks to reproduce.
    if (state.orchestratorWasActiveThread && !orchIsActive && orchId) {
      state.orchestratorEntriesThreadId = null;
    }
    state.orchestratorWasActiveThread = orchIsActive;
    const orchRefresh = orchestratorTranscriptRefreshDecision(state, session, orchId);
    state.orchestratorWasWorking = nextOrchestratorWasWorking(state, orchRefresh.orchWorking);
    Object.assign(state, nextOrchestratorRefreshObservations(state, orchRefresh.orchWorking));
    if (orchRefresh.defer) {
      orchestratorRefreshLatch.defer(orchId);
    } else if (orchRefresh.refresh) {
      state.orchestratorLastRefreshAt = Date.now();
      void loadOrchestratorTranscript(orchId, {
        terminal: orchRefresh.terminal,
        repair: orchRefresh.repair,
      }).then(() => {
        if (state.session) {
          renderTaskTeam(state.session);
        }
      });
    }
    const orchEntries = orchIsActive
      ? session?.transcript || []
      : state.orchestratorEntries || null;
    renderReactContent(
      taskTeamMount,
      h(TaskTeamScreen, {
        // `null` until the first successful load is what lets the screen tell
        // "still loading" apart from "there are no tasks".
        runs: teams,
        selectedRunId: context.teamRunId || null,
        seenAt,
        changesPanel: taskDiffPanel(context.teamRunId || null),
        // From the live snapshot, so a relay restarted without `--beta` re-blurs
        // a screen the user is already standing on.
        locked,
        loading: !loaded,
        syncing: teamsCache.isSyncing(),
        error: state.teamsError || null,
        waitingCount: teamsNeedingYou(teams || [], seenAt),
        actionPending: state.teamActionPending || null,
        actionError: state.teamActionError || null,
        onOpenTask: (teamRunId) => onOpenTask?.(teamRunId),
        onBack: () => onBackToTasks?.(),
        onOpenThread: (threadId) => {
          if (!threadId || typeof viewThread !== "function") {
            return;
          }
          // Pass the thread's OWNING context. The reducer's floor stops a tasks
          // context from swallowing the tab, but "not invisible" is not the same
          // as "right": a seat thread that belongs to a project must land in that
          // project's tab set, not in the sessions bucket.
          viewThread(threadId, {
            context: selectOwningContext({
              threadId,
              threadProjectId: state.threadProjectId || {},
            }),
          });
        },
        onAction: (action) => onTeamAction?.(action, context.teamRunId || null),
        onStartTask: () => onStartTask?.(),
        orchestrator: locked
          ? null
          : {
              entries: orchEntries,
              // Both: `orchestratorLoading` is the ensure (creating the thread),
              // `orchestratorEntriesLoading` the transcript fetch. Only the
              // first was surfaced, so a re-open's refetch showed as "no
              // conversation" rather than as one arriving.
              loading: Boolean(state.orchestratorLoading || state.orchestratorEntriesLoading),
              composerDisabled: !orchId || Boolean(state.orchestratorLoading),
              composerBusy: Boolean(state.orchestratorSending || state.orchestratorProposalBusy),
              composerError: state.orchestratorSendError || null,
              proposals: session?.orchestrator_proposals || [],
              onSend: orchId ? (text) => sendOrchestratorMessage(text, orchId) : null,
              onPropose: (text) => proposeFromOrchestratorDraft(text),
              onConfirmProposal: (proposalId) => confirmOrchestratorProposalCard(proposalId),
              onDismissProposal: (proposalId) => dismissOrchestratorProposalCard(proposalId),
              onToggleProposalAutoStart: (proposalId, autoStart) =>
                setOrchestratorProposalAutoStart(proposalId, autoStart),
              onReset: typeof resetOrchestrator === "function" ? () => restartOrchestrator() : null,
              resetBusy: Boolean(state.orchestratorResetting),
              attachments: (state.orchestratorImageAttachments || []).map((attachment) => ({
                id: attachment.id,
                name: attachment.name,
                size: attachment.size,
              })),
              onPasteImages: (clipboardData) => attachOrchestratorImages(clipboardData),
              onRemoveAttachment: (id) => removeOrchestratorAttachment(id),
              // The same bundle the conversation gets, minus what cannot work
              // here. `canFork` and `enableFileChangeActions` are off: the
              // Orchestrator does not edit files, and the apply endpoint
              // resolves an item against the relay's ACTIVE thread, so acting
              // from this pane could mutate a different one.
              transcriptOptions: {
                currentCwd: session?.current_cwd || state.selectedCwd || "",
                expandedKeys: localUi.transcriptExpandedItemIds,
                loadingItemIds: localUi.transcriptLoadingItemIds,
                canFork: false,
                enableFileChangeActions: false,
                // Whoever is actually answering. The Orchestrator is built on
                // Claude, but reading it off the thread keeps the mark honest if
                // that ever changes.
                provider: session?.provider || "",
                // Filtered by thread: a question belongs to the thread that
                // asked it (AskUserQuestionRequestView carries `thread_id`), and
                // showing the session's question here would put an answer box on
                // the wrong conversation. Unfiltered, this pane would also go
                // interactive for a question it cannot answer.
                pendingAskUserQuestions: pendingAskUserQuestionsForThread(session, orchId),
                onSubmitAskUserAnswers: (requestId, answers) => {
                  void state.controller?.submitAskUserQuestionAnswer?.(requestId, answers);
                },
                askUserSubmittingRequestId: localUi.askUserSubmittingRequestId || "",
                askUserErrors:
                  localUi.askUserErrors instanceof Map ? localUi.askUserErrors : new Map(),
              },
              // The transcript's own controls. Still a subset — this pane has
              // no fork dialog and does not edit files — but the toggles are
              // live now that `displayedThreadId()` resolves to this thread
              // (see local/displayed-thread.js). Before that they would have
              // fetched the session thread's details under the Orchestrator's
              // messages.
              onTranscriptInteract: createTranscriptInteractionHandler({
                copyMessage: ({ text, element }) => void copyTextToClipboard(text, element),
                toggleGroup: ({ expandKey }) =>
                  state.controller?.toggleTranscriptExpandKey?.(expandKey),
                toggleEntry: ({ itemId }) =>
                  void state.controller?.toggleTranscriptEntry?.(itemId),
                // Named explicitly rather than left to `state.currentApprovalId`,
                // which is whichever approval the CONVERSATION rendered first.
                approvalDecision: ({ decision, scope }) => {
                  if (orchApproval?.request_id) {
                    void state.controller?.submitDecision?.(decision, scope, orchApproval.request_id);
                  }
                },
                openThread: ({ threadId }) => {
                  if (threadId && typeof viewThread === "function") {
                    viewThread(threadId, {
                      context: selectOwningContext({
                        threadId,
                        threadProjectId: state.threadProjectId || {},
                      }),
                    });
                  }
                },
              }),
              // The DEVICE's write right, not "is the composer usable right
              // now". Passing `!composerDisabled` made a pane that was merely
              // still opening announce that another device had control.
              //
              // Asked of the ORCHESTRATOR's thread, not the conversation's.
              // `canCurrentDeviceWrite` opens with `if (!active_thread_id)
              // return false`, so on a relay with no session open it locked
              // this composer and captioned it "Another device has control" —
              // with no other device and no active thread. See
              // shared/orchestrator-write-gate.js.
              canWrite: orchestratorCanWrite({
                session,
                orchestratorThreadId: orchId,
                deviceId: state.deviceId,
              }),
              // Stop, so a turn started here can be interrupted here. The pane
              // is drawn beside the conversation, and the conversation's Stop
              // button is hidden by CSS while Tasks is open.
              onStop: () => void state.controller?.stopActiveTurn?.(orchId),
              // An approval raised by the Orchestrator's own thread had NO
              // surface at all: this prop was never passed, and the fallback
              // `#pending-action-banner` is hidden by CSS while Tasks is open
              // (styles.css: `.chat-shell[data-view="tasks"] > * { display:none }`).
              // So the run just sat there.
              approval: orchApproval,
              // Liveness for the Orchestrator's OWN thread — top-level fields
              // when it is the active one, `thread_activity` otherwise. Stall
              // detection needs `last_progress_at`/`server_time`, which describe
              // the active thread only, so it is claimed only then.
              activity: {
                ...orchActivity,
                stalled: orchIsActive && isProgressStalled(session),
              },
            },
      })
    );
    // AFTER the render, not before: the scroller is a React node, so on the
    // first mount (and on every welcome/attention -> transcript swap) there was
    // nothing to attach to yet and pagination stayed dead until some later
    // render happened to run.
    syncOrchestratorHistoryLoader();
  }

  /**
   * Throw the current Orchestrator away and open a new one.
   *
   * `ensure` cannot do this: it is idempotent by design (every Tasks open calls
   * it) and hands back a live pin. But a pin can point at a thread the relay
   * still resolves while its provider session is gone — a restart drops cursor's
   * — and then every turn fails identically with nothing on screen to press.
   */
  async function restartOrchestrator() {
    if (typeof resetOrchestrator !== "function" || state.orchestratorResetting) {
      return;
    }
    state.orchestratorResetting = true;
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      const receipt = await resetOrchestrator();
      const threadId = receipt?.thread_id || null;
      if (!threadId) {
        throw new Error("Orchestrator reset returned no thread id");
      }
      state.orchestratorThreadId = threadId;
      // The old thread's entries are not this thread's — keep them and the new
      // conversation would open showing someone else's history.
      state.orchestratorEntries = null;
      state.orchestratorHistoryExtended = false;
      if (state.session) {
        state.session = { ...state.session, orchestrator_thread_id: threadId };
      }
      await loadOrchestratorTranscript(threadId);
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      state.orchestratorResetting = false;
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  async function ensureOrchestratorReady(session) {
    if (typeof ensureOrchestrator !== "function") {
      return;
    }
    const known = state.orchestratorThreadId || session?.orchestrator_thread_id || null;
    if (known) {
      state.orchestratorThreadId = known;
      // A failed load now leaves `orchestratorEntriesThreadId` null so this
      // refetches instead of caching the failure forever — which means a
      // persistently failing fetch would otherwise re-arm on every render. Same
      // backoff the view-only pin uses for the same reason: long enough that a
      // tight loop cannot form (a failed fetch re-renders synchronously), short
      // enough that the next snapshot after the relay returns recovers.
      const retryReady =
        !state.orchestratorEntriesErrorAt
        || Date.now() - state.orchestratorEntriesErrorAt >= VIEW_ONLY_LOAD_RETRY_BACKOFF_MS;
      if (
        session?.active_thread_id !== known &&
        state.orchestratorEntriesThreadId !== known &&
        !state.orchestratorEntriesLoading &&
        retryReady
      ) {
        void loadOrchestratorTranscript(known).then(() => {
          if (state.session) {
            renderTaskTeam(state.session);
          }
        });
      }
      return;
    }
    if (state.orchestratorEnsurePromise) {
      return state.orchestratorEnsurePromise;
    }
    state.orchestratorLoading = true;
    state.orchestratorEnsurePromise = (async () => {
      try {
        const receipt = await ensureOrchestrator();
        const threadId = receipt?.thread_id || null;
        if (!threadId) {
          throw new Error("Orchestrator ensure returned no thread id");
        }
        state.orchestratorThreadId = threadId;
        state.orchestratorSendError = null;
        if (state.session) {
          state.session = {
            ...state.session,
            orchestrator_thread_id: threadId,
          };
        }
        await loadOrchestratorTranscript(threadId);
        if (state.session) {
          renderTaskTeam(state.session);
        }
      } catch (error) {
        state.orchestratorSendError = error?.message || String(error);
        if (state.session) {
          renderTaskTeam(state.session);
        }
      } finally {
        state.orchestratorLoading = false;
        state.orchestratorEnsurePromise = null;
      }
    })();
    return state.orchestratorEnsurePromise;
  }

  async function loadOrchestratorTranscript(threadId, { terminal = false, repair = false } = {}) {
    // Taken here and released in the `finally`, with every answer inside the
    // `try` — including the two that need no fetch. A load that returned before
    // the `finally` settled nothing, and since a tail gap is retried on the very
    // next render with no throttle, an unsettled one is repaired forever.
    const generation = beginOrchestratorLoad(state, { repair });
    try {
      if (!threadId || typeof fetchTranscriptPage !== "function") {
        state.orchestratorEntries = [];
        state.orchestratorEntriesThreadId = threadId || null;
        state.orchestratorHistoryExtended = false;
        return;
      }
      if (state.session?.active_thread_id === threadId) {
        // The Orchestrator is the live thread, so its own transcript is the
        // authoritative answer and the gap is closed by reading it.
        state.orchestratorEntries = state.session.transcript || [];
        state.orchestratorEntriesThreadId = threadId;
        // These entries replace what was paged in, so no prefix is being held
        // open any more — a stale flag would keep a later refresh from trimming.
        state.orchestratorHistoryExtended = false;
        return;
      }
      const prior = orchestratorRefreshPin(state, threadId);
      const page = await fetchTranscriptPage(threadId, {});
      if (generation !== state.orchestratorLoadGeneration) {
        return;
      }
      // Normalize + validate the thread id + merge, the same three steps the
      // view-only pin takes and for the same reasons (local/pin-page.js). This
      // used to assign `page.entries` wholesale, discarding every delta that
      // arrived while the fetch was in flight.
      applyRefreshedOrchestratorPage(state, prior, page, threadId);
      state.orchestratorEntriesError = null;
      state.orchestratorEntriesErrorAt = 0;
      // The tail gap is NOT answered here: this page was built before a delta
      // refused mid-flight, so only the `finally` may settle it.
    } catch (error) {
      // A failed load must NOT claim the thread as loaded. It used to set
      // `orchestratorEntriesThreadId = threadId` and `entries = []`, and the
      // ensure path only refetches when that id differs from the pin — so one
      // transient 500 left an empty Orchestrator with no way back, and `[]` is
      // truthy enough to render the "no messages" welcome rather than a retry.
      // A newer load may also have superseded this one, in which case its
      // result is the one to keep.
      if (generation !== state.orchestratorLoadGeneration) {
        return;
      }
      state.orchestratorEntriesThreadId = null;
      state.orchestratorEntriesError = error?.message || String(error);
      state.orchestratorEntriesErrorAt = Date.now();
      logLine(`Orchestrator transcript load failed: ${error?.message || error}`);
    } finally {
      applyOrchestratorLoadFinally(state, generation, threadId, state.session, { terminal });
    }
  }

  /**
   * Page in the Orchestrator's older history.
   *
   * The pane always rendered the history sentinel (TranscriptContent emits it
   * unconditionally), but nothing watched it and `prev_cursor` was dropped on
   * the floor — so scrolling up hit a hard wall at the newest transport page.
   * Same merge the view-only pin uses: older entries are PREPENDED and
   * de-duplicated by item id, never assigned over the live tail.
   *
   * @returns {Promise<boolean|null>} true if more history remains, false at the
   *   oldest page, null when this attempt was not definitive (in flight, or
   *   superseded) — the sentinel loader distinguishes all three.
   */
  /**
   * Keep the history sentinel watched, across the pane mounting and unmounting.
   *
   * `attachTranscriptHistoryLoader` binds one scroll element for its lifetime,
   * and this pane's scroller is a React node that comes and goes with the Tasks
   * screen — so the loader is rebuilt whenever the element identity changes,
   * and poked on every render so a cursor that only appeared after a refresh
   * still resumes a loader that had backed off.
   */
  function syncOrchestratorHistoryLoader() {
    const scroller = taskTeamMount?.querySelector?.(".task-orch-transcript") || null;
    if (scroller !== orchestratorHistoryScroller) {
      // `detach`, not `dispose`: the helper returns { detach, sync }, so the
      // optional `dispose?.()` this used to call was a silent no-op and every
      // scroller swap left the old IntersectionObserver alive on a detached
      // node while a second one attached.
      orchestratorHistoryLoader?.detach?.();
      orchestratorHistoryLoader = null;
      orchestratorHistoryScroller = scroller;
      if (scroller) {
        orchestratorHistoryLoader = attachTranscriptHistoryLoader({
          onLoad: () => loadOlderOrchestratorTranscript(),
          scrollElement: scroller,
        });
      }
    }
    orchestratorHistoryLoader?.sync?.();
  }

  async function loadOlderOrchestratorTranscript() {
    const threadId = state.orchestratorEntriesThreadId;
    if (!threadId || typeof fetchTranscriptPage !== "function") {
      return null;
    }
    if (state.orchestratorOlderCursor == null) {
      return false;
    }
    if (state.orchestratorEntriesLoading || state.orchestratorOlderLoading) {
      return null;
    }
    const generation = state.orchestratorLoadGeneration || 0;
    state.orchestratorOlderLoading = true;
    try {
      const page = await fetchTranscriptPage(threadId, {
        before: state.orchestratorOlderCursor,
      });
      // A refresh or a restart landed while this was in flight; its entries are
      // the current ones and prepending to them would splice in a stale prefix.
      if (
        (state.orchestratorLoadGeneration || 0) !== generation
        || state.orchestratorEntriesThreadId !== threadId
      ) {
        return null;
      }
      applyOlderOrchestratorPage(state, threadId, page);
      if (state.session) {
        renderTaskTeam(state.session);
      }
      return state.orchestratorOlderCursor != null;
    } catch (error) {
      logLine(`Couldn't load older Orchestrator messages: ${error.message}`);
      return null;
    } finally {
      state.orchestratorOlderLoading = false;
      // Hand back the refresh this request made wait. Re-render rather than
      // calling the loader: the decision has to be retaken, not replayed.
      if (takeDeferredOrchestratorRefresh(state, orchestratorRefreshLatch) && state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  // Chat and task-start are separate channels on purpose; see orchestrator-chat.js.
  const orchestratorChat = createOrchestratorChatActions({
    state,
    sendMessage,
    proposeOrchestratorTask,
    confirmOrchestratorProposal,
    reviseOrchestratorProposal,
    teamsCache,
    onOpenTask,
    // The Orchestrator has no composer node under it, so the failure `sendMessage`
    // filed against its thread would otherwise never reach a screen.
    readSendError: (threadId) => composerErrorFor(threadId),
    renderTaskTeam: (session) => renderTaskTeam(session),
    renderSession: (session) => renderSession(session),
  });

  /**
   * Take images off a paste, if there are any.
   *
   * Returns whether it took them: the composer swallows the paste only then, so
   * pasting ordinary text still behaves like ordinary text. Limits are the same
   * ones every other composer uses — four images, 8 MB each, 16 MB together —
   * because "why did this one refuse" is a worse question than any limit.
   */
  function attachOrchestratorImages(clipboardData) {
    const files = pastedImageFiles(clipboardData);
    if (files.length === 0) {
      return false;
    }
    const existing = state.orchestratorImageAttachments || [];
    const { accepted, errors } = validateImageAttachments(existing, files);
    if (errors.length) {
      state.orchestratorSendError = errors[0];
    }
    if (accepted.length) {
      state.orchestratorImageAttachments = [
        ...existing,
        ...accepted.map((file) => ({
          id: `orch-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || "Pasted image",
          size: file.size,
          file,
        })),
      ];
    }
    if (state.session) {
      renderTaskTeam(state.session);
    }
    return true;
  }

  function removeOrchestratorAttachment(id) {
    state.orchestratorImageAttachments = (state.orchestratorImageAttachments || []).filter(
      (attachment) => attachment.id !== id
    );
    if (state.session) {
      renderTaskTeam(state.session);
    }
  }

  /**
   * Load one task's changes.
   *
   * Keyed by run AND base so switching either refetches, and guarded by the key
   * that was in flight: a slow request for the previous run must not paint over
   * a newer one. Read-only on the relay, so this is safe to call while the task
   * is still running — the tree is simply a moving target, which the panel says.
   */
  async function loadTaskDiff(teamRunId, base) {
    if (typeof fetchTeamDiff !== "function" || !teamRunId) {
      return;
    }
    const key = `${teamRunId}::${base || ""}`;
    if (state.taskDiffKey === key && (state.taskDiff || state.taskDiffLoading)) {
      void loadTaskReviewData(teamRunId);
      return;
    }
    state.taskDiffKey = key;
    state.taskDiffLoading = true;
    state.taskDiffError = null;
    if (state.session) renderTaskTeam(state.session);
    try {
      const data = await fetchTeamDiff(teamRunId, base);
      if (state.taskDiffKey !== key) return; // a newer request won
      state.taskDiff = data;
      // The relay decides which base actually answered; echo it back so the
      // picker shows what is on screen rather than what was asked for.
      state.taskDiffBase = data?.base || base || null;
      void loadTaskReviewData(teamRunId);
    } catch (error) {
      if (state.taskDiffKey !== key) return;
      state.taskDiff = null;
      state.taskDiffError = error?.message || String(error);
    } finally {
      if (state.taskDiffKey === key) {
        state.taskDiffLoading = false;
        if (state.session) renderTaskTeam(state.session);
      }
    }
  }

  /**
   * The line comments and review ticks for one task's diff.
   *
   * The key is the WHOLE guard, deliberately. This is reached from
   * `taskDiffPanel()`, which runs during render, and everything here down to the
   * first `await` is synchronous — including the `renderTaskTeam` below, which
   * re-enters this function through that same panel. So the guard has to answer
   * "has this key been started", not "has this key produced anything": on the
   * re-entry no result can exist yet, by construction.
   *
   * It used to also require `state.taskComments || state.taskReviewTicks`.
   * Those are results, so the guard never held on re-entry, and render recursed
   * into itself until the renderer process died — selecting a task killed the
   * tab outright, which reads as a freeze (no console, no way back). Note the
   * sibling `loadTaskDiff` gets this right: its guard includes
   * `state.taskDiffLoading`, the in-flight flag, not just the result.
   *
   * Nothing is lost by dropping the result clause, because every caller that
   * wants a refetch already invalidates explicitly: `refreshTaskReviewData` and
   * the base picker both null `state.taskReviewKey` first.
   */
  async function loadTaskReviewData(teamRunId) {
    if (!teamRunId) return;
    const key = `${teamRunId}::${state.taskDiffBase || ""}`;
    if (state.taskReviewKey === key) {
      return;
    }
    state.taskReviewKey = key;
    state.taskCommentsLoading = true;
    if (state.session) renderTaskTeam(state.session);
    try {
      const loaders = [];
      if (typeof fetchTaskLineComments === "function") {
        loaders.push(
          fetchTaskLineComments(teamRunId).then((data) => {
            if (state.taskReviewKey === key) state.taskComments = data;
          })
        );
      }
      if (typeof fetchTaskReviewTicks === "function") {
        loaders.push(
          fetchTaskReviewTicks(teamRunId).then((data) => {
            if (state.taskReviewKey === key) state.taskReviewTicks = data;
          })
        );
      }
      await Promise.all(loaders);
    } catch (error) {
      if (state.taskReviewKey === key) {
        state.taskCommentsError = error?.message || String(error);
      }
    } finally {
      if (state.taskReviewKey === key) {
        state.taskCommentsLoading = false;
        if (state.session) renderTaskTeam(state.session);
      }
    }
  }

  async function refreshTaskReviewData(teamRunId) {
    state.taskReviewKey = null;
    await loadTaskReviewData(teamRunId);
  }

  /**
   * The props both the summary panel and the review screen render from. One
   * builder, so the two cannot disagree about the selected base or whether a
   * comment landed — a divergence only visible after switching between them.
   * `rerender` differs because they live in different mounts.
   */
  function taskReviewProps(teamRunId, rerender) {
    void loadTaskDiff(teamRunId, state.taskDiffBase);
    return {
      data: state.taskDiff,
      loading: Boolean(state.taskDiffLoading),
      error: state.taskDiffError || null,
      selectedPath: state.taskDiffPath || null,
      comments: state.taskComments,
      commentsLoading: Boolean(state.taskCommentsLoading),
      commentScope: teamRunId ? `team_run:${teamRunId}` : "",
      reviewTicks: state.taskReviewTicks,
      onSelectPath: (path) => {
        state.taskDiffPath = path;
        rerender();
      },
      onSelectBase: (base) => {
        state.taskDiffBase = base;
        state.taskDiffPath = null;
        state.taskReviewKey = null;
        void loadTaskDiff(teamRunId, base);
      },
      onCreateComment:
        typeof createTaskLineComment === "function"
          ? async ({ path, side, line, body, base_commit: baseCommit }) => {
              await createTaskLineComment(
                teamRunId,
                { path, side, line, base_commit: baseCommit },
                body
              );
              await refreshTaskReviewData(teamRunId);
            }
          : null,
      onResolveComment:
        typeof resolveTaskLineComment === "function"
          ? async (commentId, action) => {
              await resolveTaskLineComment(commentId, action);
              await refreshTaskReviewData(teamRunId);
            }
          : null,
      onHandBackComment:
        typeof handBackTaskLineComment === "function"
          ? async (commentId) => {
              await handBackTaskLineComment(commentId);
              await refreshTaskReviewData(teamRunId);
            }
          : null,
      onToggleReviewTick:
        typeof tickTaskReviewFile === "function"
          ? async (path) => {
              await tickTaskReviewFile(teamRunId, path, "new", null);
              await refreshTaskReviewData(teamRunId);
            }
          : null,
    };
  }

  /** The node for `TaskDetail`'s existing "Changes on this branch" slot. */
  function taskDiffPanel(teamRunId) {
    if (!teamRunId || typeof fetchTeamDiff !== "function") {
      return null;
    }
    return React.createElement(TaskDiffPane, {
      ...taskReviewProps(teamRunId, () => {
        if (state.session) renderTaskTeam(state.session);
      }),
      // One entry point to the full screen, so there is one to keep working.
      onOpenReview: onOpenReviewScreen ? () => onOpenReviewScreen(teamRunId) : null,
    });
  }

  /**
   * The full-screen merge review (15a). Reads its run id from the CONTEXT, not a
   * remembered selection, so a reload lands on the run the history entry names.
   */
  function renderReviewScreen() {
    if (!reviewScreenMount) {
      return;
    }
    const teamRunId = getViewContext()?.teamRunId || null;
    if (!teamRunId || typeof fetchTeamDiff !== "function") {
      renderReactContent(reviewScreenMount, null);
      return;
    }
    renderReactContent(
      reviewScreenMount,
      h(TaskReviewScreen, {
        ...taskReviewProps(teamRunId, () => renderReviewScreen()),
        onBack: () => onOpenTask?.(teamRunId),
      })
    );
  }

  async function sendOrchestratorMessage(text, threadId) {
    const attached = (state.orchestratorImageAttachments || []).slice();
    let images = [];
    if (attached.length) {
      try {
        images = await Promise.all(
          attached.map(async (attachment) => ({
            data_url: await imageFileToDataUrl(attachment.file),
          }))
        );
      } catch (error) {
        // Reading failed, so nothing was sent: keep the attachments where they
        // are rather than dropping work the user can still retry.
        state.orchestratorSendError = `Image attachment failed: ${error?.message || error}`;
        if (state.session) {
          renderTaskTeam(state.session);
        }
        return;
      }
    }
    await orchestratorChat.send(text, threadId, images);
    // Cleared only on a send that was accepted — `send` records its own failure
    // in `orchestratorSendError`, and re-sending should still have the images.
    if (!state.orchestratorSendError) {
      const sent = new Set(attached.map((attachment) => attachment.id));
      state.orchestratorImageAttachments = (state.orchestratorImageAttachments || []).filter(
        (attachment) => !sent.has(attachment.id)
      );
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  async function proposeFromOrchestratorDraft(text) {
    await orchestratorChat.propose(text);
  }

  async function confirmOrchestratorProposalCard(proposalId) {
    if (!proposalId || typeof confirmOrchestratorProposal !== "function") {
      return;
    }
    state.orchestratorProposalBusy = true;
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      await orchestratorChat.confirm(proposalId);
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      state.orchestratorProposalBusy = false;
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  async function setOrchestratorProposalAutoStart(proposalId, autoStart) {
    if (!proposalId || typeof reviseOrchestratorProposal !== "function") {
      return;
    }
    state.orchestratorProposalBusy = true;
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      await orchestratorChat.revise(proposalId, { auto_start: Boolean(autoStart) });
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      state.orchestratorProposalBusy = false;
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  async function dismissOrchestratorProposalCard(proposalId) {
    if (!proposalId || typeof dismissOrchestratorProposal !== "function") {
      return;
    }
    state.orchestratorProposalBusy = true;
    state.orchestratorSendError = null;
    if (state.session) {
      renderTaskTeam(state.session);
    }
    try {
      await dismissOrchestratorProposal(proposalId);
      if (state.session) {
        state.session = {
          ...state.session,
          orchestrator_proposals: (state.session.orchestrator_proposals || []).filter(
            (entry) => entry?.id !== proposalId
          ),
        };
      }
    } catch (error) {
      state.orchestratorSendError = error?.message || String(error);
    } finally {
      state.orchestratorProposalBusy = false;
      if (state.session) {
        renderTaskTeam(state.session);
      }
    }
  }

  function renderTeamsLibrary(session) {
    if (!teamsLibraryMount) {
      return;
    }
    const context = getViewContext() || {};
    const teams = teamsFromCatalog(state.teamCatalog);
    renderReactContent(
      teamsLibraryMount,
      h(TeamsLibraryScreen, {
        teams,
        selectedTeamId: context.teamId || BUILTIN_TEAM_ID,
        locked: tasksLocked(session),
        onSelectTeam: (teamId) => onOpenTeamsScreen?.(teamId),
        onBackToTasks: () => onOpenTasksScreen?.(),
      })
    );
  }

  async function loadTeamCatalog() {
    if (typeof fetchTeamCatalog !== "function" || tasksLocked(state.session)) {
      state.teamCatalog = { enabled: false, teams: listLibraryTeams().map((team) => ({
        id: team.id,
        name: team.name,
        persistent: team.persistent,
        role_count: team.roleCount,
        focus: team.focus,
        current_version_id: team.currentVersionId,
        roles: team.roles.map((role) => ({
          id: role.id,
          name: role.name,
          seat: role.seat,
          blurb: role.blurb,
          estimate_label: role.estimateLabel,
        })),
        stats: {},
      })) };
      renderSidebarTeamsList();
      if (getViewContext()?.kind === "teams") {
        renderTeamsLibrary(state.session);
      }
      renderSidebarTaskList();
      return;
    }
    try {
      state.teamCatalog = await fetchTeamCatalog();
    } catch (error) {
      state.teamCatalogError = error?.message || String(error);
      if (!state.teamCatalog) {
        state.teamCatalog = { enabled: false, teams: [] };
      }
    }
    renderSidebarTeamsList();
    renderSidebarTaskList();
    if (getViewContext()?.kind === "teams") {
      renderTeamsLibrary(state.session);
    }
  }

  // Fill the main-area card overview for the active project. Callers gate this on
  // mainView === "project-overview" (see renderSession); it owns pin/reorder writes
  // (client-side, project-overview-prefs) and re-renders itself after each.
  function renderProjectOverview() {
    if (!projectOverviewMount) {
      return;
    }
    const activeProjectId = readActiveProjectId(state.threadListStore);
    // Loading / error states: only shown before the FIRST successful load, so a
    // background refresh never blanks an already-rendered overview.
    if (!state.projectsLoaded) {
      renderReactContent(
        projectOverviewMount,
        h(
          "div",
          { className: "project-overview-empty" },
          h("h3", null, state.projectsError ? "Projects unavailable" : "Loading projects…"),
          state.projectsError ? h("p", null, String(state.projectsError)) : null
        )
      );
      return;
    }
    const project = (state.projects || []).find((entry) => entry.id === activeProjectId) || null;
    const prefs = loadProjectPrefs(activeProjectId);
    const agents = sortProjectCards(
      selectProjectAgents({
        projectId: activeProjectId,
        threads: state.threads,
        threadProjectId: state.threadProjectId || {},
      }),
      prefs
    );
    renderReactContent(
      projectOverviewMount,
      h(ProjectOverview, {
        project,
        agents,
        pinnedIds: new Set(prefs.pinned),
        threadActivity: buildThreadActivityMap(state.session),
        threadAttention: threadAttention.snapshotMap(),
        threadReviewing: buildReviewingThreadSet(state.session, reviewsCache.current()),
        formatMeta(thread) {
          return formatRelativeTime(thread.updated_at);
        },
        onOpenAgent(threadId, { preview = true } = {}) {
          // Opening clears the attention dot and doubles as the gesture that unlocks
          // notification permission — mirrors the sidebar's onResumeThread, peek
          // semantics and skipped transition included. A card and a row are two
          // doors onto the same list; they must not disagree about what a click
          // does to the tab strip.
          threadAttention.clear(threadId);
          void ensureNotificationPermission();
          if (typeof viewThread === "function") {
            viewThread(threadId, { preview, transition: !preview });
          }
        },
        onTogglePin(threadId) {
          toggleProjectPin(activeProjectId, threadId);
          renderProjectOverview();
        },
        onReorder(orderedIds) {
          setProjectOrder(activeProjectId, orderedIds);
          renderProjectOverview();
        },
        onNewAgent(projectId) {
          if (typeof startProjectAgent === "function") {
            startProjectAgent(projectId);
          }
        },
      })
    );
  }

  function renderWorkspaceSuggestions(session) {
    if (!workspaceSuggestionsList) {
      return;
    }

    const suggestions = selectWorkspaceSuggestionsModel({
      session,
      selectedCwd: state.selectedCwd,
      threads: state.threads || [],
    });

    workspaceSuggestionsList.replaceChildren(
      ...suggestions.map((suggestion) => {
        const option = document.createElement("option");
        option.value = suggestion.cwd;
        option.label = suggestion.label || workspaceBasename(suggestion.cwd);
        return option;
      })
    );
  }

  function renderThreadListMessage(countLabel, message) {
    // rerender:false — this function renders its own (empty) thread-list content
    // just below, so let closeThreadContextMenu skip its own renderThreads().
    closeThreadContextMenu({ rerender: false });
    threadsCount.textContent = countLabel;
    threadsCount.title = "";
    renderReactContent(
      threadsList,
      h(ThreadGroupList, {
        emptyMessage: message,
        groups: [],
      })
    );
  }

  function syncThreadSelection() {
    if (!threadsList) {
      return;
    }

    const viewedThreadId = state.viewThreadId || null;
    threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.threadId === viewedThreadId);
    });
  }

  function syncThreadHistoryScroll() {
    if (!threadsList || !sessionHistoryDrawer || !appShell) {
      return;
    }

    if (appShell.dataset.view !== "conversation") {
      threadsList.style.height = "";
      threadsList.style.maxHeight = "";
      return;
    }

    window.requestAnimationFrame(() => {
      const listRect = threadsList.getBoundingClientRect();
      const drawerRect = sessionHistoryDrawer.getBoundingClientRect();
      const availableHeight = Math.floor(drawerRect.bottom - listRect.top - 12);

      if (availableHeight > 120) {
        threadsList.style.height = `${availableHeight}px`;
        threadsList.style.maxHeight = `${availableHeight}px`;
      }
    });
  }

  function restoreThreadHistoryScroll() {
    if (!threadsList || !appShell || appShell.dataset.view !== "conversation") {
      return;
    }

    const desiredScrollTop =
      state.pendingThreadHistoryScrollTop ?? state.threadHistoryScrollTop ?? 0;
    if (desiredScrollTop <= 0) {
      return;
    }

    const applyScrollPosition = () => {
      const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
      threadsList.scrollTop = Math.min(desiredScrollTop, maxScrollTop);
      state.threadHistoryScrollTop = threadsList.scrollTop;
    };

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyScrollPosition();
      });
    });

    window.setTimeout(() => {
      if (appShell?.dataset.view === "conversation") {
        applyScrollPosition();
      }
    }, 160);
  }

  function runViewTransition(update) {
    const startViewTransition = document.startViewTransition?.bind(document);
    if (typeof startViewTransition !== "function") {
      return Promise.resolve().then(update);
    }

    // Navigation commits can include an IndexedDB transaction. Returning the update
    // promise keeps the browser transition open until canonical state, history and
    // the first render have all crossed the same boundary.
    const transition = startViewTransition(() => Promise.resolve().then(update));

    return transition.finished.catch(() => {});
  }

  function renderLogs(entries) {
    // Feed the relay's server logs into the merged client-log view. This must
    // NOT replace the whole surface (the old behavior), or client-originated
    // status lines like "Prompt failed: ..." would be wiped on the next
    // snapshot before the user (or a test) can observe them.
    ingestRelayLogs?.(entries || []);
  }

  function metaChip(label, value) {
    return { label, value };
  }

  function overviewBadge(label, value) {
    return { label, value };
  }

  function classifyAuditEntry(entry) {
    const text = `${entry?.kind || ""} ${entry?.message || ""}`.toLowerCase();

    if (
      text.includes("failed") ||
      text.includes("denied") ||
      text.includes("rejected") ||
      text.includes("revoked") ||
      text.includes("offline") ||
      text.includes("disconnected")
    ) {
      return "alert";
    }

    if (
      text.includes("pairing approval required") ||
      text.includes("approval required for")
    ) {
      return "alert";
    }

    if (text.includes("approval") && text.includes("requested")) {
      return "alert";
    }

    if (
      text.includes("approved") ||
      text.includes("accepted") ||
      text.includes("started") ||
      text.includes("resumed") ||
      text.includes("connected") ||
      text.includes("saved") ||
      (text.includes("responded to approval") && text.includes("approve"))
    ) {
      return "ready";
    }

    if (text.includes("responded to approval") && text.includes("deny")) {
      return "alert";
    }

    return "neutral";
  }

  return {
    renderAuthRequiredState,
    renderOverviewState,
    renderSession,
    renderSidebarChrome,
    renderSidebarNav,
    renderSessionMeta,
    renderSessionUnavailable,
    renderThreadListMessage,
    renderThreads,
    restoreThreadHistoryScroll,
    runViewTransition,
    syncThreadHistoryScroll,
    syncThreadSelection,
  };
}
