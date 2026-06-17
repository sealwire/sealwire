const REMOTE_SERVICE_WORKER_PATH = "/sw.js";
const REMOTE_CACHE_PREFIX = "agent-relay-remote-";

let remoteServiceWorkerRegistration = null;

/**
 * Register the push-only remote service worker and clear any caches left by the
 * old caching worker. Non-fatal on failure. Returns the registration (or null).
 */
export async function registerRemotePwa() {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker?.register) {
    return null;
  }

  try {
    // Drop any HTTP caches the old caching service worker created. The revived
    // worker is push-only (no fetch handler), but a stale cache from a prior
    // install must still be purged.
    await clearRemoteCaches();
    const registration = await navigator.serviceWorker.register(REMOTE_SERVICE_WORKER_PATH);
    remoteServiceWorkerRegistration = registration;
    return registration;
  } catch (error) {
    console.warn("failed to register remote service worker", error);
    return null;
  }
}

/**
 * The registration captured by registerRemotePwa(), if any. Lets the push
 * subscription manager reach `registration.pushManager` without re-registering.
 */
export function getRemoteServiceWorkerRegistration() {
  return remoteServiceWorkerRegistration;
}

async function clearRemoteCaches() {
  if (!globalThis.caches?.keys) {
    return;
  }

  const keys = await globalThis.caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(REMOTE_CACHE_PREFIX))
      .map((key) => globalThis.caches.delete(key))
  );
}
