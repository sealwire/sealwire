import React from "react";
import { StartSessionDialog } from "../shared/start-session-dialog.js";
import { ConversationHeadingBody } from "../shared/conversation-header.js";
export { ConversationComposer as Composer } from "../shared/composer.js";
export { SessionSettingsFields } from "../shared/session-settings-fields.js";
import { formatTimestamp, shortId } from "./utils.js";

const h = React.createElement;

function compactStatusLabel(label) {
  const normalized = String(label || "").trim().toLowerCase();

  switch (normalized) {
    case "approval required":
      return "Approval";
    case "re-pair required":
      return "Re-pair";
    case "pairing failed":
      return "Failed";
    case "review in progress":
      return "Review";
    case "review blocked — action needed":
      return "Review blocked";
    case "code flow in progress":
      return "Code Flow";
    case "code flow blocked — action needed":
      return "Code Flow blocked";
    default:
      return label
        ? String(label)
            .trim()
            .replace(/\b\w/g, (char) => char.toUpperCase())
        : "";
  }
}

function shouldShowHeaderStatusBadge(statusBadge) {
  return Boolean(statusBadge?.label && statusBadge.headerVisible === true);
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

function InfoIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("circle", { cx: "8", cy: "8", r: "6.25" }),
    h("line", { x1: "8", y1: "7.3", x2: "8", y2: "11.5" }),
    h("circle", { cx: "8", cy: "5", r: "0.7", fill: "currentColor", stroke: "none" })
  );
}

export function WorkspaceHeading({ header, statusBadge, onOpenInfo, titleNode = null }) {
  const subtitle = header?.subtitle || "";
  const showStatus = shouldShowHeaderStatusBadge(statusBadge);

  // The title row + subtitle structure is shared with local now — this function is down to
  // deciding WHICH nodes go in the slots, which is the part that is genuinely remote's
  // (a status badge that can be absent, a pairing-aware fallback title).
  return h(ConversationHeadingBody, {
    titleNode: titleNode
      ? titleNode
      : h(
          "h1",
          {
            id: "remote-workspace-title",
            title: header?.titleTitle || "",
          },
          header?.title || "Pair this browser"
        ),
    statusNode: showStatus
      ? h(
          "span",
          {
            "aria-label": statusBadge.label,
            className: `status-badge status-badge-${statusBadge.tone} status-badge-compact`,
            id: "remote-status-badge",
            title: statusBadge.label,
          },
          compactStatusLabel(statusBadge.label)
        )
      : null,
    infoButton: onOpenInfo
      ? h(
          "button",
          {
            "aria-label": "Session details",
            className: "header-icon-button chat-heading-info-button",
            id: "remote-open-session-details",
            onClick: onOpenInfo,
            title: "Session details",
            type: "button",
          },
          h(InfoIcon)
        )
      : null,
    subtitleNode: h(
      "p",
      {
        className: "chat-subtitle",
        hidden: header?.subtitleHidden ?? !subtitle,
        id: "remote-workspace-subtitle",
        title: header?.subtitleTitle || subtitle,
      },
      subtitle
    ),
  });
}

export function SessionPanel({
  model,
  onFieldChange = null,
  onSelectModel = null,
  onStartSession = null,
}) {
  if (!model.hasRemoteAuth) {
    return null;
  }

  const effortOptions = model.effortOptions?.length
    ? model.effortOptions
    : [
        { label: "medium", value: "medium" },
        { label: "low", value: "low" },
        { label: "high", value: "high" },
        { label: "xhigh", value: "xhigh" },
      ];

  return h(StartSessionDialog, {
    id: "remote-start-session-dialog",
    // `cwd` now travels inside `fields` like every other value, so the dialog has
    // one shape of input instead of one field plus a special case.
    fields: model.fields,
    onFieldChange,
    onOpenModelPicker: model.onOpenModelPicker,
    onSelectModel,
    onStart: onStartSession,
    startPending: model.startPending,
    workspaceSuggestions: model.workspaceSuggestions,
    gitContext: model.gitContext,
    // The merged Model pill needs every provider's catalog, not just the
    // selected one's. Remote already pre-fetches them all on connect.
    providers: model.providers,
    providerModels: model.providerModels,
    modelsStatus: model.modelsStatus,
    approvalOptions: model.approvalOptions,
    effortOptions,
    projects: model.projects,
    threads: model.threads,
    threadProjectId: model.threadProjectId,
    threadActivity: model.threadActivity,
    threadAttention: model.threadAttention,
    threadReviewing: model.threadReviewing,
    onCreateProject: model.onCreateProject,
    // Remote passes no attachment mount: a paired device cannot send image
    // bytes, so the placeholder must not invite a paste.
    // Mirror local: Claude supports deferred start — the relay accepts no
    // initial prompt and promotes the session on the first composer message.
    requireInitialPrompt: false,
  });
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

export function ControlBanner({ model, onRepairWorkspace = null, onTakeOver = null }) {
  if (model.hidden) {
    return null;
  }

  // `{ label, pending, error, kind, threadId }` when the viewed thread's workspace is
  // gone — see remote/workspace-repair.js. The banner is one slot, so this and Take over
  // are mutually exclusive by construction: the model never offers both.
  const repair = model.repair || null;

  return h(
    React.Fragment,
    null,
    h(
      "span",
      {
        className: "control-summary",
        // The summary carries a recorded cwd shortened from the middle to survive a
        // phone; this puts the whole path back within reach.
        title: model.summaryTitle || undefined,
      },
      model.summary
    ),
    // Stays mounted (hidden) rather than swapped out, so nothing that resolves
    // `#remote-take-over-button` loses its element when the repair banner takes over.
    h(
      "button",
      {
        className: "control-button",
        hidden: model.takeOverHidden,
        id: "remote-take-over-button",
        onClick: onTakeOver,
        type: "button",
      },
      "Take over"
    ),
    repair
      ? h(
        "button",
        {
          className: "control-button",
          disabled: repair.pending,
          id: "remote-workspace-repair-button",
          onClick: () => onRepairWorkspace?.(repair.threadId),
          type: "button",
        },
        repair.label
      )
      : null,
    // Which branch comes back with the worktree, or what re-creating a folder buys. Only
    // the repair banner shows a hint line — the compact bar has no room otherwise.
    // `flexBasis` inline because the banner's own class has no full-width hint rule.
    repair
      ? h(
        "p",
        { className: "control-hint", style: { flexBasis: "100%", margin: 0 } },
        model.hint
      )
      : null,
    // The relay's own failure text, verbatim, on its own line. Swallowing it would put
    // the user back where this change started: an action that stops working with nothing
    // on screen to say why.
    repair?.error
      ? h("p", { className: "control-banner-error", role: "alert" }, repair.error)
      : null
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
        // Same 3-column grid as session rows (`14px | 1fr | auto`). An empty
        // lead slot is load-bearing: without it the title occupies the 14px
        // track and ellipsises to one character while meta sits in the 1fr.
        h("span", { className: "conversation-lead", "aria-hidden": "true" }),
        h("span", { className: "conversation-title" }, item.title),
        h("span", { className: "conversation-preview" }, relaySubtitle(item.relay)),
        h(
          "span",
          { className: "conversation-meta" },
          item.meta ? `${item.meta} · ${item.actionLabel}` : item.actionLabel
        )
      )
    )
  );
}

export function RelayHomeState({ clientAuth, nicknames, onRenameRelay, onSelectRelay, relayDirectory }) {
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
          nickname: (nicknames && relay.relayId) ? (nicknames[relay.relayId] || null) : null,
          onRenameRelay,
          onSelectRelay,
          relay,
        })
      )
    )
  );
}

function RelayHomeCard({ nickname, onRenameRelay, onSelectRelay, relay }) {
  const relayId = relay.relayId || relay.brokerRoomId || relay.deviceId || "";
  const fallbackTitle =
    relay.relayLabel
    || relay.relayId
    || relay.brokerRoomId
    || relay.deviceLabel
    || relay.deviceId
    || "Unknown relay";
  const title = nickname || fallbackTitle;
  const subtitle = relay.hasLocalProfile
    ? relay.deviceLabel || relay.deviceId
    : relay.needsLocalRePairing
      ? "Local credentials are missing in this browser. Pair this relay again to restore remote access."
      : "This browser can see the grant, but it does not have local encrypted access for this relay yet.";
  const meta = relay.grantedAt ? `Granted ${formatTimestamp(relay.grantedAt)}` : null;
  const cta = relay.hasLocalProfile
    ? "Open relay"
    : relay.needsLocalRePairing
      ? "Re-pair in this browser"
      : "Pair again in this browser";

  const canRename = Boolean(onRenameRelay && relay.relayId);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(nickname || "");

  React.useEffect(() => {
    if (!editing) {
      setDraft(nickname || "");
    }
  }, [nickname, editing]);

  const startEditing = () => {
    setDraft(nickname || "");
    setEditing(true);
  };
  const cancelEditing = () => setEditing(false);
  const commitEditing = () => {
    if (!canRename) {
      setEditing(false);
      return;
    }
    onRenameRelay(relay.relayId, draft);
    setEditing(false);
  };

  if (editing) {
    return h(
      "div",
      { className: "relay-home-card-wrapper is-editing" },
      h(
        "form",
        {
          className: "relay-home-card-edit",
          onSubmit: (event) => {
            event.preventDefault();
            commitEditing();
          },
        },
        h("label", { className: "relay-home-card-edit-label", htmlFor: `relay-rename-${relayId}` }, "Rename relay"),
        h("input", {
          autoFocus: true,
          className: "relay-home-card-edit-input",
          id: `relay-rename-${relayId}`,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          },
          placeholder: fallbackTitle,
          type: "text",
          value: draft,
        }),
        h(
          "div",
          { className: "relay-home-card-edit-actions" },
          h("button", { className: "relay-home-card-edit-save", type: "submit" }, "Save"),
          h(
            "button",
            { className: "relay-home-card-edit-cancel", onClick: cancelEditing, type: "button" },
            "Cancel"
          ),
          nickname
            ? h(
                "button",
                {
                  className: "relay-home-card-edit-clear",
                  onClick: () => {
                    if (canRename) onRenameRelay(relay.relayId, "");
                    setEditing(false);
                  },
                  type: "button",
                },
                "Reset"
              )
            : null
        )
      )
    );
  }

  return h(
    "div",
    { className: "relay-home-card-wrapper" },
    h(
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
        h("strong", { className: "relay-home-card-title" }, title),
        h("p", { className: "relay-home-card-body" }, subtitle)
      ),
      h(
        "div",
        { className: "relay-home-card-meta" },
        meta ? h("span", null, meta) : null,
        h("span", { className: "relay-home-card-cta" }, cta)
      )
    ),
    canRename
      ? h(
          "button",
          {
            "aria-label": nickname ? `Rename ${title}` : `Give ${title} a nickname`,
            className: "relay-home-card-rename",
            onClick: startEditing,
            type: "button",
          },
          nickname ? "Rename" : "Nickname"
        )
      : null
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
