import test from "node:test";
import assert from "node:assert/strict";

test("native listeners precede registration, return APNs config, and retain a cold-start tap", async () => {
  const { createNativePush } = await import("./src/native-push.js");
  const listeners = new Map();
  const plugin = {
    async addListener(name, callback) { listeners.set(name, callback); return { remove() {} }; },
    async register() {
      assert.ok(listeners.has("registrationError"));
      listeners.get("registration")({ value: "token" });
    },
    requestPermissions: async () => ({ receive: "granted" }),
    checkPermissions: async () => ({ receive: "granted" }),
  };
  const bridge = createNativePush(plugin, {
    getConfiguration: async () => ({ environment: "development", topic: "dev.sealwire.mobile" }),
  });
  await bridge.ready;
  listeners.get("pushNotificationActionPerformed")({ notification: { data: { thread_id: "t1", device_id: "d1", relay_id: "relay-b" } } });
  const actions = [];
  const stop = bridge.onAction((action) => actions.push(action));
  assert.deepEqual(actions, [{ thread_id: "t1", device_id: "d1", relay_id: "relay-b" }]);
  stop();
  assert.deepEqual(await bridge.register(), { token: "token", environment: "development", topic: "dev.sealwire.mobile" });
});

test("APNs registration errors reject the pending registration", async () => {
  const { createNativePush } = await import("./src/native-push.js");
  const listeners = new Map();
  const bridge = createNativePush({
    async addListener(name, callback) { listeners.set(name, callback); },
    async register() { listeners.get("registrationError")({ error: "missing entitlement" }); },
  }, { getConfiguration: async () => ({}) });
  await assert.rejects(bridge.register(), /missing entitlement/);
});
