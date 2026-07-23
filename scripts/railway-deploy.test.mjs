import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyDeploymentStatus,
  findDeploymentStatus,
  parseStartedDeployment,
  waitForDeployment,
} from "./railway-deploy.mjs";

test("parses the structured detached upload response", () => {
  assert.deepEqual(
    parseStartedDeployment(
      '{"deploymentId":"deploy-123","logsUrl":"https://railway.example/logs"}'
    ),
    {
      deploymentId: "deploy-123",
      logsUrl: "https://railway.example/logs",
    }
  );
});

test("parses the final JSON line if the CLI emits a warning first", () => {
  assert.deepEqual(
    parseStartedDeployment(
      'warning: update available\n{"deploymentId":"deploy-123","logsUrl":null}'
    ),
    {
      deploymentId: "deploy-123",
      logsUrl: null,
    }
  );
});

test("finds the exact deployment instead of assuming the newest entry", () => {
  const output = JSON.stringify([
    { id: "another-deploy", status: "SUCCESS" },
    { id: "deploy-123", status: "building" },
  ]);

  assert.equal(findDeploymentStatus(output, "deploy-123"), "BUILDING");
  assert.equal(findDeploymentStatus(output, "missing"), null);
});

test("classifies terminal and in-progress Railway statuses", () => {
  assert.equal(classifyDeploymentStatus("SUCCESS"), "success");
  assert.equal(classifyDeploymentStatus("FAILED"), "failure");
  assert.equal(classifyDeploymentStatus("CRASHED"), "failure");
  assert.equal(classifyDeploymentStatus("QUEUED"), "pending");
  assert.equal(classifyDeploymentStatus("BUILDING"), "pending");
  assert.equal(classifyDeploymentStatus(null), "pending");
});

test("waits through API visibility and build states until success", async () => {
  const statuses = [null, "QUEUED", "BUILDING", "DEPLOYING", "SUCCESS"];
  const observed = [];
  let nowMs = 0;

  const result = await waitForDeployment({
    deploymentId: "deploy-123",
    readStatus: async () => statuses.shift(),
    sleep: async (duration) => {
      nowMs += duration;
    },
    now: () => nowMs,
    timeoutMs: 100,
    pollIntervalMs: 10,
    onStatus: (status) => observed.push(status),
  });

  assert.equal(result, "SUCCESS");
  assert.deepEqual(observed, [null, "QUEUED", "BUILDING", "DEPLOYING", "SUCCESS"]);
});

test("retries transient deployment-list failures without uploading again", async () => {
  let attempts = 0;
  let nowMs = 0;

  const result = await waitForDeployment({
    deploymentId: "deploy-123",
    readStatus: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("temporary API error");
      }
      return "SUCCESS";
    },
    sleep: async (duration) => {
      nowMs += duration;
    },
    now: () => nowMs,
    timeoutMs: 100,
    pollIntervalMs: 10,
  });

  assert.equal(result, "SUCCESS");
  assert.equal(attempts, 3);
});

test("fails on a terminal deployment status", async () => {
  await assert.rejects(
    waitForDeployment({
      deploymentId: "deploy-123",
      readStatus: async () => "FAILED",
      sleep: async () => {},
      timeoutMs: 100,
      pollIntervalMs: 10,
    }),
    /deploy-123 finished with status FAILED/
  );
});

test("times out instead of reporting an in-progress deployment as successful", async () => {
  let nowMs = 0;

  await assert.rejects(
    waitForDeployment({
      deploymentId: "deploy-123",
      readStatus: async () => "QUEUED",
      sleep: async (duration) => {
        nowMs += duration;
      },
      now: () => nowMs,
      timeoutMs: 20,
      pollIntervalMs: 10,
    }),
    /Timed out waiting for Railway deployment deploy-123/
  );
});

test("workflow pins the CLI and uses the single-upload deploy script", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workflow = await readFile(
    path.join(repoRoot, ".github/workflows/railway-broker-deploy.yml"),
    "utf8"
  );

  assert.match(workflow, /@railway\/cli@5\.28\.0/);
  assert.match(workflow, /node scripts\/railway-deploy\.mjs/);
  assert.doesNotMatch(workflow, /for attempt in 1 2 3/);
});

test("deployment runner uploads once and polls the exact deployment to success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sealwire-railway-deploy-"));
  const statePath = path.join(tempDir, "state.json");
  const railwayPath = path.join(tempDir, "railway");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  await writeFile(
    railwayPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const statePath = process.env.FAKE_RAILWAY_STATE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { uploads: 0, polls: 0 };
const args = process.argv.slice(2);

if (args[0] === "up") {
  state.uploads += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({
    deploymentId: "deploy-123",
    logsUrl: "https://railway.example/deploy-123",
  }));
} else if (args[0] === "deployment" && args[1] === "list") {
  state.polls += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const statuses = ["QUEUED", "BUILDING", "SUCCESS"];
  const status = statuses[Math.min(state.polls - 1, statuses.length - 1)];
  console.log(JSON.stringify([{ id: "deploy-123", status }]));
} else {
  console.error("unexpected fake Railway command:", args.join(" "));
  process.exitCode = 2;
}
`,
    { mode: 0o755 }
  );

  try {
    const result = await runNode(
      path.join(repoRoot, "scripts/railway-deploy.mjs"),
      {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
        FAKE_RAILWAY_STATE: statePath,
        RAILWAY_SERVICE_ID: "service-123",
        RAILWAY_DEPLOY_POLL_SECONDS: "0.001",
        RAILWAY_DEPLOY_TIMEOUT_SECONDS: "2",
      }
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(state, { uploads: 1, polls: 3 });
    assert.match(result.stdout, /deploy-123: QUEUED/);
    assert.match(result.stdout, /deploy-123: BUILDING/);
    assert.match(result.stdout, /completed successfully/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.dirname(path.dirname(script)),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
