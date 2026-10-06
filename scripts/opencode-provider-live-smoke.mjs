// Opt-in paid smoke using the existing OpenCode login, copied without inspecting credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { resolveRelayServerCommand } from "./e2e/harness/binaries.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

assert.equal(process.env.OPENCODE_LIVE_SMOKE, "1", "Set OPENCODE_LIVE_SMOKE=1 to authorize real OpenAI model requests");
const model = process.env.OPENCODE_SMOKE_MODEL || "openai/gpt-5.6-luna";
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-opencode-live-")));
const cwd = path.join(root, "project");
const authCopy = path.join(root, "data", "opencode", "auth.json");
let relay;
let base;
const ids = new Set();
async function api(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: body === undefined ? undefined : JSON.stringify({ device_id: "opencode-live-smoke", ...body }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok, `${route}: ${JSON.stringify(result)}`);
  return result.data;
}
const transcript = (id) => api(`/api/threads/${encodeURIComponent(id)}/transcript`);
async function until(read, predicate, label, budget = 120000) {
  const deadline = Date.now() + budget;
  let last;
  while (Date.now() < deadline) {
    const result = await read();
    last = result;
    const error = result.entries?.findLast((entry) => entry.kind === "error");
    if (error) throw new Error(`${label}: ${error.text}`);
    if (predicate(result)) return result;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}: ${JSON.stringify(last?.thread_state || last)}`);
}
try {
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "marker.txt"), "SEALWIRE_LIVE_MARKER\n");
  await fs.mkdir(path.dirname(authCopy), { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "auth.json"), authCopy);
  await fs.chmod(authCopy, 0o600);
  const config = path.join(root, "config", "opencode");
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({ model, small_model: model, enabled_providers: ["openai"] }));
  const port = await getFreePort();
  const { command, args } = resolveRelayServerCommand();
  relay = spawnManagedProcess("opencode-live-smoke", command, args, {
    AGENT_PROVIDERS: "opencode", BIND_HOST: "127.0.0.1", PORT: String(port),
    RELAY_STATE_DB: path.join(root, "relay", "sealwire.db"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_CONFIG_CONTENT: "{}",
  }, { stripInherited: (name) => /^(RELAY_|SEALWIRE_|OPENCODE_|ANTHROPIC_|OPENAI_)/.test(name) });
  base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/api/health`, 90000);
  await api("/api/allowed-roots", { allowed_roots: [cwd] });
  await api("/api/workspace/trust", { cwd, trusted: true });
  const catalog = await api("/api/providers/opencode/models");
  const sol = catalog.find((entry) => entry.model === "openai/gpt-6-sol");
  assert.ok(sol?.supported_reasoning_efforts.includes("high"), "GPT-6 Sol must offer effort before opening a session with it");
  console.log(`PASS unselected GPT-6 Sol efforts: ${sol.supported_reasoning_efforts.join(", ")}`);
  const started = await api("/api/session/start", { cwd, provider: "opencode", model, effort: "low", approval_policy: "bypass", initial_prompt: "Reply exactly SEALWIRE_LIVE_OK. Do not call tools." });
  const id = started.active_thread_id;
  ids.add(id);
  console.log(`Started isolated live smoke ${base}, model ${model}, session ${id}`);
  await until(() => transcript(id), (data) => !data.thread_state?.active_turn_id && data.entries.some((entry) => entry.kind === "agent_text" && entry.text?.includes("SEALWIRE_LIVE_OK")), "real model response");
  console.log(`PASS real ${model} response`);
  const response = await fetch(`${base}/api/session/goal`, {
    method: "POST", headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: JSON.stringify({ thread_id: id, objective: "Verify marker.txt contains SEALWIRE_LIVE_MARKER using a read tool. Do not edit files or delegate. Use goal_plan for 3 small steps, mark each done with goal_step, then call goal_complete citing the read result. Keep the response short." }),
  });
  const goalResult = await response.json();
  assert.ok(response.ok && !goalResult.isError, JSON.stringify(goalResult));
  const goals = await until(() => api("/api/session/reviews"), (data) => data.goals?.some((goal) => goal.thread_id === id && ["complete_claimed", "blocked", "awaiting_user", "out_of_turns"].includes(goal.status)), "real Goal MCP completion");
  const goal = goals.goals.find((goal) => goal.thread_id === id);
  assert.equal(goal.status, "complete_claimed", JSON.stringify(goal));
  assert.ok(goal.steps?.length >= 3 && goal.steps.every((step) => step.status === "done"));
  await until(() => transcript(id), (data) => !data.thread_state?.active_turn_id, "goal turn settles");
  assert.equal(await fs.readFile(path.join(cwd, "marker.txt"), "utf8"), "SEALWIRE_LIVE_MARKER\n");
  console.log(`PASS real Goal plan, steps, file read and completion (${goal.turns} turn)`);
  console.log(JSON.stringify({ ok: true, model, isolated_state: root }));
} catch (error) {
  if (base) {
    const snapshot = await api("/api/session").catch(() => null);
    console.error("live smoke state", JSON.stringify({ status: snapshot?.current_status, turn: snapshot?.active_turn_id, pending: snapshot?.pending_approvals?.map((entry) => entry.summary) }));
    for (const id of ids) {
      const data = await transcript(id).catch(() => null);
      console.error("live smoke transcript", JSON.stringify(data?.entries?.map((entry) => ({ kind: entry.kind, text: entry.text }))));
    }
  }
  throw error;
} finally {
  if (relay && base) {
    for (const id of ids) {
      await api("/api/session/stop", { thread_id: id }).catch(() => {});
      await until(() => transcript(id), (data) => !data.thread_state?.active_turn_id, "cleanup", 10000).catch(() => {});
      await api(`/api/threads/${encodeURIComponent(id)}/delete`, {}).catch((error) => console.error("session cleanup:", error.message));
    }
  }
  await stopManagedProcess(relay);
  await fs.rm(authCopy, { force: true });
}
