import test from "node:test";
import assert from "node:assert/strict";

import {
  collapseLogRepeats,
  deviceStatusLine,
  expiresInLabel,
  filterLogRows,
  logLevel,
  logRepeatLabel,
  pathScopeLabel,
  relativeTime,
  splitDeviceRecords,
} from "./settings-model.js";

test("logLevel: a failure outranks the notable word in the same line", () => {
  assert.equal(logLevel("Revoke failed: broker unreachable"), "error");
  assert.equal(logLevel("[broker] peer disconnected"), "error");
  assert.equal(logLevel("Device iPhone reconnected via broker"), "notable");
  assert.equal(logLevel("Fetching session list across saved workspaces"), "info");
});

test("collapseLogRepeats folds only consecutive identical lines", () => {
  const rows = collapseLogRepeats([
    { at: 39_000, text: "poll" },
    { at: 26_000, text: "poll" },
    { at: 13_000, text: "poll" },
    { at: 12_000, text: "Session started" },
    { at: 1_000, text: "poll" },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.text, row.count]),
    [
      ["poll", 3],
      ["Session started", 1],
      ["poll", 1],
    ]
  );
  assert.equal(rows[0].at, 39_000, "the folded row keeps the newest time");
  assert.equal(logRepeatLabel(rows[0]), "×3 · every 13s");
  assert.equal(logRepeatLabel(rows[1]), "");
});

test("filterLogRows: notable keeps errors too, errors keeps only errors", () => {
  const rows = collapseLogRepeats([
    { at: 3, text: "poll" },
    { at: 2, text: "Session started" },
    { at: 1, text: "Prompt failed: boom" },
  ]);
  assert.equal(filterLogRows(rows, "all").length, 3);
  assert.deepEqual(filterLogRows(rows, "notable").map((row) => row.text), ["Session started", "Prompt failed: boom"]);
  assert.deepEqual(filterLogRows(rows, "errors").map((row) => row.text), ["Prompt failed: boom"]);
});

test("splitDeviceRecords puts revoked and rejected in history, newest first", () => {
  const { current, past } = splitDeviceRecords([
    { device_id: "a", lifecycle_state: "approved" },
    { device_id: "b", lifecycle_state: "revoked", state_changed_at: 10 },
    { device_id: "c", lifecycle_state: "pending" },
    { device_id: "d", lifecycle_state: "rejected", state_changed_at: 20 },
  ]);
  assert.deepEqual(current.map((record) => record.device_id), ["a", "c"]);
  assert.deepEqual(past.map((record) => record.device_id), ["d", "b"]);
});

test("pathScopeLabel: an empty scope means the relay roots decide", () => {
  assert.equal(pathScopeLabel([]), "All relay roots");
  assert.equal(pathScopeLabel(undefined), "All relay roots");
  assert.equal(pathScopeLabel(["/a", "/b"]), "/a, /b");
});

test("relativeTime / expiresInLabel read epoch seconds", () => {
  const now = 1_000_000 * 1000;
  assert.equal(relativeTime(1_000_000 - 30, now), "just now");
  assert.equal(relativeTime(1_000_000 - 120, now), "2m ago");
  assert.equal(relativeTime(1_000_000 - 3 * 3600, now), "3h ago");
  assert.equal(relativeTime(null, now), "");
  assert.equal(expiresInLabel(1_000_000 + 23 * 3600 + 50, now), "Expires in 23 h");
  assert.equal(expiresInLabel(1_000_000 + 600, now), "Expires in 10 min");
  assert.equal(expiresInLabel(1_000_000 - 1, now), "Expired");
});

test("deviceStatusLine", () => {
  const now = 1_000_000 * 1000;
  assert.equal(deviceStatusLine({ lifecycle_state: "approved", last_seen_at: 1_000_000 - 120 }, now), "Last seen 2m ago");
  assert.equal(deviceStatusLine({ lifecycle_state: "approved" }, now), "Never connected");
  assert.equal(deviceStatusLine({ lifecycle_state: "pending" }, now), "Waiting for approval");
});
