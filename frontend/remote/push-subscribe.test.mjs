import test from "node:test";
import assert from "node:assert/strict";

// push-subscribe.js imports actions.js -> state.js, which touches
// window.localStorage at module-load time. Stub a minimal browser before the
// dynamic import so the pure helpers stay testable under Node.
function installMinimalBrowser({ secureContext = false } = {}) {
  const storage = new Map();
  globalThis.window = {
    isSecureContext: secureContext,
    location: { href: "https://remote.example.test/" },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
}

installMinimalBrowser();

const { urlBase64ToUint8Array, pushSupported, subscriptionToInput } = await import("./push-subscribe.js");

test("urlBase64ToUint8Array decodes a 65-byte uncompressed P-256 key", () => {
  // A real uncompressed P-256 public point (base64url, unpadded): 65 bytes, 0x04 prefix.
  const vapidKey =
    "BMgLU4l-tVY26rhHP0AG0HsQBpTrGrhL-eryvizKLryWHlRJJk1Z4rZS0Mjkm9DOLuZ9CUMC1dvxQ8llGGQ_Q9I";
  const bytes = urlBase64ToUint8Array(vapidKey);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
});

test("pushSupported returns false when push globals are absent", () => {
  // window stub has no PushManager / Notification and isSecureContext=false.
  assert.equal(pushSupported(), false);
});

test("subscriptionToInput shapes endpoint + keys from toJSON()", () => {
  const fakeSub = {
    toJSON() {
      return {
        endpoint: "https://push.example.test/abc",
        expirationTime: null,
        keys: { p256dh: "p256dh-value", auth: "auth-value" },
      };
    },
  };
  assert.deepEqual(subscriptionToInput(fakeSub), {
    endpoint: "https://push.example.test/abc",
    keys: { p256dh: "p256dh-value", auth: "auth-value" },
  });
});
