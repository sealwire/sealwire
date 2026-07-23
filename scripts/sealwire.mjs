#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const userCwd = process.cwd();
const require = createRequire(import.meta.url);

const DEFAULT_PUBLIC_BROKER_ORIGIN = "";
const defaultPort = "8787";
const defaultHost = "127.0.0.1";
const KNOWN_COMMANDS = new Set(["local"]);

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
  DEFAULT_PUBLIC_BROKER_ORIGIN;
const brokerConfig = args.noBroker || !brokerOrigin ? null : normalizeBrokerOrigin(brokerOrigin);

const env = {
  ...process.env,
  PORT: args.port || process.env.PORT || defaultPort,
  BIND_HOST: args.host || process.env.BIND_HOST || defaultHost,
  RELAY_SECURITY_MODE: process.env.RELAY_SECURITY_MODE || "private",
  RELAY_BROKER_PEER_ID: process.env.RELAY_BROKER_PEER_ID || defaultPeerId(),
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || defaultCargoTargetDir(),
};

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
  env.RELAY_BROKER_URL = process.env.RELAY_BROKER_URL || brokerConfig.websocketUrl;
  env.RELAY_BROKER_PUBLIC_URL = process.env.RELAY_BROKER_PUBLIC_URL || brokerConfig.websocketUrl;
  env.RELAY_BROKER_CONTROL_URL =
    process.env.RELAY_BROKER_CONTROL_URL || brokerConfig.controlUrl;
  env.RELAY_BROKER_AUTH_MODE = process.env.RELAY_BROKER_AUTH_MODE || "public";
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
      "Set AGENT_RELAY_PUBLIC_BROKER_URL or pass --broker to enable remote pairing."
  );
}

console.log(`sealwire: serving local relay at http://${env.BIND_HOST}:${env.PORT}`);
if (brokerConfig) {
  console.log(`sealwire: using public broker ${brokerConfig.controlUrl}`);
}
console.log(`sealwire: workspace/state directory is ${userCwd}`);

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

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function parseArgs(argv) {
  const parsed = {
    broker: null,
    command: null,
    help: false,
    host: null,
    noBroker: false,
    port: null,
    rest: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--no-broker") {
      parsed.noBroker = true;
    } else if (
      parsed.command === null &&
      !arg.startsWith("-") &&
      KNOWN_COMMANDS.has(arg)
    ) {
      // The only positional we accept is a leading subcommand. `local` is a
      // friendly alias for `--no-broker`: run a localhost-only relay and never
      // reach for a public broker, even if one is configured.
      parsed.command = arg;
      if (arg === "local") {
        parsed.noBroker = true;
      }
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
  } catch (error) {
    console.error(`sealwire: invalid broker URL \`${value}\`: ${error.message}`);
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
  sealwire [local] [--broker <url>] [--port <port>] [--host <ip>] [--no-broker]

Commands:
  local         Run with no public broker; remote pairing is disabled (alias for
                --no-broker). Ignores any configured broker origin and strips
                every RELAY_BROKER_* variable (case-insensitively) so the relay
                never dials out. Does not change the bind host — pass --host to
                control network exposure.

Defaults:
  --host        127.0.0.1
  --port        8787
  --broker      AGENT_RELAY_PUBLIC_BROKER_URL, if set by the package publisher or user

Binary resolution:
  Uses AGENT_RELAY_SERVER_BIN, a package-local bin/<platform>-<arch>/relay-server,
  package-local bin/relay-server, or an installed @sealwire/relay-<platform>-<arch>
  package. Falls back to Cargo only when no prebuilt binary is present.

Examples:
  sealwire
  sealwire local
  sealwire --broker https://broker.example.com
  AGENT_RELAY_PUBLIC_BROKER_URL=https://broker.example.com npx sealwire
  sealwire --no-broker
`);
}
