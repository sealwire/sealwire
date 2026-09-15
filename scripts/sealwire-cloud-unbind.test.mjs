import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "sealwire.mjs");
const HOSTED_BROKER_HTTP = "https://agent-relay.up.railway.app";

function runLauncher({ extraEnv = {}, args = [], stubScript } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-unbind-"));
  const capturePath = path.join(workdir, "captured.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  writeFileSync(
    stubPath,
    stubScript ||
      [
        "#!/bin/sh",
        "{",
        '  printf "argv=%s\\n" "$*"',
        '  printf "RELAY_BROKER_CONTROL_URL=%s\\n" "${RELAY_BROKER_CONTROL_URL:-<unset>}"',
        '  printf "SEALWIRE_CLOUD_ACCESS_KEY=%s\\n" "${SEALWIRE_CLOUD_ACCESS_KEY:-<unset>}"',
        '  printf "RELAY_LICENSE_CODE=%s\\n" "${RELAY_LICENSE_CODE:-<unset>}"',
        '  printf "PORT=%s\\n" "${PORT:-<unset>}"',
        '} > "$SEALWIRE_CAPTURE_FILE"',
        "exit 0",
        "",
      ].join("\n")
  );
  chmodSync(stubPath, 0o755);

  const env = {
    HOME: process.env.HOME,
    PATH: workdir,
    AGENT_RELAY_SERVER_BIN: stubPath,
    SEALWIRE_CAPTURE_FILE: capturePath,
    ...extraEnv,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args, "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      const raw = existsSync(capturePath)
        ? readFileSync(capturePath, "utf8")
        : null;
      rmSync(workdir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, captured: parseCaptured(raw) });
    });
  });
}

function parseCaptured(raw) {
  const map = {};
  if (!raw) return map;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

test("`sealwire cloud unbind` does not start the local relay or set PORT", async () => {
  const { code, stdout, stderr, captured } = await runLauncher({
    args: ["cloud", "unbind"],
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`);
  assert.match(stdout + stderr, /unbinding cloud access/);
  assert.doesNotMatch(stdout, /serving local relay/);
  assert.equal(captured.argv, "cloud-access-release");
  assert.equal(captured.RELAY_BROKER_CONTROL_URL, HOSTED_BROKER_HTTP);
  assert.equal(captured.PORT, "<unset>");
});

test("`sealwire cloud unbind` strips activation secrets from child env", async () => {
  const secret = "super-secret-access-key-never-print";
  const { code, stdout, stderr, captured } = await runLauncher({
    args: ["cloud", "unbind"],
    extraEnv: {
      SEALWIRE_CLOUD_ACCESS_KEY: secret,
      RELAY_LICENSE_CODE: secret,
    },
  });
  assert.equal(code, 0);
  assert.equal(captured.SEALWIRE_CLOUD_ACCESS_KEY, "<unset>");
  assert.equal(captured.RELAY_LICENSE_CODE, "<unset>");
  assert.doesNotMatch(stdout + stderr, new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(secret));
});

test("`sealwire cloud unbind` honors --broker origin", async () => {
  const { code, captured } = await runLauncher({
    args: ["cloud", "unbind", "--broker", "https://broker.example.test"],
  });
  assert.equal(code, 0);
  assert.equal(captured.RELAY_BROKER_CONTROL_URL, "https://broker.example.test");
});

test("`unbind` alone is rejected", async () => {
  const { code, stderr } = await runLauncher({ args: ["unbind"] });
  assert.equal(code, 2);
  assert.match(stderr, /unknown argument/);
});

test("help documents cloud unbind", () => {
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /cloud unbind/);
  assert.match(result.stdout, /SEALWIRE_CLOUD_ACCESS_KEY/);
});
