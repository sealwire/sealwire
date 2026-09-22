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
const launcher = path.join(here, "sealwire.mjs");

// The hosted broker `sealwire cloud` dials by default when nothing else is
// configured. Kept in sync with HOSTED_PUBLIC_BROKER_ORIGIN in sealwire.mjs.
const HOSTED_BROKER_WS = "wss://app.sealwire.dev";
const HOSTED_BROKER_HTTP = "https://app.sealwire.dev";

// Black-box drive the launcher with a stub standing in for the compiled
// relay-server binary. The stub records preflight + long-lived env separately.
function runLauncher({ extraEnv = {}, args = [] } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-cloud-"));
  const capturePath = path.join(workdir, "captured-broker.txt");
  const preflightPath = path.join(workdir, "captured-preflight.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "cloud-activate" ]; then',
      "  {",
      '    printf "argv=%s\\n" "$*"',
      '    printf "RELAY_CLOUD_ACTIVATION=%s\\n" "${RELAY_CLOUD_ACTIVATION:-<unset>}"',
      '    printf "RELAY_BROKER_CONTROL_URL=%s\\n" "${RELAY_BROKER_CONTROL_URL:-<unset>}"',
      '    printf "SEALWIRE_CLOUD_ACCESS_KEY=%s\\n" "${SEALWIRE_CLOUD_ACCESS_KEY:-<unset>}"',
      '    printf "RELAY_LICENSE_CODE=%s\\n" "${RELAY_LICENSE_CODE:-<unset>}"',
      '    printf "PORT=%s\\n" "${PORT:-<unset>}"',
      '  } > "$SEALWIRE_PREFLIGHT_FILE"',
      // Secret-free launch witness required for long-lived cloud start.
      '  printf \'sealwire-cloud-witness:{"v":1,"control_url":"%s","relay_id":"relay-stub","broker_room_id":"room-stub","bearer_fingerprint":"abcdef0123456789"}\\n\' "${RELAY_BROKER_CONTROL_URL}"',
      "  exit 0",
      "fi",
      'if [ "$1" = "cloud-access-release" ]; then',
      "  exit 0",
      "fi",
      "{",
      '  printf "RELAY_BROKER_URL=%s\\n" "${RELAY_BROKER_URL:-<unset>}"',
      '  printf "RELAY_BROKER_PUBLIC_URL=%s\\n" "${RELAY_BROKER_PUBLIC_URL:-<unset>}"',
      '  printf "RELAY_BROKER_CONTROL_URL=%s\\n" "${RELAY_BROKER_CONTROL_URL:-<unset>}"',
      '  printf "RELAY_BROKER_AUTH_MODE=%s\\n" "${RELAY_BROKER_AUTH_MODE:-<unset>}"',
      '  printf "SEALWIRE_CLOUD_ACCESS_KEY=%s\\n" "${SEALWIRE_CLOUD_ACCESS_KEY:-<unset>}"',
      '  printf "RELAY_LICENSE_CODE=%s\\n" "${RELAY_LICENSE_CODE:-<unset>}"',
      '  printf "RELAY_CLOUD_ACTIVATION=%s\\n" "${RELAY_CLOUD_ACTIVATION:-<unset>}"',
      '  printf "RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION=%s\\n" "${RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION:-<unset>}"',
      '  printf "RELAY_CLOUD_EXPECTED_RELAY_ID=%s\\n" "${RELAY_CLOUD_EXPECTED_RELAY_ID:-<unset>}"',
      '  printf "RELAY_CLOUD_EXPECTED_BEARER_FP=%s\\n" "${RELAY_CLOUD_EXPECTED_BEARER_FP:-<unset>}"',
      '  printf "argv=%s\\n" "$*"',
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
    SEALWIRE_PREFLIGHT_FILE: preflightPath,
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
      const preflightRaw = existsSync(preflightPath)
        ? readFileSync(preflightPath, "utf8")
        : null;
      rmSync(workdir, { recursive: true, force: true });
      resolve({
        code,
        stdout,
        stderr,
        broker: parseCaptured(raw),
        preflight: parseCaptured(preflightRaw),
      });
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

test("`sealwire cloud` is a recognized command, not an unknown argument", async () => {
  const { code, stderr } = await runLauncher({ args: ["cloud"] });
  assert.equal(
    code,
    0,
    `expected \`sealwire cloud\` to start the server; exit=${code}\nstderr:\n${stderr}`
  );
  assert.doesNotMatch(
    stderr,
    /unknown argument/,
    "`cloud` must not be rejected as an unknown argument"
  );
});

test("`sealwire cloud` attaches to the hosted broker by default", async () => {
  const { code, broker, preflight, stderr } = await runLauncher({
    args: ["cloud"],
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, HOSTED_BROKER_WS);
  assert.equal(broker.RELAY_BROKER_AUTH_MODE, "public");
  assert.equal(preflight.argv, "cloud-activate");
  assert.equal(preflight.RELAY_CLOUD_ACTIVATION, "1");
  assert.equal(preflight.RELAY_BROKER_CONTROL_URL, HOSTED_BROKER_HTTP);
  assert.equal(preflight.PORT, "<unset>");
  assert.equal(broker.RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION, "1");
  assert.equal(broker.RELAY_CLOUD_EXPECTED_RELAY_ID, "relay-stub");
  assert.equal(broker.RELAY_CLOUD_EXPECTED_BEARER_FP, "abcdef0123456789");
});

test("`sealwire cloud --broker <url>` overrides the hosted default", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://broker.example.com"],
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, "wss://broker.example.com");
});

test("`sealwire cloud` prefers a configured broker origin over the hosted default", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: { AGENT_RELAY_PUBLIC_BROKER_URL: "wss://configured.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, "wss://configured.example.com");
});

test("`sealwire cloud` derives a coherent broker set (ambient RELAY_BROKER_URL cannot split it)", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: {
      RELAY_BROKER_URL: "wss://ambient.example.com",
      RELAY_BROKER_PUBLIC_URL: "wss://split-public.example.com",
      RELAY_BROKER_CONTROL_URL: "https://split-control.example.com",
    },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, HOSTED_BROKER_WS);
  assert.equal(broker.RELAY_BROKER_PUBLIC_URL, HOSTED_BROKER_WS);
  assert.equal(broker.RELAY_BROKER_CONTROL_URL, HOSTED_BROKER_HTTP);
});

test("`sealwire cloud` forces public auth mode over an ambient self_hosted", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: { RELAY_BROKER_AUTH_MODE: "self_hosted" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_AUTH_MODE, "public");
});

test("`sealwire cloud --broker <url>` wins over an ambient RELAY_BROKER_URL for every endpoint", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://flag.example.com"],
    extraEnv: { RELAY_BROKER_URL: "wss://ambient.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, "wss://flag.example.com");
  assert.equal(broker.RELAY_BROKER_PUBLIC_URL, "wss://flag.example.com");
  assert.equal(broker.RELAY_BROKER_CONTROL_URL, "https://flag.example.com");
});

test("`--broker` honors an explicit split-horizon RELAY_BROKER_PUBLIC_URL", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://connect.example.com"],
    extraEnv: { RELAY_BROKER_PUBLIC_URL: "wss://public.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, "wss://connect.example.com");
  assert.equal(broker.RELAY_BROKER_PUBLIC_URL, "wss://public.example.com");
});

test("`--broker` honors an explicit RELAY_BROKER_CONTROL_URL and auth mode", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://connect.example.com"],
    extraEnv: {
      RELAY_BROKER_CONTROL_URL: "https://control.example.com",
      RELAY_BROKER_AUTH_MODE: "self_hosted",
    },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_CONTROL_URL, "https://control.example.com");
  assert.equal(broker.RELAY_BROKER_AUTH_MODE, "self_hosted");
});

test("`--broker` pins the websocket URL to the flag over an ambient RELAY_BROKER_URL", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://flag.example.com"],
    extraEnv: { RELAY_BROKER_URL: "wss://ambient.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_URL, "wss://flag.example.com");
});

test("`sealwire cloud --broker <url>` forces public auth even with ambient self_hosted", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://custom.example.com"],
    extraEnv: { RELAY_BROKER_AUTH_MODE: "self_hosted" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(broker.RELAY_BROKER_AUTH_MODE, "public");
});

test("`sealwire cloud --no-broker` is rejected as contradictory", async () => {
  const { code, stderr } = await runLauncher({
    args: ["cloud", "--no-broker"],
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /cloud/i);
});

test("`sealwire cloud` preflight receives the access key; long-lived child does not", async () => {
  const secret = "cloud-key-must-not-reach-long-lived";
  const { code, broker, preflight, stdout, stderr } = await runLauncher({
    args: ["cloud"],
    extraEnv: { SEALWIRE_CLOUD_ACCESS_KEY: secret },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(preflight.SEALWIRE_CLOUD_ACCESS_KEY, secret);
  assert.equal(preflight.argv, "cloud-activate");
  assert.equal(broker.SEALWIRE_CLOUD_ACCESS_KEY, "<unset>");
  assert.equal(broker.RELAY_LICENSE_CODE, "<unset>");
  assert.equal(broker.RELAY_CLOUD_ACTIVATION, "<unset>");
  assert.equal(broker.argv, "");
  assert.doesNotMatch(stdout + stderr, new RegExp(secret));
});

test("`sealwire local` strips activation secrets so providers cannot inherit them", async () => {
  const secret = "should-not-reach-local-child";
  const { code, broker } = await runLauncher({
    args: ["local"],
    extraEnv: {
      SEALWIRE_CLOUD_ACCESS_KEY: secret,
      RELAY_LICENSE_CODE: secret,
    },
  });
  assert.equal(code, 0);
  assert.equal(broker.SEALWIRE_CLOUD_ACCESS_KEY, "<unset>");
  assert.equal(broker.RELAY_LICENSE_CODE, "<unset>");
});

test("generic `--broker` strips ambient cloud mode and witness envs", async () => {
  const { code, broker, preflight, stderr } = await runLauncher({
    args: ["--broker", "wss://generic.example.com"],
    extraEnv: {
      RELAY_CLOUD_ACTIVATION: "1",
      RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION: "1",
      RELAY_CLOUD_EXPECTED_RELAY_ID: "ambient-relay",
      RELAY_CLOUD_EXPECTED_BEARER_FP: "ambientfp01234567",
      SEALWIRE_CLOUD_ACCESS_KEY: "should-not-matter",
    },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(Object.keys(preflight).length, 0);
  assert.equal(broker.RELAY_BROKER_URL, "wss://generic.example.com");
  assert.equal(broker.RELAY_CLOUD_ACTIVATION, "<unset>");
  assert.equal(broker.RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION, "<unset>");
  assert.equal(broker.RELAY_CLOUD_EXPECTED_RELAY_ID, "<unset>");
  assert.equal(broker.RELAY_CLOUD_EXPECTED_BEARER_FP, "<unset>");
  assert.equal(broker.SEALWIRE_CLOUD_ACCESS_KEY, "<unset>");
});

test("`sealwire cloud` exits nonzero when cloud-activate fails before relay start", async () => {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-cloud-fail-"));
  const stubPath = path.join(workdir, "stub-relay-server");
  writeFileSync(
    stubPath,
    ["#!/bin/sh", 'if [ "$1" = "cloud-activate" ]; then', "  echo activate-failed >&2", "  exit 7", "fi", "exit 0", ""].join(
      "\n"
    )
  );
  chmodSync(stubPath, 0o755);
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [launcher, "cloud", "--no-open"],
      {
        env: {
          HOME: process.env.HOME,
          PATH: workdir,
          AGENT_RELAY_SERVER_BIN: stubPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  rmSync(workdir, { recursive: true, force: true });
  assert.equal(result.code, 7);
  assert.doesNotMatch(result.stdout, /serving local relay/);
});

test("`sealwire cloud` strips activation secrets before PATH probes spawn", async () => {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-probe-env-"));
  const capturePath = path.join(workdir, "probe-env.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  const fakeCodex = path.join(workdir, "codex");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "cloud-activate" ]; then',
      '  printf \'sealwire-cloud-witness:{"v":1,"control_url":"https://app.sealwire.dev","relay_id":"r","broker_room_id":"room","bearer_fingerprint":"abcdef0123456789"}\\n\'',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  writeFileSync(
    fakeCodex,
    [
      "#!/bin/sh",
      '{',
      '  printf "SEALWIRE_CLOUD_ACCESS_KEY=%s\\n" "${SEALWIRE_CLOUD_ACCESS_KEY:-<unset>}"',
      '  printf "RELAY_LICENSE_CODE=%s\\n" "${RELAY_LICENSE_CODE:-<unset>}"',
      '} > "$SEALWIRE_PROBE_ENV_FILE"',
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(stubPath, 0o755);
  chmodSync(fakeCodex, 0o755);

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, "cloud", "--no-open"], {
      env: {
        HOME: process.env.HOME,
        PATH: `${workdir}${path.delimiter}${process.env.PATH || ""}`,
        AGENT_RELAY_SERVER_BIN: stubPath,
        SEALWIRE_PROBE_ENV_FILE: capturePath,
        SEALWIRE_CLOUD_ACCESS_KEY: "must-not-reach-codex-probe",
        RELAY_LICENSE_CODE: "must-not-reach-codex-probe",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });

  const probeRaw = existsSync(capturePath)
    ? readFileSync(capturePath, "utf8")
    : "";
  rmSync(workdir, { recursive: true, force: true });
  assert.equal(result.code, 0, `exit=${result.code}\nstderr:\n${result.stderr}`);
  assert.match(probeRaw, /SEALWIRE_CLOUD_ACCESS_KEY=<unset>/);
  assert.match(probeRaw, /RELAY_LICENSE_CODE=<unset>/);
});

test("broker URL with userinfo is rejected without echoing credentials", async () => {
  const { code, stdout, stderr } = await runLauncher({
    args: ["cloud", "--broker", "wss://user:s3cret@broker.example.com"],
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /userinfo|username or password/i);
  assert.doesNotMatch(stdout + stderr, /s3cret/);
  assert.doesNotMatch(stdout + stderr, /user:s3cret/);
});
