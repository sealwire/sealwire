import React from "react";
import { ClientLog } from "../shared/client-log.js";
import { ConversationComposer } from "../shared/composer.js";
import { StartSessionDialog } from "../shared/start-session-dialog.js";
import { ThemePickerRow } from "../shared/theme-picker.js";
import { PLUS_SVG, ARROW_RETURN_SVG, CHEVRON_RIGHT_SVG } from "../svg.js";

const h = React.createElement;

function iconNode(svgMarkup, extraClass = "") {
  return h("span", {
    className: extraClass ? `inline-icon ${extraClass}` : "inline-icon",
    "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: svgMarkup },
  });
}

function Sidebar({ launchModel = null, onLaunchFieldChange = null, onLaunchStart = null }) {
  return h(
    "aside",
    { className: "sidebar" },
    h(AuthForm),
    h(LaunchPanel, { launchModel, onLaunchFieldChange, onLaunchStart }),
    h(ThreadDrawer),
    h(ThreadContextMenu)
  );
}

function AuthForm() {
  return h(
    "form",
    { className: "workspace-form auth-form", hidden: true, id: "connection-form" },
    h("label", { className: "sidebar-label", htmlFor: "api-token-input" }, "API Token"),
    h(
      "div",
      { className: "workspace-picker" },
      h("input", {
        autoComplete: "off",
        id: "api-token-input",
        placeholder: "Enter RELAY_API_TOKEN to sign in",
        type: "password",
      }),
      h("button", { className: "load-button", id: "apply-token-button", type: "submit" }, "Sign In")
    )
  );
}

function LaunchPanel({ launchModel = null, onLaunchFieldChange = null, onLaunchStart = null }) {
  const m = launchModel || {};
  return h(
    "section",
    { className: "launch-panel" },
    h("h2", { className: "launch-title" }, "Sessions"),
    h(
      "div",
      { className: "launch-actions" },
      h(
        "button",
        {
          className: "start-session-button",
          id: "open-start-session-dialog",
          onClick: () => document.getElementById("launch-start-session-dialog")?.setAttribute("open", ""),
          type: "button",
        },
        iconNode(PLUS_SVG),
        h("span", null, "New session")
      ),
      h(
        "button",
        { className: "secondary-button", id: "resume-latest-button", type: "button" },
        iconNode(ARROW_RETURN_SVG),
        h("span", null, "Continue latest")
      )
    ),
    h(StartSessionDialog, {
      id: "launch-start-session-dialog",
      cwd: m.fields?.cwd || "",
      fields: m.fields || {},
      onFieldChange: onLaunchFieldChange || (() => {}),
      onStart: () => {
        document.getElementById("launch-start-session-dialog")?.close();
      },
      startPending: false,
      providerOptions: m.providerOptions || [],
      models: m.models || [],
      approvalOptions: m.approvalOptions || [],
      effortOptions: m.effortOptions || [],
      workspaceInputId: "cwd-input",
      suggestionsListId: "workspace-suggestions",
      startButtonId: "start-session-button",
      settingsPrefix: "",
      directoryFormId: "directory-form",
      loadButtonId: "load-directory-button",
      requireInitialPrompt: false,
    })
  );
}

function ThreadDrawer() {
  return h(
    "details",
    { className: "sidebar-drawer" },
    h(
      "summary",
      { className: "sidebar-drawer-summary" },
      h(
        "div",
        null,
        h("p", { className: "sidebar-caption" }, "Threads"),
        h("p", { className: "sidebar-hint", id: "threads-count" }, "Loading workspace groups...")
      )
    ),
    h(
      "div",
      { className: "sidebar-drawer-body" },
      h("button", {
        className: "secondary-button sidebar-home-button",
        hidden: true,
        id: "go-console-home-sidebar",
        type: "button",
      }, "Back to console"),
      h(
        "div",
        { className: "sidebar-row" },
        h("div", null, h("p", { className: "sidebar-caption" }, "Workspace Folders")),
        h("button", { className: "sidebar-link-button", id: "threads-refresh-button", type: "button" }, "Refresh")
      ),
      h(
        "div",
        {
          className: "conversation-list",
          "data-thread-list-scroll-root": "",
          id: "threads-list",
        },
        h("p", { className: "sidebar-empty" }, "Threads will appear here once the relay loads saved workspaces.")
      )
    )
  );
}

function ThreadContextMenu() {
  return h(
    "div",
    { className: "context-menu", hidden: true, id: "thread-context-menu" },
    h("button", { className: "context-menu-button", id: "archive-thread-button", type: "button" }, "Archive session"),
    h("button", {
      className: "context-menu-button context-menu-button-danger",
      id: "delete-thread-button",
      type: "button",
    }, "Delete permanently")
  );
}

function HeaderOverflowIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16" },
    h("circle", { cx: "3", cy: "8", fill: "currentColor", r: "1.5" }),
    h("circle", { cx: "8", cy: "8", fill: "currentColor", r: "1.5" }),
    h("circle", { cx: "13", cy: "8", fill: "currentColor", r: "1.5" })
  );
}

function ChatHeader() {
  return h(
    "header",
    { className: "chat-header" },
    h(
      "div",
      { className: "chat-heading" },
      h("h1", { id: "workspace-title" }, "Relay console"),
      h("p", { className: "chat-subtitle", id: "workspace-subtitle" })
    ),
    h(
      "div",
      { className: "chat-header-actions" },
      h("span", {
        className: "model-badge-compact",
        hidden: true,
        id: "local-model-badge",
      }),
      h("span", { className: "status-badge", id: "status-badge" }, "Idle"),
      h(
        "button",
        { className: "header-button", hidden: true, id: "go-console-home", type: "button" },
        "Back"
      ),
      h(
        "button",
        { className: "header-button", id: "open-security-header", type: "button" },
        "Devices"
      ),
      h(
        "div",
        { className: "header-overflow-wrap" },
        h(
          "button",
          {
            "aria-label": "More options",
            className: "header-button header-overflow-button",
            id: "header-overflow-button",
            type: "button",
          },
          h(HeaderOverflowIcon)
        ),
        h(
          "div",
          { className: "header-overflow-menu", hidden: true, id: "header-overflow-menu" },
          h("button", { className: "overflow-menu-item", id: "open-session-details", type: "button" }, "Session details"),
          h("button", { className: "overflow-menu-item", id: "refresh-button", type: "button" }, "Refresh"),
          h(ThemePickerRow)
        )
      )
    )
  );
}

function OverviewStrip() {
  return h(
    "section",
    { "aria-label": "Relay overview", className: "overview-strip", id: "overview-strip" },
    h("div", { className: "overview-status-bar", id: "overview-security-badges" })
  );
}

function ConsoleGrid() {
  return h(
    "section",
    { className: "console-grid" },
    h(LiveSurfacesCard),
    h(AuditTimelineCard),
    h(ConsoleFooterHint),
    h(ThreadPanel)
  );
}

function LiveSurfacesCard() {
  return h(
    "section",
    { className: "console-card console-card-surfaces console-card-hero" },
    h(
      "div",
      { className: "console-card-header" },
      h(
        "div",
        { className: "console-card-title-row" },
        h("h2", { className: "console-card-title" }, "Devices"),
        h("span", { className: "console-card-hint", id: "live-surfaces-summary" })
      ),
      h(
        "button",
        { className: "load-button console-card-action", id: "open-security-console", type: "button" },
        "Manage"
      )
    ),
    h(
      "div",
      { className: "surface-list", id: "live-surfaces-list" },
      h("p", { className: "sidebar-empty" }, "No devices paired yet.")
    )
  );
}

function AuditTimelineCard() {
  return h(
    "details",
    { className: "console-card console-card-audit console-card-collapsible", open: true },
    h(
      "summary",
      { className: "console-card-summary" },
      h("span", { className: "console-card-title" }, "Recent events"),
      h("span", { className: "console-card-hint", id: "audit-summary" }),
      h("span", {
        className: "console-card-summary-chevron",
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: CHEVRON_RIGHT_SVG },
      })
    ),
    h(
      "div",
      { className: "audit-list", id: "audit-timeline" },
      h("p", { className: "sidebar-empty" }, "No events yet.")
    )
  );
}

function ConsoleFooterHint() {
  return h(
    "p",
    { className: "console-footer-hint" },
    "Start a session from the sidebar to open the live transcript."
  );
}

function ThreadPanel() {
  return h(
    "section",
    { className: "thread-panel" },
    h(
      "section",
      { className: "control-banner", hidden: true, id: "control-banner" },
      h(
        "div",
        null,
        h("p", { className: "control-summary", id: "control-summary" }, "This device has control"),
        h("p", { className: "control-hint", id: "control-hint" }, "Only the active device can type, but any owner device can approve.")
      ),
      h("button", { className: "header-button control-button", id: "take-over-button", type: "button" }, "Take over")
    ),
    h(
      "section",
      { className: "thread-shell" },
      h(
        "div",
        { className: "chat-thread", id: "transcript" },
        h(
          "div",
          { className: "thread-empty" },
          h("h2", null, "Relay standing by"),
          h("p", null, "Load a workspace, then use this console to watch the live session, control state, and trusted devices.")
        )
      )
    )
  );
}

function ComposerShell() {
  return h(
    "form",
    { className: "composer-shell", hidden: true, id: "message-form" },
    h(ConversationComposer, {
      effortId: "message-effort",
      effortLabel: "Response mode",
      messageId: "message-input",
      messagePlaceholder: "Start or resume a session first.",
      modelId: "message-model",
      modelLabel: "Model",
      models: [{ display_name: "gpt-5.4", model: "gpt-5.4" }],
      sendButtonId: "send-button",
      stopButtonId: "stop-button",
    })
  );
}

function ChatShell() {
  return h(
    "main",
    { className: "chat-shell" },
    h(ChatHeader),
    h(OverviewStrip),
    h(ConsoleGrid),
    h("div", { className: "pending-action-banner", id: "pending-action-banner", hidden: true }),
    h(ComposerShell)
  );
}

function SessionDetailsModal() {
  return h(
    "dialog",
    { className: "panel-modal panel-modal-wide", id: "session-details-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Relay details"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-session-details-modal",
        type: "button",
      }, "\u00d7")
    ),
    h(
      "section",
      { className: "panel-modal-body session-details-shell" },
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Environment"),
        h("section", { className: "session-meta", id: "session-meta" }, h("span", { className: "meta-empty" }, "Session details will appear here."))
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Relay log"),
        h(
          "div",
          { id: "client-log-root" },
          h(ClientLog, {
            lines: ["Booting web client..."],
          })
        )
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Build"),
        h("p", { className: "build-info-inline", id: "build-info-local" }, "Loading...")
      )
    )
  );
}

function SecurityModal() {
  return h(
    "dialog",
    { className: "security-modal", id: "security-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Remote devices"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-security-modal",
        type: "button",
      }, "\u00d7")
    ),
    h(
      "section",
      { className: "remote-access-shell" },
      h(
        "div",
        { className: "sidebar-row" },
        h(
          "div",
          null,
          h("p", { className: "sidebar-caption" }, "Remote Pairing"),
          h("p", { className: "sidebar-hint" }, "Create a QR link for the broker-hosted mobile surface.")
        ),
        h("button", { className: "sidebar-link-button", id: "start-pairing-button", type: "button" }, "New QR")
      ),
      h(
        "section",
        { className: "pairing-panel", hidden: true, id: "pairing-panel" },
        h("div", { "aria-live": "polite", className: "pairing-qr", id: "pairing-qr" }),
        h("p", { className: "pairing-copy", id: "pairing-expiry" }, "Pairing ticket not created yet."),
        h("label", { className: "sidebar-label", htmlFor: "pairing-link-input" }, "Pairing Link"),
        h(
          "div",
          { className: "workspace-picker" },
          h("input", { id: "pairing-link-input", readOnly: true, type: "text" }),
          h("button", { className: "load-button", id: "copy-pairing-link-button", type: "button" }, "Copy")
        )
      ),
      hSecuritySection("Workspace Roots", "Limit every device on this relay to specific root directories. Leave empty for unrestricted access."),
      hAllowedRootsForm(),
      h(
        "div",
        { className: "paired-devices-list", id: "allowed-roots-list" },
        h("p", { className: "sidebar-empty" }, "No workspace restrictions are configured.")
      ),
      hSecuritySection("Device Security", "Review known devices, fingerprints, and broker access."),
      h(
        "div",
        { className: "paired-devices-list", id: "paired-devices-list" },
        h("p", { className: "sidebar-empty" }, "No remote devices have touched this relay yet.")
      ),
      hSecuritySection("Pending Pairing Requests", "Approve or reject devices that are asking to pair."),
      h(
        "div",
        { className: "paired-devices-list", id: "pending-pairings-list" },
        h("p", { className: "sidebar-empty" }, "No devices are waiting for local approval.")
      )
    )
  );
}

function hSecuritySection(caption, hint) {
  return h(
    "div",
    { className: "sidebar-row" },
    h(
      "div",
      null,
      h("p", { className: "sidebar-caption" }, caption),
      h("p", { className: "sidebar-hint" }, hint)
    )
  );
}

function hAllowedRootsForm() {
  return h(
    "form",
    { className: "workspace-form", id: "allowed-roots-form" },
    h("label", { className: "sidebar-label", htmlFor: "allowed-roots-input" }, "Allowed Roots"),
    h("textarea", {
      id: "allowed-roots-input",
      placeholder: "~/projects\n~/Documents/projects",
      rows: "4",
    }),
    h(
      "div",
      { className: "workspace-picker" },
      h("button", { className: "load-button", id: "save-allowed-roots-button", type: "submit" }, "Save roots")
    ),
    h("p", { className: "sidebar-hint", id: "allowed-roots-summary" }, "This relay is currently unrestricted.")
  );
}

export function LocalShell({ launchModel = null, onLaunchFieldChange = null, onLaunchStart = null }) {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "app-shell" },
      h(Sidebar, { launchModel, onLaunchFieldChange, onLaunchStart }),
      h(ChatShell)
    ),
    h(SessionDetailsModal),
    h(SecurityModal)
  );
}
