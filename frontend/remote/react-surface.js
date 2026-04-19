import {
  selectDeviceChromeRenderModel,
  selectResetChromeRenderModel,
  selectSessionChromeRenderModel,
  selectStatusBadgeRenderModel,
} from "./chrome-view-model.js";
import {
  debugScrollEvent,
  renderTranscriptPanel,
} from "./components/transcript-panel.js";
import { deriveSessionRuntime } from "./session-runtime.js";
import { renderLogs } from "./render-transcript.js";
import { readRemoteState, subscribeRemoteState } from "./state.js";
import {
  selectEmptyStateRenderModel,
  selectRelayDirectoryRenderModel,
  selectSessionRenderModel,
  selectThreadsRenderModel,
} from "./view-model.js";
import {
  renderComposerUi,
  renderDeviceChromeUi,
  renderMissingCredentialsUi,
  renderRelayDirectoryUi,
  renderRelayHomeUi,
  renderResetChromeUi,
  renderSessionChromeUi,
  renderStatusBadgeUi,
  renderThreadListUi,
  renderTranscriptEmptyUi,
  syncConversationLayoutUi,
  syncIdleSurfaceControlsUi,
  syncRelayDirectoryChromeUi,
  syncRemoteModelSuggestionsUi,
  syncSessionDraftUi,
  syncSessionStartUi,
  syncThreadRefreshUi,
  syncThreadListChromeUi,
} from "./ui-renderer.js";

let mounted = false;
let unsubscribeRemoteState = null;
let lastRenderedSession = null;
let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRemoteReactSurfaceHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
}

export function mountRemoteReactSurface() {
  if (mounted) {
    return;
  }

  mounted = true;
  unsubscribeRemoteState = subscribeRemoteState(() => {
    renderRemoteReactSurface();
  });
  renderRemoteReactSurface();
}

export function unmountRemoteReactSurface() {
  if (!mounted) {
    return;
  }

  unsubscribeRemoteState?.();
  unsubscribeRemoteState = null;
  mounted = false;
}

export function renderRemoteReactSurface() {
  renderRemoteReactSurfaceSnapshot(readRemoteState());
}

export function renderRemoteReactSurfaceSnapshot(currentState) {
  renderRelayDirectorySection(currentState);
  renderDeviceChromeUi(selectDeviceChromeRenderModel(currentState));

  if (currentState.session?.active_thread_id) {
    renderActiveSessionSurface(currentState);
  } else {
    renderIdleSurface(currentState);
  }

  renderThreadsSection(currentState);
  lastRenderedSession = currentState.session || null;
}

function renderActiveSessionSurface(currentState) {
  const session = currentState.session;
  const sessionView = selectSessionRenderModel({
    session,
    previousSession: lastRenderedSession,
    hasControllerLease: !session.active_controller_device_id
      || session.active_controller_device_id === currentState.remoteAuth?.deviceId,
  });
  const sessionRuntime = deriveSessionRuntime({
    composerDraft: currentState.composerDraft,
    composerEffort: currentState.composerEffort,
    sendPending: currentState.sendPending,
    session,
    sessionView,
    threadsFilterValue: currentState.threadsFilterValue,
  });

  syncConversationLayoutUi();
  syncThreadListChromeUi({
    threadsFilterHint: sessionRuntime.threadsFilterHint,
  });
  syncSessionDraftUi({
    fields: currentState.sessionDraft,
  });
  syncSessionStartUi({
    startDisabled: currentState.sessionStartPending,
  });
  renderComposerUi(sessionRuntime);
  syncRemoteModelSuggestionsUi({
    currentValue:
      session.model
      || currentState.sessionDraft.model
      || session.available_models?.find((model) => model.is_default)?.model
      || "gpt-5.4",
    models: session.available_models || [],
  });
  renderSessionChromeUi(selectSessionChromeRenderModel(currentState, session));
  renderTranscriptPanel(session, sessionView.approval, sessionView.canWrite, lastRenderedSession);
  renderLogs(session.logs || []);
  debugScrollEvent("renderSession", sessionView.scrollDebug);
}

function renderIdleSurface(currentState) {
  const viewModel = selectEmptyStateRenderModel({
    clientAuth: currentState.clientAuth,
    pairingTicket: currentState.pairingTicket,
    relayDirectory: currentState.relayDirectory,
    remoteAuth: currentState.remoteAuth,
  });

  syncConversationLayoutUi();
  syncIdleSurfaceControlsUi({
    remoteAuth: viewModel.remoteAuth,
    relayDirectory: viewModel.relayDirectory,
    sessionPanelOpen: currentState.sessionPanelOpen,
  });
  renderComposerUi({
    composerDisabled: true,
    currentDraft: currentState.composerDraft,
    currentEffortValue: currentState.composerEffort,
    messagePlaceholder: !viewModel.remoteAuth
      ? viewModel.relayDirectory?.length
        ? "Open a relay before sending messages."
        : "Pair this browser before sending messages."
      : viewModel.remoteAuth?.payloadSecret
        ? "Start or resume a remote session first."
      : "Local credentials are unavailable. Pair this relay again in this browser.",
    sendPending: currentState.sendPending,
  });
  syncSessionDraftUi({
    fields: currentState.sessionDraft,
  });
  syncSessionStartUi({
    startDisabled: currentState.sessionStartPending,
  });
  renderResetChromeUi(selectResetChromeRenderModel(currentState));
  renderStatusBadgeUi(selectStatusBadgeRenderModel(currentState));

  if (viewModel.showRelayHome) {
    renderRelayHomeUi({
      clientAuth: viewModel.clientAuth,
      relayDirectory: viewModel.relayDirectory,
      onSelectRelay,
    });
    return;
  }

  if (viewModel.showMissingCredentials) {
    renderMissingCredentialsUi(viewModel.remoteAuth);
    return;
  }

  renderTranscriptEmptyUi();
}

function renderRelayDirectorySection(currentState) {
  const viewModel = selectRelayDirectoryRenderModel({
    relayDirectory: currentState.relayDirectory,
    activeRelayId: currentState.remoteAuth?.relayId || null,
  });

  syncRelayDirectoryChromeUi({
    countLabel: viewModel.countLabel,
  });
  renderRelayDirectoryUi(viewModel, onSelectRelay);
}

function renderThreadsSection(currentState) {
  const viewModel = selectThreadsRenderModel({
    threads: currentState.threads,
    filterValue: currentState.threadsFilterValue,
    activeThreadId: currentState.session?.active_thread_id || null,
    error: currentState.threadsError,
    loading: currentState.threadsRefreshPending,
    remoteAuth: currentState.remoteAuth,
    relayDirectory: currentState.relayDirectory,
  });

  syncThreadListChromeUi({
    countLabel: viewModel.countLabel,
  });
  syncThreadRefreshUi({
    refreshDisabled:
      currentState.threadsRefreshPending || !Boolean(currentState.remoteAuth?.payloadSecret),
  });
  renderThreadListUi(viewModel, onResumeThread);
}
