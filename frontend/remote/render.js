import * as dom from "./dom.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  isCurrentDeviceActiveController as isRemoteController,
  renderDeviceMeta as renderDeviceChrome,
  renderSessionChrome,
  resetRemoteSurfaceChrome,
  updateStatusBadge as updateChromeStatusBadge,
} from "./render-chrome.js";
import {
  renderEmptyState as renderTranscriptEmptyState,
  renderLog as appendClientLog,
  renderLogs,
} from "./render-transcript.js";
import {
  renderMissingCredentialsState,
  renderRelayHome,
  syncIdleSurfaceControls,
} from "./components/empty-state.js";
import { renderRelayDirectoryList } from "./components/relay-directory.js";
import { renderThreadList } from "./components/thread-list.js";
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

let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
}

export function renderSession(session) {
  const previousSession = state.session;
  syncTranscriptScrollModeForSession(session, previousSession);
  syncRemoteChatView();
  const sessionView = selectSessionRenderModel({
    session,
    previousSession,
    hasControllerLease: canCurrentDeviceWrite(session),
  });
  const sessionRuntime = deriveSessionRuntime({
    session,
    sessionView,
    threadsFilterValue: dom.remoteThreadsCwdInput.value,
  });
  applySessionRuntimeView(sessionRuntime);
  applyRemoteSurfacePatch(createSessionRuntimeStatePatch(sessionRuntime));

  syncRemoteModelSuggestions(session.available_models || [], session.model);

  renderSessionChrome(session);
  renderTranscriptPanel(session, sessionView.approval, sessionView.canWrite, previousSession);
  renderLogs(session.logs || []);
  debugScrollEvent("renderSession", sessionView.scrollDebug);
  renderThreads(state.threads);
}

export function renderThreads(threads) {
  const filterValue = dom.remoteThreadsCwdInput.value.trim();
  const viewModel = selectThreadsRenderModel({
    threads,
    filterValue,
    activeThreadId: state.session?.active_thread_id || null,
    remoteAuth: state.remoteAuth,
    relayDirectory: state.relayDirectory,
  });
  renderThreadList(viewModel, onResumeThread);
}

export function renderRelayDirectory() {
  const viewModel = selectRelayDirectoryRenderModel({
    relayDirectory: state.relayDirectory,
    activeRelayId: state.remoteAuth?.relayId || null,
  });
  renderRelayDirectoryList(viewModel, onSelectRelay);
}

export function renderDeviceMeta() {
  renderDeviceChrome();
  renderRelayDirectory();
}

export function renderEmptyState() {
  syncRemoteChatView();
  const viewModel = selectEmptyStateRenderModel({
    clientAuth: state.clientAuth,
    pairingTicket: state.pairingTicket,
    relayDirectory: state.relayDirectory,
    remoteAuth: state.remoteAuth,
  });
  syncIdleSurfaceControls({
    remoteAuth: viewModel.remoteAuth,
    relayDirectory: viewModel.relayDirectory,
    setRemoteSessionPanelOpen,
  });

  if (viewModel.showRelayHome) {
    renderRelayHome({
      clientAuth: viewModel.clientAuth,
      relayDirectory: viewModel.relayDirectory,
      onSelectRelay,
    });
    return;
  }

  if (viewModel.showMissingCredentials) {
    renderMissingCredentialsState(viewModel.remoteAuth);
    return;
  }

  renderTranscriptEmptyState();
}

export function setRemoteSessionPanelOpen(open) {
  if (!state.remoteAuth) {
    dom.remoteSessionPanel.hidden = true;
    dom.remoteSessionToggle.setAttribute("aria-expanded", "false");
    dom.remoteSessionToggle.textContent = "Select a relay first";
    return;
  }
  dom.remoteSessionPanel.hidden = !open;
  dom.remoteSessionToggle.setAttribute("aria-expanded", String(open));
  dom.remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
}

export function updateStatusBadge() {
  updateChromeStatusBadge();
}

export function renderLog(message) {
  appendClientLog(message);
}

export function resetRemoteSurface() {
  syncRemoteChatView();
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

function syncRemoteModelSuggestions(models, selectedModel) {
  const currentValue =
    selectedModel
    || dom.remoteModelInput.value
    || models.find((model) => model.is_default)?.model
    || "gpt-5.4";
  const options = [...models];
  if (currentValue && !options.some((model) => model.model === currentValue)) {
    options.unshift({
      model: currentValue,
      display_name: currentValue,
    });
  }

  dom.remoteModelInput.innerHTML = options
    .map((model) => `<option value="${escapeHtml(model.model)}">${escapeHtml(model.display_name)}</option>`)
    .join("");
  dom.remoteModelInput.value = currentValue;
}

function syncRemoteChatView() {
  if (dom.appShell) {
    dom.appShell.dataset.view = "conversation";
  }
  if (dom.chatShell) {
    dom.chatShell.dataset.view = "conversation";
  }
}

function applySessionRuntimeView(sessionRuntime) {
  if (sessionRuntime.threadsFilterHint) {
    dom.remoteThreadsCwdInput.placeholder = sessionRuntime.threadsFilterHint.placeholder;
    dom.remoteThreadsCwdInput.title = sessionRuntime.threadsFilterHint.title;
  }

  dom.remoteSendButton.disabled = sessionRuntime.composerDisabled;
  dom.remoteMessageInput.disabled = sessionRuntime.composerDisabled;
  dom.remoteMessageInput.placeholder = sessionRuntime.messagePlaceholder;
}
