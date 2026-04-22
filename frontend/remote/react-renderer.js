import React from "react";
import { canonicalizeWorkspace } from "../shared/thread-groups.js";
import { formatTimestamp, shortId } from "./utils.js";

const h = React.createElement;

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

function relaySubtitle(relay) {
  if (relay.hasLocalProfile) {
    return relay.deviceLabel || relay.deviceId;
  }

  if (relay.needsLocalRePairing) {
    return "Local credentials are missing in this browser. Pair this relay again to restore encrypted access.";
  }

  return "Grant exists, but this browser does not have local encrypted access yet.";
}

export function WorkspaceHeading({ header, statusBadge }) {
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

export function SessionPanel({
  cwdInputRef = null,
  model,
  onFieldChange = null,
  onStartSession = null,
}) {
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
          onChange: (event) => onFieldChange?.("cwd", event.target.value),
          placeholder: "/path/to/project",
          ref: cwdInputRef,
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
        onClick: onStartSession,
        type: "button",
      },
      model.startPending ? "Starting..." : "Start Session"
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
              onChange: (event) => onFieldChange?.("model", event.target.value),
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
              onChange: (event) => onFieldChange?.("approvalPolicy", event.target.value),
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
              onChange: (event) => onFieldChange?.("sandbox", event.target.value),
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
              onChange: (event) => onFieldChange?.("effort", event.target.value),
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
            onChange: (event) => onFieldChange?.("initialPrompt", event.target.value),
            placeholder: "Optional first task for the new remote session.",
            rows: 4,
            value: model.fields.initialPrompt,
          })
        )
      )
    )
  );
}

export function SessionMetaPanel({ model }) {
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

export function DeviceMetaPanel({ model }) {
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

export function ControlBanner({ model, onTakeOver = null }) {
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
        onClick: onTakeOver,
        type: "button",
      },
      "Take over"
    )
  );
}

export function RelayDirectoryList({ onSelectRelay, viewModel }) {
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

export function ThreadList({
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

export function DefaultTranscriptEmpty() {
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

export function RelayHomeState({ clientAuth, onSelectRelay, relayDirectory }) {
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

export function MissingCredentialsState({ remoteAuth }) {
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

export function ReadyTranscriptState({ canWrite, session }) {
  const title = canWrite ? "Session ready" : "Session active on another device";
  const copy = canWrite
    ? "The remote session is live. Send the first prompt below when you're ready."
    : "This thread is already open, but another device currently has control. You can still approve or decline requests here; take over only if you want to send messages from this device.";
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

export function TranscriptMarkupState({ hydrationLoading, markup, onApprovalClick, onScroll }) {
  return h(
    React.Fragment,
    null,
    hydrationLoading
      ? h("div", { className: "transcript-loading-banner" }, "Loading earlier transcript…")
      : null,
    h("div", {
      className: "transcript-react-root",
      dangerouslySetInnerHTML: { __html: markup },
      onClick: onApprovalClick,
      onScroll,
    })
  );
}

export function Composer({
  composerDisabled,
  currentDraft,
  currentEffortValue,
  messagePlaceholder,
  onDraftChange = null,
  onEffortChange = null,
  sendPending,
}) {
  const submitDisabled = composerDisabled || sendPending;
  return h(
    "div",
    { className: "composer-inner" },
    h("textarea", {
      disabled: submitDisabled,
      id: "remote-message-input",
      onChange: (event) => onDraftChange?.(event.target.value),
      placeholder: messagePlaceholder,
      rows: 3,
      value: currentDraft,
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
            id: "remote-message-effort",
            onChange: (event) => onEffortChange?.(event.target.value),
            value: currentEffortValue,
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
          disabled: submitDisabled,
          id: "remote-send-button",
          type: "submit",
        },
        sendPending ? "Sending..." : "Send"
      )
    )
  );
}
