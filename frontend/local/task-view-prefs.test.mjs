import test from "node:test";
import assert from "node:assert/strict";

import { loadTaskViewMode, saveTaskViewMode } from "./task-view-prefs.js";

const KEY = "sealwire:tasks-view-mode";

/** Install a `window.localStorage`, or a thing that throws where one should be. */
function withStorage(impl, body) {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = impl === "throws"
    ? {
        get localStorage() {
          throw new Error("storage access denied");
        },
      }
    : { localStorage: impl };
  try {
    return body();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    read: (k) => (map.has(k) ? map.get(k) : null),
  };
}

test("the default is the list, which is the layout that existed before", () => {
  withStorage(memoryStorage(), () => {
    assert.equal(loadTaskViewMode(), "list");
  });
});

test("a stored mode survives a reload", () => {
  const store = memoryStorage();
  withStorage(store, () => {
    assert.equal(saveTaskViewMode("board"), "board");
    assert.equal(store.read(KEY), "board");
    assert.equal(loadTaskViewMode(), "board");
  });
});

// Anything could be in there — an older build, a hand-edited value, another tab.
test("a value that is not a mode falls back instead of rendering nothing", () => {
  withStorage(memoryStorage({ [KEY]: "kanban" }), () => {
    assert.equal(loadTaskViewMode(), "list");
  });
  withStorage(memoryStorage({ [KEY]: "" }), () => {
    assert.equal(loadTaskViewMode(), "list");
  });
  withStorage(memoryStorage(), () => {
    assert.equal(saveTaskViewMode("nonsense"), "list");
  });
});

// Privacy mode makes the `window.localStorage` GETTER throw, so a bare
// try-around-getItem is not enough. A preference is never worth a dead screen.
test("storage that throws on access degrades to the default, never throws", () => {
  withStorage("throws", () => {
    assert.equal(loadTaskViewMode(), "list");
    assert.equal(saveTaskViewMode("board"), "board");
  });
});

test("a full quota still lets the choice drive this session", () => {
  const full = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  withStorage(full, () => {
    assert.equal(saveTaskViewMode("board"), "board");
  });
});

test("with no window at all the default still answers", () => {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(loadTaskViewMode(), "list");
    assert.equal(saveTaskViewMode("board"), "board");
  } finally {
    if (had) globalThis.window = previous;
  }
});
