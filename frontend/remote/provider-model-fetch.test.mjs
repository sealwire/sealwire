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
const { ensureModelPickerCatalogs, ensureProviderModels, ensureProviders } = await import("./provider-model-fetch.js");

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

test("opening the model picker retries a catalog that boot left in error", async () => {
  const store = createRemoteUiStore({
    providerModels: { codex: [] },
    providerModelsStatus: { codex: "error" },
    providers: ["codex"],
  });
  let calls = 0;

  await ensureModelPickerCatalogs(store, async (provider) => {
    calls += 1;
    assert.equal(provider, "codex");
    return CATALOG;
  }, NO_SLEEP);

  assert.equal(calls, 1);
  assert.deepEqual(store.getState().providerModels.codex, CATALOG);
  assert.equal(store.getState().providerModelsStatus.codex, "ready");
});

test("opening the model picker keeps ready catalogs and dedupes a boot fetch", async () => {
  const store = createRemoteUiStore({
    providerModels: { claude_code: CATALOG, codex: [] },
    providerModelsStatus: { claude_code: "ready", codex: "loading" },
    providers: ["claude_code", "codex"],
  });
  let calls = 0;

  await ensureModelPickerCatalogs(store, async () => {
    calls += 1;
    return CATALOG;
  }, NO_SLEEP);

  assert.equal(calls, 0, "ready catalogs stay cached and the in-flight boot pull is not duplicated");
});

test("ensureProviders retries a list the boot fetch lost, and keeps one it has", async () => {
  // The boot pull can fire before the broker socket is open, and a swallowed
  // failure left `providers` empty for the life of the page — which renders the
  // model menu as an empty strip with no rows in it at all.
  const store = createRemoteUiStore({ providers: [] });
  let calls = 0;

  const first = await ensureProviders(store, async () => {
    calls += 1;
    return calls === 1 ? [] : ["codex", "claude_code"];
  }, NO_SLEEP);

  assert.deepEqual(first, ["codex", "claude_code"]);
  assert.deepEqual(store.getState().providers, ["codex", "claude_code"]);

  await ensureProviders(store, async () => {
    calls += 1;
    return ["fake"];
  }, NO_SLEEP);
  assert.equal(calls, 2, "a provider list already in the store is not refetched");
});

test("a provider list that cannot be fetched leaves the store retryable", async () => {
  const store = createRemoteUiStore({ providers: [] });

  const providers = await ensureProviders(store, async () => {
    throw new Error("broker socket is not connected");
  }, NO_SLEEP);

  assert.deepEqual(providers, [], "a failure resolves empty rather than rejecting into a void catch");
  assert.deepEqual(store.getState().providers, [], "nothing is stored, so the next edge retries");
});

test("opening the model picker fills a provider list the boot fetch never got", async () => {
  const store = createRemoteUiStore({ providers: [] });
  const catalogs = [];

  await ensureModelPickerCatalogs(
    store,
    async (provider) => {
      catalogs.push(provider);
      return CATALOG;
    },
    { ...NO_SLEEP, fetchProviders: async () => ["codex", "claude_code"] }
  );

  assert.deepEqual(store.getState().providers, ["codex", "claude_code"]);
  assert.deepEqual(
    catalogs.sort(),
    ["claude_code", "codex"],
    "every provider the relay published gets its catalogue"
  );
});
