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
