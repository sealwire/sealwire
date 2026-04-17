import * as dom from "./dom.js";
import {
  renderThreadGroupsMarkup,
} from "../shared/thread-groups.js";
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
  relaySubtitle,
  renderMissingCredentialsState,
  renderRelayHome,
  syncIdleSurfaceControls,
} from "./components/empty-state.js";
import {
  debugScrollEvent,
  handleTranscriptScroll,
  renderTranscriptPanel,
  syncTranscriptScrollModeForSession,
} from "./components/transcript-panel.js";
import { state } from "./state.js";
import { escapeHtml, formatTimestamp, workspaceBasename } from "./utils.js";
import {
  selectEmptyStateRenderModel,
  selectRelayDirectoryRenderModel,
  selectSessionRenderModel,
  selectThreadsRenderModel,
} from "./view-model.js";

let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
}

export function renderSession(session) {
  const previousSession = state.session;
  state.session = session;
  syncTranscriptScrollModeForSession(session, previousSession);
  syncRemoteChatView();
  const sessionView = selectSessionRenderModel({
    session,
    previousSession,
    hasControllerLease: canCurrentDeviceWrite(session),
  });
  state.currentApprovalId = sessionView.approval?.request_id || null;

  if (session.current_cwd && !dom.remoteThreadsCwdInput.value.trim()) {
    dom.remoteThreadsCwdInput.placeholder = `Optional exact path filter (current: ${workspaceBasename(session.current_cwd)})`;
    dom.remoteThreadsCwdInput.title = session.current_cwd;
  }

  syncRemoteModelSuggestions(session.available_models || [], session.model);

  renderSessionChrome(session);
  renderTranscriptPanel(session, sessionView.approval, sessionView.canWrite, previousSession);
  renderLogs(session.logs || []);
  debugScrollEvent("renderSession", sessionView.scrollDebug);
  renderThreads(state.threads);

  dom.remoteSendButton.disabled = !sessionView.hasActiveSession || !sessionView.hasControllerLease;
  dom.remoteMessageInput.disabled = !sessionView.hasActiveSession || !sessionView.hasControllerLease;
  dom.remoteMessageInput.placeholder = sessionView.messagePlaceholder;
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

  dom.remoteThreadsCount.textContent = viewModel.countLabel;

  if (viewModel.emptyMessage) {
    dom.remoteThreadsList.innerHTML = `<p class="sidebar-empty">${viewModel.emptyMessage}</p>`;
    return;
  }

  dom.remoteThreadsList.innerHTML = renderThreadGroupsMarkup(viewModel.groups, {
    activeThreadId: viewModel.activeThreadId,
    includePreview: true,
    formatThreadMeta(thread) {
      return formatTimestamp(thread.updated_at);
    },
  });

  dom.remoteThreadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onResumeThread(button.dataset.threadId);
    });
  });
}

export function renderRelayDirectory() {
  const viewModel = selectRelayDirectoryRenderModel({
    relayDirectory: state.relayDirectory,
    activeRelayId: state.remoteAuth?.relayId || null,
  });
  dom.remoteRelaysCount.textContent = viewModel.countLabel;

  if (viewModel.emptyMessage) {
    dom.remoteRelaysList.innerHTML = `<p class="sidebar-empty">${viewModel.emptyMessage}</p>`;
    return;
  }

  dom.remoteRelaysList.innerHTML = viewModel.items
    .map((item) => {
      const subtitle = relaySubtitle(item.relay);
      const activeClass = item.active ? " is-active" : "";
      return `
        <button class="conversation-item${activeClass}" type="button" data-relay-id="${escapeHtml(item.id)}" ${item.isEnabled ? "" : "disabled"}>
          <span class="conversation-title">${escapeHtml(item.title)}</span>
          <span class="conversation-preview">${escapeHtml(subtitle)}</span>
          <span class="conversation-meta">${escapeHtml(item.meta)} · ${escapeHtml(item.actionLabel)}</span>
        </button>
      `;
    })
    .join("");

  dom.remoteRelaysList.querySelectorAll("[data-relay-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onSelectRelay(button.dataset.relayId);
    });
  });
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
