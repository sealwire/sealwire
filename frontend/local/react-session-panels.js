import React from "react";

const h = React.createElement;

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
            surface.copy ? h("p", { className: "surface-card-copy" }, surface.copy) : null
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
              {
                className: "surface-chip",
                key: `${chip.label}:${chip.value}`,
                title: `${chip.label}: ${chip.value}`,
              },
              h("strong", null, chip.label),
              chip.value
            )
          )
        )
      )
    )
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
  hint: _hint,
  // `{ label, pending, error }` when the viewed thread's workspace is missing — see
  // local/control-banner.js. The banner is one slot, so this and Take over are
  // mutually exclusive by construction: the model never sets both.
  repair = null,
  showTakeOver = false,
  summary,
  summaryTitle = "",
}) {
  return h(
    React.Fragment,
    null,
    h(
      "span",
      {
        className: "control-summary",
        id: "control-summary",
        // A recorded cwd is long enough to overflow the bar; CSS ellipsizes it and
        // this puts the whole path back within reach.
        title: summaryTitle || undefined,
      },
      summary
    ),
    // The take-over button stays mounted (hidden) rather than swapped out: the
    // click handler in app.js binds by id on the banner, and dom.js resolves
    // `#take-over-button` once at boot.
    h(
      "button",
      {
        className: "control-button",
        hidden: !showTakeOver,
        id: "take-over-button",
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
          id: "workspace-repair-button",
          type: "button",
        },
        repair.label
      )
      : null,
    // The relay's own failure text, kept verbatim on its own line. Swallowing it
    // would put the user back where this change started: an action that stops
    // working with nothing on screen to say why.
    repair?.error
      ? h("p", { className: "control-banner-error", role: "alert" }, repair.error)
      : null
  );
}
