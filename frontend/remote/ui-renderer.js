import * as dom from "./dom.js";
import { renderEmptyState as renderTranscriptEmptyState } from "./render-transcript.js";
import {
  renderMissingCredentialsState,
  renderRelayHome,
} from "./components/empty-state.js";
import { renderRelayDirectoryList } from "./components/relay-directory.js";
import { renderThreadList } from "./components/thread-list.js";
import { escapeHtml, shortId } from "./utils.js";

let remoteUiRenderer = createDomRemoteUiRenderer();

export function installRemoteUiRenderer(renderer) {
  remoteUiRenderer = renderer;
}

export function renderRelayDirectoryUi(viewModel, onSelectRelay) {
  remoteUiRenderer.renderRelayDirectory(viewModel, onSelectRelay);
}

export function renderThreadListUi(viewModel, onResumeThread) {
  remoteUiRenderer.renderThreadList(viewModel, onResumeThread);
}

export function renderTranscriptEmptyUi() {
  remoteUiRenderer.renderTranscriptEmpty();
}

export function renderRelayHomeUi(model) {
  remoteUiRenderer.renderRelayHome(model);
}

export function renderMissingCredentialsUi(remoteAuth) {
  remoteUiRenderer.renderMissingCredentials(remoteAuth);
}

export function renderReadyTranscriptUi({ session, canWrite }) {
  remoteUiRenderer.renderReadyTranscript({ session, canWrite });
}

export function renderTranscriptMarkupUi({ markup, hydrationLoading }) {
  remoteUiRenderer.renderTranscriptMarkup({ markup, hydrationLoading });
}

export function renderComposerUi(model) {
  remoteUiRenderer.renderComposer(model);
}

export function readThreadsFilterValue() {
  return remoteUiRenderer.readThreadsFilterValue();
}

export function readCurrentModelValue() {
  return remoteUiRenderer.readCurrentModelValue();
}

export function readSessionPanelOpen() {
  return remoteUiRenderer.readSessionPanelOpen();
}

export function syncConversationLayoutUi() {
  remoteUiRenderer.syncConversationLayout();
}

export function syncThreadListChromeUi(model) {
  remoteUiRenderer.syncThreadListChrome(model);
}

export function syncRelayDirectoryChromeUi(model) {
  remoteUiRenderer.syncRelayDirectoryChrome(model);
}

export function syncSessionPanelUi(model) {
  remoteUiRenderer.syncSessionPanel(model);
}

export function syncIdleSurfaceControlsUi(model) {
  remoteUiRenderer.syncIdleSurfaceControls(model);
}

export function syncRemoteModelSuggestionsUi(model) {
  remoteUiRenderer.syncRemoteModelSuggestions(model);
}

function createDomRemoteUiRenderer() {
  return {
    readThreadsFilterValue() {
      return dom.remoteThreadsCwdInput.value.trim();
    },
    readCurrentModelValue() {
      return dom.remoteModelInput.value;
    },
    readSessionPanelOpen() {
      return !dom.remoteSessionPanel.hidden;
    },
    syncConversationLayout() {
      if (dom.appShell) {
        dom.appShell.dataset.view = "conversation";
      }
      if (dom.chatShell) {
        dom.chatShell.dataset.view = "conversation";
      }
    },
    syncThreadListChrome({ countLabel, threadsFilterHint }) {
      if (countLabel !== undefined) {
        dom.remoteThreadsCount.textContent = countLabel;
      }
      if (threadsFilterHint) {
        dom.remoteThreadsCwdInput.placeholder = threadsFilterHint.placeholder;
        dom.remoteThreadsCwdInput.title = threadsFilterHint.title;
      }
    },
    syncRelayDirectoryChrome({ countLabel }) {
      if (countLabel !== undefined) {
        dom.remoteRelaysCount.textContent = countLabel;
      }
    },
    syncSessionPanel({ hasRemoteAuth, open }) {
      if (!hasRemoteAuth) {
        dom.remoteSessionPanel.hidden = true;
        dom.remoteSessionToggle.setAttribute("aria-expanded", "false");
        dom.remoteSessionToggle.textContent = "Select a relay first";
        return;
      }

      dom.remoteSessionPanel.hidden = !open;
      dom.remoteSessionToggle.setAttribute("aria-expanded", String(open));
      dom.remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
    },
    syncIdleSurfaceControls({ relayDirectory, remoteAuth, sessionPanelOpen }) {
      const hasRelay = Boolean(remoteAuth);
      const hasUsableRelay = Boolean(remoteAuth?.payloadSecret);
      dom.remoteSessionToggle.disabled = !hasUsableRelay;
      dom.remoteThreadsRefreshButton.disabled = !hasUsableRelay;
      dom.remoteThreadsCwdInput.disabled = !hasUsableRelay;
      dom.remoteStartSessionButton.disabled = !hasUsableRelay;

      this.syncSessionPanel({
        hasRemoteAuth: hasRelay,
        open: hasUsableRelay ? sessionPanelOpen : false,
      });

      dom.remoteHomeButton.hidden = !hasRelay;
      dom.remoteHomeButton.disabled = !hasRelay;
      this.renderComposer({
        composerDisabled: true,
        messagePlaceholder: !hasRelay
          ? relayDirectory?.length
            ? "Open a relay before sending messages."
            : "Pair this browser before sending messages."
          : hasUsableRelay
            ? "Start or resume a remote session first."
            : "Local credentials are unavailable. Pair this relay again in this browser.",
      });
    },
    syncRemoteModelSuggestions({ currentValue, models }) {
      const options = [...models];
      if (currentValue && !options.some((model) => model.model === currentValue)) {
        options.unshift({
          model: currentValue,
          display_name: currentValue,
        });
      }

      dom.remoteModelInput.innerHTML = options
        .map(
          (model) =>
            `<option value="${escapeHtml(model.model)}">${escapeHtml(model.display_name)}</option>`
        )
        .join("");
      dom.remoteModelInput.value = currentValue;
    },
    renderRelayDirectory(viewModel, onSelectRelay) {
      renderRelayDirectoryList(viewModel, onSelectRelay);
    },
    renderThreadList(viewModel, onResumeThread) {
      renderThreadList(viewModel, onResumeThread);
    },
    renderTranscriptEmpty() {
      renderTranscriptEmptyState();
    },
    renderRelayHome(model) {
      renderRelayHome(model);
    },
    renderMissingCredentials(remoteAuth) {
      renderMissingCredentialsState(remoteAuth);
    },
    renderReadyTranscript({ session, canWrite }) {
      const title = canWrite ? "Session ready" : "Session active on another device";
      const copy = canWrite
        ? "The remote session is live. Send the first prompt below when you're ready."
        : "This thread is already open, but another device currently has control. Take over to send the first prompt from here.";
      const detailParts = [];

      if (session.current_cwd) {
        detailParts.push(`Workspace: ${escapeHtml(session.current_cwd)}`);
      }
      if (session.active_thread_id) {
        detailParts.push(`Thread: ${escapeHtml(shortId(session.active_thread_id))}`);
      }

      dom.remoteTranscript.innerHTML = `
        <div class="thread-empty thread-empty-ready">
          <span class="thread-empty-badge">${canWrite ? "Ready" : "Waiting"}</span>
          <h2>${title}</h2>
          <p>${copy}</p>
          ${
            detailParts.length
              ? `<p class="thread-empty-detail">${detailParts.join(" · ")}</p>`
              : ""
          }
        </div>
      `;
    },
    renderTranscriptMarkup({ markup, hydrationLoading }) {
      const loadingBanner = hydrationLoading
        ? `<div class="transcript-loading-banner">Loading earlier transcript…</div>`
        : "";
      dom.remoteTranscript.innerHTML = `${loadingBanner}${markup}`;
    },
    renderComposer({ composerDisabled, messagePlaceholder }) {
      if (dom.remoteSendButton) {
        dom.remoteSendButton.disabled = composerDisabled;
      }
      if (dom.remoteMessageInput) {
        dom.remoteMessageInput.disabled = composerDisabled;
        dom.remoteMessageInput.placeholder = messagePlaceholder;
      }
    },
  };
}
