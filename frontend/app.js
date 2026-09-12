import {
  allowedRootsForm,
  allowedRootsInput,
  allowedRootsList,
  allowedRootsSummary,
  apiTokenInput,
  apiTokenLabel,
  appShell,
  applyTokenButton,
  archiveThreadButton,
  renameThreadButton,
  flagThreadButton,
  approvalPolicyInput,
  auditSummary,
  auditTimeline,
  chatShell,
  clientLogRoot,
  closeLaunchSettingsModalButton,
  closeSessionDetailsModalButton,
  closeSettingsModalButton,
  settingsModal,
  iconRailSettingsButton,
  sidebarTaskListMount,
  startTaskDialogMount,
  composerAttachments,
  composerCommandMount,
  connectionForm,
  controlBanner,
  copyPairingLinkButton,
  cwdInput,
  deleteThreadButton,
  projectContextMenu,
  renameProjectMenuButton,
  deleteProjectMenuButton,
  directoryForm,
  forkSessionDialogRoot,
  forkThreadButton,
  goConsoleHomeButton,
  launchSettingsModal,
  loadDirectoryButton,
  messageEffort,
  messageForm,
  messageInput,
  messageModel,
  modelInput,
  modelInputLabel,
  openLaunchSettingsButton,
  openSessionDetailsButton,
  overviewSecurityBadges,
  pairedDevicesList,
  pairingApprovalList,
  pairingApprovalModal,
  closePairingApprovalModalBtn,
  pendingActionBanner,
  pendingPairingsList,
  providerInput,
  sandboxInput,
  saveAllowedRootsButton,
  sendButton,
  sessionDetailsModal,
  sessionHistoryDrawer,
  sessionMeta,
  startEffortInput,
  startEffortLabel,
  startPairingButton,
  startPromptInput,
  startSessionButton,
  statusBadge,
  agentWorkingIndicator,
  agentWorkingIndicatorLabel,
  stopButton,
  threadContextMenu,
  threadProjectActions,
  threadProjectSubmenu,
  threadProjectSubmenuTrigger,
  threadProjectCurrentLabel,
  threadsCount,
  threadsList,
  threadsRefreshButton,
  transcript,
  workspaceSubtitle,
  workspaceDiffModal,
  closeWorkspaceDiffModalButton,
  workspaceDiffTitleMount,
  workspaceDiffMount,
  workspaceChangesMount,
  workspaceDiffChipMount,
  reviewerChipMount,
  sidebarElement,
  sidebarResizeHandle,
  rightRailResizeHandle,
  toggleLeftPanelButton,
  toggleRightPanelButton,
  sidebarTopToggleButton,
  railTopToggleButton,
  newSessionComposeButton,
} from "./local/dom.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { StartSessionSplitButton } from "./shared/start-session-split-button.js";
import { reviewerPreviewEntriesFromPage } from "./shared/reviewer-panel.js";
import {
  createApiFetch,
  createAuthSession,
  deleteAuthSession,
  fetchAuthSession,
  getDevices,
  getReviews,
  getWorkflows,
  getTeams,
  startTeam,
  teamAction,
  deleteTeam,
  getUsage,
  getTeamCatalog,
  ensureOrchestrator,
  resetOrchestrator,
  getTeamDiff,
  listLineComments,
  createLineComment,
  resolveLineComment,
  handBackLineComment,
  listReviewTicks,
  tickReviewFile,
  teamRunCommentScope,
  proposeOrchestratorTask,
  confirmOrchestratorProposal,
  reviseOrchestratorProposal,
  dismissOrchestratorProposal,
  setUsageBudget,
} from "./local/api.js";
import {
  createWorkspaceDiffStore,
  createWorkspaceDiffSheet,
  mountChangesPanel,
  mountChip,
  mountReviewerChip,
} from "./local/workspace-diff.js";
import { createPanelControl } from "./local/panel-controls.js";
import { setupHeaderBandSync } from "./local/header-band-sync.js";
import {
  createVerbCycler,
  isProgressStalled,
  progressPhaseLabel,
  VERB_CYCLE_MS,
} from "./progress-verbs.js";
import {
  configureSecurityRenderers,
  renderAllowedRoots,
  renderDeviceRecords,
  renderPairingApprovalModal,
  renderPairingPanel,
  renderPendingPairingRequests,
} from "./local/render-security.js";
import { createSessionRenderer } from "./local/render-session.js";
import { createSessionController } from "./local/session-controller.js";
import {
  runLocalBootDataPhase,
  syncProjectsForSession,
} from "./local/boot-session-view.js";
import { resolveDirectRenderSession } from "./local/session/render-session-flush.js";
import {
  createLocalUiStore,
  readLocalUiState,
} from "./local/ui-store.js";
import { openSessionStream, sessionStreamUrl } from "./session-stream.js";
import {
  buildNavigationThreadGroups,
} from "./shared/thread-groups.js";
import { findThreadInSearchResults, findVisibleThread } from "./shared/thread-search.js";
import { createTranscriptInteractionHandler } from "./shared/transcript-interactions.js";
import { createViewOnlyRefreshOps } from "./local/view-only-refresh-ops.js";

import {
  createThreadListStore,
  readActiveProjectId,
  readThreadFilter,
  readThreadListContextMenu,
  readThreadListUi,
  readThreadSelection,
} from "./shared/thread-list-store.js";
import {
  applyThreadSelectionClick,
  describeBulkDelete,
  pruneThreadSelection,
  resolveContextMenuTargets,
  threadSelectionIntent,
} from "./shared/thread-multi-select.js";
import { matchesApplePlatform } from "./shared/composer-keys.js";
import { createComposerCommandController } from "./local/composer-commands.js";
import { canRequestReview, selectReviewLaunchModel } from "./shared/review-state.js";
import { createProjectsStore } from "./shared/projects-store.js";
import { createDevicesCache } from "./shared/devices-cache.js";
import { createReviewsCache } from "./shared/reviews-cache.js";
import { createWorkflowsCache } from "./shared/workflows-cache.js";
import { createTeamsCache } from "./shared/teams-cache.js";
import { markTaskSeen } from "./local/task-seen-prefs.js";
import { StartTaskDialog } from "./shared/start-task-dialog.js";
import { BUILTIN_TEAM_ID, teamsFromCatalog } from "./shared/teams-library-model.js";
import {
  fetchProjectsPayload,
  createProject,
  renameProject,
  renameThread,
  setThreadFlag,
  deleteProject,
  assignThreadToProject,
  unassignThread,
} from "./local/project-actions.js";
import {
  applyRenameToRow,
  normalizeThreadName,
  threadCustomName,
  threadNameChanged,
  threadNameDraft,
} from "./shared/thread-rename.js";
import {
  buildProjectMenuItems,
  currentProjectLabel,
  pickNewProjectId,
  normalizeProjectName,
  placeProjectSubmenu,
  projectsMenuReady,
  projectMenuActionAllowed,
} from "./shared/project-menu.js";
import { installThreadListWheelProxy } from "./shared/thread-list-scroll.js";
import {
  positionContextMenuElement,
  updateContextMenuContent,
} from "./shared/context-menu-position.js";
import { fetchBuildInfo } from "./shared/build-badge.js";
import { providerLabel } from "./shared/provider-labels.js";
import { applyProviderMark } from "./shared/provider-mark.js";
import { ForkSessionDialog } from "./shared/fork-session-dialog.js";
import { forkCompletionEffect } from "./local/fork-submit-ownership.js";
import {
  INHERIT,
  applyForkProviderChange,
  defaultForkFields,
  forkPointIsTranscriptTip,
  resolveForkSourceThread,
  threadIsBusyForFork,
} from "./shared/fork-fields.js";
import { providerSupportsArchive } from "./shared/thread-actions-model.js";
import { reportDestructiveActionFailure } from "./shared/destructive-action-failure.js";
import {
  buildReviewingThreadSet,
  isReviewInProgressForThread,
  isTerminalReviewStatus,
} from "./shared/review-state.js";
import { buildThreadActivityMap } from "./shared/thread-activity.js";
import { threadAttention } from "./shared/thread-attention.js";
import { isWorkflowInProgressForThread } from "./shared/workflow-state.js";
import {
  buildViewOnlyPin,
  projectViewOnlySession,
} from "./local/view-only-thread.js";
import { createWatchedThreadsSync } from "./local/watched-threads.js";
import { ClientLog } from "./shared/client-log.js";
import { mapRelayLogEntries, mergeLogEntries } from "./shared/client-log-merge.js";
import { SessionTabStrip, buildSessionTabItems } from "./shared/session-tab-strip.js";
import { ProjectSwitcher } from "./shared/project-switcher.js";
import { StartSessionDialog } from "./shared/start-session-dialog.js";
import { selectWorkspaceSuggestionsModel } from "./shared/workspace-suggestions.js";
import {
  decideWorkspaceRefresh,
  localViewedWorkspaceKey,
} from "./shared/viewed-workspace-key.js";
import { createProjectAndSelect } from "./shared/project-create.js";
import {
  layoutThreadIds,
} from "./shared/tab-layout.js";
import {
  createBrowserSessionViewHistoryAdapter,
  createSessionViewController,
  createSessionViewStore,
} from "./shared/session-view-controller.js";
import {
  openReviewDestination,
  openTicketDestination,
  openSessionsDestination,
  openTasksDestination,
  openTeamsDestination,
  openUsageDestination,
} from "./shared/nav-destinations.js";
import {
  browserSessionViewPersistence,
} from "./shared/session-view-persistence.js";
import {
  selectContextAfterProjectDelete,
  sessionViewContextKey,
} from "./shared/session-view-state.js";
import {
  loadRemovedThreadIds,
  rememberRemovedThreadId,
} from "./shared/removed-threads.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
  saveLastApprovalPolicy,
  saveLastEffort,
} from "./shared/last-used-settings.js";
import {
  renderSelectOptions,
  syncModelSuggestions,
} from "./shared/select-options.js";
import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "./shared/reasoning-efforts.js";
import {
  defaultModelForProvider,
  defaultProvider,
  normalizeProviderList,
  providerOptions,
  providerSettings,
  sandboxOptions,
  scopedProviderModels,
} from "./shared/provider-settings.js";
import { localQueryClient } from "./local/query-client.js";
import { copyTextToClipboard } from "./shared/clipboard.js";
import {
  countReviewerThreadsForParent,
  reviewerChoiceRequestInit,
} from "./shared/reviewer-threads.js";
import {
  formatAttachmentBytes,
  imageFileToDataUrl,
  pastedImageFiles,
  validateImageAttachments,
} from "./local/image-attachments.js";

const DEVICE_STORAGE_KEY = "agent-relay.device-id";
const API_TOKEN_STORAGE_KEY = "agent-relay.api-token";

// Identifies this page load as a CONNECTION, distinct from the device identity below.
//
// Deliberately NOT persisted. sessionStorage looks per-tab, but the browser COPIES it
// into a tab you duplicate (and into `window.open`/`target=_blank` children), so both
// tabs would come up claiming the same surface id and the relay — which keys watch sets
// by surface — would treat them as one. The later one would win and the other's live
// tail would just stop.
//
// A fresh id per page load has no such failure mode and costs nothing: it is stable for
// the page's lifetime (so an SSE reconnect keeps it, and the connection generation
// arbitrates old vs new stream), and a reload's orphaned entry is removed when its SSE
// stream drops.
//
// This cache MUST stay above `state`: `state` is built during module evaluation and
// calls loadOrCreateSurfaceId(). The function declaration hoists, but a `let` below
// `state` would still be in its temporal dead zone when that call runs, so the whole
// module throws "Cannot access 'cachedSurfaceId' before initialization" and the app
// never boots.
let cachedSurfaceId = null;

function loadOrCreateSurfaceId() {
  cachedSurfaceId ||= window.crypto?.randomUUID?.()
    ? window.crypto.randomUUID()
    : `surface-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return cachedSurfaceId;
}

export { loadOrCreateSurfaceId };

const state = {
  apiToken: loadApiToken(),
  authRequired: false,
  authenticated: false,
  cookieSession: false,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  currentPairing: null,
  // Client-originated status lines (sends, errors, etc.) kept as {at, text} so
  // they can be merged with the relay's server logs in one #client-log view.
  // These PERSIST across snapshots — a server-log refresh must not wipe them.
  clientLogLines: [{ at: Date.now(), text: "Booting web client..." }],
  // Latest server (relay) log entries, refreshed from each session snapshot.
  relayLogLines: [],
  deviceId: loadOrCreateDeviceId(),
  // Identifies this PAGE LOAD, held only in memory, where deviceId identifies the
  // browser (localStorage). The relay filters the live delta stream per surface so two
  // tabs can watch different threads without silencing each other.
  //
  // Deliberately NOT sessionStorage: the browser copies sessionStorage into a duplicated
  // tab, so both copies would claim one surface id, the later connection generation would
  // win, and the loser's live tail would stop with no error and no spinner — snapshots
  // keep arriving, so the sidebar and status dots still look healthy. An in-memory id
  // cannot be copied, so duplicating a tab always yields a fresh surface.
  surfaceId: loadOrCreateSurfaceId(),
  defaultsSeeded: false,
  selectedCwd: "",
  session: null,
  // Compatibility read mirror for renderers. Replaced with a getter backed by the
  // canonical session-view store immediately after state construction.
  viewThreadId: null,
  // Read-only "view projection" pin for ANY non-active thread the user is looking
  // at (see local/view-only-thread.js). `{ threadId, entries, olderCursor,
  // generation, review, reviewSig, loading }` or null. Loaded by
  // loadViewOnlyTranscript() below; paginated by loadOlderViewOnlyTranscript().
  viewOnlyThread: null,
  viewOnlyGeneration: 0,
  // Per-thread "your workspace is gone" state, keyed by thread id:
  // `{ workspaceMissing, pending, error }` (see local/workspace-repair.js). Written
  // from each transcript TAIL response — `workspace_missing` rides `thread_state`,
  // which no session snapshot carries — and read by the control banner, which turns
  // into the repair action instead of a take-over the user cannot use.
  workspaceRepairByThread: new Map(),
  // True while a composer submit is in flight.
  // Freezes the composer and rejects re-entry so a draft edit / navigation /
  // double-submit during the async request can't change or duplicate the send.
  composerSubmitInFlight: false,
  composerImageAttachments: [],
  nextComposerImageAttachmentId: 1,
  newSessionSubmitInFlight: false,
  // Git standing of the launch dialog's chosen directory; null when unknown or
  // when the directory is not a repo.
  launchGitContext: null,
  // Bumped on every opening. A DOM `open` check cannot tell a reopened dialog from
  // the one an in-flight request was started against.
  launchDialogGeneration: 0,
  // Same, for the fork dialog. Separate because the two dialogs can hold
  // different directories and neither should show the other's answer.
  forkGitContext: null,
  newSessionImageAttachments: [],
  nextNewSessionImageAttachmentId: 1,
  forkImageAttachments: [],
  nextForkImageAttachmentId: 1,
  // Bumped on every fork-dialog opening so an in-flight submit can tell whether
  // the dialog it started from is still the one on screen.
  forkDialogGeneration: 0,
  sessionStream: null,
  streamConnected: false,
  transcriptEntryDetailCache: new Map(),
  transcriptEntryDetailOrder: [],
  transcriptHydrationBaseSnapshot: null,
  transcriptHydrationEntries: new Map(),
  transcriptHydrationLastFetchAt: 0,
  transcriptHydrationOrder: [],
  transcriptHydrationOlderCursor: null,
  transcriptHydrationPromise: null,
  transcriptHydrationSignature: null,
  transcriptHydrationStatus: "idle",
  transcriptHydrationTailReady: false,
  transcriptHydrationThreadId: null,
  // Bumped on every per-item delta refusal (session/stream.js), so a tail
  // fetch already in flight when the refusal happens reads back stale on
  // arrival — see shared/transcript-hydration.js's isStaleTranscriptPage.
  transcriptRefusalEpoch: 0,
  transcriptLiveEntryDetails: new Map(),
  transcriptLiveEntryThreadId: null,
  transcriptPreserveScroll: false,
  pendingThreadHistoryScrollTop: null,
  providerModels: {},
  providers: [],
  forkDialog: {
    open: false,
    pending: false,
    sourceThread: null,
    fields: null,
  },
  threadGroups: [],
  // Title-search results, held SEPARATELY from `state.threads`/`state.threadGroups`.
  // Those two are the authoritative list (the poll rewrites them; tab restore, delete
  // fallbacks and the context-menu liveness check read them); a narrowed copy in there
  // would make every non-matching session look deleted. See shared/thread-search.js.
  threadSearch: { query: "", groups: [], loading: false, error: null, unavailableProviders: [] },
  // The bell used to be a field right here. It now lives on `threadListStore` — see
  // shared/thread-list-store.js — because remote held a byte-identical copy of it and the
  // two were free to drift. Read it with `readThreadFilter(state.threadListStore)`.
  projects: [],
  threadProjectId: {},
  projectsLoading: false,
  projectsError: null,
  projectsLoaded: false,
  // Task screen. `teamActionPending` holds the verb in flight so the buttons can
  // disable together — five whole-run actions on one run must not overlap, and the
  // backend's own gate would refuse the second with an error the user never asked
  // to see.
  teamsError: null,
  teamActionPending: null,
  teamActionError: null,
  // When a session is started via a project overview's "New agent" button, this holds
  // that project's id so the freshly-created thread can be auto-assigned to it. Set at
  // "New agent" time, consumed once by the next start, and cleared by any plain
  // new-session opener so a normal launch never inherits a stale project.
  threadHistoryScrollTop: 0,
  // Sessions this browser archived/deleted. History entries outlive threads, so
  // back/forward can land on a `?thread=` that no longer exists; without a tombstone
  // the popstate handler would helpfully re-create a tab for a dead session.
  // Tracked rather than inferred from `state.threads`, which is capped at 120 and
  // would false-negative a live-but-old session. Restored from storage because the
  // stale history entries survive a reload too.
  removedThreadIds: new Set(loadRemovedThreadIds()),
  // The sessions the OPEN right-click menu acts on — one row, or the whole
  // multi-selection it was opened inside. Snapshotted at open time so the action
  // cannot be re-derived against a selection that has since been torn down.
  contextMenuThreadIds: [],
  threadListStore: createThreadListStore(),
  sessionViewStore: null,
  sessionViewController: null,
  localUiStore: createLocalUiStore(),
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threads: [],
  threadsPollTimer: null,
};

// Archive/delete remove a row from the authoritative list; the search slice holds its
// own copy and has to be swept too.
function dropThreadFromSearchResults(threadId) {
  const search = state.threadSearch;
  if (!search?.groups?.length) {
    return;
  }
  state.threadSearch = {
    ...search,
    groups: search.groups
      .map((group) => ({
        ...group,
        threads: (group.threads || []).filter((thread) => thread.id !== threadId),
      }))
      .filter((group) => group.threads.length),
  };
}

// Look a thread up by id across everything the user can currently SEE.
//
// A function declaration (not a const) so the lookup sites above it hoist correctly.
// See `findVisibleThread` for why iteration must NOT use this.
function findVisible(threadId) {
  return findVisibleThread({ threads: state.threads, search: state.threadSearch }, threadId);
}

const sessionViewStore = createSessionViewStore({
  initialLocation: {
    context: { kind: "sessions" },
    threadId: null,
  },
  persistence: browserSessionViewPersistence,
  onError(error) {
    logLine(`Session view persistence failed: ${error.message}`);
  },
});
state.sessionViewStore = sessionViewStore;
Object.defineProperty(state, "viewThreadId", {
  configurable: false,
  enumerable: true,
  get() {
    return sessionViewStore.getState().location.threadId;
  },
});

const sessionViewController = createSessionViewController({
  store: sessionViewStore,
  historyAdapter: createBrowserSessionViewHistoryAdapter(window),
  // Until the dedicated Projects payload has loaded, absence is not evidence of
  // deletion. Returning null tells history restoration to preserve project context
  // and cold buckets; the projects subscription reconciles again once authoritative.
  getProjectIds() {
    return state.projectsLoaded
      ? (state.projects || []).map((project) => project.id)
      : null;
  },
  getUnavailableThreadIds() {
    return new Set([
      ...loadRemovedThreadIds(),
      ...state.removedThreadIds,
    ]);
  },
  onCommit(change) {
    syncThreadListViewFromContext(change.next.location.context);
    if (change.locationChanged) {
      clearComposerImageAttachments();
    }
  },
  onError(error, details) {
    logLine(
      `Session view ${details?.phase || "transaction"} failed: ${error.message}`
    );
  },
});
state.sessionViewController = sessionViewController;

const apiFetch = createApiFetch({
  getApiToken() {
    return state.apiToken;
  },
  onUnauthorized(message) {
    handleUnauthorized(message);
  },
});

const devicesCache = createDevicesCache();
const reviewsCache = createReviewsCache();
const workflowsCache = createWorkflowsCache();
const teamsCache = createTeamsCache();

const viewedThreadId = () => state.viewThreadId || state.session?.active_thread_id || null;
const workspaceDiffStore = createWorkspaceDiffStore({
  apiFetch,
  surface: "local",
  // The local surface is the only one that can grant, so it is the only one that passes
  // this: the remote store omits it and its panels go read-only. `trustWorkspace` is a
  // hoisted function declaration further down this module.
  trustWorkspace,
  // Diff follows the session the user is viewing, not whichever thread is active.
  getThreadId: viewedThreadId,
  // Reset identity = viewed thread + its cwd, so a same-thread cwd change also
  // clears the stale diff during loading (not just a thread switch).
  getWorkspaceKey: () => localViewedWorkspaceKey({
    session: state.session,
    viewThreadId: viewedThreadId(),
    viewOnlyThread: state.viewOnlyThread,
  }),
});
// Projects ride a dedicated channel off the byte-budgeted snapshot; this store fetches
// the payload when `projects_revision` changes (see createProjectsStore) and feeds it
// into state so the sidebar can group by Project.
const projectsStore = createProjectsStore({
  fetchProjects: () => fetchProjectsPayload(apiFetch),
});
// Monotonic token bumped on every Projects-store transition. A context-menu button
// captures the token at build time; runThreadProjectAction() refuses to act if it has
// since advanced, so a button built from now-stale Project state can't mutate.
let projectsStateSeq = 0;
let reconciledProjectSignature = null;
projectsStore.subscribe((projectsState) => {
  state.projects = projectsState.projects;
  state.threadProjectId = projectsState.threadProjectId;
  state.projectsLoading = projectsState.loading;
  state.projectsError = projectsState.error;
  state.projectsLoaded = projectsState.loaded;
  // The launch dialog's project chip reads this list; without a nudge a project
  // created or refreshed while the dialog is open never appears in its menu.
  renderLaunchSessionDialogIfOpen();
  if (!projectsState.loaded) {
    reconciledProjectSignature = null;
  }
  projectsStateSeq += 1;
  // The switcher lists projects in EVERY mode — that is how you reach one from "All
  // sessions" — so it refreshes unconditionally, outside the projects-mode gate below.
  renderProjectSwitcher();
  // Re-render on ANY change (loading/loaded/error transitions) while the Projects
  // view is showing, so its loading/error placeholder resolves to the grouping.
  // `renderThreads`/`renderSession` are module consts defined below; this callback
  // only ever fires asynchronously (after a fetch settles), by which point they are
  // initialized.
  // Unconditional now. The sidebar renders project-derived data in EVERY state — the
  // pinned group's name and its activity roll-up — so gating this on "a project is
  // selected" would leave a rename unpainted exactly when the rename mattered.
  if (projectsState.loaded && !projectsState.loading && !projectsState.error) {
    void dropStaleProjectSelection();
  }
  renderThreads();
  if (state.session) {
    renderSession(state.session);
  }
  // Project ids become authoritative only after a successful payload. Re-run the
  // current location as RESTORE_HISTORY once per project set so a deleted selected
  // project falls to Projects home and its cold IndexedDB bucket is deleted. During
  // initial loading/error we deliberately retain project context and persisted tabs.
  if (
    projectsState.loaded
    && !projectsState.loading
    && !projectsState.error
  ) {
    const signature = JSON.stringify(
      projectsState.projects.map((project) => project.id)
    );
    if (signature !== reconciledProjectSignature) {
      reconciledProjectSignature = signature;
      void (async () => {
        // A local create/select command may already be queued behind the Projects
        // response that triggered this subscriber. Read location only AFTER earlier
        // navigation commits, or an old Projects-home snapshot can replace the newly
        // selected project's history entry.
        await sessionViewController.whenIdle();
        const location = sessionViewStore.getState().location;
        await sessionViewController.restoreHistory(
          { version: 1, context: location.context },
          location.threadId
        );
      })();
    }
  }
  // Keep an OPEN context menu's Project section in sync regardless of view mode —
  // a settled refresh/failure must repopulate (fresh membership) or fall closed
  // (loading/error note) rather than leave stale assign/unassign controls exposed.
  // Re-place while repopulating: the swap changes the menu's height (a one-line
  // note ⇄ a full project list), and a `top` computed for the old height can put
  // the new content below the fold.
  const openContext = readThreadListContextMenu(state.threadListStore);
  if (openContext.threadId && threadContextMenu && !threadContextMenu.hidden) {
    refreshThreadContextMenuContent(openContext, openContext.threadId);
  }
  // Fail closed: a projects transition (remote rename/delete, add, or a refresh/error)
  // can invalidate the right-clicked project, so drop any open project menu rather than
  // let Rename/Delete act on a now-stale target and clobber a concurrent change.
  closeProjectContextMenu();
});
let clientLogRootHandle = null;
let clientLogRootElement = null;
let forkSessionRoot = null;

// Reviewer-tab actions. Bound late through `state.controller` (assigned after
// the controller is built) so these can be wired into the rail + sheet mounts
// that run at module load; they only ever fire on user interaction.
const reviewerActions = {
  onRequestReview: (values) => state.controller?.requestReview(values),
  onStartWorkflow: (values) => state.controller?.startWorkflow(values),
  onResolveReview: (reviewJobId) => state.controller?.resolveReview(reviewJobId),
  onResolveWorkflow: (workflowRunId) => state.controller?.resolveWorkflow(workflowRunId),
  onDeleteReview: (reviewId) => state.controller?.deleteReview(reviewId),
  fetchReviewerTranscript: (threadId) =>
    Promise.resolve(state.controller?.fetchTranscriptPage(threadId, {})).then(
      (page) => reviewerPreviewEntriesFromPage(state.session, page)
    ),
};

const workspaceDiffSheet = createWorkspaceDiffSheet({
  store: workspaceDiffStore,
  mount: workspaceDiffMount,
  modal: workspaceDiffModal,
  closeButton: closeWorkspaceDiffModalButton,
  titleMount: workspaceDiffTitleMount,
  reviewer: reviewerActions,
  panelId: "review-panel-sheet",
});
mountChangesPanel({
  store: workspaceDiffStore,
  mount: workspaceChangesMount,
  reviewer: reviewerActions,
  panelId: "review-panel-rail",
});
setupHeaderBandSync({
  chatHeader: document.querySelector(".chat-shell > .chat-header"),
});
mountChip({
  store: workspaceDiffStore,
  mount: workspaceDiffChipMount,
  onTap: () => {
    // Mirror the Reviewer chip below: force the Changes tab rather than opening
    // on whatever tab was last persisted, so tapping the diff chip always shows
    // the diff (not the Reviewer panel under a now-"Reviewer" title).
    workspaceDiffStore.setActiveTab("changes");
    workspaceDiffSheet?.open();
  },
});
mountReviewerChip({
  store: workspaceDiffStore,
  mount: reviewerChipMount,
  onTap: () => {
    // Land the user straight on the Reviewer tab rather than whatever was last open.
    workspaceDiffStore.setActiveTab("reviewer");
    workspaceDiffSheet?.open();
  },
});
void workspaceDiffStore.refresh();

// The resolved working tree arrives asynchronously and decides which reviewer threads
// are reusable at all, so a snapshot render that happened before it landed would leave
// the reuse picker offering cross-tree reviewers the relay refuses. Repaint once the
// answer (or a later, different one) is in. Guarded on the cwd so the setReview →
// notify → render loop closes: a repaint that changes nothing re-enters here and stops.
let renderedWorkspaceCwd = null;
workspaceDiffStore.subscribe((workspaceState) => {
  const cwd = workspaceState.workspace?.cwd || null;
  if (cwd === renderedWorkspaceCwd) {
    return;
  }
  renderedWorkspaceCwd = cwd;
  if (state.session) {
    renderSession(state.session);
  }
});

const leftPanelControl = createPanelControl({
  cssVarName: "--sidebar-width",
  widthStorageKey: "agent-relay:local-sidebar-width",
  openWidthStorageKey: "agent-relay:local-sidebar-open-width",
  minOpenWidth: 220,
  maxOpenWidth: 520,
  defaultOpenWidth: 300,
  side: "left",
});
leftPanelControl.attachResizeHandle(sidebarResizeHandle);
leftPanelControl.attachToggleButton(toggleLeftPanelButton);
leftPanelControl.attachToggleButton(sidebarTopToggleButton);
leftPanelControl.subscribe(({ isOpen }) => {
  document.body.classList.toggle("sidebar-collapsed", !isOpen);
  // Tasks render this control inside React (Orchestrator header). Keep its
  // pressed state in sync the same way attachToggleButton does for the static
  // chat-header / sidebar buttons.
  const tasksToggle = document.getElementById("tasks-sidebar-toggle");
  if (tasksToggle) {
    tasksToggle.setAttribute("aria-pressed", isOpen ? "true" : "false");
    tasksToggle.classList.toggle("is-active", isOpen);
    tasksToggle.setAttribute(
      "aria-label",
      isOpen ? "Hide navigation panel" : "Show navigation panel"
    );
    tasksToggle.title = isOpen
      ? "Hide navigation panel (\u2318B)"
      : "Show navigation panel (\u2318B)";
  }
});
// Click is delegated: the button is mounted/unmounted with the Tasks view, so
// attachToggleButton at module load would miss it.
document.addEventListener("click", (event) => {
  if (event.target.closest?.("#tasks-sidebar-toggle")) {
    leftPanelControl.toggle();
  }
});
newSessionComposeButton?.addEventListener("click", () => {
  openStartSessionDialog();
});

const rightPanelControl = createPanelControl({
  cssVarName: "--right-rail-width",
  widthStorageKey: "agent-relay:local-rail-width",
  openWidthStorageKey: "agent-relay:local-rail-open-width",
  minOpenWidth: 260,
  maxOpenWidth: 560,
  defaultOpenWidth: 320,
  side: "right",
});
rightPanelControl.attachResizeHandle(rightRailResizeHandle);
rightPanelControl.attachToggleButton(toggleRightPanelButton);
rightPanelControl.attachToggleButton(railTopToggleButton);
rightPanelControl.subscribe(({ isOpen }) => {
  document.body.classList.toggle("rail-collapsed", !isOpen);
});
document.addEventListener("keydown", (event) => {
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
});

let lastTurnDiffItemId = null;
let lastWorkspaceKey = null;
window.addEventListener("agent-relay:session-updated", () => {
  refreshWorkspaceDiffIfChanged();
  // Fetch the dedicated Projects payload when the snapshot's revision changes (a
  // no-op otherwise; unconditional on the first observation).
  projectsStore.syncToRevision(state.session?.projects_revision || 0);
  refreshThreadsIfRenamedElsewhere();
  void devicesCache.sync(
    state.session?.devices_revision,
    () => getDevices(apiFetch),
    () => {
      if (state.session) renderer.renderSession(state.session);
    }
  );
});
// Session titles do NOT ride the snapshot — they live on the separately-fetched thread
// list, which is otherwise only polled every 12s. `threads_revision` bumps when someone
// renames a session (here, on the phone, or in another window), and is the only signal
// that the list we are holding has gone stale. Without this, a rename made on the phone
// would take up to 12 seconds to appear on the desktop tab strip.
//
// `null` means "not observed yet": the first snapshot only SEEDS the baseline, because
// boot has already fetched the list and a refetch there would be pure duplication.
let lastThreadsRevision = null;
function refreshThreadsIfRenamedElsewhere() {
  const revision = state.session?.threads_revision || 0;
  if (lastThreadsRevision === revision) {
    return;
  }
  const seeding = lastThreadsRevision === null;
  lastThreadsRevision = revision;
  if (seeding) {
    return;
  }
  // `fresh`: a deduped response could predate the rename that triggered this, and the
  // revision is already consumed, so a stale title would stick until the next poll.
  void loadThreads("session renamed", { fresh: true });
  // Search results are a separate snapshot, so refreshing only the authoritative list
  // would leave the rows actually ON SCREEN showing the old title — the rename would
  // look like it did nothing. Only on this known-mutation signal, not on the 12s poll:
  // a search must not turn into a second polling loop.
  const activeQuery = state.threadSearch?.query;
  if (activeQuery) {
    void searchThreads(activeQuery);
  }
}

function refreshWorkspaceDiffIfChanged() {
  const session = state.session;
  if (!session) return;
  // Viewed session + birth cwd + remembered tree: observation does not move
  // current_cwd, so an open panel would otherwise keep showing the previous tree.
  const viewThreadId = state.viewThreadId || session.active_thread_id || null;
  const workspaceKey = localViewedWorkspaceKey({
    session,
    viewThreadId,
    viewOnlyThread: state.viewOnlyThread,
  });
  const decision = decideWorkspaceRefresh({
    session,
    workspaceKey,
    lastWorkspaceKey,
    lastTurnDiffId: lastTurnDiffItemId,
  });
  lastWorkspaceKey = decision.workspaceKey;
  lastTurnDiffItemId = decision.turnDiffId;
  if (decision.refresh) {
    void workspaceDiffStore.refresh();
  }
}

configureSecurityRenderers({
  escapeHtml,
  formatTimestamp,
  shortId,
  workspaceBasename,
});

let controller;

fetchBuildInfo("relay").then((info) => {
  const el = document.querySelector("#build-info-local");
  if (el) {
    el.textContent = info.label;
    el.title = info.title;
  }
});

// --- progress verb cycler --------------------------------------------------
//
// While `session.current_phase` is set we rotate through a small pool of
// gerund verbs every 2.5s so the inline working indicator above the composer
// keeps moving and proves the UI is live. The timer is fully driven by phase
// transitions reported in session snapshots — when phase clears we tear it
// down.

const verbCycler = createVerbCycler();
let currentProgressVerb = null;
let verbTimer = null;

function syncVerbTimer(session) {
  const phase = session?.current_phase ?? null;
  if (phase) {
    if (!verbTimer) {
      currentProgressVerb = verbCycler.next();
      verbTimer = setInterval(() => {
        currentProgressVerb = verbCycler.next();
        refreshAgentWorkingIndicator();
      }, VERB_CYCLE_MS);
    }
  } else if (verbTimer) {
    clearInterval(verbTimer);
    verbTimer = null;
    currentProgressVerb = null;
    verbCycler.reset();
  }
  refreshAgentWorkingIndicator();
}

function refreshAgentWorkingIndicator() {
  const session = state.session;
  if (!agentWorkingIndicator) return;
  const approval = session?.pending_approvals?.[0] || null;
  const phase = session?.current_phase ?? null;
  // The snapshot's phase describes only the active thread. Show the working
  // indicator solely when the thread being viewed IS that active thread —
  // otherwise the console home (or another thread's page) would light up for
  // work happening elsewhere. Per-thread activity is surfaced by the sidebar
  // badge (session.thread_activity) instead.
  const viewingActive = Boolean(
    session?.active_thread_id && state.viewThreadId === session.active_thread_id
  );
  const offline = !session || approval || !session.provider_connected || !viewingActive || !phase;
  if (offline) {
    agentWorkingIndicator.hidden = true;
    return;
  }
  const stalled = isProgressStalled(session);
  const label = stalled
    ? "Stalled?"
    : progressPhaseLabel(phase, session.current_tool, currentProgressVerb);
  if (!label) {
    agentWorkingIndicator.hidden = true;
    return;
  }
  agentWorkingIndicator.hidden = false;
  const tone = stalled ? "alert" : "ready";
  agentWorkingIndicator.className = `agent-working-indicator agent-working-indicator-${tone}`;
  if (agentWorkingIndicatorLabel) {
    agentWorkingIndicatorLabel.textContent = label;
  }
}

const renderer = createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
  renderPairingApprovalModal,
  resolveActiveThread,
  setSelectedCwd,
  resumeSession(...args) {
    return controller.resumeSession(...args);
  },
  openThreadContextMenu,
  closeThreadContextMenu,
  onSelectThread: selectThreadFromClick,
  onRenameProject: renameProjectFromHeader,
  onDeleteProject: deleteProjectFromHeader,
  openProjectContextMenu,
  scheduleControllerHeartbeat(...args) {
    return controller.scheduleControllerHeartbeat(...args);
  },
  scheduleControllerLeaseRefresh(...args) {
    return controller.scheduleControllerLeaseRefresh(...args);
  },
  cancelControllerHeartbeat() {
    return controller?.cancelControllerHeartbeat();
  },
  cancelControllerLeaseRefresh() {
    return controller?.cancelControllerLeaseRefresh();
  },
  // See render-session.js's own doc on this option: renderSession calls it
  // directly so its internal closures (not just this file's `renderer.renderSession`
  // wrap below) clear a pending transcript flush too.
  cancelPendingTranscriptFlush() {
    return controller?.cancelPendingTranscriptFlush?.();
  },
  logLine,
  renderClientLogLines,
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
  sessionControllerState,
  isCurrentDeviceActiveController,
  isViewingConversation,
  approvedDeviceCount,
  securityModeLabel,
  contentVisibilityLabel,
  brokerStatusLabel,
  pairedDeviceCountLabel,
  ensureConversationTranscript(session) {
    return controller?.ensureConversationTranscript(session);
  },
  // LocalTranscriptPanel owns attaching/detaching the IntersectionObserver
  // now; this just supplies what to do when it fires. A pinned read-only view
  // paginates through its own pin (the hydration pipeline is keyed to the
  // live thread); everything else takes the normal active-thread path, which
  // no-ops while a pin is showing.
  loadOlderTranscript() {
    const pin = state.viewOnlyThread;
    if (pin && state.viewThreadId === pin.threadId) {
      return loadOlderViewOnlyTranscript();
    }
    return controller?.maybeLoadOlderTranscript();
  },
  syncComposerModel(session) {
    syncComposerModelForRenderedSession(session);
  },
  updateSessionSettings(payload) {
    return controller?.updateSessionSettings(payload);
  },
  requestReview(values) {
    return controller?.requestReview(values);
  },
  startWorkflow(values) {
    return controller?.startWorkflow(values);
  },
  setReviewSlice(slice) {
    workspaceDiffStore.setReview(slice);
  },
  // One answer to "which working tree is this session's work in", shared by the Changes
  // panel, the Reviewer panel and the review dialog — and stored on the relay, so it
  // survives a reload and is the same tree the phone sees.
  getThreadWorkspace: () => workspaceDiffStore.getState().workspace,
  pinThreadWorkspace: (path) => workspaceDiffStore.pinWorkspace(path),
  // Goes through the store rather than calling `trustWorkspace` directly, so the review
  // dialog's grant refreshes the same panel state the Changes tab reads — one grant, one
  // refetch, one answer about the tree.
  trustThreadWorkspace: (path) => void workspaceDiffStore.trustWorkspace(path),
  reviewsCache,
  workflowsCache,
  // Dedicated, uncompacted reviewer data. The snapshot carries only its revision
  // plus the minimal non-terminal gating projection.
  fetchReviews() {
    // Local is the operator surface (full access): the endpoint resolves reviews with no
    // device scope, so don't append a (dead) ?device_id query.
    return getReviews(apiFetch);
  },
  fetchWorkflows() {
    return getWorkflows(apiFetch);
  },
  teamsCache,
  fetchTeams() {
    return getTeams(apiFetch);
  },
  fetchUsage(params) {
    return getUsage(apiFetch, params);
  },
  fetchTeamCatalog() {
    return getTeamCatalog(apiFetch);
  },
  ensureOrchestrator() {
    return ensureOrchestrator(apiFetch, state.deviceId);
  },
  resetOrchestrator() {
    return resetOrchestrator(apiFetch, state.deviceId);
  },
  fetchTeamDiff(teamRunId, base) {
    return getTeamDiff(apiFetch, teamRunId, base, state.deviceId);
  },
  fetchTaskLineComments(teamRunId) {
    return listLineComments(apiFetch, teamRunCommentScope(teamRunId), state.deviceId);
  },
  createTaskLineComment(teamRunId, anchor, body) {
    return createLineComment(apiFetch, {
      scope: teamRunCommentScope(teamRunId),
      body,
      anchor,
      device_id: state.deviceId,
    });
  },
  resolveTaskLineComment(commentId, action) {
    return resolveLineComment(apiFetch, commentId, action, state.deviceId);
  },
  handBackTaskLineComment(commentId) {
    return handBackLineComment(apiFetch, commentId, state.deviceId);
  },
  fetchTaskReviewTicks(teamRunId) {
    return listReviewTicks(apiFetch, teamRunCommentScope(teamRunId), state.deviceId);
  },
  tickTaskReviewFile(teamRunId, path, side, baseCommit) {
    return tickReviewFile(apiFetch, {
      scope: teamRunCommentScope(teamRunId),
      path,
      side,
      base_commit: baseCommit || null,
      device_id: state.deviceId,
    });
  },
  proposeOrchestratorTask(body) {
    return proposeOrchestratorTask(apiFetch, {
      ...body,
      device_id: state.deviceId,
    });
  },
  confirmOrchestratorProposal(proposalId) {
    return confirmOrchestratorProposal(apiFetch, proposalId, state.deviceId);
  },
  reviseOrchestratorProposal(proposalId, updates) {
    return reviseOrchestratorProposal(apiFetch, proposalId, updates, state.deviceId);
  },
  dismissOrchestratorProposal(proposalId) {
    return dismissOrchestratorProposal(apiFetch, proposalId, state.deviceId);
  },
  sendMessage(text, threadId) {
    return controller?.sendMessage(text, threadId);
  },
  fetchTranscriptPage(threadId, opts) {
    return controller?.fetchTranscriptPage(threadId, opts);
  },
  setUsageBudget(patch) {
    return setUsageBudget(apiFetch, patch);
  },
  getViewContext: () => sessionViewStore.getState().location.context,
  // The sidebar nav's two destinations. Both go through `showOverview` so both are real
  // history entries — the back button has to be able to leave the Task screen the same
  // way it leaves a project. Declared as functions further down the file, so these
  // wrappers keep the hoisting honest.
  onOpenSessionsScreen: () => openSessionsScreen(),
  onOpenTasksScreen: () => openTaskScreen(),
  onOpenUsageScreen: () => openUsageScreen(),
  onOpenTeamsScreen: (teamId) => openTeamsScreen(teamId),
  // The narrowing controls. Each wraps a transport the shared components must not see:
  // the search field's debounce + HTTP query, and the bell's list re-render.
  onSetSearchOpen: (open) => setSearchOpen(open),
  onSearchInput: (value) => onSearchInput(value),
  onToggleActivityFilter: (next) => setActivityFilter(next),
  onOpenTask(teamRunId) {
    // Clear the action error on the way out. It belongs to the task that produced
    // it; carrying it across would render "this task is blocked" attributed to a
    // task that is not.
    state.teamActionError = null;
    // Opening a FINISHED task is how its badge is discharged — there is no action
    // left to take on one, so reading it is the only thing that can. A task still
    // asking for something is unaffected; `teamNeedsYouNow` refuses to let a
    // glance clear a request.
    const opened = (teamsCache.current().teams || []).find(
      (run) => run?.team_run_id === teamRunId
    );
    if (opened) {
      markTaskSeen(opened.team_run_id, opened.updated_at);
    }
    void sessionViewController.showOverview({ kind: "tasks", teamRunId });
  },
  onBackToTasks() {
    state.teamActionError = null;
    void sessionViewController.showOverview({ kind: "tasks", teamRunId: null });
  },
  // One run's ticket page (17b), entered from a board card.
  //
  // Carries the SAME side effects as `onOpenTask`, deliberately: this is the
  // other way of opening a task, so a badge must discharge and a stale action
  // error must clear here too. Diverging made a finished task keep its unread
  // mark when opened from the board, and let task A's error surface on task B.
  onOpenTicketScreen(teamRunId) {
    if (!teamRunId) {
      return;
    }
    state.teamActionError = null;
    const opened = (teamsCache.current().teams || []).find(
      (run) => run?.team_run_id === teamRunId
    );
    if (opened) {
      markTaskSeen(opened.team_run_id, opened.updated_at);
    }
    void openTicketDestination(sessionViewController, teamRunId);
  },
  // The full-screen merge review (15a). Routed through the same controller as
  // every other destination so Back leaves it the way it leaves a project, and
  // a reload lands on the run rather than on the task list.
  onOpenReviewScreen(teamRunId) {
    if (!teamRunId) {
      return;
    }
    void openReviewDestination(sessionViewController, teamRunId);
  },
  onTeamAction: runTeamAction,
  onDeleteTask: deleteTask,
  onStartTask: openStartTaskDialog,
  // Hoisted module-level declarations below. `viewThread` is shared rather than a
  // method here because several call sites (sidebar rows, tab strip) need the one
  // implementation — they used to each inline a copy of its body.
  viewThread: viewThreadById,
  renderProjectSwitcher,
  renderSessionTabs,
  // Projects master-detail: select a project and show its card overview in the main
  // area. Clears any open session so the overview (not a transcript) is what renders;
  // renderSession derives data-view="project-overview" from the selected project.
  enterProjectOverview(projectId) {
    void sessionViewController.showOverview({
      kind: "project",
      projectId,
    });
  },
  // "New agent": open the start-session dialog and remember the project, so the
  // session created by the next Start is auto-assigned to it. Hoisted to module
  // scope (below) because the chat header's own New agent button needs the same
  // flow, and it is wired imperatively rather than through the renderer.
  startProjectAgent,
});

// Wrap renderer.renderSession so every full render also reconciles the
// liveness verb timer. Patching the object (rather than only the local
// destructured binding) ensures controller callbacks below also flow
// through the wrapper.
const _baseRenderSession = renderer.renderSession;
renderer.renderSession = function wrappedRenderSession(session) {
  // Late-bound: `controller` is assigned after this wrap runs (see
  // createSessionController below), but nothing calls renderSession before
  // boot finishes assigning it. Every render through this ONE function —
  // whether reached via ctx.renderSession or one of the many direct
  // renderer.renderSession(...) calls elsewhere in this file — must satisfy
  // the flush scheduler's pending slot, or a coalesced delta timer left over
  // from before this render fires later and paints a second time.
  //
  // Settles any pending window projection into state.session too — a bare
  // cancel would destroy the only scheduled catch-up while leaving the stale
  // pre-projection array in place, which is what this render would then
  // paint. See resolveDirectRenderSession's own doc.
  session = resolveDirectRenderSession(session, {
    state,
    cancelPendingTranscriptFlush: () => controller?.cancelPendingTranscriptFlush?.(),
  });
  if (devicesCache.hasData()) {
    session = { ...session, ...devicesCache.current() };
  }
  // lifecycle.js's applySessionSnapshot now advances state.session
  // synchronously before every render it triggers (queue() defers only the
  // paint, never the write — see .sealwire/PLAN.md), so state.session can no
  // longer be trusted to still hold "the live session a moment ago" by the
  // time this wrap runs. It stashes that value here itself when the active
  // thread just switched; fall back to state.session for every other render
  // path (deltas/patches), which do not pre-write it and so still satisfy
  // the old assumption. Consumed once — clear it so a later, unrelated
  // render can't read a stale switch that already happened.
  const previousLiveSession = state.previousLiveSessionForPin || state.session;
  state.previousLiveSessionForPin = null;
  const viewedThreadWasLive = Boolean(
    state.viewThreadId
    && previousLiveSession?.active_thread_id === state.viewThreadId
    && session?.active_thread_id !== state.viewThreadId
    && !state.viewOnlyThread
  );
  if (viewedThreadWasLive) {
    const summary =
      findVisible(state.viewThreadId);
    state.viewOnlyThread = buildViewOnlyPin({
      relayGeneration: previousLiveSession?.transcript_generation || "",
      threadId: state.viewThreadId,
      priorEntries: previousLiveSession.transcript || [],
      cwd: summary?.cwd ?? previousLiveSession.current_cwd ?? null,
      threadWorkspaceCwd: previousLiveSession.thread_workspace_cwd ?? null,
      provider: summary?.provider ?? previousLiveSession.provider ?? null,
      status: previousLiveSession.current_status || "idle",
      lastRefreshAt: Date.now(),
      lastRefreshServerTime: previousLiveSession.server_time ?? null,
      wasWorking: Boolean(previousLiveSession.active_turn_id),
    });
  }
  // Make the real session current BEFORE reconciling the view-only pin.
  // maybeRefreshViewOnly() (and the loadViewOnlyTranscript it may trigger) read
  // state.session; without this, the very first render after a deep link to a
  // non-active thread runs while state.session is still null, the self-heal load
  // bails, and the one-attempt guard suppresses every retry. _baseRenderSession
  // sets it again (idempotent).
  state.session = session;
  maybeRefreshViewOnly(session);
  _baseRenderSession(session);
  syncVerbTimer(session);
  if (viewedThreadWasLive) {
    void loadViewOnlyTranscript(state.viewThreadId);
  }
};

// A stable signature of the review running on `threadId`, so the read-only view
// re-fetches when the review advances (a new round, a posted-back result) and is
// released when it ends.
function viewOnlyReviewSignature(session, threadId) {
  if (!reviewsCache.hasData()) {
    return null;
  }
  const job = (reviewsCache.current()?.review_jobs || []).find(
    (entry) =>
      entry.parent_thread_id === threadId
      && !isTerminalReviewStatus(entry.status)
  );
  return job ? `${job.status}:${job.round ?? 0}:${job.updated_at ?? 0}` : "none";
}

// Fetch a non-active thread's transcript tail into state.viewOnlyThread so
// render-session.js can project it read-only (with scroll-up pagination via the
// pin's olderCursor). Works for ANY non-active thread — the review-locked parent
// case is just one flavor (pin.review). For the active thread it clears the
// projection. A generation guard drops stale responses when the user navigates
// again mid-fetch.
let viewOnlyRefreshOps;
async function loadViewOnlyTranscript(threadId, options) {
  return viewOnlyRefreshOps.loadViewOnlyTranscript(threadId, options);
}

// Scroll-up pagination for the read-only pin: fetch the page before the pin's
// olderCursor (cache-aware via the transcript page cache) and prepend it.
// Deliberately separate from the active-thread hydration pipeline — that store
// is keyed to the live thread and must not be re-keyed by a view-only visit.
async function loadOlderViewOnlyTranscript() {
  return viewOnlyRefreshOps.loadOlderViewOnlyTranscript();
}

// Called on every render: keep the pin honest against the latest REAL session.
// Pins stay pinned while viewed and never auto-resume. Review pins refresh when
// their review advances or ends. Also self-heals: deep links / back-button land on a
// non-active thread without going through viewThread(), and a rapid-switch race can
// drop the pin — so re-arm the load here whenever the viewed thread lacks a good pin
// (viewOnlySelfHealThreadId), with a backoff on failures so a failing fetch can't loop.
// Tell the relay which threads this surface has on screen, so it streams their deltas
// here. Deduped internally, so calling it on every render costs one request per actual
// change of the viewed thread.
const syncWatchedThreads = createWatchedThreadsSync({
  apiFetch,
  deviceId: () => state.deviceId,
  // Per TAB, not per device: the device id lives in localStorage and is shared by every
  // tab, so a per-device watch set would let whichever tab declared last silence the
  // others. See loadOrCreateSurfaceId for why this id is per page load and in memory
  // rather than in sessionStorage, which a duplicated tab would copy.
  surfaceId: () => state.surfaceId,
  surfaceGeneration: () => state.surfaceGeneration ?? null,
  onError: (error) => logLine(`Failed to declare watched threads: ${error.message}`),
});
state.resetWatchedThreadsDeclaration = () => syncWatchedThreads.reset();

/**
 * The Orchestrator thread, while the Tasks screen is drawing it.
 *
 * It is rendered BESIDE the conversation, not instead of it, so it never shows
 * up in `viewThreadId` and the active-thread fallback does not reach it either
 * (`viewThreadId` still names the session you last opened). Undeclared, the
 * relay streams it nothing and the pane updates only when the next full
 * snapshot happens to carry it.
 */
function orchestratorWatchIds() {
  if (sessionViewStore.getState().location.context?.kind !== "tasks") {
    return [];
  }
  const threadId = state.orchestratorThreadId || state.session?.orchestrator_thread_id || null;
  return threadId ? [threadId] : [];
}

viewOnlyRefreshOps = createViewOnlyRefreshOps({
  getState: () => state,
  fetchTranscriptPage: (threadId, options = {}) =>
    controller?.fetchTranscriptPage(threadId, options),
  renderSession: (session) => renderer.renderSession(session),
  logLine,
  findVisible,
  reviewSignature: viewOnlyReviewSignature,
  syncWatchedThreads,
  getOrchestratorWatchIds: orchestratorWatchIds,
  isReviewInProgressForThread,
  isWorkflowInProgressForThread,
});

function maybeRefreshViewOnly(session) {
  return viewOnlyRefreshOps.maybeRefreshViewOnly(session);
}

controller = createSessionController({
  state,
  apiFetch,
  queryClient: localQueryClient,
  shortId,
  logLine,
  seedDefaults,
  setSelectedCwd,
  setThreadRoute,
  canCurrentDeviceWrite,
  renderSession: renderer.renderSession,
  renderOverviewState: renderer.renderOverviewState,
  renderSessionUnavailable: renderer.renderSessionUnavailable,
  renderThreadListMessage: renderer.renderThreadListMessage,
  renderThreads: renderer.renderThreads,
  renderAuthRequiredState: renderer.renderAuthRequiredState,
  runViewTransition: renderer.runViewTransition,
  handleUnauthorized,
});
// Stash on state so React render paths (e.g. transcript-react.js's
// AskUserEntry onClick) can call back into the controller without an
// additional prop-drilling layer through every render entrypoint.
state.controller = controller;

const {
  renderAuthRequiredState,
  renderSession,
  renderSessionMeta,
  // The search + bell toggles and the search field. Repainted on its own rather than
  // through a whole `renderSession` pass, because a keystroke has to reach a CONTROLLED
  // input immediately — the field would otherwise appear to swallow characters until the
  // search debounce fired and something else triggered a render.
  renderSidebarChrome,
  // Also called once at module scope, before boot's awaits — see paintInitialSidebarChrome.
  renderSidebarNav,
  renderThreads,
  runViewTransition,
  syncThreadHistoryScroll,
} = renderer;

// One post-commit projection path for every navigation source. The controller has
// already committed canonical state, persistence and history before listeners run,
// so renderers never observe a route that belongs to a different tab workspace.
sessionViewController.subscribe((change) => {
  renderProjectSwitcher();
  renderSessionTabs();
  renderStartSessionSplit();
  renderThreads();
  if (state.session) {
    renderSession(state.session);
  }
  if (change.locationChanged) {
    void loadViewOnlyTranscript(change.next.location.threadId);
  }
});

const {
  cancelControllerHeartbeat,
  cancelControllerLeaseRefresh,
  cancelSessionPoll,
  cancelStreamReconnect,
  cancelThreadsPoll,
  connectSessionStream,
  copyPairingLink,
  decidePairingRequest,
  forkSession,
  loadSession,
  loadThreads,
  searchThreads,
  resumeSession,
  revokeOtherDevices,
  revokePairedDevice,
  saveAllowedRoots,
  scheduleThreadsPoll,
  sendMessage,
  stopActiveTurn,
  startPairing,
  startSession,
  submitDecision,
  takeOverControl,
  repairWorkspace,
  toggleTranscriptEntry,
  toggleTranscriptExpandKey,
  applyFileChange,
} = controller;

threadsList?.addEventListener("scroll", () => {
  state.threadHistoryScrollTop = threadsList.scrollTop;
});

sessionHistoryDrawer?.addEventListener("toggle", () => {
  state.threadListStore.getState().setDrawerOpen(Boolean(sessionHistoryDrawer.open));
});

installThreadListWheelProxy({
  root: sessionHistoryDrawer,
  scrollElement: threadsList,
  shouldProxyWheel() {
    return Boolean(sessionHistoryDrawer?.open);
  },
});

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuthSession();
});

startPairingButton.addEventListener("click", () => {
  void startPairing();
});

const SETTINGS_TABS = ["providers", "devices", "log", "appearance"];

// Toggle which Settings tab is active (button `is-active` + panel `hidden`).
// Panels are all mounted up front so their ids resolve at dom.js import time.
function setSettingsTab(tab = "providers") {
  const active = SETTINGS_TABS.includes(tab) ? tab : "providers";
  for (const key of SETTINGS_TABS) {
    const btn = document.getElementById(`settings-tab-${key}`);
    btn?.classList.toggle("is-active", key === active);
    btn?.setAttribute("aria-selected", key === active ? "true" : "false");
    const panel = document.querySelector(`[data-settings-panel="${key}"]`);
    if (panel) {
      panel.hidden = key !== active;
    }
  }
}

function openSettingsModal(tab = "providers") {
  // Devices sub-panels are also refreshed on every snapshot, but re-render on open
  // so the modal reflects the latest state immediately. Providers + audit (Log tab)
  // are kept fresh by the render loop (renderProviderStatus / renderAuditTimeline).
  state.localUiStore.getState().setAllowedRootsDraftDirty(false);
  renderAllowedRoots(state.session?.allowed_roots || [], {
    draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
  });
  renderPairingPanel(state.currentPairing);
  renderDeviceRecords(state.session?.device_records || []);
  renderPendingPairingRequests(
    state.session?.pending_pairing_requests || [],
    state.pendingPairingDecisions || {}
  );
  setSettingsTab(tab);
  settingsModal?.showModal();
}

// Three gears, one modal, each owning a state the others cannot reach:
//   #sidebar-settings      — sidebar footer; the desktop entry while expanded
//   #icon-rail-settings    — icon rail; only rendered while the sidebar is collapsed
//   #open-settings-header  — chat header; ≤960px, where neither of the above shows
// Every one of them is optional (`?.`) because no single view mounts all three.
document
  .getElementById("sidebar-settings")
  ?.addEventListener("click", () => openSettingsModal());
iconRailSettingsButton?.addEventListener("click", () => openSettingsModal());
document
  .getElementById("open-settings-header")
  ?.addEventListener("click", () => openSettingsModal());
for (const key of SETTINGS_TABS) {
  document
    .getElementById(`settings-tab-${key}`)
    ?.addEventListener("click", () => setSettingsTab(key));
}

// Keeps the sidebar's pinned selection in step with the routed context. There is no
// grouping mode to sync any more — the context IS the selection.
function syncThreadListViewFromContext(context) {
  const store = state.threadListStore.getState();
  const projectId = context?.kind === "project" ? context.projectId : null;
  if (readActiveProjectId(state.threadListStore) !== projectId) {
    store.setActiveProject(projectId);
  }
  // Unconditional once a session snapshot exists: the switcher offers the project
  // list from every context, so gating the fetch on Projects mode would leave it
  // empty exactly where it is the only way IN to a project.
  syncProjectsForSession(projectsStore, state.session);
}

// Drop a selection whose project is gone (deleted here or by a remote peer). It used
// to ALSO land you on the first project when Projects mode was entered without one;
// that half went with the mode. "No project selected" is now the default workspace,
// and auto-jumping into an arbitrary project would be the sidebar choosing a container
// on your behalf.
async function dropStaleProjectSelection() {
  // Same hazard as the delete handler, same fix: a project click that has not finished
  // persisting still reports as the previous context, so sweeping without draining the
  // queue first would clear a selection the user has just made.
  await sessionViewController.whenIdle();
  const context = sessionViewStore.getState().location.context;
  if (context.kind !== "project") {
    return;
  }
  if ((state.projects || []).some((project) => project.id === context.projectId)) {
    return;
  }
  void sessionViewController.showOverview({ kind: "sessions" }, { replace: true });
}

// ---------------------------------------------------------------------------
// Session title search
// ---------------------------------------------------------------------------

// No handles here any more. The toggle, the field, its input and its clear button were
// four `getElementById` calls, and the field's own OPEN/DRAFT state was kept in the DOM —
// `open` read back off `sidebarSearch.hidden`, the draft off `sidebarSearchInput.value`.
// Using the DOM as the state is precisely why local could not conditionally render the
// field: the nodes had to exist for the state to be readable.
//
// Both now live in `threadListStore` (see shared/thread-list-store.js `searchUi`), which
// remote reads too, and the field itself is `SidebarSearchField`. What stays here is the
// part that is genuinely local: the debounce and the HTTP query it triggers.

// Each keystroke is a relay round trip, so coalesce a burst of typing into one. Short
// enough to feel live, long enough that a word costs one request rather than five.
const SEARCH_DEBOUNCE_MS = 180;
let searchDebounceTimer = null;

function runSearch(query) {
  window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
  void searchThreads(query);
}

function queueSearch(query) {
  window.clearTimeout(searchDebounceTimer);
  // Clearing is not a query — apply it immediately so the list snaps back rather than
  // sitting on stale matches for another debounce window.
  if (!query.trim()) {
    runSearch("");
    return;
  }
  searchDebounceTimer = window.setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

// Opening and closing the field. The store enforces "closing clears the draft" — the rule
// both shells used to state in prose and could each have lost — so all that is left here
// is the half that is local's: telling the relay the query is gone.
function setSearchOpen(open) {
  state.threadListStore.getState().setSearchOpen(open);
  if (!open) {
    runSearch("");
  }
  renderSidebarChrome();
}

// A keystroke has to repaint immediately: the input is CONTROLLED by the draft, so a
// re-render that waited for the search results to land would make the field appear to
// swallow every character until the debounce fired.
function onSearchInput(value) {
  state.threadListStore.getState().setSearchDraft(value);
  renderSidebarChrome();
  queueSearch(value);
}

// Do not bind ⌘F / Ctrl+F here. Session search is click-only (sidebar magnifying
// glass); Find must stay with the browser so the user can search the transcript.

// ---------------------------------------------------------------------------
// Activity filter (the bell)
// ---------------------------------------------------------------------------

// No handle and no chrome sync. `is-active` and `aria-pressed` used to be written onto
// the button here, from a function whose only job was to keep the DOM in step with the
// store; `SidebarBellToggle` now derives both from the `on` prop in the same render.
//
// Toggling the filter RESETS retention. The retention set exists so a row cannot vanish
// mid-reach; carrying it across a deliberate off/on would instead re-list rows that
// stopped being interesting long ago.
function setActivityFilter(next) {
  state.threadListStore.getState().setThreadFilter(next);
  renderSidebarChrome();
  renderThreads();
}

// Prompt for a Project name (trimmed; null aborts). Native prompt mirrors the
// window.confirm flow the archive/delete affordances already use.
function promptProjectName(current = "") {
  return normalizeProjectName(window.prompt("Project name", current));
}

// Create a Project from the Projects toolbar. Membership/list refresh rides the
// snapshot's projects_revision bump (project_action calls notify()), same as an
// API-driven mutation — no manual store.refresh() needed.
async function createProjectFromToolbar() {
  const name = promptProjectName();
  if (!name) {
    return;
  }
  try {
    const before = state.projects || [];
    const receipt = await createProject(apiFetch, name);
    const projectId = pickNewProjectId(before, receipt?.projects);
    if (projectId) {
      await sessionViewController.showOverview({
        kind: "project",
        projectId,
      });
    }
    logLine(`Created project "${name}".`);
  } catch (error) {
    logLine(`Failed to create project: ${error.message}`);
  }
}

// Selects the new project instead of navigating to it, unlike the toolbar version.
async function createProjectForLaunchDraft(apply, isCurrent) {
  const name = promptProjectName();
  if (!name) {
    return;
  }
  try {
    const projectId = await createProjectAndSelect({
      apply,
      create: (projectName) => createProject(apiFetch, projectName),
      isCurrent,
      name,
      store: projectsStore,
    });
    logLine(
      projectId
        ? `Created project "${name}".`
        : `Created project "${name}", but could not tell which one is new — pick it manually.`
    );
  } catch (error) {
    logLine(`Failed to create project: ${error.message}`);
  }
}

// Grant this relay permission to run git in `cwd`.
//
// Local only, and by construction rather than by a check: no `RemoteActionRequest`
// variant maps to `POST /api/workspace/trust`, so a paired phone can report an
// ungranted folder but has no way to clear it. That is why this lives here, in the
// local app, and is handed to the workspace-diff store instead of being reachable
// from shared panel code.
//
// Throws on refusal: the caller shows it next to the control the user just used. A
// swallowed error here would read as "the button does nothing".
async function trustWorkspace(cwd) {
  if (!cwd) {
    return;
  }
  const response = await apiFetch("/api/workspace/trust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, trusted: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to trust workspace");
  }
  logLine(`Trusted workspace ${cwd}.`);
}

// Rename a Project from its group header (Projects view). Prompt pre-filled with the
// current name; refresh rides the projects_revision snapshot bump like every mutation.
async function renameProjectFromHeader(projectId, currentName) {
  if (!projectId) {
    return;
  }
  const name = promptProjectName(currentName || "");
  if (!name || name === currentName) {
    return;
  }
  try {
    await renameProject(apiFetch, projectId, name);
    logLine(`Renamed project to "${name}".`);
  } catch (error) {
    logLine(`Failed to rename project: ${error.message}`);
  }
}

// Delete a Project from its group header. Its sessions become Unassigned (the sessions
// themselves are not deleted). Confirm first, mirroring the archive/delete flows.
async function deleteProjectFromHeader(projectId, name) {
  if (!projectId) {
    return;
  }
  const confirmed = window.confirm(
    `Delete project "${name}"?\n\nIts sessions become Unassigned — the sessions themselves are not deleted.`
  );
  if (!confirmed) {
    return;
  }
  try {
    await deleteProject(apiFetch, projectId);
    // Decided AFTER the await AND after the controller settles — not from a snapshot
    // taken at confirm time, and not from `getState()` alone.
    //
    // The confirm-time snapshot outlived the request: the switcher stays interactive
    // for the whole round trip, so deleting A and then picking B let the response yank
    // you back out of B. Reading `getState()` late fixes that only for a navigation
    // that has already COMMITTED — the controller assigns state after its IndexedDB
    // transaction resolves, so a click on B that is still persisting reports as "you
    // are in A", and the reconciliation then queues its own navigation behind B's and
    // overwrites it.
    //
    // `whenIdle` drains that queue, and its loop matters: it re-checks until the queue
    // stops growing, so a dispatch that lands while we are waiting is waited for too.
    // A user action arriving AFTER it resolves is dispatched after this reconciliation
    // and wins on its own, which is the right order.
    //
    // The receipt's surviving-project list is deliberately not consulted. It used to
    // navigate to `receipt.projects[0]`, which raced the same clearing mechanism with
    // the opposite answer.
    await sessionViewController.whenIdle();
    const nextContext = selectContextAfterProjectDelete({
      context: sessionViewStore.getState().location.context,
      deletedProjectId: projectId,
    });
    if (nextContext) {
      await sessionViewController.showOverview(nextContext, { replace: true });
    }
    logLine(`Deleted project "${name}".`);
  } catch (error) {
    logLine(`Failed to delete project: ${error.message}`);
  }
}

// Right-click menu for a project row in the sidebar (Projects mode). Positioned +
// toggled imperatively like #thread-context-menu; the target project is held here so
// the Rename/Delete buttons act on whatever row was right-clicked.
let projectContextTarget = null;
function openProjectContextMenu(projectId, name, clientX, clientY) {
  if (!projectContextMenu || !projectId) {
    return;
  }
  // Don't stack the two menus.
  closeThreadContextMenu({ rerender: false });
  projectContextTarget = { id: projectId, name: name || projectId };
  // Unhide first so the menu can be measured, then place it: near the bottom of
  // the sidebar it flips up instead of running off the viewport.
  projectContextMenu.hidden = false;
  positionContextMenuElement(projectContextMenu, clientX, clientY);
}

function closeProjectContextMenu() {
  if (projectContextMenu) {
    projectContextMenu.hidden = true;
  }
  projectContextTarget = null;
}

renameProjectMenuButton?.addEventListener("click", () => {
  const target = projectContextTarget;
  closeProjectContextMenu();
  if (target) {
    void renameProjectFromHeader(target.id, target.name);
  }
});

deleteProjectMenuButton?.addEventListener("click", () => {
  const target = projectContextTarget;
  closeProjectContextMenu();
  if (target) {
    void deleteProjectFromHeader(target.id, target.name);
  }
});

// Run one context-menu Project action for a thread (assign / unassign / new+assign).
// `builtSeq` is the projectsStateSeq captured when the clicked button was built.
async function runThreadProjectAction(threadId, item, builtSeq) {
  closeThreadContextMenu();
  if (!threadId || !item) {
    return;
  }
  // Execution-time freshness guard: refuse to act on a button built from Project state
  // that has since changed or is no longer trustworthy (a newer revision arrived, or a
  // refresh is pending/failed). Otherwise a stale button could overwrite newer
  // membership. The user reopens the menu to act on current state.
  if (
    !projectMenuActionAllowed({
      builtSeq,
      currentSeq: projectsStateSeq,
      projectsLoaded: state.projectsLoaded,
      projectsError: state.projectsError,
      projectsLoading: state.projectsLoading,
    })
  ) {
    logLine("Projects changed — reopen the menu to change membership.");
    return;
  }
  try {
    if (item.kind === "unassign") {
      await unassignThread(apiFetch, threadId);
      logLine(`Removed session ${shortId(threadId)} from its project.`);
      return;
    }
    if (item.kind === "assign") {
      if (item.isCurrent) {
        return; // already there — no-op
      }
      await assignThreadToProject(apiFetch, threadId, item.projectId);
      logLine(`Moved session ${shortId(threadId)} to "${item.label}".`);
      return;
    }
    if (item.kind === "create") {
      const name = promptProjectName();
      if (!name) {
        return;
      }
      const before = state.projects || [];
      const receipt = await createProject(apiFetch, name);
      const projectId = pickNewProjectId(before, receipt?.projects);
      if (!projectId) {
        // Created, but the new id was ambiguous — leave the session unassigned rather
        // than guess. The snapshot refresh still surfaces the new (empty) project.
        logLine(`Created project "${name}" (assign the session from its menu).`);
        return;
      }
      await assignThreadToProject(apiFetch, threadId, projectId);
      logLine(`Created project "${name}" and moved session ${shortId(threadId)} into it.`);
    }
  } catch (error) {
    logLine(`Failed to update project membership: ${error.message}`);
  }
}

// Rebuild the context menu's per-session Project controls for `threadId` from the
// current Projects payload: the trigger row's "current project" value plus the
// submenu's buttons. Called each time the menu opens (openThreadContextMenu) and
// whenever the Projects payload transitions while it is open.
function populateThreadProjectActions(threadId) {
  if (!threadProjectActions) {
    return;
  }
  threadProjectActions.textContent = ""; // drop prior buttons (and their listeners)
  // Fail closed: mirror the sidebar renderer — never present Project membership or
  // mutation controls as authoritative unless we hold a current payload. During a
  // pending/failed/first-load fetch, show a non-interactive note instead of buttons
  // (which would falsely imply "no projects / not a member" or expose stale controls).
  const ready = projectsMenuReady({
    projectsLoaded: state.projectsLoaded,
    projectsError: state.projectsError,
    projectsLoading: state.projectsLoading,
  });
  const currentProjectId = state.threadProjectId?.[threadId] || null;
  // The trigger row answers "which project is this session in?" without opening the
  // submenu. Same fail-closed rule: while the payload is pending/failed we show a
  // status word, never "None" — "None" would assert non-membership we can't vouch for.
  if (threadProjectCurrentLabel) {
    const assignedLabel = ready
      ? currentProjectLabel({ projects: state.projects || [], currentProjectId })
      : null;
    threadProjectCurrentLabel.textContent = ready
      ? assignedLabel || "None"
      : state.projectsError
        ? "Unavailable"
        : "Loading…";
    threadProjectCurrentLabel.classList.toggle("is-assigned", Boolean(assignedLabel));
  }
  if (!ready) {
    const note = document.createElement("p");
    note.className = "context-menu-note";
    note.textContent = state.projectsError ? "Projects unavailable" : "Loading projects…";
    threadProjectActions.appendChild(note);
    return;
  }
  const builtSeq = projectsStateSeq; // freshness token for this build
  const items = buildProjectMenuItems({ projects: state.projects || [], currentProjectId });
  for (const item of items) {
    // "Remove from project" trails the Project list and reads as a different class of
    // action than picking one — rule it off so it isn't mistaken for another Project.
    if (item.kind === "unassign") {
      const separator = document.createElement("div");
      separator.className = "context-menu-separator";
      separator.setAttribute("role", "separator");
      threadProjectActions.appendChild(separator);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-button context-menu-project-button";
    // The flyout is role="menu", so its rows have to be menuitems or the container's role
    // is a lie to assistive tech.
    button.setAttribute("role", "menuitem");
    if (item.isCurrent) {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "true");
    }
    if (item.kind === "create") {
      button.classList.add("context-menu-project-create");
    }
    button.textContent = item.isCurrent ? `✓ ${item.label}` : item.label;
    button.addEventListener("click", () => {
      void runThreadProjectAction(threadId, item, builtSeq);
    });
    threadProjectActions.appendChild(button);
  }
}

// Populate + place the thread menu, then re-place an open Projects flyout. The flyout is
// anchored to the MENU's box, and the menu's own placement depends on the height of the
// content this call just rebuilt (a one-line "Loading projects…" note ⇄ a full list can
// flip it above the click) — so the flyout has to be re-placed after that lands, not
// from inside the populate callback where the menu hasn't moved yet.
function refreshThreadContextMenuContent(anchor, threadId) {
  const placement = updateContextMenuContent(threadContextMenu, anchor, () =>
    populateThreadProjectActions(threadId)
  );
  repositionThreadProjectSubmenu();
  return placement;
}

// Show + position the "Projects ›" submenu against the trigger row. Positioned in JS
// (rather than as a CSS-nested flyout) because the parent menu is itself fixed-
// positioned at the cursor and scrolls its own overflow.
function openThreadProjectSubmenu({ focusFirst = false } = {}) {
  if (
    !threadProjectSubmenu
    || !threadProjectSubmenuTrigger
    || !threadContextMenu
    || threadContextMenu.hidden
  ) {
    return;
  }
  threadProjectSubmenu.hidden = false;
  threadProjectSubmenuTrigger.setAttribute("aria-expanded", "true");
  placeThreadProjectSubmenu();
  if (focusFirst) {
    threadProjectSubmenu.querySelector("button:not(:disabled)")?.focus();
  }
}

// Measure the panel, then hand the geometry to placeProjectSubmenu (pure: flip + clamp
// are unit-tested there). Unhidden but held invisible for the measurement — a hidden
// element measures zero, and revealing it at its previous coordinates first is a visible
// jump on a re-place.
function placeThreadProjectSubmenu() {
  threadProjectSubmenu.style.visibility = "hidden";
  threadProjectSubmenu.hidden = false;
  const { width, height } = threadProjectSubmenu.getBoundingClientRect();
  const { left, top } = placeProjectSubmenu({
    menuRect: threadContextMenu.getBoundingClientRect(),
    triggerRect: threadProjectSubmenuTrigger.getBoundingClientRect(),
    submenuWidth: width,
    submenuHeight: height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  threadProjectSubmenu.style.left = `${Math.round(left)}px`;
  threadProjectSubmenu.style.top = `${Math.round(top)}px`;
  threadProjectSubmenu.style.visibility = "";
}

// Re-place the submenu only if it is currently open (no-op otherwise).
function repositionThreadProjectSubmenu() {
  if (
    !threadProjectSubmenu
    || threadProjectSubmenu.hidden
    || !threadProjectSubmenuTrigger
    || !threadContextMenu
  ) {
    return;
  }
  placeThreadProjectSubmenu();
}

function closeThreadProjectSubmenu({ focusTrigger = false } = {}) {
  if (threadProjectSubmenu) {
    threadProjectSubmenu.hidden = true;
    threadProjectSubmenu.style.visibility = ""; // never stay stuck invisible-but-shown
  }
  threadProjectSubmenuTrigger?.setAttribute("aria-expanded", "false");
  if (focusTrigger) {
    threadProjectSubmenuTrigger?.focus();
  }
}

// Open-only, not a toggle: on a mouse the pointer's `mouseenter` has already opened the
// flyout by the time the click lands, so toggling would make a deliberate click on
// "Projects" close what the user was reaching for. Dismissal is Escape / hovering
// another row / picking a Project. Tap (no hover) still opens it.
threadProjectSubmenuTrigger?.addEventListener("click", () => {
  openThreadProjectSubmenu();
});

// Hover opens the flyout, and hovering any OTHER row of the parent menu dismisses it —
// the usual nested-menu feel, so the panel never shadows the session actions.
threadProjectSubmenuTrigger?.addEventListener("mouseenter", () => {
  openThreadProjectSubmenu();
});

// ArrowRight/ArrowDown enter the flyout from the keyboard (Enter/Space already open it),
// landing on its first row so the list is navigable without a mouse.
threadProjectSubmenuTrigger?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowDown") {
    return;
  }
  event.preventDefault();
  openThreadProjectSubmenu({ focusFirst: true });
});

// ArrowLeft walks back out to the trigger — the mirror of ArrowRight, so a keyboard user
// can leave the flyout without dismissing the whole menu (which is what Escape does).
threadProjectSubmenu?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft") {
    return;
  }
  event.preventDefault();
  closeThreadProjectSubmenu({ focusTrigger: true });
});

threadContextMenu?.addEventListener("mouseover", (event) => {
  if (!threadProjectSubmenu || threadProjectSubmenu.hidden) {
    return;
  }
  const row = event.target.closest(".context-menu-button");
  if (!row || row === threadProjectSubmenuTrigger) {
    return;
  }
  closeThreadProjectSubmenu();
});

closeSettingsModalButton?.addEventListener("click", () => {
  settingsModal?.close();
});

settingsModal?.addEventListener("click", (event) => {
  if (event.target === settingsModal) {
    settingsModal.close();
  }
});

closePairingApprovalModalBtn?.addEventListener("click", () => {
  pairingApprovalModal?.close();
});

pairingApprovalModal?.addEventListener("click", (event) => {
  if (event.target === pairingApprovalModal) {
    pairingApprovalModal.close();
    return;
  }

  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

openLaunchSettingsButton?.addEventListener("click", () => {
  launchSettingsModal?.showModal();
});

closeLaunchSettingsModalButton?.addEventListener("click", () => {
  launchSettingsModal?.close();
});

launchSettingsModal?.addEventListener("click", (event) => {
  if (event.target === launchSettingsModal) {
    launchSettingsModal.close();
  }
});

openSessionDetailsButton?.addEventListener("click", () => {
  if (state.session) {
    renderSessionMeta(state.session);
  }
  sessionDetailsModal?.showModal();
});

closeSessionDetailsModalButton?.addEventListener("click", () => {
  sessionDetailsModal?.close();
});

sessionDetailsModal?.addEventListener("click", (event) => {
  if (event.target === sessionDetailsModal) {
    sessionDetailsModal.close();
  }
});

copyPairingLinkButton.addEventListener("click", () => {
  void copyPairingLink();
});

allowedRootsInput?.addEventListener("input", () => {
  state.localUiStore.getState().setAllowedRootsDraftDirty(true);
});

allowedRootsForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAllowedRoots();
});

// Exit the current session back to the list/overview. Bound to the in-conversation
// header back arrow. A collapsed nav panel comes back via the header's
// #toggle-left-panel (⌘B), which is what the icon-rail folder used to cover.
function goConsoleHome() {
  void clearThreadRoute();
}

goConsoleHomeButton?.addEventListener("click", goConsoleHome);

// Remember which project the next Start belongs to, then open the launcher. Shared
// by the project overview's "New agent" and the chat header's.
function startProjectAgent(projectId) {
  openStartSessionDialog({ projectId: projectId || null });
}

/**
 * Run one of the five whole-run task actions.
 *
 * All five share a body and a receipt, so they share this. The run id is sent
 * explicitly even though the backend accepts it as optional: that shortcut only
 * holds while one task runs at a time, and a UI that relied on it would break
 * silently the day that relaxes.
 */
async function runTeamAction(action, teamRunId) {
  if (!teamRunId || state.teamActionPending) {
    return;
  }
  state.teamActionPending = action;
  state.teamActionError = null;
  renderer.renderSession(state.session);
  try {
    const receipt = await teamAction(apiFetch, action, {
      teamRunId,
      deviceId: state.deviceId,
    });
    logLine(`Task ${teamRunId}: ${receipt.message}`);
  } catch (error) {
    // Surface the relay's own words. It refuses with the reason ("this task is
    // blocked; resolve it first"), and paraphrasing loses the instruction.
    state.teamActionError = error?.message || String(error);
  } finally {
    state.teamActionPending = null;
    renderer.renderSession(state.session);
  }
}

async function deleteTask(teamRunId) {
  if (!teamRunId || state.teamActionPending) {
    return false;
  }
  if (
    !window.confirm(
      "Delete this finished task and its sessions? This cannot be undone."
    )
  ) {
    return false;
  }
  state.teamActionPending = "delete";
  state.teamActionError = null;
  renderer.renderSession(state.session);
  try {
    const receipt = await deleteTeam(apiFetch, {
      teamRunId,
      deviceId: state.deviceId,
    });
    logLine(`Task ${teamRunId}: ${receipt.message}`);
    const context = sessionViewStore.getState().location.context || {};
    if (context.teamRunId === teamRunId) {
      void sessionViewController.showOverview({ kind: "tasks", teamRunId: null });
    }
    return true;
  } catch (error) {
    state.teamActionError = error?.message || String(error);
    return false;
  } finally {
    // A provider failure can happen after an earlier seat was deleted. Always
    // discard both caches so the UI reflects durable progress before a retry.
    teamsCache.invalidate();
    try {
      await loadThreads("post-task-delete refresh", { fresh: true });
    } catch (refreshError) {
      logLine(`Task delete refresh failed: ${refreshError?.message || refreshError}`);
    }
    state.teamActionPending = null;
    if (state.session) {
      renderer.renderSession(state.session);
    }
  }
}

// ── New task dialog ─────────────────────────────────────────────────────────
// Its own React sub-root, for the same reason the tab strip has one: the shell is
// rendered once, so anything data-driven needs one.
let startTaskRootHandle = null;
let startTaskFields = {};
let startTaskPending = false;
let startTaskError = null;

function renderStartTaskDialog() {
  if (!startTaskDialogMount) {
    return;
  }
  if (!startTaskRootHandle) {
    startTaskRootHandle = createRoot(startTaskDialogMount);
  }
  flushSync(() => {
    const teams = teamsFromCatalog(state.teamCatalog);
    startTaskRootHandle.render(
      React.createElement(StartTaskDialog, {
        fields: startTaskFields,
        pending: startTaskPending,
        error: startTaskError,
        defaultCwd: state.session?.current_cwd || "",
        teams,
        onFieldChange(key, value) {
          startTaskFields = { ...startTaskFields, [key]: value };
          renderStartTaskDialog();
        },
        onRequestClose() {
          startTaskError = null;
        },
        onStart: submitStartTask,
      })
    );
  });
}

function openStartTaskDialog() {
  startTaskError = null;
  renderStartTaskDialog();
  document.getElementById("start-task-dialog")?.setAttribute("open", "");
}

async function submitStartTask() {
  if (startTaskPending) {
    return;
  }
  startTaskPending = true;
  startTaskError = null;
  renderStartTaskDialog();
  try {
    const receipt = await startTeam(apiFetch, {
      title: startTaskFields.title || "",
      context: startTaskFields.context || "",
      acceptance_criteria: startTaskFields.acceptance_criteria || "",
      agreed_scope: startTaskFields.agreed_scope || "",
      quality_rules: startTaskFields.quality_rules || "",
      team_id: startTaskFields.team_id || BUILTIN_TEAM_ID,
      // Omitted rather than blank: the relay reads absent as "the current
      // workspace" and "the workspace's own branch", and an empty string is a
      // path/ref that resolves to nothing.
      cwd: startTaskFields.cwd?.trim() || null,
      target_branch: startTaskFields.target_branch?.trim() || null,
      device_id: state.deviceId,
    });
    logLine(`Task ${receipt.team_run_id}: ${receipt.message}`);
    // The relay's teams_revision will move, but not before the next render — and
    // the next render is the one that shows the new task's detail. Without this
    // the screen looks the task up in a pre-create list and reports it gone.
    teamsCache.invalidate();
    // Clear only on success — a rejected form must keep what the user typed.
    startTaskFields = {};
    document.getElementById("start-task-dialog")?.close();
    void sessionViewController.showOverview({
      kind: "tasks",
      teamRunId: receipt.team_run_id,
    });
  } catch (error) {
    startTaskError = error?.message || String(error);
  } finally {
    startTaskPending = false;
    renderStartTaskDialog();
  }
}

// The sidebar's two destinations. What each one does — and why Sessions restores a
// selection where Tasks blanks it — lives in shared/nav-destinations.js, next to a
// test that drives it against a real controller.
function openTaskScreen() {
  void openTasksDestination(sessionViewController);
}

function openUsageScreen() {
  void openUsageDestination(sessionViewController);
}

function openTeamsScreen(teamId = null) {
  void openTeamsDestination(sessionViewController, teamId || null);
}

function openSessionsScreen() {
  // No project check here: the reducer validates the remembered context against the
  // same `projectIds` / `projectIdsComplete` facts history restoration already uses,
  // so an unloaded catalogue cannot be mistaken for a deletion.
  void openSessionsDestination(sessionViewController);
}

// No listeners here for either of them, and none for the icon rail's copies. Both
// forms of the nav are one shared component (shared/sidebar-nav.js) taking these two
// functions as props — see the `onOpenSessionsScreen` / `onOpenTasksScreen` injections
// into createSessionRenderer below. Four id-addressed listeners became two props, and
// the rail can no longer offer a different set of destinations than the rows.

threadsRefreshButton.addEventListener("click", () => {
  void loadThreads("manual refresh");
});

archiveThreadButton?.addEventListener("click", () => {
  void archiveThreadFromContextMenu();
});

renameThreadButton?.addEventListener("click", () => {
  void renameThreadFromContextMenu();
});

flagThreadButton?.addEventListener("click", () => {
  void toggleThreadFlagFromContextMenu();
});

forkThreadButton?.addEventListener("click", () => {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  if (threadId) {
    openForkDialogForThread(threadId);
  }
});

deleteThreadButton?.addEventListener("click", () => {
  void deleteThreadFromContextMenu();
});

document.addEventListener("click", (event) => {
  if (projectContextMenu && !projectContextMenu.hidden && !event.target.closest("#project-context-menu")) {
    closeProjectContextMenu();
  }

  if (!threadContextMenu || threadContextMenu.hidden) {
    return;
  }

  // The Projects flyout is a sibling of the menu, not a descendant — without it in this
  // test, clicking a Project would close the menu before its handler ran.
  if (event.target.closest("#thread-context-menu") || event.target.closest("#thread-project-submenu")) {
    return;
  }

  closeThreadContextMenu();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // Peel one level at a time: an open Projects flyout first (back to the session
    // actions), and only then the menu itself.
    if (threadProjectSubmenu && !threadProjectSubmenu.hidden) {
      closeThreadProjectSubmenu({ focusTrigger: true });
      return;
    }
    // Third level of the same peel: a menu still open takes this Escape, and only a
    // press with nothing above it drops the selection. Otherwise dismissing the menu
    // would also discard the batch the user built to feed it.
    const menuWasOpen = readThreadListContextMenu(state.threadListStore).threadId != null;
    closeThreadContextMenu();
    closeProjectContextMenu();
    if (!menuWasOpen && readThreadSelection(state.threadListStore).ids.size) {
      state.threadListStore.getState().clearThreadSelection();
      renderThreads();
    }
  }
});

window.addEventListener("blur", () => {
  closeThreadContextMenu();
  closeProjectContextMenu();
});

window.addEventListener("resize", () => {
  closeThreadContextMenu();
  closeProjectContextMenu();
  syncThreadHistoryScroll();
});

window.addEventListener("popstate", (event) => {
  void sessionViewController.restoreHistory(
    event.state,
    readThreadIdFromUrl(),
    // Back/Forward retraces a browse: every peek pushed an entry, so replaying
    // one must reuse the preview slot rather than deposit a permanent tab per
    // step. Boot (below) deliberately does NOT pass this — a reloaded or shared
    // `?thread=` names a session on purpose.
    { preview: true }
  );
});

async function submitStartSession() {
  if (state.newSessionSubmitInFlight) {
    return;
  }
  const imageAttachments = state.newSessionImageAttachments.slice();
  state.newSessionSubmitInFlight = true;
  renderNewSessionImageAttachments();
  renderLaunchSessionDialogIfOpen();
  try {
    const newThreadId = await startSession(imageAttachments);
    if (newThreadId) {
      const sentIds = new Set(imageAttachments.map((attachment) => attachment.id));
      state.newSessionImageAttachments = state.newSessionImageAttachments.filter(
        (attachment) => !sentIds.has(attachment.id)
      );
    }
  } finally {
    state.newSessionSubmitInFlight = false;
    renderNewSessionImageAttachments();
    renderLaunchSessionDialogIfOpen();
  }
}

// Assign a just-started session to the project its "New agent" button belongs to. The
// membership change rides the snapshot's projects_revision bump (assign calls notify),
// same as every other project mutation, so the sidebar/overview refresh on their own.


// The banner is one slot with one button, but which button it is depends on why the
// banner is up (see local/control-banner.js), so both are bound here by id.
controlBanner?.addEventListener("click", (event) => {
  if (event.target.closest("#workspace-repair-button")) {
    void repairWorkspace();
    return;
  }
  if (!event.target.closest("#take-over-button")) {
    return;
  }

  void takeOverControl();
});

function renderComposerImageAttachments() {
  if (!composerAttachments) return;
  composerAttachments.replaceChildren();
  composerAttachments.hidden = state.composerImageAttachments.length === 0;

  for (const attachment of state.composerImageAttachments) {
    const chip = document.createElement("span");
    chip.className = "composer-attachment";

    const name = document.createElement("span");
    name.className = "composer-attachment-name";
    name.textContent = `${attachment.file.name || "Pasted image"} · ${formatAttachmentBytes(attachment.file.size)}`;
    chip.append(name);

    const remove = document.createElement("button");
    remove.className = "composer-attachment-remove";
    remove.dataset.removeImageAttachment = attachment.id;
    remove.disabled = state.composerSubmitInFlight;
    remove.type = "button";
    remove.title = "Remove image";
    remove.setAttribute("aria-label", `Remove ${attachment.file.name || "pasted image"}`);
    remove.textContent = "×";
    chip.append(remove);

    composerAttachments.append(chip);
  }
}

function clearComposerImageAttachments() {
  if (state.composerImageAttachments.length === 0) return;
  state.composerImageAttachments = [];
  renderComposerImageAttachments();
}

function renderNewSessionImageAttachments() {
  // Resolved live: the mount ships with the dialog, so a module-level query is null.
  const mount = document.getElementById("start-prompt-attachments");
  if (!mount) return;
  mount.replaceChildren();
  mount.hidden = state.newSessionImageAttachments.length === 0;

  for (const attachment of state.newSessionImageAttachments) {
    const chip = document.createElement("span");
    chip.className = "composer-attachment";

    const name = document.createElement("span");
    name.className = "composer-attachment-name";
    name.textContent = `${attachment.file.name || "Pasted image"} · ${formatAttachmentBytes(attachment.file.size)}`;
    chip.append(name);

    const remove = document.createElement("button");
    remove.className = "composer-attachment-remove";
    remove.dataset.removeNewSessionImageAttachment = attachment.id;
    remove.disabled = state.newSessionSubmitInFlight;
    remove.type = "button";
    remove.title = "Remove image";
    remove.setAttribute("aria-label", `Remove ${attachment.file.name || "pasted image"}`);
    remove.textContent = "×";
    chip.append(remove);

    mount.append(chip);
  }
}

function clearNewSessionImageAttachments() {
  if (state.newSessionImageAttachments.length === 0) return;
  state.newSessionImageAttachments = [];
  renderNewSessionImageAttachments();
}

// The fork dialog is rendered by React on every field change, so its prompt
// textarea and attachment mount do not exist at module load and are replaced
// as the user edits. Both handlers are therefore delegated from `document`,
// and the chips are re-applied after each React render (see
// renderForkSessionDialog) — React owns `hidden` on that div and would reset
// it to true on the next keystroke otherwise.
const FORK_DIALOG_ID = "local-fork-session-dialog";
const FORK_PROMPT_INPUT_ID = `${FORK_DIALOG_ID}-start-prompt`;
const FORK_PROMPT_ATTACHMENTS_ID = "fork-prompt-attachments";

function renderForkImageAttachments() {
  const mount = document.getElementById(FORK_PROMPT_ATTACHMENTS_ID);
  if (!mount) return;
  mount.replaceChildren();
  mount.hidden = state.forkImageAttachments.length === 0;

  for (const attachment of state.forkImageAttachments) {
    const chip = document.createElement("span");
    chip.className = "composer-attachment";

    const name = document.createElement("span");
    name.className = "composer-attachment-name";
    name.textContent = `${attachment.file.name || "Pasted image"} · ${formatAttachmentBytes(attachment.file.size)}`;
    chip.append(name);

    const remove = document.createElement("button");
    remove.className = "composer-attachment-remove";
    remove.dataset.removeForkImageAttachment = attachment.id;
    remove.disabled = Boolean(state.forkDialog?.pending);
    remove.type = "button";
    remove.title = "Remove image";
    remove.setAttribute("aria-label", `Remove ${attachment.file.name || "pasted image"}`);
    remove.textContent = "×";
    chip.append(remove);

    mount.append(chip);
  }
}

document.addEventListener("paste", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || target.id !== FORK_PROMPT_INPUT_ID) return;
  // Frozen while a submit is in flight, like the composer. Accepting a paste
  // here would attach an image to a request that has already been sent, and it
  // would be dropped when the fork completes and closes the dialog.
  if (state.forkDialog?.pending) return;
  const files = pastedImageFiles(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();

  const { accepted, errors } = validateImageAttachments(
    state.forkImageAttachments,
    files
  );
  for (const file of accepted) {
    state.forkImageAttachments.push({
      file,
      id: `fork-image-${state.nextForkImageAttachmentId++}`,
    });
  }
  for (const error of errors) {
    logLine(`Fork image rejected: ${error}`);
  }
  if (accepted.length > 0) {
    logLine(
      `Attached ${accepted.length} pasted image${accepted.length === 1 ? "" : "s"} to the fork.`
    );
    renderForkImageAttachments();
  }
});

document.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("[data-remove-fork-image-attachment]")
      : null;
  if (!button || state.forkDialog?.pending) return;
  state.forkImageAttachments = state.forkImageAttachments.filter(
    (attachment) => attachment.id !== button.dataset.removeForkImageAttachment
  );
  renderForkImageAttachments();
  document.getElementById(FORK_PROMPT_INPUT_ID)?.focus();
});


// Delegated: the dialog renders on demand, so there is nothing to bind at boot.
document.addEventListener("paste", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("#launch-start-session-dialog-start-prompt")) {
    return;
  }
  const files = pastedImageFiles(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();

  const { accepted, errors } = validateImageAttachments(
    state.newSessionImageAttachments,
    files
  );
  for (const file of accepted) {
    state.newSessionImageAttachments.push({
      file,
      id: `new-session-image-${state.nextNewSessionImageAttachmentId++}`,
    });
  }
  for (const error of errors) {
    logLine(`New session image rejected: ${error}`);
  }
  if (accepted.length > 0) {
    logLine(
      `Attached ${accepted.length} pasted image${accepted.length === 1 ? "" : "s"} to the new session.`
    );
    renderNewSessionImageAttachments();
  }
});

// Delegated for the same reason as the paste handler above.
document.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("[data-remove-new-session-image-attachment]")
      : null;
  if (!button || state.newSessionSubmitInFlight) return;
  state.newSessionImageAttachments = state.newSessionImageAttachments.filter(
    (attachment) => attachment.id !== button.dataset.removeNewSessionImageAttachment
  );
  renderNewSessionImageAttachments();
  document.getElementById("launch-start-session-dialog-start-prompt")?.focus();
});

messageInput?.addEventListener("paste", (event) => {
  const files = pastedImageFiles(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();

  const { accepted, errors } = validateImageAttachments(
    state.composerImageAttachments,
    files
  );
  for (const file of accepted) {
    state.composerImageAttachments.push({
      file,
      id: `image-${state.nextComposerImageAttachmentId++}`,
    });
  }
  for (const error of errors) {
    logLine(`Image attachment rejected: ${error}`);
  }
  if (accepted.length > 0) {
    logLine(
      `Attached ${accepted.length} pasted image${accepted.length === 1 ? "" : "s"}.`
    );
    renderComposerImageAttachments();
  }
});

composerAttachments?.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("[data-remove-image-attachment]")
      : null;
  if (!button || state.composerSubmitInFlight) return;
  state.composerImageAttachments = state.composerImageAttachments.filter(
    (attachment) => attachment.id !== button.dataset.removeImageAttachment
  );
  renderComposerImageAttachments();
  messageInput.focus();
});

// The provider/model vocabulary the "/" argument matcher is allowed to resolve
// against. Deliberately the REAL catalogue — matching against anything else is
// how a typo becomes a silently wrong model.
function composerCommandLaunchModel() {
  return selectReviewLaunchModel({
    providers: state.providers || [],
    providerModels: state.providerModels || {},
    session: state.session || null,
  });
}

// What each command IS lives behind the seam; this only hands over the
// capabilities it may act through, so the public tree never names one.
const composerCommands = createComposerCommandController({
  input: messageInput,
  mount: composerCommandMount,
  getCatalog: () => ({
    providers: state.providers || [],
    models: composerCommandLaunchModel().models,
    // Every session, so "@" can name one. The ids are already here, so naming
    // one never needs the relay to resolve a name.
    sessions: (state.threads || []).map((thread) => ({
      id: thread.id,
      name: thread.name || "",
      provider: thread.provider || "",
    })),
  }),
  getContext: () => {
    const session = state.session || null;
    const threadId = state.viewThreadId || session?.active_thread_id || null;
    return {
      threadId,
      canReview: canRequestReview(session, state.deviceId, threadId),
      defaultReviewerProvider: composerCommandLaunchModel().defaultProvider,
    };
  },
  requestReview: (values) => state.controller?.requestReview(values),
  // The SAME endpoint an agent's tool call lands on, so the human door and the
  // agent door cannot drift apart. A refusal comes back as 200 + isError, which
  // is text for the caller to read, not a transport failure.
  askAgent: async (callerThreadId, args) => {
    try {
      // The tool path only accepts a token, so the surface asks for one rather
      // than the route growing a second, weaker way to name a caller.
      const issued = await apiFetch("/api/session/ask-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: callerThreadId }),
      });
      const askToken = (await issued.json())?.data?.ask_token;
      const response = await apiFetch("/api/orchestrator/tools/ask_agent/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arguments: args, ask_token: askToken }),
      });
      const body = await response.json();
      return {
        text: body?.content?.[0]?.text || "No answer from the relay.",
        isError: Boolean(body?.isError) || !response.ok,
      };
    } catch (error) {
      return { text: `Could not reach the relay: ${error.message}`, isError: true };
    }
  },
  log: logLine,
});

// Drive a composer submit. The draft text and the target thread are captured
// synchronously at submit time and the composer is frozen, so a draft edit /
// navigation / second submit during the async send can't change or duplicate it.
// The send carries the target thread id; the relay starts the turn directly on
// that thread and moves control after success.
async function runComposerSubmit() {
  const text = messageInput.value;
  const imageAttachments = state.composerImageAttachments.slice();
  const pin = state.viewOnlyThread;
  if (pin?.review) {
    // A thread mid-review can't be sent to (the relay rejects resume/send for it).
    if (text.trim() || imageAttachments.length > 0) {
      logLine("This session is being reviewed — you can’t send to it right now.");
    }
    return;
  }
  // Ours, or an ordinary message? `submit` returns null for a "/word" we do not
  // own — and for every draft at all in a public build — which then reaches the
  // provider verbatim. That is what keeps a user's own .claude/commands/* working.
  const running = composerCommands.submit();
  if (running) {
    state.composerSubmitInFlight = true;
    if (state.session) renderer.renderSession(state.session);
    try {
      await running;
    } finally {
      state.composerSubmitInFlight = false;
      if (state.session) renderer.renderSession(state.session);
    }
    return;
  }
  if (!text.trim() && imageAttachments.length === 0) {
    void sendMessage(text); // empty → sendMessage logs the parity message
    return;
  }
  // The thread the user is looking at (the read-only pin's thread, else active).
  const targetThreadId = pin?.threadId || state.session?.active_thread_id || null;
  // Sending is the strongest "I'm working here" signal there is, so it keeps a
  // session that was only peeked at — otherwise the next sidebar click could
  // replace the preview tab out from under a live conversation. Fire and forget:
  // a strip bookkeeping write must never delay the message.
  if (targetThreadId) {
    void sessionViewController.promoteThread(targetThreadId);
  }
  state.composerSubmitInFlight = true;
  renderComposerImageAttachments();
  if (state.session) renderer.renderSession(state.session); // freeze the composer
  try {
    const images = await Promise.all(
      imageAttachments.map(async (attachment) => ({
        data_url: await imageFileToDataUrl(attachment.file),
      }))
    );
    const sent = await sendMessage(text, targetThreadId, images);
    if (sent) {
      const sentIds = new Set(imageAttachments.map((attachment) => attachment.id));
      state.composerImageAttachments = state.composerImageAttachments.filter(
        (attachment) => !sentIds.has(attachment.id)
      );
    }
  } catch (error) {
    logLine(`Image attachment failed: ${error.message}`);
  } finally {
    state.composerSubmitInFlight = false;
    renderComposerImageAttachments();
    if (state.session) renderer.renderSession(state.session); // unfreeze
  }
}

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.composerSubmitInFlight) {
    return; // a submit is already in flight — ignore the re-entry (double click)
  }
  void runComposerSubmit();
});

messageModel?.addEventListener("change", () => {
  // Keep the chip's logo on the model the user just picked. Unconditional and
  // first, because the effort bookkeeping below bails out when there's no
  // session provider — the mark must not be left showing the previous vendor.
  syncComposerModelMark();
  // Effort is no longer in the composer; the popover owns it. Just react
  // to model changes so an effort default can still be persisted for this
  // provider+model pair.
  const provider = state.session?.provider;
  if (!provider) return;
  const models = state.session?.available_models || [];
  const resolved = resolveReasoningEffortValue(
    models,
    messageModel.value,
    loadLastEffort(provider) || state.session?.reasoning_effort || ""
  );
  if (resolved) saveLastEffort(provider, resolved);
});

stopButton?.addEventListener("click", () => {
  void stopActiveTurn();
});

// One dispatcher, three surfaces. The chain that used to live inline here was
// copied into remote/react-app.js and absent from the Orchestrator pane, which
// is why that pane's Copy button and tool toggles rendered dead. Which button
// was clicked is now decided in shared/transcript-interactions.js; what to do
// about it stays here, where it needs this module's dialogs and state.
transcript.addEventListener(
  "click",
  createTranscriptInteractionHandler({
    copyMessage: ({ text, element }) => void copyTextToClipboard(text, element),
    forkFromItem: ({ itemId }) => {
      const threadId = state.viewThreadId || state.session?.active_thread_id || null;
      openForkDialogForThread(threadId, itemId);
    },
    approvalDecision: ({ decision, scope }) => void submitDecision(decision, scope),
    toggleGroup: ({ expandKey }) => toggleTranscriptExpandKey(expandKey),
    toggleEntry: ({ itemId }) => void toggleTranscriptEntry(itemId),
    fileChangeAction: ({ itemId, action }) => void applyFileChange(itemId, action),
    suggestion: ({ text }) => {
      messageInput.value = text;
      messageInput.focus();
    },
    // Standby "start a task" actions (#9): open the real New session dialog,
    // seeding its initial-prompt field when the starter carries one. This is the
    // actionable path — the composer is disabled with no active thread, so
    // prefilling it (data-suggestion) dead-ends.
    startSession: ({ prompt }) => {
      if (prompt) {
        state.localUiStore.getState().setSessionDraftField("initialPrompt", prompt);
        const promptInput = document.getElementById("start-prompt");
        if (promptInput) promptInput.value = prompt;
      }
      openStartSessionDialog();
    },
    openThread: ({ threadId }) => {
      if (!threadId) return;
      // Routed through the one implementation so every way of opening a session
      // shares its behaviour — including landing in the tab strip.
      //
      // These buttons ("Open live conversation" on Home, "Continue" on the
      // standby empty state) each name ONE session and you pressed it on
      // purpose, so this is a KEEP — the same class of gesture as a double
      // click, not a browse. Without the explicit `false` a session that was
      // already peeked would stay in the disposable slot and be thrown away by
      // the next sidebar click.
      void viewThreadById(threadId, { preview: false });
    },
    goHome: () => void runViewTransition(() => clearThreadRoute()),
  })
);

pendingActionBanner?.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    void submitDecision(
      approvalButton.dataset.approvalDecision,
      approvalButton.dataset.approvalScope || "once"
    );
    return;
  }

  const openPairingApproval = event.target.closest("[data-open-pairing-approval]");
  if (openPairingApproval) {
    if (pairingApprovalModal && !pairingApprovalModal.open) {
      try {
        pairingApprovalModal.showModal();
      } catch {}
    }
    return;
  }

  const openSecurity = event.target.closest("[data-open-security]");
  if (openSecurity) {
    openSettingsModal("devices");
  }
});

pairedDevicesList.addEventListener("click", (event) => {
  const revokeOthersButton = event.target.closest("[data-revoke-others-except-device-id]");
  if (revokeOthersButton) {
    void revokeOtherDevices(revokeOthersButton.dataset.revokeOthersExceptDeviceId);
    return;
  }

  const revokeButton = event.target.closest("[data-revoke-device-id]");
  if (!revokeButton) {
    return;
  }

  void revokePairedDevice(revokeButton.dataset.revokeDeviceId);
});

pendingPairingsList.addEventListener("click", (event) => {
  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

// Paint the sidebar's chrome BEFORE boot awaits anything.
//
// `renderLocalShell()` is synchronous but paints only the empty mounts; the nav, the search
// toggle and the bell are rendered by render-session, and `boot()` below does not reach its
// first `renderSession` until two network round trips have completed. Without this the
// sidebar sits chromeless until the relay answers — and because `createPanelControl` has
// already restored the collapsed state from localStorage at module scope, a user who quit
// collapsed boots into an icon rail holding a logo, a gear, and no way to go anywhere.
// That is the exact bug the shared nav exists to prevent, and on an unreachable relay the
// window is unbounded rather than brief.
//
// Safe here: `sessionViewStore` (which `getViewContext` reads) is created at module scope
// well above, and `teamsCache` answers `{ teams: [] }` before its first sync.
function paintInitialSidebarChrome() {
  renderSidebarNav();
  renderSidebarChrome();
}
paintInitialSidebarChrome();

// The React sub-roots this module owns, declared HERE rather than beside the render
// functions that use them, because `void boot();` on the next line runs boot()'s prologue
// synchronously — in the middle of this module's evaluation. A `let` further down the file
// is in its temporal dead zone at that moment, so a render call in that prologue throws
// `Cannot access 'X' before initialization` and the app never paints. That is not a
// hypothetical: renderStartSessionSplit() is boot()'s first statement.
// Pinned by frontend/boot-tdz-guard.test.mjs.
let sessionTabsRootHandle = null;
let sessionTabsRootElement = null;
let projectSwitcherRootHandle = null;
let projectSwitcherRootElement = null;
let launchDialogRootHandle = null;
let launchDialogRootElement = null;
let startSessionSplitRootHandle = null;
let startSessionSplitRootElement = null;

void boot();

async function boot() {
  // Painted before anything is fetched: the LEFT half needs no catalogue, and the sidebar
  // must not be missing its primary action while auth and providers settle. The caret
  // half appears on the re-render below, once there is more than one agent to pick.
  renderStartSessionSplit();
  apiTokenInput.value = state.apiToken;
  updateConnectionForm();

  await refreshAuthSession("initial boot");
  if (state.apiToken && state.authRequired && !state.authenticated) {
    await signInWithApiToken(state.apiToken, "stored token migration");
  }
  if (state.authRequired && !state.authenticated) {
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    updateConnectionForm();
    renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
    return;
  }

  // No `preview` intent, unlike the popstate handler above. Boot means "route to
  // this, changing nothing about a tab that already exists": a link to a session
  // you are not holding open opens a kept tab, while a refresh on one you were
  // only peeking at stays a peek — reload is not a gesture. This MUST happen
  // before loading the session: applying that snapshot starts an asynchronous
  // Projects reconciliation, and its history replace has to read the restored
  // thread route. If it sees the initial null location instead, it removes the
  // URL's `?thread=` while boot is still in flight and a large-thread reload
  // lands on console home.
  await runLocalBootDataPhase({
    restoreHistory: () => sessionViewController.restoreHistory(
      window.history.state,
      readThreadIdFromUrl()
    ),
    loadSession: () => loadSession("initial boot"),
    loadThreads: () => loadThreads("initial boot"),
    connectSessionStream,
    scheduleThreadsPoll,
    onRestoreError: (error) =>
      logLine(`Session view history restore failed during boot: ${error?.message || error}`),
  });
}

async function refreshAuthSession(reason) {
  try {
    const data = await fetchAuthSession();
    applyAuthSessionState(data);
    return data;
  } catch (error) {
    logLine(`Auth session check failed (${reason}): ${error.message}`);
    return null;
  }
}

async function submitAuthSession() {
  if (!state.authRequired) {
    logLine("This relay does not require an API token on the current bind host.");
    return;
  }

  const token = apiTokenInput.value.trim();
  if (token) {
    await signInWithApiToken(token, "manual sign-in");
    return;
  }

  if (!state.authenticated) {
    logLine("Enter RELAY_API_TOKEN to sign in.");
    apiTokenInput.focus();
    return;
  }

  await signOutAuthSession("manual sign-out");
}

async function signInWithApiToken(token, reason) {
  setConnectionFormBusy(true);

  try {
    const data = await createAuthSession(token);
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(data);
    logLine(`Local relay sign-in succeeded (${reason}).`);
    await resumeAfterAuthChange("sign-in");
  } catch (error) {
    clearStoredApiToken();
    state.apiToken = "";
    logLine(`Local relay sign-in failed: ${error.message}`);
  } finally {
    setConnectionFormBusy(false);
  }
}

async function signOutAuthSession(reason) {
  setConnectionFormBusy(true);

  try {
    const data = await deleteAuthSession();
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(data);
    logLine(`Local relay sign-out succeeded (${reason}).`);
    await resumeAfterAuthChange("sign-out");
  } catch (error) {
    logLine(`Local relay sign-out failed: ${error.message}`);
  } finally {
    setConnectionFormBusy(false);
  }
}

function applyAuthSessionState(view) {
  state.authRequired = Boolean(view?.auth_required);
  state.authenticated = Boolean(view?.authenticated);
  state.cookieSession = Boolean(view?.cookie_session);
  if (state.authenticated || !state.authRequired) {
    clearStoredApiToken();
    state.apiToken = "";
  }
  updateConnectionForm();
}

function updateConnectionForm() {
  if (!apiTokenLabel || !applyTokenButton) {
    return;
  }

  connectionForm.hidden = !state.authRequired;

  if (!state.authRequired) {
    apiTokenLabel.textContent = "Local Access";
    apiTokenInput.value = "";
    apiTokenInput.disabled = true;
    apiTokenInput.placeholder = "No API token required on this relay";
    applyTokenButton.textContent = "Ready";
    applyTokenButton.disabled = true;
    return;
  }

  apiTokenLabel.textContent = state.cookieSession ? "Local Session" : "API Token";
  apiTokenInput.disabled = false;
  applyTokenButton.disabled = false;

  if (state.authenticated) {
    apiTokenInput.placeholder = "Signed in. Submit an empty field to sign out.";
    applyTokenButton.textContent = "Sign Out";
  } else {
    apiTokenInput.placeholder = "Enter RELAY_API_TOKEN to sign in";
    applyTokenButton.textContent = "Sign In";
  }
}

function setConnectionFormBusy(busy) {
  apiTokenInput.disabled = busy || !state.authRequired;
  applyTokenButton.disabled = busy || !state.authRequired;
}

async function resumeAfterAuthChange(reason) {
  state.streamConnected = false;
  cancelStreamReconnect();
  cancelSessionPoll();
  cancelThreadsPoll();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }

  if (state.authRequired && !state.authenticated) {
    renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
    return;
  }

  await loadSession(reason);
  await loadThreads(reason);
  connectSessionStream();
}

function handleUnauthorized(message) {
  const alreadySignedOut = state.authRequired && !state.authenticated;
  clearStoredApiToken();
  state.apiToken = "";
  apiTokenInput.value = "";
  state.authenticated = false;
  state.cookieSession = false;
  state.streamConnected = false;
  cancelStreamReconnect();
  cancelSessionPoll();
  cancelThreadsPoll();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }
  updateConnectionForm();
  renderAuthRequiredState(message);
  if (!alreadySignedOut) {
    logLine(message);
  }
}

function seedDefaults(session) {
  void refreshProviderCatalogs(session);
  const activeProvider = session.provider || defaultProvider(state.providers);
  // A live snapshot still arrives while the user is browsing a different,
  // client-local view-only thread. Seed the composer from what is rendered,
  // not from the live provider, or each snapshot briefly replaces the viewed
  // thread's friendly model name/catalogue before the deferred render repairs it.
  const renderedSession = projectViewOnlySession(session, {
    viewThreadId: state.viewThreadId,
    viewOnlyThread: state.viewOnlyThread,
  }) || session;
  const renderedProvider = renderedSession.provider || activeProvider;
  const launchProvider = providerInput?.value || activeProvider;
  const launchModels = modelsForProvider(
    launchProvider,
    session.available_models || [],
    session.provider
  );

  const seededModel = state.defaultsSeeded
    ? messageModel?.value || renderedSession.model
    : renderedSession.model || defaultModelForProvider(renderedProvider);
  syncComposerModelForRenderedSession(renderedSession, seededModel);
  state.defaultsSeeded = true;

  // Effort is no longer rendered in the composer (it lives in the settings
  // popover and persists via localStorage). If a stale messageEffort element
  // is still in the DOM, keep it in sync for backwards-compat.
  if (messageEffort) {
    syncEffortSuggestions(
      messageEffort,
      session.available_models || [],
      messageModel?.value || session.model,
      messageEffort.value || session.reasoning_effort,
      session.provider || ""
    );
  }

  syncLaunchSettingsModal(session, launchProvider, launchModels, activeProvider);

  if (!state.selectedCwd && session.current_cwd) {
    setSelectedCwd(session.current_cwd);
  }
}

async function refreshProviderCatalogs(session) {
  let catalogsChanged = false;
  try {
    const launchDraft = readLocalUiState(state.localUiStore).sessionDraft || {};
    const liveProviderInput = document.getElementById("provider-input") || providerInput;
    const selectedProvider = launchDraft.provider || liveProviderInput?.value || session.provider;
    if (!state.providers.length) {
      const providersResponse = await apiFetch("/api/providers");
      const providersPayload = await providersResponse.json();
      if (providersResponse.ok && providersPayload.ok) {
        state.providers = normalizeProviderList(providersPayload.data);
        syncProviderSuggestions(liveProviderInput, state.providers, selectedProvider);
        // The split button's agent menu is this same list.
        renderStartSessionSplit();
      }
    }
    await Promise.all(state.providers.map(async (provider) => {
      if (state.providerModels[provider]?.length) return;
      const response = await apiFetch(`/api/providers/${encodeURIComponent(provider)}/models`);
      const payload = await response.json();
      if (response.ok && payload.ok) {
        const models = payload.data || [];
        state.providerModels[provider] = models;
        catalogsChanged ||= models.length > 0;
      }
    }));
    // The merged Model pill is built from these catalogues. Opening the dialog
    // before they land left an empty menu that never refilled.
    renderLaunchSessionDialogIfOpen();
    const provider = selectedProvider || defaultProvider(state.providers);
    const liveModelInput = document.getElementById("model-input") || modelInput;
    const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;
    syncLaunchSettingLabels(provider);
    syncModelSuggestions(
      liveModelInput,
      modelsForProvider(provider, session.available_models || [], session.provider),
      liveModelInput?.value || defaultModelForProvider(provider)
    );
    syncEffortSuggestions(
      liveStartEffortInput,
      modelsForProvider(provider, session.available_models || [], session.provider),
      liveModelInput?.value || defaultModelForProvider(provider),
      liveStartEffortInput?.value || "",
      provider
    );
  } catch (error) {
    logLine(`Provider model refresh failed: ${error.message}`);
    return;
  }

  // The initial snapshot can arrive before any provider catalogue. Refresh
  // only the model control once the fetch fills that cache; a full session
  // repaint would unnecessarily settle transcript work and rerender dialogs.
  if (catalogsChanged && state.session?.active_thread_id) {
    try {
      syncComposerModelForRenderedSession(
        projectViewOnlySession(state.session, {
          viewThreadId: state.viewThreadId,
          viewOnlyThread: state.viewOnlyThread,
        })
      );
    } catch (error) {
      logLine(`Composer model refresh failed: ${error.message}`);
    }
  }
}

// The composer chip's logo, for the surface that renders its options outside
// React. Reads the vendor off the selected <option> rather than re-deriving it
// from state, so it stays correct whether the change came from the user or from
// a snapshot reasserting the session's model.
function syncComposerModelMark() {
  if (!messageModel) {
    return;
  }
  const selected = messageModel.selectedOptions?.[0];
  applyProviderMark(
    document.getElementById("message-model-mark"),
    selected?.dataset?.provider || ""
  );
}

function syncComposerModelForRenderedSession(session, selectedModel = "") {
  if (!messageModel || !session) {
    return;
  }

  const models = session.available_models || [];
  const fallbackModels = state.providerModels[session.provider] || [];
  const displayModels = models.length ? models : fallbackModels;
  const requestedModel = selectedModel || messageModel.value;
  const currentModel = displayModels.some((model) => model.model === requestedModel)
    ? requestedModel
    : session.model || requestedModel;

  // The rendered session may be a client-local view-only projection for a
  // provider different from the relay's live session. Use that projection's
  // catalog, reject a foreign current value in view-only mode, and reassert the
  // projection after every live snapshot. Preserve a manual selection whenever
  // it still belongs to the rendered provider's catalog.
  syncModelSuggestions(
    messageModel,
    models,
    currentModel,
    !session.view_only,
    true,
    fallbackModels
  );
  syncComposerModelMark();
}

function syncProviderSuggestions(select, providers, selectedProvider) {
  if (!select) {
    return;
  }
  const options = providerOptions(providers);
  renderSelectOptions(select, options, selectedProvider || defaultProvider(providers));
}

// `fallbackModels` is always the session snapshot's `available_models`, which
// belong to the snapshot's OWN provider — hence `fallbackProvider`. Defaulting
// it to `state.session?.provider` matches every call site that passes
// `state.session.available_models`; the few that pass a session object around
// name its provider explicitly.
function modelsForProvider(
  provider,
  fallbackModels = [],
  fallbackProvider = state.session?.provider
) {
  return scopedProviderModels(provider, state.providerModels, fallbackProvider, fallbackModels);
}

function handleLaunchFieldInput(field, value) {
  if (!field) {
    return;
  }
  const ui = state.localUiStore.getState();
  ui.setSessionDraftField(field, value);

  const draftProvider = readLocalUiState(state.localUiStore).sessionDraft?.provider || "codex";
  if (field === "effort") saveLastEffort(draftProvider, value);
  if (field === "approvalPolicy") saveLastApprovalPolicy(draftProvider, value);

  if (field === "cwd") {
    void refreshLaunchGitContext(value);
  }

  if (field === "provider") {
    // Model, effort and approval are all per-provider; restore this one's last used.
    void refreshProviderCatalogs(state.session || {});
    const storedApproval = loadLastApprovalPolicy(value);
    const storedEffort = loadLastEffort(value);
    if (storedApproval) ui.setSessionDraftField("approvalPolicy", storedApproval);
    if (storedEffort) ui.setSessionDraftField("effort", storedEffort);
  }

  renderLaunchSessionDialog();
}

// Generation-guarded: a late answer must not seed a dialog reopened on another
// thread. Display only — these are never written into the submitted fields.
let forkSettingsGeneration = 0;
async function refreshForkSourceSettings(threadId) {
  const generation = ++forkSettingsGeneration;
  try {
    const response = await apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}/settings?device_id=${encodeURIComponent(state.deviceId || "")}`
    );
    const payload = await response.json();
    if (generation !== forkSettingsGeneration) return;
    if (!response.ok || !payload.ok) return;
    const dialog = state.forkDialog;
    if (!dialog?.open || dialog.sourceThread?.id !== threadId) return;

    // DISPLAY only. Writing these into `fields` would submit them, freezing a
    // permission the source may tighten while the dialog is open.
    state.forkDialog = { ...dialog, sourceSettings: payload.data };
    renderForkSessionDialog();
  } catch {
    // A failed fetch just leaves the fields inherited, which is what they were
    // before this existed and is still a correct request.
  }
}

// Separate counter and slot from the launch dialog's: both can be open on
// different directories.
let forkGitContextGeneration = 0;
let forkGitContextTimer = null;
async function refreshForkGitContext(cwd) {
  const generation = ++forkGitContextGeneration;
  if (forkGitContextTimer) clearTimeout(forkGitContextTimer);
  const target = String(cwd || "").trim();
  state.forkGitContext = null;
  if (!target) {
    return;
  }
  forkGitContextTimer = setTimeout(async () => {
    try {
      const response = await apiFetch(
        `/api/workspace/git-context?cwd=${encodeURIComponent(target)}`
      );
      const payload = await response.json();
      if (generation !== forkGitContextGeneration) return;
      state.forkGitContext = !response.ok || !payload.ok ? null : payload.data || null;
    } catch {
      if (generation === forkGitContextGeneration) state.forkGitContext = null;
    }
    if (state.forkDialog?.open) renderForkSessionDialog();
  }, 250);
}

// The static per-provider constant is a seed, not an answer: prefer the catalogue.
function defaultModelForProviderCatalog(provider) {
  const models = state.providerModels[provider] || [];
  return (
    models.find((option) => option.is_default)?.model
    || models[0]?.model
    || defaultModelForProvider(provider)
  );
}

// One step, because effort is per MODEL: a Codex `xhigh` carried onto a Claude
// model that offers only high/max is honoured by the relay, not corrected.
function handleLaunchModelSelection({ provider, model }) {
  const ui = state.localUiStore.getState();
  const previousProvider = readLocalUiState(state.localUiStore).sessionDraft?.provider || "";
  if (provider && provider !== previousProvider) {
    ui.setSessionDraftField("provider", provider);
    const storedApproval = loadLastApprovalPolicy(provider);
    if (storedApproval) ui.setSessionDraftField("approvalPolicy", storedApproval);
    void refreshProviderCatalogs(state.session || {});
  }
  ui.setSessionDraftField("model", model);

  const draft = readLocalUiState(state.localUiStore).sessionDraft || {};
  const models = state.providerModels[provider] || [];
  // Clamp against the NEW model's catalogue. Falls back to the model's own
  // default when the current level is not offered.
  const effort = resolveReasoningEffortValue(models, model, draft.effort);
  if (effort !== draft.effort) {
    ui.setSessionDraftField("effort", effort);
    saveLastEffort(provider, effort);
  }
  renderLaunchSessionDialog();
}

// Debounced and generation-guarded: the field is free text, so a probe per
// keystroke would spawn a git subprocess per character.
let launchGitContextGeneration = 0;
let launchGitContextTimer = null;
async function refreshLaunchGitContext(cwd) {
  const generation = ++launchGitContextGeneration;
  if (launchGitContextTimer) clearTimeout(launchGitContextTimer);
  const target = String(cwd || "").trim();
  // Drop the old answer now: otherwise path B wears path A's branch until the reply.
  state.launchGitContext = null;
  renderLaunchSessionDialogIfOpen();
  if (!target) {
    return;
  }
  launchGitContextTimer = setTimeout(async () => {
    try {
      const response = await apiFetch(
        `/api/workspace/git-context?cwd=${encodeURIComponent(target)}`
      );
      const payload = await response.json();
      if (generation !== launchGitContextGeneration) return;
      // No path-equality check: the relay answers about the NORMALIZED cwd, and the
      // generation counter above already makes a stale answer safe to drop.
      state.launchGitContext = !response.ok || !payload.ok ? null : payload.data || null;
    } catch {
      // A failed probe is not worth surfacing: the chip is an extra, and the
      // dialog is fully usable without it.
      if (generation === launchGitContextGeneration) state.launchGitContext = null;
    }
    renderLaunchSessionDialog();
  }, 250);
}

function syncLaunchSettingsModal(session, provider, launchModels, activeProvider) {
  const prov = provider || activeProvider || "codex";
  // Scoped, not raw: `available_models` is the ACTIVE session's catalog, and
  // this modal is showing the LAUNCH provider's picker.
  const models = launchModels?.length
    ? launchModels
    : modelsForProvider(prov, session?.available_models || [], session?.provider);
  const settings = providerSettings(prov);
  const launchDraft = readLocalUiState(state.localUiStore).sessionDraft || {};
  const fields = {
    approvalPolicy: launchDraft.approvalPolicy || session?.approval_policy || "untrusted",
    cwd: session?.current_cwd || state.selectedCwd || "",
    effort: launchDraft.effort || session?.reasoning_effort || "medium",
    initialPrompt: launchDraft.initialPrompt || "",
    model: launchDraft.model || session?.model || defaultModelForProvider(prov),
    provider: prov,
    sandbox: launchDraft.sandbox || session?.sandbox || "workspace-write",
  };
  const liveCwdInput = document.getElementById("cwd-input") || cwdInput;
  const liveStartPromptInput = document.getElementById("start-prompt") || startPromptInput;
  const liveProviderInput = document.getElementById("provider-input") || providerInput;
  const liveModelInput = document.getElementById("model-input") || modelInput;
  const liveApprovalPolicyInput = document.getElementById("approval-policy-input") || approvalPolicyInput;
  const liveSandboxInput = document.getElementById("sandbox-input") || sandboxInput;
  const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;

  if (liveCwdInput && !liveCwdInput.value) liveCwdInput.value = fields.cwd;
  if (liveStartPromptInput) liveStartPromptInput.value = fields.initialPrompt;
  syncProviderSuggestions(liveProviderInput, state.providers, fields.provider);
  syncLaunchSettingLabels(fields.provider);
  syncModelSuggestions(liveModelInput, models, fields.model);
  renderSelectOptions(liveApprovalPolicyInput, settings.approvalOptions, fields.approvalPolicy);
  renderSelectOptions(liveSandboxInput, sandboxOptions(), fields.sandbox);
  syncEffortSuggestions(liveStartEffortInput, models, fields.model, fields.effort, fields.provider);
}

function syncLaunchSettingLabels(provider) {
  const settings = providerSettings(provider);
  if (modelInputLabel) {
    modelInputLabel.textContent = settings.modelLabel;
  }
  if (startEffortLabel) {
    startEffortLabel.textContent = settings.effortLabel;
  }
  renderSelectOptions(
    approvalPolicyInput,
    settings.approvalOptions,
    approvalPolicyInput?.value || "untrusted"
  );
  renderSelectOptions(
    sandboxInput,
    sandboxOptions(),
    sandboxInput?.value || "workspace-write"
  );
}

async function selectLaunchProvider(provider) {
  const selected = provider || defaultProvider(state.providers);
  syncLaunchSettingLabels(selected);
  if (!state.providerModels[selected]?.length) {
    await refreshProviderCatalogs(state.session || { provider: selected, available_models: [] });
  }
  const models = modelsForProvider(selected, state.session?.available_models || []);
  const model = models.find((option) => option.is_default)?.model
    || models[0]?.model
    || defaultModelForProvider(selected);
  syncModelSuggestions(modelInput, models, model);
  syncEffortSuggestions(startEffortInput, models, model, startEffortInput?.value || "", selected);
}

function syncEffortSuggestions(select, models, selectedModel, selectedEffort, provider = "") {
  if (!select) {
    return;
  }

  const resolvedEffort = resolveReasoningEffortValue(models, selectedModel, selectedEffort);
  renderSelectOptions(
    select,
    buildReasoningEffortOptions(models, selectedModel, provider),
    resolvedEffort
  );
}

function setSelectedCwd(cwd) {
  state.threadListStore.getState().setSelectedCwd(cwd);
  state.selectedCwd = readThreadListUi(state.threadListStore).selectedCwd;
  // The field only exists while the dialog is open, so mirror into the draft.
  state.localUiStore?.getState?.().setSessionDraftField?.("cwd", state.selectedCwd);
}

function resolveActiveThread(threadId) {
  if (!threadId) {
    return null;
  }

  return findVisible(threadId);
}

function renderForkSessionDialog() {
  if (!forkSessionDialogRoot) {
    return;
  }
  if (!forkSessionRoot) {
    forkSessionRoot = createRoot(forkSessionDialogRoot);
  }
  const dialogState = state.forkDialog;
  if (!dialogState.open || !dialogState.sourceThread) {
    flushSync(() => forkSessionRoot.render(null));
    return;
  }

  const fields = dialogState.fields || defaultForkFields(dialogState.sourceThread);
  const provider = fields.provider || defaultProvider(state.providers);
  const models = modelsForProvider(provider, state.session?.available_models || []);
  const settings = providerSettings(provider);
  const selectedModel = fields.model || defaultModelForProvider(provider);
  const dialog = React.createElement(ForkSessionDialog, {
    id: FORK_DIALOG_ID,
    initialPromptAttachmentsId: FORK_PROMPT_ATTACHMENTS_ID,
    sourceThread: dialogState.sourceThread,
    fields,
    pending: dialogState.pending,
    error: dialogState.error || "",
    // The merged Model pill needs every provider's catalogue, not one flattened
    // list — a cross-provider fork is chosen from the same menu.
    providers: state.providers || [],
    providerModels: state.providerModels,
    modelsStatus: models.length ? "ready" : "loading",
    gitContext: state.forkGitContext,
    workspaceSuggestions: selectWorkspaceSuggestionsModel({
      selectedCwd: fields.cwd || "",
      session: state.session,
      threads: state.threads || [],
    }),
    onSelectModel: handleForkModelSelection,
    approvalOptions: settings.approvalOptions,
    effortOptions: buildReasoningEffortOptions(models, selectedModel, provider),
    forkCapabilities: state.session?.provider_fork_capabilities || [],
    sourceSettings: dialogState.sourceSettings || null,
    sourceProjectId: state.threadProjectId?.[dialogState.sourceThread?.id] || null,
    onCreateProject() {
      // The generation, not the source id: reopening on the SAME thread is still a
      // different opening, and the earlier answer does not belong to it.
      const opening = state.forkDialogGeneration;
      void createProjectForLaunchDraft(
        (projectId) => handleForkDialogFieldChange("projectId", projectId),
        () => state.forkDialog?.open && state.forkDialogGeneration === opening
      );
    },
    projects: state.projects || [],
    threadProjectId: state.threadProjectId || {},
    threads: state.threads || [],
    onFieldChange: handleForkDialogFieldChange,
    onFork: submitForkDialog,
    onRequestClose: closeForkDialog,
  });

  flushSync(() => forkSessionRoot.render(dialog));
  // After React, never before: the mount only exists once React has rendered
  // it, and it is a brand-new empty div on every open. Re-running here also
  // re-syncs each chip's disabled state when `pending` flips on submit.
  // (React itself leaves the chips alone — it never sets children on that div,
  // and `hidden` is a constant prop, so it is not rewritten between renders.)
  renderForkImageAttachments();
  const element = document.getElementById(FORK_DIALOG_ID);
  if (element && !element.open) {
    element.showModal();
  }
}

function threadIsBusy(thread) {
  return threadIsBusyForFork(thread, state.session);
}

function openForkDialogForThread(threadId, upToItemId = "") {
  // Falls back to the viewed session snapshot: on a deep link the transcript
  // (and its fork buttons) render before the sidebar thread list exists, and
  // the list is paged so an older thread may never appear in it.
  const visible = findVisible(threadId);
  const thread = resolveForkSourceThread({
    threadId,
    // The search slice too: a result from beyond the authoritative page is exactly the
    // kind of older thread this resolver's fallbacks exist for, and forking it is one
    // of the main reasons to have gone looking.
    threads: visible ? [visible, ...(state.threads || [])] : state.threads,
    session: state.session,
    viewedThread: state.viewOnlyThread,
  });
  if (!thread) {
    logLine(`Cannot fork unknown session ${threadId}`);
    return;
  }
  // A thread mid-turn is rejected by the relay (the transcript is still being
  // written), so refuse here instead of letting the user fill in the whole
  // dialog first. Background threads count — they have their own live runtime.
  if (threadIsBusy(thread)) {
    logLine("Cannot fork a session while a turn is in progress.");
    return;
  }
  const models = modelsForProvider(thread.provider, state.session?.available_models || []);
  // Not awaited: the dialog opens on inherited fields and re-seeds when this lands.
  void refreshForkSourceSettings(thread.id);
  state.forkDialog = {
    open: true,
    pending: false,
    sourceThread: thread,
    fields: {
      ...defaultForkFields({ thread, models, session: state.session }),
      cwd: thread.cwd || state.session?.current_cwd || state.selectedCwd || "",
      upToItemId: upToItemId || "",
      // Branching at the tip drops nothing, so the relay collapses it to a
      // whole-thread fork — which keeps a tip-only native fork native.
      // The entries ACTUALLY on screen: while viewing a saved thread,
      // `state.session` is still the live session (same trap as
      // resolveForkSourceThread), so its transcript would answer for the
      // wrong thread.
      forkPointIsTip: forkPointIsTranscriptTip(
        state.viewOnlyThread?.threadId === threadId
          ? state.viewOnlyThread.entries || []
          : state.session?.transcript || [],
        upToItemId || ""
      ),
    },
  };
  closeThreadContextMenu();
  // Treat each opening as a fresh attachment draft. Reopening after a dismiss
  // or a failed fork must not silently carry a screenshot into a fork of a
  // DIFFERENT source thread. An in-flight fork captured its own slice already,
  // and the generation bump stops it from acting on this new dialog.
  state.forkImageAttachments = [];
  state.forkDialogGeneration += 1;
  renderForkSessionDialog();
  // The source thread's catalog is usually not the active session's, so fetch
  // it before the user can submit a model that belongs to another provider.
  void ensureForkProviderModels(thread.provider);
}

function closeForkDialog() {
  state.forkDialog = {
    open: false,
    pending: false,
    sourceThread: null,
    fields: null,
    error: "",
  };
  renderForkSessionDialog();
}

// Fetch a provider's model catalog so the fork dialog can offer that
// provider's own models. Without this a cross-provider fork sits on
// "Loading models..." forever and can submit a foreign model id.
async function ensureForkProviderModels(provider) {
  if (!provider) return;
  if (modelsForProvider(provider, state.session?.available_models || []).length) return;
  try {
    await refreshProviderCatalogs(
      state.session || { provider, available_models: [] }
    );
  } catch (error) {
    logLine(`Could not load ${providerLabel(provider) || provider} models: ${error.message}`);
  }
  renderForkSessionDialog();
}

function handleForkDialogFieldChange(field, value) {
  const current = state.forkDialog.fields;
  let next = { ...current, [field]: value };
  if (field === "cwd") {
    void refreshForkGitContext(value);
  }
  if (field === "provider") {
    const models = modelsForProvider(value, state.session?.available_models || []);
    next = applyForkProviderChange(next, value, models);
    void ensureForkProviderModels(value);
  }
  state.forkDialog = { ...state.forkDialog, fields: next, error: "" };
  renderForkSessionDialog();
}

// One step, like the launch dialog. The INHERIT row must NOT re-resolve: that one
// is deliberately sent as null for the relay to read off the source.
function handleForkModelSelection({ provider, model }) {
  const current = state.forkDialog.fields;
  let next = { ...current };
  if (provider && provider !== current.provider) {
    const models = modelsForProvider(provider, state.session?.available_models || []);
    next = applyForkProviderChange(next, provider, models);
    void ensureForkProviderModels(provider);
  }
  next.model = model;
  if (model !== INHERIT) {
    next.effort = resolveReasoningEffortValue(
      state.providerModels[provider] || [],
      model,
      next.effort
    );
  }
  state.forkDialog = { ...state.forkDialog, fields: next, error: "" };
  renderForkSessionDialog();
}

// `submittedFields` are the dialog's NORMALIZED fields — the values actually on
// screen. Submitting `dialogState.fields` instead would send the raw state,
// which after a provider change can still hold the withdrawn empty "inherit"
// value: the user sees a concrete model and the relay resolves its own.
async function submitForkDialog(submittedFields = null) {
  const dialogState = state.forkDialog;
  if (!dialogState.sourceThread?.id || dialogState.pending) {
    return;
  }
  // Capture the attachments synchronously, like the composer does: the dialog
  // can be reopened (which resets the draft) while this request is in flight.
  const imageAttachments = state.forkImageAttachments.slice();
  // The dialog stays cancelable while pending, so this request may outlive the
  // opening that started it. Every completion below is gated on this token.
  const generation = state.forkDialogGeneration;
  state.forkDialog = { ...dialogState, pending: true };
  renderForkSessionDialog();
  let images = [];
  try {
    images = await Promise.all(
      imageAttachments.map(async (attachment) => ({
        data_url: await imageFileToDataUrl(attachment.file),
      }))
    );
  } catch (error) {
    if (
      forkCompletionEffect({
        capturedGeneration: generation,
        currentGeneration: state.forkDialogGeneration,
        ok: false,
      }) === "showError"
    ) {
      state.forkDialog = {
        ...state.forkDialog,
        pending: false,
        error: `Image attachment failed: ${error.message}`,
      };
      renderForkSessionDialog();
    }
    return;
  }
  const result = await forkSession(
    {
      ...(submittedFields || dialogState.fields),
      sourceThreadId: dialogState.sourceThread.id,
    },
    images
  );
  const effect = forkCompletionEffect({
    capturedGeneration: generation,
    currentGeneration: state.forkDialogGeneration,
    ok: Boolean(result?.ok),
  });
  if (effect === "discard") {
    // The user cancelled and reopened while this was in flight. The fork itself
    // still happened (or failed) on the relay and was logged there; touching the
    // dialog now would close or corrupt an unrelated one.
    return;
  }
  if (effect === "close") {
    // This opening is still the current one, so its draft is exactly what was
    // sent — clear it and close.
    state.forkImageAttachments = [];
    closeForkDialog();
    return;
  }
  // Surface the failure IN the dialog. Reporting only through logLine left the
  // button silently re-enabling with no visible reason, so users retried.
  state.forkDialog = {
    ...state.forkDialog,
    pending: false,
    error: result?.error || "Failed to fork session.",
  };
  renderForkSessionDialog();
}

// A modified click on a session row: Cmd/Ctrl toggles one, Shift extends a range
// from the anchor. The rows only reach the delete this selection feeds through the
// right-click menu, so nothing here starts an action on its own.
// Every click on a session row lands here first. Returns true when the click WAS the
// gesture (and so must not also open the session), false to let the row open it.
function selectThreadFromClick(threadId, event, orderedThreadIds = []) {
  const intent = threadSelectionIntent(event, {
    applePlatform: matchesApplePlatform(
      window.navigator?.platform || "",
      window.navigator?.userAgent || ""
    ),
  });
  // ctrl+click on a Mac is the right-click: its `contextmenu` has already opened the
  // menu over this row, so the click is spent. Claim it without touching the
  // selection, which is the batch that menu was just built for.
  if (intent === "open" && (event?.ctrlKey || event?.metaKey || event?.shiftKey)) {
    return true;
  }

  const before = readThreadSelection(state.threadListStore);
  const { selection } = applyThreadSelectionClick({
    selection: before,
    threadId,
    orderedThreadIds,
    intent,
  });
  state.threadListStore.getState().setThreadSelection(selection);

  if (intent === "open") {
    // A plain click is here only to drop the old selection and leave the anchor on
    // this row. Re-render just for the highlight that went away — the open itself
    // renders anyway — and let the row proceed.
    if (before.ids.size) {
      renderThreads();
    }
    return false;
  }

  // Growing a selection is not browsing: the open session stays put. Any menu still
  // up was built for a batch that no longer matches, so it goes.
  closeThreadContextMenu({ rerender: false });
  renderThreads();
  return true;
}

function openThreadContextMenu(threadId, clientX, clientY, orderedThreadIds = []) {
  if (!threadContextMenu || !archiveThreadButton || !deleteThreadButton || !threadId) {
    return;
  }

  // Right-clicking inside a multi-selection aims the menu at the whole batch;
  // right-clicking outside it drops the selection first, so the menu can never act
  // on rows the user cannot see highlighted.
  const targets = resolveContextMenuTargets({
    selection: readThreadSelection(state.threadListStore),
    threadId,
    orderedThreadIds,
  });
  state.threadListStore.getState().setThreadSelection(targets.selection);
  state.contextMenuThreadIds = targets.threadIds;
  const batchSize = targets.threadIds.length;

  state.threadListStore.getState().openContextMenu(threadId, clientX, clientY);
  const isActive = state.session?.active_thread_id === threadId;
  const isRunningActiveSession =
    isActive && Boolean(state.session?.active_turn_id);
  const contextThread = resolveActiveThread(threadId);
  if (forkThreadButton) {
    // Background threads can be mid-turn too, and the relay rejects those as
    // well — gate on the same rule the server uses, not just "is active".
    const forkBlocked = threadIsBusy(contextThread);
    forkThreadButton.disabled = forkBlocked;
    forkThreadButton.textContent = forkBlocked
      ? "Running session cannot be forked"
      : "Fork session";
  }
  // Hidden, not disabled: a provider without an archive will never grow one at
  // runtime, so there is nothing for the user to wait for. (Disabled is for
  // "momentarily unavailable", which is what the running-session case below is.)
  // Cursor is why this exists — ACP has no archive method, so the action used to
  // report success and hand the session back on the very next list.
  //
  // `resolveActiveThread` misses the active session when history has not loaded
  // or pagination left it out, so fall back to the snapshot's own provider
  // before giving up. An unresolved provider leaves the action ALONE rather than
  // hiding it: this decides whether a control exists, and guessing "no" would
  // make a working Codex archive vanish on a slow list.
  const contextProvider =
    contextThread?.provider || (isActive ? state.session?.provider : "") || "";
  archiveThreadButton.hidden =
    Boolean(contextProvider)
    && !providerSupportsArchive({
      provider: contextProvider,
      capabilities: state.session?.provider_archive_capabilities || [],
    });
  archiveThreadButton.disabled = isRunningActiveSession;
  archiveThreadButton.textContent = isRunningActiveSession
    ? "Running session cannot be archived"
    : "Archive session";
  // Relay-owned metadata, like rename — works mid-turn, so no busy gate. A batch
  // still disables it below (like rename/fork/archive): it needs one session to
  // aim at, not whichever row happened to be right-clicked.
  if (flagThreadButton) {
    flagThreadButton.textContent = contextThread?.flagged ? "Unflag" : "Flag for follow-up";
  }
  // Delete is the ONLY action that takes a batch. Archive, fork, rename, and flag
  // each need one session to aim at, so a batch disables them rather than silently
  // applying to whichever row happened to be right-clicked.
  const isBatch = batchSize > 1;
  if (isBatch) {
    if (forkThreadButton) {
      forkThreadButton.disabled = true;
      forkThreadButton.textContent = "Fork session";
    }
    archiveThreadButton.disabled = true;
    archiveThreadButton.textContent = "Archive session";
    if (flagThreadButton) {
      flagThreadButton.textContent = "Flag for follow-up";
    }
  }
  // Assigned on EVERY open, not just batch ones: a right-click straight onto another
  // row opens the menu again without the document click handler that resets it (a
  // right-click fires no `click`), so a one-way disable here stays stuck. The Projects
  // flyout is in the same boat — it files ONE session, and firing it with three rows
  // highlighted would move only the row under the cursor.
  if (renameThreadButton) {
    renameThreadButton.disabled = isBatch;
  }
  if (flagThreadButton) {
    flagThreadButton.disabled = isBatch;
  }
  if (threadProjectSubmenuTrigger) {
    threadProjectSubmenuTrigger.disabled = isBatch;
  }
  // The running check has to cover EVERY target, not just the row under the cursor:
  // the relay rejects a running session, and finding that out halfway through a batch
  // means a partial delete the user never agreed to.
  const busyTargets = isBatch
    ? targets.threadIds.filter((id) => threadIsBusy(resolveActiveThread(id))).length
    : 0;
  const deleteBlocked = isBatch ? busyTargets > 0 : isRunningActiveSession;
  deleteThreadButton.disabled = deleteBlocked;
  deleteThreadButton.textContent = !deleteBlocked
    ? isBatch
      ? `Delete ${batchSize} sessions permanently`
      : "Delete permanently"
    : isBatch
      ? `${busyTargets} of ${batchSize} are running and cannot be deleted`
      : "Running session cannot be deleted";
  // Per-session Project assignment — rebuilt from the current Projects payload each
  // open so the marked "current" project and the list stay fresh. Populate and place
  // go through the same entry point the projects-store subscriber uses, so an open
  // and a mid-open refresh can't drift apart: the menu is measured AFTER its
  // variable-height content lands, and a row near the bottom of a long list opens
  // the menu upward instead of off the bottom edge.
  // Every open starts at the first level: the flyout is opt-in, not left open from a
  // previous right-click (and closing it first keeps it from being placed against the
  // menu's pre-move box).
  closeThreadProjectSubmenu();
  refreshThreadContextMenuContent({ clientX, clientY }, threadId);

  // Re-render the thread list so the `is-context-target` highlight lands via
  // React (driven by the store's context-menu target we just set). Opening the
  // menu is otherwise a store-only mutation with no subscriber, so without this
  // the class would only appear on the NEXT incidental render (an SSE/activity
  // tick or the 12s poll). Painting it imperatively here instead is fragile: any
  // React re-render in that window recomputes the row className from frozen props
  // (contextMenuThreadId=null) and strips it — the flake the delete-thread e2e hit.
  renderThreads();
}

// `rerender` re-renders the thread list so React drops the `is-context-target`
// highlight (mirrors openThreadContextMenu). Callers that are already inside
// renderThreads() — or that render their own thread-list content immediately
// after — pass `{ rerender: false }` to avoid a redundant/re-entrant render.
function closeThreadContextMenu({ rerender = true } = {}) {
  // Only worth a re-render if a menu was actually open — Escape/blur/resize call
  // this unconditionally, and we don't want to re-render the thread list on every
  // one of those when there's no highlight to clear.
  const wasOpen = readThreadListContextMenu(state.threadListStore).threadId != null;
  state.threadListStore.getState().closeContextMenu();
  // The batch belongs to the menu that is going away. Leaving it behind lets a later
  // action read targets that were resolved against a selection nobody can see.
  state.contextMenuThreadIds = [];
  if (threadContextMenu) {
    threadContextMenu.hidden = true;
  }
  closeThreadProjectSubmenu(); // the flyout lives outside the menu element — hide it too
  if (forkThreadButton) {
    forkThreadButton.disabled = false;
    forkThreadButton.textContent = "Fork session";
  }
  if (archiveThreadButton) {
    archiveThreadButton.disabled = false;
    archiveThreadButton.textContent = "Archive session";
  }
  if (flagThreadButton) {
    flagThreadButton.textContent = "Flag for follow-up";
  }
  if (deleteThreadButton) {
    deleteThreadButton.disabled = false;
    deleteThreadButton.textContent = "Delete permanently";
  }
  // All three are only ever disabled for a batch (see openThreadContextMenu), and a
  // menu that closed while disabled would reopen on a single row still greyed out.
  if (renameThreadButton) {
    renameThreadButton.disabled = false;
  }
  if (flagThreadButton) {
    flagThreadButton.disabled = false;
  }
  if (threadProjectSubmenuTrigger) {
    threadProjectSubmenuTrigger.disabled = false;
  }
  if (rerender && wasOpen) {
    renderThreads();
  }
}

async function reviewerThreadsForDestructiveAction() {
  if (reviewsCache.hasData()) {
    return reviewsCache.current().reviewer_threads || [];
  }
  try {
    const reviews = await getReviews(apiFetch);
    return reviews?.reviewer_threads || [];
  } catch (_error) {
    // The backend still performs the authoritative reviewer cleanup. If this
    // read fails, continue without a client-side count prompt.
    return [];
  }
}

/**
 * Set or clear a session's user-chosen title. The single write path for every rename
 * entry point (tab strip inline editor, sidebar context menu).
 *
 * Optimistic: the local rows are patched before the request settles so the tab does not
 * flicker back to the agent's title for a round trip. The server's receipt is then
 * applied verbatim (it is the trimmed truth, and `null` when the rename was a reset),
 * and a failure re-renders from `state.threads` — which the catch leaves untouched by
 * reloading the list rather than trying to invert the patch.
 */
async function renameThreadById(threadId, rawName) {
  if (!threadId) {
    return;
  }
  const thread = findVisible(threadId);
  const next = normalizeThreadName(rawName);
  // Compare against the OVERRIDE, never the displayed title. Typing the agent's current
  // title on a session that has no override is a REAL action — it pins that title
  // against the agent's next re-derivation, which is the whole point of the feature.
  // Comparing against `name` would silently swallow exactly that request.
  if (!threadNameChanged(rawName, threadCustomName(thread))) {
    return;
  }

  // Re-looked-up every call, never captured: the `threads_revision` bump this rename
  // causes makes us refetch too, so the row object can be replaced between the
  // optimistic write and the receipt.
  const applyName = (value) => {
    // Every copy the user can see, not just the first match: while a search is open
    // the same session has a row in BOTH slices, and renaming only one leaves the
    // visible list showing the old title until the query is re-run.
    applyRenameToRow(
      (state.threads || []).find((entry) => entry.id === threadId),
      value
    );
    applyRenameToRow(findThreadInSearchResults(state.threadSearch, threadId), value);
    state.threadGroups = buildNavigationThreadGroups(state.threads);
    renderThreads();
    renderSessionTabs();
  };

  applyName(next);
  try {
    const receipt = await renameThread(apiFetch, threadId, next);
    // Trust the server: it trims, caps, and answers `null` for a reset.
    applyName(receipt?.name ?? null);
    logLine(
      receipt?.message
        || (next ? `Renamed session to "${next}".` : "Session name reset.")
    );
  } catch (error) {
    logLine(`Failed to rename session: ${error.message}`);
    // Re-read rather than un-patching: the optimistic write is not the only thing that
    // may have moved, and the list is cheap.
    await loadThreads("post-rename recovery");
  }
}

/**
 * Rename from the sidebar's right-click menu. A prompt rather than an inline editor:
 * the menu has already taken over the pointer, and this mirrors how renaming a Project
 * works from its own menu.
 */
async function renameThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();
  if (!threadId) {
    return;
  }
  const thread = resolveActiveThread(threadId);
  const current = threadNameDraft(thread, shortId(threadId));
  const answer = window.prompt(
    "Rename this session.\n\nLeave it blank to go back to the name the agent picked.",
    current
  );
  // Cancel (null) is not the same as an emptied box (""): only the latter is a reset.
  if (answer === null) {
    return;
  }
  await renameThreadById(threadId, answer);
}

/**
 * Set or clear a session's follow-up flag. Same optimistic-write-then-reconcile
 * shape as `renameThreadById`, minus the name-specific normalization a bare bool
 * has no use for.
 */
async function setThreadFlagById(threadId, flagged) {
  if (!threadId) {
    return;
  }
  const applyFlag = (value) => {
    const apply = (row) => {
      if (row) row.flagged = Boolean(value);
    };
    // Every copy the user can see, not just the first match — same reasoning as
    // renameThreadById's applyName: a search result and the resting list can both
    // hold a row for the same session.
    apply((state.threads || []).find((entry) => entry.id === threadId));
    apply(findThreadInSearchResults(state.threadSearch, threadId));
    state.threadGroups = buildNavigationThreadGroups(state.threads);
    renderThreads();
  };

  applyFlag(flagged);
  try {
    const receipt = await setThreadFlag(apiFetch, threadId, flagged);
    applyFlag(receipt?.flagged ?? flagged);
    logLine(receipt?.message || (flagged ? "Flagged for follow-up." : "Unflagged."));
  } catch (error) {
    logLine(`Failed to update flag: ${error.message}`);
    await loadThreads("post-flag recovery");
  }
}

async function toggleThreadFlagFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();
  if (!threadId) {
    return;
  }
  const thread = resolveActiveThread(threadId);
  await setThreadFlagById(threadId, !thread?.flagged);
}

async function archiveThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }

  const thread = resolveActiveThread(threadId);
  const wasViewed = state.viewThreadId === threadId;
  const fallbackThreadId = wasViewed ? findAdjacentThreadId(threadId) : null;
  const title = thread?.name || thread?.preview || shortId(threadId);
  if (!window.confirm(`Archive "${title}" from local history?`)) {
    return;
  }

  // If this thread is the parent of hidden reviewer thread(s), ask what to do with
  // them. Reviewer threads have no archived state of their own, so the choice is
  // delete vs keep-as-normal — same prompt as permanent delete. Default (OK) deletes
  // them; Cancel keeps them as normal threads.
  const reviewerCount = countReviewerThreadsForParent(
    await reviewerThreadsForDestructiveAction(),
    threadId
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `This conversation has ${reviewerCount} reviewer session${reviewerCount === 1 ? "" : "s"}.\n\n` +
        "OK: delete the reviewer session(s) too.\n" +
        "Cancel: keep them as normal sessions (they'll appear in your session list)."
    );
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
      method: "POST",
      ...reviewerChoiceRequestInit(deleteReviewers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to archive session");
    }

    state.threads = state.threads.filter((entry) => entry.id !== threadId);
    // ...and from the search results, which are a separate slice. Leaving it there
    // keeps a dead session on screen as a clickable row until the query changes.
    dropThreadFromSearchResults(threadId);
    // A tab pointing at a deleted session is dead — drop it before re-rendering.
    state.removedThreadIds.add(threadId);
    rememberRemovedThreadId(threadId);
    const removal = await sessionViewController.removeThread(threadId);
    if (
      wasViewed
      && !removal.next.location.threadId
      && fallbackThreadId
      && state.threads.some((entry) => entry.id === fallbackThreadId)
    ) {
      await sessionViewController.openThread(fallbackThreadId, {
        replace: true,
      });
    }
    state.threadGroups = buildNavigationThreadGroups(state.threads);
    renderThreads();
    await loadSession("post-archive refresh");
    await loadThreads("post-archive refresh");
    logLine(payload.data?.message || `Archived local session ${shortId(threadId)}.`);
  } catch (error) {
    // Both channels: the log for the record, a modal so the user sees it. A
    // refused archive leaves the row exactly where it was, which is
    // indistinguishable from the button doing nothing.
    reportDestructiveActionFailure({
      action: "archive",
      title,
      error,
      log: logLine,
      notify: (message) => window.alert(message),
    });
  }
}

function threadTitle(threadId) {
  const thread = resolveActiveThread(threadId);
  return thread?.name || thread?.preview || shortId(threadId);
}

// Delete several sessions in one confirmed action. The relay deletes one session per
// request, so this is a loop — run SEQUENTIALLY because each delete mutates the same
// session state on the far side, and because a failure halfway has to name which
// sessions actually went.
async function deleteThreadBatch(threadIds) {
  const confirmed = window.confirm(describeBulkDelete({ titles: threadIds.map(threadTitle) }));
  if (!confirmed) {
    return;
  }

  // Asked ONCE for the whole batch rather than once per session: a per-session prompt
  // would be a dialog storm, and the answer is a policy ("keep my reviewer sessions"),
  // not a per-row judgement.
  const reviewerThreads = await reviewerThreadsForDestructiveAction();
  const reviewerCount = threadIds.reduce(
    (total, id) => total + countReviewerThreadsForParent(reviewerThreads, id),
    0
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `These sessions have ${reviewerCount} reviewer session${reviewerCount === 1 ? "" : "s"} between them.\n\n` +
        "OK: delete the reviewer session(s) too.\n" +
        "Cancel: keep them as normal sessions (they'll appear in your session list)."
    );
  }

  const viewedThreadId = state.viewThreadId;
  const fallbackThreadId = threadIds.includes(viewedThreadId)
    ? state.threads.find((entry) => !threadIds.includes(entry.id))?.id || null
    : null;
  const deleted = [];
  const failures = [];
  const notes = [];
  // Whether `removeThread` already moved the view somewhere real. Only the viewed
  // session's own removal can, so this is the one whose answer is worth keeping.
  let viewedRemoval = null;

  for (const threadId of threadIds) {
    try {
      const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/delete`, {
        method: "POST",
        ...reviewerChoiceRequestInit(deleteReviewers),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "Failed to permanently delete session");
      }
      deleted.push(threadId);
      // The relay can succeed and still have something to say — a reviewer session it
      // could not delete comes back on an `ok` receipt, and dropping it leaves the user
      // watching sessions reappear with no reason given.
      if (payload.data?.message?.includes("reviewer")) {
        notes.push(payload.data.message);
      }
      state.threads = state.threads.filter((entry) => entry.id !== threadId);
      dropThreadFromSearchResults(threadId);
      state.removedThreadIds.add(threadId);
      rememberRemovedThreadId(threadId);
      const removal = await sessionViewController.removeThread(threadId);
      if (threadId === viewedThreadId) {
        viewedRemoval = removal;
      }
    } catch (error) {
      failures.push({ threadId, error });
    }
  }

  state.threadListStore.getState().clearThreadSelection();

  // Move the view only if the session being viewed was ACTUALLY deleted — a failed
  // delete leaves it on screen, and navigating away from it would look like the
  // delete worked. And only if `removeThread` did not already land on a real tab,
  // which is the check the single-delete path makes for the same reason.
  if (
    viewedRemoval
    && !viewedRemoval.next.location.threadId
    && fallbackThreadId
    && state.threads.some((entry) => entry.id === fallbackThreadId)
  ) {
    await sessionViewController.openThread(fallbackThreadId, { replace: true });
  }

  // One refresh for the whole batch, not one per session — the single-delete path
  // refreshes because it is the end of the action, and here that is only true now.
  state.threadGroups = buildNavigationThreadGroups(state.threads);
  renderThreads();
  await loadThreads("post-bulk-delete refresh");
  await loadSession("post-bulk-delete refresh");

  if (deleted.length) {
    logLine(`Deleted ${deleted.length} local session${deleted.length === 1 ? "" : "s"} permanently.`);
  }
  for (const note of notes) {
    logLine(note);
  }
  // Reported per failure, naming the session: "3 of 5 failed" tells the user something
  // went wrong but not what to retry, and the sessions that survived are still listed.
  for (const failure of failures) {
    reportDestructiveActionFailure({
      action: "delete",
      title: threadTitle(failure.threadId),
      error: failure.error,
      log: logLine,
      notify: (message) => window.alert(message),
    });
  }
}

async function deleteThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  // Resolved when the menu OPENED, over the selection as it stood then. Re-deriving
  // it here would read a selection the close below has already torn down.
  const batch = state.contextMenuThreadIds || [];
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }
  // The batch must still contain the row the menu was opened on, or it belongs to an
  // earlier menu and this is a plain single delete.
  if (batch.length > 1 && batch.includes(threadId)) {
    await deleteThreadBatch(batch);
    return;
  }

  const thread = resolveActiveThread(threadId);
  const wasViewed = state.viewThreadId === threadId;
  const fallbackThreadId = wasViewed ? findAdjacentThreadId(threadId) : null;
  const title = thread?.name || thread?.preview || shortId(threadId);
  // Name the thread's own provider — the old ternary mislabeled every
  // non-Claude provider (incl. future ones) as "Codex".
  const providerName = providerLabel(thread?.provider) || "agent";
  const confirmed = window.confirm(
    `Permanently delete "${title}" from local ${providerName} storage?\n\nThis removes the local session file and related local index/state entries. This cannot be undone.`
  );
  if (!confirmed) {
    return;
  }

  // If this thread is the parent of hidden reviewer thread(s), ask what to do with
  // them. Default (OK) deletes them too; Cancel keeps them as normal threads.
  const reviewerCount = countReviewerThreadsForParent(
    await reviewerThreadsForDestructiveAction(),
    threadId
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `This conversation has ${reviewerCount} reviewer session${reviewerCount === 1 ? "" : "s"}.\n\n` +
        "OK: delete the reviewer session(s) too.\n" +
        "Cancel: keep them as normal sessions (they'll appear in your session list)."
    );
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/delete`, {
      method: "POST",
      ...reviewerChoiceRequestInit(deleteReviewers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to permanently delete session");
    }

    state.threads = state.threads.filter((entry) => entry.id !== threadId);
    // A single delete can still land on a row the user had selected — drop the dead
    // id, or the next right-click builds its batch around a session that is gone.
    state.threadListStore
      .getState()
      .setThreadSelection(
        pruneThreadSelection(
          readThreadSelection(state.threadListStore),
          state.threads.map((entry) => entry.id)
        )
      );
    // ...and from the search results, which are a separate slice. Leaving it there
    // keeps a dead session on screen as a clickable row until the query changes.
    dropThreadFromSearchResults(threadId);
    // A tab pointing at a deleted session is dead — drop it before re-rendering.
    state.removedThreadIds.add(threadId);
    rememberRemovedThreadId(threadId);
    const removal = await sessionViewController.removeThread(threadId);
    if (
      wasViewed
      && !removal.next.location.threadId
      && fallbackThreadId
      && state.threads.some((entry) => entry.id === fallbackThreadId)
    ) {
      await sessionViewController.openThread(fallbackThreadId, {
        replace: true,
      });
    }
    state.threadGroups = buildNavigationThreadGroups(state.threads);
    renderThreads();
    await loadThreads("post-delete refresh");
    await loadSession("post-delete refresh");
    logLine(payload.data?.message || `Deleted local session ${shortId(threadId)} permanently.`);
  } catch (error) {
    // See the archive path above. This matters more now that delete really
    // deletes: it has genuine failure modes (directory already gone, a
    // permissions error, a session held by a running turn) where it previously
    // had exactly one, constant, one.
    reportDestructiveActionFailure({
      action: "delete",
      title,
      error,
      log: logLine,
      notify: (message) => window.alert(message),
    });
  }
}

function findAdjacentThreadId(threadId) {
  const index = state.threads.findIndex((entry) => entry.id === threadId);
  if (index === -1) {
    return state.threads.find((entry) => entry.id !== threadId)?.id || null;
  }
  return (
    state.threads[index + 1]?.id
    || state.threads[index - 1]?.id
    || state.threads.find((entry) => entry.id !== threadId)?.id
    || null
  );
}

function metaChip(label, value) {
  return `
    <span class="meta-chip">
      <strong>${escapeHtml(label)}:</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function overviewBadge(label, value) {
  return `
    <span class="overview-badge">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function sessionStatusLabel(session, approval) {
  if (approval) {
    return "Approval required";
  }

  if (!session?.provider_connected) {
    return "Offline";
  }

  if (!session?.active_thread_id) {
    return "Standby";
  }

  return "Live";
}

function securityModeLabel(session) {
  if (session?.security_mode === "managed") {
    return "Managed policy";
  }
  return "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Broker-readable with audit" : "Broker-readable";
  }
  return session?.e2ee_enabled ? "End-to-end encrypted" : "Broker cannot read content";
}

function brokerStatusLabel(session) {
  if (!session?.broker_channel_id) {
    return "Disabled";
  }

  const state = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${state} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${state} · ${channel}`;
}

function pairedDeviceCountLabel(session) {
  const count = approvedDeviceCount(session);
  return count === 0 ? "None" : `${count} paired`;
}

function approvedDeviceCount(session) {
  if (Array.isArray(session?.paired_devices)) {
    return session.paired_devices.length;
  }

  if (!Array.isArray(session?.device_records)) {
    return 0;
  }

  return session.device_records.filter((record) => record.lifecycle_state === "approved").length;
}

function formatTimestamp(seconds) {
  if (!seconds) {
    return "unknown";
  }

  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(seconds) {
  if (!seconds) {
    return "now";
  }

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(seconds));
  if (diffSeconds < 60) {
    return "now";
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h`;
  }
  if (diffSeconds < 604800) {
    return `${Math.floor(diffSeconds / 86400)}d`;
  }
  if (diffSeconds < 2592000) {
    return `${Math.floor(diffSeconds / 604800)}w`;
  }
  if (diffSeconds < 31536000) {
    return `${Math.floor(diffSeconds / 2592000)}mo`;
  }
  return `${Math.floor(diffSeconds / 31536000)}y`;
}

function humanizeLabel(value) {
  return String(value)
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
    text.includes("approved") ||
    text.includes("accepted") ||
    text.includes("started") ||
    text.includes("resumed") ||
    text.includes("connected") ||
    text.includes("saved")
  ) {
    return "ready";
  }

  return "neutral";
}

function isCurrentDeviceActiveController(session) {
  if (!session?.active_thread_id || !session.active_controller_device_id) {
    return false;
  }

  return session.active_controller_device_id === state.deviceId;
}

function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return !session.active_controller_device_id || session.active_controller_device_id === state.deviceId;
}

function sessionControllerState(session) {
  if (!session?.active_thread_id) {
    return "none";
  }

  if (!session.active_controller_device_id) {
    return "unclaimed";
  }

  return session.active_controller_device_id === state.deviceId ? "this_device" : "other_device";
}

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function controllerStateLabel(session) {
  if (session?.view_only) {
    return "View only";
  }
  if (session?.active_thread_id && !session.active_turn_id) {
    return "Available";
  }
  switch (sessionControllerState(session)) {
    case "this_device":
      return "This device";
    case "other_device":
      return controllerLabel(session.active_controller_device_id);
    case "unclaimed":
      return "Unclaimed";
    default:
      return "None";
  }
}

function readThreadIdFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("thread") || null;
}

function setThreadRoute(threadId, options = {}) {
  const context = options.context || sessionViewStore.getState().location.context;
  if (threadId) {
    return sessionViewController.openThread(threadId, {
      context,
      replace: Boolean(options.replace),
      // Tri-state, forwarded rather than defaulted: `true` peeks, `false` keeps,
      // and undefined (every route that isn't a sidebar gesture) opens a kept tab
      // without re-flagging one that is already open.
      preview: options.preview,
    });
  }
  return sessionViewController.showOverview(context, {
    replace: Boolean(options.replace),
  });
}

function clearThreadRoute(options = {}) {
  return setThreadRoute(null, options);
}

function isViewingConversation(session) {
  return Boolean(session?.active_thread_id && state.viewThreadId === session.active_thread_id);
}

function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

function shortId(value) {
  return value ? value.slice(0, 8) : "unknown";
}

function loadOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.()
    ? window.crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
  return generated;
}

function loadApiToken() {
  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() || "";
}

function clearStoredApiToken() {
  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
}

function logLine(message) {
  state.clientLogLines = [{ at: Date.now(), text: message }, ...state.clientLogLines].slice(0, 400);
  renderClientLog();
}

// Refresh the relay's server logs from a session snapshot. Replaces (rather than
// appends) so repeated snapshots don't duplicate, and re-renders the merged view
// WITHOUT discarding client-originated lines (e.g. "Prompt failed: ...").
function ingestRelayLogs(entries) {
  state.relayLogLines = mapRelayLogEntries(entries);
  renderClientLog();
}

// Merge client + server log entries into the single #client-log surface, newest
// first. Server-log refreshes and client status lines previously clobbered each
// other (last writer won); merging keeps both visible. The merge/cap logic lives
// in client-log-merge.js (unit-tested); only the locale-dependent timestamp
// formatting stays here.
function renderClientLog() {
  const combined = mergeLogEntries(state.clientLogLines, state.relayLogLines).map(
    (entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.text}`
  );
  renderClientLogLines(combined);
}

function renderClientLogLines(lines) {
  if (!clientLogRoot) {
    return;
  }

  if (clientLogRootElement !== clientLogRoot) {
    clientLogRootHandle?.unmount();
    clientLogRootHandle = createRoot(clientLogRoot);
    clientLogRootElement = clientLogRoot;
  }

  flushSync(() => {
    clientLogRootHandle.render(React.createElement(ClientLog, { lines }));
  });
}

// ── Session tabs ────────────────────────────────────────────────────────────
// The strip lives in the static shell, so like #client-log-root it needs its own
// React sub-root to be data-driven. Tabs are scoped to the active project; with no
// project selected they fall back to a shared bucket so Sessions mode keeps tabs.
//
// Focusing a tab goes through `viewThread`, the view-only path. It must NOT call
// resume_session, which moves the relay's single active thread for EVERY connected
// client — a tab is a per-client view, not a claim on the relay.

// The Project switcher above the tab strip. Its own sub-root for the same reason
// the strip has one: the shell renders once, so anything data-driven needs its own.
// `label`/`labelTooltip` come from render-session's headerLabels — the switcher is
// the header title, so its text is that module's decision, not this one's. The
// last labels are remembered because navigation and Projects-store changes also
// re-render this control, and they have no opinion about the title.
let lastSwitcherLabels = { label: "", labelTooltip: "" };
// Its own sub-root, like renderProjectSwitcher: the shell renders once, so
// anything whose props change needs a root that can re-render.
function renderLaunchSessionDialog() {
  const mount = document.getElementById("launch-dialog-root");
  if (!mount) {
    return;
  }
  if (launchDialogRootElement !== mount) {
    launchDialogRootHandle?.unmount();
    launchDialogRootHandle = createRoot(mount);
    launchDialogRootElement = mount;
  }

  const draft = readLocalUiState(state.localUiStore).sessionDraft || {};
  const provider = draft.provider || defaultProvider(state.providers);
  const models = state.providerModels[provider] || [];
  const model = draft.model || defaultModelForProvider(provider);

  launchDialogRootHandle.render(
    React.createElement(StartSessionDialog, {
      approvalOptions: providerSettings(provider).approvalOptions,
      effortOptions: buildReasoningEffortOptions(models, model, provider),
      fields: {
        ...draft,
        cwd: draft.cwd || state.selectedCwd || state.session?.current_cwd || "",
        model,
        provider,
      },
      gitContext: state.launchGitContext,
      id: "launch-start-session-dialog",
      initialPromptAttachmentsId: "start-prompt-attachments",
      onCreateProject() {
        const opening = state.launchDialogGeneration;
        void createProjectForLaunchDraft(
          (projectId) => handleLaunchFieldInput("projectId", projectId),
          () =>
            state.launchDialogGeneration === opening
            && document.getElementById("launch-start-session-dialog")?.open === true
        );
      },
      onFieldChange: handleLaunchFieldInput,
      onSelectModel: handleLaunchModelSelection,
      onRequestClose() {
        clearNewSessionImageAttachments();
      },
      onStart() {
        void submitStartSession();
      },
      projects: state.projects || [],
      providerModels: state.providerModels,
      providers: state.providers || [],
      // Matches remote: Claude supports deferred start, so an empty prompt is
      // allowed and the relay promotes the session on the first message.
      requireInitialPrompt: false,
      startPending: Boolean(state.newSessionSubmitInFlight),
      threadProjectId: state.threadProjectId || {},
      threads: state.threads || [],
      workspaceSuggestions: selectWorkspaceSuggestionsModel({
        selectedCwd: state.selectedCwd || "",
        session: state.session,
        threads: state.threads || [],
      }),
    })
  );
}

// The dialog is controlled, so anything arriving asynchronously (catalogues,
// projects, the pending flag) is invisible until something re-renders it.
function renderLaunchSessionDialogIfOpen() {
  if (document.getElementById("launch-start-session-dialog")?.open) {
    renderLaunchSessionDialog();
  }
}

function renderProjectSwitcher(labels = null) {
  if (labels) {
    lastSwitcherLabels = labels;
  }
  const mount = document.getElementById("project-switcher-mount");
  if (!mount) {
    return;
  }

  if (projectSwitcherRootElement !== mount) {
    projectSwitcherRootHandle?.unmount();
    projectSwitcherRootHandle = createRoot(mount);
    projectSwitcherRootElement = mount;
  }

  const context = sessionViewStore.getState().location.context;
  projectSwitcherRootHandle.render(
    React.createElement(ProjectSwitcher, {
      activeProjectId: context?.kind === "project" ? context.projectId : null,
      label: lastSwitcherLabels.label,
      labelTooltip: lastSwitcherLabels.labelTooltip,
      projects: state.projects || [],
      titleId: "workspace-title",
      onCreateProject() {
        void createProjectFromToolbar();
      },
      onSelectProject(projectId) {
        // Straight through the session-view controller, which is what makes the
        // switcher swap TAB SETS as well as the pinned group: each context owns its
        // own workspace of tabs and its own remembered focus. `switchContext`
        // restores where you were in that project; picking "All sessions" returns to
        // the sessions context, not to a project-less limbo.
        void sessionViewController.switchContext(
          projectId ? { kind: "project", projectId } : { kind: "sessions" }
        );
      },
    })
  );
}

function resolveTabThread(threadId) {
  const thread = findVisible(threadId);
  if (!thread) {
    // A tab can outlive its thread (deleted elsewhere, or a stale stored
    // workspace); label it rather than rendering a blank tab.
    return { title: shortId(threadId), tooltip: threadId };
  }
  return {
    title: thread.name || thread.preview || shortId(thread.id),
    tooltip: thread.cwd || thread.name || thread.id,
    // Drives the tab's idle mark. Read off the THREAD, not the live session: a
    // strip can hold tabs from several providers at once.
    provider: thread.provider || "",
  };
}

function openStartSessionDialog({ projectId = undefined } = {}) {
  state.launchDialogGeneration += 1;
  // At open time, not per render: re-seeding per render would overwrite a choice
  // made inside the dialog.
  const context = sessionViewStore.getState().location.context;
  const seeded =
    projectId !== undefined
      ? projectId
      : context?.kind === "project"
        ? context.projectId
        : null;
  const ui = state.localUiStore.getState();
  ui.setSessionDraftField("projectId", seeded || null);
  // Submit reads the draft, so a render-time-only fallback would post empty.
  const draft = readLocalUiState(state.localUiStore).sessionDraft || {};
  if (!draft.cwd) {
    ui.setSessionDraftField(
      "cwd",
      state.selectedCwd || state.session?.current_cwd || ""
    );
  }
  // Repaired, not just filled when empty: the draft defaults to "codex", which a
  // relay that does not run Codex would reject at start.
  const available = state.providers || [];
  const provider =
    draft.provider && available.includes(draft.provider)
      ? draft.provider
      : defaultProvider(available);
  if (provider !== draft.provider) {
    ui.setSessionDraftField("provider", provider);
    // The model belonged to the provider just replaced.
    ui.setSessionDraftField("model", defaultModelForProvider(provider));
  } else if (!draft.model) {
    ui.setSessionDraftField("model", defaultModelForProvider(provider));
  }
  void refreshLaunchGitContext(
    readLocalUiState(state.localUiStore).sessionDraft?.cwd || ""
  );
  // Fresh attachment draft per opening: a dismissed paste must not follow the
  // user into an unrelated workspace.
  clearNewSessionImageAttachments();
  // flushSync because showModal() below needs the element to exist: createRoot's
  // render is async, so the first open found nothing and failed silently.
  flushSync(() => renderLaunchSessionDialog());
  // The mount only exists once the dialog has rendered.
  renderNewSessionImageAttachments();
  // showModal(), not setAttribute("open"): only a modal dialog gets `::backdrop`
  // and the Escape close-request the pickers inside it cooperate with.
  document.getElementById("launch-start-session-dialog")?.showModal();
}

// The sidebar's primary action. It lives in a mount rather than in react-shell.js because
// its right half lists the AVAILABLE agents, and that catalogue is fetched after boot —
// the shell renders once and could only ever hand it an empty array.
function renderStartSessionSplit() {
  const mount = document.getElementById("start-session-split-mount");
  if (!mount) {
    return;
  }

  if (startSessionSplitRootElement !== mount) {
    startSessionSplitRootHandle?.unmount();
    startSessionSplitRootHandle = createRoot(mount);
    startSessionSplitRootElement = mount;
  }

  startSessionSplitRootHandle.render(
    React.createElement(StartSessionSplitButton, {
      buttonId: "open-start-session-dialog",
      menuId: "start-session-agent-menu",
      providerOptions: providerOptions(state.providers || []),
      activeProvider: readLocalUiState(state.localUiStore).sessionDraft?.provider || "",
      onStart: () => openStartSessionDialog(),
      onStartWithProvider: (provider) => {
        // The same atomic handler the Model pill uses, so effort is re-resolved
        // against the new model rather than carried over.
        handleLaunchModelSelection({
          model: defaultModelForProviderCatalog(provider),
          provider,
        });
        openStartSessionDialog();
      },
    })
  );
}

function renderSessionTabs() {
  const mount = document.getElementById("session-tab-strip-mount");
  if (!mount) {
    return;
  }

  if (sessionTabsRootElement !== mount) {
    sessionTabsRootHandle?.unmount();
    sessionTabsRootHandle = createRoot(mount);
    sessionTabsRootElement = mount;
  }

  const viewState = sessionViewStore.getState();
  const context = viewState.location.context;
  const workspace =
    viewState.workspaces[sessionViewContextKey(context)] || {
      tabs: [],
      focusedTabId: null,
    };
  const items = buildSessionTabItems({
    workspace,
    layoutThreadIds,
    resolveThread: resolveTabThread,
    threadActivity: buildThreadActivityMap(state.session),
    threadAttention: threadAttention.snapshotMap(),
    threadReviewing: buildReviewingThreadSet(state.session, reviewsCache.current()),
  });

  sessionTabsRootHandle.render(
    React.createElement(SessionTabStrip, {
      items,
      // The highlight means "this session is on screen", and the ONLY thing that puts
      // a session on screen is the view route: with no `?thread=` the renderer shows
      // the console home or a project overview, not the active conversation — home
      // even offers an explicit "Open live conversation" button (render-session.js).
      //
      // So no fallbacks here. Falling back to `workspace.focusedTabId` let a tab claim
      // focus while the main area showed something else; falling back to
      // `active_thread_id` did the same on Home and in a project overview.
      focusedTabId: items.find((item) => item.threadId === state.viewThreadId)?.tabId || null,
      onFocus(tabId) {
        const item = items.find((entry) => entry.tabId === tabId);
        if (item?.threadId) {
          // No view transition, for the same reason a sidebar peek skips it: a
          // running transition swallows the SECOND click of a double click, so
          // animating tab focus would quietly break double-click-to-keep on the
          // strip. Switching tabs wants a cut anyway — browser tabs don't
          // cross-fade either. No `preview` flag: focusing a tab must leave it
          // exactly as kept or as disposable as it already was.
          void viewThreadById(item.threadId, { transition: false });
        }
      },
      onClose(tabId) {
        void sessionViewController.closeTab(tabId, { context });
      },
      onPromote(tabId) {
        void sessionViewController.promoteTab(tabId, { context });
      },
      onTogglePin(tabId, pinned) {
        void sessionViewController.pinTab(tabId, pinned, { context });
      },
      onMove(tabId, toIndex) {
        void sessionViewController.moveTab(tabId, toIndex, { context });
      },
      onRename(threadId, name) {
        void renameThreadById(threadId, name);
      },
      emptyMessage: "No open sessions. Pick one from the sidebar.",
    })
  );
}

/**
 * View-only navigation: update the URL/viewThreadId WITHOUT calling the backend
 * resume_session, which is mutating (it moves the relay's single active thread for
 * EVERY connected client). Any non-active thread renders from the client-local pin;
 * an idle viewed thread can be sent to directly.
 *
 * Module-level so every entry point shares it — the sidebar row handler and the tab
 * strip previously each carried their own copy of this body.
 */
async function viewThreadById(
  threadId,
  { transition = true, replace = false, context = null, preview = undefined } = {}
) {
  // `context` lets a caller open a session INTO a specific context in one command —
  // the Projects sidebar needs it, because clicking a session nested under project P
  // must land in P's tab set even when another project is currently selected. Doing it
  // as one dispatch keeps state and history ordered; selecting then opening would be two.
  const update = () => setThreadRoute(threadId, { replace, context, preview });
  if (transition) {
    await runViewTransition(update);
  } else {
    await update();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
