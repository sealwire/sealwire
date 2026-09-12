import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionOptionsBase, createCwdReporter } from "./session-options.mjs";

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

test("effort reaches the SDK, not just the model catalogue", () => {
  // The worker published every model's supported effort levels and let the
  // relay pick one, then never applied it: only `model` was copied onto the
  // options, so the SDK ran at its own default no matter what was chosen.
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp", model: "claude-opus-5", effort: "medium" },
    defaults,
  );
  assert.equal(opts.effort, "medium");
});

test("an unknown effort is dropped rather than handed to the SDK", () => {
  // The SDK takes a closed set; forwarding junk fails the whole query() rather
  // than degrading to the default, which would take the thread down.
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp", model: "claude-opus-5", effort: "turbo" },
    defaults,
  );
  assert.ok(!("effort" in opts));
});

test("no effort asked for means no effort forced", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", model: "claude-opus-5" }, defaults);
  assert.ok(!("effort" in opts));
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

test("a systemPrompt on the command reaches the SDK options", () => {
  // The Orchestrator's persona travels as `systemPrompt` precisely so it is NOT
  // a turn: it must not appear in the transcript, and it must not provoke the
  // agent into answering its own instructions.
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp", systemPrompt: "You are the Orchestrator." },
    defaults
  );
  // A full replacement, not `{preset:'claude_code', append}`: a secretary that
  // does not write code should not inherit the coding agent's system prompt.
  // And snapshot MUST be false: SDK ≥0.3.267 records a bare-string custom
  // prompt and ignores later persona swaps until compaction.
  assert.deepEqual(opts.systemPrompt, {
    type: "custom",
    prompt: "You are the Orchestrator.",
    snapshot: false,
  });
});

test("relay-managed personas opt out of SDK system-prompt snapshots", () => {
  // REGRESSION (SDK 0.3.267+): a bare string `systemPrompt` is snapshotted by
  // default. The worker rebuilds the query when the persona changes, but a
  // resume of the SAME provider session would keep serving the recorded
  // Orchestrator text until compaction — while the relay believes the persona
  // was replaced or cleared. `snapshot: false` makes every request re-render.
  const withPersona = buildSessionOptionsBase(
    { cwd: "/tmp", systemPrompt: "You are the Orchestrator." },
    defaults
  );
  const cleared = buildSessionOptionsBase({ cwd: "/tmp" }, defaults);
  assert.equal(withPersona.systemPrompt.snapshot, false);
  assert.ok(!("systemPrompt" in cleared), "clearing the persona must omit the field");
});

test("no systemPrompt leaves the SDK default alone", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp" }, defaults);
  assert.ok(!("systemPrompt" in opts));
});

test("a blank systemPrompt is not sent as an empty persona", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", systemPrompt: "   " }, defaults);
  assert.ok(!("systemPrompt" in opts));
});

test("an mcpServers config reaches the SDK, paired with its allowlist", () => {
  // The pairing is the point. `canUseTool` is installed unconditionally and
  // acceptEdits does NOT auto-allow MCP tools, so a toolset attached without an
  // allowlist raises an approval on every call — a secretary asking permission
  // to write a sticky note.
  const opts = buildSessionOptionsBase(
    {
      cwd: "/tmp",
      permissionMode: "acceptEdits",
      mcpServers: { sealwire: { type: "stdio", command: "node", args: ["/x/bridge.mjs"] } },
      allowedTools: ["mcp__sealwire__propose_task"],
    },
    defaults
  );
  assert.equal(opts.mcpServers.sealwire.type, "stdio");
  assert.deepEqual(opts.allowedTools, ["mcp__sealwire__propose_task"]);
});

test("an Orchestrator toolset also DISABLES the built-in coding tools", () => {
  // Observed against a real Claude session: told "you are a secretary, you do not
  // write code or run commands" but handed the default claude_code preset, the
  // model went and ran Bash four times to explore the repo instead of staging a
  // card. The prompt said secretary; the toolbox said coding agent, and the
  // toolbox won. `tools: []` is the SDK's own way to say "built-ins: none".
  const opts = buildSessionOptionsBase(
    {
      cwd: "/tmp",
      tools: [],
      mcpServers: { sealwire: { type: "stdio", command: "node", args: ["/x.mjs"] } },
      allowedTools: ["mcp__sealwire__propose_task"],
    },
    defaults
  );
  assert.deepEqual(opts.tools, [], "an empty array must survive as an empty array");
  assert.deepEqual(opts.mcpServers.sealwire.type, "stdio");
});

test("no toolset means neither option is invented", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp" }, defaults);
  assert.ok(!("mcpServers" in opts));
  assert.ok(!("allowedTools" in opts));
});

test("an empty allowlist is not sent as a total denial", () => {
  // `allowedTools: []` is not "allow nothing" to the SDK, but sending it says
  // something we did not mean. Absent is the honest encoding.
  const opts = buildSessionOptionsBase({ cwd: "/tmp", allowedTools: [] }, defaults);
  assert.ok(!("allowedTools" in opts));
});

test("non-reviewer modes carry no disallowedTools", () => {
  const opts = buildSessionOptionsBase({ cwd: "/tmp", permissionMode: "default" }, defaults);
  assert.ok(!("disallowedTools" in opts));
});

test("cwd observation hooks report PostToolUse and CwdChanged without rewriting tool output", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  assert.ok(opts.hooks?.CwdChanged, "CwdChanged is the move event");
  assert.ok(opts.hooks?.PostToolUse, "PostToolUse.cwd covers a quiet stretch of reads");
  const cwdChanged = await opts.hooks.CwdChanged[0].hooks[0]({ cwd: "/repo/wt" });
  const postTool = await opts.hooks.PostToolUse[0].hooks[0]({
    cwd: "/repo/wt",
    tool_name: "Read",
  });
  assert.deepEqual(
    seen,
    ["/repo/wt"],
    "CwdChanged reports immediately; PostToolUse waits until the tool result is published"
  );
  reporter.flushPostToolCwd();
  assert.deepEqual(
    seen,
    ["/repo/wt", "/repo/wt"],
    "the same cwd must still be reported: recency has to advance after intervening writes"
  );
  assert.deepEqual(cwdChanged, {}, "observe-only: do not replace tool output");
  assert.deepEqual(postTool, {}, "observe-only: do not replace tool output");
});

test("PostToolUse cwd is held until flushPostToolCwd so it outranks the completed write", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await opts.hooks.PostToolUse[0].hooks[0]({
    cwd: "/repo/a",
    tool_name: "Write",
  });
  assert.deepEqual(
    seen,
    [],
    "PostToolUse runs before the SDK publishes the tool result; do not stamp cwd yet"
  );
  reporter.flushPostToolCwd();
  assert.deepEqual(seen, ["/repo/a"]);
});

test("CwdChanged drops a queued PostToolUse cwd so a real move is not overwritten", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await opts.hooks.PostToolUse[0].hooks[0]({ cwd: "/repo/b", tool_name: "Write" });
  await opts.hooks.CwdChanged[0].hooks[0]({ cwd: "/repo/a" });
  reporter.flushPostToolCwd();
  assert.deepEqual(seen, ["/repo/a"]);
});

test("parallel PostToolUse cwds survive a batch of tool results", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await Promise.all([
    opts.hooks.PostToolUse[0].hooks[0]({
      cwd: "/repo/a",
      tool_name: "Write",
      tool_use_id: "tool-1",
    }),
    opts.hooks.PostToolUse[0].hooks[0]({
      cwd: "/repo/a",
      tool_name: "Write",
      tool_use_id: "tool-2",
    }),
  ]);
  assert.deepEqual(seen, []);
  reporter.flushPostToolCwd("tool-1");
  reporter.flushPostToolCwd("tool-2");
  assert.deepEqual(seen, ["/repo/a", "/repo/a"]);
});

test("cwd observation hooks ignore subagent PostToolUse so the parent stays put", async () => {
  const seen = [];
  const reporter = createCwdReporter((cwd) => seen.push(cwd));
  const opts = buildSessionOptionsBase(
    { cwd: "/tmp" },
    { ...defaults, observeCwd: reporter.observeCwd }
  );
  await opts.hooks.PostToolUse[0].hooks[0]({
    cwd: "/repo/subagent-wt",
    tool_name: "Read",
    agent_id: "agent-sub-1",
  });
  await opts.hooks.CwdChanged[0].hooks[0]({ cwd: "/repo/parent-wt" });
  assert.deepEqual(seen, ["/repo/parent-wt"]);
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
