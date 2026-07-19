import test from "node:test";
import assert from "node:assert/strict";

import {
  INHERIT,
  defaultForkFields,
  forkFieldsToPayload,
  canForkInSession,
  forkIsLossy,
  threadIsBusyForFork,
} from "./fork-fields.js";

const CLAUDE_MODELS = [
  { model: "claude-sonnet-4-6", display_name: "Sonnet", is_default: true },
];

// The relay resolves approval/sandbox/effort from the SOURCE thread's
// remembered settings when the request omits them. Seeding the dialog from the
// currently-active session instead (and then always sending it) silently
// re-permissions the fork: forking a read-only thread from a full-access
// session would hand the branch full access.
test("untouched permission fields inherit from the source thread, not the live session", () => {
  const fields = defaultForkFields({
    thread: { provider: "claude_code", cwd: "/repo" },
    models: CLAUDE_MODELS,
    session: {
      provider: "codex",
      sandbox: "danger-full-access",
      approval_policy: "on-request",
      reasoning_effort: "high",
    },
  });

  assert.equal(fields.sandbox, INHERIT);
  assert.equal(fields.approvalPolicy, INHERIT);
  assert.equal(fields.effort, INHERIT);

  const payload = forkFieldsToPayload(fields);
  assert.equal(payload.sandbox, null);
  assert.equal(payload.approval_policy, null);
  assert.equal(payload.effort, null);
});

test("explicitly chosen permission fields are sent through", () => {
  const fields = {
    ...defaultForkFields({ thread: { provider: "claude_code" }, models: CLAUDE_MODELS }),
    sandbox: "read-only",
    approvalPolicy: "untrusted",
  };

  const payload = forkFieldsToPayload(fields);
  assert.equal(payload.sandbox, "read-only");
  assert.equal(payload.approval_policy, "untrusted");
});

// resolve_provider_model on the relay passes an EXPLICIT model straight to the
// bridge without checking it against the target provider's catalog, so seeding
// the model from a different provider's session sends e.g. a codex model id to
// the Claude worker.
test("model is never seeded from a different provider's session", () => {
  const fields = defaultForkFields({
    thread: { provider: "claude_code" },
    models: [],
    session: { provider: "codex", model: "gpt-5.3-codex" },
  });

  assert.notEqual(fields.model, "gpt-5.3-codex");
  assert.equal(forkFieldsToPayload(fields).model, null, "unknown catalog inherits");
});

test("model is seeded from the target provider's own catalog when available", () => {
  const fields = defaultForkFields({
    thread: { provider: "claude_code" },
    models: CLAUDE_MODELS,
    session: { provider: "codex", model: "gpt-5.3-codex" },
  });

  assert.equal(fields.model, "claude-sonnet-4-6");
  assert.equal(forkFieldsToPayload(fields).model, "claude-sonnet-4-6");
});

test("the fork point rides along with the payload", () => {
  const fields = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    sourceThreadId: "thread-1",
    upToItemId: "assistant:abc",
  };

  const payload = forkFieldsToPayload(fields);
  assert.equal(payload.source_thread_id, "thread-1");
  assert.equal(payload.up_to_item_id, "assistant:abc");
});

test("a blank fork prompt is sent as null so a native fork stays idle", () => {
  const fields = {
    ...defaultForkFields({ thread: { provider: "codex" }, models: [] }),
    initialPrompt: "   ",
  };
  assert.equal(forkFieldsToPayload(fields).initial_prompt, null);
});

test("fork eligibility matches the server guard, including background threads", () => {
  const session = { active_thread_id: "active-1", active_turn_id: "turn-9" };

  assert.equal(
    threadIsBusyForFork({ id: "active-1", status: "active" }, session),
    true,
    "active thread mid-turn"
  );
  // The defect this guards: a BACKGROUND thread running a turn used to show an
  // enabled Fork affordance and only fail on submit.
  assert.equal(
    threadIsBusyForFork({ id: "bg-1", status: "active" }, session),
    true,
    "background thread with a working status"
  );
  assert.equal(threadIsBusyForFork({ id: "bg-2", status: "idle" }, session), false);
  assert.equal(threadIsBusyForFork({ id: "bg-3", status: "completed" }, session), false);
  assert.equal(threadIsBusyForFork({ id: "bg-4", status: "" }, session), false);
});

test("lossy labelling follows provider capability, not a hardcoded pair list", () => {
  assert.equal(forkIsLossy({ sourceProvider: "codex", targetProvider: "claude_code" }), true);
  assert.equal(forkIsLossy({ sourceProvider: "codex", targetProvider: "codex" }), false);
  // codex thread/fork is tip-only, so a mid-thread branch degrades to replay
  assert.equal(
    forkIsLossy({ sourceProvider: "codex", targetProvider: "codex", upToItemId: "x" }),
    true
  );
  // the Claude SDK fork takes upToMessageId and stays native
  assert.equal(
    forkIsLossy({ sourceProvider: "claude_code", targetProvider: "claude_code", upToItemId: "x" }),
    false
  );
});

// The label is a claim about what the server will do. Guessing "native" for
// any same-provider pair was wrong for the fake provider (which has no native
// fork and silently replays), so only providers known to implement
// ProviderBridge::fork_thread may be labelled native.
test("only providers with a real native fork are labelled native", () => {
  assert.equal(forkIsLossy({ sourceProvider: "fake", targetProvider: "fake" }), true);
  assert.equal(forkIsLossy({ sourceProvider: "whatever", targetProvider: "whatever" }), true);
  assert.equal(forkIsLossy({ sourceProvider: "codex", targetProvider: "codex" }), false);
  assert.equal(
    forkIsLossy({ sourceProvider: "claude_code", targetProvider: "claude_code" }),
    false
  );
});

// Forking does not write to the thread you are looking at — it starts a NEW
// session from that thread's history, and the relay accepts any non-busy
// thread regardless of which one is active. Gating the affordance on the
// read-only-ness of the viewed thread (`view_only`) hid fork on every saved
// conversation, leaving it only on the live one.
test("a saved / view-only thread still offers fork", () => {
  assert.equal(canForkInSession({ view_only: true }), true, "saved thread view");
  assert.equal(canForkInSession({ view_only: false }), true, "live session");
  assert.equal(canForkInSession({}), true, "no view_only field");
  assert.equal(canForkInSession(null), false, "nothing to fork from");
});
