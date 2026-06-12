import test from "node:test";
import assert from "node:assert/strict";

import { isSessionIdle, sessionBusyReason } from "./session-settings-panel.js";

const base = {
  active_turn_id: null,
  pending_approvals: [],
  current_status: "idle",
};

test("isSessionIdle allows settings on an idle session", () => {
  assert.equal(isSessionIdle(base), true);
  assert.equal(sessionBusyReason(base), null);
});

test("isSessionIdle blocks while a turn is running or an approval is pending", () => {
  assert.equal(isSessionIdle({ ...base, active_turn_id: "turn-1" }), false);
  assert.equal(
    isSessionIdle({ ...base, pending_approvals: [{ id: "req-1" }] }),
    false
  );
});

test("isSessionIdle blocks on a genuinely-working status", () => {
  assert.equal(isSessionIdle({ ...base, current_status: "active" }), false);
  assert.equal(isSessionIdle({ ...base, current_status: "working" }), false);
  assert.equal(
    sessionBusyReason({ ...base, current_status: "active" }),
    "Settings locked while status is active."
  );
});

// The sibling of the review-gate bug: a saved Codex thread reports `unknown` /
// `completed` (not the literal "idle"), but with no live turn its settings must NOT
// be locked. Mirrors the backend sessions.rs semantic gate.
test("isSessionIdle allows settings on a not-running Codex thread (unknown/completed)", () => {
  for (const status of ["unknown", "completed", "UNKNOWN", "viewing", ""]) {
    assert.equal(
      isSessionIdle({ ...base, current_status: status }),
      true,
      `status \`${status}\` must not lock settings`
    );
    assert.equal(
      sessionBusyReason({ ...base, current_status: status }),
      null,
      `status \`${status}\` must surface no busy reason`
    );
  }
});
