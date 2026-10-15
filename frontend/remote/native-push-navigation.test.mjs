import test from "node:test";
import assert from "node:assert/strict";

test("a notification selects its owning relay even when two profiles share the device ID", async () => {
  const { handleNativePushAction } = await import("./native-push-navigation.js");
  const selected = [];
  const opened = [];
  const action = { thread_id: "thread-b", device_id: "same-phone", relay_id: "relay-b" };
  const progress = {};
  const options = {
    remoteProfiles: {
      "relay-a": { relayId: "relay-a", deviceId: "same-phone" },
      "relay-b": { relayId: "relay-b", deviceId: "same-phone" },
    },
    currentRelayId: "relay-a", ready: true,
    selectRelay: (id) => selected.push(id), openThread: (id) => opened.push(id),
  };
  assert.equal(handleNativePushAction(action, options, progress), false);
  assert.deepEqual(selected, ["relay-b"]);
  assert.deepEqual(opened, []);
  options.currentRelayId = "relay-b";
  options.ready = false;
  assert.equal(handleNativePushAction(action, options, progress), false);
  assert.deepEqual(opened, []);
  options.ready = true;
  assert.equal(handleNativePushAction(action, options, progress), true);
  assert.deepEqual(opened, ["thread-b"]);
  assert.deepEqual(selected, ["relay-b"]);
  assert.equal(handleNativePushAction({ ...action, device_id: "forgotten-device" }, options, {}), true);
  assert.equal(handleNativePushAction({ ...action, relay_id: "unknown-relay" }, options, {}), true);
  assert.deepEqual(opened, ["thread-b"]);
});

test("leaving an offline notification's relay cancels its navigation instead of pulling the user back", async () => {
  const { handleNativePushAction } = await import("./native-push-navigation.js");
  const selected = [];
  const action = { thread_id: "thread-b", device_id: "phone", relay_id: "relay-b" };
  const options = {
    remoteProfiles: { "relay-b": { relayId: "relay-b", deviceId: "phone" } },
    currentRelayId: "relay-a", ready: false,
    selectRelay: (id) => selected.push(id),
    openThread: () => assert.fail("an offline relay has no session to open"),
  };
  const progress = {};
  assert.equal(handleNativePushAction(action, options, progress), false);
  options.currentRelayId = "relay-b";
  assert.equal(handleNativePushAction(action, options, progress), false);
  for (const currentRelayId of ["relay-a", null]) {
    options.currentRelayId = currentRelayId;
    assert.equal(handleNativePushAction(action, options, progress), true, "manual navigation must consume the pending tap");
  }
  assert.deepEqual(selected, ["relay-b"], "one tap can select a relay only once");
  assert.equal(handleNativePushAction(action, options, {}), false, "a new tap may select the relay again");
  assert.deepEqual(selected, ["relay-b", "relay-b"]);
});

test("a tap on the current offline relay also yields to a later manual selection", async () => {
  const { handleNativePushAction } = await import("./native-push-navigation.js");
  const action = { thread_id: "thread-b", device_id: "phone", relay_id: "relay-b" };
  const options = {
    remoteProfiles: { "relay-b": { relayId: "relay-b", deviceId: "phone" } },
    currentRelayId: "relay-b", ready: false,
    selectRelay: () => assert.fail("the user left the relay; do not select it again"),
    openThread: () => assert.fail("an offline relay has no session to open"),
  };
  const progress = {};
  assert.equal(handleNativePushAction(action, options, progress), false);
  options.currentRelayId = "relay-a";
  assert.equal(handleNativePushAction(action, options, progress), true);
});
