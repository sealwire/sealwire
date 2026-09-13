// The relay decides which remote actions need a session claim; the browser has to agree,
// because it picks the payload shape BEFORE sending. A name the relay gates but the client
// does not goes out unclaimed and is refused — the button simply never works, and only on
// the phone. That is what happened to `set_goal`: "Keep going" failed even for the device
// holding control.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIONS_REQUIRING_SESSION_CLAIM } from "./session-claim-actions.js";

const RUST = readFileSync(
  new URL("../../crates/relay-server/src/broker/remote_actions.rs", import.meta.url),
  "utf8"
);

function relayClaimGatedActions() {
  const fn = /fn requires_session_claim\(action: RemoteActionKind\) -> bool \{([\s\S]*?)\n\}/.exec(
    RUST
  );
  assert.ok(fn, "requires_session_claim should still exist in remote_actions.rs");
  const names = [...fn[1].matchAll(/RemoteActionKind::(\w+)/g)].map((match) => match[1]);
  assert.ok(names.length > 0, "requires_session_claim should still list action kinds");
  return new Set(names.map((name) => name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase()));
}

test("the browser gates exactly the actions the relay gates", () => {
  assert.deepEqual(
    [...ACTIONS_REQUIRING_SESSION_CLAIM].sort(),
    [...relayClaimGatedActions()].sort()
  );
});
