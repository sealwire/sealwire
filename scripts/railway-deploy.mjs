#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

const SUCCESS_STATUSES = new Set(["SUCCESS"]);
const FAILURE_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "CANCELED",
  "CANCELLED",
]);

export function parseStartedDeployment(output) {
  const payload = parseJsonOutput(output, "Railway upload");
  if (!payload || typeof payload.deploymentId !== "string" || !payload.deploymentId.trim()) {
    throw new Error("Railway upload did not return a deploymentId");
  }

  return {
    deploymentId: payload.deploymentId.trim(),
    logsUrl: typeof payload.logsUrl === "string" ? payload.logsUrl : null,
  };
}

export function findDeploymentStatus(output, deploymentId) {
  const deployments = parseJsonOutput(output, "Railway deployment list");
  if (!Array.isArray(deployments)) {
    throw new Error("Railway deployment list did not return an array");
  }

  const deployment = deployments.find((candidate) => candidate?.id === deploymentId);
  if (!deployment) {
    return null;
  }
  if (typeof deployment.status !== "string" || !deployment.status.trim()) {
    throw new Error(`Railway deployment ${deploymentId} did not include a status`);
  }
  return deployment.status.trim().toUpperCase();
}

export function classifyDeploymentStatus(status) {
  if (status == null) {
    return "pending";
  }
  if (SUCCESS_STATUSES.has(status)) {
    return "success";
  }
  if (FAILURE_STATUSES.has(status)) {
    return "failure";
  }
  return "pending";
}

export async function waitForDeployment({
  deploymentId,
  readStatus,
  sleep = delay,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  onStatus = () => {},
  onPollError = () => {},
  maxConsecutivePollErrors = MAX_CONSECUTIVE_POLL_ERRORS,
}) {
  const deadline = now() + timeoutMs;
  let lastStatus;
  let consecutivePollErrors = 0;

  while (now() < deadline) {
    let status;
    try {
      status = await readStatus();
      consecutivePollErrors = 0;
    } catch (error) {
      consecutivePollErrors += 1;
      onPollError(error, consecutivePollErrors);
      if (consecutivePollErrors >= maxConsecutivePollErrors) {
        throw new Error(
          `Could not read Railway deployment ${deploymentId} after `
            + `${consecutivePollErrors} consecutive attempts`,
          { cause: error }
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (status !== lastStatus) {
      onStatus(status);
      lastStatus = status;
    }

    const classification = classifyDeploymentStatus(status);
    if (classification === "success") {
      return status;
    }
    if (classification === "failure") {
      throw new Error(`Railway deployment ${deploymentId} finished with status ${status}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for Railway deployment ${deploymentId}`
      + (lastStatus ? ` (last status: ${lastStatus})` : "")
  );
}

function parseJsonOutput(output, label) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) {
    throw new Error(`${label} returned no JSON output`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Keep looking for the final structured line.
      }
    }
  }

  throw new Error(`${label} returned invalid JSON`);
}

async function runRailway(args, { echoStdout = false, echoStderr = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("railway", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echoStdout) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (echoStderr) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const suffix = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
      const error = new Error(`railway ${args[0]} failed (${suffix})`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function printFailureLogs(deploymentId, serviceId) {
  for (const [label, flag, lines] of [
    ["build", "--build", "200"],
    ["deployment", "--deployment", "100"],
  ]) {
    console.error(`\nLast Railway ${label} logs for ${deploymentId}:`);
    try {
      await runRailway(
        ["logs", deploymentId, flag, "--lines", lines, "--service", serviceId],
        { echoStdout: true }
      );
    } catch (error) {
      console.error(`Could not retrieve ${label} logs: ${error.message}`);
    }
  }
}

function positiveDurationFromEnv(name, fallbackMs) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallbackMs;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds`);
  }
  return seconds * 1000;
}

async function main() {
  const serviceId = process.env.RAILWAY_SERVICE_ID?.trim();
  if (!serviceId) {
    throw new Error("RAILWAY_SERVICE_ID is required");
  }

  const timeoutMs = positiveDurationFromEnv(
    "RAILWAY_DEPLOY_TIMEOUT_SECONDS",
    DEFAULT_TIMEOUT_MS
  );
  const pollIntervalMs = positiveDurationFromEnv(
    "RAILWAY_DEPLOY_POLL_SECONDS",
    DEFAULT_POLL_INTERVAL_MS
  );

  console.log("Uploading one detached Railway deployment...");
  const upload = await runRailway([
    "up",
    "--detach",
    "--json",
    "--yes",
    "--service",
    serviceId,
  ]);
  const { deploymentId, logsUrl } = parseStartedDeployment(upload.stdout);

  console.log(`Railway deployment: ${deploymentId}`);
  if (logsUrl) {
    console.log(`Build logs: ${logsUrl}`);
  }

  try {
    await waitForDeployment({
      deploymentId,
      timeoutMs,
      pollIntervalMs,
      readStatus: async () => {
        const result = await runRailway([
          "deployment",
          "list",
          "--service",
          serviceId,
          "--limit",
          "100",
          "--json",
        ]);
        return findDeploymentStatus(result.stdout, deploymentId);
      },
      onStatus(status) {
        console.log(
          status
            ? `Railway deployment ${deploymentId}: ${status}`
            : `Railway deployment ${deploymentId}: waiting for API visibility`
        );
      },
      onPollError(error, attempt) {
        console.warn(
          `Could not query Railway deployment status (${attempt}/`
            + `${MAX_CONSECUTIVE_POLL_ERRORS}): ${error.message}`
        );
      },
    });
  } catch (error) {
    console.error(error.message);
    await printFailureLogs(deploymentId, serviceId);
    throw error;
  }

  console.log(`Railway deployment ${deploymentId} completed successfully.`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`Railway deploy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
