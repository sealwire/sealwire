import test from "node:test";
import assert from "node:assert/strict";

const STORAGE_KEY = "agent-relay.relay-nicknames";

function installLocalStorageStub() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
  };
  return store;
}

async function loadModule() {
  const url = new URL("./relay-nicknames.js", import.meta.url).href;
  const mod = await import(`${url}?cacheBust=${Math.random()}`);
  mod._resetRelayNicknamesForTests();
  return mod;
}

test("loadRelayNicknames returns empty object when nothing stored", async () => {
  installLocalStorageStub();
  const mod = await loadModule();
  assert.deepEqual(mod.loadRelayNicknames(), {});
});

test("saveRelayNickname persists trimmed value and notifies listeners", async () => {
  const store = installLocalStorageStub();
  const mod = await loadModule();

  let calls = 0;
  mod.subscribeRelayNicknames(() => {
    calls += 1;
  });

  mod.saveRelayNickname("relay-abc", "  My Mac  ");
  assert.equal(mod.getRelayNickname("relay-abc"), "My Mac");
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)), { "relay-abc": "My Mac" });
});

test("snapshot reference is stable across loads until something changes", async () => {
  installLocalStorageStub();
  const mod = await loadModule();

  const snapshotA = mod.loadRelayNicknames();
  const snapshotB = mod.loadRelayNicknames();
  assert.equal(snapshotA, snapshotB);

  mod.saveRelayNickname("relay-abc", "Foo");
  const snapshotC = mod.loadRelayNicknames();
  assert.notEqual(snapshotA, snapshotC);
  assert.equal(snapshotC["relay-abc"], "Foo");
});

test("saving the same value does not notify", async () => {
  installLocalStorageStub();
  const mod = await loadModule();
  mod.saveRelayNickname("relay-abc", "Foo");

  let calls = 0;
  mod.subscribeRelayNicknames(() => {
    calls += 1;
  });
  mod.saveRelayNickname("relay-abc", "Foo");
  assert.equal(calls, 0);
});

test("saving empty string removes the entry", async () => {
  const store = installLocalStorageStub();
  const mod = await loadModule();
  mod.saveRelayNickname("relay-abc", "Foo");
  mod.saveRelayNickname("relay-abc", "   ");
  assert.equal(mod.getRelayNickname("relay-abc"), null);
  assert.equal(store.get(STORAGE_KEY), undefined);
});

test("clearRelayNickname removes the entry and notifies", async () => {
  installLocalStorageStub();
  const mod = await loadModule();
  mod.saveRelayNickname("relay-abc", "Foo");

  let calls = 0;
  mod.subscribeRelayNicknames(() => {
    calls += 1;
  });
  mod.clearRelayNickname("relay-abc");
  assert.equal(mod.getRelayNickname("relay-abc"), null);
  assert.equal(calls, 1);
});

test("malformed stored JSON falls back to empty map", async () => {
  const store = installLocalStorageStub();
  store.set(STORAGE_KEY, "{not valid json");
  const mod = await loadModule();
  assert.deepEqual(mod.loadRelayNicknames(), {});
});

test("non-string values in stored JSON are ignored", async () => {
  const store = installLocalStorageStub();
  store.set(
    STORAGE_KEY,
    JSON.stringify({ "relay-abc": "Mac", "relay-xyz": 42, "": "no key" })
  );
  const mod = await loadModule();
  assert.deepEqual(mod.loadRelayNicknames(), { "relay-abc": "Mac" });
});
