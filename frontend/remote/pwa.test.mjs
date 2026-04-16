import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const deletedCaches = [];
  const registrations = [];

  globalThis.window = {
    location: { href: "https://remote.example.test/" },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        async getRegistrations() {
          return registrations;
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
    registrations,
  };
}

test("registerRemotePwa unregisters the remote service worker and clears remote caches", async () => {
  const browser = installBrowserStubs();
  let remoteUnregisters = 0;
  let otherUnregisters = 0;

  browser.registrations.push(
    {
      active: {
        scriptURL: "https://remote.example.test/sw.js",
      },
      async unregister() {
        remoteUnregisters += 1;
        return true;
      },
    },
    {
      active: {
        scriptURL: "https://remote.example.test/other-sw.js",
      },
      async unregister() {
        otherUnregisters += 1;
        return true;
      },
    }
  );

  const { registerRemotePwa } = await import("./pwa.js");
  await registerRemotePwa();

  assert.equal(remoteUnregisters, 1);
  assert.equal(otherUnregisters, 0);
  assert.deepEqual(browser.deletedCaches, [
    "agent-relay-remote-v1",
    "agent-relay-remote-v2",
  ]);
});
