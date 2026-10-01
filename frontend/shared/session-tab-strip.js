import React from "react";

import { InlineTitleEditor } from "./inline-title-editor.js";
import { selectThreadDot } from "./thread-dot.js";
// The idle slot's content. A provider we ship no mark for leaves it empty rather
// than borrowing another vendor's logo, which would mislabel the session.
import { providerMark } from "./provider-mark.js";
import {
  REORDER_HOLD_MS,
  createStripGesture,
  edgeScrollStep,
  resolveDropTabId,
  scrollLeftToReveal,
  wheelScrollDelta,
} from "./tab-strip-gesture.js";

const { useEffect, useRef, useState } = React;
const h = React.createElement;

// The tab strip for a project's open sessions — Chrome/terminal shaped: pinned
// tabs hold a zone on the left, the focused tab is highlighted, tabs can be
// closed and dragged to reorder.
//
// Ordering is NOT decided here. The caller passes `items` already in strip order
// (pinned first), which is what `shared/tab-layout.js` guarantees; this component
// only reports intent (`onFocus` / `onClose` / `onTogglePin` / `onMove`) and lets
// the model own the invariants. Same split as ProjectSidebarList: a precomputed
// view model in, callbacks out.
//
// `onMove(tabId, toIndex)` uses the target tab's CURRENT index as the dragged
// tab's final index, which reads correctly dragging in either direction.
//
// Tabs are a FIXED width, so a project with many sessions overflows the strip
// instead of squeezing every title into an ellipsis. Reaching the overflow is
// what the gestures in `tab-strip-gesture.js` are for:
//
//   drag            → pan the strip
//   hold, then drag → reorder the tab under the pointer
//   wheel           → pan the strip (a vertical wheel scrolls it sideways)
//
// Panning has to be the gesture you get without thinking, because it's the one
// used constantly; reordering is rare and can afford the hold. Both run on
// pointer events — native HTML5 drag-and-drop would eat the pan the instant the
// pointer moved. The scrollbar stays hidden: it's a one-line strip and the
// gestures are the affordance.
//
// Mobile: touch panning is left to the browser (momentum scrolling we can't
// match), and every action is an explicit control (a × button, a pin button) —
// there is no right-click or hover affordance to depend on. Closing a tab only
// closes the view; the session is untouched.

function CloseGlyph() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2.2",
      strokeLinecap: "round",
    },
    h("path", { d: "M6 6l12 12M18 6L6 18" })
  );
}

function PinGlyph({ filled }) {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: filled ? "currentColor" : "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M12 17v4" }),
    h("path", { d: "M7 4h10l-1.2 7.2a2 2 0 0 0 .6 1.8L18 15H6l1.6-2a2 2 0 0 0 .6-1.8z" })
  );
}

function SessionTab({
  item,
  focused,
  isDragging,
  isDropTarget,
  editing,
  onFocus,
  onClose,
  onPromote,
  onTogglePin,
  onBeginRename,
  onCommitRename,
  onCancelRename,
}) {
  // One source of truth for the activity dot, shared with the thread list and
  // project cards — a tab must never disagree with the sidebar about a session.
  const dot = selectThreadDot({
    activity: item.activity || null,
    attentionKind: item.attentionKind || null,
    reviewing: Boolean(item.reviewing),
  });
  const renamable = Boolean(onBeginRename) && Boolean(item.threadId);

  return h(
    "div",
    {
      className:
        `session-tab${focused ? " is-focused" : ""}`
        + `${item.pinned ? " is-pinned" : ""}`
        + `${item.preview ? " is-preview" : ""}`
        + `${isDragging ? " is-dragging" : ""}`
        + `${isDropTarget ? " is-drop-target" : ""}`,
      "data-tab-id": item.tabId,
      "data-thread-id": item.threadId,
      // Read by the e2e suite, which has no way to ask about an italic title.
      "data-preview": item.preview ? "true" : undefined,
      "data-editing": editing ? "true" : undefined,
      // Right-click is the rename gesture. It goes straight into the editor rather
      // than opening a one-item menu: the tab IS the target and the label IS the
      // thing being changed, so a menu would only add a click. Double-click is not
      // available — it already promotes a preview tab (see onDoubleClick below).
      onContextMenu: renamable
        ? (event) => {
            event.preventDefault();
            // The sidebar row's own context menu lives on an ancestor; without this
            // a right-click on a tab would also open that session menu behind the
            // editor.
            event.stopPropagation();
            onBeginRename(item.tabId);
          }
        : undefined,
    },
    // One fixed-width slot for both states, so titles line up whether or not a
    // session has a dot — a slot that resized per state would make every title
    // jump as turns start and finish. Status outranks identity inside it: the
    // dot is transient and demands attention, the provider is static and can
    // wait for the session to settle.
    //
    // While editing, the lead moves OUT of the button and the button is replaced by
    // the input. An <input> nested in a <button> is invalid HTML, and the button
    // would swallow the clicks that place a caret — so the two are siblings, never
    // parent and child.
    editing
      ? h(
          "span",
          { className: "session-tab-main is-editing" },
          h(
            "span",
            { className: "session-tab-lead", "aria-hidden": "true" },
            dot
              ? h("span", { className: dot.className })
              : providerMark(item.provider, "session-tab-provider")
          ),
          h(InlineTitleEditor, {
            className: "session-tab-title-input",
            ariaLabel: "Session name",
            // Seeded from the DISPLAYED title so a never-renamed session opens with
            // the agent's name to edit, not an empty box.
            defaultValue: item.renameDraft ?? item.title,
            onCommit: (value) => onCommitRename?.(item.tabId, value),
            onCancel: () => onCancelRename?.(item.tabId),
          })
        )
      : h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": focused ? "true" : "false",
            className: "session-tab-main",
            onClick: () => onFocus?.(item.tabId),
            // F2 is the platform-neutral rename key (Explorer, VS Code, most IDEs).
            // Keyboard users cannot reach a right-click.
            onKeyDown: renamable
              ? (event) => {
                  if (event.key === "F2") {
                    event.preventDefault();
                    onBeginRename(item.tabId);
                  }
                }
              : undefined,
            // Same keep gesture as the sidebar row, on the other end of the journey:
            // you peeked, you stayed, now double click to stop it being replaceable.
            // Bound to the tab's own button so a double click on the close or pin
            // control — which stop their own clicks — can never promote a tab that is
            // on its way out.
            onDoubleClick: () => onPromote?.(item.tabId),
            title: item.tooltip || item.title,
          },
          h(
            "span",
            { className: "session-tab-lead", "aria-hidden": "true" },
            dot
              ? h("span", { className: dot.className })
              : providerMark(item.provider, "session-tab-provider")
          ),
          h("span", { className: "session-tab-title" }, item.title),
          dot ? h("span", { className: "sr-only" }, dot.label) : null
        ),
    h(
      "button",
      {
        type: "button",
        className: `session-tab-pin${item.pinned ? " is-pinned" : ""}`,
        title: item.pinned ? "Unpin tab" : "Pin tab",
        "aria-label": item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`,
        "aria-pressed": item.pinned ? "true" : "false",
        onClick: (event) => {
          event.stopPropagation();
          onTogglePin?.(item.tabId, !item.pinned);
        },
      },
      h(PinGlyph, { filled: item.pinned })
    ),
    h(
      "button",
      {
        type: "button",
        className: "session-tab-close",
        title: "Close tab",
        "aria-label": `Close ${item.title}`,
        onClick: (event) => {
          event.stopPropagation();
          onClose?.(item.tabId);
        },
      },
      h(CloseGlyph)
    )
  );
}

// Controls own their clicks; a press on one must never start a pan or a lift.
// The title editor is in here for the same reason plus one more: dragging inside it
// selects text, and a strip pan would steal that.
const CONTROL_SELECTOR =
  ".session-tab-pin, .session-tab-close, .session-tab-new, .session-tab-title-input";

function tabIdAt(node) {
  return node?.closest?.("[data-tab-id]")?.getAttribute("data-tab-id") || null;
}

export function SessionTabStrip({
  items = [],
  focusedTabId = null,
  onFocus = null,
  onClose = null,
  onPromote = null,
  onTogglePin = null,
  onMove = null,
  onNewTab = null,
  // `onRename(threadId, name)` — `name` is the raw box contents; the caller normalizes
  // (blank means "reset to the agent's own title"). Absent → tabs are not renamable and
  // no rename affordance is advertised at all.
  onRename = null,
  emptyMessage = "No open sessions.",
  reorderHoldMs = REORDER_HOLD_MS,
}) {
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);
  const [panning, setPanning] = useState(false);
  // Which tab is being renamed, if any. Local to the strip on purpose: an in-progress
  // edit is transient UI, not navigation state — it must not survive a reload or land
  // in the canonical session-view store.
  const [editingTabId, setEditingTabId] = useState(null);

  const stripRef = useRef(null);
  const gestureRef = useRef(null);
  if (!gestureRef.current) {
    gestureRef.current = createStripGesture();
  }
  const holdTimerRef = useRef(null);
  // A live gesture routes through the window, so the handlers it calls have to be
  // the CURRENT render's — a drag outlives several renders (activity dots tick),
  // and a stale `items` would resolve the drop onto the wrong index.
  const handlersRef = useRef(null);
  const bridgeRef = useRef(null);
  // The window the listeners went onto, held independently of the DOM ref: React
  // clears refs before running this effect's cleanup, so a teardown that looked
  // the window up through the strip would find nothing and leave them installed.
  const gestureViewRef = useRef(null);
  // Which pointer owns the gesture. A second contact on a hybrid device must not
  // steer or commit the drag the first one is still holding.
  const gesturePointerRef = useRef(null);
  // The edge auto-scroll runs on its own frames; the pointer sitting still at the
  // edge is exactly when it has to keep going.
  const edgeRef = useRef({ frame: 0, x: 0 });
  // Read inside effects that must not fight a pan in flight.
  const panningRef = useRef(false);
  panningRef.current = panning;
  // The drop target is read back inside pointer handlers; state alone would let a
  // handler captured before the last render report a stale target on release.
  const dropTargetRef = useRef(null);
  // A pan or a reorder ends with a click on whatever tab the pointer landed on.
  // That click is a leftover of the gesture, not a request to switch sessions.
  const suppressClickRef = useRef(false);

  const clearHold = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const setDropTarget = (tabId) => {
    if (dropTargetRef.current === tabId) {
      return;
    }
    dropTargetRef.current = tabId;
    setDropTargetId(tabId);
  };

  // Everything a gesture leaves behind, in one place — every exit path (release,
  // cancel, unmount) has to run all of it or a phantom drag survives.
  const endGesture = () => {
    clearHold();
    stopEdgeScroll();
    listenForGesture(false);
    gesturePointerRef.current = null;
    setDropTarget(null);
    setDraggingId(null);
    setPanning(false);
  };

  // Pointer moves and the release are taken from the window, not the strip. The
  // strip is one line tall: a press easily leaves it before the drag is decided,
  // and a release that lands elsewhere would otherwise never be seen — which used
  // to leave the hold timer lifting a tab nobody was dragging any more.
  //
  // This is also why the strip does NOT capture the pointer. Capture retargets the
  // compatibility mouse events, so a captured press fires its `click` on the strip
  // instead of on the tab's button, and the tab stops being clickable.
  const listenForGesture = (on) => {
    const listening = gestureViewRef.current;
    const view = on ? stripRef.current?.ownerDocument?.defaultView : listening;
    if (!view || Boolean(listening) === on) {
      return;
    }
    if (!bridgeRef.current) {
      bridgeRef.current = {
        move: (event) => handlersRef.current?.move(event),
        up: (event) => handlersRef.current?.up(event),
        cancel: (event) => handlersRef.current?.cancel(event),
      };
    }
    const bind = on ? view.addEventListener : view.removeEventListener;
    bind.call(view, "pointermove", bridgeRef.current.move);
    bind.call(view, "pointerup", bridgeRef.current.up);
    bind.call(view, "pointercancel", bridgeRef.current.cancel);
    gestureViewRef.current = on ? view : null;
  };

  // Events from any pointer other than the one that started the gesture are not
  // ours. An undefined id (a synthetic event) is treated as the owner's.
  const isGesturePointer = (event) => {
    const owner = gesturePointerRef.current;
    return owner == null || event?.pointerId == null || event.pointerId === owner;
  };

  const stopEdgeScroll = () => {
    // Same reason as the listeners: on unmount the strip ref is already gone.
    const view = gestureViewRef.current || stripRef.current?.ownerDocument?.defaultView;
    if (edgeRef.current.frame && view?.cancelAnimationFrame) {
      view.cancelAnimationFrame(edgeRef.current.frame);
    }
    edgeRef.current.frame = 0;
  };

  useEffect(
    () => () => {
      clearHold();
      stopEdgeScroll();
      listenForGesture(false);
    },
    []
  );

  // Non-passive so a wheel the strip consumed doesn't also scroll the page. React
  // registers its own wheel listener as passive, hence the manual binding.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      return undefined;
    }
    const handleWheel = (event) => {
      if (event.ctrlKey) {
        return; // pinch-zoom
      }
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 0) {
        return;
      }
      const delta = wheelScrollDelta(event, strip.clientWidth);
      const next = Math.max(0, Math.min(strip.scrollLeft + delta, max));
      if (next === strip.scrollLeft) {
        return; // at an end: let the gesture fall through to the page
      }
      strip.scrollLeft = next;
      event.preventDefault();
    };
    strip.addEventListener("wheel", handleWheel, { passive: false });
    return () => strip.removeEventListener("wheel", handleWheel);
    // The empty strip renders a different element, so the listener has to follow
    // the ref across that swap.
  }, [items.length > 0]);

  const revealFocusedTab = () => {
    const strip = stripRef.current;
    if (!strip || !focusedTabId || panningRef.current) {
      return;
    }
    const tab = strip.querySelector(`[data-tab-id="${focusedTabId}"]`);
    if (!tab?.getBoundingClientRect) {
      return;
    }
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    const start = tabBox.left - stripBox.left + strip.scrollLeft;
    const next = scrollLeftToReveal({
      scrollLeft: strip.scrollLeft,
      viewport: strip.clientWidth,
      start,
      end: start + tabBox.width,
      margin: 12,
      max: strip.scrollWidth - strip.clientWidth,
    });
    if (next !== strip.scrollLeft) {
      strip.scrollLeft = next;
    }
  };

  // A focused session must be visible in the strip, and the things that move it
  // out of view don't know where the strip is scrolled: focus arriving from the
  // sidebar, a close, and — with the same tab still focused — a pin, which slides
  // the tab into the pinned zone at the front.
  //
  // Keyed on everything that moves a tab: focus, strip order, and pinned state —
  // a pinned tab is narrower, so unpinning one pushes every tab after it along
  // without changing the order or the strip's own size.
  //
  // Deliberately NOT every render: a strip that re-revealed the focused tab
  // whenever anything changed would undo a pan the moment the pointer lifted, and
  // the overflow could never be reached. Panning is read from a ref for the same
  // reason — it must not be a dependency.
  const layoutKey = `${focusedTabId || ""}|${items
    .map((item) => `${item.tabId}${item.pinned ? ":pinned" : ""}`)
    .join(",")}`;
  useEffect(revealFocusedTab, [layoutKey]);

  // A narrower strip clips what used to be visible — the focused tab included.
  useEffect(() => {
    const strip = stripRef.current;
    const view = strip?.ownerDocument?.defaultView;
    if (!strip || typeof view?.ResizeObserver !== "function") {
      return undefined;
    }
    const observer = new view.ResizeObserver(() => revealFocusedTab());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [layoutKey]);

  const readTabRects = () => {
    const strip = stripRef.current;
    if (!strip) {
      return [];
    }
    return [...strip.querySelectorAll("[data-tab-id]")].map((node) => {
      const box = node.getBoundingClientRect();
      return { tabId: node.getAttribute("data-tab-id"), left: box.left, right: box.right };
    });
  };

  // Drag a held tab to the strip's edge and the strip keeps scrolling under it for
  // as long as it is held there — the pointer has nowhere further to go, so waiting
  // for more movement would strand every tab beyond the visible window.
  const runEdgeScroll = () => {
    edgeRef.current.frame = 0;
    const strip = stripRef.current;
    if (!strip || gestureRef.current.mode !== "reorder") {
      return;
    }
    const box = strip.getBoundingClientRect();
    const step = edgeScrollStep(edgeRef.current.x, { left: box.left, right: box.right });
    if (!step) {
      return;
    }
    const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const next = Math.max(0, Math.min(strip.scrollLeft + step, max));
    if (next === strip.scrollLeft) {
      return; // parked at an end
    }
    strip.scrollLeft = next;
    // Tabs slide under a stationary pointer, so the drop target moves with them.
    setDropTarget(resolveDropTabId(edgeRef.current.x, readTabRects()) || gestureRef.current.tabId);
    scheduleEdgeScroll();
  };

  const scheduleEdgeScroll = () => {
    const view = stripRef.current?.ownerDocument?.defaultView;
    if (edgeRef.current.frame || typeof view?.requestAnimationFrame !== "function") {
      return;
    }
    edgeRef.current.frame = view.requestAnimationFrame(runEdgeScroll);
  };

  const handlePointerDown = (event) => {
    // A gesture already owns the strip: a second contact (a touch landing while
    // the mouse holds a tab) must not reset the machine under it.
    if (gestureRef.current.mode !== "idle") {
      return;
    }
    suppressClickRef.current = false;
    if (event.target?.closest?.(CONTROL_SELECTOR)) {
      return;
    }
    const tabId = tabIdAt(event.target);
    const strip = stripRef.current;
    const taken = gestureRef.current.down({
      tabId,
      x: event.clientX,
      scrollLeft: strip?.scrollLeft || 0,
      button: event.button,
      pointerType: event.pointerType,
    });
    if (!taken) {
      return;
    }
    gesturePointerRef.current = event.pointerId ?? null;
    clearHold();
    listenForGesture(true);
    if (tabId && onMove) {
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        if (gestureRef.current.hold()) {
          setDraggingId(tabId);
          setDropTarget(tabId);
        }
      }, reorderHoldMs);
    }
  };

  const handlePointerMove = (event) => {
    if (!isGesturePointer(event)) {
      return;
    }
    // A move with nothing pressed means the release happened where the page could
    // not hear it — outside the browser window, most often. Without this the strip
    // would go on following the pointer with no button held.
    if (event.buttons === 0) {
      handlePointerCancel();
      return;
    }
    const step = gestureRef.current.move({ x: event.clientX });
    if (!step) {
      return;
    }
    const strip = stripRef.current;
    if (step.mode === "panning") {
      clearHold();
      if (!panning) {
        setPanning(true);
      }
      if (strip) {
        const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
        strip.scrollLeft = Math.max(0, Math.min(step.scrollLeft, max));
      }
      return;
    }
    edgeRef.current.x = event.clientX;
    if (strip) {
      const box = strip.getBoundingClientRect();
      if (edgeScrollStep(event.clientX, { left: box.left, right: box.right })) {
        scheduleEdgeScroll();
      } else {
        stopEdgeScroll();
      }
    }
    setDropTarget(resolveDropTabId(event.clientX, readTabRects()) || step.tabId);
  };

  const handlePointerUp = (event) => {
    if (!isGesturePointer(event)) {
      return;
    }
    const result = gestureRef.current.up();
    const target = dropTargetRef.current;
    if (result.mode === "reorder" && result.tabId && target && target !== result.tabId) {
      const toIndex = items.findIndex((item) => item.tabId === target);
      if (toIndex >= 0) {
        onMove?.(result.tabId, toIndex);
      }
    }
    suppressClickRef.current = result.moved;
    endGesture();
  };

  const handlePointerCancel = (event) => {
    if (!isGesturePointer(event)) {
      return;
    }
    gestureRef.current.reset();
    endGesture();
  };

  // The window listeners are installed once per gesture but must always reach this
  // render's closures.
  handlersRef.current = {
    move: handlePointerMove,
    up: handlePointerUp,
    cancel: handlePointerCancel,
  };

  const handleClickCapture = (event) => {
    if (!suppressClickRef.current) {
      return;
    }
    suppressClickRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  const beginRename = (tabId) => {
    // Renaming a tab is not the same as viewing it — the strip deliberately does NOT
    // focus the session here. Right-clicking a background tab to correct its label
    // should not yank the main area away from what you were reading.
    setEditingTabId(tabId);
  };

  const cancelRename = () => setEditingTabId(null);

  const commitRename = (tabId, value) => {
    setEditingTabId(null);
    const item = items.find((entry) => entry.tabId === tabId);
    if (!item?.threadId) {
      return;
    }
    // The caller decides whether this is a real change and what "blank" means; the
    // strip's job ends at reporting the intent.
    onRename?.(item.threadId, value);
  };

  if (!items.length) {
    return h(
      "div",
      { className: "session-tab-strip is-empty", role: "tablist", "aria-label": "Open sessions" },
      h("p", { className: "session-tab-empty" }, emptyMessage),
      onNewTab
        ? h(
            "button",
            {
              type: "button",
              className: "session-tab-new",
              title: "Open a session",
              "aria-label": "Open a session",
              onClick: () => onNewTab(),
            },
            "+"
          )
        : null
    );
  }

  return h(
    "div",
    {
      className: `session-tab-strip${panning ? " is-panning" : ""}${draggingId ? " is-reordering" : ""}`,
      role: "tablist",
      "aria-label": "Open sessions",
      ref: stripRef,
      // Only the press starts here; the rest of the gesture is taken from the
      // window (see listenForGesture) so it survives leaving the strip.
      onPointerDown: handlePointerDown,
      onClickCapture: handleClickCapture,
    },
    ...items.map((item) =>
      h(SessionTab, {
        key: item.tabId,
        item,
        focused: item.tabId === focusedTabId,
        isDragging: draggingId === item.tabId,
        isDropTarget: dropTargetId === item.tabId && draggingId !== item.tabId,
        // A tab that is being dragged is not being renamed: a lift cancels the edit
        // (its commit already ran on blur), so the two states can never overlap.
        editing: Boolean(onRename) && editingTabId === item.tabId && !draggingId,
        onFocus,
        onClose,
        onPromote,
        onTogglePin,
        onBeginRename: onRename ? beginRename : null,
        onCommitRename: commitRename,
        onCancelRename: cancelRename,
      })
    ),
    onNewTab
      ? h(
          "button",
          {
            type: "button",
            className: "session-tab-new",
            title: "Open a session",
            "aria-label": "Open a session",
            onClick: () => onNewTab(),
          },
          "+"
        )
      : null
  );
}

/**
 * Build the strip's view model from a tab workspace plus the same per-thread
 * signal maps the sidebar is fed. Kept next to the component so a caller doesn't
 * have to know how a layout tree maps onto a tab label.
 *
 * `resolveThread(threadId)` returns `{ title, tooltip, provider }` for a session. A tab
 * holding a split shows the first session's title with a pane count, which is
 * enough until panes get their own affordance.
 */
export function buildSessionTabItems({
  workspace = null,
  resolveThread = null,
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
  layoutThreadIds = null,
} = {}) {
  const tabs = workspace?.tabs || [];
  return tabs.map((tab) => {
    const threadIds = layoutThreadIds ? layoutThreadIds(tab.layout) : [];
    const primaryId = threadIds[0] || "";
    const resolved = resolveThread?.(primaryId) || {};
    const paneSuffix = threadIds.length > 1 ? ` (${threadIds.length})` : "";
    return {
      tabId: tab.id,
      threadId: primaryId,
      pinned: Boolean(tab.pinned),
      // The tab the next peek will replace. Rendered as an italic title, the same
      // signal an editor uses for exactly this state.
      preview: Boolean(tab.preview),
      title: `${resolved.title || "Session"}${paneSuffix}`,
      // What the rename editor opens with — the session's OWN title, without the
      // `(2)` pane count the displayed title carries. Seeding from `title` would
      // pre-fill "Auth work (2)", and committing that stores the suffix literally,
      // rendering as "Auth work (2) (2)" from then on.
      renameDraft: resolved.title || "",
      tooltip: resolved.tooltip || null,
      // Which agent owns the tab. Shown in the leading slot while the session is
      // idle, i.e. whenever the activity dot is not using it.
      provider: resolved.provider || "",
      activity: threadActivity?.get?.(primaryId) || null,
      attentionKind: threadAttention?.get?.(primaryId) || null,
      reviewing: Boolean(threadReviewing?.has?.(primaryId)),
    };
  });
}
