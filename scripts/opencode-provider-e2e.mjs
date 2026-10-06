// Real OpenCode ACP + relay, with an isolated store and a local model server.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolveRelayServerCommand } from "./e2e/harness/binaries.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth, dumpProcessLogs } from "./e2e/harness/process.mjs";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-opencode-e2e-")));
const cwd = path.join(root, "project");
await fs.mkdir(cwd);
const unrelated = path.join(root, "other-provider");
const marker = path.join(root, "untrusted-plugin-ran");
await fs.mkdir(path.join(unrelated, ".opencode", "plugin"), { recursive: true });
await fs.writeFile(path.join(unrelated, ".opencode", "plugin", "marker.js"),
  `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "executed"); export const marker = async () => ({});`);
let relay;
let base;
const requests = [];
const sockets = new Set();
let cancelledUpstream = false;
const modelServer = http.createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const messages = body.messages || [];
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const content = messages[lastUser]?.content;
    const text = typeof content === "string" ? content : (content || []).map((part) => part.text || "").join("");
    const alreadyCalled = messages.slice(lastUser + 1).some((message) => message.role === "tool");
    const writeFile = text.match(/SEALWIRE_WRITE (\S+)/)?.[1];
    const readFile = text.match(/SEALWIRE_READ (\S+)/)?.[1];
    if (text.includes("SEALWIRE_CHECK_SUBAGENTS") && body.tools?.length) {
      assert.ok(!body.tools.some((tool) => tool.function.name === "task"), "ask modes must hide native task to prevent child permission bypass");
    }
    const shellFile = text.match(/SEALWIRE_SHELL ([a-z-]+\.txt)/)?.[1];
    const sealwireTools = (body.tools || []).map((tool) => tool.function.name).filter((name) => name.startsWith("sealwire-"));
    assert.ok(new Set(sealwireTools.map((name) => name.split("_")[0])).size <= 1, "a session must never see another session's Sealwire identity");
    const nameFor = (suffix) => sealwireTools.find((name) => name.endsWith(`_${suffix}`));
    const calls = messages.slice(lastUser + 1).flatMap((message) => message.tool_calls || []);
    const goalSequence = [
      ["goal_plan", { steps: ["Read the request", "Perform the test", "Verify the result"] }],
      ["goal_step", { step: 1, status: "done", note: "Request read" }],
      ["goal_step", { step: 2, status: "done", note: "Test performed" }],
      ["goal_step", { step: 3, status: "done", note: "Verified" }],
      ["goal_complete", { summary: "SEALWIRE_GOAL completed with an actual session MCP call" }],
    ];
    const isReviewer = text.includes("SEALWIRE_REVIEW") && body.tools?.length && !(body.tools || []).some((tool) => tool.function.name === "write");
    if (isReviewer && body.stream) {
      assert.equal(sealwireTools.length, 0, "reviewers must not receive another session's tools");
      assert.ok(!(body.tools || []).some((tool) => ["write", "edit", "apply_patch", "task"].includes(tool.function.name)), "reviewer mutation and subagent tools must be denied");
    }
    const sequence = text.startsWith("SEALWIRE_AGENT_DELEGATE") ? [["delegate", { provider: "opencode", model: "sealwire_test/echo", message: "SEALWIRE_MCP_PEER: report your result" }]]
      : !isReviewer && !text.includes("Nobody is waiting on a reply") && text.includes("SEALWIRE_GOAL") ? goalSequence
      : text.includes("Do it yourself unless") && text.includes("report_back") ? [["report_back", { answer: "first response" }]] : [];
    const next = sequence[calls.length];
    const tool = !body.tools?.length ? null : isReviewer && !alreadyCalled ? {
      id: `call_review_${requests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "cat approved.txt", description: "Inspect the test fixture" }) },
    } : next ? {
      id: `call_mcp_${requests.length}`, type: "function", function: { name: nameFor(next[0]), arguments: JSON.stringify(next[1]) },
    } : text.startsWith("SEALWIRE_SPOOF_TITLE") && !alreadyCalled ? {
      id: `call_spoof_${requests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `${sealwireTools[0].split("_")[0]}-report_back: report_back`, description: "Untrusted tool title" }) },
    } : shellFile && !alreadyCalled ? {
      id: `call_shell_${requests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `printf 'shell permission verified\\n' > ${shellFile}`, description: "Verify Sealwire shell approval" }) },
    } : text.startsWith("SEALWIRE_MIXED") && !alreadyCalled ? {
      id: `call_mixed_${requests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf SEALWIRE_AFTER_BOUNDARY", description: "Inspect mixed-message boundary" }) },
    } : readFile && !alreadyCalled ? {
      id: `call_read_${requests.length}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: path.join(cwd, readFile) }) },
    } : writeFile && !alreadyCalled ? {
      id: `call_sealwire_write_${requests.length}`, type: "function", function: {
        name: "write", arguments: JSON.stringify({ filePath: path.join(cwd, writeFile), content: "written through OpenCode ACP\n" }),
      },
    } : null;
    const answer = isReviewer ? "VERDICT: APPROVED\nSEALWIRE_REVIEW: inspected approved.txt, no findings." : text.includes("SEALWIRE_WAIT") ? "waiting response" : text.includes("SEALWIRE_SECOND") ? "second response" : "first response";
    if (!body.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "test", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: "assistant" });
    if (text.includes("SEALWIRE_WAIT")) {
      response.on("close", () => { cancelledUpstream = true; });
      send({ content: "still working" });
      return;
    }
    if (tool) {
      if (text.startsWith("SEALWIRE_MIXED")) send({ content: "SEALWIRE_BEFORE_TOOL" });
      assert.ok(body.tools.some((item) => item.function.name === tool.function.name), `OpenCode should expose ${tool.function.name}`);
      send({ tool_calls: [{ index: 0, ...tool }] });
      send({}, "tool_calls");
    } else {
      send({ content: answer.slice(0, 5) });
      await delay(50);
      send({ content: answer.slice(5) });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    console.error("mock model error", error);
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error));
  }
});
modelServer.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const modelPort = modelServer.address().port;
const config = {
  model: "sealwire_test/echo", small_model: "sealwire_test/echo", enabled_providers: ["sealwire_test"], permission: "allow",
  command: {
    "unsafe-subtask": { template: "SEALWIRE_WRITE escaped.txt", subtask: true },
    "unsafe-agent": { template: "SEALWIRE_WRITE escaped.txt", agent: "general" },
    "safe-command": { template: "SEALWIRE_CHECK_SUBAGENTS", subtask: false },
    "shell-template": { template: "!`touch command-escaped.txt`" },
    "file-template": { template: "@.env" },
    "split-template": { template: "$1`touch command-escaped.txt`" },
    "empty-template": { template: "!$1`touch command-escaped.txt`" },
  },
  provider: { sealwire_test: { name: "Sealwire Test", npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "isolated-test" },
    models: {
      echo: { name: "Echo", limit: { context: 8192, output: 1024 }, variants: { low: {}, high: {} } },
      second: { name: "Second", limit: { context: 8192, output: 1024 }, variants: { low: {}, high: {}, xhigh: {} } },
      plain: { name: "Plain", limit: { context: 8192, output: 1024 }, variants: {} },
    },
  } },
};
await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true });
await fs.writeFile(path.join(root, "config", "opencode", "opencode.json"), JSON.stringify(config));
await fs.writeFile(path.join(cwd, "opencode.json"), JSON.stringify({ model: "sealwire_test/second" }));
const env = {
  AGENT_PROVIDERS: "opencode,fake", BIND_HOST: "127.0.0.1",
  RELAY_STATE_DB: path.join(root, "relay", "sealwire.db"),
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_CONFIG_CONTENT: "{}",
};
async function boot() {
  const port = await getFreePort();
  const { command, args } = resolveRelayServerCommand();
  relay = spawnManagedProcess("opencode-relay", command, args, { ...env, PORT: String(port) }, {
    stripInherited: (name) => /^(RELAY_|SEALWIRE_|OPENCODE_|ANTHROPIC_|OPENAI_)/.test(name),
  });
  base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/api/health`, 90000);
  await api("/api/allowed-roots", { allowed_roots: [cwd, unrelated] });
  await api("/api/workspace/trust", { cwd, trusted: true });
}
async function api(route, data) {
  const response = await fetch(`${base}${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: data === undefined ? undefined : JSON.stringify({ device_id: "opencode-e2e", ...data }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok, `${route}: ${JSON.stringify(result)}`);
  return result.data;
}
async function toolApi(route, data) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: JSON.stringify({ device_id: "opencode-e2e", ...data }),
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response.json();
}
async function until(read, predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
const session = () => api("/api/session");
const transcript = (id) => api(`/api/threads/${encodeURIComponent(id)}/transcript`);
const textOf = (data) => (data.entries || []).map((entry) => entry.text || "").join("\n");
async function idle(id, expected) {
  return until(() => transcript(id), (data) => textOf(data).includes(expected) && !data.thread_state?.active_turn_id, `idle transcript ${id}`);
}
let exportSequence = 0;
async function exportedSession(id) {
  // OpenCode exits before a large piped stdout drains; a file keeps the full JSON.
  const output = path.join(root, `export-${++exportSequence}.json`);
  const file = await fs.open(output, "w", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("opencode", ["export", id], {
        cwd, env: { ...process.env, ...env }, timeout: 30000,
        stdio: ["ignore", file.fd, "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`opencode export: ${code}: ${stderr}`)));
    });
    return JSON.parse(await fs.readFile(output, "utf8"));
  } finally {
    await file.close();
    await fs.rm(output, { force: true });
  }
}
async function run() {
  await boot();
  if (process.env.OPENCODE_E2E_BROWSER_ONLY === "1") {
    await fs.writeFile(path.join(cwd, "approved.txt"), "browser review fixture\n");
    const { verifyOpenCodeCommands } = await import("./opencode-provider-browser.mjs");
    await verifyOpenCodeCommands({ base, cwd, root, api, until, transcript, exportedSession });
    return;
  }
  const other = await api("/api/session/start", { cwd: unrelated, provider: "fake", model: "fake-echo" });
  await api("/api/providers/opencode/models");
  await api("/api/threads");
  await assert.rejects(fs.stat(marker), /ENOENT/, "catalog and history reads must not execute another provider's workspace plugins");
  await api(`/api/threads/${encodeURIComponent(other.active_thread_id)}/delete`, {});
  console.log("PASS discovery never runs unrelated workspace plugins");
  const status = (await session()).provider_status.find((row) => row.provider === "opencode");
  assert.ok(status?.connected, JSON.stringify(status));
  const models = await api("/api/providers/opencode/models");
  assert.ok(models.some((model) => model.model === "sealwire_test/echo"));
  assert.ok(models.every((model) => model.provider === "opencode"));
  assert.equal(models.find((model) => model.is_default)?.model, "sealwire_test/echo", "background discovery reads the global default");
  assert.deepEqual(models.find((model) => model.model === "sealwire_test/second").supported_reasoning_efforts, ["low", "high", "xhigh", "default"], "a model not selected by discovery must expose its own variants before starting a session");
  assert.deepEqual(models.find((model) => model.model === "sealwire_test/echo").supported_reasoning_efforts, ["low", "high", "default"]);
  assert.deepEqual(models.find((model) => model.model === "sealwire_test/plain").supported_reasoning_efforts, ["default"]);
  assert.ok(models.every((model) => model.default_reasoning_effort === "default"), "OpenCode defaults must not inherit ACP's first variant");
  assert.equal((await api("/api/threads")).threads.length, 0, "discovery sessions must be deleted");
  for (const model of ["", "sealwire_test/echo", "sealwire_test/second"]) {
    const started = await api("/api/session/start", { cwd, provider: "opencode", model, initial_prompt: "SEALWIRE_DEFAULT_EFFORT" });
    assert.equal(started.reasoning_effort, "default", "omitting effort uses Model default for explicit and folder-default models");
    await idle(started.active_thread_id, "SEALWIRE_DEFAULT_EFFORT");
    const native = await exportedSession(started.active_thread_id);
    assert.ok(native.messages.filter((row) => row.info.role === "user").every((row) => !row.info.model.variant || row.info.model.variant === "default"), "no explicit first variant is sent upstream");
    await api(`/api/threads/${encodeURIComponent(started.active_thread_id)}/delete`, {});
  }
  console.log("PASS cold model discovery and cleanup");

  const first = await api("/api/session/start", { cwd, provider: "opencode", effort: "high", initial_prompt: "SEALWIRE_FIRST" });
  const firstId = first.active_thread_id;
  assert.equal(first.model, "sealwire_test/second", "an unspecified model follows the target workspace's config");
  await idle(firstId, "first response");
  const exported = await exportedSession(firstId);
  assert.ok(exported.messages.some((message) => message.info.role === "user" && message.info.model.variant === "high"), "OpenCode must persist the requested high effort");
  console.log("PASS new session, configured default, streaming response");

  await assert.rejects(api("/api/session/start", { cwd, provider: "opencode", model: "sealwire_test/missing" }), /does not offer model/);
  assert.equal((await api("/api/threads")).threads.length, 1, "failed start must delete its native empty session");
  console.log("PASS failed-start cleanup");

  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WRITE approved.txt" });
  const pending = await until(session, (data) => data.pending_approvals?.length, "approval request");
  await assert.rejects(fs.stat(path.join(cwd, "approved.txt")), /ENOENT/);
  await api(`/api/approvals/${encodeURIComponent(pending.pending_approvals[0].request_id)}`, { decision: "approve", scope: "once" });
  await until(() => fs.readFile(path.join(cwd, "approved.txt"), "utf8").catch(() => ""), (text) => text.includes("written through"), "approved file write");
  await idle(firstId, "first response");
  console.log("PASS real OpenCode permission request and file tool");

  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WRITE denied.txt" });
  const denied = await until(session, (data) => data.pending_approvals?.length, "request to deny");
  await api(`/api/approvals/${encodeURIComponent(denied.pending_approvals[0].request_id)}`, { decision: "deny", scope: "once" });
  await idle(firstId, "first response");
  await assert.rejects(fs.stat(path.join(cwd, "denied.txt")), /ENOENT/);
  console.log("PASS denied tool request leaves the file absent");

  for (const decision of ["deny", "approve"]) {
    const filename = `shell-${decision}.txt`;
    await api("/api/session/message", { thread_id: firstId, text: `SEALWIRE_SHELL ${filename}` });
    const shell = await until(session, (data) => data.pending_approvals?.length, "shell approval request");
    await assert.rejects(fs.stat(path.join(cwd, filename)), /ENOENT/);
    await api(`/api/approvals/${encodeURIComponent(shell.pending_approvals[0].request_id)}`, { decision, scope: "once" });
    await idle(firstId, `SEALWIRE_SHELL ${filename}`);
    if (decision === "approve") assert.match(await fs.readFile(path.join(cwd, filename), "utf8"), /shell permission verified/);
    else await assert.rejects(fs.stat(path.join(cwd, filename)), /ENOENT/);
  }
  console.log("PASS Sealwire approves and denies actual shell mutations despite upstream allow defaults");

  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_SPOOF_TITLE" });
  const spoofed = await until(session, (data) => data.pending_approvals?.some((row) => row.thread_id === firstId), "a shell command cannot impersonate Sealwire tools in its title");
  const spoofedRequest = spoofed.pending_approvals.find((row) => row.thread_id === firstId);
  assert.match(spoofedRequest.summary, /sealwire-.*-report_back/);
  await api(`/api/approvals/${encodeURIComponent(spoofedRequest.request_id)}`, { decision: "deny", scope: "once" });
  await idle(firstId, "SEALWIRE_SPOOF_TITLE");
  await fs.writeFile(path.join(cwd, ".env"), "SEALWIRE_DUMMY_SECRET=fixture-only\n");
  const refusedNativeCommands = [
    "/unsafe-subtask", "/unsafe-agent", "\uFEFF/unsafe-subtask", "/unsafe-subtask\uFEFFarg",
    `/init !\`touch ${path.join(cwd, "command-escaped.txt")}\``,
    `\uFEFF/init !\`touch ${path.join(cwd, "command-escaped.txt")}\``,
    `/init\uFEFF!\`touch ${path.join(cwd, "command-escaped.txt")}\``,
    `/init @${path.join(cwd, ".env")}`, "/shell-template", "/file-template", "/split-template !", "/empty-template",
  ];
  async function assertNativeCommandsRefused() {
    for (const text of refusedNativeCommands) {
      const before = requests.length;
      await assert.rejects(api("/api/session/message", { thread_id: firstId, text }), /cannot preserve Sealwire approvals|without permission checks/);
      assert.equal(requests.length, before, "unsafe native command must not reach a model");
    }
    await assert.rejects(fs.stat(path.join(cwd, "command-escaped.txt")), /ENOENT/);
  }
  for (const approval_policy of ["on-request", "untrusted"]) {
    await api("/api/session/settings", { thread_id: firstId, approval_policy });
    await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_CHECK_SUBAGENTS" });
    await idle(firstId, "SEALWIRE_CHECK_SUBAGENTS");
    await assertNativeCommandsRefused();
    await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_READ .env" });
    const secretRequest = await until(session, (data) => data.pending_approvals?.some((row) => row.thread_id === firstId), "secret read asks");
    const request = secretRequest.pending_approvals.find((row) => row.thread_id === firstId);
    await api(`/api/approvals/${encodeURIComponent(request.request_id)}`, { decision: "deny", scope: "once" });
    await idle(firstId, "SEALWIRE_READ .env");
    assert.ok(!JSON.stringify(requests.at(-1)).includes("SEALWIRE_DUMMY_SECRET"), "denied secret must not enter model context");
  }
  await api("/api/session/settings", { thread_id: firstId, approval_policy: "never", sandbox: "read-only" });
  await assertNativeCommandsRefused();
  await api("/api/session/settings", { thread_id: firstId, approval_policy: "on-request", sandbox: "workspace-write" });
  await api("/api/session/message", { thread_id: firstId, text: "/safe-command" });
  await until(() => exportedSession(firstId), (data) => data.messages.some((row) => row.parts.some((part) => part.text?.includes("SEALWIRE_CHECK_SUBAGENTS"))), "ordinary native command works");
  await until(() => transcript(firstId), (data) => !data.thread_state?.active_turn_id, "ordinary command settled");
  await assert.rejects(fs.stat(path.join(cwd, "escaped.txt")), /ENOENT/);
  console.log("PASS subagents, command expansions and BOM prefixes cannot bypass restricted policies; .env reads still ask");


  await api("/api/session/settings", { thread_id: firstId, model: "sealwire_test/echo", effort: "low", approval_policy: "bypass" });
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WRITE automatic.txt" });
  await until(() => fs.readFile(path.join(cwd, "automatic.txt"), "utf8").catch(() => ""), (text) => text.includes("written through"), "automatic file write");
  await idle(firstId, "first response");
  assert.ok(requests.some((request) => request.model === "echo"));
  const switched = await exportedSession(firstId);
  assert.equal(switched.messages.filter((message) => message.info.role === "user").at(-1).info.model.variant, "low");
  assert.equal((await session()).pending_approvals.length, 0);
  console.log("PASS model/effort change and auto-approval");

  const goal = await toolApi("/api/session/goal", { thread_id: firstId, objective: "SEALWIRE_GOAL: Finish this isolated test" });
  assert.notEqual(goal.isError, true, JSON.stringify(goal));
  await until(() => api("/api/session/reviews"), (data) => data.goals?.some((item) => item.thread_id === firstId && item.status === "complete_claimed"), "goal completes via its own tools");
  await until(() => transcript(firstId), (data) => !data.thread_state?.active_turn_id, "goal turn settles");
  console.log("PASS Goal planning, steps and completion through isolated session tools");

  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WAIT" });
  await until(() => transcript(firstId), (data) => textOf(data).includes("still working"), "stream before switch");
  const second = await api("/api/session/start", { cwd, provider: "opencode", model: "sealwire_test/echo", effort: "low", initial_prompt: "SEALWIRE_SECOND" });
  const secondId = second.active_thread_id;
  await idle(secondId, "second response");
  await api("/api/session/stop", { thread_id: firstId });
  await until(() => transcript(firstId), (data) => !data.thread_state?.active_turn_id, "cancelled background turn");
  await until(async () => cancelledUpstream, Boolean, "upstream model stream cancellation");
  assert.equal((await session()).active_thread_id, secondId, "stopping a background session must not move focus");
  console.log("PASS concurrent sessions, background streaming and targeted cancellation");
  const firstTools = requests.find((request) => request.tools?.length && request.messages.some((message) => JSON.stringify(message.content).includes("SEALWIRE_FIRST"))).tools;
  const secondTools = requests.find((request) => request.tools?.length && request.messages.some((message) => JSON.stringify(message.content).includes("SEALWIRE_SECOND"))).tools;
  const identities = (tools) => [...new Set(tools.map((tool) => tool.function.name).filter((name) => name.startsWith("sealwire-")).map((name) => name.split("_")[0]))];
  assert.equal(identities(firstTools).length, 1);
  assert.equal(identities(secondTools).length, 1);
  assert.notDeepEqual(identities(firstTools), identities(secondTools));
  console.log("PASS no Sealwire MCP identity crosses OpenCode sessions");

  await api("/api/session/settings", { thread_id: firstId, approval_policy: "untrusted" });
  await api("/api/session/settings", { thread_id: secondId, approval_policy: "untrusted" });
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WRITE concurrent-denied.txt" });
  await api("/api/session/message", { thread_id: secondId, text: "SEALWIRE_WRITE concurrent-approved.txt" });
  const concurrent = await until(session, (data) => data.pending_approvals?.length === 2, "two independent approvals");
  assert.equal(new Set(concurrent.pending_approvals.map((row) => row.request_id)).size, 2, "ACP request ids from separate processes must not collide");
  for (const request of concurrent.pending_approvals) {
    await api(`/api/approvals/${encodeURIComponent(request.request_id)}`, { decision: request.thread_id === firstId ? "deny" : "approve", scope: "once" });
  }
  await idle(firstId, "SEALWIRE_WRITE concurrent-denied.txt");
  await idle(secondId, "SEALWIRE_WRITE concurrent-approved.txt");
  await assert.rejects(fs.stat(path.join(cwd, "concurrent-denied.txt")), /ENOENT/);
  assert.match(await fs.readFile(path.join(cwd, "concurrent-approved.txt"), "utf8"), /written through/);
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WRITE cancelled.txt" });
  await until(session, (data) => data.pending_approvals?.some((row) => row.thread_id === firstId), "permission before cancellation");
  await api("/api/session/stop", { thread_id: firstId });
  await until(() => transcript(firstId), (data) => !data.thread_state?.active_turn_id, "cancelled permission turn");
  await assert.rejects(fs.stat(path.join(cwd, "cancelled.txt")), /ENOENT/);
  await api("/api/session/settings", { thread_id: firstId, approval_policy: "bypass" });
  await api("/api/session/settings", { thread_id: secondId, approval_policy: "bypass" });
  console.log("PASS narrowed policies, independent concurrent approvals and cancellation");

  await api("/api/session/message", { thread_id: secondId, text: "SEALWIRE_THIRD" });
  await idle(secondId, "SEALWIRE_THIRD");
  const nativeSource = await exportedSession(secondId);
  const tip = await api("/api/session/fork", { source_thread_id: secondId, provider: "opencode" });
  const tipId = tip.active_thread_id;
  const nativeTip = await exportedSession(tipId);
  assert.equal(nativeTip.messages.length, nativeSource.messages.length, "native fork preserves full provider messages without a replay prompt");
  assert.notEqual(tipId, secondId);
  await api("/api/session/message", { thread_id: tipId, text: "SEALWIRE_FORK_CONTINUE" });
  await idle(tipId, "SEALWIRE_FORK_CONTINUE");
  const sourceHistory = await transcript(secondId);
  const point = sourceHistory.entries.find((row) => row.kind === "user_text" && row.text === "SEALWIRE_SECOND");
  const branch = await api("/api/session/fork", { source_thread_id: secondId, provider: "opencode", up_to_item_id: point.row_id });
  const branchId = branch.active_thread_id;
  const nativeBranch = await exportedSession(branchId);
  assert.equal(nativeBranch.messages.length, 1, "an inclusive user message boundary must not copy its following response");
  assert.ok(JSON.stringify(nativeBranch.messages).includes("SEALWIRE_SECOND"));
  assert.ok(!JSON.stringify(nativeBranch.messages).includes("SEALWIRE_THIRD"));
  await api(`/api/threads/${encodeURIComponent(branchId)}/archive`, {});
  assert.ok(!(await api("/api/threads")).threads.some((row) => row.id === branchId));
  assert.ok((await exportedSession(branchId)).info.time.archived, "archive preserves the native conversation and marks it archived");
  await promisify(execFile)("opencode", ["session", "delete", branchId], { cwd, env: { ...process.env, ...env }, timeout: 30000 });
  await api("/api/session/message", { thread_id: tipId, text: "SEALWIRE_MIXED" });
  await idle(tipId, "SEALWIRE_BEFORE_TOOL");
  const mixedNative = await exportedSession(tipId);
  assert.ok(mixedNative.messages.some((row) => row.parts.some((part) => part.text?.includes("SEALWIRE_BEFORE_TOOL")) && row.parts.some((part) => part.type === "tool")), "fixture must put text and a later tool in the same native message");
  const mixedRow = (await transcript(tipId)).entries.find((row) => row.kind === "agent_text" && row.text?.includes("SEALWIRE_BEFORE_TOOL"));
  assert.ok(mixedRow);
  const partial = await api("/api/session/fork", { source_thread_id: tipId, provider: "opencode", up_to_item_id: mixedRow.row_id });
  await idle(partial.active_thread_id, "first response");
  const partialNative = await exportedSession(partial.active_thread_id);
  assert.ok(JSON.stringify(partialNative.messages).includes("SEALWIRE_BEFORE_TOOL"));
  assert.ok(!JSON.stringify(partialNative.messages).includes("SEALWIRE_AFTER_BOUNDARY"), "within-message fork must replay only selected rows, excluding the later native tool");
  await api(`/api/threads/${encodeURIComponent(partial.active_thread_id)}/delete`, {});
  await api(`/api/threads/${encodeURIComponent(tipId)}/delete`, {});
  console.log("PASS native tip/message-boundary fork, safe within-message replay, isolated continuation and persistent archive");

  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_REVIEW_SOURCE" });
  await idle(firstId, "SEALWIRE_REVIEW_SOURCE");
  const review = await api("/api/session/review", { parent_thread_id: firstId, reviewer_provider: "opencode", reviewer_model: "sealwire_test/echo", recap_source: "last_message", instructions: "SEALWIRE_REVIEW: inspect approved.txt and return a verdict", max_rounds: 1 });
  const reviewed = await until(() => api("/api/session/reviews"), (data) => data.review_jobs.some((job) => job.id === review.review_job_id && ["complete", "failed"].includes(job.status?.status || job.status)), "OpenCode reviewer completes", 60000);
  const job = reviewed.review_jobs.find((job) => job.id === review.review_job_id);
  assert.equal(job.status?.status || job.status, "complete", JSON.stringify(job));
  assert.equal(job.verdict, "approve", JSON.stringify(job));
  const nativeReview = await exportedSession(job.reviewer_thread_id);
  assert.ok(nativeReview.messages.some((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed")), "reviewer must actually inspect using shell");
  assert.equal(await fs.readFile(path.join(cwd, "approved.txt"), "utf8"), "written through OpenCode ACP\n");
  await api(`/api/threads/${encodeURIComponent(job.reviewer_thread_id)}/delete`, {});
  console.log("PASS best-effort OpenCode reviewer with shell inspection and mutation tools denied");

  const delegated = await toolApi("/api/session/delegate", {
    thread_id: firstId, provider: "opencode", model: "sealwire_test/echo", message: "SEALWIRE_DELEGATED: report the result",
  });
  assert.notEqual(delegated.isError, true, JSON.stringify(delegated));
  const answered = await until(() => api("/api/session/reviews"), (data) => data.asks?.some((ask) => ask.asker_thread_id === firstId && ask.status === "done"), "delegated OpenCode answer");
  const answer = answered.asks.find((ask) => ask.asker_thread_id === firstId);
  assert.equal(answer.answer, "first response");
  const peerHistory = await transcript(answer.peer_thread_id);
  assert.ok(!textOf(peerHistory).includes("You finished without calling `report_back`"));
  assert.ok(textOf(peerHistory).includes("report_back"));
  await until(() => transcript(firstId), (data) => data.entries.some((entry) => entry.injection?.kind === "delegate_answer") && !data.thread_state?.active_turn_id, "asker receives answer and settles");
  await until(() => transcript(answer.peer_thread_id), (data) => !data.thread_state?.active_turn_id, "delegated peer settles after report_back");
  await api(`/api/threads/${encodeURIComponent(answer.peer_thread_id)}/delete`, {});
  console.log("PASS delegated OpenCode report_back returns without a missing-tool reminder");

  const handover = await toolApi("/api/session/handover", { thread_id: secondId, provider: "opencode", model: "sealwire_test/echo", note: "SEALWIRE_HANDOVER: Continue the isolated test" });
  assert.notEqual(handover.isError, true, JSON.stringify(handover));
  const handoverTarget = handover.content[0].text.match(/agent's id is (ses_[A-Za-z0-9]+)/)?.[1];
  assert.ok(handoverTarget, JSON.stringify(handover));
  await until(() => transcript(handoverTarget), (data) => textOf(data).includes("Nobody is waiting on a reply") && !data.thread_state?.active_turn_id && data.entries.some((entry) => entry.kind === "agent_text"), "OpenCode handover continues", 45000);
  await api(`/api/threads/${encodeURIComponent(handoverTarget)}/delete`, {});
  console.log("PASS handover starts an isolated OpenCode session and continues");

  await api("/api/session/message", { thread_id: secondId, text: "SEALWIRE_AGENT_DELEGATE: ask another OpenCode agent" });
  const agentAsks = await until(() => api("/api/session/reviews"), (data) => data.asks?.some((ask) => ask.asker_thread_id === secondId && ask.status === "done"), "agent-initiated MCP delegation", 60000);
  const agentAsk = agentAsks.asks.find((ask) => ask.asker_thread_id === secondId);
  assert.equal(agentAsk.answer, "first response");
  await until(() => transcript(secondId), (data) => data.entries.some((entry) => entry.injection?.kind === "delegate_answer") && !data.thread_state?.active_turn_id, "MCP asker receives its own report");
  await until(() => transcript(agentAsk.peer_thread_id), (data) => !data.thread_state?.active_turn_id, "MCP peer settles");
  await api(`/api/threads/${encodeURIComponent(agentAsk.peer_thread_id)}/delete`, {});
  console.log("PASS OpenCode initiates delegate through its own MCP identity and receives report_back");

  await stopManagedProcess(relay);
  config.provider.sealwire_test.models.added = { name: "Added after restart", limit: { context: 8192, output: 1024 }, variants: { xhigh: {} } };
  delete config.provider.sealwire_test.models.plain;
  await fs.writeFile(path.join(root, "config", "opencode", "opencode.json"), JSON.stringify(config));
  await boot();
  const restartedModels = await api("/api/providers/opencode/models");
  assert.deepEqual(restartedModels.find((row) => row.model === "sealwire_test/added")?.supported_reasoning_efforts, ["xhigh", "default"], "startup refresh includes models added since the persisted catalog");
  assert.ok(!restartedModels.some((row) => row.model === "sealwire_test/plain"), "startup refresh removes stale model rows");
  const coldThreads = (await api("/api/threads")).threads.map((thread) => thread.id);
  assert.ok(coldThreads.includes(firstId) && coldThreads.includes(secondId), "native history must be listed before any cold transcript read");
  const cold = await transcript(firstId);
  for (let cursor = cold.prev_cursor; cursor != null;) {
    const page = await api(`/api/threads/${encodeURIComponent(firstId)}/transcript?before=${encodeURIComponent(cursor)}`);
    cold.entries.unshift(...page.entries);
    cursor = page.prev_cursor;
  }
  assert.ok(textOf(cold).includes("SEALWIRE_FIRST"));
  assert.ok(textOf(cold).includes("first response"));
  assert.ok((cold.entries || []).some((entry) => entry.kind !== "user_text" && JSON.stringify(entry).includes("approved.txt")), "tool history survives restart");
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_AFTER_RESTART" });
  await idle(firstId, "SEALWIRE_AFTER_RESTART");
  console.log("PASS cold history replay and continuation");

  await api("/api/session/settings", { thread_id: firstId, approval_policy: "untrusted" });
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_BEFORE_EVICTION" });
  await idle(firstId, "SEALWIRE_BEFORE_EVICTION");
  const policyBeforeEviction = (await exportedSession(firstId)).info.permission;
  const pool = [];
  const ownChildren = async () => {
    const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,args="]);
    return stdout.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match && Number(match[2]) === relay.pid && /opencode acp/.test(match[3]) ? [Number(match[1])] : [];
    });
  };
  const killOwnChild = async (pid) => {
    assert.ok((await ownChildren()).includes(pid), "only this test relay's child may be killed");
    process.kill(pid, "SIGKILL");
    await until(ownChildren, (pids) => !pids.includes(pid), "test child exited");
  };
  let newestPid;
  for (let i = 0; i < 4; i++) {
    const before = await ownChildren();
    const started = await api("/api/session/start", { cwd, provider: "opencode", model: "sealwire_test/echo", approval_policy: "bypass", initial_prompt: `SEALWIRE_POOL_${i}` });
    await idle(started.active_thread_id, `SEALWIRE_POOL_${i}`);
    pool.push(started.active_thread_id);
    newestPid = (await ownChildren()).find((pid) => !before.includes(pid));
    assert.ok(newestPid, "a new session has its own process");
  }
  await until(ownChildren, (pids) => pids.length <= 3, "index plus at most two idle session processes");
  const revivedId = pool.at(-1);
  await killOwnChild(newestPid);
  const beforeRevive = await ownChildren();
  await api("/api/session/message", { thread_id: revivedId, text: "SEALWIRE_AFTER_CRASH" });
  await idle(revivedId, "SEALWIRE_AFTER_CRASH");
  const revivedPid = (await ownChildren()).find((pid) => !beforeRevive.includes(pid));
  assert.ok(revivedPid, "dead child is replaced without restarting relay");
  await killOwnChild(revivedPid);
  await api(`/api/threads/${encodeURIComponent(revivedId)}/archive`, {});
  const archivedNative = await exportedSession(revivedId);
  assert.ok(archivedNative.info.time.archived, "dead session can be archived");
  await promisify(execFile)("opencode", ["session", "delete", revivedId], { cwd, env: { ...process.env, ...env }, timeout: 30000 });
  for (const id of pool.filter((id) => id !== revivedId)) await api(`/api/threads/${encodeURIComponent(id)}/delete`, {});
  const beforeDelete = await ownChildren();
  const doomed = await api("/api/session/start", { cwd, provider: "opencode", model: "sealwire_test/echo", initial_prompt: "SEALWIRE_DELETE_AFTER_CRASH" });
  await idle(doomed.active_thread_id, "SEALWIRE_DELETE_AFTER_CRASH");
  const doomedPid = (await ownChildren()).find((pid) => !beforeDelete.includes(pid));
  await killOwnChild(doomedPid);
  await api(`/api/threads/${encodeURIComponent(doomed.active_thread_id)}/delete`, {});
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_AFTER_EVICTION" });
  await idle(firstId, "SEALWIRE_AFTER_EVICTION");
  assert.deepEqual((await exportedSession(firstId)).info.permission, policyBeforeEviction, "reattachment must not append a temporary on-request policy");
  console.log("PASS bounded idle processes, dead-child continuation/archive/delete and reattachment after eviction");

  if (process.env.OPENCODE_E2E_BROWSER === "1") {
    const { verifyOpenCodeCommands } = await import("./opencode-provider-browser.mjs");
    await verifyOpenCodeCommands({ base, cwd, root, api, until, transcript, exportedSession });
  }

  if (process.env.OPENCODE_E2E_PREVIEW === "1") {
    console.log(`PREVIEW ${base} (SIGINT to finish)`);
    await new Promise((resolve) => process.once("SIGINT", resolve));
  }

  await api(`/api/threads/${encodeURIComponent(firstId)}/delete`, {});
  await api(`/api/threads/${encodeURIComponent(secondId)}/delete`, {});
  assert.equal((await api("/api/threads")).threads.length, 0);
  const native = await promisify(execFile)("opencode", ["session", "list", "--format", "json"], {
    cwd, env: { ...process.env, ...env }, timeout: 30000,
  });
  assert.equal(native.stdout.trim(), "", "native OpenCode storage must be empty after deletion");
  console.log("PASS permanent deletion through OpenCode CLI");
  console.log(JSON.stringify({ ok: true, model_requests: requests.length, isolated_state: root }));
}
try {
  await run();
} catch (error) {
  if (base) {
    const snapshot = await session().catch(() => null);
    console.error("relay failure state", JSON.stringify({ pending: snapshot?.pending_approvals, status: snapshot?.current_status }));
    if (snapshot?.active_thread_id) console.error("transcript", JSON.stringify(await transcript(snapshot.active_thread_id).catch(() => null)));
  }
  dumpProcessLogs(relay);
  throw error;
} finally {
  await stopManagedProcess(relay);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => modelServer.close(resolve));
}
