// Viewport-aware placement for the sidebar context menus (session rows and
// project rows). Both used to be positioned by clamping the click point against
// a hardcoded height guess, which meant a right-click on a row near the bottom
// of a long list opened a menu that ran off the bottom edge. Placement here is
// flip-based: prefer opening down/right from the click, but anchor the menu's
// bottom/right edge at the click when that side has no room.

/** Gap kept between the menu and the viewport edges. */
export const CONTEXT_MENU_MARGIN_PX = 12;

/** Gap kept between a dropdown menu and the trigger it hangs off. */
export const ANCHORED_MENU_GAP_PX = 6;

// Only used when the menu can't be measured (never rendered / zero-size layout).
const FALLBACK_MENU_WIDTH_PX = 220;
const FALLBACK_MENU_HEIGHT_PX = 96;

function clamp(value, min, max) {
  // `min` wins when the menu is larger than the space it has to live in, so we
  // stay pinned to the top/left margin instead of drifting off screen.
  return Math.max(min, Math.min(value, max));
}

/**
 * The one flip rule, shared by both menu kinds: stay on the preferred side when
 * the menu fits there, flip when it doesn't, and when it fits on neither side
 * take the roomier one so the clamp loses as little as possible.
 */
function shouldFlip(size, spacePreferred, spaceOther) {
  return size > spacePreferred && (size <= spaceOther || spaceOther > spacePreferred);
}

/**
 * Pure placement math. Returns viewport (`position: fixed`) coordinates plus the
 * side each axis ended up on, so callers/tests can assert the flip.
 *
 * @returns {{ left: number, top: number, placement: "above"|"below", alignment: "left"|"right" }}
 */
export function placeContextMenu({
  anchorX = 0,
  anchorY = 0,
  menuWidth = 0,
  menuHeight = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = CONTEXT_MENU_MARGIN_PX,
} = {}) {
  const spaceBelow = viewportHeight - margin - anchorY;
  const spaceAbove = anchorY - margin;
  // Prefer downward (the familiar direction); flip up only when the menu
  // genuinely doesn't fit below.
  const openAbove = shouldFlip(menuHeight, spaceBelow, spaceAbove);

  const spaceRight = viewportWidth - margin - anchorX;
  const spaceLeft = anchorX - margin;
  const alignRight = shouldFlip(menuWidth, spaceRight, spaceLeft);

  const rawTop = openAbove ? anchorY - menuHeight : anchorY;
  const rawLeft = alignRight ? anchorX - menuWidth : anchorX;

  return {
    left: clamp(rawLeft, margin, viewportWidth - margin - menuWidth),
    top: clamp(rawTop, margin, viewportHeight - margin - menuHeight),
    placement: openAbove ? "above" : "below",
    alignment: alignRight ? "right" : "left",
  };
}

/**
 * Placement for a menu hanging off a TRIGGER BOX rather than a click point. Same
 * flip rule as the context menus, plus `maxHeight` — the room actually available
 * on the chosen side, which is what CSS could not express and why the Model list
 * was capped at a flat 340px and still ran off the edge.
 *
 * @returns {{ left: number, top: number, maxHeight: number,
 *             placement: "above"|"below", alignment: "left"|"right" }}
 */
export function placeAnchoredMenu({
  gap = ANCHORED_MENU_GAP_PX,
  margin = CONTEXT_MENU_MARGIN_PX,
  menuHeight = 0,
  menuWidth = 0,
  triggerBottom = 0,
  triggerLeft = 0,
  triggerRight = 0,
  triggerTop = 0,
  viewportHeight = 0,
  viewportWidth = 0,
} = {}) {
  // Space between the trigger's near edge and the viewport margin, on each side.
  const spaceBelow = viewportHeight - margin - (triggerBottom + gap);
  const spaceAbove = triggerTop - gap - margin;
  const openAbove = shouldFlip(menuHeight, spaceBelow, spaceAbove);

  // Negative space means the trigger itself is off-screen (mid-scroll, or a
  // keyboard has shrunk the visual viewport). Zero keeps the menu degenerate but
  // on-screen rather than inverted.
  const available = Math.max(openAbove ? spaceAbove : spaceBelow, 0);
  const height = Math.min(menuHeight, available);

  // Left-align to the trigger, flip to right-aligned when that overflows.
  const spaceRight = viewportWidth - margin - triggerLeft;
  const spaceLeft = triggerRight - margin;
  const alignRight = shouldFlip(menuWidth, spaceRight, spaceLeft);

  const rawTop = openAbove ? triggerTop - gap - height : triggerBottom + gap;
  const rawLeft = alignRight ? triggerRight - menuWidth : triggerLeft;

  return {
    alignment: alignRight ? "right" : "left",
    // `Math.max(margin, …)` guards the case where the menu is wider/taller than
    // the viewport itself: without it the clamp range inverts and `min` wins,
    // putting the menu off the top-left corner.
    left: clamp(rawLeft, margin, Math.max(margin, viewportWidth - margin - menuWidth)),
    maxHeight: available,
    placement: openAbove ? "above" : "below",
    top: clamp(rawTop, margin, Math.max(margin, viewportHeight - margin - height)),
  };
}

/**
 * A second-level panel beside `menu` (both rects in viewport coordinates). It
 * overlaps the menu's edge by `overlap`, as drawn, and narrows to the room on the
 * roomier side down to `minWidth`. `fits: false` means neither side has even that,
 * which on a phone is the usual answer.
 */
export function placeFlyout({
  alignBottom = false,
  height = 0,
  margin = CONTEXT_MENU_MARGIN_PX,
  menu,
  minWidth = null,
  overlap = 4,
  viewportHeight = 0,
  viewportWidth = 0,
  width = 0,
} = {}) {
  const roomRight = viewportWidth - margin - (menu.right - overlap);
  const roomLeft = menu.left + overlap - margin;
  const floor = Math.min(minWidth ?? width, width);
  const right = roomRight >= width || (roomRight >= floor && roomRight >= roomLeft);
  const room = right ? roomRight : roomLeft;
  if (room < floor) {
    return { fits: false };
  }
  const shownWidth = Math.min(width, room);
  const maxHeight = Math.max(0, viewportHeight - margin * 2);
  const shown = Math.min(height, maxHeight);
  const wanted = alignBottom ? menu.bottom - shown : menu.top;
  return {
    fits: true,
    left: right ? menu.right - overlap : menu.left + overlap - shownWidth,
    maxHeight,
    side: right ? "right" : "left",
    top: clamp(wanted, margin, Math.max(margin, viewportHeight - margin - shown)),
    width: shownWidth,
  };
}

/**
 * Measure an already-visible menu element and write its `position: fixed`
 * coordinates. Callers must unhide the menu (and finish populating it) first,
 * so the measured height reflects the real content — that measurement is the
 * whole point: a fixed guess is what let the menu overflow the bottom edge.
 */
/**
 * Rebuild a visible menu's dynamic content and re-place it from the SAME click
 * anchor. Placement depends on the menu's measured height, so any content swap
 * invalidates it: the session menu opens as a one-line "Loading projects…" note
 * and is repopulated into a tall project list once the payload settles, and a
 * `top` computed for the short version leaves the tall one hanging off the
 * bottom edge. Populate and place are one call so a caller can't do the first
 * without the second.
 *
 * Only for a menu that is (or is becoming) visible — it unhides to measure.
 * Returns null, without populating, when there's no usable anchor.
 */
export function updateContextMenuContent(menu, anchor, populate, view) {
  if (!menu || !menu.style || !anchor) {
    return null;
  }
  // A missing coordinate degrades to the top-left corner: the menu is still
  // reachable, where bailing out would leave it hidden with no way to open it.
  const clientX = Number.isFinite(anchor.clientX) ? anchor.clientX : 0;
  const clientY = Number.isFinite(anchor.clientY) ? anchor.clientY : 0;
  if (typeof populate === "function") {
    populate();
  }
  // Measuring a hidden element reports zero, which would fall back to the
  // placeholder size and mis-place the menu.
  menu.hidden = false;
  return positionContextMenuElement(menu, clientX, clientY, view);
}

export function positionContextMenuElement(menu, anchorX, anchorY, view) {
  if (!menu || !menu.style) {
    return null;
  }
  const viewport = view || (typeof window !== "undefined" ? window : null);
  const rect =
    typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : null;
  const menuWidth = rect?.width || menu.offsetWidth || FALLBACK_MENU_WIDTH_PX;
  const menuHeight = rect?.height || menu.offsetHeight || FALLBACK_MENU_HEIGHT_PX;

  const placement = placeContextMenu({
    anchorX,
    anchorY,
    menuWidth,
    menuHeight,
    viewportWidth: viewport?.innerWidth || 0,
    viewportHeight: viewport?.innerHeight || 0,
  });
  menu.style.left = `${Math.round(placement.left)}px`;
  menu.style.top = `${Math.round(placement.top)}px`;
  return placement;
}
