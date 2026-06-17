import test from "node:test";
import assert from "node:assert/strict";

// remote-ui-store -> state.js touches window.localStorage at import time, so
// install browser stubs first, then dynamically import (mirrors claude-model-fetch.test.mjs).
function installBrowserStubs() {
  const storage = new Map();
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

installBrowserStubs();

const { createRemoteUiStore } = await import("./remote-ui-store.js");
const { ensureProviderModels } = await import("./provider-model-fetch.js");

const NO_SLEEP = { baseDelayMs: 0, sleep: () => Promise.resolve() };
const CATALOG = [{ model: "gpt-5.5", display_name: "GPT-5.5" }];

test("ensureProviderModels loads a catalog and flips status loading → ready", async () => {
  const store = createRemoteUiStore({});
  await ensureProviderModels(store, "codex", async () => CATALOG, NO_SLEEP);
  assert.deepEqual(
    store.getState().providerModels.codex.map((m) => m.model),
    ["gpt-5.5"]
  );
  assert.equal(store.getState().providerModelsStatus.codex, "ready");
});

test("ensureProviderModels records 'error' (not a stuck 'loading') when the pull keeps failing", async () => {
  const store = createRemoteUiStore({});
  await ensureProviderModels(store, "codex", async () => {
    throw new Error("cold app-server");
  }, { attempts: 2, ...NO_SLEEP });
  assert.equal(store.getState().providerModelsStatus.codex, "error");
});

test("ensureProviderModels dedupes a concurrent in-flight pull for the same provider", async () => {
  // The review panel + every per-card re-review launcher can trigger the same
  // provider at once; the in-flight "loading" guard must collapse them to ONE pull.
  const store = createRemoteUiStore({});
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return CATALOG;
  };
  const p1 = ensureProviderModels(store, "codex", fetchFn, NO_SLEEP);
  const p2 = ensureProviderModels(store, "codex", fetchFn, NO_SLEEP);
  await Promise.all([p1, p2]);
  assert.equal(calls, 1, "only one pull runs while another is in flight");
  assert.equal(store.getState().providerModelsStatus.codex, "ready");
});

test("ensureProviderModels allows a retry after a previous pull errored (no permanent lockout)", async () => {
  const store = createRemoteUiStore({});
  await ensureProviderModels(store, "codex", async () => {
    throw new Error("cold");
  }, { attempts: 1, ...NO_SLEEP });
  assert.equal(store.getState().providerModelsStatus.codex, "error");
  // status is "error" (not "loading"), so a later retry is permitted.
  await ensureProviderModels(store, "codex", async () => CATALOG, NO_SLEEP);
  assert.equal(store.getState().providerModelsStatus.codex, "ready");
});

test("ensureProviderModels ignores an empty provider name", async () => {
  const store = createRemoteUiStore({});
  let calls = 0;
  await ensureProviderModels(store, "", async () => {
    calls += 1;
    return CATALOG;
  });
  assert.equal(calls, 0);
});
