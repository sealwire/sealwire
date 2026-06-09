import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto as webCrypto } from "node:crypto";

// encoding.js (imported transitively by page-cache.js) uses window.atob/btoa.
globalThis.window = globalThis.window || {
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
};

const { createTranscriptPageCache } = await import("./page-cache.js");

// ---------------------------------------------------------------------------
// Minimal but faithful in-memory IndexedDB supporting exactly what page-cache.js
// uses: open + onupgradeneeded, createObjectStore/createIndex, array-name
// readwrite transactions with oncomplete, store get/put/clear, and ascending
// index cursors with continue()/delete(). Crucially exposes `cmp`, so the
// capability gate in page-cache treats it as a real IDBFactory.
// ---------------------------------------------------------------------------
function createFakeIndexedDB() {
  const databases = new Map();

  function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
  }

  function makeStore(meta) {
    return {
      createIndex(name, keyPath) {
        meta.indexes.set(name, { keyPath });
        return {};
      },
      get(key) {
        const req = makeRequest();
        queueMicrotask(() => {
          req.result = meta.records.get(key);
          req.onsuccess?.();
        });
        return req;
      },
      put(value) {
        const req = makeRequest();
        queueMicrotask(() => {
          meta.records.set(value[meta.keyPath], value);
          req.result = value[meta.keyPath];
          req.onsuccess?.();
        });
        return req;
      },
      clear() {
        const req = makeRequest();
        queueMicrotask(() => {
          meta.records.clear();
          req.onsuccess?.();
        });
        return req;
      },
      index(name) {
        const idx = meta.indexes.get(name);
        return {
          openCursor(query) {
            const req = makeRequest();
            let rows = [...meta.records.values()];
            if (query !== undefined && query !== null) {
              rows = rows.filter((row) => row[idx.keyPath] === query);
            }
            rows.sort((a, b) => {
              const av = a[idx.keyPath];
              const bv = b[idx.keyPath];
              return av < bv ? -1 : av > bv ? 1 : 0;
            });
            let i = 0;
            const advance = () => {
              queueMicrotask(() => {
                if (i >= rows.length) {
                  req.result = null;
                  req.onsuccess?.();
                  return;
                }
                const record = rows[i];
                req.result = {
                  value: record,
                  continue() {
                    i += 1;
                    advance();
                  },
                  delete() {
                    meta.records.delete(record[meta.keyPath]);
                  },
                };
                req.onsuccess?.();
              });
            };
            advance();
            return req;
          },
        };
      },
    };
  }

  function makeDatabase() {
    const stores = new Map();
    return {
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(name, options = {}) {
        const meta = { keyPath: options.keyPath || "id", records: new Map(), indexes: new Map() };
        stores.set(name, meta);
        return makeStore(meta);
      },
      transaction(names) {
        const list = Array.isArray(names) ? names : [names];
        const tx = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore(name) {
            if (!list.includes(name)) {
              throw new Error(`store ${name} not in transaction`);
            }
            return makeStore(stores.get(name));
          },
        };
        // Fire completion on a macrotask, after all request microtasks settle.
        setTimeout(() => tx.oncomplete?.(), 0);
        return tx;
      },
      close() {},
    };
  }

  return {
    cmp(a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    },
    deleteDatabase(name) {
      const req = makeRequest();
      queueMicrotask(() => {
        databases.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
    open(name) {
      const req = makeRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = makeDatabase();
          databases.set(name, database);
        }
        req.result = database;
        if (isNew) {
          req.onupgradeneeded?.();
        }
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    },
  };
}

function makeCache(overrides = {}) {
  let clock = 1000;
  return createTranscriptPageCache({
    indexedDb: createFakeIndexedDB(),
    webCrypto,
    now: () => clock++,
    ...overrides,
  });
}

function olderPage(threadId, before, bytesPad = 0) {
  return {
    thread_id: threadId,
    revision: 1,
    prev_cursor: before - 1,
    entries: [{ item_id: `i-${before}`, status: "completed", text: "x".repeat(bytesPad) }],
  };
}

test("encrypted round-trip: an older page reads back equal", async () => {
  const cache = makeCache();
  const page = olderPage("t1", 10);
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page });
  const read = await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 });
  assert.deepEqual(read, page);
});

test("the tail (before == null) is never stored or served", async () => {
  const cache = makeCache();
  await cache.writePage({
    scope: "relayA",
    threadId: "t1",
    before: null,
    page: { thread_id: "t1", entries: [{ item_id: "tail" }], revision: 9 },
  });
  const read = await cache.readPage({ scope: "relayA", threadId: "t1", before: null });
  assert.equal(read, null);
});

test("overwriting a key returns the latest value", async () => {
  const cache = makeCache();
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page: olderPage("t1", 10, 5) });
  const updated = olderPage("t1", 10, 50);
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page: updated });
  const read = await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 });
  assert.deepEqual(read, updated);
});

test("eviction drops least-recently-written pages once over quota, protecting the newest", async () => {
  // Size the quota to hold exactly two pages so the third write evicts the oldest.
  const pages = [10, 11, 12].map((before) => olderPage("t1", before, 60));
  const pageBytes = Math.max(...pages.map((page) => JSON.stringify(page).length));
  const cache = makeCache({ quotaBytes: 2 * pageBytes + 10 });

  for (let n = 0; n < pages.length; n += 1) {
    await cache.writePage({ scope: "relayA", threadId: "t1", before: 10 + n, page: pages[n] });
  }

  // Oldest (before=10) evicted; the two newest remain.
  assert.equal(await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 }), null);
  assert.ok(await cache.readPage({ scope: "relayA", threadId: "t1", before: 11 }));
  assert.ok(await cache.readPage({ scope: "relayA", threadId: "t1", before: 12 }));
});

test("a read refreshes recency so the touched page survives eviction", async () => {
  const pages = [10, 11].map((before) => olderPage("t1", before, 60));
  const pageBytes = Math.max(...pages.map((page) => JSON.stringify(page).length));
  const cache = makeCache({ quotaBytes: 2 * pageBytes + 10 });

  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page: pages[0] });
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 11, page: pages[1] });

  // Touch the OLDER page so it becomes most-recently-accessed...
  assert.ok(await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 }));
  // ...and let the fire-and-forget lastAccess write settle before evicting.
  await new Promise((resolve) => setTimeout(resolve, 25));

  // Third write exceeds quota -> the now-least-recently-accessed page (before=11) goes.
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 12, page: olderPage("t1", 12, 60) });

  assert.ok(
    await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 }),
    "the read-touched page should survive"
  );
  assert.equal(
    await cache.readPage({ scope: "relayA", threadId: "t1", before: 11 }),
    null,
    "the untouched page should be evicted"
  );
  assert.ok(await cache.readPage({ scope: "relayA", threadId: "t1", before: 12 }));
});

test("clearScope removes only that relay's pages", async () => {
  const cache = makeCache();
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page: olderPage("t1", 10) });
  await cache.writePage({ scope: "relayB", threadId: "t2", before: 10, page: olderPage("t2", 10) });
  await cache.clearScope("relayA");
  assert.equal(await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 }), null);
  assert.ok(await cache.readPage({ scope: "relayB", threadId: "t2", before: 10 }));
});

test("an undecryptable record reads back as a miss (not a throw)", async () => {
  // Write under one key, then point a fresh cache at the SAME db but a webCrypto
  // whose subtle.decrypt always fails -> readPage must resolve null.
  const idb = createFakeIndexedDB();
  const good = createTranscriptPageCache({ indexedDb: idb, webCrypto });
  await good.writePage({ scope: "relayA", threadId: "t1", before: 10, page: olderPage("t1", 10) });

  const brokenCrypto = {
    getRandomValues: (a) => webCrypto.getRandomValues(a),
    subtle: {
      generateKey: (...args) => webCrypto.subtle.generateKey(...args),
      encrypt: (...args) => webCrypto.subtle.encrypt(...args),
      decrypt: async () => {
        throw new Error("bad key");
      },
    },
  };
  const broken = createTranscriptPageCache({ indexedDb: idb, webCrypto: brokenCrypto });
  const read = await broken.readPage({ scope: "relayA", threadId: "t1", before: 10 });
  assert.equal(read, null);
});

test("plaintext fallback round-trips when WebCrypto.subtle is unavailable", async () => {
  const cache = makeCache({ webCrypto: { getRandomValues: () => {} } }); // no subtle
  const page = olderPage("t1", 10);
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page });
  const read = await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 });
  assert.deepEqual(read, page);
});

test("a non-IDBFactory (no cmp) disables the cache entirely", async () => {
  const cache = createTranscriptPageCache({
    indexedDb: { open() {} }, // looks like IDB but lacks cmp
    webCrypto,
  });
  await cache.writePage({ scope: "relayA", threadId: "t1", before: 10, page: olderPage("t1", 10) });
  assert.equal(await cache.readPage({ scope: "relayA", threadId: "t1", before: 10 }), null);
});
