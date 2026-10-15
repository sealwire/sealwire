import React, { useState } from "react";
import { t } from "./i18n.js";
import { providerLabel, providerTone } from "./provider-labels.js";
import { projectCardStatus, reorderCardIds } from "./project-overview-model.js";

const h = React.createElement;

function shortId(value) {
  return value ? String(value).slice(0, 8) : t("unknown");
}

function workspaceBasename(cwd) {
  if (!cwd) {
    return "";
  }
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "";
}

function PlusGlyph() {
  return h(
    "svg",
    { "aria-hidden": "true", width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round" },
    h("path", { d: "M12 5v14M5 12h14" }),
  );
}

function DragGlyph() {
  return h(
    "svg",
    { "aria-hidden": "true", width: "14", height: "14", viewBox: "0 0 16 16", fill: "currentColor" },
    h("circle", { cx: "6", cy: "3.5", r: "1.1" }), h("circle", { cx: "10", cy: "3.5", r: "1.1" }),
    h("circle", { cx: "6", cy: "8", r: "1.1" }), h("circle", { cx: "10", cy: "8", r: "1.1" }),
    h("circle", { cx: "6", cy: "12.5", r: "1.1" }), h("circle", { cx: "10", cy: "12.5", r: "1.1" }),
  );
}

function PinGlyph({ filled }) {
  return h(
    "svg",
    { "aria-hidden": "true", width: "15", height: "15", viewBox: "0 0 24 24", fill: filled ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round" },
    h("path", { d: "M9 4h6l-1 7 4 3v2H6v-2l4-3-1-7z" }),
    h("path", { d: "M12 16v4" }),
  );
}

function FolderGlyph() {
  return h(
    "svg",
    { "aria-hidden": "true", width: "17", height: "17", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round" },
    h("path", { d: "M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }),
  );
}

// The Projects-mode sidebar: one row per project (no sessions inline, no Unassigned).
// `rows` is a precomputed view model [{ id, name, working, needsInput, total }].
export function ProjectSidebarList({ rows = [], activeProjectId = null, onSelect = null, onContext = null, emptyMessage = t("No projects yet.") }) {
  if (!rows.length) {
    return h("p", { className: "sidebar-empty" }, emptyMessage);
  }
  return h(
    "div",
    { className: "project-sidebar-list" },
    ...rows.map((row) => {
      const badges = [];
      if (row.working) {
        badges.push(h("span", { key: "w", className: "project-sidebar-badge is-working" }, t("{count} working", { count: row.working })));
      }
      if (row.needsInput) {
        badges.push(h("span", { key: "n", className: "project-sidebar-badge is-attention" }, t("{count} needs input", { count: row.needsInput })));
      }
      if (!badges.length) {
        const total = row.total || 0;
        badges.push(h("span", { key: "t", className: "project-sidebar-badge" }, total === 1 ? t("{count} session", { count: total }) : t("{count} sessions", { count: total })));
      }
      const rowButton = h(
        "button",
        {
          type: "button",
          className: `project-sidebar-row${row.id === activeProjectId ? " is-active" : ""}`,
          onClick: () => onSelect?.(row.id),
          // Right-click (desktop) still opens the actions menu at the cursor.
          onContextMenu: onContext
            ? (event) => {
                event.preventDefault();
                onContext(row.id, row.name, event.clientX, event.clientY);
              }
            : undefined,
          title: row.name,
        },
        h("span", { className: "project-sidebar-icon", "aria-hidden": "true" }, h(FolderGlyph)),
        h(
          "span",
          { className: "project-sidebar-meta" },
          h("span", { className: "project-sidebar-name" }, row.name),
          h("span", { className: "project-sidebar-badges" }, ...badges),
        ),
      );
      // Without a menu handler there's nothing to reveal — keep the bare row.
      if (!onContext) {
        return h(React.Fragment, { key: row.id }, rowButton);
      }
      // A visible actions button (keyboard-focusable, tap-friendly on touch) opens the
      // same Rename/Delete menu as right-click — so project management isn't mouse-only.
      return h(
        "div",
        { key: row.id, className: "project-sidebar-row-wrap" },
        rowButton,
        h(
          "button",
          {
            type: "button",
            className: "project-sidebar-more",
            "aria-label": t("Actions for {name}", { name: row.name }),
            title: t("Project actions"),
            onClick: (event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onContext(row.id, row.name, rect.right, rect.bottom);
            },
          },
          h(MoreGlyph),
        ),
      );
    }),
  );
}

function MoreGlyph() {
  return h(
    "svg",
    { "aria-hidden": "true", width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor" },
    h("circle", { cx: "3", cy: "8", r: "1.3" }),
    h("circle", { cx: "8", cy: "8", r: "1.3" }),
    h("circle", { cx: "13", cy: "8", r: "1.3" }),
  );
}

function ProjectCard({
  thread,
  pinned,
  status,
  meta,
  isDragging,
  isDropTarget,
  onOpen,
  onTogglePin,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const title = thread.name || thread.preview || shortId(thread.id);
  const provider = providerLabel(thread.provider);
  const providerToneClass = `is-${providerTone(thread.provider)}`;
  const workspace = workspaceBasename(thread.cwd);
  const statusTitle = status.tool ? `${status.label} · ${status.tool}` : status.label;

  return h(
    "article",
    {
      className:
        `project-card${pinned ? " is-pinned" : ""}` +
        `${isDragging ? " is-dragging" : ""}${isDropTarget ? " is-drop-target" : ""}`,
      draggable: true,
      "data-thread-id": thread.id,
      // A card PEEKS, exactly like a sidebar row: the session opens into the one
      // reusable preview tab, so arranging an overview doesn't leave a tab behind
      // per card you looked at. Cards and rows are two doors onto the same list
      // and must not disagree about what opening means.
      //
      // No double-click-to-keep here, though the row has one: opening replaces
      // the overview with the conversation, so the card is gone before a second
      // click could reach it. Keeping belongs where the target survives — the tab
      // strip (double-click the tab, or pin it), or simply sending a message.
      onClick: (event) => {
        if (event.target.closest(".project-card-pin") || event.target.closest(".project-card-drag")) {
          return;
        }
        onOpen(thread.id, { preview: true });
      },
      onDragStart: (event) => onDragStart(event, thread.id),
      onDragOver: (event) => onDragOver(event, thread.id),
      onDrop: (event) => onDrop(event, thread.id),
      onDragEnd,
      title: provider ? `${provider} · ${title}` : title,
    },
    h("span", { className: "project-card-drag", "aria-hidden": "true", title: t("Drag to reorder") }, h(DragGlyph)),
    h(
      "div",
      { className: "project-card-body" },
      h(
        "div",
        { className: "project-card-title-row" },
        provider ? h("span", { className: `conversation-provider-badge ${providerToneClass}` }, provider) : null,
        h("span", { className: "project-card-title" }, title),
      ),
      h(
        "div",
        { className: "project-card-meta" },
        workspace ? h("span", { className: "project-card-workspace" }, workspace) : null,
      ),
    ),
    h(
      "div",
      { className: "project-card-side" },
      h(
        "span",
        { className: `project-card-status is-${status.key}`, title: statusTitle },
        h("span", { className: "project-card-status-dot", "aria-hidden": "true" }),
        status.label,
      ),
      meta ? h("span", { className: "project-card-time" }, meta) : null,
      h(
        "button",
        {
          type: "button",
          className: `project-card-pin${pinned ? " is-pinned" : ""}`,
          title: pinned ? t("Unpin") : t("Pin"),
          "aria-label": pinned ? t("Unpin {title}", { title }) : t("Pin {title}", { title }),
          "aria-pressed": pinned ? "true" : "false",
          onClick: (event) => {
            event.stopPropagation();
            onTogglePin(thread.id);
          },
        },
        h(PinGlyph, { filled: pinned }),
      ),
    ),
  );
}

// The Projects "card overview" main-area view: every agent (session) in the active
// project as a card, pin + drag-to-reorder, click to open the session. Callers pass
// `agents` already sorted (sortProjectCards) and own persistence.
export function ProjectOverview({
  project = null,
  agents = [],
  pinnedIds = new Set(),
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
  formatMeta = () => "",
  onOpenAgent = null,
  onTogglePin = null,
  onReorder = null,
  onNewAgent = null,
}) {
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  if (!project) {
    return h(
      "div",
      { className: "project-overview-empty" },
      h("h3", null, t("Select a project")),
      h("p", null, t("Pick a project on the left to see its agents.")),
    );
  }

  const count = agents.length;
  const header = h(
    "header",
    { className: "project-overview-header" },
    h(
      "div",
      { className: "project-overview-heading" },
      h("h1", { className: "project-overview-title" }, project.name || project.id),
      h(
        "p",
        { className: "project-overview-sub" },
        count === 1 ? t("{count} agent", { count }) : t("{count} agents", { count }),
      ),
    ),
    onNewAgent
      ? h(
          "button",
          { type: "button", className: "project-overview-new", onClick: () => onNewAgent(project.id) },
          h(PlusGlyph),
          t("New agent"),
        )
      : null,
  );

  if (!count) {
    return h(
      "div",
      { className: "project-overview" },
      header,
      h(
        "div",
        { className: "project-overview-empty" },
        h("h3", null, t("No agents yet")),
        h("p", null, t("Start an agent in this project — it'll show up here as a card.")),
      ),
    );
  }

  const clearDrag = () => {
    setDraggingId(null);
    setDropTargetId(null);
  };
  const handleDragStart = (event, id) => {
    setDraggingId(id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", id);
      } catch {
        // Some browsers restrict setData outside a user gesture; the id in state
        // is the source of truth, dataTransfer is only a courtesy.
      }
    }
  };
  const handleDragOver = (event, id) => {
    if (!draggingId) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    if (id !== dropTargetId) {
      setDropTargetId(id);
    }
  };
  const handleDrop = (event, id) => {
    event.preventDefault();
    if (draggingId && draggingId !== id) {
      onReorder?.(reorderCardIds(agents.map((agent) => agent.id), draggingId, id));
    }
    clearDrag();
  };

  const cards = agents.map((thread) =>
    h(ProjectCard, {
      key: thread.id,
      thread,
      pinned: pinnedIds.has(thread.id),
      status: projectCardStatus({
        activity: threadActivity?.get?.(thread.id) || null,
        attentionKind: threadAttention?.get?.(thread.id) || null,
        reviewing: threadReviewing?.has?.(thread.id) || false,
      }),
      meta: formatMeta(thread),
      isDragging: draggingId === thread.id,
      isDropTarget: dropTargetId === thread.id && draggingId !== thread.id,
      onOpen: onOpenAgent || (() => {}),
      onTogglePin: onTogglePin || (() => {}),
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      onDragEnd: clearDrag,
    }),
  );

  const anyPinned = agents.some((thread) => pinnedIds.has(thread.id));
  if (!anyPinned) {
    return h("div", { className: "project-overview" }, header, h("div", { className: "project-card-list" }, ...cards));
  }

  // Split into Pinned / Recent bands with subtle labels (agents already come
  // pinned-first from sortProjectCards).
  const pinnedCards = [];
  const restCards = [];
  agents.forEach((thread, index) => {
    (pinnedIds.has(thread.id) ? pinnedCards : restCards).push(cards[index]);
  });
  return h(
    "div",
    { className: "project-overview" },
    header,
    h("p", { className: "project-card-band-label" }, t("Pinned")),
    h("div", { className: "project-card-list" }, ...pinnedCards),
    restCards.length
      ? h("p", { className: "project-card-band-label" }, t("Recent"))
      : null,
    restCards.length ? h("div", { className: "project-card-list" }, ...restCards) : null,
  );
}
