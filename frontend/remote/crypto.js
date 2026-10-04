import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";

import { base64ToBytes, base64UrlToBytes, bytesToBase64 } from "./encoding.js";

const REMOTE_DEVICE_KEY_DB_NAME = "agent-relay-crypto";
const REMOTE_DEVICE_KEY_STORE_NAME = "device-keys";
const REMOTE_DEVICE_KEY_RECORD_ID = "remote-device-keypair-v1";
const REMOTE_DEVICE_KEY_KIND_PROTECTED = "protected";
const REMOTE_DEVICE_KEY_KIND_SOFTWARE = "software";

let deviceKeypairPromise = null;

// SECURITY: the payload carries the pairing_secret, the only key sealing the
// pairing handshake (whose envelope ships this device's payload_secret and refresh
// tokens). The broker serves the page this link points at, so a payload in the
// QUERY string lands in the broker's request line — and in any proxy/CDN access
// log in front of it — letting the broker decrypt a handshake that `private` mode
// promises it cannot read. Fragments are never transmitted to the server, so the
// payload is read from there only. A link that still uses the query is refused
// rather than honored: by the time we see it the secret has already gone over the
// wire, so the operator needs a fresh ticket, not a working one.
export function parsePairingPayload(rawInput) {
  let raw = rawInput.trim();

  try {
    const url = new URL(raw);
    if (url.searchParams.has("pairing")) {
      throw new Error(
        "this pairing link carries its secret in the query string, which exposes it to the broker; generate a fresh QR or pairing link from the local relay (the payload belongs in the URL fragment)"
      );
    }
    raw = pairingFromFragment(url.hash) || raw;
  } catch (error) {
    if (error instanceof Error && error.message.includes("fragment")) {
      throw error;
    }
    if (raw.startsWith("#")) {
      raw = pairingFromFragment(raw) || raw;
    } else if (raw.startsWith("pairing=")) {
      raw = raw.slice("pairing=".length);
    }
  }

  const json = new TextDecoder().decode(base64UrlToBytes(raw));
  const payload = JSON.parse(json);

  const missingFields = [];
  if (!payload.pairing_id) {
    missingFields.push("pairing_id");
  }
  if (!payload.pairing_secret) {
    missingFields.push("pairing_secret");
  }
  if (!payload.broker_url) {
    missingFields.push("broker_url");
  }
  if (!payload.pairing_join_ticket) {
    missingFields.push("pairing_join_ticket");
  }
  if (missingFields.length > 0) {
    if (missingFields.length === 1 && missingFields[0] === "pairing_join_ticket") {
      throw new Error(
        "pairing link is outdated and missing pairing_join_ticket; generate a new QR or pairing link from the local relay"
      );
    }
    throw new Error(`pairing payload is missing required fields: ${missingFields.join(", ")}`);
  }

  return payload;
}

function pairingFromFragment(hash) {
  if (!hash) {
    return null;
  }
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.get("pairing");
}

export function clearPairingQueryFromUrl() {
  const url = new URL(window.location.href);
  const hadFragment = Boolean(pairingFromFragment(url.hash));
  // A legacy link may still put it in the query. Scrub both so the secret does not
  // linger in the address bar or in history.
  const hadQuery = url.searchParams.has("pairing");
  if (!hadFragment && !hadQuery) {
    return;
  }
  url.searchParams.delete("pairing");
  if (hadFragment) {
    url.hash = "";
  }
  window.history.replaceState({}, "", url);
}

export async function encryptJson(secret, value) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const key = deriveSecretKey(secret);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);

  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptJson(secret, envelope) {
  const nonce = base64ToBytes(envelope.nonce);
  if (nonce.length !== nacl.secretbox.nonceLength) {
    throw new Error("invalid envelope nonce length");
  }

  const key = deriveSecretKey(secret);
  const plaintext = nacl.secretbox.open(base64ToBytes(envelope.ciphertext), nonce, key);
  if (!plaintext) {
    throw new Error("decryption failed");
  }

  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function ensureDeviceKeypair() {
  if (!deviceKeypairPromise) {
    deviceKeypairPromise = loadOrCreateDeviceKeypair().catch((error) => {
      deviceKeypairPromise = null;
      throw error;
    });
  }
  return deviceKeypairPromise;
}

export function pairingProofMessage(pairingId, deviceId) {
  return `agent-relay:pairing:${pairingId}:${deviceId || ""}`;
}

export async function signPairingProof(pairingId, deviceId, keypair = null) {
  return signDeviceProof(
    pairingProofMessage(pairingId, deviceId),
    keypair || (await ensureDeviceKeypair())
  );
}

export function claimProofMessage(challengeId, challenge, deviceId, peerId) {
  return `agent-relay:claim-challenge:${challengeId}:${challenge}:${deviceId || ""}:${peerId || ""}`;
}

export function claimInitProofMessage(actionId, deviceId, peerId) {
  return `agent-relay:claim-init:${actionId}:${deviceId || ""}:${peerId || ""}`;
}

export async function signClaimInitProof(actionId, deviceId, peerId, keypair = null) {
  return signDeviceProof(
    claimInitProofMessage(actionId, deviceId, peerId),
    keypair || (await ensureDeviceKeypair())
  );
}

export async function signClaimChallengeProof(
  challengeId,
  challenge,
  deviceId,
  peerId,
  keypair = null
) {
  return signDeviceProof(
    claimProofMessage(challengeId, challenge, deviceId, peerId),
    keypair || (await ensureDeviceKeypair())
  );
}

// Must match `client_claim_message` in crates/relay-broker/src/public_control.rs.
// The relay id is in the message on purpose: a signature produced for one
// relay's pairing cannot be replayed to claim against a different relay.
export function clientClaimProofMessage(claimId, nonce, relayId) {
  return `agent-relay:client-claim:${claimId}:${nonce}:${relayId}`;
}

export async function signClientClaim(claimId, nonce, relayId, keypair = null) {
  return signDeviceProof(
    clientClaimProofMessage(claimId, nonce, relayId),
    keypair || (await ensureDeviceKeypair())
  );
}

export async function signCredentialRefresh(challenge, keypair = null) {
  return signDeviceProof(
    `agent-relay:credential-refresh:${challenge.broker_origin}:${challenge.challenge_id}:${challenge.nonce}:${challenge.client_id}:${challenge.broker_room_id || ""}:${challenge.device_id || ""}`,
    keypair || (await ensureDeviceKeypair())
  );
}

export async function signCredentialRefreshInit({ brokerOrigin, clientId, room, deviceId }, keypair = null) {
  const nonce = bytesToBase64(nacl.randomBytes(24));
  const signature = await signDeviceProof(
    `agent-relay:credential-refresh-init:${brokerOrigin}:${clientId}:${room || ""}:${deviceId || ""}:${nonce}`,
    keypair || (await ensureDeviceKeypair())
  );
  return { nonce, signature };
}

async function signDeviceProof(message, keypair) {
  const encodedMessage = new TextEncoder().encode(message);
  const signature = await keypair.sign(encodedMessage);
  return bytesToBase64(signature);
}

function deriveSecretKey(secret) {
  return sha256(new TextEncoder().encode(secret));
}

async function loadOrCreateDeviceKeypair() {
  const storedKeypair = await loadStoredDeviceKeypair();
  if (storedKeypair) {
    return storedKeypair;
  }

  if (supportsProtectedDeviceKeypairStorage()) {
    try {
      return await createProtectedDeviceKeypair();
    } catch (error) {
      if (!supportsSoftwareDeviceKeypairStorage()) {
        throw new Error(
          `protected device key storage could not be initialized: ${error.message}`
        );
      }
    }
  }

  if (supportsSoftwareDeviceKeypairStorage()) {
    return createSoftwareDeviceKeypair();
  }

  throw new Error("device signing key storage is unavailable in this browser context");
}

function supportsProtectedDeviceKeypairStorage() {
  return Boolean(getWebCrypto()?.subtle && getIndexedDb());
}

function supportsSoftwareDeviceKeypairStorage() {
  return Boolean(getIndexedDb());
}

function getWebCrypto() {
  return globalThis.crypto || window.crypto || null;
}

function getIndexedDb() {
  return globalThis.indexedDB || window.indexedDB || null;
}

async function loadStoredDeviceKeypair() {
  const record = await readProtectedDeviceKeypairRecord();
  if (!record) {
    return null;
  }

  if (
    (record.kind === REMOTE_DEVICE_KEY_KIND_PROTECTED || !record.kind) &&
    record.verifyKey &&
    record.privateKey &&
    record.publicKey
  ) {
    return buildProtectedDeviceKeypair(record);
  }

  if (
    record.kind === REMOTE_DEVICE_KEY_KIND_SOFTWARE &&
    record.verifyKey &&
    record.signingSeed
  ) {
    return buildSoftwareDeviceKeypair(record);
  }

  return null;
}

async function createProtectedDeviceKeypair() {
  const webcrypto = getWebCrypto();
  const generated = await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  const verifyKey = bytesToBase64(
    new Uint8Array(await webcrypto.subtle.exportKey("raw", generated.publicKey))
  );
  const record = {
    id: REMOTE_DEVICE_KEY_RECORD_ID,
    kind: REMOTE_DEVICE_KEY_KIND_PROTECTED,
    verifyKey,
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };
  await writeProtectedDeviceKeypairRecord(record);
  return buildProtectedDeviceKeypair(record);
}

function buildProtectedDeviceKeypair(record) {
  const webcrypto = getWebCrypto();
  return {
    verifyKey: record.verifyKey,
    async sign(messageBytes) {
      const signature = await webcrypto.subtle.sign("Ed25519", record.privateKey, messageBytes);
      return new Uint8Array(signature);
    },
  };
}

async function createSoftwareDeviceKeypair() {
  const signingSeed = randomSigningSeed();
  const naclKeypair = nacl.sign.keyPair.fromSeed(signingSeed);
  const record = {
    id: REMOTE_DEVICE_KEY_RECORD_ID,
    kind: REMOTE_DEVICE_KEY_KIND_SOFTWARE,
    verifyKey: bytesToBase64(naclKeypair.publicKey),
    signingSeed: bytesToBase64(signingSeed),
  };
  await writeProtectedDeviceKeypairRecord(record);
  return buildSoftwareDeviceKeypair(record);
}

function buildSoftwareDeviceKeypair(record) {
  const signingSeed = base64ToBytes(record.signingSeed);
  const naclKeypair = nacl.sign.keyPair.fromSeed(signingSeed);
  return {
    verifyKey: record.verifyKey,
    async sign(messageBytes) {
      return nacl.sign.detached(messageBytes, naclKeypair.secretKey);
    },
  };
}

function randomSigningSeed() {
  const webcrypto = getWebCrypto();
  if (webcrypto?.getRandomValues) {
    const seed = new Uint8Array(nacl.sign.seedLength);
    webcrypto.getRandomValues(seed);
    return seed;
  }

  return nacl.randomBytes(nacl.sign.seedLength);
}

async function readProtectedDeviceKeypairRecord() {
  return withProtectedKeyStore("readonly", (store) => {
    const request = store.get(REMOTE_DEVICE_KEY_RECORD_ID);
    return wrapRequest(request);
  });
}

async function writeProtectedDeviceKeypairRecord(record) {
  return withProtectedKeyStore("readwrite", (store) => {
    const request = store.put(record);
    return wrapRequest(request);
  });
}

async function withProtectedKeyStore(mode, run) {
  const database = await openProtectedKeyDatabase();
  try {
    const transaction = database.transaction(REMOTE_DEVICE_KEY_STORE_NAME, mode);
    const store = transaction.objectStore(REMOTE_DEVICE_KEY_STORE_NAME);
    const completion = waitForTransaction(transaction);
    const result = await run(store);
    await completion;
    return result;
  } finally {
    database.close();
  }
}

function openProtectedKeyDatabase() {
  return new Promise((resolve, reject) => {
    const request = getIndexedDb().open(REMOTE_DEVICE_KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REMOTE_DEVICE_KEY_STORE_NAME)) {
        database.createObjectStore(REMOTE_DEVICE_KEY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("failed to open device key database"));
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("device key transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("device key transaction failed"));
  });
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("device key storage request failed"));
  });
}
