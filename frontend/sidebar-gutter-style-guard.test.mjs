// The sidebar has ONE leading gutter, and it is the macOS traffic-light inset.
//
// On the desktop surface the window's close button is the first thing on that edge —
// the app does not draw it and cannot move it, so it is the fixed reference every
// row below has to meet. Its left edge is at 13px, MEASURED off a 2x window capture:
// first painted pixel at device x=26, centre at CSS 20.0, so a 14px-wide button.
//
// The first version of this guard asserted 14px, derived from remembered geometry
// ("12px buttons, 20px pitch, first centre at 20"). Everything downstream was
// perfectly consistent with that number and the column was still visibly 1px off the
// circles above it. So the value is pinned here as a measurement with its provenance
// in the comment, not as arithmetic anyone can redo from memory.
//
// What went wrong without this guard: `.sidebar` padded itself 20px while
// `.sidebar-nav` added another 10px of its own, so the Sessions/Tasks pills started
// 30px in — three different left edges stacked down the same 300px column (14 for
// the traffic lights, 20 for the collapse toggle and New session, 30 for the nav).
// Each value was locally reasonable; only the column read as ragged.
//
// So the invariant is a RELATION, not a set of numbers: the sidebar's horizontal
// padding IS the gutter token, and nothing inside the sidebar re-insets itself past
// it. A guard that only pinned `padding: 20px 14px` would go green the moment
// someone re-added a margin one level down — which is exactly the bug it exists to
// catch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW_CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8"
);

// Stripped once, up front. The prose comments in this stylesheet contain braces,
// semicolons and selector names in backticks, and any of those would end a rule head
// early — turning "the rule moved" into "no rule found", which reads the same as a
// passing guard if you are not careful.
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// Match on the WHOLE parsed head, split on commas, rather than on the characters
// around the hit: `.sidebar` is a substring of `.sidebar-nav`, `body.sidebar-collapsed
// .sidebar` and a dozen others, and a neighbour check catches the prefix cases but
// not a descendant rule ending in the same selector.
// Brace-depth walk rather than indexOf hops, because the two questions this guard asks
// — "is this head one of ours" and "is it inside an @media" — are both nesting
// questions, and a scan that answers them by looking backwards from a hit gets the
// second one wrong on a stylesheet with ~40 media blocks.
//
// Matching rules are MERGED in document order, the way the cascade would: `.sidebar`
// is declared more than once at top level (layout here, `position: relative` for the
// resize handle later), and reading only the last one reports `padding: undefined`
// for a rule that plainly sets it.
function declarations(selector, { inMediaQuery = false } = {}) {
  const merged = new Map();
  let matched = 0;
  const stack = [];
  let headStart = 0;

  for (let i = 0; i < CSS.length; i += 1) {
    const ch = CSS[i];
    if (ch !== "{" && ch !== "}") continue;

    if (ch === "{") {
      const head = CSS.slice(headStart, i).trim();
      const insideMedia = stack.some((h) => h.startsWith("@media"));
      stack.push(head);
      headStart = i + 1;

      if (head.startsWith("@")) continue;
      if (insideMedia !== inMediaQuery) continue;
      if (!head.split(",").some((part) => part.trim() === selector)) continue;

      // Declarations only run to the first nested `{`, but a plain rule has none —
      // and if one ever appears the head scan below re-anchors on it anyway.
      const close = CSS.indexOf("}", i);
      matched += 1;
      for (const piece of CSS.slice(i + 1, close).split(";")) {
        const at = piece.indexOf(":");
        if (at === -1) continue;
        merged.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
      }
      continue;
    }

    stack.pop();
    headStart = i + 1;
  }

  assert.notEqual(matched, 0, `no rule found for ${selector}`);
  return merged;
}

// `padding: 20px 14px` and `padding: 20px 14px 20px 14px` are the same box; the guard
// compares boxes, not source strings, or it fails on a purely cosmetic rewrite.
function paddingBox(shorthand) {
  const parts = shorthand.split(/\s+/).filter(Boolean);
  const [top, right = top, bottom = top, left = right] = parts;
  return { top, right, bottom, left };
}

test("the sidebar gutter token is the macOS traffic-light leading inset", () => {
  const root = declarations(":root");
  assert.equal(
    root.get("--sidebar-gutter"),
    "13px",
    "measured: the close button's first painted pixel is at device x=26 on a 2x capture, i.e. CSS 13"
  );
});

test("the sidebar's horizontal padding IS the gutter token", () => {
  const sidebar = declarations(".sidebar");
  const box = paddingBox(sidebar.get("padding") || "");
  assert.equal(box.left, "var(--sidebar-gutter)");
  assert.equal(box.right, "var(--sidebar-gutter)");
});

test("nothing in the sidebar re-insets itself past the gutter", () => {
  // The nav is the one that did. It is a direct flex child of `.sidebar` (its mount
  // is `display: contents`), so a horizontal margin here is a second, competing left
  // edge for the two most prominent rows in the column.
  const nav = declarations(".sidebar-nav");
  const parts = (nav.get("margin") || "").split(/\s+/).filter(Boolean);
  const [top, right = top, bottom = top, left = right] = parts;
  assert.equal(left, "0", `.sidebar-nav must not add its own left inset (got ${left})`);
  assert.equal(right, "0", `.sidebar-nav must not add its own right inset (got ${right})`);
  assert.ok(bottom, "margin shorthand still has to set the vertical rhythm");
});

test("the top bar's first control starts on the gutter, not beside it", () => {
  // The collapse toggle is the sidebar's first painted box and the one directly under
  // the traffic lights. A margin here would offset it from the nav pills below by
  // exactly the amount this whole file exists to keep at zero.
  const bar = declarations(".sidebar-top-bar");
  for (const prop of ["padding-left", "margin-left"]) {
    const value = bar.get(prop);
    assert.ok(
      value === undefined || value === "0",
      `.sidebar-top-bar must not set ${prop} (got ${value})`
    );
  }
  const padding = bar.get("padding");
  if (padding) {
    const box = paddingBox(padding);
    assert.equal(box.left, "0", ".sidebar-top-bar must not pad its leading edge");
  }
});

// The Sealwire logo row and the chat-header ("Small improvement") are one band
// across the top of the window. Sessions sits under that band the way the session
// tab strip sits under the chat-header — so the logo row must share the measured
// height, start at y=0 (no sidebar padding-top), and cancel the column gap so
// Sessions is not pushed below the tabs.
test("the sidebar logo row shares the measured chat-header band height", () => {
  const bar = declarations(".sidebar-top-bar");
  assert.equal(
    bar.get("min-height"),
    "var(--header-band-height, 67px)",
    "without this the logo row is shorter than the chat-header and Sessions drifts off the tab strip"
  );
  assert.equal(
    bar.get("box-sizing"),
    "border-box",
    "padding inside the band must not grow it past the measured chat-header height"
  );
});

test("the sidebar does not inset the logo band below the chat-header", () => {
  const sidebar = declarations(".sidebar");
  const box = paddingBox(sidebar.get("padding") || "");
  assert.equal(
    box.top,
    "0",
    `padding-top ${box.top} would push the logo band below the chat-header`
  );
  assert.equal(box.left, "var(--sidebar-gutter)");
  assert.equal(box.right, "var(--sidebar-gutter)");
});

test("the logo row cancels the sidebar stack gap so Sessions meets the tab strip", () => {
  const sidebar = declarations(".sidebar");
  assert.equal(sidebar.get("--sidebar-stack-gap"), "16px");
  assert.equal(sidebar.get("gap"), "var(--sidebar-stack-gap)");

  const bar = declarations(".sidebar-top-bar");
  assert.equal(
    bar.get("margin-bottom"),
    "calc(-1 * var(--sidebar-stack-gap))",
    "the column gap under the logo row would otherwise drop Sessions below the tabs"
  );

  const conversation = declarations('.app-shell[data-view="conversation"] .sidebar');
  assert.equal(
    conversation.get("--sidebar-stack-gap"),
    "12px",
    "conversation tightens the stack gap; the cancel must track that value"
  );
});
