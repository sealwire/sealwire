import { base64ToBytes, bytesToBase64 } from "./encoding.js";

const REMOTE_SECRET_DB_NAME = "agent-relay-secrets";
const REMOTE_SECRET_STORE_NAME = "payload-secrets";
const REMOTE_SECRET_KEY_STORE_NAME = "secret-keys";
const REMOTE_SECRET_KEY_RECORD_ID = "payload-secret-key-v1";

let secretKeyPromise = null;

export async function loadStoredPayloadSecret(relayId) {
  if (!relayId) {
    return null;
  }
  const key = await readOrCreateSecretKey();
  if (!key) {
    return null;
  }

  const record = await withSecretStore(REMOTE_SECRET_STORE_NAME, "readonly", (store) => {
    return wrapRequest(store.get(relayId));
  });
  if (!record?.ciphertext || !record?.iv) {
    return null;
  }

  const plaintext = await getWebCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.iv),
    },
    key,
    base64ToBytes(record.ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

export async function storePayloadSecret(relayId, payloadSecret) {
  if (!relayId || !payloadSecret) {
    throw new Error("relayId and payloadSecret are required");
  }
  const key = await readOrCreateSecretKey();
  if (!key) {
    throw new Error("protected payload secret storage is unavailable");
  }

  const iv = new Uint8Array(12);
  getWebCrypto().getRandomValues(iv);
  const ciphertext = await getWebCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    new TextEncoder().encode(payloadSecret)
  );

  await withSecretStore(REMOTE_SECRET_STORE_NAME, "readwrite", (store) => {
    return wrapRequest(
      store.put({
        id: relayId,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      })
    );
  });
}

export async function deleteStoredPayloadSecret(relayId) {
  if (!relayId || !getIndexedDb()) {
    return;
  }
  await withSecretStore(REMOTE_SECRET_STORE_NAME, "readwrite", (store) => {
    return wrapRequest(store.delete(relayId));
  });
}

export function supportsProtectedPayloadSecretStorage() {
  return Boolean(getWebCrypto()?.subtle && getIndexedDb());
}

async function readOrCreateSecretKey() {
  if (!supportsProtectedPayloadSecretStorage()) {
    return null;
  }

  if (secretKeyPromise) {
    return secretKeyPromise;
  }

  secretKeyPromise = (async () => {
    const stored = await withSecretStore(REMOTE_SECRET_KEY_STORE_NAME, "readonly", (store) => {
      return wrapRequest(store.get(REMOTE_SECRET_KEY_RECORD_ID));
    });
    if (stored?.key) {
      return stored.key;
    }

    const key = await getWebCrypto().subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    await withSecretStore(REMOTE_SECRET_KEY_STORE_NAME, "readwrite", (store) => {
      return wrapRequest(
        store.put({
          id: REMOTE_SECRET_KEY_RECORD_ID,
          key,
        })
      );
    });
    return key;
  })().catch((error) => {
    secretKeyPromise = null;
    throw error;
  });

  return secretKeyPromise;
}

async function withSecretStore(storeName, mode, run) {
  const database = await openSecretDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const completion = waitForTransaction(transaction);
    const result = await run(store);
    await completion;
    return result;
  } finally {
    database.close();
  }
}

function openSecretDatabase() {
  return new Promise((resolve, reject) => {
    const indexedDb = getIndexedDb();
    if (!indexedDb) {
      reject(new Error("indexedDB is unavailable"));
      return;
    }

    const request = indexedDb.open(REMOTE_SECRET_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REMOTE_SECRET_STORE_NAME)) {
        database.createObjectStore(REMOTE_SECRET_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(REMOTE_SECRET_KEY_STORE_NAME)) {
        database.createObjectStore(REMOTE_SECRET_KEY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("failed to open remote secret database"));
  });
}

function getWebCrypto() {
  return globalThis.crypto || window.crypto || null;
}

function getIndexedDb() {
  return globalThis.indexedDB || window.indexedDB || null;
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("remote secret transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("remote secret transaction failed"));
  });
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("remote secret request failed"));
  });
}
