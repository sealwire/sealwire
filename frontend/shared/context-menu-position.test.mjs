import test from "node:test";
import assert from "node:assert/strict";

import {
  placeContextMenu,
  placeFlyout,
  positionContextMenuElement,
  updateContextMenuContent,
} from "./context-menu-position.js";

// Regression: both sidebar context menus (session rows and project rows) were
// positioned by clamping the click point with a *hardcoded* height guess
// (`window.innerHeight - 64` / `- 96`). The menu always opened downward, so a
// right-click on a row near the bottom of a long list ran the menu off the
// bottom of the viewport — its actions were unreachable. The menu must flip
// upward (anchor its bottom at the click) when there isn't room below.

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };

test("opens downward from the click when there is room below", () => {
  const placement = placeContextMenu({
    anchorX: 300,
    anchorY: 120,
    menuWidth: 220,
    menuHeight: 260,
    ...VIEWPORT,
  });
  assert.equal(placement.top, 120);
  assert.equal(placement.left, 300);
  assert.equal(placement.placement, "below");
});

test("flips upward when the menu would overflow the bottom edge", () => {
  const menuHeight = 260;
  const anchorY = 740; // near the bottom of an 800px viewport
  const placement = placeContextMenu({
    anchorX: 300,
    anchorY,
    menuWidth: 220,
    menuHeight,
    ...VIEWPORT,
  });
  assert.equal(placement.placement, "above");
  // Bottom edge sits at the click point, so the whole menu is on screen.
  assert.equal(placement.top, anchorY - menuHeight);
  assert.ok(
    placement.top + menuHeight <= VIEWPORT.viewportHeight,
    `menu bottom ${placement.top + menuHeight} overflows viewport`
  );
});

test("stays on screen when the menu fits in neither direction", () => {
  const placement = placeContextMenu({
    anchorX: 300,
    anchorY: 400,
    menuWidth: 220,
    menuHeight: 900, // taller than the viewport
    ...VIEWPORT,
  });
  assert.ok(placement.top >= 0, `top ${placement.top} is off screen`);
});

test("picks the roomier side when neither side fully fits", () => {
  const below = placeContextMenu({
    anchorX: 300,
    anchorY: 300,
    menuWidth: 220,
    menuHeight: 600,
    ...VIEWPORT,
  });
  assert.equal(below.placement, "below"); // 500px below vs 300px above

  const above = placeContextMenu({
    anchorX: 300,
    anchorY: 520,
    menuWidth: 220,
    menuHeight: 600,
    ...VIEWPORT,
  });
  assert.equal(above.placement, "above"); // 520px above vs 280px below
});

test("flips left when the menu would overflow the right edge", () => {
  const placement = placeContextMenu({
    anchorX: 1150,
    anchorY: 100,
    menuWidth: 220,
    menuHeight: 200,
    ...VIEWPORT,
  });
  assert.equal(placement.left, 1150 - 220);
  assert.ok(placement.left + 220 <= VIEWPORT.viewportWidth);
});

test("never places the menu past the top/left margin", () => {
  const placement = placeContextMenu({
    anchorX: 2,
    anchorY: 4,
    menuWidth: 220,
    menuHeight: 200,
    ...VIEWPORT,
  });
  assert.ok(placement.left >= 0);
  assert.ok(placement.top >= 0);
});

function fakeMenu(width, height) {
  return {
    style: {},
    getBoundingClientRect: () => ({ width, height }),
  };
}

// The element-level wrapper is what app.js calls: it must measure the menu's
// *real* rendered height (not a constant) and write both coordinates.
test("positionContextMenuElement measures the menu and flips it up near the bottom", () => {
  const menu = fakeMenu(220, 300);
  const placement = positionContextMenuElement(menu, 300, 760, {
    innerWidth: 1200,
    innerHeight: 800,
  });
  assert.equal(placement.placement, "above");
  assert.equal(menu.style.top, `${760 - 300}px`);
  assert.equal(menu.style.left, "300px");
});

test("positionContextMenuElement writes a downward placement unchanged", () => {
  const menu = fakeMenu(220, 300);
  positionContextMenuElement(menu, 300, 100, { innerWidth: 1200, innerHeight: 800 });
  assert.equal(menu.style.top, "100px");
});

test("positionContextMenuElement tolerates an unmeasurable menu", () => {
  const menu = { style: {} };
  const placement = positionContextMenuElement(menu, 300, 790, {
    innerWidth: 1200,
    innerHeight: 800,
  });
  assert.ok(placement);
  assert.ok(Number.parseFloat(menu.style.top) >= 0);
});

// Regression: measuring only at open-time is not enough. The session menu's
// Project section is repopulated while the menu is open (the projects-store
// subscriber in app.js), so a menu that opened as a short "Loading projects…"
// note can grow into a tall project list. Without re-placing, the stale `top`
// from the short measurement leaves the grown menu's actions below the fold.
function growableMenu(height) {
  const menu = {
    hidden: false,
    style: {},
    height,
    getBoundingClientRect: () => ({ width: 220, height: menu.height }),
  };
  return menu;
}

const VIEW = { innerWidth: 1200, innerHeight: 800 };

test("updateContextMenuContent re-places a menu that grew taller than its space", () => {
  const menu = growableMenu(60); // "Loading projects…" — fits below the click
  const anchor = { clientX: 300, clientY: 700 };
  positionContextMenuElement(menu, anchor.clientX, anchor.clientY, VIEW);
  assert.equal(menu.style.top, "700px");

  // Projects resolve: the menu is rebuilt into a full list, growing to 420px.
  const placement = updateContextMenuContent(
    menu,
    anchor,
    () => {
      menu.height = 420;
    },
    VIEW
  );

  assert.equal(placement.placement, "above");
  const top = Number.parseFloat(menu.style.top);
  assert.ok(
    top + menu.height <= VIEW.innerHeight,
    `menu bottom ${top + menu.height} overflows viewport after repopulation`
  );
});

test("updateContextMenuContent re-derives placement when content shrinks", () => {
  const menu = growableMenu(420);
  const anchor = { clientX: 300, clientY: 700 };
  positionContextMenuElement(menu, anchor.clientX, anchor.clientY, VIEW);
  assert.equal(menu.style.top, `${700 - 420}px`); // flipped up while tall

  // Projects fetch fails: the list collapses to a one-line note, so the menu
  // should hang from the click again rather than stay stuck above it.
  updateContextMenuContent(
    menu,
    anchor,
    () => {
      menu.height = 60;
    },
    VIEW
  );
  assert.equal(menu.style.top, "700px");
});

test("updateContextMenuContent keeps the original click as the anchor", () => {
  const menu = growableMenu(60);
  const anchor = { clientX: 300, clientY: 100 };
  updateContextMenuContent(menu, anchor, () => {
    menu.height = 420;
  }, VIEW);
  assert.equal(menu.style.top, "100px");
  assert.equal(menu.style.left, "300px");
});

test("updateContextMenuContent still shows the menu when coordinates are missing", () => {
  const menu = growableMenu(60);
  menu.hidden = true;
  const placement = updateContextMenuContent(menu, {}, () => {}, VIEW);
  assert.ok(placement);
  assert.equal(menu.hidden, false);
  assert.ok(Number.parseFloat(menu.style.top) >= 0);
});

test("updateContextMenuContent ignores a menu with no usable anchor", () => {
  const menu = growableMenu(60);
  let populated = false;
  const placement = updateContextMenuContent(menu, null, () => {
    populated = true;
  }, VIEW);
  assert.equal(placement, null);
  assert.equal(populated, false);
  assert.equal(menu.style.top, undefined);
});

// --- second-level panel beside a menu (the model picker's flyout) -------------------

const PANEL = { left: 32, right: 280, top: 400, bottom: 560 };

test("a flyout opens to the right, overlapping the menu edge, and bottom-aligned above its trigger", () => {
  // The design draws the menu opened upward with both panels' bottoms on one line.
  const placed = placeFlyout({ alignBottom: true, height: 300, menu: PANEL, width: 232, ...VIEWPORT });
  assert.deepEqual(placed, { fits: true, left: 276, maxHeight: 776, side: "right", top: 260, width: 232 });
});

test("a flyout below its trigger lines up with the menu's top", () => {
  const placed = placeFlyout({ alignBottom: false, height: 300, menu: PANEL, width: 232, ...VIEWPORT });
  assert.equal(placed.top, 400);
});

test("a flyout with no room on the right opens to the left", () => {
  const placed = placeFlyout({
    alignBottom: false,
    height: 100,
    menu: { left: 900, right: 1148, top: 100, bottom: 300 },
    width: 232,
    ...VIEWPORT,
  });
  assert.deepEqual([placed.side, placed.left], ["left", 672]);
});

test("a flyout that fits on neither side says so, so the picker can drill in instead", () => {
  // A phone: 248 + 232 does not fit in 390.
  const placed = placeFlyout({
    alignBottom: true,
    height: 200,
    menu: { left: 12, right: 260, top: 300, bottom: 600 },
    width: 232,
    viewportHeight: 800,
    viewportWidth: 390,
  });
  assert.equal(placed.fits, false);
});

test("a flyout taller than the room is pinned inside the margins and capped", () => {
  const placed = placeFlyout({ alignBottom: true, height: 2000, menu: PANEL, width: 232, ...VIEWPORT });
  assert.deepEqual([placed.top, placed.maxHeight], [12, 776]);
});

test("a flyout too wide for the room beside the menu is narrowed, not moved out of reach", () => {
  // OpenCode's names ("OpenAI/GPT-6 Astra Ultrafast") make the panel wider than the
  // dialog leaves; a narrower panel with ellipsed names beats losing the second level.
  const placed = placeFlyout({
    alignBottom: false,
    height: 100,
    menu: { left: 20, right: 268, top: 100, bottom: 300 },
    minWidth: 232,
    viewportHeight: 600,
    viewportWidth: 560,
    width: 300,
  });
  assert.deepEqual([placed.fits, placed.side, placed.left, placed.width], [true, "right", 264, 284]);
});
