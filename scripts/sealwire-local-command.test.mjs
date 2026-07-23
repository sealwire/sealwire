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

// Black-box drive the launcher with a stub standing in for the compiled
// relay-server binary. The relay-server connects to a broker only when
// RELAY_BROKER_URL is present in its environment
// (crates/relay-server/src/broker.rs), so the stub records the broker-related
// variables it was handed and exits 0. We probe both the canonical
// `RELAY_BROKER_URL` and the lowercase `relay_broker_url` because Windows
// environment names are case-insensitive: on that platform a lowercase stray
// would reappear to the server as the broker URL, so the launcher must strip it
// too. The stub uses only shell builtins (printf) because PATH is intentionally
// bare — no external commands are resolvable.
function runLauncher({ extraEnv = {}, args = [] } = {}) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), "sealwire-local-"));
  const capturePath = path.join(workdir, "captured-broker.txt");
  const stubPath = path.join(workdir, "stub-relay-server");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      "{",
      '  printf "RELAY_BROKER_URL=%s\\n" "${RELAY_BROKER_URL:-<unset>}"',
      '  printf "relay_broker_url=%s\\n" "${relay_broker_url:-<unset>}"',
      '  printf "RELAY_BROKER_PEER_ID=%s\\n" "${RELAY_BROKER_PEER_ID:-<unset>}"',
      '  printf "RELAY_BROKER_TICKET_SECRET=%s\\n" "${RELAY_BROKER_TICKET_SECRET:-<unset>}"',
      '} > "$SEALWIRE_CAPTURE_FILE"',
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(stubPath, 0o755);

  const env = {
    HOME: process.env.HOME,
    PATH: workdir, // no codex, no cargo — the stub needs no external commands
    AGENT_RELAY_SERVER_BIN: stubPath,
    SEALWIRE_CAPTURE_FILE: capturePath,
    ...extraEnv,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args], {
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
      resolve({ code, stdout, stderr, broker: parseCaptured(raw) });
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

test("`sealwire local` is a recognized command, not an unknown argument", async () => {
  const { code, stderr } = await runLauncher({ args: ["local"] });
  assert.equal(
    code,
    0,
    `expected \`sealwire local\` to start the server; exit=${code}\nstderr:\n${stderr}`
  );
  assert.doesNotMatch(
    stderr,
    /unknown argument/,
    "`local` must not be rejected as an unknown argument"
  );
});

test("`sealwire local` ignores a configured public broker origin", async () => {
  // A publisher (or the user) configured a broker origin, but `local` is an
  // explicit "stay offline" request and must win over it.
  const { code, broker, stderr } = await runLauncher({
    args: ["local"],
    extraEnv: { AGENT_RELAY_PUBLIC_BROKER_URL: "wss://broker.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "<unset>",
    "`sealwire local` must not hand the server any RELAY_BROKER_URL"
  );
});

test("`sealwire local` strips an ambient RELAY_BROKER_URL so it cannot leak", async () => {
  // The relay-server connects whenever RELAY_BROKER_URL is present in its
  // environment. Because the launcher forwards process.env, a stray broker URL
  // in the caller's shell would otherwise silently defeat local mode.
  const { code, broker, stderr } = await runLauncher({
    args: ["local"],
    extraEnv: { RELAY_BROKER_URL: "wss://leaked.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "<unset>",
    "`sealwire local` must strip an ambient RELAY_BROKER_URL from the child env"
  );
});

test("`sealwire local` strips a lowercase broker var (Windows case-insensitivity)", async () => {
  // Windows environment names are case-insensitive, so an ambient
  // `relay_broker_url` is the SAME variable as RELAY_BROKER_URL to the
  // relay-server. The launcher must delete it regardless of case.
  const { code, broker, stderr } = await runLauncher({
    args: ["local"],
    extraEnv: { relay_broker_url: "wss://lowercase-leak.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.relay_broker_url,
    "<unset>",
    "`sealwire local` must strip broker vars case-insensitively"
  );
});

test("`sealwire local` strips broker identity/secret vars, not just the URL", async () => {
  // The child env is inherited by spawned provider processes, so broker
  // identity and ticket secrets must not linger in local mode. RELAY_BROKER_PEER_ID
  // is also set by the launcher itself, so it must be stripped afterwards too.
  const { code, broker, stderr } = await runLauncher({
    args: ["local"],
    extraEnv: { RELAY_BROKER_TICKET_SECRET: "top-secret" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_TICKET_SECRET,
    "<unset>",
    "`sealwire local` must strip RELAY_BROKER_TICKET_SECRET"
  );
  assert.equal(
    broker.RELAY_BROKER_PEER_ID,
    "<unset>",
    "`sealwire local` must strip the RELAY_BROKER_PEER_ID the launcher would set"
  );
});

test("`--no-broker` alias also strips an ambient broker URL", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--no-broker"],
    extraEnv: { RELAY_BROKER_URL: "wss://leaked.example.com" },
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "<unset>",
    "`--no-broker` must strip an ambient RELAY_BROKER_URL just like `local`"
  );
});

test("`--broker <url>` still connects (local command did not break remote mode)", async () => {
  const { code, broker, stderr } = await runLauncher({
    args: ["--broker", "wss://broker.example.com"],
  });
  assert.equal(code, 0, `exit=${code}\nstderr:\n${stderr}`);
  assert.equal(
    broker.RELAY_BROKER_URL,
    "wss://broker.example.com",
    "`--broker` must still forward RELAY_BROKER_URL to the server"
  );
});
