// Regression guards for the sidebar / right-rail collapse layout.
//
// Background: the local + remote shells lay out [Sidebar | ChatShell | Rail]
// as a 3-column CSS grid. When a panel is collapsed we previously set
// `display: none` on the panel element, which removed it from the grid and
// let CSS auto-placement reflow the surviving children into adjacent columns
// — ChatShell ended up in the 0-width slot while the rail occupied the 1fr
// slot, swapping the visible layout. The fix is to keep the panel in the
// grid (visibility: hidden + pointer-events: none + overflow: hidden) and
// force the column to 0 via grid-template-columns.
//
// These tests parse the stylesheet text and assert the structural
// invariants so the bug can't silently reappear.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stylesPath = fileURLToPath(new URL("../styles.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

function extractRule(selector) {
  // Find a rule whose selector list contains an exact match for `selector`.
  // Selector lists may span multiple lines (comma-separated), so we
  // accumulate text from after the previous `}` until we hit `{`.
  let cursor = 0;
  while (cursor < styles.length) {
    const braceIndex = styles.indexOf("{", cursor);
    if (braceIndex < 0) break;
    // Walk back to the prior `}` or start of file to capture the full head.
    let headStart = styles.lastIndexOf("}", braceIndex - 1) + 1;
    if (headStart < 0) headStart = 0;
    const head = styles.slice(headStart, braceIndex);
    // Skip at-rules (e.g. `@media (...)` which have a brace too).
    const trimmedHead = head.trim();
    if (trimmedHead.startsWith("@")) {
      cursor = braceIndex + 1;
      continue;
    }
    const selectorList = head
      .replace(/\s+/g, " ")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (selectorList.includes(selector)) {
      let depth = 1;
      let scan = braceIndex + 1;
      while (scan < styles.length && depth > 0) {
        const ch = styles[scan];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        scan += 1;
      }
      return styles.slice(braceIndex + 1, scan - 1);
    }
    cursor = braceIndex + 1;
  }
  throw new Error(`Could not find CSS rule for selector \`${selector}\``);
}

test("collapsed sidebar does NOT use `display: none` (would reflow grid)", () => {
  const rule = extractRule("body.sidebar-collapsed .sidebar");
  assert.doesNotMatch(
    rule,
    /display\s*:\s*none/,
    "body.sidebar-collapsed .sidebar must not use `display: none` — that removes the panel from the CSS grid and lets the rail reflow into the chat column. Use `visibility: hidden` instead."
  );
  assert.match(
    rule,
    /visibility\s*:\s*hidden/,
    "body.sidebar-collapsed .sidebar should use `visibility: hidden` so the panel keeps its grid slot."
  );
  assert.match(
    rule,
    /pointer-events\s*:\s*none/,
    "body.sidebar-collapsed .sidebar should disable pointer events while invisible."
  );
});

test("collapsed right rail does NOT use `display: none`", () => {
  const rule = extractRule("body.rail-collapsed .right-rail");
  assert.doesNotMatch(
    rule,
    /display\s*:\s*none/,
    "body.rail-collapsed .right-rail must not use `display: none` (same reflow trap)."
  );
  assert.match(rule, /visibility\s*:\s*hidden/);
  assert.match(rule, /pointer-events\s*:\s*none/);
});

test("collapsed sidebar grid template keeps the 3-column rail intact", () => {
  // When the sidebar is collapsed but the rail is visible, the template
  // must still declare three columns (0, 1fr, rail) — collapsing to two
  // columns would let the rail eat the chat column.
  const rule = extractRule("body.sidebar-collapsed .app-shell-with-rail");
  const match = rule.match(/grid-template-columns\s*:\s*([^;]+);/);
  assert.ok(match, "Expected a grid-template-columns declaration");
  const columns = match[1]
    .replace(/minmax\([^)]+\)/g, "minmax()") // collapse functions for counting
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(
    columns.length,
    3,
    `Expected 3 columns, got ${columns.length}: ${match[1].trim()}`
  );
  assert.equal(columns[0], "0", "First column should be 0 when sidebar is collapsed");
});

test("collapsed sidebar on Tasks does not reserve an empty right-rail column", () => {
  // Observed: icon-rail up (sidebar collapsed) on Tasks left a ~320px blank
  // strip to the right of the embedded detail. `body.sidebar-collapsed
  // .app-shell-with-rail` still declared three tracks; Tasks has no app rail,
  // so the third track was empty void. Beat that rule with a view-scoped twin.
  assert.match(
    styles,
    /body\.sidebar-collapsed\s+\.app-shell-with-rail\[data-view="tasks"\][^\{]*\{[^}]*grid-template-columns:\s*0\s+minmax\(0,\s*1fr\)/,
    "collapsed Tasks must be two tracks (0, 1fr), not a ghost rail column"
  );
  assert.match(
    styles,
    /body\.sidebar-collapsed\s+\.app-shell-with-rail\[data-view="review"\]/,
    "review has the same no-app-rail contract"
  );
  assert.match(
    styles,
    /body\.sidebar-collapsed\s+\.app-shell-with-rail\[data-view="usage"\][^\{]*\{[^}]*grid-template-columns:\s*0\s+minmax\(0,\s*1fr\)/,
    "collapsed Usage must not keep a ghost 320px right-rail track"
  );
});

test("collapsed rail grid template keeps the sidebar column intact", () => {
  const rule = extractRule("body.rail-collapsed .app-shell-with-rail");
  const match = rule.match(/grid-template-columns\s*:\s*([^;]+);/);
  assert.ok(match, "Expected a grid-template-columns declaration");
  const columns = match[1]
    .replace(/minmax\([^)]+\)/g, "minmax()")
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(columns.length, 3, `Expected 3 columns, got ${columns.length}`);
  assert.equal(columns[2], "0", "Third column should be 0 when rail is collapsed");
});

test("both panels collapsed still keeps 3 columns (0, 1fr, 0)", () => {
  const rule = extractRule(
    "body.rail-collapsed.sidebar-collapsed .app-shell-with-rail"
  );
  const match = rule.match(/grid-template-columns\s*:\s*([^;]+);/);
  assert.ok(match, "Expected a grid-template-columns declaration");
  const columns = match[1]
    .replace(/minmax\([^)]+\)/g, "minmax()")
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(columns.length, 3, `Expected 3 columns, got ${columns.length}`);
  assert.equal(columns[0], "0");
  assert.equal(columns[2], "0");
});

// --- Mobile responsive guards ---------------------------------------------
// The desktop persisted collapsed state (saved width=0 from a previous
// session) used to leak onto mobile, leaving the sidebar invisible and the
// grid stuck on the 3-column template. The mobile media query must override
// both the column template and the visibility/opacity properties so the
// responsive layout always wins.

function extractMobileMediaBlock() {
  // Locate the @media (max-width: 960px) block that contains our recent
  // mobile responsive rules. Anchor on a marker that's unique to that
  // specific block — the `:not(.remote-app-shell)` rule for hiding the
  // sidebar-bottom-bar only appears there, so we won't accidentally pick
  // up an older @media block.
  const marker = ".app-shell:not(.remote-app-shell) .sidebar-bottom-bar";
  const markerIdx = styles.indexOf(marker);
  assert.ok(markerIdx > 0, "expected to find the mobile-only sidebar-bottom-bar rule");
  // Walk back to find the enclosing @media (max-width: 960px) { ... } block.
  const atMediaIdx = styles.lastIndexOf("@media (max-width: 960px)", markerIdx);
  assert.ok(atMediaIdx >= 0, "expected @media (max-width: 960px) before mobile rule");
  const openBrace = styles.indexOf("{", atMediaIdx);
  let depth = 1;
  let scan = openBrace + 1;
  while (scan < styles.length && depth > 0) {
    const ch = styles[scan];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    scan += 1;
  }
  return styles.slice(openBrace + 1, scan - 1);
}

test("mobile media query forces single-column grid even when body.sidebar-collapsed", () => {
  const block = extractMobileMediaBlock();
  // Must override the desktop body.sidebar-collapsed 3-column rule, otherwise
  // the desktop rule wins on specificity and the layout breaks on phones.
  assert.match(
    block,
    /body\.sidebar-collapsed\s+\.app-shell-with-rail\s*[,{]/,
    "mobile media query must include a `body.sidebar-collapsed .app-shell-with-rail` override"
  );
  assert.match(
    block,
    /grid-template-columns\s*:\s*1fr\s*;/,
    "mobile override should collapse to single column"
  );
});

test("mobile media query restores sidebar visibility when desktop state says collapsed", () => {
  const block = extractMobileMediaBlock();
  assert.match(
    block,
    /body\.sidebar-collapsed\s+\.sidebar\s*\{[^}]*visibility\s*:\s*visible/s,
    "must reset visibility on collapsed sidebar at mobile breakpoint"
  );
  assert.match(
    block,
    /body\.sidebar-collapsed\s+\.sidebar\s*\{[^}]*opacity\s*:\s*1/s,
    "must reset opacity on collapsed sidebar at mobile breakpoint"
  );
  assert.match(
    block,
    /body\.sidebar-collapsed\s+\.sidebar\s*\{[^}]*pointer-events\s*:\s*auto/s,
    "must restore pointer-events on collapsed sidebar at mobile breakpoint"
  );
});

test("mobile media query bumps icon-button touch target to at least 32px", () => {
  const block = extractMobileMediaBlock();
  const match = block.match(/\.header-icon-button\s*\{([^}]+)\}/);
  assert.ok(match, ".header-icon-button must be sized for touch on mobile");
  const decls = match[1];
  const widthMatch = decls.match(/width\s*:\s*(\d+)px/);
  const heightMatch = decls.match(/height\s*:\s*(\d+)px/);
  assert.ok(widthMatch, "expected explicit width");
  assert.ok(heightMatch, "expected explicit height");
  assert.ok(
    Number(widthMatch[1]) >= 32,
    `icon button width should be ≥32px on mobile, got ${widthMatch[1]}px`
  );
  assert.ok(
    Number(heightMatch[1]) >= 32,
    `icon button height should be ≥32px on mobile, got ${heightMatch[1]}px`
  );
});

test("mobile media query hides desktop-only chrome (rail, resize handles, toggle buttons)", () => {
  const block = extractMobileMediaBlock();
  assert.match(block, /\.right-rail\s*\{\s*display\s*:\s*none\s*;?\s*\}/);
  assert.match(
    block,
    /\.sidebar-resize\s*,\s*\.right-rail-resize\s*,\s*\.task-workspace-resize\s*\{\s*display\s*:\s*none\s*;?\s*\}/
  );
});

test("mobile media query overrides view-scoped collapsed Tasks/Teams/Review grids", () => {
  // The desktop ghost-track rules use
  // `body.sidebar-collapsed .app-shell-with-rail[data-view="tasks"]` — higher
  // specificity than the generic mobile `body.sidebar-collapsed .app-shell-with-rail`
  // reset. Without matching view selectors inside the mobile block, a phone
  // inherits `0 1fr` / `sidebar 1fr` instead of a single column.
  const block = extractMobileMediaBlock();
  for (const view of ["tasks", "teams", "review", "ticket", "usage"]) {
    assert.match(
      block,
      new RegExp(
        `body\\.sidebar-collapsed\\s+\\.app-shell-with-rail\\[data-view="${view}"\\]`
      ),
      `mobile reset must beat desktop collapsed ${view} grid`
    );
    assert.match(
      block,
      new RegExp(
        `body\\.rail-collapsed\\.sidebar-collapsed\\s+\\.app-shell-with-rail\\[data-view="${view}"\\]`
      ),
      `mobile reset must beat dual-collapsed ${view} grid`
    );
  }
  assert.match(
    block,
    /body\.sidebar-collapsed\s+\.app-shell-with-rail\[data-view="tasks"\][^]*?grid-template-columns:\s*1fr/s,
    "collapsed Tasks on mobile must force single-column"
  );
});

test("Tasks workspace grid is scoped; Teams Library keeps a fixed detail column", () => {
  // Sharing `--task-orch-panel-width` on every `.task-workspace` lets a Tasks
  // drag widen the Teams Library detail pane. Tasks owns the CSS var; Teams
  // keeps the pre-resize minmax(280px, 360px) detail track.
  // The half-workspace cap lives in the resize controller (not CSS `min(...,
  // 50%)`) so drag math and rendered width stay in sync.
  assert.match(
    styles,
    /\.task-workspace:not\(\.teams-workspace\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--task-orch-panel-width/s,
    "Tasks grid must size the Orchestrator from its CSS var"
  );
  assert.doesNotMatch(
    styles,
    /\.task-workspace:not\(\.teams-workspace\)\s*\{[^}]*min\(var\(--task-orch-panel-width/s,
    "do not CSS-cap at 50% — that desyncs drag start from rendered width"
  );
  assert.match(
    styles,
    /\.task-workspace\.teams-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(280px,\s*360px\)/s,
    "Teams Library must keep its independent 280–360px detail column"
  );
});

test("narrow task-workspace media query beats the desktop column selectors", () => {
  // `.task-workspace:not(.teams-workspace)` and `.teams-workspace` outrank a
  // bare `.task-workspace` inside @media, so the ≤900px single-column reset
  // must restate those selectors or the panes stay side-by-side.
  const marker = ".task-workspace-resize";
  const atMediaIdx = styles.lastIndexOf("@media (max-width: 900px)");
  assert.ok(atMediaIdx >= 0, "expected @media (max-width: 900px) for task workspace");
  const openBrace = styles.indexOf("{", atMediaIdx);
  let depth = 1;
  let scan = openBrace + 1;
  while (scan < styles.length && depth > 0) {
    const ch = styles[scan];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    scan += 1;
  }
  const block = styles.slice(openBrace + 1, scan - 1);
  assert.ok(block.includes(marker), "expected resize hide inside the 900px block");
  assert.match(
    block,
    /\.task-workspace:not\(\.teams-workspace\)\s*,\s*\.task-workspace\.teams-workspace\s*\{[^}]*grid-template-columns:\s*1fr/s
  );
});

test("Tasks/Teams stack when the main mount is narrower than two panes need", () => {
  // Viewport media alone misses "wide window + wide sidebar → skinny workspace".
  // Container queries on the mount (not on `.task-workspace` itself) stack at
  // <640px so a 320px Orchestrator floor cannot leave a 160px detail strip.
  assert.match(
    styles,
    /container-type:\s*inline-size/,
    "task/teams mounts must establish a size container"
  );
  assert.match(
    styles,
    /@container[^{]*\(max-width:\s*639px\)/,
    "stack when the workspace mount is under 640px"
  );
  const atIdx = styles.search(/@container[^{]*\(max-width:\s*639px\)/);
  assert.ok(atIdx >= 0);
  const openBrace = styles.indexOf("{", atIdx);
  let depth = 1;
  let scan = openBrace + 1;
  while (scan < styles.length && depth > 0) {
    const ch = styles[scan];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    scan += 1;
  }
  const block = styles.slice(openBrace + 1, scan - 1);
  assert.match(
    block,
    /\.task-workspace:not\(\.teams-workspace\)\s*,\s*\.task-workspace\.teams-workspace\s*\{[^}]*grid-template-columns:\s*1fr/s
  );
});

test("tasks view surfaces a sidebar expand control when the sidebar is collapsed", () => {
  // The chat header's left-panel toggle is unreachable on Tasks — the whole
  // header is `display: none`. The Orchestrator header owns the replacement,
  // and it must only appear in the collapsed state (same pattern as
  // `.chat-header-collapsed-actions`).
  assert.match(
    styles,
    /body\.sidebar-collapsed\s+\.app-shell\[data-view="tasks"\][^{]*#tasks-sidebar-toggle/,
    "collapsed Tasks must reveal #tasks-sidebar-toggle"
  );
  assert.match(
    styles,
    /#tasks-sidebar-toggle\s*\{[^}]*display:\s*none/,
    "the tasks expand control stays hidden while the sidebar is open"
  );
});

test("mobile mode suppresses the tasks sidebar expand control", () => {
  // ≤960px keeps the sidebar visible despite a persisted collapsed width, so a
  // "Show navigation panel" button would lie. Mirror the left-panel toggle kill.
  const block = extractMobileMediaBlock();
  assert.match(
    block,
    /body\.sidebar-collapsed\s+\.app-shell\[data-view="tasks"\]\s+#tasks-sidebar-toggle\s*\{[^}]*display:\s*none/,
    "collapsed-state reveal must not win on mobile"
  );
});

test("embedded task detail shares one horizontal inset, not 32px on some rows and 20px on others", () => {
  // The right pane looked ragged: header padded to 20px while banner / actions /
  // sub-tasks still carried the full-screen 32px margins.
  assert.match(
    styles,
    /\.task-screen\.is-embedded\s+\.task-banner[^}]*margin[^;]*20px/,
    "embedded banner inset must match the header"
  );
  assert.match(
    styles,
    /\.task-screen\.is-embedded\s+\.task-actions[^}]*margin[^;]*20px/,
    "embedded actions inset must match the header"
  );
});
