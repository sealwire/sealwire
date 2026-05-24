// Behavior tests for createPanelControl — the shared module that powers
// both the left sidebar and the right rail. We mock document, localStorage,
// and matchMedia with minimal stubs so the module's logic can run under
// node:test without a browser environment.

import test from "node:test";
import assert from "node:assert/strict";

const STORAGE_WIDTH = "test:width";
const STORAGE_OPEN = "test:open-width";

function setupEnv({ mobile = false, savedWidth = null, savedOpen = null } = {}) {
  const cssVars = new Map();
  globalThis.document = {
    documentElement: {
      style: {
        setProperty(name, value) {
          cssVars.set(name, value);
        },
      },
    },
    body: {
      classList: {
        add() {},
        remove() {},
        toggle() {},
      },
    },
  };
  const store = new Map();
  if (savedWidth != null) store.set(STORAGE_WIDTH, String(savedWidth));
  if (savedOpen != null) store.set(STORAGE_OPEN, String(savedOpen));
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
  globalThis.window = {
    matchMedia(_query) {
      return { matches: mobile };
    },
  };
  return { cssVars, store };
}

function teardown() {
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.window;
}

async function importControl() {
  // Re-import each test to defeat the module cache, so state from a previous
  // test (CSS-var bag, localStorage stub) doesn't leak across cases.
  const mod = await import(`./panel-controls.js?cachebust=${Math.random()}`);
  return mod.createPanelControl;
}

test("initial width defaults to defaultOpenWidth when nothing is persisted", async () => {
  const { cssVars } = setupEnv();
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    assert.equal(control.getWidth(), 300);
    assert.equal(control.isOpen(), true);
    assert.equal(cssVars.get("--sidebar-width"), "300px");
  } finally {
    teardown();
  }
});

test("toggle closes when open, then re-opens to the last open width", async () => {
  const { cssVars, store } = setupEnv({ savedWidth: 380, savedOpen: 380 });
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    assert.equal(control.getWidth(), 380);

    control.toggle();
    assert.equal(control.getWidth(), 0);
    assert.equal(control.isOpen(), false);
    assert.equal(cssVars.get("--sidebar-width"), "0px");
    // Closing should NOT overwrite the stored open width — that's what we
    // restore to on re-open.
    assert.equal(store.get(STORAGE_OPEN), "380");

    control.toggle();
    assert.equal(control.getWidth(), 380, "should restore the last open width");
    assert.equal(control.isOpen(), true);
    assert.equal(cssVars.get("--sidebar-width"), "380px");
  } finally {
    teardown();
  }
});

test("subscribe fires for each width change with the correct isOpen flag", async () => {
  setupEnv();
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    const events = [];
    const unsub = control.subscribe((event) => {
      events.push({ width: event.width, isOpen: event.isOpen });
    });
    // The initial subscribe should fire once synchronously with the current
    // state so subscribers don't miss the boot value.
    assert.equal(events.length, 1);
    assert.equal(events[0].isOpen, true);

    control.close();
    control.open();
    assert.deepEqual(
      events.map((e) => e.isOpen),
      [true, false, true]
    );

    unsub();
    control.close();
    assert.equal(events.length, 3, "unsub should stop further callbacks");
  } finally {
    teardown();
  }
});

test("drag-release below CLOSE_THRESHOLD (80px) snaps to 0", async () => {
  const { cssVars } = setupEnv();
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    // Simulate the resize handle dragging down to 60px (below threshold of
    // 80) without committing yet, then releasing — the final state should
    // snap to 0 (closed) rather than the minOpenWidth.
    const fakeHandle = makeFakeHandle();
    control.attachResizeHandle(fakeHandle);
    fakeHandle.dispatch("pointerdown", { pointerId: 1, clientX: 300 });
    fakeHandle.dispatch("pointermove", { clientX: 60 });
    fakeHandle.dispatch("pointerup", {});
    assert.equal(control.getWidth(), 0, "should snap to 0 below threshold");
    assert.equal(cssVars.get("--sidebar-width"), "0px");
  } finally {
    teardown();
  }
});

test("drag-release above CLOSE_THRESHOLD snaps up to at least minOpenWidth", async () => {
  setupEnv();
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    const fakeHandle = makeFakeHandle();
    control.attachResizeHandle(fakeHandle);
    fakeHandle.dispatch("pointerdown", { pointerId: 1, clientX: 300 });
    // Drag down to 180 (below minOpenWidth=220 but above threshold=80) →
    // should NOT snap to 0, should clamp up to minOpenWidth.
    fakeHandle.dispatch("pointermove", { clientX: 180 });
    fakeHandle.dispatch("pointerup", {});
    assert.equal(
      control.getWidth(),
      220,
      "release above threshold but below min should clamp to minOpenWidth"
    );
  } finally {
    teardown();
  }
});

test("right-side panel inverts drag direction", async () => {
  setupEnv();
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--right-rail-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 260,
      maxOpenWidth: 560,
      defaultOpenWidth: 320,
      side: "right",
    });
    const fakeHandle = makeFakeHandle();
    control.attachResizeHandle(fakeHandle);
    // Right-side handle: pulling the pointer LEFT (decreasing clientX) should
    // GROW the rail (since the handle sits on the rail's LEFT edge). Mirror
    // of the left-side behavior.
    fakeHandle.dispatch("pointerdown", { pointerId: 1, clientX: 1200 });
    fakeHandle.dispatch("pointermove", { clientX: 1100 });
    fakeHandle.dispatch("pointerup", {});
    assert.equal(
      control.getWidth(),
      420,
      "right-side drag-left should add to width (320 + 100)"
    );
  } finally {
    teardown();
  }
});

test("attaching the same control to two toggle buttons keeps them in sync", async () => {
  setupEnv();
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    const buttonA = makeFakeButton();
    const buttonB = makeFakeButton();
    control.attachToggleButton(buttonA);
    control.attachToggleButton(buttonB);
    // After attaching, both buttons should reflect the current open state.
    assert.equal(buttonA.getAttribute("aria-pressed"), "true");
    assert.equal(buttonB.getAttribute("aria-pressed"), "true");

    // Clicking one button should propagate to the other via the subscribe
    // callback inside attachToggleButton.
    buttonA.dispatch("click");
    assert.equal(control.isOpen(), false);
    assert.equal(buttonA.getAttribute("aria-pressed"), "false");
    assert.equal(buttonB.getAttribute("aria-pressed"), "false");

    buttonB.dispatch("click");
    assert.equal(control.isOpen(), true);
    assert.equal(buttonA.getAttribute("aria-pressed"), "true");
    assert.equal(buttonB.getAttribute("aria-pressed"), "true");
  } finally {
    teardown();
  }
});

test("mobile environment suppresses drag (isMobile guard)", async () => {
  setupEnv({ mobile: true });
  try {
    const createPanelControl = await importControl();
    const control = createPanelControl({
      cssVarName: "--sidebar-width",
      widthStorageKey: STORAGE_WIDTH,
      openWidthStorageKey: STORAGE_OPEN,
      minOpenWidth: 220,
      maxOpenWidth: 520,
      defaultOpenWidth: 300,
      side: "left",
    });
    const handle = makeFakeHandle();
    control.attachResizeHandle(handle);
    const before = control.getWidth();
    handle.dispatch("pointerdown", { pointerId: 1, clientX: 300 });
    handle.dispatch("pointermove", { clientX: 50 });
    handle.dispatch("pointerup", {});
    assert.equal(
      control.getWidth(),
      before,
      "mobile media query should suppress pointer drag so the panel doesn't move"
    );
  } finally {
    teardown();
  }
});

// --- minimal DOM stubs ----------------------------------------------------

function makeFakeHandle() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    dispatch(type, eventInit = {}) {
      const event = {
        preventDefault() {},
        ...eventInit,
      };
      listeners.get(type)?.forEach((fn) => fn(event));
    },
  };
}

function makeFakeButton() {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    classList: {
      toggle(name, force) {
        const has = classes.has(name);
        const next = typeof force === "boolean" ? force : !has;
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      has(name) {
        return classes.has(name);
      },
    },
    dispatch(type) {
      listeners.get(type)?.forEach((fn) => fn());
    },
  };
}
