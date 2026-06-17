// Fetch a provider's model catalog with bounded retry + backoff.
//
// Claude's catalog is a live worker round-trip (SDK supportedModels()) that is
// cold/slow right after a relay restart — exactly when the client pulls it.
// A single attempt that fails (or returns an empty list) used to be swallowed
// silently, leaving the new-session dialog stuck on a single hardcoded default.
// Retrying a few times with backoff lets the pull succeed once the worker
// warms up; if every attempt fails the caller learns about it (throws) instead
// of silently degrading.
//
// `sleep` is injectable so tests can run without real timers.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchModelsWithRetry(
  fetchFn,
  provider,
  { attempts = 3, baseDelayMs = 600, sleep = defaultSleep } = {}
) {
  let lastError = new Error("model fetch failed");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const models = await fetchFn(provider);
      if (Array.isArray(models) && models.length > 0) {
        return models;
      }
      // An empty catalog is treated as a soft failure worth retrying: a healthy
      // provider always returns at least one model, so empty means "not ready".
      lastError = new Error(`empty model catalog for ${provider}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts - 1) {
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
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
