// Guards for where the app's brand and its way into Settings live.
//
// Background: both used to sit in a 64px icon rail to the left of the sidebar —
// seal logo at the top, gear at the bottom, nothing else. They have moved into
// the sidebar itself (logo into the brand lockup, gear onto the footer status
// line), which leaves the rail with nothing to show while the sidebar is open.
// So the rail is now the COLLAPSED-state shell only.
//
// That split has two failure modes worth pinning down:
//
//   1. Show the rail while expanded and the logo and the gear each render TWICE,
//      64px apart.
//   2. Hide the rail while collapsed and the window has no brand and no reachable
//      Settings at all — the sidebar that holds the replacements is
//      `visibility: hidden` in exactly that state.
//
// The collapsed appearance is meant to be unchanged from before the split.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Comments are stripped before any parsing: the naive "walk back to the previous
// `}` to find the selector head" trick below would otherwise swallow the comment
// above a rule, and prose commas ("Expanded, its two occupants…") would split
// into bogus selectors and hide the real one.
const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const shell = readFileSync(fileURLToPath(new URL("./react-shell.js", import.meta.url)), "utf8");
const appJs = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8");
const renderSession = readFileSync(fileURLToPath(new URL("./render-session.js", import.meta.url)), "utf8");

// Pull the body of the first rule whose selector list contains an exact match,
// searching only within `scope` (so a media-query block can be searched on its
// own). Mirrors the helper in panel-collapse.test.mjs.
function ruleBody(selector, scope = styles) {
  let cursor = 0;
  while (cursor < scope.length) {
    const brace = scope.indexOf("{", cursor);
    if (brace < 0) break;
    const head = scope.slice(Math.max(scope.lastIndexOf("}", brace - 1) + 1, 0), brace);
    if (head.trim().startsWith("@")) {
      cursor = brace + 1;
      continue;
    }
    const selectors = head.replace(/\s+/g, " ").split(",").map((s) => s.trim()).filter(Boolean);
    if (selectors.includes(selector)) {
      let depth = 1;
      let scan = brace + 1;
      while (scan < scope.length && depth > 0) {
        if (scope[scan] === "{") depth += 1;
        else if (scope[scan] === "}") depth -= 1;
        scan += 1;
      }
      return scope.slice(brace + 1, scan - 1);
    }
    cursor = brace + 1;
  }
  throw new Error(`Could not find CSS rule for selector \`${selector}\``);
}

// The text of the `@media (max-width: 960px)` block, brace-matched.
function mobileBlock() {
  const start = styles.indexOf("@media (max-width: 960px)");
  assert.ok(start >= 0, "expected a ≤960px media query");
  const brace = styles.indexOf("{", start);
  let depth = 1;
  let scan = brace + 1;
  while (scan < styles.length && depth > 0) {
    if (styles[scan] === "{") depth += 1;
    else if (styles[scan] === "}") depth -= 1;
    scan += 1;
  }
  return styles.slice(brace + 1, scan - 1);
}

// --- the rail is the collapsed-state shell ----------------------------------

test("the icon rail is hidden while the sidebar is expanded", () => {
  assert.match(
    ruleBody(".icon-rail"),
    /display:\s*none/,
    "an expanded sidebar already shows the logo and the gear; the rail would duplicate both"
  );
});

test("the icon rail comes back when the sidebar collapses", () => {
  assert.match(
    ruleBody("body.sidebar-collapsed .icon-rail"),
    /display:\s*flex/,
    "collapsed, the rail is the only surviving brand + Settings surface"
  );
});

// Specificity regression. `body.sidebar-collapsed .icon-rail { display: flex }`
// scores (0,2,1), and a media query contributes NO specificity of its own — so a
// bare `.icon-rail { display: none }` inside the ≤960px block scores (0,1,0) and
// LOSES. The rail would pop back onto a phone screen the moment the sidebar
// happened to be collapsed, which is most of the time on mobile.
test("the mobile kill-switch still beats the collapsed rule", () => {
  const mobile = mobileBlock();
  assert.match(
    ruleBody("body.sidebar-collapsed .icon-rail", mobile),
    /display:\s*none/,
    "≤960px must hide the rail even when the sidebar is collapsed"
  );
});

// --- collapsed, the rail IS the navigation -----------------------------------
//
// While `body.sidebar-collapsed` is set the sidebar is `visibility: hidden`, so
// every row in `SidebarNav` is unreachable and the rail is the only navigation on
// screen. It shipped with a Tasks button and NO Sessions button — a user who
// collapsed the panel while on the Task screen had no way back to their sessions
// short of re-opening the panel. That gap was a consequence of the nav being a
// segmented control, which has no icon-only form to collapse into; a row is
// already a glyph plus a label, so the rail is just the same rows with the labels
// dropped. Both destinations, or the rail is not a nav.

// `assert.match` prints the ENTIRE haystack when it fails, and app.js is ~156 KB —
// one failed match scrolls the real message off the screen. These files are big
// enough that the regex plus a sentence is the more useful failure.
function assertSource(source, pattern, message) {
  assert.ok(pattern.test(source), `${message} (no match for ${pattern})`);
}

// The rail and the rows are now ONE component (shared/sidebar-nav.js) in two forms,
// so "both offer the same destinations" is proved once, structurally, over there —
// see sidebar-nav.test.mjs, "both forms offer exactly the same destinations". What
// is still local's business, and what these guards cover, is that the rail actually
// MOUNTS it: a rail that rendered nothing would be a nav-less collapsed state, which
// is the original bug in a new shape.
test("the collapsed rail mounts the shared nav", () => {
  assertSource(
    shell,
    /id:\s*"icon-rail-nav"/,
    "the rail is the whole nav while collapsed; it needs the mount to render into"
  );
  assertSource(
    renderSession,
    /renderReactContent\(iconRailNavMount,\s*h\(SidebarNavRail,/,
    "the mount has to be filled with the rail form of the shared nav"
  );
});

// The strongest form this guard can take. Both mounts are handed the SAME props
// object — not two objects built alike — so the rail and the rows cannot disagree
// about where you are, what is waiting, or where a click goes. Four id-addressed
// listeners in app.js used to carry this, and nothing stopped them drifting apart.
test("the rail and the rows are driven by one props object", () => {
  const start = renderSession.indexOf("function renderSidebarNav");
  assert.ok(start >= 0, "expected renderSidebarNav to exist");
  const body = renderSession.slice(start, renderSession.indexOf("\n  }", start));

  assertSource(body, /renderReactContent\(sidebarNavMount,\s*h\(SidebarNav,\s*props\)\)/, "the rows read `props`");
  assertSource(
    body,
    /renderReactContent\(iconRailNavMount,\s*h\(SidebarNavRail,\s*props\)\)/,
    "the rail reads the SAME `props`, or the two forms can drift again"
  );
  // One fact, two renderings: the sidebar shows a count, the rail reduces it to a
  // dot. Both come off this single value, so they cannot disagree about whether
  // anything is waiting — and a rail that stayed quiet would go silent in exactly
  // the state where the user has the least on screen to notice.
  assertSource(
    body,
    /tasksWaitingCount:\s*teamsNeedingYou\(/,
    "the badge counts tasks waiting on a PERSON, not tasks that exist"
  );
  assertSource(body, /onOpenSessions:|onOpenTasks:|onOpenUsage:/, "all three destinations must be reachable");
});

// The nav is CHROME, not session content, and moving it into a mount made that
// distinction load-bearing for the first time. As static markup in the shell it
// could not go missing; rendered into `#sidebar-nav` it appears only when something
// calls renderSidebarNav(), and the shell has three top-level states that each
// repaint independently, including when the relay is unavailable.
test("every shell state renders the nav, including the ones with no session", () => {
  for (const entry of [
    "renderSession",
    "renderSessionUnavailable",
  ]) {
    const start = renderSession.indexOf(`function ${entry}(`);
    assert.ok(start >= 0, `expected ${entry} to exist`);
    const body = renderSession.slice(start, renderSession.indexOf("\n  }", start));
    assertSource(
      body,
      /renderSidebarNav\(\)/,
      `${entry} must render the nav — it is chrome, and used to be markup that could not go missing`
    );
  }
});

// Another state, before boot settles: "boot has not
// reached any terminal state yet".
//
// `renderLocalShell()` is synchronous and paints only the empty mounts. `boot()` then
// awaits a network round trip (`loadSession`) before the
// first `renderSession`. So between first paint and boot settling, the sidebar has no
// search or bell buttons and no Sessions/Tasks rows.
//
// The worst case is the collapsed one, and it is not hypothetical: `createPanelControl`
// restores the collapsed state from localStorage at MODULE level, before those awaits. A
// user who quit with the sidebar collapsed therefore boots into a rail holding a logo and
// a gear and NO destinations — which is exactly the bug the shared nav was written to make
// impossible, returning through the boot window. On a slow or unreachable relay that
// window is not milliseconds.
test("the sidebar chrome is painted before boot awaits anything", () => {
  const bootAt = appJs.indexOf("void boot();");
  assert.ok(bootAt > 0, "expected a `void boot();` call to anchor against");
  const paintAt = appJs.indexOf("paintInitialSidebarChrome();");
  assert.ok(
    paintAt > 0 && paintAt < bootAt,
    "the chrome must be painted at module scope BEFORE boot's first await, or a collapsed "
      + "user sees a rail with no destinations until the network answers"
  );
});

// The `[data-view]` mirror is gone, and must stay gone. It existed only because the
// nav was static markup that could not take a prop: the view was mirrored onto
// `<body>` so CSS could reach the rail (which sits outside `.app-shell`), while
// `aria-current` was written separately from render-session because CSS cannot set
// it. Two writes for one fact. Re-adding either would restore the drift.
test("the nav's selected state has exactly one source: the prop", () => {
  assert.doesNotMatch(
    renderSession,
    /document\.body\.dataset\.view\s*=/,
    "the body[data-view] mirror is the component's prop now; a second source can disagree with it"
  );
  assert.doesNotMatch(
    renderSession,
    /setAttribute\("aria-current"/,
    "aria-current comes from the same comparison as the class, inside the component"
  );
  assert.match(
    ruleBody(".icon-rail-button.is-current"),
    /background:\s*var\(/,
    "the rail's current destination must fill, not merely recolour"
  );
});

// --- the sidebar nav is a row stack ------------------------------------------
//
// There is no track and no travelling indicator behind these rows, so the
// selected row has to carry a FILL of its own — colour alone leaves nothing
// marking where you are. And it must not be the raised/shadowed pill, which is
// this app's button treatment: "where you are" and "do this" have to stay apart.
test("the selected sidebar nav row is filled, not just recoloured", () => {
  const selected = ruleBody(".sidebar-nav-row.is-current");
  assert.match(selected, /background:\s*var\(--surface-\d\)/);
  assert.doesNotMatch(selected, /box-shadow/, "a shadow would make the current view look like a button");
});

// Hover and selection are both "a filled row", so if they land on adjacent
// surface steps they read as the same thing — hovering Sessions while on Tasks
// lit two rows that looked alike, worst in the light theme where the steps are
// closest. The exact tokens are free to move; sharing one is the bug.
test("hover and selection do not share a fill", () => {
  const fill = (body) => body.match(/background:\s*(var\(--surface-\d\))/)?.[1];
  const hover = fill(ruleBody(".sidebar-nav-row:hover"));
  const selected = fill(ruleBody(".sidebar-nav-row.is-current"));
  assert.ok(hover, "the hovered row must fill — it is the only affordance a row has");
  assert.ok(selected, "the selected row must fill");
  assert.notEqual(selected, hover, `hover and selected both use ${hover}; the row you are on becomes unreadable`);
});

// "Exactly one row is aria-current" moved into the component with the rest of the
// selected state, and is asserted against a real render in
// sidebar-nav.test.mjs ("the current destination is marked, and only ever one of
// them") rather than against a pair of imperative writes here. What is left for this
// file is that local passes a destination at all — a nav rendered without `current`
// lights nothing, which looks like "no view is selected" rather than like a bug.
test("local tells the nav which destination it is on", () => {
  const start = renderSession.indexOf("function renderSidebarNav");
  const body = renderSession.slice(start, renderSession.indexOf("\n  }", start));
  assertSource(
    body,
    /current:[\s\S]*usage[\s\S]*sessions/,
    "the view context is the canonical answer to which screen you are on"
  );
});

// --- the brand lockup --------------------------------------------------------

// The lockup's markup was byte-for-byte identical to remote's, so it is now literally the
// same component and its contents are asserted once, in
// `shared/sidebar-chrome.test.mjs`. What is local's business is that it still renders one.
//
// Note it is used DIRECTLY here, not through a mount: it takes no props, so a file that
// renders exactly once loses nothing by holding it.
test("the local sidebar brand is the shared lockup", () => {
  assertSource(shell, /h\(SidebarBrand\)/, "the brand must render, or the app has no mark");
  assert.doesNotMatch(
    shell,
    /className:\s*"sidebar-brand-logo"/,
    "hand-written brand markup here is the duplicate that was just removed"
  );
});

// Search and toggles must also render when the relay is unavailable.
test("every shell state renders the sidebar chrome", () => {
  for (const entry of [
    "renderSession",
    "renderSessionUnavailable",
  ]) {
    const start = renderSession.indexOf(`function ${entry}(`);
    assert.ok(start >= 0, `expected ${entry} to exist`);
    const body = renderSession.slice(start, renderSession.indexOf("\n  }", start));
    assertSource(
      body,
      /renderSidebarChrome\(\)/,
      `${entry} must render the search + bell toggles; they used to be markup that could not go missing`
    );
  }
});

// The point of the whole exercise: local no longer keeps the field mounted-and-hidden.
// If `hidden` comes back, so does the constraint that made two implementations necessary.
test("the search field is absent when closed, not hidden", () => {
  assertSource(shell, /id:\s*"sidebar-search-mount"/, "the field needs a mount to render into");
  assert.doesNotMatch(
    shell,
    /className:\s*"sidebar-search"[^)]*hidden/,
    "an always-mounted hidden field is the contract this replaced"
  );
  assert.doesNotMatch(
    styles,
    /\.sidebar-search\[hidden\]/,
    "nothing sets `hidden` on the field any more; the rule would be dead and misleading"
  );
});

// The state moved OUT of the DOM. `open` used to be read back off `sidebarSearch.hidden`
// and the draft off `sidebarSearchInput.value` — using the rendered nodes as the model is
// exactly what made conditional rendering impossible, so a regression here would quietly
// re-impose it.
test("the search field's own state is not read back out of the DOM", () => {
  assert.doesNotMatch(appJs, /getElementById\("sidebar-search/, "no id handles for the field");
  assert.doesNotMatch(appJs, /getElementById\("sidebar-bell-toggle"\)/, "nor for the bell");
  assertSource(appJs, /setSearchDraft\(/, "the draft lives in the shared store");
  assertSource(appJs, /setSearchOpen\(/, "and so does whether the field is open");
});

// --- Settings is reachable in every state -----------------------------------

test("the sidebar footer carries a Settings gear", () => {
  assert.match(shell, /id:\s*"sidebar-settings"/);
  assert.match(shell, /className:\s*"sidebar-settings-button"/);
});

test("all three Settings gears are wired to the modal", () => {
  for (const id of ["sidebar-settings", "open-settings-header"]) {
    assert.match(
      appJs,
      new RegExp(`getElementById\\("${id}"\\)[\\s\\S]{0,80}?settings\\.open\\(\\)`),
      `#${id} must open the Settings modal`
    );
  }
  assert.match(appJs, /iconRailSettingsButton\?\.addEventListener\([\s\S]{0,60}?settings\.open\(\)/);
});

// Every one of those gears is a bare glyph in a button, and the glyph is injected
// with `dangerouslySetInnerHTML`. A `click` only fires when mousedown and mouseup
// resolve to the SAME node, so if anything re-renders between the two the <svg> is
// replaced and the browser fires no click at all — the button hovers, depresses,
// and does nothing. Remote reproduces this on demand (its `[sidebar-debug]` tracer
// calls renderLog() on pointerdown, landing a re-render mid-gesture); local is one
// stray re-render away from the same thing. Making the icon transparent to hit
// testing means the button is always the target and the glyph's identity stops
// mattering.
test("an icon inside a button is never the click target", () => {
  assert.match(
    ruleBody(".inline-icon"),
    /pointer-events:\s*none/,
    "a re-render between mousedown and mouseup would otherwise swallow the click entirely"
  );
});

// The footer bar is `display: none` on local mobile, so the footer gear cannot be
// the only entry — the chat-header gear is what covers that case, and the ≤960px
// block has to un-hide it against the base `display: none`.
test("the mobile header gear survives as the phone entry point", () => {
  assert.match(mobileBlock(), /\.app-shell\s+\.header-settings-button\s*\{[^}]*display:\s*inline-flex/);
});
