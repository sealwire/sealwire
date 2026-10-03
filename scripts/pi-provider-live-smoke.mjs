// Opt-in: uses the installed Pi login for one bounded, explicitly selected model turn.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveRelayServerCommand } from "./e2e/harness/binaries.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const model = process.env.PI_LIVE_MODEL;
assert.ok(model?.includes("/"), "Set PI_LIVE_MODEL=provider/model explicitly; this test spends real model tokens.");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-pi-live-")));
const cwd = path.join(root, "project");
const agent = path.join(root, "agent");
await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
await fs.mkdir(agent);
const login = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "auth.json");
await fs.symlink(login, path.join(agent, "auth.json"));
await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultTools: [], packages: [], autoUpdate: false, cacheWarming: "off" }));
await fs.writeFile(path.join(cwd, ".pi", "extensions", "limit-tools.mjs"), `
export default function (pi) {
  pi.on("before_agent_start", () => {
    pi.setActiveTools(pi.getAllTools().filter(t => t.name.endsWith("__goal_status")).map(t => t.name));
  });
}
`);
const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const { command, args } = resolveRelayServerCommand();
const relay = spawnManagedProcess("pi-live", command, args, {
  AGENT_PROVIDERS: "pi", BIND_HOST: "127.0.0.1", PORT: String(port),
  RELAY_STATE_PATH: path.join(root, "relay", "session.json"),
  PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
  PI_OFFLINE: "1", PI_TELEMETRY: "0",
}, { stripInherited: name => /^(RELAY_|SEALWIRE_|PI_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_|GITHUB_|GH_TOKEN|COPILOT_|OPENROUTER_|XAI_|GROQ_|MISTRAL_)/.test(name) });
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: body === undefined ? undefined : JSON.stringify({ device_id: "pi-live-smoke", ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok, `${route}: ${JSON.stringify(result)}`);
  return result.data;
}
try {
  await waitForHealth(`${base}/api/health`, 60_000);
  await api("/api/allowed-roots", { allowed_roots: [cwd] });
  await api("/api/workspace/trust", { cwd, trusted: true });
  const session = await api("/api/session/start", {
    provider: "pi", cwd, model, effort: "low", approval_policy: "bypass", sandbox: "danger-full-access",
  });
  assert.equal(session.reasoning_effort, "low");
  const id = session.active_thread_id;
  await api("/api/session/message", { thread_id: id, text: "Call the Sealwire goal_status tool exactly once, then reply exactly PI_LIVE_MCP_OK. Do nothing else." });
  let finished;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const page = await api(`/api/threads/${encodeURIComponent(id)}/transcript`);
    const rows = page.entries || page.transcript || [];
    const calls = rows.filter(row => row.kind === "tool_call");
    assert.ok(calls.length <= 1, "The smoke test permits only one tool call");
    if (!page.thread_state?.active_turn_id) { finished = rows; break; }
    await delay(150);
  }
  assert.ok(finished, "Real Pi turn exceeded 90 seconds");
  assert.ok(finished.some(row => row.kind === "agent_text" && row.text?.includes("PI_LIVE_MCP_OK")), "Expected real model reply");
  assert.ok(finished.some(row => row.tool?.name?.endsWith("__goal_status") && row.status === "completed"), "MCP call succeeds");
  assert.ok(!finished.some(row => row.kind === "error"), "No provider error");
  const now = Math.floor(Date.now() / 1000);
  const usageRoute = `/api/usage?since=${now - 3600}&until=${now + 60}`;
  const usage = await api(usageRoute);
  assert.ok(usage.totals.total > 0, "Real usage reaches the durable ledger");
  for (let i = 0; i < 3; i++) await api(`/api/threads/${encodeURIComponent(id)}/transcript`);
  assert.equal((await api(usageRoute)).totals.total, usage.totals.total, "History reads do not rebill usage");
  console.log(`Pi live smoke passed: ${model}; one MCP call; ${usage.totals.total} reported tokens.`);
} finally {
  await stopManagedProcess(relay);
  await fs.rm(path.join(agent, "auth.json"), { force: true });
  console.log(`Isolated test artifacts: ${root}`);
}
