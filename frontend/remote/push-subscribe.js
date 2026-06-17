/**
 * Web Push subscription manager for the remote PWA.
 *
 * Registers/unregisters a push subscription with the server via the broker
 * remote-action transport. All DOM/SW/network access is feature-guarded so the
 * pure helpers (`urlBase64ToUint8Array`, `subscriptionToInput`) stay testable
 * under Node.
 *
 * Wire contract with the backend (do not deviate):
 *   register:   { type: "register_push_subscription", input: { endpoint, keys: { p256dh, auth } } }
 *   unregister: { type: "unregister_push_subscription", endpoint }
 * Both are device-authenticated and DO NOT require a session claim.
 */

import { dispatchRemoteActionWithoutReply } from "./actions.js";

/**
 * Convert a base64url VAPID public key into the Uint8Array the
 * `applicationServerKey` option expects.
 *
 * @param {string} base64String
 * @returns {Uint8Array}
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** True iff this environment can subscribe to Web Push in a secure context. */
export function pushSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window &&
    Boolean(window.isSecureContext)
  );
}

/**
 * Shape a PushSubscription into the `input` payload the server expects.
 *
 * @param {PushSubscription} sub
 * @returns {{ endpoint: string, keys: { p256dh: string, auth: string } }}
 */
export function subscriptionToInput(sub) {
  const json = typeof sub?.toJSON === "function" ? sub.toJSON() : sub || {};
  const keys = json.keys || {};
  return {
    endpoint: json.endpoint,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}

/**
 * Ensure a push subscription exists and is registered with the server.
 * Never throws on guard failures — returns `{ ok: false, reason }` instead.
 *
 * @param {{ vapidPublicKey?: string | null, registration?: ServiceWorkerRegistration | null }} options
 * @returns {Promise<{ ok: boolean, reason?: string, subscription?: PushSubscription }>}
 */
export async function ensurePushSubscription({ vapidPublicKey, registration } = {}) {
  if (!pushSupported()) {
    return { ok: false, reason: "unsupported" };
  }
  if (window.Notification.permission !== "granted") {
    return { ok: false, reason: "permission" };
  }
  if (!vapidPublicKey) {
    return { ok: false, reason: "missing-vapid-key" };
  }
  if (!registration?.pushManager) {
    return { ok: false, reason: "missing-registration" };
  }

  try {
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }

    await dispatchRemoteActionWithoutReply("register_push_subscription", {
      input: subscriptionToInput(subscription),
    });

    return { ok: true, subscription };
  } catch (error) {
    return { ok: false, reason: error?.message || "subscribe-failed" };
  }
}

/**
 * Unsubscribe locally and tell the server to drop the endpoint.
 *
 * @param {{ registration?: ServiceWorkerRegistration | null }} options
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function disablePushSubscription({ registration } = {}) {
  if (!registration?.pushManager) {
    return { ok: false, reason: "missing-registration" };
  }

  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      return { ok: true };
    }
    const { endpoint } = subscription;
    await subscription.unsubscribe();
    if (endpoint) {
      await dispatchRemoteActionWithoutReply("unregister_push_subscription", {
        endpoint,
      });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || "unsubscribe-failed" };
  }
}
