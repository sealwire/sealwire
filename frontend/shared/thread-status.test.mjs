import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NON_WORKING_THREAD_STATUSES,
  isWorkingThreadStatus,
  normalizeThreadStatus,
} from "./thread-status.js";
import { statusIsWorking } from "./thread-attention.js";
import { isAgentStatusWorking } from "./review-state.js";
import { threadIsBusyForFork } from "./fork-fields.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_RS = path.resolve(HERE, "../../crates/relay-server/src/state/relay.rs");

test("normalization is case- and whitespace-insensitive", () => {
  assert.equal(normalizeThreadStatus("  NotLoaded "), "notloaded");
  assert.equal(normalizeThreadStatus(null), "");
  assert.equal(normalizeThreadStatus(undefined), "");
});

test("the settled vocabulary is not working; anything else is", () => {
  for (const settled of NON_WORKING_THREAD_STATUSES) {
    assert.equal(isWorkingThreadStatus(settled), false, `${settled} must be settled`);
  }
  for (const working of ["active", "thinking", "running", "waitingOnApproval"]) {
    assert.equal(isWorkingThreadStatus(working), true, `${working} must be working`);
  }
});

// The rule previously lived in four independent copies with four different
// normalizations, which is exactly how Codex's camelCase `notLoaded` ended up
// fixed in one place and still broken in another. Every frontend predicate must
// resolve to the same answer for the same input.
test("every frontend working-status predicate agrees", () => {
  const cases = [
    ...NON_WORKING_THREAD_STATUSES,
    "notLoaded",
    "NotLoaded",
    "  idle  ",
    "IDLE",
    "active",
    "thinking",
  ];

  for (const status of cases) {
    const canonical = isWorkingThreadStatus(status);
    assert.equal(statusIsWorking(status), canonical, `thread-attention: ${status}`);
    assert.equal(isAgentStatusWorking(status), canonical, `review-state: ${status}`);
    assert.equal(
      threadIsBusyForFork({ id: "t", status }, null),
      canonical,
      `fork-fields: ${status}`
    );
  }
});

// The backend is authoritative. This reads the Rust match arm so a value added
// there (or here) without the other fails loudly instead of drifting silently —
// the failure mode that produced the `notLoaded` bug.
test("the settled vocabulary matches the backend match arm", () => {
  const source = fs.readFileSync(RELAY_RS, "utf8");
  const fn = source.slice(source.indexOf("pub(crate) fn thread_status_is_working"));
  const arm = fn.slice(fn.indexOf("matches!("), fn.indexOf(")", fn.indexOf('"unknown"')));
  const backend = [...arm.matchAll(/"([^"]*)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    backend,
    [...NON_WORKING_THREAD_STATUSES].sort(),
    "frontend and backend settled-status vocabularies must match"
  );
});
