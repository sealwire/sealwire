import React from "react";
import { ClientLog } from "../shared/client-log.js";
import { ConversationComposer } from "../shared/composer.js";
import { RefreshButton } from "../shared/refresh-button.js";
import { ThemePickerRow } from "../shared/theme-picker.js";
import { SidebarBrand, SidebarCollapseToggle, SidebarResizeHandle } from "../shared/sidebar-chrome.js";
import { ConversationHeader, ConversationHeadingBody } from "../shared/conversation-header.js";
// The back arrow, the compose mark and the left-panel toggle moved into
// shared/conversation-header.js with the header markup that used them; only the right-rail
// toggle is still drawn here, because the rail is not part of the shared header.
import { ToggleRightPanelIcon } from "../shared/panel-icons.js";
import {
  CHEVRON_RIGHT_SVG,
  SETTINGS_SVG,
} from "../svg.js";
import {
  getLocalTranscriptSlotSnapshot,
  subscribeLocalTranscriptSlot,
} from "./transcript-slot.js";

const h = React.createElement;

function LocalTranscriptSlot() {
  return React.useSyncExternalStore(
    subscribeLocalTranscriptSlot,
    getLocalTranscriptSlotSnapshot,
    getLocalTranscriptSlotSnapshot
  );
}

// Far-left 64px icon rail: brand logo (top), the same two destinations SidebarNav
// offers, and a Settings gear (bottom). The rail lives OUTSIDE the .app-shell grid
// (in .local-frame) so the grid math is untouched.
//
// The two destinations are no longer written out here. They are the SAME list the
// sidebar rows render, mounted from `shared/sidebar-nav.js` as `SidebarNavRail` —
// which is what stops the rail and the rows drifting. It shipped with a Tasks
// button and no Sessions button for exactly as long as the two were separate
// pieces of markup, so a user who collapsed the panel on the Task screen had no
// way back to their sessions.
//
// The gear stays imperative (wired in app.js by id): it is not a destination, it
// opens a modal.
function IconRail() {
  return h(
    "nav",
    { className: "icon-rail", "aria-label": "Primary" },
    h("img", {
      className: "icon-rail-logo",
      src: "/static/sealwire_logo.png",
      alt: "Sealwire",
      width: 30,
      height: 30,
    }),
    // `display: contents`, so the two buttons rendered in here stay flex children
    // of `.icon-rail` itself — the rail's `gap`, `align-items` and the spacer's
    // `flex: 1` all depend on that.
    h("div", { className: "icon-rail-nav-mount", id: "icon-rail-nav" }),
    h("div", { className: "icon-rail-spacer" }),
    h(
      "button",
      {
        className: "icon-rail-button icon-rail-settings",
        id: "icon-rail-settings",
        type: "button",
        title: "Settings",
        "aria-label": "Settings",
      },
      h("span", { className: "inline-icon", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: SETTINGS_SVG } })
    )
  );
}

function iconNode(svgMarkup, extraClass = "") {
  return h("span", {
    className: extraClass ? `inline-icon ${extraClass}` : "inline-icon",
    "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: svgMarkup },
  });
}

function Sidebar() {
  return h(
    "aside",
    // No `data-thread-view`: it gated the primary action on the Sessions/Projects
    // toggle, and with the toggle gone nothing writes it and nothing reads it. New
    // session is now the sidebar's only primary action in every state.
    { className: "sidebar" },
    h(
      "div",
      { className: "sidebar-top-bar" },
      h(SidebarCollapseToggle, { id: "sidebar-top-toggle" }),
      // Byte-for-byte identical to remote's, so it is now literally the same
      // component. It takes no props, which is why it can render HERE rather than
      // into a mount: this file renders exactly once, and a propless component has
      // nothing to miss out on.
      h(SidebarBrand),
      // Trailing actions — the search and bell toggles. A mount rather than markup,
      // because both of them report state (`is-active`, `aria-expanded`,
      // `aria-pressed`) that app.js used to write onto them by hand.
      //
      // The div IS the mount: local's action row holds nothing but these two, so
      // there is no wrapper to make layout-transparent. Remote's row also carries the
      // Project switcher, which is why the row itself is not the shared thing.
      h("div", { className: "sidebar-top-actions", id: "sidebar-top-actions" })
    ),
    // The search field. Search is a RELAY query, not a filter over the loaded rows —
    // the list is truncated to the newest 120, so the session worth searching for is
    // usually not in it.
    //
    // This mount is the point of the whole exercise. The field used to be static
    // markup here, permanently mounted and toggled with `hidden`, because app.js
    // reached three ids inside it. It is now ABSENT when closed, which is what
    // remote always did — the two implementations of one control have become one.
    h("div", { className: "sidebar-search-mount", id: "sidebar-search-mount" }),
    // No state pills under the bell: turning it on re-groups the list by state, and
    // those bucket headers already say everything a pill row could.
    h(AuthForm),
    // No Sessions/Projects toggle: selecting a project PINS it to the top of a list
    // that stays complete, so there was never a second mode to be in. The Project
    // switcher in the header is the whole control.
    // Mount point, not markup: the rows come from `shared/sidebar-nav.js` and are
    // rendered by render-session with the current destination and the waiting-task
    // count as props. `display: contents`, so `.sidebar-nav` stays a direct flex
    // child of the sidebar column and keeps its own margins.
    h("div", { className: "sidebar-nav-mount", id: "sidebar-nav" }),
    h(LaunchPanel),
    // The Task list, in the sidebar. Filled by renderSidebarTaskList(); CSS-gated
    // to the Tasks view, which also hides the launch panel and the thread drawer
    // below — one sidebar, two mutually exclusive bodies.
    h("div", { className: "sidebar-task-list", id: "sidebar-task-list" }),
    // Teams library list (13a). Same slot pattern as the task list — CSS shows
    // one or the other based on data-view.
    h("div", { className: "sidebar-teams-list", id: "sidebar-teams-list" }),
    h(ThreadDrawer),
    h(ThreadContextMenu),
    h(ProjectContextMenu),
    h("div", { id: "fork-session-dialog-root" }),
    // Footer: what the relay is doing on the left, the way into Settings on the
    // right. The gear is the DESKTOP entry now that the icon rail only exists
    // while the sidebar is collapsed. It is not the only one — this whole bar is
    // `display: none` on local mobile, which is what #open-settings-header in the
    // chat header covers. Wired imperatively in app.js by id, like the rail gear.
    h(
      "div",
      { className: "sidebar-bottom-bar sidebar-host-status", id: "sidebar-host-status" },
      h("span", { className: "sidebar-host-dot", id: "sidebar-host-dot", "aria-hidden": "true" }),
      h("span", { className: "sidebar-host-label", id: "sidebar-host-label" }, "Local relay · Live"),
      h(
        "button",
        {
          className: "sidebar-settings-button",
          id: "sidebar-settings",
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
        },
        iconNode(SETTINGS_SVG)
      )
    ),
    // Same handle remote renders. The id stays local's, because app.js finds it by id
    // to attach the drag maths.
    h(SidebarResizeHandle, { id: "sidebar-resize" })
  );
}

/*
 * `SessionSearch` used to be here: the search field as static markup, always
 * mounted, `hidden: true`.
 *
 * It is now `SidebarSearchField` in `shared/sidebar-chrome.js`, rendered into
 * `#sidebar-search-mount` and ABSENT when closed. This was the one control in the
 * repo whose two implementations were incompatible in kind rather than in detail —
 * remote rendered it conditionally, local could not, because three ids inside it had
 * to resolve for app.js. Retiring those ids is what made one component possible.
 */

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

// A mount, not the control. The split button's right half lists the AVAILABLE agents,
// which this file cannot know: the provider catalogue is fetched after boot into
// `state.providers`, and this shell renders exactly once (see the note above ThreadDrawer),
// so a prop would be frozen empty forever. app.js owns the root and re-renders it, the
// same arrangement the session tab strip already uses.
function LaunchPanel() {
  return h(
    "section",
    { className: "launch-panel" },
    h("div", { className: "launch-actions", id: "start-session-split-mount" })
  );
}


/*
 * The sidebar's two destinations used to be written out here, as `SidebarNav`.
 *
 * They now live in `shared/sidebar-nav.js`, rendered into `#sidebar-nav` (and
 * `#icon-rail-nav`) by render-session, with `current` and the waiting-task count
 * passed as props. The reasoning that shaped them is preserved there; the two
 * points worth keeping in view from the shell side:
 *
 *   Sessions used to be the implicit background state and Tasks a lone button
 *   below the launch panel, which made them read as different kinds of thing —
 *   one a place, one an action. They are both places, named at the same level.
 *
 *   Rows rather than a two-up segmented control, because a segment strip is sized
 *   by its member count: a third destination would force a redesign, where a row
 *   just joins the stack.
 *
 * Why they left the shell: this file renders EXACTLY ONCE (see local-app.js), so
 * anything living here can never take a prop that changes. A nav has to know which
 * destination you are on, and that was previously smuggled in through CSS on
 * `[data-view]` plus an imperative `aria-current` write — two sources of truth for
 * one fact. A mount point plus a prop is one.
 */

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
        // No "Sessions" caption here any more — the nav row directly above names
        // this view, and saying it twice was the clearest symptom of the old
        // arrangement. The count carries the label's job now.
        h("p", { className: "sidebar-caption", id: "threads-count" }, "Loading workspace groups...")
      ),
      h(RefreshButton, { id: "threads-refresh-button", label: "Refresh sessions" })
    ),
    h(
      "div",
      { className: "sidebar-drawer-body" },
      h(
        "div",
        {
          className: "conversation-list",
          "data-thread-list-scroll-root": "",
          id: "threads-list",
        },
        h("p", { className: "sidebar-empty" }, "Sessions will appear here once the relay loads saved workspaces.")
      )
    )
  );
}

function ThreadContextMenu() {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "context-menu", hidden: true, id: "thread-context-menu" },
      h("button", { className: "context-menu-button", id: "fork-thread-button", type: "button" }, "Fork session"),
      h("button", { className: "context-menu-button", id: "rename-thread-button", type: "button" }, "Rename session…"),
      h("button", { className: "context-menu-button", id: "flag-thread-button", type: "button" }, "Flag for follow-up"),
      h("button", { className: "context-menu-button", id: "archive-thread-button", type: "button" }, "Archive session"),
      h("button", {
        className: "context-menu-button context-menu-button-danger",
        id: "delete-thread-button",
        type: "button",
      }, "Delete permanently"),
      // Per-session Project assignment is one row here — "Projects  <current> ›" — that
      // opens the submenu below. Flat-listing every Project at this level buried the
      // session actions once a few Projects existed.
      h("div", { className: "context-menu-separator", role: "separator" }),
      h(
        "button",
        {
          className: "context-menu-button context-menu-submenu-trigger",
          id: "thread-project-submenu-trigger",
          type: "button",
          "aria-haspopup": "true",
          "aria-expanded": "false",
          "aria-controls": "thread-project-submenu",
        },
        h("span", { className: "context-menu-submenu-title" }, "Projects"),
        h("span", { className: "context-menu-submenu-value", id: "thread-project-current-label" }, "None"),
        iconNode(CHEVRON_RIGHT_SVG, "context-menu-submenu-chevron")
      )
    ),
    // Second level, a SIBLING of the menu (not a child): the menu scrolls its own
    // overflow, and nesting the submenu inside would let that clip it. Positioned
    // imperatively against the trigger in app.js, and populated there when it opens
    // (one button per Project + unassign + "New project…") from state.projects and the
    // thread's current membership.
    h(
      "div",
      { className: "context-menu context-menu-submenu", hidden: true, id: "thread-project-submenu", role: "menu" },
      h("div", { className: "context-menu-projects", id: "thread-project-actions" })
    )
  );
}

// Right-click menu for a project row in the sidebar (Projects mode). Rename/Delete
// reuse the existing renameProject/deleteProject handlers (app.js). Positioned +
// toggled imperatively by id, mirroring #thread-context-menu.
function ProjectContextMenu() {
  return h(
    "div",
    { className: "context-menu", hidden: true, id: "project-context-menu" },
    h("button", { className: "context-menu-button", id: "rename-project-button", type: "button" }, "Rename project"),
    h("button", {
      className: "context-menu-button context-menu-button-danger",
      id: "delete-project-button",
      type: "button",
    }, "Delete project")
  );
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





function ChatHeader() {
  return h(ConversationHeader, {
    backButtonId: "go-console-home",
    backLabel: "Back to console",
    composeButtonId: "new-session-compose-button",
    leftPanelToggleId: "toggle-left-panel",
    // No handlers: every button in here is wired by id from app.js, which is what lets
    // this render once and never take a changing prop.
    heading: h(ConversationHeadingBody, {
      // The Project switcher IS the header title — one control answering "where am I",
      // not a title plus a switcher naming the same thing one row below it. Its own
      // sub-root, filled by renderProjectSwitcher().
      titleNode: h("div", { className: "project-switcher-mount", id: "project-switcher-mount" }),
      infoButton: h(
        "button",
        {
          "aria-label": "Session details",
          className: "header-icon-button chat-heading-info-button",
          id: "open-session-details",
          type: "button",
          title: "Session details",
        },
        h(InfoIcon)
      ),
      subtitleNode: h("p", { className: "chat-subtitle", id: "workspace-subtitle" }),
    }),
    actions: h(
      React.Fragment,
      null,
      h("span", {
        className: "model-badge-compact",
        hidden: true,
        id: "local-model-badge",
      }),
      h("span", { className: "status-badge", id: "status-badge" }, "Idle"),
      // Mobile-only Settings entry: the icon rail (which holds the gear) is hidden
      // <=960px, so this keeps Providers/Devices/Log/Appearance reachable in every
      // view (the header is always present, even in conversation where the sidebar
      // collapses). Hidden on desktop via CSS.
      h(
        "button",
        {
          className: "header-button header-settings-button",
          id: "open-settings-header",
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
        },
        iconNode(SETTINGS_SVG)
      ),
      h(
        "button",
        {
          "aria-label": "Toggle side panel",
          className: "header-button header-panel-toggle header-panel-toggle-right",
          id: "toggle-right-panel",
          type: "button",
          title: "Toggle side panel (\u2325\u2318B)",
        },
        h(ToggleRightPanelIcon)
      )
    ),
  });
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
    h(ThreadPanel)
  );
}

// "Recent events" audit — moved out of the retired console home into the
// Settings > Log tab. Keeps ids #audit-timeline / #audit-summary so the
// render-session.js populate path is unchanged.
function AuditTimelineCard() {
  return h(
    "details",
    // Collapsed by default: Recent events is a curated subset of the relay log
    // above, so it starts folded to avoid duplicating the same stream on open.
    { className: "console-card console-card-audit console-card-collapsible" },
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

function ThreadPanel() {
  return h(
    "section",
    { className: "thread-panel" },
    h(
      "section",
      { className: "thread-shell" },
      h(
        "div",
        { className: "chat-thread", id: "transcript" },
        h(LocalTranscriptSlot)
      )
    )
  );
}

function ComposerShell() {
  // One sticky block, not three siblings: the shell's console layout is a grid
  // that grows past the viewport, and only `.composer-shell` was pinned to the
  // bottom of it, so anything rendered beside it landed below the fold.
  return h(
    "div",
    { className: "composer-dock-stack" },
    h(
      "div",
      { className: "workspace-diff-chip-host" },
      h("div", { className: "workspace-diff-chip-slot", id: "workspace-diff-chip-mount" }),
      h("div", { className: "workspace-diff-chip-slot", id: "reviewer-chip-mount" })
    ),
    h(
      "section",
      { className: "control-banner control-banner-compact", hidden: true, id: "control-banner" },
      h("span", { className: "control-summary", id: "control-summary" }, "Another device has control"),
      h(
        "button",
        {
          className: "control-button",
          id: "take-over-button",
          type: "button",
        },
        "Take over"
      )
    ),
    h(
      "form",
      { className: "composer-shell", hidden: true, id: "message-form" },
      h(ConversationComposer, {
        actionsBeforeSend: h("span", { id: "composer-settings-mount" }),
        attachmentArea: h("div", {
          className: "composer-attachments",
          hidden: true,
          id: "composer-attachments",
        }),
        // The local surface is always desktop: Enter sends, Shift+Enter is a newline.
        enterSubmits: true,
        // This shell renders once; the send path fills the region by id (see
        // local/composer-error.js), so it must exist from the start.
        errorId: "composer-error",
        messageId: "message-input",
        messagePlaceholder: "Start or open a session first.",
        modelId: "message-model",
        models: [{ display_name: "gpt-5.4", model: "gpt-5.4" }],
        sendButtonId: "send-button",
        stopButtonId: "stop-button",
      })
    )
  );
}

function WorkspaceChangesRail() {
  return h(
    "aside",
    {
      className: "right-rail",
      id: "workspace-changes-rail",
      "aria-label": "Workspace overview",
    },
    h("div", {
      className: "right-rail-resize",
      id: "right-rail-resize",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize workspace panel",
      tabIndex: 0,
    }),
    h(
      "button",
      {
        "aria-label": "Hide workspace panel",
        className: "header-button header-panel-toggle rail-top-toggle",
        id: "rail-top-toggle",
        title: "Hide workspace panel (⌥⌘B)",
        type: "button",
      },
      h(ToggleRightPanelIcon)
    ),
    h("div", { id: "workspace-changes-mount" })
  );
}

function ChatShell() {
  return h(
    "main",
    { className: "chat-shell", "data-view": "console" },
    h(ChatHeader),
    // Tab strip for the active project's open sessions. Filled by
    // renderSessionTabs() through its own React sub-root, like #client-log-root —
    // the shell is rendered once, so anything data-driven needs its own root.
    h("div", { className: "session-tab-strip-mount", id: "session-tab-strip-mount" }),
    h(OverviewStrip),
    // Projects "card overview" main-area view. Filled by renderProjectOverview();
    // shown only when data-view="project-overview" (CSS-gated like console/conversation).
    h("section", { className: "project-overview-mount", id: "project-overview" }),
    // The Task screen. Filled by renderTaskTeam(); shown only when
    // data-view="tasks", which hides every sibling above and below it.
    h("section", { className: "task-team-mount", id: "task-team" }),
    // Teams library (13a). Same full-area pattern as Tasks / Usage.
    h("section", { className: "teams-library-mount", id: "teams-library" }),
    // The full-screen merge review (15a). Same full-area pattern again — it is a
    // screen, not a wider panel inside task detail, which is what the columns in
    // the mockup require.
    h("section", { className: "review-screen-mount", id: "review-screen" }),
    // The Usage report. Same full-area pattern as Tasks.
    h("section", { className: "usage-report-mount", id: "usage-report" }),
    h(ConsoleGrid),
    h("div", { className: "pending-action-banner", id: "pending-action-banner", hidden: true }),
    h(
      "div",
      {
        className: "agent-working-indicator agent-working-indicator-ready",
        id: "agent-working-indicator",
        role: "status",
        "aria-live": "polite",
        hidden: true,
      },
      h("span", { className: "agent-working-indicator-dot", "aria-hidden": "true" }),
      h(
        "span",
        { className: "agent-working-indicator-label", id: "agent-working-indicator-label" },
        ""
      )
    ),
    h("div", { className: "review-idle-nudge", id: "review-idle-nudge", hidden: true }),
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
        h("h3", { className: "details-heading" }, "Workspace"),
        h("p", { className: "details-path", id: "session-details-path" }, "No workspace path yet.")
      ),
      h(
        "section",
        { className: "details-section" },
        h("h3", { className: "details-heading" }, "Environment"),
        h("section", { className: "session-meta", id: "session-meta" }, h("span", { className: "meta-empty" }, "Session details will appear here."))
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

function WorkspaceDiffModal() {
  return h(
    "dialog",
    { className: "panel-modal panel-modal-wide", id: "workspace-diff-modal" },
    h(
      "div",
      { className: "modal-header" },
      // Title is mounted (createWorkspaceDiffSheet) so it follows the active tab.
      // Diff refresh now lives inside the Changes body, not this header.
      h("div", { className: "modal-title-slot", id: "workspace-diff-title" }),
      h(
        "div",
        { className: "modal-header-actions" },
        h(
          "button",
          {
            className: "header-button close-modal-btn",
            id: "close-workspace-diff-modal",
            type: "button",
          },
          "×"
        )
      )
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h("div", { id: "workspace-diff-mount" })
    )
  );
}

// The devices/security surface \u2014 extracted from the old standalone SecurityModal
// so it can be embedded in the Settings modal's Devices tab. Keeps every id
// (#pending-pairings-list, #pairing-panel, allowed-roots, #paired-devices-list\u2026)
// so dom.js/render-security.js/app.js wiring resolves unchanged.
function DevicesPanelBody() {
  return h(
    "section",
    { className: "remote-access-shell" },
    hSecuritySection("Pending Pairing Requests", "Approve or reject devices that are asking to pair."),
      h(
        "div",
        { className: "paired-devices-list", id: "pending-pairings-list" },
        h("p", { className: "sidebar-empty" }, "No devices are waiting for local approval.")
      ),
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
        "div",
        { className: "pairing-scope-row" },
        h("label", { className: "sidebar-label", htmlFor: "pairing-path-scope-input" }, "Pairing path scope (optional)"),
        h("input", {
          autoComplete: "off",
          id: "pairing-path-scope-input",
          list: "workspace-suggestions",
          placeholder: "/Users/me/projects/specific-repo",
          type: "text",
        }),
        h("p", { className: "sidebar-hint" }, "Limit the next QR's paired device to this path. Empty = no per-device restriction (relay roots still apply).")
      ),
      h(
        "section",
        { className: "pairing-panel", hidden: true, id: "pairing-panel" },
        h("div", { "aria-live": "polite", className: "pairing-qr", id: "pairing-qr" }),
        h("p", { className: "pairing-copy", id: "pairing-expiry" }, "Pairing ticket not created yet."),
        h("p", { className: "pairing-copy", id: "pairing-scope-summary" }),
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

// Consolidated Settings modal opened from the icon-rail gear. Four always-mounted
// tab panels (toggled by `hidden`, never conditionally rendered) so every id inside
// resolves at dom.js import time. Tab switching is wired imperatively in app.js
// (setSettingsTab) by the #settings-tab-* / data-settings-panel ids.
function SettingsModal() {
  const tab = (key, label, active = false) =>
    h(
      "button",
      {
        className: `settings-tab${active ? " is-active" : ""}`,
        id: `settings-tab-${key}`,
        type: "button",
        role: "tab",
        "aria-selected": active ? "true" : "false",
        "data-settings-tab": key,
      },
      label
    );
  const panel = (key, active, ...children) =>
    h(
      "div",
      { className: "settings-panel", "data-settings-panel": key, hidden: !active },
      ...children
    );
  return h(
    "dialog",
    { className: "settings-modal panel-modal panel-modal-wide", id: "settings-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Settings"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-settings-modal",
        type: "button",
      }, "×")
    ),
    h(
      "div",
      { className: "settings-tabs", role: "tablist", "aria-label": "Settings sections" },
      tab("providers", "Providers", true),
      tab("devices", "Devices"),
      tab("log", "Log"),
      tab("appearance", "Appearance")
    ),
    h(
      "section",
      { className: "panel-modal-body settings-body" },
      panel(
        "providers",
        true,
        h(
          "section",
          { className: "provider-status-panel", id: "provider-status-panel" },
          h("p", { className: "sidebar-caption" }, "Providers"),
          h("ul", { className: "provider-status-list", id: "provider-status-list" })
        )
      ),
      panel("devices", false, h(DevicesPanelBody)),
      panel(
        "log",
        false,
        h(
          "section",
          { className: "details-section" },
          h("h3", { className: "details-heading" }, "Relay log"),
          h(
            "div",
            { id: "client-log-root" },
            h(ClientLog, { lines: ["Booting web client..."] })
          )
        ),
        h("section", { className: "details-section" }, h(AuditTimelineCard))
      ),
      panel(
        "appearance",
        false,
        h("section", { className: "details-section" }, h(ThemePickerRow))
      )
    )
  );
}

function PairingApprovalModal() {
  return h(
    "dialog",
    { className: "panel-modal pairing-approval-modal", id: "pairing-approval-modal" },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Approve pairing"),
      h("button", {
        className: "header-button close-modal-btn",
        id: "close-pairing-approval-modal",
        type: "button",
      }, "×")
    ),
    h(
      "section",
      { className: "panel-modal-body pairing-approval-shell" },
      h("p", { className: "panel-modal-copy", id: "pairing-approval-hint" },
        "A remote device is requesting access. Approve or reject before the request times out."),
      h("div", { className: "paired-devices-list", id: "pairing-approval-list" })
    )
  );
}

// The shell owns stable layout nodes and mount points. Most data-driven regions
// still live in their own sub-root; the Local transcript is the narrow exception
// and subscribes above so #transcript itself stays shell-owned.
export function LocalShell() {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "local-frame" },
      h(IconRail),
      h(
        "div",
        { className: "app-shell app-shell-with-rail", "data-view": "console" },
        h(Sidebar),
        h(ChatShell),
        h(WorkspaceChangesRail)
      )
    ),
    // Filled by renderLaunchSessionDialog() through its own React sub-root: this
    // shell renders exactly once, and a controlled dialog must re-render.
    h("div", { className: "launch-dialog-mount", id: "launch-dialog-root" }),
    // Filled by renderStartTaskDialog() through its own React sub-root — the shell
    // renders once, so anything data-driven needs one.
    h("div", { className: "start-task-dialog-mount", id: "start-task-dialog-mount" }),
    h(SessionDetailsModal),
    h(WorkspaceDiffModal),
    h(SettingsModal),
    h(PairingApprovalModal)
  );
}
