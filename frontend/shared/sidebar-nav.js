// The sidebar's destination nav — Sessions | Tasks — in both of its forms.
//
// Shared by local and remote deliberately, for the same reason `project-switcher.js`
// gives: the control is identical on both (a list of places to be), and the surfaces
// differ only in what arriving somewhere DOES, which is the caller's business. Writing it
// twice is how the two sidebars drifted before.
//
// Two exported forms, ONE destination list:
//
//   `SidebarNav`     — labelled rows, for an expanded sidebar.
//   `SidebarNavRail` — icon-only buttons, for local's 64px collapsed rail.
//
// The rail is not a second nav. It shipped with a Tasks button and no Sessions button,
// so collapsing the sidebar while on the Task screen left no way back — a gap that was
// only possible because the two forms were written separately. They now read one list, so
// a third destination joins both at once and neither can lack what the other offers.
//
// Rows rather than a two-up segmented control because a segment strip is sized by its
// member count: a third destination would re-slice every segment and invalidate the rule
// positioning the indicator, where a row just joins the stack.
//
// ---------------------------------------------------------------------------
// This component OWNS its selected state, and does not know what routing is.
// ---------------------------------------------------------------------------
//
// It takes `current` in and emits `onOpen*` out. It must never learn about local's
// `session-view-state.js` (a real state machine with invariants — contexts, history, tab
// workspaces) or about remote's absence of one. That seam is the only reason one
// component can serve two surfaces whose navigation models have nothing in common.
//
// `current` also drives the `is-current` class, replacing a CSS selector on
// `.app-shell[data-view]` that existed only because the nav was NOT prop-driven: the
// paint could not wait on an imperative `aria-current` write, so the two were kept in
// step by hand from render-session. Now both come from the same prop in the same render,
// so there is one source of truth and nothing to keep in step.

import React from "react";

import { t } from "./i18n.js";
import { SESSIONS_SVG, TASKS_SVG, USAGE_SVG } from "../svg.js";

const h = React.createElement;

/**
 * Every place the sidebar can send you, in the order they are offered.
 *
 * Exported so a caller can enumerate destinations without hard-coding the keys, and so a
 * test can assert both forms cover the same set.
 */
export const SIDEBAR_NAV_DESTINATIONS = Object.freeze([
  Object.freeze({
    key: "sessions",
    label: t("Sessions"),
    title: t("Sessions — conversations with one agent"),
    svg: SESSIONS_SVG,
  }),
  Object.freeze({
    key: "tasks",
    label: t("Tasks"),
    title: t("Tasks — long-running work a team does on its own branch"),
    svg: TASKS_SVG,
  }),
  // Third destination, and the proof that the two forms now read one list: this
  // entry gives the expanded nav a row and the collapsed rail a button, with no
  // second edit. The rail shipped once with Tasks and no Sessions, which is the
  // shape of bug that costs.
  Object.freeze({
    key: "usage",
    label: t("Usage"),
    title: t("Usage — tokens spent, by provider and model"),
    svg: USAGE_SVG,
  }),
]);

/**
 * The destinations this caller can actually reach.
 *
 * A destination with no handler is dropped ENTIRELY rather than rendered disabled. That
 * is the repo's established split, set by the mobile actions sheet: an action with no
 * transport is absent (archive, delete — the broker has no action kind for them), while
 * one that merely cannot run yet is present and says why (fork on a busy thread). Tasks
 * on remote is the first kind — there is no broker transport for the team routes at all —
 * so a disabled row there would be a promise the surface cannot keep.
 */
function reachableDestinations(handlers) {
  return SIDEBAR_NAV_DESTINATIONS.filter(
    (destination) => typeof handlers[destination.key] === "function"
  );
}

/**
 * How many tasks are waiting ON A PERSON — not how many exist.
 *
 * Anything that is not a positive integer means "nothing is waiting". A badge that
 * rendered for `NaN` or `-1` would show an empty amber pill that never clears, and a
 * badge that never clears stops being read.
 */
function waitingCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function glyph(svgMarkup, extraClass) {
  // `.inline-icon` is not decoration. It carries `pointer-events: none`, which keeps the
  // BUTTON as the hit target — a `click` only fires when mousedown and mouseup resolve to
  // the same node, and these glyphs are injected with `dangerouslySetInnerHTML`, so a
  // re-render mid-gesture replaces the <svg> and the browser fires no click at all. The
  // nav used to render exactly once and was safe by accident; prop-driven, it is not.
  return h("span", {
    className: extraClass ? `inline-icon ${extraClass}` : "inline-icon",
    "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: svgMarkup },
  });
}

// `aria-current` and the class are set from the same comparison, so they cannot disagree.
// `data-destination` is what tests and e2e address rows by — deliberately not an `id`,
// because a stable id is what let local reach these buttons imperatively in the first
// place, and remote would collide with local's ids the moment both mount the component.
function destinationProps(destination, current, onOpen) {
  const isCurrent = destination.key === current;
  return {
    key: destination.key,
    type: "button",
    "data-destination": destination.key,
    "aria-current": isCurrent ? "page" : undefined,
    onClick: onOpen,
    isCurrent,
  };
}

/**
 * Nothing to render unless there is a CHOICE.
 *
 * One destination is not navigation — it is a label that looks clickable. Remote is
 * exactly this case today: it can host Sessions but has no Tasks transport, so it renders
 * no nav at all rather than a lone inert row. Passing `onOpenTasks` is what makes the nav
 * appear, which keeps "the transport exists" and "the nav is offered" the same fact.
 */
function useNavModel({
  current,
  tasksWaitingCount,
  onOpenSessions,
  onOpenTasks,
  onOpenUsage,
  tasksBeta = false,
  usageBeta = false,
}) {
  const handlers = {
    sessions: onOpenSessions,
    tasks: onOpenTasks,
    usage: onOpenUsage,
  };
  const destinations = reachableDestinations(handlers);
  return {
    destinations: destinations.length >= 2 ? destinations : [],
    handlers,
    current,
    waiting: waitingCount(tasksWaitingCount),
    // Keyed by destination rather than one boolean per screen, for the same
    // reason the destinations themselves are one list: a second parallel flag is
    // a thing that can disagree with the first. Renderers look a key up; they do
    // not name a screen. `=== true` because these arrive from a JSON snapshot.
    //
    // Not the reachability rule above — a beta destination stays reachable, it
    // just says so first.
    beta: {
      tasks: tasksBeta === true,
      usage: usageBeta === true,
    },
  };
}

/** Labelled rows, for an expanded sidebar. */
export function SidebarNav(props = {}) {
  const { destinations, handlers, current, waiting, beta } = useNavModel(props);
  if (!destinations.length) {
    return null;
  }

  return h(
    "nav",
    { className: "sidebar-nav", "aria-label": t("Views") },
    destinations.map((destination) => {
      const { isCurrent, ...buttonProps } = destinationProps(
        destination,
        current,
        handlers[destination.key]
      );
      return h(
        "button",
        {
          ...buttonProps,
          className: isCurrent ? "sidebar-nav-row is-current" : "sidebar-nav-row",
          title: destination.title,
        },
        glyph(destination.svg, "sidebar-nav-glyph"),
        h("span", { className: "sidebar-nav-label" }, destination.label),
        // Only Tasks can be waited on, and only when something actually is.
        destination.key === "tasks" && waiting
          ? h("span", { className: "sidebar-nav-badge" }, String(waiting))
          : null,
        // Mutually exclusive with the badge for Tasks: a locked build never
        // fetches teams, so `waiting` is 0 in exactly the state this renders.
        beta[destination.key]
          ? h("span", { className: "sidebar-nav-beta" }, "Beta")
          : null
      );
    })
  );
}

/**
 * Icon-only buttons, for local's 64px collapsed rail.
 *
 * The rail is the WHOLE nav while the sidebar is collapsed — the sidebar that holds the
 * rows is `visibility: hidden` in exactly that state — so it has to offer every
 * destination the rows do. A row is already a glyph plus a label, so dropping the label
 * is the entire adaptation; the name survives as `aria-label`, because icon-only means
 * the accessible name is the only name.
 */
export function SidebarNavRail(props = {}) {
  const { destinations, handlers, current, waiting } = useNavModel(props);
  if (!destinations.length) {
    return null;
  }

  return destinations.map((destination) => {
    const { isCurrent, ...buttonProps } = destinationProps(
      destination,
      current,
      handlers[destination.key]
    );
    return h(
      "button",
      {
        ...buttonProps,
        className: isCurrent
          ? `icon-rail-button icon-rail-${destination.key} is-current`
          : `icon-rail-button icon-rail-${destination.key}`,
        title: destination.label,
        "aria-label": destination.label,
      },
      glyph(destination.svg),
      // The collapsed form of the badge: a count has nowhere to sit on a 44px square,
      // but "something is waiting" is the part that has to survive.
      destination.key === "tasks" && waiting
        ? h("span", { className: "icon-rail-dot", "aria-hidden": "true" })
        : null
    );
  });
}
