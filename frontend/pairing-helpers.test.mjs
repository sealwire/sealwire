import test from "node:test";
import assert from "node:assert/strict";

import {
  decidePendingActionBannerState,
  earliestPairingExpiry,
  filterActivePairings,
  formatPendingPairingsBannerLabel,
} from "./shared/pairing-helpers.js";

test("filterActivePairings keeps live requests and drops expired ones", () => {
  const now = 1_000;
  const requests = [
    { pairing_id: "p1", expires_at: 900 },
    { pairing_id: "p2", expires_at: 1_500 },
    { pairing_id: "p3", expires_at: 1_000 },
    { pairing_id: "p4", expires_at: 2_000 },
  ];
  const result = filterActivePairings(requests, now);
  assert.deepEqual(
    result.map((r) => r.pairing_id),
    ["p2", "p4"]
  );
});

test("filterActivePairings keeps entries with no expires_at AND no requested_at (no deadline known)", () => {
  const result = filterActivePairings([{ pairing_id: "p1" }], 9_999_999);
  assert.deepEqual(result, [{ pairing_id: "p1" }]);
});

test("filterActivePairings: missing expires_at falls back to requested_at + 30s (old backend safety net)", () => {
  // Simulates a relay-server build that pre-dates the expires_at field.
  // requested_at=1000, fallback TTL=30 → effective expiry = 1030.
  const legacy = [{ pairing_id: "p1", requested_at: 1_000 }];
  assert.equal(filterActivePairings(legacy, 1_020).length, 1, "still active at +20s");
  assert.equal(filterActivePairings(legacy, 1_030).length, 0, "filtered at +30s (boundary)");
  assert.equal(filterActivePairings(legacy, 1_100).length, 0, "filtered well past fallback expiry");
});

test("earliestPairingExpiry: uses requested_at + 30s fallback when expires_at missing", () => {
  assert.equal(
    earliestPairingExpiry([{ pairing_id: "p1", requested_at: 1_000 }]),
    1_030
  );
  // expires_at, when present, takes precedence over the fallback.
  assert.equal(
    earliestPairingExpiry([
      { pairing_id: "p1", requested_at: 1_000, expires_at: 1_100 },
    ]),
    1_100
  );
});

test("filterActivePairings returns empty array for non-arrays / empties", () => {
  assert.deepEqual(filterActivePairings([], 100), []);
  assert.deepEqual(filterActivePairings(null, 100), []);
  assert.deepEqual(filterActivePairings(undefined, 100), []);
});

test("earliestPairingExpiry returns null on empty input and minimum on populated", () => {
  assert.equal(earliestPairingExpiry([]), null);
  assert.equal(earliestPairingExpiry(null), null);
  assert.equal(
    earliestPairingExpiry([
      { expires_at: 200 },
      { expires_at: 150 },
      { expires_at: 300 },
    ]),
    150
  );
});

test("earliestPairingExpiry ignores entries without expires_at", () => {
  assert.equal(
    earliestPairingExpiry([
      { pairing_id: "p1" },
      { expires_at: 500 },
    ]),
    500
  );
  assert.equal(
    earliestPairingExpiry([{ pairing_id: "p1" }, { pairing_id: "p2" }]),
    null
  );
});

test("formatPendingPairingsBannerLabel: empty input returns empty string", () => {
  assert.equal(formatPendingPairingsBannerLabel([]), "");
  assert.equal(formatPendingPairingsBannerLabel(null), "");
});

test("formatPendingPairingsBannerLabel: single request uses label or shortId fallback", () => {
  assert.equal(
    formatPendingPairingsBannerLabel([{ pairing_id: "p1", label: "iPad" }]),
    'Device "iPad" wants to pair'
  );
  assert.equal(
    formatPendingPairingsBannerLabel(
      [{ pairing_id: "p1", device_id: "device-abcdef" }],
      (value) => `short-${value.slice(0, 4)}`
    ),
    'Device "short-devi" wants to pair'
  );
});

test("formatPendingPairingsBannerLabel: two requests use singular 'device'", () => {
  const label = formatPendingPairingsBannerLabel([
    { pairing_id: "p1", label: "iPad" },
    { pairing_id: "p2", label: "Phone" },
  ]);
  assert.equal(label, 'Device "iPad" wants to pair, and 1 more device');
});

test("decidePendingActionBannerState: approval present → 'approval' (wins over pairing)", () => {
  const result = decidePendingActionBannerState(
    { request_id: "a", summary: "x" },
    [{ pairing_id: "p1", label: "iPad" }]
  );
  assert.equal(result.kind, "approval");
  assert.equal(result.approval.request_id, "a");
});

test("decidePendingActionBannerState: no approval + pending requests → 'pairing' with label", () => {
  const result = decidePendingActionBannerState(null, [
    { pairing_id: "p1", label: "iPad" },
    { pairing_id: "p2", label: "Phone" },
  ]);
  assert.equal(result.kind, "pairing");
  assert.equal(result.count, 2);
  assert.equal(result.label, 'Device "iPad" wants to pair, and 1 more device');
});

test("decidePendingActionBannerState: empty pendingPairings + no approval → 'hidden'", () => {
  assert.equal(decidePendingActionBannerState(null, []).kind, "hidden");
  assert.equal(decidePendingActionBannerState(null, null).kind, "hidden");
});

test("end-to-end: expired pairings filter out, banner decision flips to 'hidden'", () => {
  const requests = [
    { pairing_id: "p1", label: "iPad", expires_at: 1_030 },
  ];
  // Before expiry — at server time 1_020, request still active.
  const before = filterActivePairings(requests, 1_020);
  assert.equal(before.length, 1, "before expiry, request still active");
  assert.equal(decidePendingActionBannerState(null, before).kind, "pairing");

  // After expiry — at server time 1_030+, filterActivePairings drops it,
  // and the banner decision flips to 'hidden' even though state.session
  // would still carry the original requests array.
  const after = filterActivePairings(requests, 1_030);
  assert.equal(after.length, 0, "expires_at == now should be filtered out (boundary)");
  assert.equal(decidePendingActionBannerState(null, after).kind, "hidden");

  const afterPlus = filterActivePairings(requests, 1_500);
  assert.equal(afterPlus.length, 0, "well past expiry, definitely filtered");
  assert.equal(decidePendingActionBannerState(null, afterPlus).kind, "hidden");
});

test("formatPendingPairingsBannerLabel: three+ requests use plural 'devices'", () => {
  const label = formatPendingPairingsBannerLabel([
    { pairing_id: "p1", label: "iPad" },
    { pairing_id: "p2", label: "Phone" },
    { pairing_id: "p3", label: "Laptop" },
  ]);
  assert.equal(label, 'Device "iPad" wants to pair, and 2 more devices');

  const five = formatPendingPairingsBannerLabel([
    { pairing_id: "p1", label: "iPad" },
    { pairing_id: "p2", label: "Phone" },
    { pairing_id: "p3", label: "Laptop" },
    { pairing_id: "p4", label: "Desktop" },
    { pairing_id: "p5", label: "Watch" },
  ]);
  assert.equal(five, 'Device "iPad" wants to pair, and 4 more devices');
});
