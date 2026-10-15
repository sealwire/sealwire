// Status text + auto-enroll gate for the remote "Notifications" section.
//
// Notifications follow device pairing: the browser permission prompt rides the
// pairing gesture, and the client subscribes automatically once permission is
// granted and the relay has advertised a VAPID key (see react-app.js). There is
// intentionally NO in-app toggle — the browser's own notification permission is
// the on/off switch, and it persists — so this section is purely informational.

import { t } from "../shared/i18n.js";

/**
 * The gate the auto-enroll effect uses: enroll only when push is usable and the
 * browser permission is granted. "Off" is expressed by denying the browser
 * permission, so there's no separate opt-out to consult.
 *
 * @param {{ supported?: boolean, hasVapidKey?: boolean,
 *   permissionGranted?: boolean }} [model]
 * @returns {boolean}
 */
export function shouldAutoSubscribe(model = {}) {
  return (
    Boolean(model.supported) &&
    (Boolean(model.native) || Boolean(model.hasVapidKey)) &&
    Boolean(model.permissionGranted)
  );
}

/**
 * @param {{ supported?: boolean, permission?: string, subscribed?: boolean,
 *   hasVapidKey?: boolean }} [model]
 * @returns {string} an informational status line (no actions)
 */
export function remoteNotificationsHint(model = {}) {
  const supported = Boolean(model.supported);
  const hasVapidKey = Boolean(model.hasVapidKey);
  const denied = model.permission === "denied";
  const subscribed = Boolean(model.subscribed);

  if (!supported) {
    return t("Requires HTTPS / iOS 16.4+ installed to Home Screen.");
  }
  if (denied) {
    if (model.native) return t("Notifications are blocked in iOS settings.");
    // The browser permission is the off switch; point the user at it.
    return t("Notifications are blocked in your browser settings.");
  }
  if (model.native ? !model.apnsAvailable : !hasVapidKey) {
    return t("Push isn't available on this relay yet.");
  }
  if (subscribed) {
    return t("You'll get push alerts when sessions need input or finish, even when the app is closed.");
  }
  return t("Notifications turn on automatically when you pair this device.");
}
