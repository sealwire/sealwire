// Push-only service worker for the remote PWA.
//
// IMPORTANT: this worker has NO `fetch` handler and does NO HTTP/app-shell
// caching. An earlier version cached the app shell, which served stale session
// state on this live control surface. Web Push is the only reason this worker
// exists, so keep it free of any request interception.

const REMOTE_CACHE_PREFIX = "agent-relay-remote-";

self.addEventListener("install", () => {
  // Take over as soon as the new push worker is installed.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Purge any caches the old caching service worker left behind.
      if (self.caches?.keys) {
        const keys = await self.caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith(REMOTE_CACHE_PREFIX))
            .map((key) => self.caches.delete(key))
        );
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  const title = (payload && payload.title) || "Agent update";
  const options = {
    body: (payload && payload.body) || "",
    // `tag` coalesces repeats for the same thread+kind (server sends
    // `thread-<id>-<kind>` to match thread-notify.js).
    tag: (payload && payload.tag) || undefined,
    data: {
      threadId: (payload && payload.threadId) || null,
      kind: (payload && payload.kind) || null,
      url: (payload && payload.url) || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        if ("focus" in client) {
          try {
            if ("navigate" in client && targetUrl && targetUrl !== "/") {
              await client.navigate(targetUrl).catch(() => {});
            }
          } catch {
            // navigation is best-effort; still focus the existing window.
          }
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl || "/");
      }
      return undefined;
    })()
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // We cannot re-subscribe here without the VAPID key (which only the page
  // holds), so nudge any open client to re-register on its next interaction.
  event.waitUntil(
    (async () => {
      try {
        const clientList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clientList) {
          client.postMessage({ type: "pushsubscriptionchange" });
        }
      } catch {
        // best-effort only.
      }
    })()
  );
});
