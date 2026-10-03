import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const repoRoot = path.resolve(here, "..");
const launcher = path.join(here, "sealwire.mjs");
const expectedWorker = path.join(repoRoot, "claude-worker", "worker.mjs");

// Black-box drive the launcher with a stub standing in for the compiled
// relay-server binary. The stub records the CLAUDE_WORKER_PATH it was handed
// and exits 0 immediately, so we can assert on the environment the launcher
// builds without needing a real server, a real port, or a real provider.
function runLauncher({ extraEnv = {}, args = ["--no-broker"] } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-launcher-"));
  const capturePath = path.join(workdir, "captured-env.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  // Pure-shell stub: only builtins + redirection, so it runs even when PATH is
  // empty (which is how we prove the launcher no longer hard-requires codex).
  writeFileSync(
    stubPath,
    `#!/bin/sh\nprintf '%s' "\${CLAUDE_WORKER_PATH:-<unset>}" > "$SEALWIRE_CAPTURE_FILE"\nexit 0\n`
  );
  chmodSync(stubPath, 0o755);

  // PATH points at an empty dir on purpose: codex is therefore NOT resolvable,
  // which is exactly the scenario a Claude-only user hits. The launcher is
  // invoked by absolute node path, and the stub needs no external commands, so
  // nothing legitimately requires PATH here. env is built from scratch (no
  // ...process.env), so CLAUDE_WORKER_PATH is absent unless a test opts in.
  const env = {
    HOME: process.env.HOME,
    PATH: workdir, // no codex, no cargo
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
      const captured = existsSync(capturePath)
        ? readFileSync(capturePath, "utf8")
        : null;
      rmSync(workdir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, captured });
    });
  });
}

test("launcher runs without codex on PATH (Claude-only users are not blocked)", async () => {
  const { code, stderr, captured } = await runLauncher();
  assert.equal(
    code,
    0,
    `expected launcher to start the server even without codex; exit=${code}\nstderr:\n${stderr}`
  );
  assert.notEqual(
    captured,
    null,
    "expected the stub relay-server to have been spawned"
  );
});

test("launcher points the relay-server at the packaged claude worker", async () => {
  const { captured, stderr } = await runLauncher();
  assert.equal(
    captured,
    expectedWorker,
    `CLAUDE_WORKER_PATH should resolve to the packaged worker.\nstderr:\n${stderr}`
  );
});

test("launcher honors an explicit CLAUDE_WORKER_PATH override", async () => {
  const override = "/tmp/custom/worker.mjs";
  const { captured } = await runLauncher({
    extraEnv: { CLAUDE_WORKER_PATH: override },
  });
  assert.equal(captured, override);
});


test("launcher refuses LAN and wildcard addresses before starting a relay", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.2", "invalid", "::1%lo0"]) {
    const result = await runLauncher({ args: ["--host", host] });
    assert.equal(result.code, 2);
    assert.equal(result.captured, null);
    assert.match(result.stderr, /loopback/);
  }
  const result = await runLauncher({ extraEnv: { BIND_HOST: "0.0.0.0" } });
  assert.equal(result.code, 2);
  assert.equal(result.captured, null);
});

test("launcher accepts IPv4 and IPv6 loopback addresses", async () => {
  for (const host of ["127.0.0.2", "::1", "0:0:0:0:0:0:0:1"]) {
    const result = await runLauncher({ args: ["--host", host] });
    assert.equal(result.code, 0, result.stderr);
    assert.notEqual(result.captured, null);
  }
});
