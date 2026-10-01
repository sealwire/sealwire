// Keyboard behaviour for the conversation composer textarea, factored into pure
// functions so it can be unit-tested without a DOM. The composer wires these to
// its `onKeyDown` handler; see frontend/shared/composer.js.

import { hasFinePrimaryPointer } from "./pointer-class.js";

// Should a keydown submit the composer? On desktop, a plain Enter sends the
// message and Shift+Enter inserts a newline. We deliberately bail while an IME
// composition is in flight so confirming a Chinese/Japanese candidate with Enter
// doesn't fire the message.
export function enterShouldSubmit(event = {}, { enterSubmits = false } = {}) {
  if (!enterSubmits) return false;
  if (event.key !== "Enter") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  if (event.isComposing) return false;
  if (event.keyCode === 229) return false; // IME composition in progress
  return true;
}

// An input method is mid-composition: Enter and the arrows belong to its candidate
// list, not to whatever the field is in. Takes a native or a React synthetic event.
export function isImeComposing(event = {}) {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Start of the logical line (paragraph) containing `pos` — the character after
// the preceding "\n", or 0.
function lineStart(value, pos) {
  if (pos <= 0) return 0;
  const nl = value.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

// End of the logical line containing `pos` — the next "\n", or end of text.
function lineEnd(value, pos) {
  const nl = value.indexOf("\n", pos);
  return nl === -1 ? value.length : nl;
}

// Compute the new selection when Home/End is pressed, moving the caret to the
// start/end of the current LOGICAL line (bounded by "\n"). This fills the gap on
// macOS, where native Home/End in a textarea scroll or do nothing rather than
// moving the caret.
//
// PRODUCT DECISION (2026-07-28): logical-line, NOT visual-line, is the accepted
// behaviour. A single long paragraph that soft-wraps across several rows is one
// logical line, so Home moves to the paragraph start (not the wrapped row start),
// and Shift+Home/End selects to the paragraph edge. This was chosen deliberately
// over native-parity visual-row navigation because visual-row boundaries in a
// <textarea> can only be found by fragile DOM layout measurement (no selection
// API exposes them) that can't be exercised in the unit suite (jsdom does no
// layout). macOS users keep the native Cmd+←/→ for visual-row navigation; this
// only adds the missing Home/End motion. The soft-wrap test below locks this in.
//
// With Shift, the selection is extended from its existing anchor. Returns
// { start, end, direction } for setSelectionRange, or null when not Home/End.
export function homeEndSelection(
  value = "",
  selectionStart = 0,
  selectionEnd = 0,
  selectionDirection = "none",
  key,
  shiftKey = false
) {
  if (key !== "Home" && key !== "End") return null;
  const text = String(value);
  const len = text.length;
  const start = clamp(selectionStart, 0, len);
  const end = clamp(selectionEnd, 0, len);

  // The active (moving) caret vs. the fixed anchor. A collapsed caret is both.
  let active;
  let anchor;
  if (start === end) {
    active = start;
    anchor = start;
  } else if (selectionDirection === "backward") {
    active = start;
    anchor = end;
  } else {
    active = end;
    anchor = start;
  }

  const target = key === "Home" ? lineStart(text, active) : lineEnd(text, active);

  if (shiftKey) {
    const newStart = Math.min(anchor, target);
    const newEnd = Math.max(anchor, target);
    if (newStart === newEnd) {
      return { start: newStart, end: newEnd, direction: "none" };
    }
    return {
      start: newStart,
      end: newEnd,
      direction: target < anchor ? "backward" : "forward",
    };
  }

  return { start: target, end: target, direction: "none" };
}

// Apple platforms are where native Home/End don't move the textarea caret, so
// the composer remaps them there. iOS is included: it lacks physical Home/End
// keys, but hardware keyboards (iPad) can send them, and remapping is harmless
// when the keys never fire.
export function matchesApplePlatform(platform = "", userAgent = "") {
  const p = String(platform || "");
  const ua = String(userAgent || "");
  if (/Mac|iPhone|iPad|iPod/i.test(p)) return true;
  if (/Mac OS X|iPhone|iPad|iPod/i.test(ua)) return true;
  return false;
}

// Resolve whether Enter should submit for the current environment when the
// composer isn't given an explicit `enterSubmits` prop. We gate on the PRIMARY
// pointer being fine (a mouse/trackpad), i.e. a real desktop/laptop — an iPad with a
// Magic Keyboard keeps Enter as a newline and relies on the Send button. The primary-
// vs-any reasoning lives in `pointer-class.js`; this is the composer's reading of it.
//
// Note the fail-open default there is load-bearing HERE and not shared by every caller:
// an environment that cannot answer gets a submitting Enter, because the alternative is
// a composer whose Enter key silently does nothing useful. `win` is injectable for tests.
export function defaultEnterSubmits(win = typeof window !== "undefined" ? window : undefined) {
  return hasFinePrimaryPointer(win);
}

// Resolve whether to remap Home/End for the current environment when the
// composer isn't given an explicit `remapHomeEnd` prop. We read `window.navigator`
// (not the ambient global `navigator`, which Node 21+ also defines) so any
// non-browser context resolves to false rather than leaking the host platform.
// `nav` is injectable for tests.
export function defaultRemapHomeEnd(
  nav = typeof window !== "undefined" ? window.navigator : undefined
) {
  if (!nav) return false;
  return matchesApplePlatform(nav.platform || "", nav.userAgent || "");
}

// Build the composer textarea's onKeyDown handler. Kept here (not inline in the
// component) so the DOM wiring — submit-button lookup, requestSubmit, caret
// remap — is unit-testable with plain fake event/DOM objects. `enterSubmits`
// and `remapHomeEnd` are the already-resolved booleans for the environment.
export function createComposerKeydownHandler({ enterSubmits = false, remapHomeEnd = false } = {}) {
  return (event) => {
    const native = event.nativeEvent || event;
    const isComposing = event.isComposing ?? native.isComposing ?? false;
    const keyCode = event.keyCode ?? native.keyCode;

    if (
      enterShouldSubmit(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          isComposing,
          keyCode,
        },
        { enterSubmits }
      )
    ) {
      // Never let a plain Enter insert a newline on desktop. Mirror clicking the
      // Send button: submit only when a visible, enabled submit button exists
      // (so a disabled composer or an in-progress turn does nothing). We read the
      // live button from the DOM because the local surface toggles it
      // imperatively rather than re-rendering the component.
      event.preventDefault();
      const form = event.currentTarget?.form || event.target?.form;
      if (!form) return;
      const submitter = form.querySelector('button[type="submit"]:not([hidden])');
      if (!submitter || submitter.disabled) return;
      if (typeof form.requestSubmit === "function") form.requestSubmit(submitter);
      else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return;
    }

    if (
      remapHomeEnd &&
      (event.key === "Home" || event.key === "End") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const target = event.currentTarget;
      if (!target || typeof target.setSelectionRange !== "function") return;
      const selection = homeEndSelection(
        target.value ?? "",
        target.selectionStart ?? 0,
        target.selectionEnd ?? 0,
        target.selectionDirection || "none",
        event.key,
        event.shiftKey
      );
      if (selection) {
        event.preventDefault();
        target.setSelectionRange(selection.start, selection.end, selection.direction);
      }
    }
  };
}
