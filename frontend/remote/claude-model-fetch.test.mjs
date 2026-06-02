import test from "node:test";
import assert from "node:assert/strict";

import { fetchModelsWithRetry } from "./provider-model-fetch.js";

// remote-ui-store -> state.js touches window.localStorage at import time, so
// install browser stubs first, then dynamically import. Mirrors
// __tests__/remote-ui-state.test.mjs.
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
const { defaultModelForProvider } = await import("../shared/provider-settings.js");

const NO_SLEEP = { baseDelayMs: 0, sleep: () => Promise.resolve() };

const CLAUDE_CATALOG = [
  { model: "claude-opus-4-8", display_name: "Default (recommended, Opus 4.8)", is_default: true },
  { model: "claude-sonnet-4-6", display_name: "Sonnet 4.6" },
  { model: "claude-haiku-4-5", display_name: "Haiku 4.5" },
];

// --- fetchModelsWithRetry: the core of #1 -----------------------------------

test("fetchModelsWithRetry recovers a transient cold-start failure", async () => {
  let calls = 0;
  const fetchFn = () => {
    calls += 1;
    // Cold worker rejects the first two pulls, then warms up.
    return calls < 3 ? Promise.reject(new Error("model/list timed out")) : Promise.resolve(CLAUDE_CATALOG);
  };
  const models = await fetchModelsWithRetry(fetchFn, "claude_code", { attempts: 3, ...NO_SLEEP });
  assert.equal(calls, 3);
  assert.deepEqual(models.map((m) => m.model), ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
});

test("fetchModelsWithRetry retries an empty catalog (treated as not-ready)", async () => {
  let calls = 0;
  const fetchFn = () => {
    calls += 1;
    return calls < 2 ? Promise.resolve([]) : Promise.resolve(CLAUDE_CATALOG);
  };
  const models = await fetchModelsWithRetry(fetchFn, "claude_code", { attempts: 3, ...NO_SLEEP });
  assert.equal(calls, 2);
  assert.equal(models.length, 3);
});

test("fetchModelsWithRetry throws after exhausting attempts (caller learns of failure)", async () => {
  let calls = 0;
  const fetchFn = () => {
    calls += 1;
    return Promise.reject(new Error("worker down"));
  };
  await assert.rejects(() => fetchModelsWithRetry(fetchFn, "claude_code", { attempts: 3, ...NO_SLEEP }));
  assert.equal(calls, 3);
});

// --- end-to-end with the real store, mirroring react-app's effect -----------

// Mirror of react-app.js's selected-provider load effect (retry + status).
async function loadProviderModels(store, provider, onFetch) {
  store.getState().setProviderModelsStatus(provider, "loading");
  try {
    const models = await fetchModelsWithRetry(onFetch, provider, NO_SLEEP);
    store.getState().setProviderModels(provider, models);
    store.getState().setProviderModelsStatus(provider, "ready");
  } catch {
    store.getState().setProviderModelsStatus(provider, "error");
  }
}

// Mirror of the dialog viewmodel derivation (react-app.js models + modelsStatus).
function dialogModelView(state, selectedProvider) {
  const models = state.providerModels[selectedProvider] || [];
  const modelsStatus = models.length
    ? "ready"
    : state.providerModelsStatus[selectedProvider] || "loading";
  const shown = models.length
    ? models
    : [{ model: state.sessionDraft.model || defaultModelForProvider(selectedProvider) }];
  return { models: shown.map((m) => m.model), modelsStatus };
}

function newStore() {
  return createRemoteUiStore({
    sessionDraft: { provider: "claude_code", model: defaultModelForProvider("claude_code") },
  });
}

test("cold-then-warm Claude fetch ends with the full catalog (no stuck 4.6)", async () => {
  const store = newStore();
  let calls = 0;
  const onFetch = () => {
    calls += 1;
    return calls < 2 ? Promise.reject(new Error("cold")) : Promise.resolve(CLAUDE_CATALOG);
  };

  await loadProviderModels(store, "claude_code", onFetch);

  const view = dialogModelView(store.getState(), "claude_code");
  assert.deepEqual(view.models, ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
  assert.equal(view.modelsStatus, "ready");
});

test("persistent failure is surfaced as status 'error' (not a silent single default)", async () => {
  const store = newStore();
  const onFetch = () => Promise.reject(new Error("worker down"));

  await loadProviderModels(store, "claude_code", onFetch);

  const view = dialogModelView(store.getState(), "claude_code");
  // The picker still has a usable value, but the failure is now visible so the
  // dialog renders the "couldn't load models" hint instead of pretending the
  // single fallback is the whole catalog.
  assert.equal(view.modelsStatus, "error");
  assert.deepEqual(view.models, ["claude-sonnet-4-6"]);
});
