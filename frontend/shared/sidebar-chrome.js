// The sidebar chrome both shells render identically: brand lockup, search toggle, bell
// toggle, and the search field itself.
//
// Each of these existed twice. The brand was duplicated byte-for-byte. The two toggles
// differed only in which state they read and what they called on click. The search field
// was the sharpest case, and the reason this module is the one that unblocks the rest:
// remote rendered it conditionally, while local ALWAYS mounted it and toggled `hidden`,
// because every id inside it had to resolve at `dom.js` import time.
//
// A shared component cannot honour both of those, so it honours the honest one: closed
// means NOT RENDERED. Local retired the handles rather than hiding the node, which is what
// `HANDOVER_SEARCH_AND_BELL.md` called the second option and the whole point of doing it.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT shared here
// ---------------------------------------------------------------------------
//
//   * The project switcher's placement — local hosts it in the header, remote in the
//     sidebar's action row.
//   * The DEBOUNCE behind `onInput`. Remote's lives in `session-ops` next to the request
//     it triggers, so a teardown cancels both together; a timer owned by a component is
//     invisible to the surface reset, and a keystroke typed just before a re-pair would
//     fire against whatever connection replaced the one it was typed into. Local's lives
//     in `app.js`. Injecting `onInput` keeps that difference where it belongs.
//
// Sharing any of those would mean abstracting over a real difference, which is how a
// shared component turns into a pile of surface flags.

import React from "react";

import { BELL_SVG, SEARCH_SVG, X_SVG } from "../svg.js";
import { ToggleLeftPanelIcon } from "./panel-icons.js";

const h = React.createElement;

// `.inline-icon` carries `pointer-events: none`, which keeps the BUTTON as the hit
// target. A `click` only fires when mousedown and mouseup resolve to the same node, and
// these glyphs are injected with `dangerouslySetInnerHTML` — so a re-render mid-gesture
// replaces the <svg> and the browser fires no click at all.
function glyph(svgMarkup, extraClass) {
  return h("span", {
    className: extraClass ? `inline-icon ${extraClass}` : "inline-icon",
    "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: svgMarkup },
  });
}

/**
 * The brand lockup: seal, then wordmark.
 *
 * Takes no props — it was byte-for-byte identical on both surfaces, which is the cleanest
 * possible case for sharing and the one most likely to be re-typed if left alone.
 *
 * The seal lives here rather than in local's icon rail because the rail is only up while
 * the sidebar is collapsed; leaving the brand there would mean the app has no mark at all
 * in its normal, expanded state. `alt=""` because the wordmark beside it already names the
 * app, so alt text would make a screen reader say "Sealwire" twice.
 */
export function SidebarBrand() {
  return h(
    "div",
    { className: "sidebar-brand" },
    h("img", {
      className: "sidebar-brand-logo",
      src: "/static/sealwire_logo.png",
      alt: "",
      width: 24,
      height: 24,
    }),
    h("span", { className: "sidebar-brand-name" }, "Sealwire")
  );
}

/**
 * Reveals the search field.
 *
 * `aria-expanded`, not `aria-pressed`: this button discloses a field. The bell below is
 * the opposite case and the two must not be made to match.
 *
 * `shortcutHint` is optional. Session search used to advertise ⌘F; that key is left to
 * the browser for in-page Find, so local no longer passes a hint here. The prop remains
 * for any surface that still wants to name a different binding.
 */
export function SidebarSearchToggle({ open = false, onToggle = null, shortcutHint = "" } = {}) {
  const title = shortcutHint ? `Search sessions (${shortcutHint})` : "Search sessions";
  return h(
    "button",
    {
      className: open ? "header-button sidebar-search-toggle is-active" : "header-button sidebar-search-toggle",
      type: "button",
      title,
      "aria-label": "Search sessions",
      "aria-expanded": String(Boolean(open)),
      onClick: onToggle ? () => onToggle(!open) : undefined,
    },
    glyph(SEARCH_SVG)
  );
}

/**
 * The bell: narrow the list to what is actually going on.
 *
 * `aria-pressed`, not `aria-expanded` — it re-groups the list in place and there is no
 * popover under it to expand.
 */
export function SidebarBellToggle({ on = false, onToggle = null } = {}) {
  return h(
    "button",
    {
      className: on ? "header-button sidebar-bell-toggle is-active" : "header-button sidebar-bell-toggle",
      type: "button",
      title: "Filter by activity",
      "aria-label": "Filter by activity",
      "aria-pressed": String(Boolean(on)),
      onClick: onToggle ? () => onToggle(!on) : undefined,
    },
    glyph(BELL_SVG)
  );
}

/**
 * The search field. Absent when closed — never hidden.
 *
 * Search is a RELAY QUERY, not a filter over the loaded rows: the list is truncated to the
 * newest 120, so the session worth searching for is usually not in it.
 *
 * `query` is the caller's DRAFT, not the executed query. Binding this to
 * `threadSearch.query` — which only advances after the debounce fires — makes React
 * restore the previous value after every keystroke, so typing a word char by char ends up
 * searching for its last letter. A test that drives the field with `page.fill()` sets the
 * value in one shot and hides this completely; only real key-by-key input shows it.
 *
 * No ids on anything. Ids are what let local reach this field imperatively in the first
 * place, and they would collide the moment both surfaces mounted the component.
 *
 * Focus takes TWO props, because there are two separate questions.
 *
 * `focusOnOpen` is the surface's policy: local focuses when the field opens from the
 * magnifying-glass button, while on a phone focusing pops the on-screen keyboard over
 * the very list the user just asked to search.
 *
 * `focusSignal` is the request, and it is a counter rather than a boolean because requests
 * REPEAT. React's `autoFocus` only fires on mount, which covers opening a closed field and
 * nothing else — open again while the field is already mounted with the caret elsewhere
 * and `open` does not change, so there is no mount and no re-render that means "focus me".
 * Watching a counter covers the mount and the repeat with one mechanism.
 *
 * Focusing also SELECTS. Closing clears the draft, so a newly opened field is empty and
 * selection is a no-op there — but a repeat open onto a field that already holds a term
 * should let the next keystroke replace it rather than append to it.
 */
export function SidebarSearchField({
  open = false,
  query = "",
  onInput = null,
  onClose = null,
  focusOnOpen = false,
  focusSignal = 0,
} = {}) {
  const inputRef = React.useRef(null);
  // Deliberately keyed on `focusSignal` alone (plus the policy flag), NOT on `query` or
  // `open`: a re-render caused by anything else — a list refresh, a keystroke elsewhere —
  // must not yank the caret back, or the field fights the user for it.
  React.useEffect(() => {
    if (!focusOnOpen || !focusSignal) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [focusOnOpen, focusSignal]);

  if (!open) {
    return null;
  }

  return h(
    "div",
    { className: "sidebar-search" },
    glyph(SEARCH_SVG, "sidebar-search-glyph"),
    h("input", {
      autoComplete: "off",
      ref: inputRef,
      className: "sidebar-search-input",
      placeholder: "Search session titles",
      spellCheck: false,
      type: "search",
      value: query,
      "aria-label": "Search session titles",
      onChange: onInput ? (event) => onInput(event.target.value) : undefined,
      onKeyDown: (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose?.();
        }
      },
    }),
    h(
      "button",
      {
        className: "sidebar-search-clear",
        type: "button",
        title: "Clear search",
        "aria-label": "Clear search",
        // Clears the query but leaves the field OPEN and focused — the user is still
        // searching, they just want to start the term again. Closing here would be a
        // different gesture than the one they made.
        //
        // The focus hand-back is EXPLICIT and load-bearing: clicking a button focuses the
        // button, so without this the caret sits on the "clear" glyph and the user's next
        // keystroke goes nowhere. Local's imperative version called
        // `sidebarSearchInput.focus()` here; the first port of this component kept the
        // comment above and dropped the call, which is how a claim outlives its code.
        onClick: onInput
          ? () => {
              onInput("");
              inputRef.current?.focus();
            }
          : undefined,
      },
      glyph(X_SVG)
    )
  );
}

/**
 * The drag handle on the sidebar's trailing edge.
 *
 * Byte-for-byte identical on both surfaces apart from its `id`, which is how each shell's
 * resize wiring finds it (`app.js` and `remote/react-app.js` both `getElementById` it and
 * attach their own pointer maths). So the id stays a prop and the drag logic stays per
 * surface; what is shared is the ACCESSIBILITY contract, which is the part that had two
 * copies free to drift.
 *
 * `role="separator"` plus `aria-orientation` is what makes this a resizer rather than a
 * decorative strip, and `tabIndex: 0` is what lets it be reached without a pointer at all.
 */
export function SidebarResizeHandle({ id }) {
  return h("div", {
    className: "sidebar-resize",
    id,
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize navigation panel",
    tabIndex: 0,
  });
}

/**
 * The button that collapses the sidebar.
 *
 * Verbatim duplicate on both surfaces apart from its `id` — same class list, same label,
 * same ⌘B hint, same glyph. It nearly did not get shared: the first read of it assumed
 * "the two surfaces use different icons", because local called the glyph
 * `ToggleLeftPanelIcon` and remote called it `RemoteToggleLeftPanelIcon`. They were byte
 * for byte the same function. A prefix is not a difference.
 *
 * The id stays a prop, like `SidebarResizeHandle`'s, because each shell's collapse wiring
 * finds the button by id — local through `dom.js`, remote through `getElementById`. The
 * ⌘B hint is baked in rather than passed, unlike the search toggle's: both surfaces
 * genuinely bind it (remote's panel toggle is a desktop-width control; on a phone the
 * whole top bar is a drawer and this button is not what opens it).
 */
export function SidebarCollapseToggle({ id }) {
  return h(
    "button",
    {
      "aria-label": "Hide navigation panel",
      className: "header-button header-panel-toggle sidebar-top-toggle",
      id,
      title: "Hide navigation panel (⌘B)",
      type: "button",
    },
    h(ToggleLeftPanelIcon)
  );
}
