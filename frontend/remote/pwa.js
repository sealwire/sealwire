const REMOTE_SERVICE_WORKER_PATH = "/sw.js";
const REMOTE_CACHE_PREFIX = "agent-relay-remote-";

export async function registerRemotePwa() {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker?.getRegistrations) {
    return;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter(isRemoteServiceWorkerRegistration)
        .map((registration) => registration.unregister())
    );
    await clearRemoteCaches();
  } catch (error) {
    console.warn("failed to disable remote service worker support", error);
  }
}

function isRemoteServiceWorkerRegistration(registration) {
  const worker =
    registration?.active ||
    registration?.waiting ||
    registration?.installing;
  if (!worker?.scriptURL) {
    return false;
  }

  try {
    const scriptUrl = new URL(worker.scriptURL, window.location.href);
    const pageOrigin = new URL(window.location.href).origin;
    return scriptUrl.origin === pageOrigin
      && scriptUrl.pathname === REMOTE_SERVICE_WORKER_PATH;
  } catch {
    return false;
  }
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
