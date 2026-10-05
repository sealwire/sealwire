import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function createRequest() {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

function createIndexedDbStub() {
  const databases = new Map();

  function createDatabase() {
    const stores = new Map();

    return {
      objectStoreNames: {
        contains(name) {
          return stores.has(name);
        },
      },
      createObjectStore(name, options = {}) {
        if (!stores.has(name)) {
          stores.set(name, {
            keyPath: options.keyPath || "id",
            records: new Map(),
          });
        }
        return {};
      },
      transaction(name) {
        const storeState = stores.get(name);
        const transaction = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore() {
            return {
              get(key) {
                const request = createRequest();
                queueMicrotask(() => {
                  request.result = storeState.records.get(key);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
              put(value) {
                const request = createRequest();
                queueMicrotask(() => {
                  storeState.records.set(value[storeState.keyPath], value);
                  request.result = value[storeState.keyPath];
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
            };
          },
        };
        return transaction;
      },
      close() {},
    };
  }

  return {
    open(name) {
      const request = createRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = createDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) {
          request.onupgradeneeded?.();
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
    peek(dbName, storeName, recordId) {
      return databases.get(dbName)?.transaction(storeName).objectStore().get(recordId);
    },
  };
}

function installBrowserStubs({ subtleAvailable, indexedDb = createIndexedDbStub() }) {
  const cryptoObject = {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  };
  if (subtleAvailable) {
    cryptoObject.subtle = webcrypto.subtle;
  }

  globalThis.window = {
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    location: { href: "http://192.168.1.47:8788/" },
    history: {
      replaceState() {},
    },
    atob(value) {
      return Buffer.from(value, "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    crypto: cryptoObject,
    indexedDB: indexedDb,
  };

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoObject,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDb,
  });

  return { indexedDb };
}

async function importCrypto(tag) {
  return import(`./crypto.js?${tag}`);
}

test("ensureDeviceKeypair falls back to software storage when WebCrypto subtle is unavailable", async () => {
  const { indexedDb } = installBrowserStubs({ subtleAvailable: false });
  const { ensureDeviceKeypair } = await importCrypto(`software-fallback-${Date.now()}`);

  const keypair = await ensureDeviceKeypair();
  const signature = await keypair.sign(new TextEncoder().encode("agent-relay:test"));

  assert.ok(keypair.verifyKey);
  assert.ok(signature instanceof Uint8Array);

  const request = indexedDb.peek("agent-relay-crypto", "device-keys", "remote-device-keypair-v1");
  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      assert.equal(request.result.kind, "software");
      assert.ok(request.result.signingSeed);
      resolve();
    };
    request.onerror = () => reject(request.error || new Error("failed to inspect key store"));
  });
});

test("software-stored device keypair persists across module reloads", async () => {
  const indexedDb = createIndexedDbStub();
  installBrowserStubs({ subtleAvailable: false, indexedDb });
  const firstCrypto = await importCrypto(`software-persist-a-${Date.now()}`);
  const firstKeypair = await firstCrypto.ensureDeviceKeypair();

  installBrowserStubs({ subtleAvailable: false, indexedDb });
  const secondCrypto = await importCrypto(`software-persist-b-${Date.now()}`);
  const secondKeypair = await secondCrypto.ensureDeviceKeypair();

  assert.equal(secondKeypair.verifyKey, firstKeypair.verifyKey);
});

// The exact bytes the broker verifies. This literal is duplicated in
// `the_client_claim_message_matches_the_frontend_contract`
// (crates/relay-broker/src/public_control.rs); both sides assert against it, so
// a change to either format fails a test here instead of silently rejecting
// every pairing at runtime. The relay id is part of the message on purpose: a
// signature made for one relay must not redeem another relay's attestation.
test("the client claim message matches the broker contract", async () => {
  installBrowserStubs({});
  const crypto = await importCrypto(`claim-message-${Date.now()}`);

  assert.equal(
    crypto.clientClaimProofMessage("ccl-abc", "cn-def", "relay-1"),
    "agent-relay:client-claim:ccl-abc:cn-def:relay-1"
  );
});

// The operator compares this with the computer's screen; the same literal is pinned in
// `the_phone_and_relay_agree_on_a_device_fingerprint` so the two formats cannot drift.
test("the device fingerprint matches the relay's format", async () => {
  installBrowserStubs({});
  const crypto = await importCrypto(`fingerprint-${Date.now()}`);

  assert.equal(
    crypto.deviceKeyFingerprint("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="),
    "ae:21:6c:2e:f5:24:7a:37"
  );
});
