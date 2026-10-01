import test from "node:test";
import assert from "node:assert/strict";

import {
  createComposerKeydownHandler,
  defaultEnterSubmits,
  defaultRemapHomeEnd,
  enterShouldSubmit,
  homeEndSelection,
  matchesApplePlatform,
} from "./composer-keys.js";

// A fake submit button + form + textarea, standing in for the composer DOM so
// the handler wiring can be exercised without a browser.
function makeComposerDom({ value = "", start = 0, end = 0, direction = "none", submitterHidden = false, submitterDisabled = false } = {}) {
  const submitter = { disabled: submitterDisabled, hidden: submitterHidden };
  const form = {
    requestSubmitCalls: [],
    dispatched: [],
    requestSubmit(s) {
      this.requestSubmitCalls.push(s);
    },
    dispatchEvent(evt) {
      this.dispatched.push(evt);
      return true;
    },
    querySelector(selector) {
      if (selector.includes('type="submit"')) {
        // Emulate :not([hidden]) — a hidden submit button isn't matched.
        return submitter.hidden ? null : submitter;
      }
      return null;
    },
  };
  const textarea = {
    form,
    value,
    selectionStart: start,
    selectionEnd: end,
    selectionDirection: direction,
    setSelectionCalls: [],
    setSelectionRange(s, e, d) {
      this.selectionStart = s;
      this.selectionEnd = e;
      this.selectionDirection = d;
      this.setSelectionCalls.push([s, e, d]);
    },
  };
  return { submitter, form, textarea };
}

function makeKeyEvent(textarea, overrides = {}) {
  let prevented = false;
  return {
    key: overrides.key,
    shiftKey: overrides.shiftKey || false,
    altKey: overrides.altKey || false,
    metaKey: overrides.metaKey || false,
    ctrlKey: overrides.ctrlKey || false,
    isComposing: overrides.isComposing || false,
    keyCode: overrides.keyCode,
    currentTarget: textarea,
    target: textarea,
    nativeEvent: {},
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  };
}

// ---------------------------------------------------------------------------
// enterShouldSubmit — desktop Enter sends, Shift+Enter is a newline.
// ---------------------------------------------------------------------------

test("plain Enter submits when enterSubmits is enabled (desktop)", () => {
  assert.equal(enterShouldSubmit({ key: "Enter" }, { enterSubmits: true }), true);
});

test("Shift+Enter never submits — it inserts a newline", () => {
  assert.equal(
    enterShouldSubmit({ key: "Enter", shiftKey: true }, { enterSubmits: true }),
    false
  );
});

test("Enter with Meta/Ctrl/Alt does not submit (reserved for other shortcuts)", () => {
  assert.equal(enterShouldSubmit({ key: "Enter", metaKey: true }, { enterSubmits: true }), false);
  assert.equal(enterShouldSubmit({ key: "Enter", ctrlKey: true }, { enterSubmits: true }), false);
  assert.equal(enterShouldSubmit({ key: "Enter", altKey: true }, { enterSubmits: true }), false);
});

test("Enter does not submit when enterSubmits is disabled (mobile / touch)", () => {
  assert.equal(enterShouldSubmit({ key: "Enter" }, { enterSubmits: false }), false);
  assert.equal(enterShouldSubmit({ key: "Enter" }, {}), false);
});

test("non-Enter keys never submit", () => {
  assert.equal(enterShouldSubmit({ key: "a" }, { enterSubmits: true }), false);
  assert.equal(enterShouldSubmit({ key: "Home" }, { enterSubmits: true }), false);
});

test("Enter while an IME composition is active does NOT submit (Chinese/Japanese input)", () => {
  // Confirming an IME candidate with Enter must not fire the message.
  assert.equal(
    enterShouldSubmit({ key: "Enter", isComposing: true }, { enterSubmits: true }),
    false
  );
  // Some browsers surface an in-progress composition as keyCode 229 instead.
  assert.equal(
    enterShouldSubmit({ key: "Enter", keyCode: 229 }, { enterSubmits: true }),
    false
  );
});

// ---------------------------------------------------------------------------
// homeEndSelection — move the caret to the start/end of the current LOGICAL
// line (bounded by "\n"; a soft-wrapped paragraph is one line by design).
// Returns { start, end, direction } or null when it should not intervene.
// ---------------------------------------------------------------------------

test("Home moves the caret to the start of the current line", () => {
  // "abc\ndefXghi" — caret sits inside the second line.
  const value = "abc\ndefghi";
  const caret = 7; // between 'f' and 'g' on line 2 (line starts at index 4)
  assert.deepEqual(homeEndSelection(value, caret, caret, "none", "Home", false), {
    start: 4,
    end: 4,
    direction: "none",
  });
});

test("End moves the caret to the end of the current line (not the whole text)", () => {
  const value = "abc\ndefghi";
  const caret = 5; // on line 2; line ends at index 10 (string length)
  assert.deepEqual(homeEndSelection(value, caret, caret, "none", "End", false), {
    start: 10,
    end: 10,
    direction: "none",
  });
});

test("End stops at the newline for a non-final line", () => {
  const value = "abc\ndefghi";
  const caret = 1; // on line 1; line 1 ends just before the newline at index 3
  assert.deepEqual(homeEndSelection(value, caret, caret, "none", "End", false), {
    start: 3,
    end: 3,
    direction: "none",
  });
});

test("Home at the very start of the text stays at 0 (no underflow)", () => {
  const value = "\nabc";
  assert.deepEqual(homeEndSelection(value, 0, 0, "none", "Home", false), {
    start: 0,
    end: 0,
    direction: "none",
  });
});

test("Home on a later logical line goes to THAT line's start, not the document start", () => {
  // Three logical lines: "a"(0-1) "\n" "bb"(2-4) "\n" "ccc"(5-8). Caret on line 3.
  const value = "a\nbb\nccc";
  assert.deepEqual(homeEndSelection(value, 7, 7, "none", "Home", false), {
    start: 5,
    end: 5,
    direction: "none",
  });
  // End on the same line stops at end-of-text (last line has no trailing "\n").
  assert.deepEqual(homeEndSelection(value, 6, 6, "none", "End", false), {
    start: 8,
    end: 8,
    direction: "none",
  });
});

test("accepted product decision: a single wrapped paragraph is ONE logical line (paragraph-boundary nav)", () => {
  // No "\n" → the whole string is one logical line, so Home from anywhere lands
  // at 0 and End at the very end, regardless of how the textarea visually wraps.
  const value = "this is a long paragraph that would wrap across visual rows";
  assert.deepEqual(homeEndSelection(value, 30, 30, "none", "Home", false), {
    start: 0,
    end: 0,
    direction: "none",
  });
  assert.deepEqual(homeEndSelection(value, 30, 30, "none", "End", false), {
    start: value.length,
    end: value.length,
    direction: "none",
  });
});

test("Shift+Home extends the selection from the caret back to line start", () => {
  const value = "abc\ndefghi";
  const caret = 7; // line 2 start is 4
  assert.deepEqual(homeEndSelection(value, caret, caret, "none", "Home", true), {
    start: 4,
    end: 7,
    direction: "backward",
  });
});

test("Shift+End extends the selection from the caret to line end", () => {
  const value = "abc\ndefghi";
  const caret = 5;
  assert.deepEqual(homeEndSelection(value, caret, caret, "none", "End", true), {
    start: 5,
    end: 10,
    direction: "forward",
  });
});

test("Shift+Home uses the existing anchor when there is a forward selection", () => {
  // Anchor at 5, active caret at 8 (selectionDirection forward). Shift+Home
  // should collapse the active end back to line start (4), keeping anchor 5.
  const value = "abc\ndefghi";
  assert.deepEqual(homeEndSelection(value, 5, 8, "forward", "Home", true), {
    start: 4,
    end: 5,
    direction: "backward",
  });
});

test("returns null for keys other than Home/End", () => {
  assert.equal(homeEndSelection("abc", 1, 1, "none", "ArrowLeft", false), null);
});

// ---------------------------------------------------------------------------
// matchesApplePlatform — where native Home/End don't move the caret.
// ---------------------------------------------------------------------------

test("detects macOS and iOS as Apple platforms", () => {
  assert.equal(matchesApplePlatform("MacIntel", ""), true);
  assert.equal(matchesApplePlatform("iPhone", ""), true);
  assert.equal(matchesApplePlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), true);
});

test("does not flag Windows/Linux as Apple platforms", () => {
  assert.equal(matchesApplePlatform("Win32", "Mozilla/5.0 (Windows NT 10.0)"), false);
  assert.equal(matchesApplePlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux)"), false);
  assert.equal(matchesApplePlatform("", ""), false);
});

// ---------------------------------------------------------------------------
// defaultEnterSubmits / defaultRemapHomeEnd — environment resolution.
// ---------------------------------------------------------------------------

// A fake `window` whose matchMedia answers by media query, mimicking a device.
function fakeWindow(matches) {
  return { matchMedia: (query) => ({ matches: Boolean(matches[query]) }) };
}

test("defaultEnterSubmits: desktop (primary fine pointer) submits on Enter", () => {
  assert.equal(defaultEnterSubmits(fakeWindow({ "(pointer: fine)": true })), true);
});

test("defaultEnterSubmits: touch-only device keeps Enter as a newline", () => {
  assert.equal(
    defaultEnterSubmits(fakeWindow({ "(pointer: fine)": false, "(any-pointer: fine)": false })),
    false
  );
});

test("defaultEnterSubmits: hybrid (coarse primary + attached fine pointer) keeps newline", () => {
  // e.g. iPad + Magic Keyboard: any-pointer is fine, but the PRIMARY pointer is
  // coarse. We must gate on the primary pointer, so Enter stays a newline.
  assert.equal(
    defaultEnterSubmits(fakeWindow({ "(pointer: fine)": false, "(any-pointer: fine)": true })),
    false
  );
});

test("defaultEnterSubmits: falls back to true without matchMedia (SSR/desktop default)", () => {
  assert.equal(defaultEnterSubmits(undefined), true);
  assert.equal(defaultEnterSubmits({}), true);
});

test("defaultRemapHomeEnd: true on Apple, false elsewhere, false without navigator", () => {
  assert.equal(defaultRemapHomeEnd({ platform: "MacIntel", userAgent: "" }), true);
  assert.equal(defaultRemapHomeEnd({ platform: "Win32", userAgent: "Windows NT" }), false);
  // `null` (not `undefined`, which would trigger the default param) exercises the
  // no-navigator guard independent of the ambient host globals.
  assert.equal(defaultRemapHomeEnd(null), false);
});

// ---------------------------------------------------------------------------
// createComposerKeydownHandler — the DOM wiring (submit / caret remap).
// ---------------------------------------------------------------------------

test("Enter requestSubmits the form via the visible, enabled Send button", () => {
  const { form, textarea, submitter } = makeComposerDom();
  const handler = createComposerKeydownHandler({ enterSubmits: true });
  const event = makeKeyEvent(textarea, { key: "Enter" });

  handler(event);

  assert.equal(event.defaultPrevented, true, "the newline is suppressed");
  assert.deepEqual(form.requestSubmitCalls, [submitter], "submits with the Send button as submitter");
});

test("Enter with a disabled Send button suppresses the newline but does not submit", () => {
  const { form, textarea } = makeComposerDom({ submitterDisabled: true });
  const handler = createComposerKeydownHandler({ enterSubmits: true });
  const event = makeKeyEvent(textarea, { key: "Enter" });

  handler(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(form.requestSubmitCalls.length, 0);
});

test("Enter while the Stop button is showing (Send hidden) does not submit", () => {
  const { form, textarea } = makeComposerDom({ submitterHidden: true });
  const handler = createComposerKeydownHandler({ enterSubmits: true });
  const event = makeKeyEvent(textarea, { key: "Enter" });

  handler(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(form.requestSubmitCalls.length, 0);
});

test("Shift+Enter is left alone so the textarea inserts a newline", () => {
  const { form, textarea } = makeComposerDom();
  const handler = createComposerKeydownHandler({ enterSubmits: true });
  const event = makeKeyEvent(textarea, { key: "Enter", shiftKey: true });

  handler(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(form.requestSubmitCalls.length, 0);
});

test("Enter mid IME composition is left alone (no submit, no preventDefault)", () => {
  const { form, textarea } = makeComposerDom();
  const handler = createComposerKeydownHandler({ enterSubmits: true });
  const event = makeKeyEvent(textarea, { key: "Enter", isComposing: true });

  handler(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(form.requestSubmitCalls.length, 0);
});

test("Enter does nothing when enterSubmits is disabled (mobile)", () => {
  const { form, textarea } = makeComposerDom();
  const handler = createComposerKeydownHandler({ enterSubmits: false });
  const event = makeKeyEvent(textarea, { key: "Enter" });

  handler(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(form.requestSubmitCalls.length, 0);
});

test("Home remaps the caret to line start when remapHomeEnd is on", () => {
  const { textarea } = makeComposerDom({ value: "abc\ndefghi", start: 7, end: 7 });
  const handler = createComposerKeydownHandler({ enterSubmits: true, remapHomeEnd: true });
  const event = makeKeyEvent(textarea, { key: "Home" });

  handler(event);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(textarea.setSelectionCalls, [[4, 4, "none"]]);
});

test("End remaps the caret to line end when remapHomeEnd is on", () => {
  const { textarea } = makeComposerDom({ value: "abc\ndefghi", start: 5, end: 5 });
  const handler = createComposerKeydownHandler({ enterSubmits: true, remapHomeEnd: true });
  const event = makeKeyEvent(textarea, { key: "End" });

  handler(event);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(textarea.setSelectionCalls, [[10, 10, "none"]]);
});

test("Home is left to the browser when remapHomeEnd is off (Windows/Linux)", () => {
  const { textarea } = makeComposerDom({ value: "abc\ndefghi", start: 7, end: 7 });
  const handler = createComposerKeydownHandler({ enterSubmits: true, remapHomeEnd: false });
  const event = makeKeyEvent(textarea, { key: "Home" });

  handler(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(textarea.setSelectionCalls.length, 0);
});

test("Cmd/Ctrl+Home is left to the browser even with remapHomeEnd on (document nav)", () => {
  const { textarea } = makeComposerDom({ value: "abc\ndefghi", start: 7, end: 7 });
  const handler = createComposerKeydownHandler({ enterSubmits: true, remapHomeEnd: true });
  const event = makeKeyEvent(textarea, { key: "Home", metaKey: true });

  handler(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(textarea.setSelectionCalls.length, 0);
});

test("isImeComposing sees a composition on the native event or the synthetic one", async () => {
  const { isImeComposing } = await import("./composer-keys.js");
  assert.equal(isImeComposing({ key: "Enter", isComposing: true }), true);
  // React's synthetic event carries no isComposing of its own.
  assert.equal(isImeComposing({ key: "Enter", nativeEvent: { isComposing: true } }), true);
  // Safari reports the confirming Enter as keyCode 229 with isComposing already false.
  assert.equal(isImeComposing({ key: "Enter", keyCode: 229 }), true);
  assert.equal(isImeComposing({ key: "Enter", keyCode: 13 }), false);
});
