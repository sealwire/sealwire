// The sidebar's destination nav, as a shared prop-driven component.
//
// It was two byte-divergent imperative surfaces: labelled rows in the sidebar and
// icon-only buttons in the collapsed rail, each wired by id in app.js and each syncing
// its own "you are here" state from a different place (`aria-current` written by
// render-session, `data-view` read by CSS). This file pins the rules that let one
// component serve both forms.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SIDEBAR_NAV_DESTINATIONS, SidebarNav, SidebarNavRail } from "./sidebar-nav.js";

const h = React.createElement;
const noop = () => {};

const BOTH = { onOpenSessions: noop, onOpenEditor: noop, onOpenTasks: noop, onOpenUsage: noop };

function markup(Component, props = {}) {
  return renderToStaticMarkup(h(Component, { ...BOTH, ...props }));
}

// --- the destination list is the single source both forms read --------------------

// The rail shipped with a Tasks button and no Sessions button, because the rows and the
// rail were written separately. Deriving both from one list is what makes that class of
// gap unrepresentable — so the list itself is the thing to pin.
test("both forms offer exactly the same destinations", () => {
  const keys = SIDEBAR_NAV_DESTINATIONS.map((destination) => destination.key);
  assert.deepEqual(keys, ["sessions", "editor", "tasks", "usage"]);

  for (const Component of [SidebarNav, SidebarNavRail]) {
    const html = markup(Component);
    for (const destination of SIDEBAR_NAV_DESTINATIONS) {
      assert.ok(
        html.includes(`data-destination="${destination.key}"`),
        `${Component.name} must offer the ${destination.key} destination`
      );
    }
  }
});

test("the rows carry labels; the rail carries the same names as aria-labels", () => {
  const rows = markup(SidebarNav);
  assert.match(rows, /Sessions</);
  assert.match(rows, /Tasks</);
  assert.match(rows, /Usage</);

  const rail = markup(SidebarNavRail);
  // Icon-only, so the accessible name is the only name — losing it makes the rail
  // unusable with a screen reader while looking perfectly fine.
  assert.match(rail, /aria-label="Sessions"/);
  assert.match(rail, /aria-label="Tasks"/);
  assert.match(rail, /aria-label="Usage"/);
  assert.ok(!/>Sessions</.test(rail), "the rail drops the visible label, that is the point");
});

// --- exactly one destination is current ------------------------------------------

test("the current destination is marked, and only ever one of them", () => {
  for (const Component of [SidebarNav, SidebarNavRail]) {
    for (const current of ["sessions", "tasks"]) {
      const html = markup(Component, { current });
      const marked = [...html.matchAll(/data-destination="([a-z]+)"[^>]*aria-current="page"/g)].map(
        (match) => match[1]
      );
      assert.deepEqual(
        marked,
        [current],
        `${Component.name} on ${current}: exactly one row is current`
      );
      assert.ok(
        html.includes("is-current"),
        `${Component.name} must carry the class the CSS selects on`
      );
      assert.equal(
        (html.match(/is-current/g) || []).length,
        1,
        `${Component.name} on ${current}: only one row may be lit`
      );
    }
  }
});

// `aria-current` and the `is-current` class must move together. They used to be two
// sources of truth — CSS on `.app-shell[data-view]` and `aria-current` written by
// render-session — so a view change could light one and not the other.
test("an unknown current lights nothing rather than defaulting to a row", () => {
  const html = markup(SidebarNav, { current: "reviewer" });
  assert.ok(!html.includes("is-current"), "no destination matches, so none is lit");
  assert.ok(!html.includes('aria-current="page"'));
});

// --- a destination with no transport does not render -----------------------------

// The repo's own rule, set by the mobile actions sheet: an action with no transport is
// ABSENT (archive/delete), while one that merely cannot run yet is present and says why
// (fork on a busy thread). Tasks on remote has no broker transport at all, so it is the
// first kind.
test("a destination whose handler is missing is not rendered at all", () => {
  const html = renderToStaticMarkup(h(SidebarNav, { onOpenSessions: noop, current: "sessions" }));
  assert.ok(!html.includes('data-destination="tasks"'), "no handler, no Tasks row");
});

// A nav has to offer a choice. One destination is not navigation, it is a label that
// looks clickable — which is what remote would render today, since it can host Sessions
// but has no Tasks transport yet.
test("fewer than two reachable destinations renders nothing", () => {
  for (const Component of [SidebarNav, SidebarNavRail]) {
    assert.equal(
      renderToStaticMarkup(h(Component, { onOpenSessions: noop })),
      "",
      `${Component.name}: a one-destination nav is not a nav`
    );
    assert.equal(renderToStaticMarkup(h(Component, {})), "", `${Component.name}: no handlers, no nav`);
  }
});

// --- the waiting-tasks badge ------------------------------------------------------

// Counts tasks WAITING ON A PERSON, not tasks that exist. A badge that never cleared
// would stop being read.
test("the badge appears only when something is waiting", () => {
  assert.ok(!markup(SidebarNav, { tasksWaitingCount: 0 }).includes("sidebar-nav-badge"));
  const two = markup(SidebarNav, { tasksWaitingCount: 2 });
  assert.match(two, /class="sidebar-nav-badge"[^>]*>2</);
});

// A count has nowhere to sit on a 44px square, but "something is waiting" is the part
// that has to survive the collapse.
test("the rail reduces the count to a dot, and drops it when nothing waits", () => {
  const rail = markup(SidebarNavRail, { tasksWaitingCount: 3 });
  assert.match(rail, /class="icon-rail-dot"/);
  assert.ok(!rail.includes(">3<"), "the rail shows presence, not the number");
  assert.ok(!markup(SidebarNavRail, { tasksWaitingCount: 0 }).includes("icon-rail-dot"));
});

test("a negative or non-numeric waiting count is treated as nothing waiting", () => {
  for (const tasksWaitingCount of [-1, NaN, null, undefined, "2"]) {
    assert.ok(
      !markup(SidebarNav, { tasksWaitingCount }).includes("sidebar-nav-badge"),
      `${JSON.stringify(tasksWaitingCount)} is not a count of waiting tasks`
    );
  }
});

// --- the re-render hazard ---------------------------------------------------------

// This is the load-bearing one. The nav used to render EXACTLY ONCE, inside the shell's
// single render, so its icons could never be swapped mid-gesture. As a prop-driven
// component it re-renders on every view change — and a `click` only fires when
// mousedown and mouseup resolve to the same node. These glyphs are injected with
// `dangerouslySetInnerHTML`, so a re-render between the two replaces the <svg> and the
// browser fires NO click: the button hovers, depresses, and does nothing.
//
// `.inline-icon { pointer-events: none }` (styles.css) is what keeps the BUTTON as the
// hit target. Renaming the class away from `.inline-icon` silently reintroduces a dead
// button, with no other symptom — hence a test rather than a comment.
test("every glyph is an .inline-icon, so a re-render cannot swallow the click", () => {
  for (const Component of [SidebarNav, SidebarNavRail]) {
    const html = markup(Component);
    const glyphs = [...html.matchAll(/<span class="([^"]*)"[^>]*><svg/g)].map((match) => match[1]);
    // Derived, not hardcoded: the point of this file is that ONE list drives both
    // forms, so a count literal here would need editing every time that list grows
    // and would fail for the wrong reason when someone forgot.
    assert.equal(
      glyphs.length,
      SIDEBAR_NAV_DESTINATIONS.length,
      `${Component.name} renders one glyph per destination`
    );
    for (const className of glyphs) {
      assert.ok(
        className.split(/\s+/).includes("inline-icon"),
        `${Component.name}: glyph "${className}" must be .inline-icon or its button goes dead`
      );
    }
  }
});

test("the buttons are type=button, so a nav inside a form cannot submit it", () => {
  for (const Component of [SidebarNav, SidebarNavRail]) {
    const html = markup(Component);
    assert.equal(
      (html.match(/type="button"/g) || []).length,
      SIDEBAR_NAV_DESTINATIONS.length,
      Component.name
    );
  }
});
