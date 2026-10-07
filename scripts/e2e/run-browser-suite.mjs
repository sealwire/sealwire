import path from "node:path";
import process from "node:process";

import { loadE2eManifest, suiteScripts } from "./manifest.mjs";
import { runScenarioProcess } from "./scenario-process.mjs";
import { summarize } from "./suite-report.mjs";

const suiteName = readOption("--suite") || process.argv[2];
const manifest = await loadE2eManifest();
if (!suiteName || !manifest.suites?.[suiteName]) {
  console.error(
    [
      "Usage: node scripts/e2e/run-browser-suite.mjs --suite <name> [--fake] [--no-build]",
      `Available suites: ${Object.keys(manifest.suites || {}).join(", ")}`,
    ].join("\n")
  );
  process.exit(1);
}
const scripts = suiteScripts(manifest, suiteName);

const useFakeProvider = process.argv.includes("--fake");
const noBuild = process.argv.includes("--no-build");
// Run every scenario even after one fails, and report them together at the end.
//
// These specs are independent — each builds its own relay, state dir and browser —
// so stopping at the first failure only hides the rest. This suite had been red for
// weeks, and each fix revealed the next long-standing failure one CI round at a
// time: 5/26, then 16/26, then 19/26. Every one of those rounds cost a full CI run
// to learn a single name. `--fail-fast` restores the old behaviour for local runs
// where the first failure is the one being worked on.
const failFast = process.argv.includes("--fail-fast");
// The slowest fake-provider scenario takes under three minutes.
const SCENARIO_TIMEOUT_MS = Number(process.env.BROWSER_E2E_SCENARIO_TIMEOUT_MS || 5 * 60 * 1000);
const env = {
  ...process.env,
  ...(useFakeProvider ? { AGENT_PROVIDERS: "fake" } : {}),
};

try {
  if (!noBuild) {
    await runChecked("npm", ["run", "build"], { env, label: "build" });
  }

  const startedAt = Date.now();
  const failures = [];
  let stoppedEarly = false;
  for (const [index, script] of scripts.entries()) {
    const label = `${script} (${index + 1}/${scripts.length})`;
    const failure = await runScenario(process.execPath, [path.join("scripts", script)], {
      env,
      label,
    });
    if (failure) {
      failures.push({ script, failure });
      if (failFast) {
        console.error(`[browser-suite] --fail-fast: stopping after ${script}`);
        stoppedEarly = true;
        break;
      }
    }
  }

  for (const line of summarize({
    duration: formatDuration(Date.now() - startedAt),
    failures,
    stoppedEarly,
    suiteName,
    total: scripts.length,
  })) {
    (failures.length ? console.error : console.log)(line);
  }
  if (failures.length) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

async function runChecked(command, args, { env, label }) {
  const failure = await runScenario(command, args, { env, label });
  if (failure) {
    throw new Error(`[browser-suite] ${label} failed with ${failure}`);
  }
}

/// Returns null when the scenario passed, or a short description of how it failed.
async function runScenario(command, args, { env, label }) {
  const startedAt = Date.now();
  console.log(`[browser-suite] running ${label}`);
  const result = await runScenarioProcess(command, args, { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  const took = formatDuration(Date.now() - startedAt);
  if (result.code !== 0) {
    const failure = result.timedOut ? "a timeout" : result.signal || `exit code ${result.code}`;
    console.error(`[browser-suite] FAILED ${label} with ${failure} after ${took}`);
    return failure;
  }
  console.log(`[browser-suite] passed ${label} in ${took}`);
  return null;
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
