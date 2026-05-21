import test from "node:test";
import assert from "node:assert/strict";

import {
  createPermissionHandler,
  resolveApprovalDecision,
} from "./permissions.mjs";

// The Claude Agent SDK's runtime Zod schema requires `updatedInput` on
// every "allow" result even though its .d.ts marks the field optional. If
// it's missing, the SDK fails union validation, the tool call surfaces as
// "Tool permission request failed: ZodError" and the model treats it as a
// retry signal — i.e. approve appears to do nothing. These tests pin the
// shape so we never regress that contract.

function makePending(overrides = {}) {
  return {
    suggestions: overrides.suggestions ?? [],
    toolUseID: overrides.toolUseID ?? "tool-use-1",
    input: overrides.input ?? { command: "echo hi" },
  };
}

test("approve includes updatedInput so SDK Zod schema accepts the result", () => {
  const result = resolveApprovalDecision(makePending(), "approve", "once");

  assert.equal(result.behavior, "allow");
  assert.ok(
    Object.prototype.hasOwnProperty.call(result, "updatedInput"),
    "updatedInput must be present even when not modified"
  );
  assert.deepEqual(result.updatedInput, { command: "echo hi" });
  assert.equal(result.toolUseID, "tool-use-1");
  assert.equal(result.decisionClassification, "user_temporary");
  assert.ok(!("updatedPermissions" in result), "once-scope must not set updatedPermissions");
});

test("approve with session scope attaches suggestions as updatedPermissions", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo hi" }] },
  ];
  const result = resolveApprovalDecision(
    makePending({ suggestions }),
    "approve",
    "session"
  );

  assert.equal(result.behavior, "allow");
  assert.deepEqual(result.updatedInput, { command: "echo hi" });
  assert.deepEqual(result.updatedPermissions, suggestions);
  assert.equal(result.decisionClassification, "user_permanent");
});

test("approve with session scope but no suggestions still has updatedInput", () => {
  const result = resolveApprovalDecision(
    makePending({ suggestions: [] }),
    "approve",
    "session"
  );

  assert.equal(result.behavior, "allow");
  assert.deepEqual(result.updatedInput, { command: "echo hi" });
  assert.ok(!("updatedPermissions" in result));
});

test("approve falls back to empty updatedInput when pending input missing", () => {
  const result = resolveApprovalDecision(
    { suggestions: [], toolUseID: "t", input: undefined },
    "approve",
    "once"
  );

  assert.deepEqual(result.updatedInput, {});
});

test("deny returns deny shape without updatedInput", () => {
  const result = resolveApprovalDecision(makePending(), "deny", "once");

  assert.equal(result.behavior, "deny");
  assert.equal(typeof result.message, "string");
  assert.ok(!("updatedInput" in result));
  assert.equal(result.interrupt, false);
});

test("cancel marks interrupt true", () => {
  const result = resolveApprovalDecision(makePending(), "cancel", "once");

  assert.equal(result.behavior, "deny");
  assert.equal(result.interrupt, true);
});

test("createPermissionHandler stores input so approve can echo it back", async () => {
  const pendingApprovals = new Map();
  let counter = 0;
  const captured = [];

  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const handler = createPermissionHandler(pendingApprovals, () => ++counter);
    const input = { command: "ls -la", description: "list" };
    const promise = handler("Bash", input, {
      toolUseID: "tool-42",
      suggestions: [{ type: "addRules", rules: [] }],
      title: "Bash",
    });

    assert.equal(pendingApprovals.size, 1);
    const [id, pending] = [...pendingApprovals.entries()][0];
    assert.equal(id, "approval:1");
    assert.deepEqual(pending.input, input);
    assert.equal(pending.toolUseID, "tool-42");

    const decision = resolveApprovalDecision(pending, "approve", "once");
    pending.resolve(decision);
    const result = await promise;
    assert.deepEqual(result.updatedInput, input);
  } finally {
    process.stdout.write = originalWrite;
  }
});
