// The relay decides which remote actions travel as signed attempts under a claim; the
// browser has to agree, because it picks the payload shape BEFORE sending. A name the relay
// gates but the client does not goes out unsigned and is dropped — the button simply never
// works, and only on the phone. That is what happened to `set_goal`: "Keep going" failed
// even for the device holding control.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requiresSessionClaim } from "./session-claim-actions.js";

const RUST = readFileSync(
  new URL("../../crates/relay-server/src/broker/remote_actions/request.rs", import.meta.url),
  "utf8"
);

function relayClaimExceptions() {
  const fn = /fn requires_signed_attempt\(action: RemoteActionKind\) -> bool \{([\s\S]*?)\n\}/.exec(
    RUST
  );
  assert.ok(fn, "requires_signed_attempt should still exist in remote_actions/request.rs");
  const names = [...fn[1].matchAll(/RemoteActionKind::(\w+)/g)].map((match) => match[1]);
  assert.ok(fn[1].includes("!matches!"), "new actions must require authentication by default");
  return new Set(names.map((name) => name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase()));
}

test("the browser gates exactly the actions the relay gates", () => {
  const exceptions = relayClaimExceptions();
  assert.deepEqual([...exceptions].sort(), ["claim_challenge", "claim_device"]);
  const kinds = /pub\(in crate::broker\) enum RemoteActionKind \{([\s\S]*?)\n\}/.exec(RUST);
  assert.ok(kinds);
  for (const [, name] of kinds[1].matchAll(/^\s+(\w+),$/gm)) {
    const action = name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
    assert.equal(requiresSessionClaim(action), !exceptions.has(action), action);
  }
  assert.equal(requiresSessionClaim("future_action"), true);
});
