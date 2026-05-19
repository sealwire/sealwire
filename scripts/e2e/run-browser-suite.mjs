import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { loadE2eManifest, suiteScripts } from "./manifest.mjs";

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
const env = {
  ...process.env,
  ...(useFakeProvider ? { AGENT_PROVIDERS: "fake" } : {}),
};

try {
  if (!noBuild) {
    await runChecked("npm", ["run", "build"], { env, label: "build" });
  }

  const startedAt = Date.now();
  for (const [index, script] of scripts.entries()) {
    const label = `${script} (${index + 1}/${scripts.length})`;
    await runChecked(process.execPath, [path.join("scripts", script)], { env, label });
  }

  console.log(
    `[browser-suite] ${suiteName} passed ${scripts.length} scenario(s) in ${formatDuration(
      Date.now() - startedAt
    )}`
  );
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
  const startedAt = Date.now();
  console.log(`[browser-suite] running ${label}`);
  const result = await runCommand(command, args, env);
  if (result.code !== 0) {
    throw new Error(
      `[browser-suite] ${label} failed with ${result.signal || `exit code ${result.code}`}`
    );
  }
  console.log(`[browser-suite] passed ${label} in ${formatDuration(Date.now() - startedAt)}`);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
