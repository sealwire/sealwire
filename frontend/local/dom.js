export const appShell = document.querySelector(".app-shell");
export const transcript = document.querySelector("#transcript");
export const connectionForm = document.querySelector("#connection-form");
export const apiTokenLabel = connectionForm.querySelector("label[for='api-token-input']");
export const apiTokenInput = document.querySelector("#api-token-input");
export const applyTokenButton = document.querySelector("#apply-token-button");
export const settingsModal = document.querySelector("#settings-modal");
export const settingsRoot = document.querySelector("#settings-root");
export const iconRailSettingsButton = document.querySelector("#icon-rail-settings");
export const sidebarHostStatus = document.querySelector("#sidebar-host-status");
export const sidebarHostLabel = document.querySelector("#sidebar-host-label");
export const pairingApprovalModal = document.querySelector("#pairing-approval-modal");
export const closePairingApprovalModalBtn = document.querySelector("#close-pairing-approval-modal");
export const pairingApprovalList = document.querySelector("#pairing-approval-list");
export const pairingApprovalHint = document.querySelector("#pairing-approval-hint");
export const threadsRefreshButton = document.querySelector("#threads-refresh-button");
export const sessionHistoryDrawer = document.querySelector(".sidebar-drawer");
export const sendButton = document.querySelector("#send-button");
export const stopButton = document.querySelector("#stop-button");
export const messageForm = document.querySelector("#message-form");
export const messageInput = document.querySelector("#message-input");
export const composerAttachments = document.querySelector("#composer-attachments");
export const composerCommandMount = document.querySelector("#composer-command-mount");
export const composerQuoteMount = document.querySelector("#composer-quote-mount");
export const composerError = document.querySelector("#composer-error");
export const composerHeld = document.querySelector("#composer-held");
export const messageModel = document.querySelector("#message-model");
export const messageEffort = document.querySelector("#message-effort");
export const directoryForm = document.querySelector("#directory-form");
export const loadDirectoryButton = document.querySelector("#load-directory-button");
export const startSessionButton = document.querySelector("#start-session-button");
export const openLaunchSettingsButton = document.querySelector("#open-launch-settings");
export const launchSettingsModal = document.querySelector("#launch-settings-modal");
export const closeLaunchSettingsModalButton = document.querySelector("#close-launch-settings-modal");
// Not queried here: the dialog renders on demand, so an import-time query would
// capture null forever. Callers use getElementById when they need it.
export const cwdInput = document.querySelector("#cwd-input");
export const startPromptInput = document.querySelector("#start-prompt");
// Not queried here either, for the same reason as the dialog above.
export const providerInput = document.querySelector("#provider-input");
export const modelInput = document.querySelector("#model-input");
export const modelInputLabel = document.querySelector("#model-input-label");
export const approvalPolicyInput = document.querySelector("#approval-policy-input");
export const sandboxInput = document.querySelector("#sandbox-input");
export const startEffortInput = document.querySelector("#start-effort");
export const startEffortLabel = document.querySelector("#start-effort-label");
export const threadsList = document.querySelector("#threads-list");
export const threadsCount = document.querySelector("#threads-count");
export const projectOverviewMount = document.querySelector("#project-overview");
export const taskTeamMount = document.querySelector("#task-team");
export const teamsLibraryMount = document.querySelector("#teams-library");
export const reviewScreenMount = document.querySelector("#review-screen");
export const ticketScreenMount = document.querySelector("#ticket-screen");
export const usageReportMount = document.querySelector("#usage-report");
// The sidebar's destinations, in both forms, are one shared prop-driven component
// (shared/sidebar-nav.js) rendered into these two mounts. That replaced SIX handles —
// a Sessions button, a Tasks button and a count badge in the sidebar, plus a Sessions
// button, a Tasks button and a dot on the rail — with two, and took the "you are here"
// state off `[data-view]` CSS and an imperative `aria-current` write at the same time.
export const sidebarNavMount = document.querySelector("#sidebar-nav");
export const iconRailNavMount = document.querySelector("#icon-rail-nav");
// The search + bell toggles, and the search FIELD. Two mounts in place of five
// `getElementById` calls in app.js — and, more to the point, in place of the rule that
// made the field always-mounted-and-hidden. A mount is a container the shell always
// renders; the CONTROL inside it is free to be absent, which is what a hidden node could
// never be.
export const sidebarTopActionsMount = document.querySelector("#sidebar-top-actions");
export const sidebarSearchMount = document.querySelector("#sidebar-search-mount");
export const sidebarTaskListMount = document.querySelector("#sidebar-task-list");
export const sidebarTeamsListMount = document.querySelector("#sidebar-teams-list");
export const startTaskDialogMount = document.querySelector("#start-task-dialog-mount");
export const threadContextMenu = document.querySelector("#thread-context-menu");
export const forkThreadButton = document.querySelector("#fork-thread-button");
export const archiveThreadButton = document.querySelector("#archive-thread-button");
export const renameThreadButton = document.querySelector("#rename-thread-button");
export const flagThreadButton = document.querySelector("#flag-thread-button");
export const deleteThreadButton = document.querySelector("#delete-thread-button");
export const threadContextMenuItems = document.querySelector("#thread-context-menu-items");
export const threadMenuConfirm = document.querySelector("#thread-menu-confirm");
export const threadMenuConfirmTitle = document.querySelector("#thread-menu-confirm-title");
export const threadMenuConfirmBody = document.querySelector("#thread-menu-confirm-body");
export const threadMenuConfirmCancel = document.querySelector("#thread-menu-confirm-cancel");
export const threadMenuConfirmOk = document.querySelector("#thread-menu-confirm-ok");
export const threadProjectFilter = document.querySelector("#thread-project-filter");
export const threadProjectFilterInput = document.querySelector("#thread-project-filter-input");
export const threadProjectActions = document.querySelector("#thread-project-actions");
export const threadProjectSubmenu = document.querySelector("#thread-project-submenu");
export const threadProjectSubmenuTrigger = document.querySelector("#thread-project-submenu-trigger");
export const threadProjectCurrentLabel = document.querySelector("#thread-project-current-label");
export const forkSessionDialogRoot = document.querySelector("#fork-session-dialog-root");
export const chatShell = document.querySelector(".chat-shell");
export const workspaceSubtitle = document.querySelector("#workspace-subtitle");
export const workspaceSuggestionsList = document.querySelector("#workspace-suggestions");
export const localModelBadge = document.querySelector("#local-model-badge");
export const statusBadge = document.querySelector("#status-badge");
export const goConsoleHomeButton = document.querySelector("#go-console-home");
export const openSessionDetailsButton = document.querySelector("#open-session-details");
export const sessionDetailsModal = document.querySelector("#session-details-modal");
export const closeSessionDetailsModalButton = document.querySelector("#close-session-details-modal");
export const sessionMeta = document.querySelector("#session-meta");
export const workspaceDiffModal = document.querySelector("#workspace-diff-modal");
export const closeWorkspaceDiffModalButton = document.querySelector("#close-workspace-diff-modal");
export const workspaceDiffTitleMount = document.querySelector("#workspace-diff-title");
export const workspaceDiffMount = document.querySelector("#workspace-diff-mount");
export const workspaceChangesRail = document.querySelector("#workspace-changes-rail");
export const workspaceChangesMount = document.querySelector("#workspace-changes-mount");
export const workspaceDiffChipMount = document.querySelector("#workspace-diff-chip-mount");
export const reviewerChipMount = document.querySelector("#reviewer-chip-mount");
export const sidebarElement = document.querySelector(".sidebar");
export const sidebarResizeHandle = document.querySelector("#sidebar-resize");
export const rightRailResizeHandle = document.querySelector("#right-rail-resize");
export const toggleLeftPanelButton = document.querySelector("#toggle-left-panel");
export const toggleRightPanelButton = document.querySelector("#toggle-right-panel");
export const sidebarTopToggleButton = document.querySelector("#sidebar-top-toggle");
export const railTopToggleButton = document.querySelector("#rail-top-toggle");
export const newSessionComposeButton = document.querySelector("#new-session-compose-button");
export const sessionDetailsPath = document.querySelector("#session-details-path");
export const overviewSecurityBadges = document.querySelector("#overview-security-badges");
export const controlBanner = document.querySelector("#control-banner");
export const composerSettingsMount = document.querySelector("#composer-settings-mount");
export const controlSummary = document.querySelector("#control-summary");
export const controlHint = document.querySelector("#control-hint");
export const takeOverButton = document.querySelector("#take-over-button");
export const pendingActionBanner = document.querySelector("#pending-action-banner");
export const agentWorkingIndicator = document.querySelector("#agent-working-indicator");
export const agentWorkingIndicatorLabel = document.querySelector("#agent-working-indicator-label");
export const reviewIdleNudge = document.querySelector("#review-idle-nudge");
