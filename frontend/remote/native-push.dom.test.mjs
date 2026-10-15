import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html data-native-app="ios"><body></body></html>', {
  url: "https://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;

const push = await import("./push-subscribe.js");

test("app permission and registration use APNs without Web Push or a VAPID key", async () => {
  const calls = [];
  window.sealwireNative = {
    push: {
      requestPermissions: async () => { calls.push("permission"); return { receive: "granted" }; },
      checkPermissions: async () => ({ receive: "granted" }),
      register: async () => ({ token: "ab".repeat(32), environment: "development", topic: "dev.sealwire.mobile" }),
    },
  };
  assert.equal(push.pushSupported(), true);
  assert.equal(await push.requestPushPermission(), "granted");
  const result = await push.ensurePushSubscription({
    relayId: "relay-b",
    dispatch: async (action, payload) => calls.push([action, payload]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["permission", ["register_apns_token", {
    input: { token: "ab".repeat(32), environment: "development", topic: "dev.sealwire.mobile", relay_id: "relay-b" },
  }]]);
});

test("denied native permission never registers a token", async () => {
  window.sealwireNative.push.requestPermissions = async () => ({ receive: "denied" });
  window.sealwireNative.push.checkPermissions = async () => ({ receive: "denied" });
  assert.equal(await push.requestPushPermission(), "denied");
  const result = await push.ensurePushSubscription({ dispatch: () => assert.fail("registered denied device") });
  assert.equal(result.reason, "permission");
});

test("missing push entitlement is a quiet registration failure", async () => {
  window.sealwireNative.push.checkPermissions = async () => ({ receive: "granted" });
  window.sealwireNative.push.register = async () => { throw new Error("no valid aps-environment entitlement"); };
  const result = await push.ensurePushSubscription({ relayId: "relay-b", dispatch: () => assert.fail("registered without a token") });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "native-registration-failed");
});

test("a browser never uses the native bridge", () => {
  document.documentElement.removeAttribute("data-native-app");
  try { assert.equal(push.pushSupported(), false); }
  finally { document.documentElement.dataset.nativeApp = "ios"; }
});

test("the app's scan-to-pair control requests native notification permission", async () => {
  const { createServer } = await import("vite");
  const { act } = await import("react");
  for (const name of ["HTMLElement", "HTMLDialogElement", "Node", "MutationObserver", "Event", "CustomEvent", "getComputedStyle"]) {
    globalThis[name] = dom.window[name];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  document.body.innerHTML = '<div id="remote-root"></div>';
  let requested = 0;
  window.Notification = { permission: "default", requestPermission: () => assert.fail("used browser permission") };
  window.sealwireNative = {
    scanQrCode: async () => ({ value: "invalid-pairing-code" }),
    push: {
      checkPermissions: async () => ({ receive: "prompt" }),
      requestPermissions: async () => { requested += 1; return { receive: "granted" }; },
      onAction: () => () => {},
      register: () => assert.fail("registered before pairing completed"),
    },
  };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let app;
  try {
    app = await server.ssrLoadModule("/frontend/remote/react-app.js");
    await act(async () => app.mountRemoteApp());
    const scan = [...document.querySelectorAll("button")].find((button) => button.textContent === "Scan QR code");
    assert.ok(scan, "the app's pairing screen must offer its native scanner");
    await act(async () => scan.click());
    assert.equal(requested, 1);
  } finally {
    if (app) await act(async () => app.unmountRemoteApp());
    await server.close();
  }
});
