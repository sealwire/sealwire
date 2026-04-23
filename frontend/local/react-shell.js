import React from "react";
import { ConversationComposer } from "../shared/composer.js";

const h = React.createElement;

function Sidebar() {
  return h(
    "aside",
    { className: "sidebar" },
    h(AuthForm),
    h(LaunchPanel),
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

function LaunchPanel() {
  return h(
    "section",
    { className: "launch-panel" },
    h(
      "div",
      { className: "launch-copy" },
      h("p", { className: "sidebar-caption" }, "Relay console"),
      h("h2", { className: "launch-title" }, "Load a workspace"),
      h(
        "p",
        { className: "launch-body" },
        "Point this relay at the project you care about, then start or resume a session when you need local control."
      )
    ),
    h(
      "form",
      { className: "workspace-form", id: "directory-form" },
      h("label", { className: "sidebar-label", htmlFor: "cwd-input" }, "Workspace"),
      h(
        "div",
        { className: "workspace-picker" },
        h("input", {
          id: "cwd-input",
          placeholder: "/path/to/project or ~/project",
          type: "text",
        }),
        h("button", { className: "load-button", id: "load-directory-button", type: "submit" }, "Load")
      )
    ),
    h(
      "div",
      { className: "launch-actions" },
      h("button", { className: "start-session-button", id: "start-session-button", type: "button" }, "Start Session"),
      h("button", { className: "secondary-button", id: "resume-latest-button", type: "button" }, "Continue Latest")
    ),
    h(
      "div",
      { className: "launch-footer" },
      h("button", { className: "sidebar-link-button", id: "open-launch-settings", type: "button" }, "Launch options"),
      h("button", { className: "sidebar-link-button", id: "open-security-modal", type: "button" }, "Remote devices")
    )
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
        { className: "conversation-list", id: "threads-list" },
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
      h("span", { className: "chat-heading-label" }, "Relay"),
      h("h1", { id: "workspace-title" }, "Relay console"),
      h(
        "p",
        { className: "chat-subtitle", id: "workspace-subtitle" },
        "Monitor live control, trusted devices, and the active session from here."
      )
    ),
    h(
      "div",
      { className: "chat-header-actions" },
      h("span", { className: "status-badge", id: "status-badge" }, "Idle"),
      h("button", { className: "header-button", hidden: true, id: "go-console-home", type: "button" }, "Back"),
      h("button", { className: "header-button", id: "open-security-header", type: "button" }, "Devices"),
      h("button", { className: "header-button", id: "open-session-details", type: "button" }, "Details"),
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
          h("button", { className: "overflow-menu-item", id: "refresh-button", type: "button" }, "Refresh")
        )
      )
    )
  );
}

function OverviewStrip() {
  return h(
    "section",
    { "aria-label": "Relay overview", className: "overview-strip", id: "overview-strip" },
    h(
      "article",
      { className: "overview-card overview-card-primary" },
      h("p", { className: "overview-label" }, "Live Session"),
      h(
        "div",
        { className: "overview-body" },
        h(
          "div",
          null,
          h("h2", { className: "overview-title", id: "overview-session-title" }, "Pick a workspace to launch"),
          h(
            "p",
            { className: "overview-copy", id: "overview-session-copy" },
            "Load a workspace, inspect relay state, and start or resume a session when you need it."
          )
        ),
        h("div", { className: "overview-badges", id: "overview-session-badges" })
      )
    ),
    h(
      "article",
      { className: "overview-card overview-card-secondary" },
      h("p", { className: "overview-label" }, "Trust & Privacy"),
      h(
        "div",
        { className: "overview-body" },
        h(
          "div",
          null,
          h("h2", { className: "overview-title", id: "overview-security-title" }, "Private by default"),
          h(
            "p",
            { className: "overview-copy", id: "overview-security-copy" },
            "Watch broker posture, paired devices, and visibility guarantees without leaving the live console."
          )
        ),
        h("div", { className: "overview-badges", id: "overview-security-badges" })
      )
    )
  );
}

function ConsoleGrid() {
  return h(
    "section",
    { className: "console-grid" },
    h(LiveSurfacesCard),
    h(AuditTimelineCard),
    h(ThreadPanel)
  );
}

function LiveSurfacesCard() {
  return h(
    "section",
    { className: "console-card console-card-surfaces" },
    h(
      "div",
      { className: "console-card-header" },
      h(
        "div",
        null,
        h("p", { className: "sidebar-caption" }, "Live Surfaces"),
        h(
          "p",
          { className: "sidebar-hint", id: "live-surfaces-summary" },
          "See which devices are trusted, pending, or currently controlling the active session."
        )
      ),
      h("button", { className: "sidebar-link-button", id: "open-security-console", type: "button" }, "Manage")
    ),
    h(
      "div",
      { className: "surface-list", id: "live-surfaces-list" },
      h("p", { className: "sidebar-empty" }, "No relay surfaces are active yet.")
    )
  );
}

function AuditTimelineCard() {
  return h(
    "section",
    { className: "console-card console-card-audit" },
    h(
      "div",
      { className: "console-card-header" },
      h(
        "div",
        null,
        h("p", { className: "sidebar-caption" }, "Audit Timeline"),
        h(
          "p",
          { className: "sidebar-hint", id: "audit-summary" },
          "Recent relay, control, and security events will appear here."
        )
      )
    ),
    h(
      "div",
      { className: "audit-list", id: "audit-timeline" },
      h("p", { className: "sidebar-empty" }, "No relay events yet.")
    )
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
      sendButtonId: "send-button",
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
    h(ComposerShell)
  );
}

function LaunchSettingsModal() {
  return h(
    "dialog",
    { className: "panel-modal", id: "launch-settings-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Launch options"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-launch-settings-modal",
        type: "button",
      }, "\u00d7")
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h(
        "p",
        { className: "panel-modal-copy" },
        "Most people can leave these alone. Change them only if you need a different startup behavior."
      ),
      h(
        "div",
        { className: "settings-grid" },
        h(
          "label",
          { className: "field" },
          h("span", null, "Model"),
          h("select", { id: "model-input" }, h("option", { value: "gpt-5.4" }, "gpt-5.4"))
        ),
        h(
          "label",
          { className: "field" },
          h("span", null, "Permission mode"),
          h(
            "select",
            { id: "approval-policy-input" },
            h("option", { value: "untrusted" }, "untrusted"),
            h("option", { value: "on-request" }, "on-request"),
            h("option", { value: "never" }, "never")
          )
        ),
        h(
          "label",
          { className: "field" },
          h("span", null, "File access"),
          h(
            "select",
            { id: "sandbox-input" },
            h("option", { value: "workspace-write" }, "workspace-write"),
            h("option", { value: "read-only" }, "read-only"),
            h("option", { value: "danger-full-access" }, "danger-full-access")
          )
        ),
        h(
          "label",
          { className: "field" },
          h("span", null, "Default effort"),
          h(
            "select",
            { id: "start-effort" },
            h("option", { value: "medium" }, "medium"),
            h("option", { value: "low" }, "low"),
            h("option", { value: "high" }, "high")
          )
        ),
        h(
          "label",
          { className: "field field-full" },
          h("span", null, "Initial prompt"),
          h("textarea", {
            id: "start-prompt",
            placeholder: "Optional first task for the new session.",
            rows: "4",
          })
        )
      )
    )
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
        h("pre", { className: "client-log", id: "client-log" }, "Booting web client...")
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

export function LocalShell() {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "app-shell" },
      h(Sidebar),
      h(ChatShell)
    ),
    h(LaunchSettingsModal),
    h(SessionDetailsModal),
    h(SecurityModal)
  );
}
