import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const initSource = readFileSync(path.join(here, "..", "public", "theme-init.js"), "utf8");
const KEY = "agent-relay.theme";

function fakeWindow({ stored, osLight }) {
  const store = new Map(stored == null ? [] : [[KEY, stored]]);
  return {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    matchMedia: () => ({ matches: osLight, addEventListener() {} }),
    store,
  };
}

function runInit(win) {
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(initSource, {
    window: win,
    localStorage: win.localStorage,
    document,
  });
  return document.documentElement.dataset.theme;
}

const theme = await import("./theme.js");

beforeEach(() => {
  globalThis.document = { documentElement: { dataset: {} } };
});

test("first visit opens in light even when the OS is dark", () => {
  const win = fakeWindow({ stored: null, osLight: false });
  assert.equal(runInit(win), "light");
  globalThis.window = win;
  assert.equal(theme.getStoredTheme(), "light");
});

test("choosing Auto survives a reload and follows the OS", () => {
  const win = fakeWindow({ stored: null, osLight: false });
  globalThis.window = win;
  theme.setStoredTheme("auto");
  assert.equal(theme.getStoredTheme(), "auto");
  assert.equal(globalThis.document.documentElement.dataset.theme, "dark");
  assert.equal(runInit(win), "dark");
});

test("an explicit Dark choice still wins", () => {
  const win = fakeWindow({ stored: "dark", osLight: true });
  assert.equal(runInit(win), "dark");
  globalThis.window = win;
  assert.equal(theme.getStoredTheme(), "dark");
});
