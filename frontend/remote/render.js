import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  isCurrentDeviceActiveController as isRemoteController,
  renderDeviceMeta as renderDeviceChrome,
  renderSessionChrome,
  resetRemoteSurfaceChrome,
  updateStatusBadge as updateChromeStatusBadge,
} from "./render-chrome.js";
import {
  renderLog as appendClientLog,
  renderLogs,
} from "./render-transcript.js";
import {
  debugScrollEvent,
  handleTranscriptScroll,
  renderTranscriptPanel,
  syncTranscriptScrollModeForSession,
} from "./components/transcript-panel.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import {
  selectEmptyStateRenderModel,
  selectRelayDirectoryRenderModel,
  selectSessionRenderModel,
  selectThreadsRenderModel,
} from "./view-model.js";
import { deriveSessionRuntime } from "./session-runtime.js";
import {
  applyRemoteSurfacePatch,
  createSessionRuntimeStatePatch,
} from "./surface-state.js";
import {
  renderComposerUi,
  renderMissingCredentialsUi,
  readCurrentModelValue,
  readSessionPanelOpen,
  readThreadsFilterValue,
  renderRelayDirectoryUi,
  renderRelayHomeUi,
  renderThreadListUi,
  renderTranscriptEmptyUi,
  syncConversationLayoutUi,
  syncIdleSurfaceControlsUi,
  syncRelayDirectoryChromeUi,
  syncRemoteModelSuggestionsUi,
  syncSessionPanelUi,
  syncThreadListChromeUi,
} from "./ui-renderer.js";

let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
}

export function renderSession(session) {
  const previousSession = state.session;
  syncTranscriptScrollModeForSession(session, previousSession);
  const sessionView = selectSessionRenderModel({
    session,
    previousSession,
    hasControllerLease: canCurrentDeviceWrite(session),
  });
  syncConversationLayoutUi();
  const sessionRuntime = deriveSessionRuntime({
    session,
    sessionView,
    threadsFilterValue: readThreadsFilterValue(),
  });
  applySessionRuntimeView(sessionRuntime);
  applyRemoteSurfacePatch(createSessionRuntimeStatePatch(sessionRuntime));

  syncRemoteModelSuggestionsUi({
    currentValue:
      session.model
      || readCurrentModelValue()
      || session.available_models?.find((model) => model.is_default)?.model
      || "gpt-5.4",
    models: session.available_models || [],
  });

  renderSessionChrome(session);
  renderTranscriptPanel(session, sessionView.approval, sessionView.canWrite, previousSession);
  renderLogs(session.logs || []);
  debugScrollEvent("renderSession", sessionView.scrollDebug);
  renderThreads(state.threads);
}

export function renderThreads(threads) {
  const filterValue = readThreadsFilterValue();
  const viewModel = selectThreadsRenderModel({
    threads,
    filterValue,
    activeThreadId: state.session?.active_thread_id || null,
    remoteAuth: state.remoteAuth,
    relayDirectory: state.relayDirectory,
  });
  syncThreadListChromeUi({
    countLabel: viewModel.countLabel,
  });
  renderThreadListUi(viewModel, onResumeThread);
}

export function renderRelayDirectory() {
  const viewModel = selectRelayDirectoryRenderModel({
    relayDirectory: state.relayDirectory,
    activeRelayId: state.remoteAuth?.relayId || null,
  });
  syncRelayDirectoryChromeUi({
    countLabel: viewModel.countLabel,
  });
  renderRelayDirectoryUi(viewModel, onSelectRelay);
}

export function renderDeviceMeta() {
  renderDeviceChrome();
  renderRelayDirectory();
}

export function renderEmptyState() {
  syncConversationLayoutUi();
  const viewModel = selectEmptyStateRenderModel({
    clientAuth: state.clientAuth,
    pairingTicket: state.pairingTicket,
    relayDirectory: state.relayDirectory,
    remoteAuth: state.remoteAuth,
  });
  syncIdleSurfaceControlsUi({
    remoteAuth: viewModel.remoteAuth,
    relayDirectory: viewModel.relayDirectory,
    sessionPanelOpen: readSessionPanelOpen(),
  });

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

export function setRemoteSessionPanelOpen(open) {
  syncSessionPanelUi({
    hasRemoteAuth: Boolean(state.remoteAuth),
    open,
  });
}

export function updateStatusBadge() {
  updateChromeStatusBadge();
}

export function renderLog(message) {
  appendClientLog(message);
}

export function resetRemoteSurface() {
  syncConversationLayoutUi();
  renderThreads([]);
  resetRemoteSurfaceChrome();
}

export function isCurrentDeviceActiveController(session) {
  return isRemoteController(session);
}

export function canCurrentDeviceWrite(session) {
  return canRemoteDeviceWrite(session);
}

export { handleTranscriptScroll } from "./components/transcript-panel.js";

function applySessionRuntimeView(sessionRuntime) {
  syncThreadListChromeUi({
    threadsFilterHint: sessionRuntime.threadsFilterHint,
  });

  renderComposerUi(sessionRuntime);
}
