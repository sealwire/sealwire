import test from "node:test";
import assert from "node:assert/strict";

// `remote/encoding.js` reaches for `window.atob`/`window.btoa`; shim before the
// module graph loads so this stays a plain unit test.
globalThis.window = { atob, btoa };
const { parsePairingPayload } = await import("./remote/crypto.js");

// SECURITY: the pairing payload carries the pairing_secret — the only key sealing
// the pairing handshake, whose envelope ships the device's payload_secret and
// refresh tokens. The broker serves the page this link points at, so a payload in
// the QUERY string lands in the broker's request line and in every proxy/CDN
// access log in front of it, handing the broker a handshake that `private` mode
// promises it cannot read. Fragments are never sent to the server, so the payload
// must ride there — and a link that still uses the query must be refused rather
// than honored, because by then the secret has already been transmitted.

function encodePayload(overrides = {}) {
  const payload = {
    version: 1,
    pairing_id: "pair-abc",
    pairing_secret: "secret-must-never-hit-the-wire",
    broker_url: "wss://broker.example.com",
    pairing_join_ticket: "join-ticket",
    relay_verify_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

test("parsePairingPayload reads the payload out of the URL fragment", () => {
  const encoded = encodePayload();
  const parsed = parsePairingPayload(`https://broker.example.com/#pairing=${encoded}`);

  assert.equal(parsed.pairing_id, "pair-abc");
  assert.equal(parsed.pairing_secret, "secret-must-never-hit-the-wire");
  assert.equal(parsed.pairing_join_ticket, "join-ticket");
});

test("parsePairingPayload refuses a payload passed in the query string", () => {
  const encoded = encodePayload();

  assert.throws(
    () => parsePairingPayload(`https://broker.example.com/?pairing=${encoded}`),
    /fragment/i,
    "a query-string pairing link already leaked its secret to the broker and must be rejected"
  );
});

test("parsePairingPayload still accepts a bare encoded payload", () => {
  const parsed = parsePairingPayload(encodePayload());

  assert.equal(parsed.pairing_id, "pair-abc");
});

test("parsePairingPayload reports the fields a truncated payload is missing", () => {
  const encoded = encodePayload({ pairing_secret: undefined, broker_url: undefined });

  assert.throws(() => parsePairingPayload(`https://x/#pairing=${encoded}`), /pairing_secret/);
});

test("clearPairingQueryFromUrl scrubs a fragment payload from the address bar", async () => {
  const { clearPairingQueryFromUrl } = await import("./remote/crypto.js");
  let replaced = null;
  globalThis.window.location = { href: `https://broker.example.com/#pairing=${encodePayload()}` };
  globalThis.window.history = {
    replaceState: (_state, _title, url) => {
      replaced = String(url);
    },
  };

  clearPairingQueryFromUrl();

  assert.ok(replaced, "history should be rewritten");
  assert.ok(!replaced.includes("pairing="), `secret must be gone; got ${replaced}`);
});

test("clearPairingQueryFromUrl also scrubs a legacy query payload", async () => {
  const { clearPairingQueryFromUrl } = await import("./remote/crypto.js");
  let replaced = null;
  globalThis.window.location = { href: `https://broker.example.com/?pairing=${encodePayload()}` };
  globalThis.window.history = {
    replaceState: (_state, _title, url) => {
      replaced = String(url);
    },
  };

  clearPairingQueryFromUrl();

  assert.ok(replaced, "an already-leaked query link must not be left in history");
  assert.ok(!replaced.includes("pairing="), `secret must be gone; got ${replaced}`);
});

test("clearPairingQueryFromUrl leaves an unrelated url untouched", async () => {
  const { clearPairingQueryFromUrl } = await import("./remote/crypto.js");
  let replaced = null;
  globalThis.window.location = { href: "https://broker.example.com/?tab=threads" };
  globalThis.window.history = {
    replaceState: (_state, _title, url) => {
      replaced = String(url);
    },
  };

  clearPairingQueryFromUrl();

  assert.equal(replaced, null, "no pairing payload means no history rewrite");
});
