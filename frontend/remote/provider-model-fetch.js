// Fetch a provider's model catalog with bounded retry + backoff.
//
// Claude's catalog is a live worker round-trip (SDK supportedModels()) that is
// cold/slow right after a relay restart — exactly when the client pulls it.
// A single attempt that fails (or returns an empty list) used to be swallowed
// silently, leaving the new-session dialog stuck on a single hardcoded default.
// Retrying a few times with backoff lets the pull succeed once the worker
// warms up; if every attempt fails the caller learns about it (throws) instead
// of silently degrading.

import { normalizeProviderList } from "../shared/provider-settings.js";

// `sleep` is injectable so tests can run without real timers.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchListWithRetry(
  fetchFn,
  what,
  { attempts = 3, baseDelayMs = 600, sleep = defaultSleep } = {}
) {
  let lastError = new Error(`${what} fetch failed`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const list = await fetchFn();
      if (Array.isArray(list) && list.length > 0) {
        return list;
      }
      // An empty answer is a soft failure worth retrying: a healthy relay always
      // has at least one, so empty means "not ready", not "none exist".
      lastError = new Error(`empty ${what}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts - 1) {
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export function fetchModelsWithRetry(fetchFn, provider, options) {
  return fetchListWithRetry(() => fetchFn(provider), `model catalog for ${provider}`, options);
}

// Load one provider's catalog into the remote UI store, with the status
// transitions + in-flight dedup the review dialog relies on. Returns early when a
// pull for `provider` is already running ("loading"), so the many ReviewPanel
// mounts (panel + per-card re-review launchers) collapse to a single fetch — this
// is safe because the store's set() is synchronous, so the second concurrent
// caller observes "loading". A pull that ends in "error" is NOT locked out: a
// later trigger sees "error" (not "loading") and may retry.
export async function ensureProviderModels(store, provider, fetchFn, options) {
  if (!provider) return;
  const ui = store.getState();
  if (ui.providerModelsStatus[provider] === "loading") return;
  ui.setProviderModelsStatus(provider, "loading");
  try {
    const models = await fetchModelsWithRetry(fetchFn, provider, options);
    store.getState().setProviderModels(provider, models || []);
    store.getState().setProviderModelsStatus(provider, "ready");
  } catch {
    store.getState().setProviderModelsStatus(provider, "error");
  }
}

// The provider list every model group is keyed by, so an empty one is not a cold
// catalogue the picker can degrade around — it is a menu with no sections at all.
// Hence: store nothing on failure, and leave any later edge free to retry.
export async function ensureProviders(store, fetchProviders, options) {
  const known = store.getState().providers;
  if (known?.length) {
    return known;
  }
  try {
    const providers = normalizeProviderList(
      await fetchListWithRetry(() => fetchProviders(), "provider list", options)
    );
    store.getState().setProviders(providers);
    return providers;
  } catch {
    return [];
  }
}

// The boot pre-fetch is deliberately bounded. If it exhausts its retries, the
// New Session picker used to stay on its synthetic current-model row forever:
// opening the picker was not another fetch edge. Retry missing/error catalogs
// when the user asks to see them. A still-running boot fetch remains deduped by
// ensureProviderModels's "loading" guard.
export async function ensureModelPickerCatalogs(store, fetchFn, options = {}) {
  if (options.fetchProviders) {
    await ensureProviders(store, options.fetchProviders, options);
  }
  const ui = store.getState();
  const providers = ui.providers?.length
    ? ui.providers
    : [ui.sessionDraft?.provider].filter(Boolean);
  const needsCatalog = providers.filter((provider) => (
    !ui.providerModels?.[provider]?.length
    || ui.providerModelsStatus?.[provider] === "error"
  ));

  await Promise.all(
    needsCatalog.map((provider) => ensureProviderModels(store, provider, fetchFn, options))
  );
}
