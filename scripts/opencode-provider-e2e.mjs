// Real OpenCode ACP + relay, with an isolated store and a local model server.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
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
    const tool = writeFile && !alreadyCalled ? {
      id: `call_sealwire_write_${requests.length}`, type: "function", function: {
        name: "write", arguments: JSON.stringify({ filePath: path.join(cwd, writeFile), content: "written through OpenCode ACP\n" }),
      },
    } : null;
    const answer = text.includes("SEALWIRE_WAIT") ? "waiting response" : text.includes("SEALWIRE_SECOND") ? "second response" : "first response";
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
      assert.ok(body.tools.some((item) => item.function.name === "write"), "OpenCode should expose its write tool");
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
    response.writeHead(500);
    response.end(String(error));
  }
});
modelServer.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const modelPort = modelServer.address().port;
const config = {
  model: "sealwire_test/echo", small_model: "sealwire_test/echo", enabled_providers: ["sealwire_test"], permission: "ask",
  provider: { sealwire_test: { name: "Sealwire Test", npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "isolated-test" },
    models: {
      echo: { name: "Echo", limit: { context: 8192, output: 1024 }, variants: { low: {}, high: {} } },
      second: { name: "Second", limit: { context: 8192, output: 1024 }, variants: { low: {}, high: {} } },
    },
  } },
};
await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true });
await fs.writeFile(path.join(root, "config", "opencode", "opencode.json"), JSON.stringify(config));
await fs.writeFile(path.join(cwd, "opencode.json"), JSON.stringify({ model: "sealwire_test/second" }));
const env = {
  AGENT_PROVIDERS: "opencode,fake", BIND_HOST: "127.0.0.1", RELAY_API_TOKEN: "",
  RELAY_STATE_PATH: path.join(root, "relay", "session.json"),
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
async function exportedSession(id) {
  const result = await promisify(execFile)("opencode", ["export", id], {
    cwd, env: { ...process.env, ...env }, timeout: 30000,
  });
  return JSON.parse(result.stdout);
}
try {
  await boot();
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
  assert.equal((await api("/api/threads")).threads.length, 0, "discovery sessions must be deleted");
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
  await assert.rejects(api("/api/session/review", { parent_thread_id: firstId, reviewer_provider: "opencode" }), /cannot enforce read-only reviews/);
  assert.equal((await api("/api/session/reviews")).review_jobs.length, 0, "unsupported reviewer must be refused before a job is queued");
  console.log("PASS failed-start cleanup and synchronous reviewer refusal");

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

  await api("/api/session/settings", { thread_id: firstId, model: "sealwire_test/echo", effort: "low", approval_policy: "bypass" });
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_WRITE automatic.txt" });
  await until(() => fs.readFile(path.join(cwd, "automatic.txt"), "utf8").catch(() => ""), (text) => text.includes("written through"), "automatic file write");
  await idle(firstId, "first response");
  assert.ok(requests.some((request) => request.model === "echo"));
  const switched = await exportedSession(firstId);
  assert.equal(switched.messages.filter((message) => message.info.role === "user").at(-1).info.model.variant, "low");
  assert.equal((await session()).pending_approvals.length, 0);
  console.log("PASS model/effort change and auto-approval");

  const requestsBeforeGoal = requests.length;
  const goal = await toolApi("/api/session/goal", { thread_id: firstId, objective: "Finish this isolated test" });
  assert.equal(goal.isError, true, "OpenCode must refuse goals it cannot settle through MCP");
  assert.match(goal.content[0].text, /OpenCode.*MCP/);
  assert.ok(!(await api("/api/session/reviews")).goals?.some((item) => item.thread_id === firstId));
  assert.equal(requests.length, requestsBeforeGoal, "a refused goal must not make model requests");
  console.log("PASS goal mode refuses missing session tools");

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
  assert.ok(requests.every((request) => (request.tools || []).every((tool) => !tool.function.name.startsWith("sealwire"))), "directory-shared tools must never contain Sealwire session identities");
  console.log("PASS no Sealwire MCP identity crosses OpenCode sessions");

  const delegated = await toolApi("/api/session/delegate", {
    thread_id: firstId, provider: "opencode", model: "sealwire_test/echo", message: "SEALWIRE_DELEGATED: report the result",
  });
  assert.notEqual(delegated.isError, true, JSON.stringify(delegated));
  const answered = await until(() => api("/api/session/reviews"), (data) => data.asks?.some((ask) => ask.asker_thread_id === firstId && ask.status === "done"), "delegated OpenCode answer");
  const answer = answered.asks.find((ask) => ask.asker_thread_id === firstId);
  assert.equal(answer.answer, "first response");
  const peerHistory = await transcript(answer.peer_thread_id);
  assert.ok(!textOf(peerHistory).includes("You finished without calling `report_back`"));
  assert.ok(textOf(peerHistory).includes("self-contained final answer"));
  await until(() => transcript(firstId), (data) => !data.thread_state?.active_turn_id, "asker settles after delegation");
  await api(`/api/threads/${encodeURIComponent(answer.peer_thread_id)}/delete`, {});
  console.log("PASS delegated OpenCode final answer returns without a missing-tool reminder");

  await stopManagedProcess(relay);
  await boot();
  const coldThreads = (await api("/api/threads")).threads.map((thread) => thread.id);
  assert.ok(coldThreads.includes(firstId) && coldThreads.includes(secondId), "native history must be listed before any cold transcript read");
  const cold = await transcript(firstId);
  assert.ok(textOf(cold).includes("SEALWIRE_FIRST"));
  assert.ok(textOf(cold).includes("first response"));
  assert.ok((cold.entries || []).some((entry) => entry.kind !== "user_text" && JSON.stringify(entry).includes("approved.txt")), "tool history survives restart");
  await api("/api/session/message", { thread_id: firstId, text: "SEALWIRE_AFTER_RESTART" });
  await idle(firstId, "SEALWIRE_AFTER_RESTART");
  console.log("PASS cold history replay and continuation");

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
