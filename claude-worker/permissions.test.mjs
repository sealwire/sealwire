import test from "node:test";
import assert from "node:assert/strict";

import {
  createPermissionHandler,
  rejectAllPendingApprovals,
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

test("createPermissionHandler routes AskUserQuestion to the ask-user handler, not the approval pool", () => {
  const pendingApprovals = new Map();
  const pendingAskUserQuestions = new Map();
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const handler = createPermissionHandler(
      pendingApprovals,
      () => 1,
      { pendingAskUserQuestions, nextAskUserRequestId: () => 1 }
    );
    handler(
      "AskUserQuestion",
      { questions: [{ question: "Q?", options: [{ label: "A" }] }] },
      { toolUseID: "tool-1" }
    );
    // Approval pool stays empty
    assert.equal(pendingApprovals.size, 0);
    assert.equal(pendingAskUserQuestions.size, 1);
    // Event emitted is the new kind, not approval_requested
    const lines = captured.join("").split("\n").filter(Boolean);
    const types = lines.map((line) => JSON.parse(line).type);
    assert.deepEqual(types, ["ask_user_question_requested"]);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("createPermissionHandler still routes non-AskUserQuestion tools to the approval pool when ask-user handler is configured", () => {
  const pendingApprovals = new Map();
  const pendingAskUserQuestions = new Map();
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const handler = createPermissionHandler(
      pendingApprovals,
      () => 1,
      { pendingAskUserQuestions, nextAskUserRequestId: () => 1 }
    );
    handler("Bash", { command: "ls" }, { toolUseID: "tool-2", title: "Bash" });
    assert.equal(pendingAskUserQuestions.size, 0);
    assert.equal(pendingApprovals.size, 1);
    const lines = captured.join("").split("\n").filter(Boolean);
    assert.equal(JSON.parse(lines[0]).type, "approval_requested");
  } finally {
    process.stdout.write = originalWrite;
  }
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

test("createPermissionHandler stamps approval requests with provider session id", () => {
  const pendingApprovals = new Map();
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const handler = createPermissionHandler(
      pendingApprovals,
      () => 1,
      { getProviderSessionId: () => "session-1" }
    );
    handler("Bash", { command: "pwd" }, { toolUseID: "tool-1", title: "Bash" });
    const event = JSON.parse(captured.join("").split("\n").filter(Boolean)[0]);
    assert.equal(event.provider_session_id, "session-1");
    assert.equal(pendingApprovals.get("approval:1").providerSessionId, "session-1");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("rejectAllPendingApprovals can reject only one provider session", async () => {
  const pendingApprovals = new Map();
  let resolveA;
  let resolveB;
  const promiseA = new Promise((resolve) => {
    resolveA = resolve;
  });
  const promiseB = new Promise((resolve) => {
    resolveB = resolve;
  });
  pendingApprovals.set("a", {
    resolve: resolveA,
    toolUseID: "tool-a",
    providerSessionId: "session-a",
  });
  pendingApprovals.set("b", {
    resolve: resolveB,
    toolUseID: "tool-b",
    providerSessionId: "session-b",
  });

  rejectAllPendingApprovals(
    pendingApprovals,
    (pending) => pending.providerSessionId === "session-a"
  );

  assert.equal(pendingApprovals.has("a"), false);
  assert.equal(pendingApprovals.has("b"), true);
  const resolvedA = await promiseA;
  assert.equal(resolvedA.behavior, "deny");
  assert.equal(resolvedA.toolUseID, "tool-a");
  resolveB({ behavior: "allow" });
  await promiseB;
});
