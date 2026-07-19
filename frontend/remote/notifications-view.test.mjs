import test from "node:test";
import assert from "node:assert/strict";

import { remoteNotificationsHint, shouldAutoSubscribe } from "./notifications-view.js";

// --- remoteNotificationsHint: informational status, never an action ----------

test("subscribed device is told alerts are on", () => {
  const hint = remoteNotificationsHint({
    supported: true,
    hasVapidKey: true,
    permission: "granted",
    subscribed: true,
  });
  assert.match(hint, /push alerts/);
});

test("not yet paired/subscribed: explains it's automatic", () => {
  const hint = remoteNotificationsHint({
    supported: true,
    hasVapidKey: true,
    permission: "default",
    subscribed: false,
  });
  assert.match(hint, /automatically when you pair/);
});

test("denied points the user at browser settings (the off switch)", () => {
  const hint = remoteNotificationsHint({
    supported: true,
    hasVapidKey: true,
    permission: "denied",
  });
  assert.match(hint, /blocked in your browser/);
});

test("unsupported context explains the requirement", () => {
  const hint = remoteNotificationsHint({ supported: false, hasVapidKey: true });
  assert.match(hint, /HTTPS/);
});

test("relay without a VAPID key says push isn't available yet", () => {
  const hint = remoteNotificationsHint({ supported: true, hasVapidKey: false });
  assert.match(hint, /isn't available on this relay/);
});

// --- shouldAutoSubscribe: the auto-enroll gate -------------------------------

test("auto-subscribes when supported + key + permission granted", () => {
  assert.equal(
    shouldAutoSubscribe({ supported: true, hasVapidKey: true, permissionGranted: true }),
    true
  );
});

test("does NOT auto-subscribe until permission is granted (deny = off)", () => {
  assert.equal(
    shouldAutoSubscribe({ supported: true, hasVapidKey: true, permissionGranted: false }),
    false
  );
});

test("does NOT auto-subscribe without support or a VAPID key", () => {
  assert.equal(
    shouldAutoSubscribe({ supported: false, hasVapidKey: true, permissionGranted: true }),
    false
  );
  assert.equal(
    shouldAutoSubscribe({ supported: true, hasVapidKey: false, permissionGranted: true }),
    false
  );
});
