// Persistent, encrypted-at-rest cache for OLDER transcript history pages.
//
// Only append-stable older pages (before != null) are stored here — the live
// tail is never cached (see ../../shared/caching-transcript-fetcher.js). Pages
// are keyed by (scope, threadId, before); `before` is a from-oldest index
// cursor, so under the common tail-append case an older page's content is stable
// for a given cursor.
//
// At rest the page JSON is encrypted with AES-GCM under a per-browser,
// NON-EXTRACTABLE key (same hardening as remote/secret-store.js): copying the
// IndexedDB files off-device does not yield decryptable history. Same-origin XSS
// is explicitly out of scope (it can call decrypt regardless). When WebCrypto is
// unavailable we fall back to plaintext so the cache still functions.
//
// Eviction: a running byte total is tracked in a meta record; on write, once the
// total exceeds `quotaBytes`, least-recently-accessed pages are deleted until the
// total is back under budget.
//
// All operations are best-effort: any IndexedDB/WebCrypto failure rejects, and
// the caller (caching-transcript-fetcher) swallows it into a cache miss / no-op.

import { base64ToBytes, bytesToBase64 } from "../encoding.js";

const DB_NAME = "agent-relay-transcript-cache";
const DB_VERSION = 1;
const PAGES_STORE = "pages";
const META_STORE = "meta";
const KEY_STORE = "cache-keys";
const KEY_RECORD_ID = "transcript-cache-key-v1";
const STATS_RECORD_ID = "stats";
const SCOPE_INDEX = "by-scope";
const LAST_ACCESS_INDEX = "by-last-access";
const KIND_ENCRYPTED = "encrypted";
const KIND_PLAINTEXT = "plaintext";
const DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024;
const KEY_DELIMITER = "\u0000";

export function createTranscriptPageCache({
  indexedDb = defaultIndexedDb(),
  webCrypto = defaultWebCrypto(),
  quotaBytes = DEFAULT_QUOTA_BYTES,
  now = () => Date.now(),
} = {}) {
  let keyPromise = null;

  function isAvailable() {
    // Require a real IDBFactory, not just any object with `open`. `cmp` is a
    // standard IDBFactory method; checking it cheaply rules out the minimal
    // single-store IndexedDB stub used by some unit tests (which would otherwise
    // hang on our multi-store / index / cursor usage) while staying true for real
    // browsers and full fakes like fake-indexeddb.
    return Boolean(
      indexedDb
        && typeof indexedDb.open === "function"
        && typeof indexedDb.cmp === "function"
    );
  }

  function canEncrypt() {
    return Boolean(webCrypto?.subtle && webCrypto?.getRandomValues);
  }

  async function readPage({ scope, threadId, before }) {
    if (!isAvailable() || before == null || !threadId) {
      return null;
    }
    const key = cacheKey(scope, threadId, before);
    const record = await withStores([PAGES_STORE], "readonly", (tx) =>
      wrapRequest(tx.objectStore(PAGES_STORE).get(key))
    );
    if (!record) {
      return null;
    }

    let json;
    if (record.kind === KIND_PLAINTEXT) {
      json = record.json;
    } else {
      const cryptoKey = await getOrCreateKey();
      if (!cryptoKey || !record.ciphertext || !record.iv) {
        return null;
      }
      try {
        const plaintext = await webCrypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64ToBytes(record.iv) },
          cryptoKey,
          base64ToBytes(record.ciphertext)
        );
        json = new TextDecoder().decode(plaintext);
      } catch {
        // Undecryptable (e.g. a key rotation, or a record written by another tab
        // that lost the cross-tab key-generation race) — treat as a cache miss so
        // the page is refetched and rewritten under the current key.
        return null;
      }
    }

    let page;
    try {
      page = JSON.parse(json);
    } catch {
      return null;
    }

    // Refresh recency for LRU; best-effort, must not affect the read result.
    void touchLastAccess(key, now());
    return page;
  }

  async function writePage({ scope, threadId, before, page }) {
    if (!isAvailable() || before == null || !threadId || !page) {
      return;
    }
    const key = cacheKey(scope, threadId, before);
    const json = JSON.stringify(page);
    const bytes = json.length;

    const record = {
      key,
      scope: scope || "default",
      threadId,
      before,
      revision: page.revision ?? null,
      bytes,
      lastAccess: now(),
    };

    const cryptoKey = await getOrCreateKey();
    if (cryptoKey) {
      const iv = webCrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await webCrypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        new TextEncoder().encode(json)
      );
      record.kind = KIND_ENCRYPTED;
      record.iv = bytesToBase64(iv);
      record.ciphertext = bytesToBase64(new Uint8Array(ciphertext));
    } else {
      record.kind = KIND_PLAINTEXT;
      record.json = json;
    }

    await withStores([PAGES_STORE, META_STORE], "readwrite", async (tx) => {
      const pages = tx.objectStore(PAGES_STORE);
      const meta = tx.objectStore(META_STORE);
      const existing = await wrapRequest(pages.get(key));
      const stats = (await wrapRequest(meta.get(STATS_RECORD_ID))) || {
        id: STATS_RECORD_ID,
        totalBytes: 0,
      };

      await wrapRequest(pages.put(record));
      let total = (stats.totalBytes || 0) - (existing?.bytes || 0) + bytes;

      if (total > quotaBytes) {
        total = await evictUntilUnderQuota(pages, total, quotaBytes, key);
      }

      await wrapRequest(meta.put({ id: STATS_RECORD_ID, totalBytes: Math.max(0, total) }));
    });
  }

  async function clearScope(scope) {
    if (!isAvailable() || !scope) {
      return;
    }
    await withStores([PAGES_STORE, META_STORE], "readwrite", async (tx) => {
      const pages = tx.objectStore(PAGES_STORE);
      const meta = tx.objectStore(META_STORE);
      let freed = 0;
      await eachCursor(pages.index(SCOPE_INDEX).openCursor(scope), (cursor) => {
        freed += cursor.value?.bytes || 0;
        cursor.delete();
      });
      const stats = (await wrapRequest(meta.get(STATS_RECORD_ID))) || { totalBytes: 0 };
      await wrapRequest(
        meta.put({ id: STATS_RECORD_ID, totalBytes: Math.max(0, (stats.totalBytes || 0) - freed) })
      );
    });
  }

  async function clearAll() {
    if (!isAvailable()) {
      return;
    }
    await withStores([PAGES_STORE, META_STORE], "readwrite", async (tx) => {
      await wrapRequest(tx.objectStore(PAGES_STORE).clear());
      await wrapRequest(tx.objectStore(META_STORE).put({ id: STATS_RECORD_ID, totalBytes: 0 }));
    });
  }

  async function touchLastAccess(key, accessedAt) {
    try {
      await withStores([PAGES_STORE], "readwrite", async (tx) => {
        const pages = tx.objectStore(PAGES_STORE);
        const record = await wrapRequest(pages.get(key));
        if (record) {
          record.lastAccess = accessedAt;
          await wrapRequest(pages.put(record));
        }
      });
    } catch {
      // Recency refresh is advisory only.
    }
  }

  async function getOrCreateKey() {
    if (!canEncrypt() || !isAvailable()) {
      return null;
    }
    if (keyPromise) {
      return keyPromise;
    }
    keyPromise = (async () => {
      const stored = await withStores([KEY_STORE], "readonly", (tx) =>
        wrapRequest(tx.objectStore(KEY_STORE).get(KEY_RECORD_ID))
      );
      if (stored?.key) {
        return stored.key;
      }
      const key = await webCrypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false, // non-extractable: raw key material never leaves the browser keystore
        ["encrypt", "decrypt"]
      );
      await withStores([KEY_STORE], "readwrite", (tx) =>
        wrapRequest(tx.objectStore(KEY_STORE).put({ id: KEY_RECORD_ID, key }))
      );
      return key;
    })().catch((error) => {
      keyPromise = null;
      throw error;
    });
    return keyPromise;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!indexedDb) {
        reject(new Error("indexedDB is unavailable"));
        return;
      }
      const request = indexedDb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PAGES_STORE)) {
          const pages = database.createObjectStore(PAGES_STORE, { keyPath: "key" });
          pages.createIndex(SCOPE_INDEX, "scope", { unique: false });
          pages.createIndex(LAST_ACCESS_INDEX, "lastAccess", { unique: false });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(KEY_STORE)) {
          database.createObjectStore(KEY_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("failed to open transcript cache database"));
    });
  }

  async function withStores(storeNames, mode, run) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeNames, mode);
      const completion = waitForTransaction(transaction);
      // If run() throws (a request errored) we never reach `await completion`, and
      // the aborting transaction would reject an orphan promise -> unhandled
      // rejection. Attach a no-op catch so the rejection is always handled; the
      // success path still awaits it below for real completion.
      completion.catch(() => {});
      const result = await run(transaction);
      await completion;
      return result;
    } finally {
      database.close();
    }
  }

  return { readPage, writePage, clearScope, clearAll };
}

async function evictUntilUnderQuota(pages, total, quotaBytes, protectKey) {
  let running = total;
  await eachCursor(pages.index(LAST_ACCESS_INDEX).openCursor(), (cursor) => {
    if (running <= quotaBytes) {
      return false; // stop iterating
    }
    const record = cursor.value;
    // Never evict the page we just wrote (it carries the freshest lastAccess and
    // would be last anyway, but guard explicitly).
    if (record?.key !== protectKey) {
      running -= record?.bytes || 0;
      cursor.delete();
    }
    return true;
  });
  return running;
}

function cacheKey(scope, threadId, before) {
  return [scope || "default", threadId, String(before)].join(KEY_DELIMITER);
}

function defaultIndexedDb() {
  return (typeof globalThis !== "undefined" && globalThis.indexedDB) || null;
}

function defaultWebCrypto() {
  return (typeof globalThis !== "undefined" && globalThis.crypto) || null;
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("transcript cache transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("transcript cache transaction failed"));
  });
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("transcript cache request failed"));
  });
}

// Iterate an IDBCursor request. `step(cursor)` may return false to stop early;
// any other return value continues. Resolves when iteration completes.
function eachCursor(request, step) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      let proceed = true;
      try {
        proceed = step(cursor) !== false;
      } catch (error) {
        reject(error);
        return;
      }
      if (proceed) {
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () =>
      reject(request.error || new Error("transcript cache cursor failed"));
  });
}
