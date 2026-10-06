// Prove a scheduled proposal card starts ITSELF, in a real relay process.
//
// The in-process tests drive `start_due_scheduled_proposals_at` directly, or
// spawn the loop against a test-built `AppState`. Neither can show the shipped
// binary doing it: the watchdog's wiring, the beta gate, the team driver and the
// HTTP surface only come together in `main`. So this boots a real relay, stages
// a card with a schedule over the real API, and waits — calling no confirm — for
// the run to appear on its own.
//
// Maintainer script, deliberately outside `npm test` (the precedent is
// verify-orchestrator-mcp.mjs): it waits on a wall clock. The API's shortest
// schedule is one whole minute and the watchdog ticks every 15s, so expect
// roughly 60-80 seconds plus a build.
//
//   scripts/with-private.sh node scripts/verify-scheduled-autostart.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFreePort } from "./e2e/harness/ports.mjs";
import { waitForHealth } from "./e2e/harness/process.mjs";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const STUB_MARKER = path.join(REPO, "crates", "sealwire-private", "STUB");

let relay;
let workspace;
class SkipRun extends Error {}

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
    );
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  if (existsSync(STUB_MARKER)) {
    console.log(
      "SKIP  this worktree has the private stub, so the relay would refuse every\n" +
        "      task route and start nothing. Run it as:\n" +
        "      scripts/with-private.sh node scripts/verify-scheduled-autostart.mjs"
    );
    process.exit(0);
  }

  // A git repo of its own. The relay takes its workspace from its cwd, and a
  // started task provisions a worktree there — pointing that at this checkout
  // would leave stray worktrees and branches behind.
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sched-ws-"));
  workspace = await fs.realpath(workspace);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "verify@example.com"],
    ["config", "user.name", "Verify"],
  ]) {
    await run("git", args, { cwd: workspace, stdio: "ignore" });
  }
  await fs.writeFile(path.join(workspace, "seed.txt"), "line1\n");
  await run("git", ["add", "-A"], { cwd: workspace, stdio: "ignore" });
  await run("git", ["commit", "-q", "-m", "seed"], { cwd: workspace, stdio: "ignore" });

  // Built here, then run from the workspace: `cargo run` would need this repo as
  // its cwd, and the relay's cwd is exactly what we are choosing.
  console.log("building relay-server --features private …");
  await run("cargo", ["build", "-p", "relay-server", "--features", "private"], { cwd: REPO });

  const port = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sched-state-"));
  relay = spawn(path.join(REPO, "target", "debug", "relay-server"), [], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_DB: path.join(stateDir, "sealwire.db"),
      AGENT_PROVIDERS: "fake",
      SEALWIRE_BETA: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const relayLog = [];
  for (const stream of [relay.stdout, relay.stderr]) {
    stream.on("data", (chunk) => {
      relayLog.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      if (relayLog.length > 200) relayLog.splice(0, relayLog.length - 200);
    });
  }

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/api/health`);

  const api = async (p, init = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const deviceId = "verify-device";

  const snap0 = await api("/api/session");
  const beta = snap0.body?.data?.beta_features_enabled;
  check(
    "the relay is up with beta ON (needs a --features private build)",
    beta === true,
    beta === true ? "" : "run via scripts/with-private.sh"
  );
  if (beta !== true) {
    throw new SkipRun("the relay came up without beta");
  }

  // A task may only start in a workspace someone vouched for.
  await api("/api/allowed-roots", {
    method: "POST",
    body: JSON.stringify({ allowed_roots: [workspace] }),
  });
  const trust = await api("/api/workspace/trust", {
    method: "POST",
    body: JSON.stringify({ cwd: workspace, trusted: true, device_id: deviceId }),
  });
  check("the temporary workspace is trusted", trust.status === 200, `status=${trust.status}`);

  // One minute is the shortest schedule the API takes: `start_in_minutes` is
  // whole minutes and must be positive. Every seat is pinned to the fake
  // provider — the default lineup names real agents this relay does not run.
  const onFake = { provider: "fake" };
  const staged = await api("/api/orchestrator/proposals", {
    method: "POST",
    body: JSON.stringify({
      title: "Scheduled auto-start proof",
      context: "Staged by verify-scheduled-autostart.mjs.",
      device_id: deviceId,
      auto_start: true,
      start_in_minutes: 1,
      agents: { tl: onFake, dev: onFake, reviewer: onFake },
    }),
  });
  const card = staged.body?.data?.proposal;
  check(
    "a card is staged carrying a schedule",
    Boolean(card?.id) && card?.auto_start === true && Number.isInteger(card?.scheduled_start_at),
    `id=${card?.id} auto_start=${card?.auto_start} at=${card?.scheduled_start_at}`
  );
  if (!card?.id) {
    throw new SkipRun(`nothing staged: ${JSON.stringify(staged.body)}`);
  }
  const dueAt = card.scheduled_start_at;

  const teamsCount = async () => {
    const res = await api("/api/session/teams");
    return (res.body?.data?.teams ?? []).length;
  };

  check("staging alone starts nothing", (await teamsCount()) === 0);

  // ONE loop across the due time, not two. Polling up to a few seconds short of
  // `dueAt` and then accepting whatever the next loop saw would pass a card that
  // fired early — the observation time is what decides, so a run seen while
  // `now < dueAt` is an early start and a failure, never something to wait past.
  // Ceiling covers the due time plus a 15s watchdog tick plus provisioning.
  const deadline = Date.now() + 150_000;
  let observedAt = null;
  while (Date.now() < deadline) {
    const at = Date.now() / 1000;
    if ((await teamsCount()) > 0) {
      observedAt = at;
      break;
    }
    await delay(250);
  }
  const offset = observedAt === null ? null : Math.round(observedAt - dueAt);

  check(
    "nothing runs before the scheduled time",
    observedAt !== null && observedAt >= dueAt,
    observedAt === null
      ? "no run appeared at all, so nothing started early"
      : `first seen ${Math.abs(offset)}s ${offset < 0 ? "BEFORE" : "after"} due`
  );
  check(
    "the card started itself, with no confirm call",
    observedAt !== null && observedAt >= dueAt,
    observedAt === null
      ? `still none ${Math.round(Date.now() / 1000 - dueAt)}s after due`
      : `a run appeared ${offset}s after it came due`
  );

  const after = await api("/api/orchestrator/proposals");
  const leftover = after.body?.data?.proposals ?? [];
  check(
    "the card is spent once it has started",
    leftover.every((entry) => entry.id !== card.id),
    `${leftover.length} card(s) still staged`
  );

  if (observedAt === null) {
    console.log("\nlast relay output:\n" + relayLog.slice(-40).join("\n"));
  }
} catch (error) {
  if (!(error instanceof SkipRun)) {
    check("harness ran to completion", false, error?.stack || String(error));
  } else {
    console.log(`SKIP  ${error.message}`);
  }
} finally {
  if (relay && relay.exitCode === null) {
    relay.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => relay.once("exit", resolve)),
      delay(3000).then(() => relay.kill("SIGKILL")),
    ]);
  }
  if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
