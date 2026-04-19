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

export function syncSessionDraftUi(model) {
  remoteUiRenderer.syncSessionDraft(model);
}

export function syncIdleSurfaceControlsUi(model) {
  remoteUiRenderer.syncIdleSurfaceControls(model);
}

export function syncRemoteModelSuggestionsUi(model) {
  remoteUiRenderer.syncRemoteModelSuggestions(model);
}

export function syncSessionStartUi(model) {
  remoteUiRenderer.syncSessionStart(model);
}

export function syncThreadRefreshUi(model) {
  remoteUiRenderer.syncThreadRefresh(model);
}

export function renderSessionChromeUi(model) {
  remoteUiRenderer.renderSessionChrome(model);
}

export function renderDeviceChromeUi(model) {
  remoteUiRenderer.renderDeviceChrome(model);
}

export function renderResetChromeUi(model) {
  remoteUiRenderer.renderResetChrome(model);
}

export function renderStatusBadgeUi(model) {
  remoteUiRenderer.renderStatusBadge(model);
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
    syncSessionDraft({ fields }) {
      if (fields.cwd !== undefined && dom.remoteCwdInput) {
        dom.remoteCwdInput.value = fields.cwd;
      }
      if (fields.initialPrompt !== undefined && dom.remoteStartPromptInput) {
        dom.remoteStartPromptInput.value = fields.initialPrompt;
      }
      if (fields.model !== undefined && dom.remoteModelInput) {
        dom.remoteModelInput.value = fields.model;
      }
      if (fields.approvalPolicy !== undefined && dom.remoteApprovalPolicyInput) {
        dom.remoteApprovalPolicyInput.value = fields.approvalPolicy;
      }
      if (fields.sandbox !== undefined && dom.remoteSandboxInput) {
        dom.remoteSandboxInput.value = fields.sandbox;
      }
      if (fields.effort !== undefined && dom.remoteStartEffortInput) {
        dom.remoteStartEffortInput.value = fields.effort;
      }
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
    syncSessionStart({ startDisabled }) {
      if (startDisabled !== undefined && dom.remoteStartSessionButton) {
        dom.remoteStartSessionButton.disabled = startDisabled;
      }
    },
    syncThreadRefresh({ countLabel, refreshDisabled }) {
      if (countLabel !== undefined) {
        dom.remoteThreadsCount.textContent = countLabel;
      }
      if (refreshDisabled !== undefined) {
        dom.remoteThreadsRefreshButton.disabled = refreshDisabled;
      }
    },
    renderSessionChrome(model) {
      applyHeaderToDom(model.header);
      applyStatusBadgeToDom(model.statusBadge);
      applySessionMetaToDom(model.sessionMeta);
      applyControlBannerToDom(model.controlBanner);
    },
    renderDeviceChrome(model) {
      applyDeviceMetaToDom(model.deviceMeta);
      if (model.workspaceHeading) {
        applyHeaderToDom(model.workspaceHeading);
      }
      dom.connectButton.disabled = model.pairingControls.connectDisabled;
      dom.connectButton.textContent = model.pairingControls.connectLabel;
      dom.pairingInput.readOnly = model.pairingControls.pairingInputReadOnly;
      dom.remoteHomeButton.hidden = model.homeButton.hidden;
    },
    renderResetChrome(model) {
      applyHeaderToDom(model.header);
      applySessionMetaToDom(model.sessionMeta);
      applyControlBannerToDom(model.controlBanner);
    },
    renderStatusBadge(model) {
      applyStatusBadgeToDom(model);
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
    renderComposer({
      composerDisabled,
      currentDraft,
      currentEffortValue,
      messagePlaceholder,
      sendPending,
    }) {
      const submitDisabled = composerDisabled || sendPending;
      if (dom.remoteSendButton) {
        dom.remoteSendButton.disabled = submitDisabled;
        dom.remoteSendButton.textContent = sendPending ? "Sending..." : "Send";
      }
      if (dom.remoteMessageInput) {
        dom.remoteMessageInput.disabled = submitDisabled;
        dom.remoteMessageInput.placeholder = messagePlaceholder;
        if (currentDraft !== undefined) {
          dom.remoteMessageInput.value = currentDraft;
        }
      }
      if (dom.remoteMessageEffort && currentEffortValue !== undefined) {
        dom.remoteMessageEffort.value = currentEffortValue;
      }
    },
  };
}

function applyHeaderToDom(model) {
  dom.remoteWorkspaceTitle.textContent = model.title;
  dom.remoteWorkspaceSubtitle.textContent = model.subtitle;
  dom.remoteWorkspaceSubtitle.hidden = model.subtitleHidden;
  dom.remoteWorkspaceTitle.title = model.titleTitle || "";
  dom.remoteWorkspaceSubtitle.title = model.subtitleTitle || model.subtitle || "";
  applySessionPathToDom(model.sessionPath);
}

function applySessionMetaToDom(model) {
  dom.remoteSessionMeta.innerHTML = [
    ...model.chips.map(
      (chip) => `
        <span class="meta-chip">
          <strong>${escapeHtml(chip.label)}:</strong>
          <span>${escapeHtml(chip.value)}</span>
        </span>
      `
    ),
    ...(model.emptyMessage ? [`<span class="meta-empty">${escapeHtml(model.emptyMessage)}</span>`] : []),
  ].join("");
}

function applyControlBannerToDom(model) {
  dom.remoteControlBanner.hidden = model.hidden;
  if (model.hidden) {
    return;
  }
  dom.remoteControlSummary.textContent = model.summary;
  dom.remoteControlHint.textContent = model.hint;
  dom.remoteTakeOverButton.hidden = model.takeOverHidden;
}

function applyDeviceMetaToDom(model) {
  if (model.emptyMessage) {
    dom.deviceMeta.innerHTML = `<p class="sidebar-empty">${escapeHtml(model.emptyMessage)}</p>`;
    return;
  }

  dom.deviceMeta.innerHTML = model.cards
    .map(
      (card) => `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <strong>${escapeHtml(card.title)}</strong>
            <div class="paired-device-badges">
              ${card.badges
                .map(
                  (badge) =>
                    `<span class="status-badge status-badge-${escapeHtml(badge.tone)}">${escapeHtml(badge.label)}</span>`
                )
                .join("")}
            </div>
            ${card.metaLines
              .map((line) => `<p class="paired-device-meta">${escapeHtml(line)}</p>`)
              .join("")}
          </div>
        </article>
      `
    )
    .join("");
}

function applyStatusBadgeToDom(model) {
  const compactLabel = compactStatusLabel(model.label);
  dom.remoteStatusBadge.textContent = compactLabel;
  dom.remoteStatusBadge.className = `status-badge status-badge-${model.tone} status-badge-compact`;
  dom.remoteStatusBadge.title = model.label;
  dom.remoteStatusBadge.setAttribute("aria-label", model.label);
}

function applySessionPathToDom(path) {
  if (!dom.remoteSessionPath) {
    return;
  }

  dom.remoteSessionPath.textContent = path || "No workspace path yet.";
}

function compactStatusLabel(label) {
  const normalized = String(label || "").trim().toLowerCase();

  switch (normalized) {
    case "idle":
    case "ready":
      return "Ready";
    case "connected":
      return "Connected";
    case "home":
      return "Home";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "approval required":
      return "Approval";
    case "re-pair required":
      return "Re-pair";
    case "pairing failed":
      return "Failed";
    case "approval pending":
      return "Pending";
    default:
      return label
        ? String(label)
            .trim()
            .replace(/\b\w/g, (char) => char.toUpperCase())
        : "Ready";
  }
}
