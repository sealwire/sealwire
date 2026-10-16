import assert from "node:assert/strict";
import test from "node:test";
import { requireNativeYolo } from "./native-terminal.mjs";

test("native Claude requires explicit YOLO and does not interpret reviewer bypass as consent", () => {
  requireNativeYolo({ permissionMode: "bypassPermissions" });
  for (const permissionMode of [undefined, "default", "acceptEdits", "dontAsk", "reviewer-read-only"]) {
    assert.throws(() => requireNativeYolo({ permissionMode }), /requires Full access \(YOLO\)/);
  }
});

let serial = 0;
async function hooks() {
  const { register } = await import(`./native-mod/hooks/register.js?case=${++serial}`);
  const handlers = new Map();
  const failures = new Map();
  register((name, matcher, callback) => {
    const key = typeof matcher === "object" ? `${name}:${matcher.tool}` : name;
    handlers.set(key, callback || matcher);
    return { catch(handler) { failures.set(key, handler); } };
  });
  const calls = [];
  let response = {};
  let tick;
  const $ = {
    env: { get: async (key) => key === "SEALWIRE_NATIVE_BRIDGE" ? "http://127.0.0.1:1" : "private-token" },
    session: { id: async () => "native-session" },
    clock: { every(ms, callback) { tick = callback; } },
    http: { fetch: async (url, options) => { calls.push({ url, ...JSON.parse(options.body) }); return { status: 200, text: JSON.stringify(response) }; } },
  };
  await handlers.get("session.start")($, {}, async () => ({}));
  calls.length = 0;
  return { $, calls, handlers, failures, tick: () => tick(), answer(value) { response = value; } };
}

test("native input enters only after the common relay admission and uses its prepared text", async () => {
  const h = await hooks();
  const input = { text: "typed", origin: { kind: "composer" }, attachments: [{ type: "image" }] };
  h.answer({ drop: "this thread is under review" });
  let entered;
  const next = async (e) => { entered = e; return { text: e.text }; };
  assert.deepEqual(await h.handlers.get("prompt.submit")(h.$, input, next), { drop: "this thread is under review" });
  assert.equal(entered, undefined);
  h.answer({ allowed: true, text: "prepared workflow prompt" });
  await h.handlers.get("prompt.submit")(h.$, input, next);
  assert.equal(entered.text, "prepared workflow prompt");
  assert.deepEqual(entered.attachments, input.attachments);
  assert.equal(h.calls[0].event.text, "typed");
});

test("third party prompt injection must use Sealwire admission", async () => {
  const h = await hooks();
  const result = await h.handlers.get("prompt.submit")(h.$, { text: "injected", origin: { kind: "plugin", name: "other" } }, () => assert.fail("entered"));
  assert.ok(result.drop);
  assert.equal(h.calls.length, 0);
});

test("session and workflow slash commands cannot escape the managed session", async () => {
  const h = await hooks();
  for (const command of ["review", "model", "resume", "clear", "fork", "plugin", "permissions", "compact"]) {
    const result = await h.handlers.get("command.run")(h.$, { command }, () => assert.fail(command));
    assert.match(result.text, /Sealwire/);
  }
  assert.equal(await h.handlers.get("command.run")(h.$, { command: "theme" }, async () => "theme opened"), "theme opened");
  assert.ok((await h.handlers.get("config.set")(h.$, { key: "permissionMode" }, () => assert.fail("permissions changed"))).deny);
});

test("a model step without an admitted turn sends no provider request", async () => {
  const h = await hooks();
  h.answer({ deny: "No admitted turn" });
  const stream = h.handlers.get("turn.step")(h.$, { turnId: "t", index: 0 }, () => assert.fail("model called"));
  const chunks = [];
  let result;
  while (true) { const item = await stream.next(); if (item.done) { result = item.value; break; } chunks.push(item.value); }
  assert.equal(result.toolUses.length, 0);
  assert.equal(chunks[0].text, "No admitted turn");
});

test("bridge failures refuse input, tool execution, and model steps", async () => {
  const h = await hooks();
  assert.ok(h.failures.get("prompt.submit")(h.$, {}, { called: false }).drop);
  assert.equal(h.failures.get("tool.check")().decision, "deny");
  const failed = h.failures.get("turn.step")(h.$, { turnId: "t", index: 0 });
  const result = await failed.next();
  assert.equal(result.done, true);
  assert.deepEqual(result.value.toolUses, []);
  assert.equal(result.value.usage, null);
});

test("native tool calls without a model-issued id are denied before execution", async () => {
  const h = await hooks();
  h.answer({ allowed: false });
  const result = await h.handlers.get("tool.call")(h.$, { tool: "Bash", command: "touch bypass" }, () => assert.fail("executed"));
  assert.ok(result.deny);
  assert.ok(h.calls[0].url.endsWith("/tool-admission"));
  assert.ok(h.failures.get("tool.call")(h.$, {}, { called: false }).deny);
});

test("native structured questions pass their flat tool arguments to the shared card handler", async () => {
  const h = await hooks();
  const questions = [{ question: "Which option?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }];
  const answers = { "Which option?": "B" };
  h.answer({ result: { questions, answers } });
  const result = await h.handlers.get("tool.call:AskUserQuestion")(h.$, { tool: "AskUserQuestion", tool_use_id: "question-1", questions }, () => assert.fail("native dialog opened"));
  assert.deepEqual(h.calls[0].event, { tool: "AskUserQuestion", tool_use_id: "question-1", input: { questions } });
  assert.deepEqual(result.result, { questions, answers });
});

test("native session approvals retain the CLI's permission update protocol", async () => {
  const h = await hooks();
  const updatedPermissions = [{ type: "addRules", rules: [{ toolName: "Write", ruleContent: "/tmp/outside/**" }], behavior: "allow", destination: "session" }];
  const decision = { behavior: "allow", updatedInput: { file_path: "/tmp/outside/file" }, updatedPermissions };
  h.answer(decision);
  const input = { tool_name: "Write", tool_input: decision.updatedInput, permission_suggestions: updatedPermissions };
  const result = await h.handlers.get("classic.PermissionRequest")(h.$, input, async () => ({}));
  assert.deepEqual(result.decision, decision);
  assert.deepEqual(h.calls[0].event.permission_suggestions, updatedPermissions);
  assert.equal(h.failures.get("classic.PermissionRequest")().decision.behavior, "deny");
});

test("stopping after a subagent starts still aborts the admitted parent turn", async () => {
  const h = await hooks();
  await h.handlers.get("turn.start")(h.$, { turnId: "parent" }, async () => ({}));
  await h.handlers.get("turn.start")(h.$, { turnId: "child", agentId: "subagent" }, async () => ({}));
  let stopped;
  h.$.turn = { abort: async ({ turnId }) => { stopped = turnId; } };
  h.answer([{ kind: "abort" }]);
  await h.tick();
  assert.equal(stopped, "parent");
});
