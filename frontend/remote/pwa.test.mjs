import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const deletedCaches = [];
  const registeredPaths = [];

  globalThis.window = {
    location: { href: "https://remote.example.test/" },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        async register(path) {
          registeredPaths.push(path);
          return { scope: "https://remote.example.test/", pushManager: {} };
        },
      },
    },
  });
  globalThis.caches = {
    async keys() {
      return ["agent-relay-remote-v1", "agent-relay-remote-v2", "other-cache"];
    },
    async delete(key) {
      deletedCaches.push(key);
      return true;
    },
  };

  return {
    deletedCaches,
    registeredPaths,
  };
}

test("registerRemotePwa registers the push-only service worker and clears remote caches", async () => {
  const browser = installBrowserStubs();

  const { registerRemotePwa, getRemoteServiceWorkerRegistration } = await import("./pwa.js");
  const registration = await registerRemotePwa();

  assert.deepEqual(browser.registeredPaths, ["/sw.js"]);
  assert.ok(registration, "registration should be returned");
  assert.equal(getRemoteServiceWorkerRegistration(), registration);
  assert.deepEqual(browser.deletedCaches, [
    "agent-relay-remote-v1",
    "agent-relay-remote-v2",
  ]);
});
