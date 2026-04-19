import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as dom from "./dom.js";
import { relaySubtitle } from "./components/empty-state.js";
import { canonicalizeWorkspace } from "../shared/thread-groups.js";
import { formatTimestamp, shortId } from "./utils.js";

const h = React.createElement;

const roots = new Map();
const collapsedGroupCwds = new Set();
let lastThreadListArgs = null;
let lastRelayDirectoryChromeModel = createDefaultRelayDirectoryChromeModel();
let lastThreadHistoryChromeModel = createDefaultThreadHistoryChromeModel();
let lastHeaderModel = createDefaultHeaderModel();
let lastStatusBadgeModel = createDefaultStatusBadgeModel();
let lastSessionPanelModel = createDefaultSessionPanelModel();

export function createRemoteReactUiRenderer() {
  const renderer = {
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
        lastThreadHistoryChromeModel = {
          ...lastThreadHistoryChromeModel,
          countLabel,
        };
        renderThreadHistoryCount();
      }
      if (threadsFilterHint) {
        dom.remoteThreadsCwdInput.placeholder = threadsFilterHint.placeholder;
        dom.remoteThreadsCwdInput.title = threadsFilterHint.title;
      }
    },
    syncRelayDirectoryChrome({ countLabel }) {
      if (countLabel !== undefined) {
        lastRelayDirectoryChromeModel = {
          ...lastRelayDirectoryChromeModel,
          countLabel,
        };
        renderRelayDirectoryCount();
      }
    },
    syncSessionPanel({ hasRemoteAuth, open }) {
      lastSessionPanelModel = {
        ...lastSessionPanelModel,
        hasRemoteAuth,
      };
      captureSessionPanelFieldValues();
      if (!hasRemoteAuth) {
        dom.remoteSessionPanel.hidden = true;
        dom.remoteSessionToggle.setAttribute("aria-expanded", "false");
        dom.remoteSessionToggle.textContent = "Select a relay first";
        renderSessionPanel();
        return;
      }

      dom.remoteSessionPanel.hidden = !open;
      dom.remoteSessionToggle.setAttribute("aria-expanded", String(open));
      dom.remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
      renderSessionPanel();
    },
    syncIdleSurfaceControls({ relayDirectory, remoteAuth, sessionPanelOpen }) {
      const hasRelay = Boolean(remoteAuth);
      const hasUsableRelay = Boolean(remoteAuth?.payloadSecret);
      lastSessionPanelModel = {
        ...lastSessionPanelModel,
        hasUsableRelay,
      };
      lastThreadHistoryChromeModel = {
        ...lastThreadHistoryChromeModel,
        refreshDisabled: !hasUsableRelay,
      };
      captureSessionPanelFieldValues();
      dom.remoteSessionToggle.disabled = !hasUsableRelay;
      dom.remoteThreadsRefreshButton.disabled = !hasUsableRelay;
      dom.remoteThreadsCwdInput.disabled = !hasUsableRelay;
      renderer.syncSessionPanel({
        hasRemoteAuth: hasRelay,
        open: hasUsableRelay ? sessionPanelOpen : false,
      });
      dom.remoteHomeButton.hidden = !hasRelay;
      dom.remoteHomeButton.disabled = !hasRelay;
      renderer.renderComposer({
        composerDisabled: true,
        currentEffortValue: dom.remoteMessageEffort?.value || "medium",
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
      captureSessionPanelFieldValues();
      const options = [...models];
      if (currentValue && !options.some((model) => model.model === currentValue)) {
        options.unshift({
          model: currentValue,
          display_name: currentValue,
        });
      }
      lastSessionPanelModel = {
        ...lastSessionPanelModel,
        fields: {
          ...lastSessionPanelModel.fields,
          model: dom.remoteModelInput?.value || currentValue || "",
        },
        models: options,
      };
      renderSessionPanel();
    },
    syncSessionStart({ startDisabled }) {
      if (startDisabled === undefined) {
        return;
      }

      captureSessionPanelFieldValues();
      lastSessionPanelModel = {
        ...lastSessionPanelModel,
        startPending: startDisabled,
      };
      renderSessionPanel();
    },
    syncThreadRefresh({ countLabel, refreshDisabled }) {
      if (countLabel !== undefined) {
        lastThreadHistoryChromeModel = {
          ...lastThreadHistoryChromeModel,
          countLabel,
        };
        renderThreadHistoryCount();
      }
      if (refreshDisabled !== undefined) {
        lastThreadHistoryChromeModel = {
          ...lastThreadHistoryChromeModel,
          refreshDisabled,
        };
        dom.remoteThreadsRefreshButton.disabled = refreshDisabled;
      }
    },
    renderSessionChrome(model) {
      lastHeaderModel = model.header;
      lastStatusBadgeModel = model.statusBadge;
      renderWorkspaceHeading();
      renderSessionPath();
      renderIntoRoot(dom.remoteSessionMeta, h(SessionMetaPanel, { model: model.sessionMeta }));
      renderControlBanner(model.controlBanner);
    },
    renderDeviceChrome(model) {
      renderIntoRoot(dom.deviceMeta, h(DeviceMetaPanel, { model: model.deviceMeta }));
      if (model.workspaceHeading) {
        lastHeaderModel = model.workspaceHeading;
        renderWorkspaceHeading();
        renderSessionPath();
      }
      dom.connectButton.disabled = model.pairingControls.connectDisabled;
      dom.connectButton.textContent = model.pairingControls.connectLabel;
      dom.pairingInput.readOnly = model.pairingControls.pairingInputReadOnly;
      dom.remoteHomeButton.hidden = model.homeButton.hidden;
    },
    renderResetChrome(model) {
      lastHeaderModel = model.header;
      renderWorkspaceHeading();
      renderSessionPath();
      renderIntoRoot(dom.remoteSessionMeta, h(SessionMetaPanel, { model: model.sessionMeta }));
      renderControlBanner(model.controlBanner);
    },
    renderStatusBadge(model) {
      lastStatusBadgeModel = model;
      renderWorkspaceHeading();
    },
    renderRelayDirectory(viewModel, onSelectRelay) {
      renderIntoRoot(
        dom.remoteRelaysList,
        h(RelayDirectoryList, {
          onSelectRelay,
          viewModel,
        })
      );
    },
    renderThreadList(viewModel, onResumeThread) {
      lastThreadListArgs = { onResumeThread, viewModel };
      renderIntoRoot(
        dom.remoteThreadsList,
        h(ThreadList, {
          collapsedGroupCwds,
          onResumeThread,
          onToggleGroup(cwd) {
            if (!cwd) {
              return;
            }
            if (collapsedGroupCwds.has(cwd)) {
              collapsedGroupCwds.delete(cwd);
            } else {
              collapsedGroupCwds.add(cwd);
            }
            if (lastThreadListArgs) {
              renderer.renderThreadList(
                lastThreadListArgs.viewModel,
                lastThreadListArgs.onResumeThread
              );
            }
          },
          viewModel,
        })
      );
    },
    renderTranscriptEmpty() {
      renderIntoRoot(dom.remoteTranscript, h(DefaultTranscriptEmpty));
    },
    renderRelayHome(model) {
      renderIntoRoot(
        dom.remoteTranscript,
        h(RelayHomeState, {
          clientAuth: model.clientAuth,
          onSelectRelay: model.onSelectRelay,
          relayDirectory: model.relayDirectory,
        })
      );
    },
    renderMissingCredentials(remoteAuth) {
      renderIntoRoot(
        dom.remoteTranscript,
        h(MissingCredentialsState, {
          remoteAuth,
        })
      );
    },
    renderReadyTranscript({ session, canWrite }) {
      renderIntoRoot(
        dom.remoteTranscript,
        h(ReadyTranscriptState, {
          canWrite,
          session,
        })
      );
    },
    renderTranscriptMarkup({ markup, hydrationLoading }) {
      renderIntoRoot(
        dom.remoteTranscript,
        h(TranscriptMarkupState, {
          hydrationLoading,
          markup,
        })
      );
    },
    renderComposer({ composerDisabled, messagePlaceholder }) {
      renderIntoRoot(
        dom.remoteMessageForm,
        h(Composer, {
          composerDisabled,
          currentEffortValue: dom.remoteMessageEffort?.value || "medium",
          messagePlaceholder,
        })
      );
      dom.refreshDynamicDomReferences();
    },
  };

  return renderer;
}

function renderSessionPanel() {
  if (!dom.remoteSessionPanel) {
    return;
  }

  renderIntoRoot(
    dom.remoteSessionPanel,
    h(SessionPanel, {
      model: lastSessionPanelModel,
    })
  );
  dom.refreshDynamicDomReferences();
}

function renderControlBanner(model) {
  if (!dom.remoteControlBanner) {
    return;
  }

  dom.remoteControlBanner.hidden = model.hidden;
  renderIntoRoot(dom.remoteControlBanner, h(ControlBanner, { model }));
}

function renderRelayDirectoryCount() {
  if (!dom.remoteRelaysCount) {
    return;
  }

  renderIntoRoot(dom.remoteRelaysCount, lastRelayDirectoryChromeModel.countLabel || "");
}

function renderThreadHistoryCount() {
  if (!dom.remoteThreadsCount) {
    return;
  }

  renderIntoRoot(dom.remoteThreadsCount, lastThreadHistoryChromeModel.countLabel || "");
}

function renderWorkspaceHeading() {
  if (!dom.remoteChatHeading) {
    return;
  }

  renderIntoRoot(
    dom.remoteChatHeading,
    h(WorkspaceHeading, {
      header: lastHeaderModel,
      statusBadge: lastStatusBadgeModel,
    })
  );
}

function renderSessionPath() {
  if (!dom.remoteSessionPath) {
    return;
  }

  renderIntoRoot(
    dom.remoteSessionPath,
    lastHeaderModel?.sessionPath || "No workspace path yet."
  );
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

function createDefaultHeaderModel() {
  return {
    sessionPath: dom.remoteSessionPath?.textContent || "No workspace path yet.",
    subtitle: dom.remoteWorkspaceSubtitle?.textContent || "",
    subtitleHidden: dom.remoteWorkspaceSubtitle?.hidden ?? false,
    subtitleTitle: dom.remoteWorkspaceSubtitle?.title || dom.remoteWorkspaceSubtitle?.textContent || "",
    title: dom.remoteWorkspaceTitle?.textContent || "Pair this browser",
    titleTitle: dom.remoteWorkspaceTitle?.title || "",
  };
}

function createDefaultRelayDirectoryChromeModel() {
  return {
    countLabel: dom.remoteRelaysCount?.textContent || "",
  };
}

function createDefaultThreadHistoryChromeModel() {
  return {
    countLabel: dom.remoteThreadsCount?.textContent || "",
    refreshDisabled: dom.remoteThreadsRefreshButton?.disabled ?? false,
  };
}

function createDefaultStatusBadgeModel() {
  return {
    label: dom.remoteStatusBadge?.title || dom.remoteStatusBadge?.textContent || "Offline",
    tone: extractStatusBadgeTone(dom.remoteStatusBadge?.className) || "offline",
  };
}

function createDefaultSessionPanelModel() {
  return {
    fields: {
      approvalPolicy: dom.remoteApprovalPolicyInput?.value || "untrusted",
      cwd: dom.remoteCwdInput?.value || "",
      effort: dom.remoteStartEffortInput?.value || "medium",
      initialPrompt: dom.remoteStartPromptInput?.value || "",
      model: dom.remoteModelInput?.value || "gpt-5.4",
      sandbox: dom.remoteSandboxInput?.value || "workspace-write",
    },
    hasRemoteAuth: !dom.remoteSessionPanel?.hidden,
    hasUsableRelay: !(dom.remoteStartSessionButton?.disabled ?? true),
    startPending: false,
    models: Array.from(dom.remoteModelInput?.options || []).map((option) => ({
      display_name: option.textContent || option.value,
      model: option.value,
    })),
  };
}

function captureSessionPanelFieldValues() {
  lastSessionPanelModel = {
    ...lastSessionPanelModel,
    fields: {
      approvalPolicy:
        dom.remoteApprovalPolicyInput?.value || lastSessionPanelModel.fields.approvalPolicy,
      cwd: dom.remoteCwdInput?.value ?? lastSessionPanelModel.fields.cwd,
      effort: dom.remoteStartEffortInput?.value || lastSessionPanelModel.fields.effort,
      initialPrompt:
        dom.remoteStartPromptInput?.value ?? lastSessionPanelModel.fields.initialPrompt,
      model: dom.remoteModelInput?.value || lastSessionPanelModel.fields.model,
      sandbox: dom.remoteSandboxInput?.value || lastSessionPanelModel.fields.sandbox,
    },
  };
}

function updateSessionPanelField(field, value) {
  lastSessionPanelModel = {
    ...lastSessionPanelModel,
    fields: {
      ...lastSessionPanelModel.fields,
      [field]: value,
    },
  };
}

function extractStatusBadgeTone(className) {
  const match = String(className || "").match(/status-badge-([a-z-]+)/);
  if (!match) {
    return null;
  }
  return match[1] === "compact" ? null : match[1];
}

function WorkspaceHeading({ header, statusBadge }) {
  const statusTone = statusBadge?.tone || "offline";
  const statusLabel = statusBadge?.label || "Offline";
  const subtitle = header?.subtitle || "";

  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "chat-heading-title-row" },
      h(
        "h1",
        {
          id: "remote-workspace-title",
          title: header?.titleTitle || "",
        },
        header?.title || "Pair this browser"
      ),
      h(
        "span",
        {
          "aria-label": statusLabel,
          className: `status-badge status-badge-${statusTone} status-badge-compact`,
          id: "remote-status-badge",
          title: statusLabel,
        },
        compactStatusLabel(statusLabel)
      )
    ),
    h(
      "p",
      {
        className: "chat-subtitle",
        hidden: header?.subtitleHidden ?? !subtitle,
        id: "remote-workspace-subtitle",
        title: header?.subtitleTitle || subtitle,
      },
      subtitle
    )
  );
}

function SessionPanel({ model }) {
  if (!model.hasRemoteAuth) {
    return null;
  }

  return h(
    React.Fragment,
    null,
    h(
      "label",
      {
        className: "sidebar-label",
        htmlFor: "remote-cwd-input",
      },
      "Workspace"
    ),
    h(
      "div",
      { className: "workspace-picker" },
      h("input", {
        id: "remote-cwd-input",
        onChange: (event) => updateSessionPanelField("cwd", event.target.value),
        placeholder: "/path/to/project",
        type: "text",
        value: model.fields.cwd,
      })
    ),
    h(
      "button",
      {
        className: "start-session-button",
        disabled: !model.hasUsableRelay || model.startPending,
        id: "remote-start-session-button",
        type: "button",
      },
      "Start Session"
    ),
    h(
      "details",
      { className: "sidebar-settings" },
      h("summary", null, "Launch settings"),
      h(
        "div",
        { className: "settings-grid" },
        h(
          "label",
          { className: "field" },
          h("span", null, "Model"),
          h(
            "select",
            {
              id: "remote-model-input",
              onChange: (event) => updateSessionPanelField("model", event.target.value),
              value: model.fields.model,
            },
            ...model.models.map((option) =>
              h(
                "option",
                {
                  key: option.model,
                  value: option.model,
                },
                option.display_name
              )
            )
          )
        ),
        h(
          "label",
          { className: "field" },
          h("span", null, "Approval"),
          h(
            "select",
            {
              id: "remote-approval-policy-input",
              onChange: (event) => updateSessionPanelField("approvalPolicy", event.target.value),
              value: model.fields.approvalPolicy,
            },
            h("option", { value: "untrusted" }, "untrusted"),
            h("option", { value: "on-request" }, "on-request"),
            h("option", { value: "never" }, "never")
          )
        ),
        h(
          "label",
          { className: "field" },
          h("span", null, "Sandbox"),
          h(
            "select",
            {
              id: "remote-sandbox-input",
              onChange: (event) => updateSessionPanelField("sandbox", event.target.value),
              value: model.fields.sandbox,
            },
            h("option", { value: "workspace-write" }, "workspace-write"),
            h("option", { value: "read-only" }, "read-only"),
            h("option", { value: "danger-full-access" }, "danger-full-access")
          )
        ),
        h(
          "label",
          { className: "field" },
          h("span", null, "Default Effort"),
          h(
            "select",
            {
              id: "remote-start-effort",
              onChange: (event) => updateSessionPanelField("effort", event.target.value),
              value: model.fields.effort,
            },
            h("option", { value: "medium" }, "medium"),
            h("option", { value: "low" }, "low"),
            h("option", { value: "high" }, "high")
          )
        ),
        h(
          "label",
          { className: "field field-full" },
          h("span", null, "Initial Prompt"),
          h("textarea", {
            id: "remote-start-prompt",
            onChange: (event) => updateSessionPanelField("initialPrompt", event.target.value),
            placeholder: "Optional first task for the new remote session.",
            rows: 4,
            value: model.fields.initialPrompt,
          })
        )
      )
    )
  );
}

function SessionMetaPanel({ model }) {
  return h(
    React.Fragment,
    null,
    ...model.chips.map((chip) =>
      h(
        "span",
        { className: "meta-chip", key: `${chip.label}:${chip.value}` },
        h("strong", null, `${chip.label}:`),
        h("span", null, chip.value)
      )
    ),
    model.emptyMessage ? h("span", { className: "meta-empty" }, model.emptyMessage) : null
  );
}

function DeviceMetaPanel({ model }) {
  if (model.emptyMessage) {
    return h("p", { className: "sidebar-empty" }, model.emptyMessage);
  }

  return h(
    React.Fragment,
    null,
    ...model.cards.map((card, cardIndex) =>
      h(
        "article",
        { className: "paired-device-card", key: `${card.title}:${cardIndex}` },
        h(
          "div",
          { className: "paired-device-copy" },
          h("strong", null, card.title),
          h(
            "div",
            { className: "paired-device-badges" },
            ...card.badges.map((badge, badgeIndex) =>
              h(
                "span",
                {
                  className: `status-badge status-badge-${badge.tone}`,
                  key: `${badge.label}:${badgeIndex}`,
                },
                badge.label
              )
            )
          ),
          ...card.metaLines.map((line, lineIndex) =>
            h("p", { className: "paired-device-meta", key: `${line}:${lineIndex}` }, line)
          )
        )
      )
    )
  );
}

function ControlBanner({ model }) {
  if (model.hidden) {
    return null;
  }

  return h(
    React.Fragment,
    null,
    h(
      "div",
      null,
      h("p", { className: "control-summary" }, model.summary),
      h("p", { className: "control-hint" }, model.hint)
    ),
    h(
      "button",
      {
        className: "header-button control-button",
        hidden: model.takeOverHidden,
        id: "remote-take-over-button",
        type: "button",
      },
      "Take over"
    )
  );
}

function renderIntoRoot(container, tree) {
  if (!container) {
    return;
  }

  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }

  flushSync(() => {
    root.render(tree);
  });
}

function RelayDirectoryList({ onSelectRelay, viewModel }) {
  if (viewModel.emptyMessage) {
    return h("p", { className: "sidebar-empty" }, viewModel.emptyMessage);
  }

  return h(
    React.Fragment,
    null,
    ...(viewModel.items || []).map((item) =>
      h(
        "button",
        {
          className: `conversation-item${item.active ? " is-active" : ""}`,
          disabled: !item.isEnabled,
          key: item.id || item.meta || item.title,
          onClick: () => onSelectRelay(item.id),
          type: "button",
        },
        h("span", { className: "conversation-title" }, item.title),
        h("span", { className: "conversation-preview" }, relaySubtitle(item.relay)),
        h("span", { className: "conversation-meta" }, `${item.meta} · ${item.actionLabel}`)
      )
    )
  );
}

function ThreadList({
  collapsedGroupCwds,
  onResumeThread,
  onToggleGroup,
  viewModel,
}) {
  if (viewModel.emptyMessage) {
    return h("p", { className: "sidebar-empty" }, viewModel.emptyMessage);
  }

  return h(
    React.Fragment,
    null,
    ...(viewModel.groups || []).map((group) => {
      const normalizedCwd = canonicalizeWorkspace(group.cwd);
      const isCollapsed = collapsedGroupCwds.has(normalizedCwd);
      return h(
        "section",
        {
          className: `thread-group${isCollapsed ? " is-collapsed" : ""}`,
          "data-thread-group-cwd": group.cwd,
          key: group.cwd,
        },
        h(
          "button",
          {
            "aria-expanded": isCollapsed ? "false" : "true",
            className: "thread-group-header",
            onClick: () => onToggleGroup(normalizedCwd),
            title: group.cwd,
            type: "button",
          },
          h("span", { "aria-hidden": "true", className: "thread-group-icon" }),
          h("span", { className: "thread-group-name" }, group.label),
          h("span", { "aria-hidden": "true", className: "thread-group-chevron" })
        ),
        h(
          "div",
          {
            className: "thread-group-list",
            hidden: isCollapsed,
          },
          ...(group.threads || []).map((thread) => {
            const title = thread.name || thread.preview || shortId(thread.id);
            return h(
              "button",
              {
                className: `conversation-item${
                  viewModel.activeThreadId === thread.id ? " is-active" : ""
                }`,
                "data-thread-cwd": group.cwd,
                "data-thread-id": thread.id,
                "data-thread-title": title,
                key: thread.id,
                onClick: () => onResumeThread(thread.id),
                title,
                type: "button",
              },
              h("span", { className: "conversation-title" }, title),
              h(
                "span",
                { className: "conversation-preview" },
                thread.preview || "No preview yet."
              ),
              h("span", { className: "conversation-meta" }, formatTimestamp(thread.updated_at))
            );
          })
        )
      );
    })
  );
}

function DefaultTranscriptEmpty() {
  return h(
    "div",
    { className: "thread-empty" },
    h("h2", null, "No remote session yet"),
    h(
      "p",
      null,
      "After pairing, this page will stream the live relay transcript through the broker."
    )
  );
}

function RelayHomeState({ clientAuth, onSelectRelay, relayDirectory }) {
  if (!(relayDirectory || []).length) {
    return h(
      "div",
      { className: "thread-empty relay-home-empty" },
      h("span", { className: "thread-empty-badge" }, "Pairing"),
      h("h2", null, clientAuth ? "No relays yet" : "Pair your first relay"),
      h(
        "p",
        null,
        clientAuth
          ? "This browser has a client identity but no relay grants yet. Open a new QR code from a local relay to add one here."
          : "Open a pairing QR code from your local relay to add your first remote surface to this browser."
      )
    );
  }

  return h(
    "div",
    { className: "relay-home" },
    h(
      "section",
      { className: "thread-empty relay-home-empty" },
      h("span", { className: "thread-empty-badge" }, "My relays"),
      h("h2", null, "Choose a relay"),
      h(
        "p",
        null,
        "This browser already has access to one or more relays. Open one below, or pair another from your local machine."
      )
    ),
    h(
      "section",
      { className: "relay-home-list" },
      ...relayDirectory.map((relay) =>
        h(RelayHomeCard, {
          key: relay.relayId || relay.brokerRoomId || relay.deviceId,
          onSelectRelay,
          relay,
        })
      )
    )
  );
}

function RelayHomeCard({ onSelectRelay, relay }) {
  const relayId = relay.relayId || relay.brokerRoomId || relay.deviceId || "";
  const title =
    relay.relayLabel
    || relay.relayId
    || relay.brokerRoomId
    || relay.deviceLabel
    || relay.deviceId
    || "Unknown relay";
  const subtitle = relay.hasLocalProfile
    ? relay.deviceLabel || relay.deviceId
    : relay.needsLocalRePairing
      ? "Local credentials are missing in this browser. Pair this relay again to restore remote access."
      : "This browser can see the grant, but it does not have local encrypted access for this relay yet.";
  const meta = relay.grantedAt
    ? `Granted ${formatTimestamp(relay.grantedAt)}`
    : relay.brokerRoomId || relayId;
  const cta = relay.hasLocalProfile
    ? "Open relay"
    : relay.needsLocalRePairing
      ? "Re-pair in this browser"
      : "Pair again in this browser";

  return h(
    "button",
    {
      className: "relay-home-card",
      disabled: !relay.hasLocalProfile || !relayId,
      onClick: () => onSelectRelay(relayId),
      type: "button",
    },
    h(
      "div",
      { className: "relay-home-card-copy" },
      h("span", { className: "relay-home-card-label" }, title),
      h("strong", { className: "relay-home-card-title" }, title),
      h("p", { className: "relay-home-card-body" }, subtitle)
    ),
    h(
      "div",
      { className: "relay-home-card-meta" },
      h("span", null, meta),
      h("span", null, cta)
    )
  );
}

function MissingCredentialsState({ remoteAuth }) {
  const relayLabel = remoteAuth?.relayLabel || remoteAuth?.deviceLabel || "This relay";
  return h(
    "div",
    { className: "thread-empty relay-home-empty" },
    h("span", { className: "thread-empty-badge" }, "Re-pair required"),
    h("h2", null, "Local credentials missing"),
    h(
      "p",
      null,
      `${relayLabel} is still known to this browser, but its local encrypted credentials are unavailable.`
    ),
    h("p", null, "Pair this relay again on this device to restore remote access.")
  );
}

function ReadyTranscriptState({ canWrite, session }) {
  const title = canWrite ? "Session ready" : "Session active on another device";
  const copy = canWrite
    ? "The remote session is live. Send the first prompt below when you're ready."
    : "This thread is already open, but another device currently has control. Take over to send the first prompt from here.";
  const detailParts = [];

  if (session.current_cwd) {
    detailParts.push(`Workspace: ${session.current_cwd}`);
  }
  if (session.active_thread_id) {
    detailParts.push(`Thread: ${shortId(session.active_thread_id)}`);
  }

  return h(
    "div",
    { className: "thread-empty thread-empty-ready" },
    h("span", { className: "thread-empty-badge" }, canWrite ? "Ready" : "Waiting"),
    h("h2", null, title),
    h("p", null, copy),
    detailParts.length
      ? h("p", { className: "thread-empty-detail" }, detailParts.join(" · "))
      : null
  );
}

function TranscriptMarkupState({ hydrationLoading, markup }) {
  return h(
    React.Fragment,
    null,
    hydrationLoading
      ? h("div", { className: "transcript-loading-banner" }, "Loading earlier transcript…")
      : null,
    h("div", {
      className: "transcript-react-root",
      dangerouslySetInnerHTML: { __html: markup },
    })
  );
}

function Composer({ composerDisabled, currentEffortValue, messagePlaceholder }) {
  return h(
    "div",
    { className: "composer-inner" },
    h("textarea", {
      disabled: composerDisabled,
      id: "remote-message-input",
      placeholder: messagePlaceholder,
      rows: 3,
    }),
    h(
      "div",
      { className: "composer-actions" },
      h(
        "label",
        { className: "composer-select", htmlFor: "remote-message-effort" },
        h("span", null, "Effort"),
        h(
          "select",
          {
            defaultValue: currentEffortValue,
            id: "remote-message-effort",
          },
          h("option", { value: "medium" }, "medium"),
          h("option", { value: "low" }, "low"),
          h("option", { value: "high" }, "high")
        )
      ),
      h(
        "button",
        {
          className: "send-button",
          disabled: composerDisabled,
          id: "remote-send-button",
          type: "submit",
        },
        "Send"
      )
    )
  );
}
