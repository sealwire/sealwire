import test from "node:test";
import assert from "node:assert/strict";

let pendingTimers = [];

function installBrowserStubs() {
  const storage = new Map();

  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    setTimeout(callback) {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    clearTimeout(id) {
      pendingTimers[id - 1] = null;
    },
  };
  globalThis.document = {
    querySelector() {
      return null;
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

function runNextTimer() {
  while (pendingTimers.length) {
    const callback = pendingTimers.shift();
    if (callback) {
      callback();
      return;
    }
  }
}

installBrowserStubs();

const { patchRemoteState, state } = await import("../state.js");
const {
  clearSessionRuntimeEffects,
  scheduleControllerHeartbeat,
  scheduleControllerLeaseRefresh,
} = await import("../session-runtime-effects.js");

test("scheduleControllerHeartbeat stores a timer only for the active controller", () => {
  pendingTimers = [];
  patchRemoteState({
    controllerHeartbeatTimer: null,
    remoteAuth: { deviceId: "device-a" },
  });

  let heartbeatCount = 0;
  scheduleControllerHeartbeat(
    {
      active_thread_id: "thread-1",
      active_controller_device_id: "device-a",
    },
    () => {
      heartbeatCount += 1;
    }
  );

  assert.equal(state.controllerHeartbeatTimer, 1);
  runNextTimer();
  assert.equal(heartbeatCount, 1);

  clearSessionRuntimeEffects();
  assert.equal(state.controllerHeartbeatTimer, null);
});

test("scheduleControllerLeaseRefresh stores a timer only for non-controller viewers", () => {
  pendingTimers = [];
  patchRemoteState({
    controllerLeaseRefreshTimer: null,
    remoteAuth: { deviceId: "device-a" },
  });

  let expired = 0;
  scheduleControllerLeaseRefresh(
    {
      active_thread_id: "thread-1",
      active_controller_device_id: "device-b",
      controller_lease_expires_at: Math.floor(Date.now() / 1000) + 30,
    },
    () => {
      expired += 1;
    }
  );

  assert.equal(state.controllerLeaseRefreshTimer, 1);
  runNextTimer();
  assert.equal(expired, 1);

  clearSessionRuntimeEffects();
  assert.equal(state.controllerLeaseRefreshTimer, null);
});
