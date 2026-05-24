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
