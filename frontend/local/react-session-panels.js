import React from "react";

const h = React.createElement;

export function TextContent({ children }) {
  return children || "";
}

export function OverviewBadges({ badges = [] }) {
  return h(
    React.Fragment,
    null,
    ...badges.map((badge) =>
      h(
        "span",
        { className: "overview-badge", key: `${badge.label}:${badge.value}` },
        h("strong", null, badge.label),
        h("span", null, badge.value)
      )
    )
  );
}

export function SurfaceCards({ surfaces = [] }) {
  return h(
    React.Fragment,
    null,
    ...surfaces.map((surface) =>
      h(
        "article",
        { className: "surface-card", key: surface.key || surface.title },
        h(
          "div",
          { className: "surface-card-heading" },
          h(
            "div",
            null,
            h("h3", { className: "surface-card-title" }, surface.title),
            h("p", { className: "surface-card-copy" }, surface.copy)
          ),
          h(
            "span",
            { className: `device-state-badge ${surface.badgeClass}` },
            surface.badgeLabel
          )
        ),
        h(
          "div",
          { className: "surface-card-meta" },
          ...(surface.chips || []).map((chip) =>
            h(
              "span",
              { className: "surface-chip", key: `${chip.label}:${chip.value}` },
              h("strong", null, chip.label),
              chip.value
            )
          )
        )
      )
    )
  );
}

export function AuditList({ entries = [], emptyMessage = "No relay events yet." }) {
  if (!entries.length) {
    return h("p", { className: "sidebar-empty" }, emptyMessage);
  }

  return h(
    React.Fragment,
    null,
    ...entries.map((entry, index) => {
      const toneClass = entry.tone === "alert"
        ? " is-alert"
        : entry.tone === "ready"
          ? " is-ready"
          : "";
      return h(
        "article",
        { className: `audit-item${toneClass}`, key: entry.key || `${entry.kind}:${index}` },
        h(
          "div",
          { className: "audit-item-header" },
          h("span", { className: "audit-item-kind" }, entry.kind),
          h("time", { className: "audit-item-time" }, entry.time)
        ),
        h("p", { className: "audit-item-message" }, entry.message || "")
      );
    })
  );
}

export function SessionMetaPanel({ chips = [], emptyMessage = "" }) {
  return h(
    React.Fragment,
    null,
    ...chips.map((chip) =>
      h(
        "span",
        { className: "meta-chip", key: `${chip.label}:${chip.value}` },
        h("strong", null, `${chip.label}:`),
        h("span", null, chip.value)
      )
    ),
    emptyMessage ? h("span", { className: "meta-empty" }, emptyMessage) : null
  );
}

export function ControlBannerContent({
  hint,
  showTakeOver = false,
  summary,
}) {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      null,
      h("p", { className: "control-summary", id: "control-summary" }, summary),
      h("p", { className: "control-hint", id: "control-hint" }, hint)
    ),
    h(
      "button",
      {
        className: "header-button control-button",
        hidden: !showTakeOver,
        id: "take-over-button",
        type: "button",
      },
      "Take over"
    )
  );
}
