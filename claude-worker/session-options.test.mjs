import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionOptionsBase } from "./session-options.mjs";

const noopCanUseTool = () => ({ behavior: "allow", updatedInput: {} });
const defaults = { canUseTool: noopCanUseTool, defaultSettingSources: ["user"] };

test("default permission mode does not set allowDangerouslySkipPermissions", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "default" }, defaults);
  assert.equal(opts.permissionMode, "default");
  assert.ok(!("allowDangerouslySkipPermissions" in opts));
});

test("acceptEdits does not opt into dangerous skip either", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "acceptEdits" }, defaults);
  assert.equal(opts.permissionMode, "acceptEdits");
  assert.ok(!("allowDangerouslySkipPermissions" in opts));
});

test("bypassPermissions sets allowDangerouslySkipPermissions=true", () => {
  // The SDK refuses to enter bypassPermissions mode unless the host
  // explicitly opts in via this flag. Without it the session boots but
  // every tool call still calls back into canUseTool, defeating YOLO.
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "bypassPermissions" }, defaults);
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
});

test("missing permissionMode falls back to default and stays safe", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp" }, defaults);
  assert.equal(opts.permissionMode, "default");
  assert.ok(!("allowDangerouslySkipPermissions" in opts));
});

test("reviewer-read-only maps to bypassPermissions + a write-tool denylist", () => {
  // A read-only reviewer must inspect without prompts (the review loop is
  // non-interactive) but never edit. It runs bypassPermissions (reads + Bash auto-run)
  // with the file-mutation tools and AskUserQuestion removed from its toolset.
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp", permissionMode: "reviewer-read-only" },
    defaults
  );
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "AskUserQuestion"]) {
    assert.ok(opts.disallowedTools.includes(tool), `${tool} must be disallowed`);
  }
  // Reads + Bash are NOT in the denylist (the reviewer needs to inspect).
  for (const tool of ["Read", "Grep", "Glob", "Bash"]) {
    assert.ok(!opts.disallowedTools.includes(tool), `${tool} must stay available`);
  }
});

test("non-reviewer modes carry no disallowedTools", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "default" }, defaults);
  assert.ok(!("disallowedTools" in opts));
});

test("model and explicit settingSources flow through", () => {
  const opts = buildSessionOptionsBase(
    {
      cwd: "/tmp",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      settingSources: ["project"],
    },
    defaults
  );
  assert.equal(opts.model, "claude-sonnet-4-6");
  assert.deepEqual(opts.settingSources, ["project"]);
  assert.equal(opts.canUseTool, noopCanUseTool);
});
