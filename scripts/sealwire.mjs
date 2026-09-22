#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { browserOpenerFor } from "./sealwire-browser.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const userCwd = process.cwd();
const require = createRequire(import.meta.url);

const DEFAULT_PUBLIC_BROKER_ORIGIN = "";
// The hosted SealWire Cloud broker `sealwire cloud` dials when the user has not
// configured a broker origin of their own. `cloud` is an explicit "go online"
// request (the mirror image of `local`), so it defaults to the hosted broker
// rather than falling back to a localhost-only relay.
const HOSTED_PUBLIC_BROKER_ORIGIN = "wss://app.sealwire.dev";
const defaultPort = "8787";
const defaultHost = "127.0.0.1";
const LAUNCH_ID_ENV = "SEALWIRE_LAUNCH_ID";
const KNOWN_COMMANDS = new Set(["local", "cloud"]);
/** Preferred generic automation input for cloud activation (consumed by cloud-activate). */
const CLOUD_ACCESS_KEY_ENV = "SEALWIRE_CLOUD_ACCESS_KEY";
const CLOUD_ACCESS_KEY_FILE_ENV = "SEALWIRE_CLOUD_ACCESS_KEY_FILE";
/** Explicit cloud-link mode — only `sealwire cloud` sets this for preflight. */
const CLOUD_ACTIVATION_ENV = "RELAY_CLOUD_ACTIVATION";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.rest.length > 0) {
  console.error(`sealwire: unknown argument: ${args.rest[0]}`);
  console.error("Run `sealwire --help` for usage.");
  process.exit(2);
}

if (args.cloud && args.noBroker) {
  // `cloud` (go online) and `local`/`--no-broker` (stay offline) are opposite
  // intents; accepting both would silently pick one and surprise the user.
  console.error(
    "sealwire: `cloud` cannot be combined with `local`/`--no-broker`; pick one."
  );
  process.exit(2);
}

if (args.unbind) {
  if (!args.cloud) {
    console.error("sealwire: `unbind` is only valid as `sealwire cloud unbind`.");
    process.exit(2);
  }
  process.exit(runCloudUnbind());
}

// Capture activation inputs immediately after argument validation and BEFORE any
// binary/PATH probes that spawn subprocesses (cargo/codex --version inherit env).
let capturedAccessKey = process.env[CLOUD_ACCESS_KEY_ENV] ?? null;
let capturedAccessKeyFile = process.env[CLOUD_ACCESS_KEY_FILE_ENV] ?? null;
delete process.env[CLOUD_ACCESS_KEY_ENV];
delete process.env[CLOUD_ACCESS_KEY_FILE_ENV];
// Scrub-only: removed legacy commercial name must never reach children or be
// forwarded as an activation input.
delete process.env.RELAY_LICENSE_CODE;
// Strip ambient cloud mode/witness from the parent process immediately so they
// cannot leak into PATH probes or non-cloud children.
delete process.env[CLOUD_ACTIVATION_ENV];
delete process.env.RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION;
delete process.env.RELAY_CLOUD_EXPECTED_CONTROL_URL;
delete process.env.RELAY_CLOUD_EXPECTED_RELAY_ID;
delete process.env.RELAY_CLOUD_EXPECTED_ROOM_ID;
delete process.env.RELAY_CLOUD_EXPECTED_BEARER_FP;

if (!args.cloud) {
  // Non-cloud modes never consume captured secrets — drop reachable plaintext now.
  capturedAccessKey = null;
  capturedAccessKeyFile = null;
}

const relayServerBinary = resolveRelayServerBinary();
if (!relayServerBinary) {
  ensureCommand(
    "cargo",
    "No prebuilt relay-server binary was found, and Rust/Cargo is required for the source fallback."
  );
}
if (!hasCommand("codex")) {
  console.warn(
    "sealwire: Codex CLI not found on PATH — Codex sessions will be unavailable. " +
      "Install and log in to the Codex CLI to enable them. " +
      "Claude Code sessions run via the bundled worker (requires Claude auth)."
  );
}

const brokerOrigin =
  args.broker ||
  process.env.AGENT_RELAY_PUBLIC_BROKER_URL ||
  process.env.AGENT_RELAY_PUBLIC_BROKER_ORIGIN ||
  process.env.npm_package_config_public_broker_origin ||
  readPackagedBrokerOrigin() ||
  (args.cloud ? HOSTED_PUBLIC_BROKER_ORIGIN : DEFAULT_PUBLIC_BROKER_ORIGIN);
const brokerConfig = args.noBroker || !brokerOrigin ? null : normalizeBrokerOrigin(brokerOrigin);
const launchId = randomUUID();

const env = {
  ...process.env,
  PORT: args.port || process.env.PORT || defaultPort,
  BIND_HOST: args.host || process.env.BIND_HOST || defaultHost,
  RELAY_SECURITY_MODE: process.env.RELAY_SECURITY_MODE || "private",
  RELAY_BROKER_PEER_ID: process.env.RELAY_BROKER_PEER_ID || defaultPeerId(),
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || defaultCargoTargetDir(),
  [LAUNCH_ID_ENV]: launchId,
};
stripActivationSecrets(env);

// OFF is *absence*, not "SEALWIRE_BETA=0", so this can never re-lock a user who
// set the variable themselves (dev scripts do).
if (args.beta) {
  env.SEALWIRE_BETA = "1";
}

// Point the relay-server at the Claude worker shipped inside this package.
// Without this, the binary falls back to a compile-time path baked in at build
// time (the CI machine's checkout), which never exists on a user's machine —
// so Claude Code sessions would silently fail. Respect a user-provided override
// (already carried in via ...process.env above).
const packagedClaudeWorker = path.join(packageRoot, "claude-worker", "worker.mjs");
if (!process.env.CLAUDE_WORKER_PATH && existsSync(packagedClaudeWorker)) {
  env.CLAUDE_WORKER_PATH = packagedClaudeWorker;
}

if (brokerConfig) {
  // The resolved origin (--broker, `cloud`'s hosted default, or a configured/
  // packaged origin — the resolution above never consults an ambient
  // RELAY_BROKER_URL) is authoritative for the websocket CONNECTION URL: an
  // explicit --broker or configured broker origin wins over a stray ambient
  // RELAY_BROKER_URL, so the live connection can never land on a broker you
  // didn't ask for.
  env.RELAY_BROKER_URL = brokerConfig.websocketUrl;

  if (args.cloud) {
    // `cloud` == the hosted SealWire Cloud broker: a single, fully-managed coherent set
    // (mirrors the desktop launcher) — public/control follow the same origin and
    // it always uses public auth (an inherited self_hosted would dial the hosted
    // broker with the wrong auth). Custom self-hosted brokers go through plain
    // `--broker`.
    env.RELAY_BROKER_PUBLIC_URL = brokerConfig.websocketUrl;
    env.RELAY_BROKER_CONTROL_URL = brokerConfig.controlUrl;
    env.RELAY_BROKER_AUTH_MODE = "public";
  } else {
    // Generic `--broker` / configured origin: still honor explicit endpoint/auth
    // overrides so documented split-horizon setups (an externally reachable
    // RELAY_BROKER_PUBLIC_URL for pairing links, a separate control host) and
    // self-hosted auth keep working. Only the websocket URL above is pinned to
    // the resolved origin.
    env.RELAY_BROKER_PUBLIC_URL = process.env.RELAY_BROKER_PUBLIC_URL || brokerConfig.websocketUrl;
    env.RELAY_BROKER_CONTROL_URL =
      process.env.RELAY_BROKER_CONTROL_URL || brokerConfig.controlUrl;
    env.RELAY_BROKER_AUTH_MODE = process.env.RELAY_BROKER_AUTH_MODE || "public";
  }
} else if (args.noBroker) {
  // Explicit local intent (`sealwire local` / `--no-broker`): the relay-server
  // connects to a broker whenever RELAY_BROKER_URL is present in its environment
  // (crates/relay-server/src/broker.rs), so a stray value forwarded from the
  // caller's shell would silently defeat local mode. Strip EVERY RELAY_BROKER_*
  // variable, matched case-insensitively:
  //   - case-insensitive because Windows environment names are case-insensitive,
  //     so an ambient `relay_broker_url` would otherwise survive and reappear to
  //     the child as RELAY_BROKER_URL (Windows is a supported target);
  //   - the whole prefix (not a hand-picked list) because this env is inherited
  //     by spawned provider processes too, so broker identity, ticket secrets,
  //     and registration/identity paths should not linger either.
  stripBrokerEnv(env);
  console.log(
    "sealwire: local mode — no public broker; remote pairing disabled."
  );
} else {
  console.warn(
    "sealwire: no public broker configured; starting localhost-only relay. " +
      "Set AGENT_RELAY_PUBLIC_BROKER_URL or pass `--broker` to enable remote pairing."
  );
}

if (args.cloud) {
  const activate = runCloudActivate({
    brokerConfig,
    relayServerBinary,
    accessKey: capturedAccessKey,
    accessKeyFile: capturedAccessKeyFile,
    baseEnv: env,
  });
  // Drop reachable plaintext from the long-lived Node parent after preflight.
  capturedAccessKey = null;
  capturedAccessKeyFile = null;
  if (activate.code !== 0) {
    process.exit(activate.code);
  }
  if (activate.witness) {
    env.RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION = "1";
    env.RELAY_CLOUD_EXPECTED_CONTROL_URL = activate.witness.control_url;
    env.RELAY_CLOUD_EXPECTED_RELAY_ID = activate.witness.relay_id;
    env.RELAY_CLOUD_EXPECTED_ROOM_ID = activate.witness.broker_room_id;
    env.RELAY_CLOUD_EXPECTED_BEARER_FP = activate.witness.bearer_fingerprint;
  } else {
    console.error(
      "sealwire: cloud activation succeeded but did not emit a launch witness; refusing to start."
    );
    process.exit(1);
  }
}

console.log(`sealwire: serving local relay at http://${env.BIND_HOST}:${env.PORT}`);
if (brokerConfig) {
  console.log(`sealwire: using public broker ${brokerConfig.controlUrl}`);
}
// The launch directory is the default workspace for new sessions, but it is NOT
// where relay state lives: state is shared per machine (`~/.agent-relay/`, or
// RELAY_STATE_PATH) so `cd` never forks your sessions, projects, paired devices
// or push key. Print both so neither is a surprise.
console.log(`sealwire: workspace directory is ${userCwd}`);
console.log(
  `sealwire: relay state is ${
    process.env.RELAY_STATE_PATH ||
    path.join(os.homedir(), ".agent-relay", "session.json")
  } (shared across launch directories; set RELAY_STATE_PATH to isolate)`
);

const command = relayServerBinary || "cargo";
const commandArgs = relayServerBinary
  ? []
  : [
      "run",
      "--release",
      "--manifest-path",
      path.join(packageRoot, "Cargo.toml"),
      "-p",
      "relay-server",
    ];
if (relayServerBinary) {
  console.log(`sealwire: starting bundled relay-server binary ${relayServerBinary}`);
} else {
  console.warn("sealwire: starting relay-server via cargo fallback; install a prebuilt package to avoid Rust/Cargo.");
}

const child = spawn(command, commandArgs, {
  cwd: userCwd,
  env,
  stdio: "inherit",
});

if (!args.noOpen && !isCiEnvironment()) {
  openBrowserWhenRelayIsReady(child, env.BIND_HOST, env.PORT, launchId);
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function parseArgs(argv) {
  const parsed = {
    beta: false,
    broker: null,
    cloud: false,
    command: null,
    help: false,
    host: null,
    noBroker: false,
    noOpen: false,
    port: null,
    rest: [],
    unbind: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--beta") {
      // A modifier, not a mode: orthogonal to local/cloud, so
      // `sealwire cloud --beta` has to be expressible.
      parsed.beta = true;
    } else if (arg === "--no-broker") {
      parsed.noBroker = true;
    } else if (arg === "--no-open") {
      parsed.noOpen = true;
    } else if (
      parsed.command === null &&
      !arg.startsWith("-") &&
      KNOWN_COMMANDS.has(arg)
    ) {
      // The only positional we accept is a leading subcommand.
      //   `local` — friendly alias for `--no-broker`: run a localhost-only
      //     relay and never reach for a broker, even if one is configured.
      //   `cloud` — the mirror image: an explicit "go online" request that
      //     attaches to the hosted SealWire Cloud broker (defaulting to it when the
      //     user has configured no broker origin of their own).
      //   `cloud unbind` — release cloud access without starting the relay.
      parsed.command = arg;
      if (arg === "local") {
        parsed.noBroker = true;
      } else if (arg === "cloud") {
        parsed.cloud = true;
      }
    } else if (
      parsed.cloud &&
      !parsed.unbind &&
      !arg.startsWith("-") &&
      arg === "unbind"
    ) {
      parsed.unbind = true;
    } else if (arg === "--broker") {
      parsed.broker = requireValue(argv, (index += 1), arg);
    } else if (arg.startsWith("--broker=")) {
      parsed.broker = arg.slice("--broker=".length);
    } else if (arg === "--host") {
      parsed.host = requireValue(argv, (index += 1), arg);
    } else if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      parsed.port = requireValue(argv, (index += 1), arg);
    } else if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
    } else {
      parsed.rest.push(arg);
    }
  }

  return parsed;
}

/**
 * Short-lived cloud activation before the long-lived relay starts. Fails the
 * whole `sealwire cloud` command (no browser/UI) when enrollment cannot proceed.
 * Returns `{ code, witness }` — witness is secret-free registration fingerprint.
 */
function runCloudActivate({
  brokerConfig,
  relayServerBinary,
  accessKey,
  accessKeyFile,
  baseEnv,
}) {
  if (!brokerConfig) {
    console.error("sealwire: cloud activation requires a broker origin");
    return { code: 1, witness: null };
  }

  const preflightEnv = {
    ...baseEnv,
    RELAY_BROKER_URL: brokerConfig.websocketUrl,
    RELAY_BROKER_PUBLIC_URL: brokerConfig.websocketUrl,
    RELAY_BROKER_CONTROL_URL: brokerConfig.controlUrl,
    RELAY_BROKER_AUTH_MODE: "public",
    [CLOUD_ACTIVATION_ENV]: "1",
  };
  // Do not inherit PORT bind for preflight — it must not open the long-lived UI.
  delete preflightEnv.PORT;
  delete preflightEnv.BIND_HOST;
  delete preflightEnv[LAUNCH_ID_ENV];
  // Never forward removed legacy commercial env as an activation input.
  delete preflightEnv.RELAY_LICENSE_CODE;

  if (accessKey) {
    preflightEnv[CLOUD_ACCESS_KEY_ENV] = accessKey;
  }
  if (accessKeyFile) {
    preflightEnv[CLOUD_ACCESS_KEY_FILE_ENV] = accessKeyFile;
  }

  const command = relayServerBinary || "cargo";
  const commandArgs = relayServerBinary
    ? ["cloud-activate"]
    : [
        "run",
        "--release",
        "--manifest-path",
        path.join(packageRoot, "Cargo.toml"),
        "-p",
        "relay-server",
        "--",
        "cloud-activate",
      ];

  console.log(
    `sealwire: checking SealWire Cloud access for ${brokerConfig.controlUrl}`
  );
  const result = spawnSync(command, commandArgs, {
    cwd: userCwd,
    env: preflightEnv,
    encoding: "utf8",
    // stderr inherits so user-facing status lines stay interactive; stdout is
    // captured for the secret-free launch witness line.
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) {
    console.error(`sealwire: cloud activation failed: ${result.error.message}`);
    return { code: 1, witness: null };
  }
  const stdout = result.stdout || "";
  if (stdout) {
    process.stdout.write(stdout);
  }
  const witness = parseCloudLaunchWitness(stdout);
  return { code: result.status ?? 1, witness };
}

function parseCloudLaunchWitness(stdout) {
  const prefix = "sealwire-cloud-witness:";
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    try {
      const payload = JSON.parse(line.slice(prefix.length));
      if (
        payload &&
        typeof payload.control_url === "string" &&
        typeof payload.relay_id === "string" &&
        typeof payload.broker_room_id === "string" &&
        typeof payload.bearer_fingerprint === "string" &&
        payload.control_url &&
        payload.relay_id &&
        payload.broker_room_id &&
        payload.bearer_fingerprint
      ) {
        return {
          control_url: payload.control_url,
          relay_id: payload.relay_id,
          broker_room_id: payload.broker_room_id,
          bearer_fingerprint: payload.bearer_fingerprint,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function stripActivationSecrets(env) {
  delete env[CLOUD_ACCESS_KEY_ENV];
  delete env[CLOUD_ACCESS_KEY_FILE_ENV];
  // Scrub-only denylist entry: never an activation input after Round 4A.
  delete env.RELAY_LICENSE_CODE;
  delete env[CLOUD_ACTIVATION_ENV];
  delete env.RELAY_CLOUD_REQUIRE_CACHED_REGISTRATION;
  delete env.RELAY_CLOUD_EXPECTED_CONTROL_URL;
  delete env.RELAY_CLOUD_EXPECTED_RELAY_ID;
  delete env.RELAY_CLOUD_EXPECTED_ROOM_ID;
  delete env.RELAY_CLOUD_EXPECTED_BEARER_FP;
}

/**
 * Release SealWire Cloud access for the selected control origin. Does not start
 * the local relay or open a browser. Reuses relay-server's registration path
 * and access-release client (`cloud-access-release` subcommand).
 */
function runCloudUnbind() {
  // Scrub activation secrets before any cargo/binary probe spawns.
  delete process.env[CLOUD_ACCESS_KEY_ENV];
  delete process.env[CLOUD_ACCESS_KEY_FILE_ENV];
  delete process.env.RELAY_LICENSE_CODE;

  const brokerOrigin =
    args.broker ||
    process.env.AGENT_RELAY_PUBLIC_BROKER_URL ||
    process.env.AGENT_RELAY_PUBLIC_BROKER_ORIGIN ||
    process.env.npm_package_config_public_broker_origin ||
    readPackagedBrokerOrigin() ||
    HOSTED_PUBLIC_BROKER_ORIGIN;
  const brokerConfig = normalizeBrokerOrigin(brokerOrigin);

  const relayServerBinary = resolveRelayServerBinary();
  if (!relayServerBinary) {
    ensureCommand(
      "cargo",
      "No prebuilt relay-server binary was found, and Rust/Cargo is required for the source fallback."
    );
  }

  const env = {
    ...process.env,
    RELAY_BROKER_CONTROL_URL: brokerConfig.controlUrl,
    RELAY_BROKER_AUTH_MODE: "public",
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || defaultCargoTargetDir(),
  };
  stripActivationSecrets(env);

  const command = relayServerBinary || "cargo";
  const commandArgs = relayServerBinary
    ? ["cloud-access-release"]
    : [
        "run",
        "--release",
        "--manifest-path",
        path.join(packageRoot, "Cargo.toml"),
        "-p",
        "relay-server",
        "--",
        "cloud-access-release",
      ];

  console.log(
    `sealwire: unbinding cloud access for ${brokerConfig.controlUrl} (does not start the local relay)`
  );
  const result = spawnSync(command, commandArgs, {
    cwd: userCwd,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`sealwire: failed to run cloud unbind: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function stripBrokerEnv(env) {
  // Delete every key whose name — uppercased — begins with RELAY_BROKER_. The
  // uppercasing makes this correct on Windows, where `relay_broker_url` and
  // `RELAY_BROKER_URL` name the same variable and the relay-server would read
  // either as the broker URL.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("RELAY_BROKER_")) {
      delete env[key];
    }
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    console.error(`sealwire: ${flag} requires a value.`);
    process.exit(2);
  }
  return value;
}

function normalizeBrokerOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.error(
      "sealwire: invalid broker URL (could not parse; credentials if present were not logged)."
    );
    process.exit(2);
  }

  if (parsed.username || parsed.password) {
    console.error(
      "sealwire: broker URL must not include username or password (userinfo)."
    );
    process.exit(2);
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";

  const protocol = parsed.protocol.toLowerCase();
  if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
    console.error("sealwire: broker URL must start with http://, https://, ws://, or wss://.");
    process.exit(2);
  }

  const controlUrl = new URL(parsed);
  controlUrl.protocol = protocol === "ws:" ? "http:" : protocol === "wss:" ? "https:" : protocol;

  const websocketUrl = new URL(parsed);
  websocketUrl.protocol =
    protocol === "http:" ? "ws:" : protocol === "https:" ? "wss:" : protocol;

  return {
    controlUrl: controlUrl.toString().replace(/\/$/, ""),
    websocketUrl: websocketUrl.toString().replace(/\/$/, ""),
  };
}

function ensureCommand(command, message) {
  if (!hasCommand(command)) {
    console.error(`sealwire: ${message}`);
    process.exit(1);
  }
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.error?.code !== "ENOENT";
}

function isCiEnvironment() {
  const value = process.env.CI?.trim().toLowerCase();
  return Boolean(value && !["0", "false", "no", "off"].includes(value));
}

function openBrowserWhenRelayIsReady(relayChild, bindHost, portValue, launchId) {
  const target = localBrowserTarget(bindHost, portValue);
  if (!target) {
    console.warn(
      "sealwire: cannot auto-open the browser when PORT is 0; open the relay URL manually."
    );
    return;
  }

  let stopped = false;
  let retryTimer = null;
  const stop = () => {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
  };
  relayChild.once("exit", stop);

  const check = async () => {
    if (stopped) {
      return;
    }
    if (await isRelayReady(target.healthUrl, launchId)) {
      if (!stopped) {
        relayChild.off("exit", stop);
        openBrowser(target.browserUrl);
      }
      return;
    }
    retryTimer = setTimeout(check, 250);
  };

  // Let immediately-failing launches exit before probing. This also avoids
  // mistaking an unrelated process already on the requested port for the
  // relay in the common bind-conflict case.
  retryTimer = setTimeout(check, 100);
}

function localBrowserTarget(bindHost, portValue) {
  const parsedPort = parseRelayPort(portValue);
  if (parsedPort === 0) {
    return null;
  }

  const parsedHost = isIP(bindHost) ? bindHost : defaultHost;
  let browserHost = parsedHost;
  if (parsedHost === "0.0.0.0") {
    browserHost = defaultHost;
  } else if (parsedHost === "::") {
    browserHost = "::1";
  }
  const urlHost = isIP(browserHost) === 6 ? `[${browserHost}]` : browserHost;
  const browserUrl = `http://${urlHost}:${parsedPort}`;
  return {
    browserUrl,
    healthUrl: `${browserUrl}/api/health`,
  };
}

function parseRelayPort(value) {
  const text = String(value);
  if (/^\d+$/.test(text)) {
    const parsed = Number(text);
    if (parsed <= 65535) {
      return parsed;
    }
  }
  // Match relay-server's current behavior: an invalid PORT falls back to 8787.
  return Number(defaultPort);
}

function isRelayReady(healthUrl, launchId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (!settled) {
        settled = true;
        resolve(ready);
      }
    };
    const request = http.get(
      healthUrl,
      { headers: { accept: "application/json" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            request.destroy();
          }
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body);
            finish(
              response.statusCode === 200 &&
                payload?.ok === true &&
                payload?.data?.status === "ok" &&
                payload?.data?.service === "relay-server" &&
                payload?.data?.launch_id === launchId
            );
          } catch {
            finish(false);
          }
        });
        response.on("aborted", () => finish(false));
        response.on("error", () => finish(false));
      }
    );
    request.setTimeout(750, () => request.destroy());
    request.on("error", () => finish(false));
  });
}

function openBrowser(url) {
  const { command, args: commandArgs } = browserOpenerFor(process.platform, url);

  const opener = spawn(command, commandArgs, {
    detached: true,
    stdio: "ignore",
  });
  opener.once("spawn", () => {
    console.log(`sealwire: opening ${url} in your default browser`);
  });
  opener.once("error", (error) => {
    console.warn(
      `sealwire: could not open the browser (${error.message}); open ${url} manually.`
    );
  });
  opener.once("exit", (code) => {
    if (code && code !== 0) {
      console.warn(
        `sealwire: browser opener exited with code ${code}; open ${url} manually.`
      );
    }
  });
  opener.unref();
}

function resolveRelayServerBinary() {
  const override = process.env.AGENT_RELAY_SERVER_BIN;
  if (override) {
    if (existsSync(override)) {
      return override;
    }
    console.error(`sealwire: AGENT_RELAY_SERVER_BIN does not exist: ${override}`);
    process.exit(1);
  }

  const executable = process.platform === "win32" ? "relay-server.exe" : "relay-server";
  const platformTarget = platformBinaryTarget();
  if (platformTarget) {
    const localPlatformBinary = path.join(packageRoot, "bin", platformTarget, executable);
    if (existsSync(localPlatformBinary)) {
      return localPlatformBinary;
    }
  }

  const localBinary = path.join(packageRoot, "bin", executable);
  if (existsSync(localBinary)) {
    return localBinary;
  }

  const platformPackageName = platformBinaryPackageName();
  if (!platformPackageName) {
    return null;
  }

  try {
    return require.resolve(`${platformPackageName}/bin/${executable}`);
  } catch {
    return null;
  }
}

function platformBinaryPackageName() {
  const target = platformBinaryTarget();
  if (!target) {
    return null;
  }
  return `@sealwire/relay-${target}`;
}

function platformBinaryTarget() {
  const platform = process.platform;
  const arch = process.arch;
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ]);
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) {
    return null;
  }
  return target;
}

function readPackagedBrokerOrigin() {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8")
    );
    return packageJson.config?.public_broker_origin || null;
  } catch {
    return null;
  }
}

function defaultPeerId() {
  const hostname = os.hostname().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return hostname ? `local-relay-${hostname}` : "local-relay";
}

function defaultCargoTargetDir() {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : path.join(os.homedir(), ".cache"));
  return path.join(cacheRoot, "agent-relay", "cargo-target");
}

function printHelp() {
  console.log(`sealwire

Run a local relay-server from the npm package.

Usage:
  sealwire [local|cloud] [--beta] [--broker <url>] [--port <port>] [--host <ip>] [--no-broker] [--no-open]
  sealwire cloud unbind [--broker <url>]

Commands:
  local         Run with no broker; remote pairing is disabled (alias for
                --no-broker). Ignores any configured broker origin and strips
                every RELAY_BROKER_* variable (case-insensitively) so the relay
                never dials out. Does not change the bind host — pass --host to
                control network exposure.
  cloud         Attach to the hosted SealWire Cloud broker so remote devices can pair
                (the opposite of local). Uses a configured broker origin if one
                is set (--broker / AGENT_RELAY_PUBLIC_BROKER_URL / packaged
                default); otherwise falls back to ${HOSTED_PUBLIC_BROKER_ORIGIN}.
                Runs a short-lived cloud-activate preflight first: prompts for a
                SealWire Cloud access key (echo disabled) unless
                SEALWIRE_CLOUD_ACCESS_KEY or SEALWIRE_CLOUD_ACCESS_KEY_FILE is
                set. Non-TTY without a key exits nonzero before the local relay
                starts. Cannot be combined with local/--no-broker.
  cloud unbind  Release this machine's SealWire Cloud access for the selected
                control origin and remove the local registration cache. Does
                not start the local relay or open a browser. Preserves the
                relay identity key for later re-enrollment.

Flags:
  --beta        Unlock in-development features (currently: Tasks). Off by
                default, where those features appear as a blurred preview
                labelled "in development" rather than being hidden. Combine
                freely with local/cloud. Equivalent to SEALWIRE_BETA=1.

Defaults:
  --host        127.0.0.1
  --port        8787
  --broker      AGENT_RELAY_PUBLIC_BROKER_URL, if set by the package publisher or user
  browser       Opens the local web UI once the relay is ready; pass --no-open
                to keep it closed (browser opening is also skipped in CI)

Binary resolution:
  Uses AGENT_RELAY_SERVER_BIN, a package-local bin/<platform>-<arch>/relay-server,
  package-local bin/relay-server, or an installed @sealwire/relay-<platform>-<arch>
  package. Falls back to Cargo only when no prebuilt binary is present.

Examples:
  sealwire
  sealwire local
  sealwire cloud
  sealwire cloud unbind
  SEALWIRE_CLOUD_ACCESS_KEY=... sealwire cloud --no-open
  sealwire --broker https://broker.example.com
  AGENT_RELAY_PUBLIC_BROKER_URL=https://broker.example.com npx sealwire
  sealwire --no-broker
  sealwire --no-open
  sealwire --beta
  sealwire cloud --beta
`);
}
