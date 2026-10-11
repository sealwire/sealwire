// Positions a dropdown menu against its trigger, measured rather than declared.
//
// These menus were placed in CSS (`top: calc(100% + 6px)` off a `position: relative`
// trigger), which only holds while the trigger is the offset parent and nothing
// between them clips. The phone sheet broke both at once and every menu rendered
// below the scroll clip. Placement is measured here instead, so it can also flip
// and size itself to the room available.
//
// The portal target is the enclosing `<dialog>`, not `<body>`: the menu has to
// clear `.session-dialog-body`'s `overflow-y: auto`, but `showModal()` makes
// everything OUTSIDE the dialog inert, so leaving it would cost every tap.
import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { CONTEXT_MENU_MARGIN_PX, placeAnchoredMenu } from "./context-menu-position.js";

const h = React.createElement;

// Tri-state: `undefined` = still resolving where to mount on this open cycle,
// `null` = no dialog ancestor (render inline), otherwise portal into that dialog.
function resolveMenuPortalTarget(anchorRef) {
  const anchor = anchorRef?.current;
  if (!anchor) {
    return undefined;
  }
  return anchor.closest("dialog") ?? null;
}

/**
 * Lifts a menu to the enclosing `<dialog>`, and leaves it in place when there is
 * none — outside a dialog there is no clip to escape, and moving the node would
 * only risk breaking CSS that scopes these menus under a parent.
 *
 * Portal resolution waits for layout, not render: reading `anchorRef.current` during
 * render saw `null` on the first open frame often enough that the tall grouped model
 * menu stayed under `.setting-pill` and picked up the legacy CSS anchor, which reads
 * as a clipped grey strip above Permissions while Effort/Permissions still looked fine.
 *
 * A portal keeps the React tree but not the DOM tree, which is why
 * `useDismissableMenu` has to be told about the menu node separately: otherwise a
 * press on the menu's own rows reads as "outside" and closes it.
 */
export function MenuPortal({ anchorRef, children, open }) {
  const [portalTarget, setPortalTarget] = useState(undefined);

  useLayoutEffect(() => {
    if (!open) {
      setPortalTarget(undefined);
      return undefined;
    }
    setPortalTarget(resolveMenuPortalTarget(anchorRef));
    return undefined;
  }, [anchorRef, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  // Prefer the layout-resolved target, but read the anchor synchronously when it
  // is already there so the menu and `useAnchoredMenu` land in the same commit.
  const target =
    portalTarget !== undefined ? portalTarget : resolveMenuPortalTarget(anchorRef);

  if (target === undefined) {
    return null;
  }
  if (target === null) {
    return h(React.Fragment, null, children);
  }
  return createPortal(h(React.Fragment, null, children), target);
}

// The rectangle a menu may occupy, in layout-viewport coordinates: the visual
// viewport intersected with every clipping ancestor.
export function placementBounds(view, menu) {
  const vv = view.visualViewport;
  const viewLeft = vv?.offsetLeft || 0;
  const viewTop = vv?.offsetTop || 0;
  const viewRight = viewLeft + (vv?.width || view.innerWidth || 0);
  const viewBottom = viewTop + (vv?.height || view.innerHeight || 0);

  let left = viewLeft;
  let top = viewTop;
  let right = viewRight;
  let bottom = viewBottom;

  for (let el = menu.parentElement; el; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    const clips = !(
      style.overflow === "visible"
      && style.overflowX === "visible"
      && style.overflowY === "visible"
    );
    if (clips) {
      const box = el.getBoundingClientRect();
      // A zero-size ancestor would pin the menu into nothing.
      if (box.width > 0 && box.height > 0) {
        left = Math.max(left, box.left);
        top = Math.max(top, box.top);
        right = Math.min(right, box.right);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    // A modal dialog is painted in the top layer, so nothing above it clips.
    if (isTopLayerDialog(el)) {
      break;
    }
  }

  // Disjoint ancestors invert the rect; the viewport is the usable answer.
  if (right <= left || bottom <= top) {
    return {
      height: Math.max(0, viewBottom - viewTop),
      left: viewLeft,
      top: viewTop,
      width: Math.max(0, viewRight - viewLeft),
    };
  }

  return { height: bottom - top, left, top, width: right - left };
}

/** Only `showModal()` reaches the top layer; `:modal` may be unimplemented. */
function isTopLayerDialog(el) {
  if (el.tagName !== "DIALOG") {
    return false;
  }
  try {
    return el.matches(":modal");
  } catch {
    return Boolean(el.open);
  }
}

/**
 * Measuring lifts the height cap, and an element that no longer overflows has its
 * `scrollTop` clamped to zero — the menu's own and any nested scroller's. So the
 * offsets are taken before and put back after, or a re-place while a long list is
 * half-scrolled snaps the user to the top.
 */
function captureScrollOffsets(menu) {
  const saved = [];
  const record = (el) => {
    if (el.scrollTop || el.scrollLeft) {
      saved.push({ el, left: el.scrollLeft, top: el.scrollTop });
    }
  };
  record(menu);
  for (const child of menu.querySelectorAll("*")) {
    record(child);
  }
  return saved;
}

export function useAnchoredMenu({ menuRef, open, triggerRef }) {
  const [menuMounted, setMenuMounted] = useState(false);

  const assignMenuRef = useCallback(
    (node) => {
      menuRef.current = node;
      setMenuMounted(Boolean(node));
    },
    [menuRef]
  );

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) {
      return;
    }
    const view = menu.ownerDocument?.defaultView;
    if (!view) {
      return;
    }

    // Read BEFORE anything is written: clearing the cap below is what loses these.
    const savedScroll = captureScrollOffsets(menu);

    delete menu.dataset.placed;
    menu.style.visibility = "hidden";
    menu.style.position = "fixed";
    // Opposing CSS insets would stretch the fixed menu instead of sizing to its content.
    menu.style.right = "auto";
    menu.style.bottom = "auto";
    // A keyboard or pinch zoom changes both the size and offset of the visible bounds.
    const bounds = placementBounds(view, menu);
    // The cap the menu sets for ITSELF, read with the inline value cleared so the
    // stylesheet's own rule shows through. A panel that caps its height and scrolls
    // inside (the workspace picker is 420px over a scrolling row list) means it, so
    // placement may only shrink it to fit — never grant it more than it asked for.
    // Without this the measurement below, which must run uncapped, is also the last
    // word: the cap is cleared and never restored.
    menu.style.maxHeight = "";
    const declaredMaxHeight = Number.parseFloat(view.getComputedStyle(menu).maxHeight);
    const selfCap = Number.isFinite(declaredMaxHeight) ? declaredMaxHeight : Infinity;
    menu.style.maxHeight = "none";
    // Measure height at the final width, or wrapping rows grow over an upward trigger.
    menu.style.maxWidth = `${Math.round(bounds.width - CONTEXT_MENU_MARGIN_PX * 2)}px`;
    // Park at the containing block's origin. The rect this produces does double
    // duty: its size is the menu's width-constrained size, and its position IS the origin
    // of whatever frame `fixed` resolves against here — (0,0) when that is the
    // viewport, the dialog's corner when a transform has intervened.
    menu.style.left = "0px";
    menu.style.top = "0px";
    const originBox = menu.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();

    const placement = placeAnchoredMenu({
      // Capped, so placement decides where a menu of the size it will ACTUALLY be
      // fits. Feeding it the uncapped height makes it believe a self-capping menu
      // is far too tall for the space below its trigger, and move it away.
      menuHeight: Math.min(originBox.height, selfCap),
      menuWidth: originBox.width,
      triggerBottom: triggerBox.bottom - bounds.top,
      triggerLeft: triggerBox.left - bounds.left,
      triggerRight: triggerBox.right - bounds.left,
      triggerTop: triggerBox.top - bounds.top,
      viewportHeight: bounds.height,
      viewportWidth: bounds.width,
    });

    // Bounds coordinates → layout viewport → containing block.
    menu.style.left = `${Math.round(placement.left + bounds.left - originBox.left)}px`;
    menu.style.top = `${Math.round(placement.top + bounds.top - originBox.top)}px`;
    menu.style.maxHeight = `${Math.round(Math.min(placement.maxHeight, selfCap))}px`;
    // Exposed so styling can point a caret the right way and so tests can assert
    // the flip without recomputing geometry.
    menu.dataset.placement = placement.placement;
    menu.dataset.alignment = placement.alignment;
    menu.dataset.placed = "true";
    menu.style.visibility = "";

    // The cap is back, so the overflow is back, so these offsets are legal again.
    for (const { el, left, top } of savedScroll) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }, [menuRef, triggerRef]);

  // Layout effect, not effect: this runs after the menu is in the DOM but before
  // the browser paints, so the menu never flashes at its unplaced position.
  useLayoutEffect(() => {
    if (!open || !menuMounted) {
      return undefined;
    }
    place();
    return undefined;
  }, [menuMounted, open, place]);

  useEffect(() => {
    if (!open || !menuMounted) {
      return undefined;
    }
    const menu = menuRef.current;
    const view = menu?.ownerDocument?.defaultView;
    if (!view || !menu) {
      return undefined;
    }
    // A fixed menu does not travel with its trigger, so anything that moves the
    // trigger has to re-place it. Capture-phase scroll catches the dialog body
    // scrolling under the pill, which does not bubble to the window.
    //
    // Capture also hears scrolls originating INSIDE the menu, which move nothing.
    // Skipping them is a performance guard, not a correctness one — `place()`
    // restores the offsets it collapses either way — but it avoids a forced
    // synchronous layout on every wheel notch through a long list.
    const onScroll = (event) => {
      const node = menuRef.current;
      const target = event.target;
      if (node && target instanceof view.Node && node.contains(target)) {
        return;
      }
      place();
    };

    view.addEventListener("resize", place);
    view.addEventListener("scroll", onScroll, true);
    view.visualViewport?.addEventListener("resize", place);
    view.visualViewport?.addEventListener("scroll", place);

    // Placement is derived from the menu's SIZE, so content that changes while it
    // is open invalidates it — and one of these is a combobox that rewrites its row
    // count as you type. `place()` restores everything it touches, so a stable menu
    // produces no net change and the observer goes quiet after one pass.
    const observer =
      typeof view.ResizeObserver === "function"
        ? new view.ResizeObserver(() => place())
        : null;
    if (observer && menu) {
      observer.observe(menu);
    }

    return () => {
      view.removeEventListener("resize", place);
      view.removeEventListener("scroll", onScroll, true);
      view.visualViewport?.removeEventListener("resize", place);
      view.visualViewport?.removeEventListener("scroll", place);
      observer?.disconnect();
    };
  }, [menuMounted, menuRef, open, place]);

  return assignMenuRef;
}
