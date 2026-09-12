// The four pieces of sidebar chrome both shells render identically.
//
// Before this module they existed twice each. The brand lockup was duplicated
// byte-for-byte (same `img` attributes, same wordmark). The search and bell toggles
// differed only in which state they read and what they called. The search FIELD was the
// sharpest case: the same control written two incompatible ways — remote conditionally
// rendered it, while local always mounted it and toggled `hidden`, because local's shell
// renders exactly once and could not take a prop.
//
// The duplication was not theoretical. Both files carried the same comment in slightly
// different words — "Closing must also clear: a hidden field still filtering/narrowing the
// list is a sidebar that looks like it lost sessions, with the reason off screen" — which
// is what a rule looks like when it has been re-derived instead of shared.
//
// What is deliberately NOT here: the collapse toggle (the two surfaces use different
// icons) and the project switcher's placement (local hosts it in the header, remote in
// the sidebar). Sharing those would mean abstracting over a real difference.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SidebarBellToggle,
  SidebarBrand,
  SidebarCollapseToggle,
  SidebarResizeHandle,
  SidebarSearchField,
  SidebarSearchToggle,
} from "./sidebar-chrome.js";

const h = React.createElement;
const noop = () => {};

// --- the brand lockup -------------------------------------------------------------

// The seal sits in the lockup, not in the icon rail: the rail is only up while the
// sidebar is collapsed, so leaving the brand there would mean the app has no mark at all
// in its normal, expanded state.
test("the brand renders the seal beside the wordmark", () => {
  const html = renderToStaticMarkup(h(SidebarBrand));
  assert.match(html, /class="sidebar-brand"/);
  assert.match(html, /src="\/static\/sealwire_logo\.png"/);
  assert.match(html, /Sealwire</, "the wordmark names the app");
});

// `alt=""` on purpose — the wordmark beside it already names the app, so alt text would
// make a screen reader say "Sealwire" twice.
test("the brand logo is decorative, because the wordmark carries the name", () => {
  assert.match(renderToStaticMarkup(h(SidebarBrand)), /alt=""/);
});

// --- the search toggle ------------------------------------------------------------

test("the search toggle reports whether the field is open", () => {
  const closed = renderToStaticMarkup(h(SidebarSearchToggle, { open: false, onToggle: noop }));
  assert.match(closed, /aria-expanded="false"/);
  assert.ok(!closed.includes("is-active"), "a closed field must not look armed");

  const open = renderToStaticMarkup(h(SidebarSearchToggle, { open: true, onToggle: noop }));
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /is-active/);
});

// `aria-expanded` is right for search (it discloses a field) and WRONG for the bell,
// which discloses nothing. Getting these the same way round would be a real
// accessibility regression that looks like tidying.
test("search is a disclosure; the bell is a toggle", () => {
  const search = renderToStaticMarkup(h(SidebarSearchToggle, { open: true, onToggle: noop }));
  assert.ok(search.includes("aria-expanded"), "the search field is disclosed by this button");
  assert.ok(!search.includes("aria-pressed"), "it is not a pressed state, it is an expanded one");

  const bell = renderToStaticMarkup(h(SidebarBellToggle, { on: true, onToggle: noop }));
  assert.ok(bell.includes("aria-pressed"), "the bell re-groups the list in place");
  assert.ok(
    !bell.includes("aria-expanded"),
    "there is no popover under the bell, so nothing is expanded"
  );
});

// The shortcut hint is optional. Session search used to advertise ⌘F; that key
// is left to the browser, so surfaces that only open this field from the
// magnifying glass pass no hint.
test("the shortcut hint appears only where there is a shortcut", () => {
  const withHint = renderToStaticMarkup(
    h(SidebarSearchToggle, { open: false, onToggle: noop, shortcutHint: "⌘K" })
  );
  assert.match(withHint, /title="Search sessions \(⌘K\)"/);

  const without = renderToStaticMarkup(h(SidebarSearchToggle, { open: false, onToggle: noop }));
  assert.match(without, /title="Search sessions"/);
  assert.ok(!without.includes("⌘"), "no shortcut, no promise of one");
});

// --- the bell toggle --------------------------------------------------------------

test("the bell reports whether it is narrowing the list", () => {
  const off = renderToStaticMarkup(h(SidebarBellToggle, { on: false, onToggle: noop }));
  assert.match(off, /aria-pressed="false"/);
  assert.ok(!off.includes("is-active"));

  const on = renderToStaticMarkup(h(SidebarBellToggle, { on: true, onToggle: noop }));
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /is-active/);
});

// --- the search field: the conditional-rendering proof ----------------------------

// THIS is the step this module exists for. Local always mounted the field and set
// `hidden`, because every id inside it had to resolve at `dom.js` import time. A shared
// component cannot honour that contract and also be honest on remote, so the field now
// simply is not rendered when closed — and local retired the handles instead of hiding
// the node.
test("a closed search field renders NOTHING, not a hidden node", () => {
  const html = renderToStaticMarkup(
    h(SidebarSearchField, { open: false, query: "", onInput: noop, onClose: noop })
  );
  assert.equal(html, "", "closed means absent; `hidden` is the contract this replaces");
});

test("an open search field renders the input, the glyph and the clear button", () => {
  const html = renderToStaticMarkup(
    h(SidebarSearchField, { open: true, query: "parser", onInput: noop, onClose: noop })
  );
  assert.match(html, /class="sidebar-search"/);
  assert.match(html, /class="sidebar-search-input"/);
  assert.match(html, /value="parser"/, "the field is controlled by the draft");
  assert.match(html, /class="sidebar-search-clear"/);
  assert.match(html, /aria-label="Search session titles"/);
});

// The field is controlled by a LOCAL DRAFT, never by the executed query. Binding it to
// `threadSearch.query` — which only advances after the debounce fires — makes React
// restore the previous value after every keystroke, so typing a word char by char ends up
// searching for its last letter. `page.fill()` sets the value in one shot and hides this
// completely; only real key-by-key input shows it.
test("the input carries no id, so two surfaces can mount it at once", () => {
  const html = renderToStaticMarkup(
    h(SidebarSearchField, { open: true, query: "", onInput: noop, onClose: noop })
  );
  assert.ok(!/\bid="/.test(html), "ids are what made these two implementations collide");
});

// --- the re-render hazard, again --------------------------------------------------

// Same rule as the nav: these glyphs are injected with `dangerouslySetInnerHTML`, and a
// `click` only fires when mousedown and mouseup resolve to the same node. Without
// `.inline-icon`'s `pointer-events: none` a re-render mid-gesture leaves the button
// hovering, depressing, and doing nothing.
test("every glyph is an .inline-icon, so a re-render cannot swallow the click", () => {
  const markups = [
    renderToStaticMarkup(h(SidebarSearchToggle, { open: false, onToggle: noop })),
    renderToStaticMarkup(h(SidebarBellToggle, { on: false, onToggle: noop })),
    renderToStaticMarkup(h(SidebarSearchField, { open: true, query: "", onInput: noop, onClose: noop })),
  ];
  for (const html of markups) {
    const glyphs = [...html.matchAll(/<span class="([^"]*)"[^>]*><svg/g)].map((m) => m[1]);
    assert.ok(glyphs.length >= 1, `expected at least one glyph in ${html.slice(0, 60)}`);
    for (const className of glyphs) {
      assert.ok(
        className.split(/\s+/).includes("inline-icon"),
        `glyph "${className}" must be .inline-icon or its button goes dead`
      );
    }
  }
});

test("every button is type=button, so none of them can submit a form", () => {
  for (const element of [
    h(SidebarSearchToggle, { open: false, onToggle: noop }),
    h(SidebarBellToggle, { on: false, onToggle: noop }),
    h(SidebarSearchField, { open: true, query: "", onInput: noop, onClose: noop }),
  ]) {
    const html = renderToStaticMarkup(element);
    const buttons = (html.match(/<button/g) || []).length;
    const typed = (html.match(/type="button"/g) || []).length;
    assert.equal(typed, buttons, `every one of the ${buttons} button(s) needs type=button`);
  }
});

// --- the resize handle ------------------------------------------------------------

// Duplicated verbatim on both surfaces except for its `id`, which each shell's drag
// wiring finds it by. The drag maths stays per-surface; what is shared is the
// ACCESSIBILITY contract, which is what had two copies free to drift.
test("the resize handle is a keyboard-reachable separator, not a decorative strip", () => {
  const html = renderToStaticMarkup(h(SidebarResizeHandle, { id: "sidebar-resize" }));
  assert.match(html, /role="separator"/, "without a role this is an unlabelled div");
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-label="Resize navigation panel"/);
  assert.match(html, /tabindex="0"/, "it must be reachable without a pointer");
});

// The id is the ONE thing that differs, so it has to come from the caller — a shared
// constant here would collide the moment both shells rendered it on one page.
test("the resize handle takes its id from the caller", () => {
  for (const id of ["sidebar-resize", "remote-sidebar-resize"]) {
    assert.match(renderToStaticMarkup(h(SidebarResizeHandle, { id })), new RegExp(`id="${id}"`));
  }
});

// --- the collapse toggle ----------------------------------------------------------

// Nearly missed: local's glyph was `ToggleLeftPanelIcon` and remote's was
// `RemoteToggleLeftPanelIcon`, which read as two different icons and was used to argue the
// button could not be shared. The two functions were byte for byte identical. A prefix is
// not a difference — hence a test that the shared button actually draws the panel glyph.
test("the collapse toggle carries the panel glyph and the ⌘B hint", () => {
  const html = renderToStaticMarkup(h(SidebarCollapseToggle, { id: "sidebar-top-toggle" }));
  assert.match(html, /title="Hide navigation panel \(⌘B\)"/);
  assert.match(html, /aria-label="Hide navigation panel"/);
  assert.match(html, /class="header-button header-panel-toggle sidebar-top-toggle"/);
  // The panel outline with the divider on the LEFT — the sidebar's own edge.
  assert.match(html, /<rect x="1.5" y="2.5" width="13" height="11" rx="2"/);
  assert.match(html, /x1="6"[^/]*x2="6"/);
});

test("the collapse toggle takes its id from the caller, like the resize handle", () => {
  for (const id of ["sidebar-top-toggle", "remote-sidebar-top-toggle"]) {
    assert.match(
      renderToStaticMarkup(h(SidebarCollapseToggle, { id })),
      new RegExp(`id="${id}"`),
      "each shell's collapse wiring finds this button by id"
    );
  }
});
