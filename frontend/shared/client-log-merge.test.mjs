import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_LOG_LIMIT,
  mapRelayLogEntries,
  mergeLogEntries,
} from "./client-log-merge.js";

test("mapRelayLogEntries converts server logs (seconds) to {at, text} (ms)", () => {
  const mapped = mapRelayLogEntries([
    { created_at: 1000, kind: "info", message: "hello" },
    { created_at: 1001, kind: "warn", message: "watch out" },
  ]);
  assert.deepEqual(mapped, [
    { at: 1_000_000, text: "[info] hello" },
    { at: 1_001_000, text: "[warn] watch out" },
  ]);
});

test("mapRelayLogEntries tolerates missing fields and non-array input", () => {
  assert.deepEqual(mapRelayLogEntries(null), []);
  assert.deepEqual(mapRelayLogEntries(undefined), []);
  assert.deepEqual(mapRelayLogEntries([{ kind: "info" }]), [
    { at: 0, text: "[info] " },
  ]);
});

test("mergeLogEntries interleaves both sources newest-first", () => {
  const client = [{ at: 30, text: "client-c" }, { at: 10, text: "client-a" }];
  const relay = [{ at: 20, text: "[info] relay-b" }];
  assert.deepEqual(mergeLogEntries(client, relay), [
    { at: 30, text: "client-c" },
    { at: 20, text: "[info] relay-b" },
    { at: 10, text: "client-a" },
  ]);
});

// Regression: the original bug was a relay-log refresh CLOBBERING client lines.
// A client status line (e.g. "Prompt failed: ...") must survive being merged
// with a fresh batch of relay logs and stay on top when it is the newest entry.
test("mergeLogEntries keeps a fresh client line above an incoming relay batch", () => {
  const clientLines = [{ at: 5_000, text: "Prompt failed: blocked" }];
  const relayBatch = mapRelayLogEntries([
    { created_at: 1, kind: "info", message: "Relay booted" },
    { created_at: 2, kind: "info", message: "Updated allowed roots" },
  ]);
  const merged = mergeLogEntries(clientLines, relayBatch);
  assert.equal(merged[0].text, "Prompt failed: blocked");
  assert.ok(
    merged.some((entry) => entry.text === "[info] Relay booted"),
    "relay lines remain present after the merge"
  );
});

test("mergeLogEntries caps the combined list at the limit (newest kept)", () => {
  const client = Array.from({ length: 300 }, (_, i) => ({ at: 10_000 + i, text: `c${i}` }));
  const relay = Array.from({ length: 300 }, (_, i) => ({ at: i, text: `r${i}` }));
  const merged = mergeLogEntries(client, relay);
  assert.equal(merged.length, CLIENT_LOG_LIMIT);
  // The newest 400 are the 300 client lines plus the 100 newest relay lines.
  assert.equal(merged[0].text, "c299");
  assert.ok(merged.every((entry) => entry.at >= 200));
  assert.ok(!merged.some((entry) => entry.text === "r0"));
});

test("mergeLogEntries does not mutate its inputs", () => {
  const client = [{ at: 1, text: "a" }];
  const relay = [{ at: 2, text: "b" }];
  mergeLogEntries(client, relay);
  assert.deepEqual(client, [{ at: 1, text: "a" }]);
  assert.deepEqual(relay, [{ at: 2, text: "b" }]);
});

test("mergeLogEntries handles empty / missing sources", () => {
  assert.deepEqual(mergeLogEntries([], []), []);
  assert.deepEqual(mergeLogEntries(undefined, undefined), []);
  assert.deepEqual(mergeLogEntries([{ at: 1, text: "a" }], undefined), [
    { at: 1, text: "a" },
  ]);
});
