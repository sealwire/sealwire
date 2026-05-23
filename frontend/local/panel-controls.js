// One unified state model per panel: the CSS variable holds the displayed
// width, and "closed" is just "width === 0". A separate localStorage entry
// remembers the most recent non-zero width so the toggle button can restore it.
// Both the drag handle and the toggle button mutate the same variable; the
// drag handle also collapses to 0 when the user pulls past a small threshold.

const CLOSE_THRESHOLD = 80;
const DEFAULT_OPEN_WIDTH = 300;
const MOBILE_BREAKPOINT = 960;

export function createPanelControl({
  cssVarName,
  widthStorageKey,
  openWidthStorageKey,
  minOpenWidth = 200,
  maxOpenWidth = 520,
  defaultOpenWidth = DEFAULT_OPEN_WIDTH,
  side = "left",
}) {
  const root = document.documentElement;

  let openWidth = clamp(
    readNumber(openWidthStorageKey, defaultOpenWidth),
    minOpenWidth,
    maxOpenWidth
  );
  let currentWidth = readNumber(widthStorageKey, openWidth);
  if (currentWidth > 0 && currentWidth < minOpenWidth) {
    currentWidth = minOpenWidth;
  }
  if (currentWidth > maxOpenWidth) currentWidth = maxOpenWidth;
  applyWidth(root, cssVarName, currentWidth);

  function getWidth() {
    return currentWidth;
  }

  function setWidth(value, { commit = true, updateOpenWidth = true } = {}) {
    const next = Math.max(0, Math.min(value, maxOpenWidth));
    currentWidth = next;
    applyWidth(root, cssVarName, next);
    if (commit) {
      writeNumber(widthStorageKey, next);
    }
    if (updateOpenWidth && next >= minOpenWidth) {
      openWidth = next;
      writeNumber(openWidthStorageKey, next);
    }
    emit();
  }

  function isOpen() {
    return currentWidth > 0;
  }

  function open() {
    setWidth(openWidth);
  }

  function close() {
    setWidth(0, { updateOpenWidth: false });
  }

  function toggle() {
    if (isOpen()) {
      close();
    } else {
      open();
    }
  }

  const listeners = new Set();
  function emit() {
    listeners.forEach((listener) => {
      try {
        listener({ width: currentWidth, isOpen: currentWidth > 0 });
      } catch (error) {
        console.warn("panel-control listener failed", error);
      }
    });
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener({ width: currentWidth, isOpen: currentWidth > 0 });
    return () => listeners.delete(listener);
  }

  function attachResizeHandle(handle) {
    if (!handle) return null;
    let dragging = false;
    let pointerId = null;
    let dragStartWidth = currentWidth;
    let dragStartX = 0;

    function onPointerDown(event) {
      if (isMobile()) return;
      dragging = true;
      pointerId = event.pointerId;
      dragStartWidth = currentWidth;
      dragStartX = event.clientX;
      handle.setPointerCapture?.(event.pointerId);
      document.body.classList.add("is-resizing-panel");
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!dragging) return;
      const delta = event.clientX - dragStartX;
      const next = side === "left"
        ? dragStartWidth + delta
        : dragStartWidth - delta;
      setWidth(Math.max(0, Math.min(next, maxOpenWidth)), {
        commit: false,
        updateOpenWidth: false,
      });
    }

    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      if (pointerId != null && handle.releasePointerCapture) {
        try {
          handle.releasePointerCapture(pointerId);
        } catch (_error) {
          // ignore
        }
      }
      pointerId = null;
      document.body.classList.remove("is-resizing-panel");
      if (currentWidth < CLOSE_THRESHOLD) {
        // Snap to 0 — user dragged past the close threshold.
        setWidth(0, { updateOpenWidth: false });
      } else {
        const snapped = clamp(currentWidth, minOpenWidth, maxOpenWidth);
        setWidth(snapped);
      }
    }

    function onDoubleClick() {
      setWidth(defaultOpenWidth);
    }

    function onKeyDown(event) {
      if (isMobile()) return;
      const delta = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const next = side === "left" ? currentWidth - delta : currentWidth + delta;
        setWidth(Math.max(0, Math.min(next, maxOpenWidth)));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = side === "left" ? currentWidth + delta : currentWidth - delta;
        setWidth(Math.max(0, Math.min(next, maxOpenWidth)));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    }

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    handle.addEventListener("dblclick", onDoubleClick);
    handle.addEventListener("keydown", onKeyDown);

    return {
      destroy() {
        handle.removeEventListener("pointerdown", onPointerDown);
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerUp);
        handle.removeEventListener("pointercancel", onPointerUp);
        handle.removeEventListener("dblclick", onDoubleClick);
        handle.removeEventListener("keydown", onKeyDown);
      },
    };
  }

  function attachToggleButton(button) {
    if (!button) return null;
    function onClick() {
      toggle();
    }
    button.addEventListener("click", onClick);
    const unsub = subscribe(({ isOpen: open }) => {
      button.setAttribute("aria-pressed", open ? "true" : "false");
      button.classList.toggle("is-active", open);
    });
    return {
      destroy() {
        button.removeEventListener("click", onClick);
        unsub();
      },
    };
  }

  return {
    getWidth,
    setWidth,
    isOpen,
    open,
    close,
    toggle,
    subscribe,
    attachResizeHandle,
    attachToggleButton,
  };
}

function applyWidth(root, cssVarName, value) {
  root.style.setProperty(cssVarName, `${Math.round(value)}px`);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readNumber(key, fallback) {
  if (!key || typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeNumber(key, value) {
  if (!key || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch (_error) {
    // ignore
  }
}

function isMobile() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}
