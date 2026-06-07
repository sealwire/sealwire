/**
 * Browser-notification glue for thread attention events.
 *
 * Pairs with `thread-attention.js`: the tracker decides *which* transitions are
 * notify-worthy (it already accounts for tab focus + the viewed thread), and
 * this module turns those events into Web Notifications. All DOM/Notification
 * access is feature-guarded so the pure helpers stay testable under Node.
 */

import { threadAttention } from "./thread-attention.js";

let config = {
  /** @type {((threadId: string) => string | null | undefined) | null} */
  resolveThreadName: null,
  /** @type {((threadId: string) => void) | null} */
  onActivateThread: null,
};

/**
 * Register surface-specific hooks (name lookup + click-to-open). Idempotent;
 * later calls shallow-merge over earlier ones.
 */
export function configureThreadNotifications(next = {}) {
  config = { ...config, ...next };
}

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission() {
  return notificationsSupported() ? window.Notification.permission : "denied";
}

let permissionRequest = null;

/**
 * Request notification permission once, lazily. Safe to call on every user
 * gesture: it no-ops unless the permission is still "default", and dedupes
 * concurrent requests.
 *
 * @returns {Promise<NotificationPermission | "denied">}
 */
export function ensureNotificationPermission() {
  if (!notificationsSupported()) {
    return Promise.resolve("denied");
  }
  const current = window.Notification.permission;
  if (current !== "default") {
    return Promise.resolve(current);
  }
  if (permissionRequest) {
    return permissionRequest;
  }
  try {
    permissionRequest = Promise.resolve(window.Notification.requestPermission()).finally(() => {
      permissionRequest = null;
    });
    return permissionRequest;
  } catch {
    permissionRequest = null;
    return Promise.resolve("denied");
  }
}

/** True when the tab is both visible and focused. */
export function isDocumentForeground() {
  if (typeof document === "undefined") {
    return true;
  }
  const visible = document.visibilityState ? document.visibilityState === "visible" : true;
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return visible && focused;
}

/**
 * @param {{ kind: "needs_input" | "completed" }} event
 * @param {string | null} [name]
 * @returns {{ title: string, body: string }}
 */
export function formatThreadNotification(event, name) {
  const label = name || "A thread";
  if (event?.kind === "needs_input") {
    return { title: "Agent needs your input", body: `${label} is waiting for you.` };
  }
  return { title: "Agent finished", body: `${label} completed its turn.` };
}

/**
 * Fire a browser notification for each notify-worthy event. No-ops without
 * permission or notification support.
 *
 * @param {Array<{ threadId: string, kind: "needs_input" | "completed", notify: boolean }>} events
 */
export function notifyThreadEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }
  if (!notificationsSupported() || window.Notification.permission !== "granted") {
    return;
  }

  for (const event of events) {
    if (!event?.notify || !event.threadId) {
      continue;
    }
    const name = config.resolveThreadName?.(event.threadId) || null;
    const { title, body } = formatThreadNotification(event, name);
    try {
      const notification = new window.Notification(title, {
        body,
        // Coalesce repeats for the same thread+kind into a single toast.
        tag: `thread-${event.threadId}-${event.kind}`,
      });
      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          /* focus may be blocked; ignore */
        }
        try {
          threadAttention.clear(event.threadId);
        } catch {
          /* tracker is best-effort */
        }
        try {
          config.onActivateThread?.(event.threadId);
        } catch {
          /* activation is best-effort */
        }
        try {
          notification.close();
        } catch {
          /* already closed */
        }
      };
    } catch {
      // Some environments throw on construction (e.g. permission revoked mid-flight).
    }
  }
}
