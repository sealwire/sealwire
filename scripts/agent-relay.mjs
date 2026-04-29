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

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.rest.length > 0) {
  console.error(`agent-relay: unknown argument: ${args.rest[0]}`);
  console.error("Run `agent-relay --help` for usage.");
  process.exit(2);
}

const relayServerBinary = resolveRelayServerBinary();
if (!relayServerBinary) {
  ensureCommand(
    "cargo",
    "No prebuilt relay-server binary was found, and Rust/Cargo is required for the source fallback."
  );
}
ensureCommand("codex", "The Codex CLI must be installed and logged in before starting agent-relay.");

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

if (brokerConfig) {
  env.RELAY_BROKER_URL = process.env.RELAY_BROKER_URL || brokerConfig.websocketUrl;
  env.RELAY_BROKER_PUBLIC_URL = process.env.RELAY_BROKER_PUBLIC_URL || brokerConfig.websocketUrl;
  env.RELAY_BROKER_CONTROL_URL =
    process.env.RELAY_BROKER_CONTROL_URL || brokerConfig.controlUrl;
  env.RELAY_BROKER_AUTH_MODE = process.env.RELAY_BROKER_AUTH_MODE || "public";
} else {
  console.warn(
    "agent-relay: no public broker configured; starting localhost-only relay. " +
      "Set AGENT_RELAY_PUBLIC_BROKER_URL or pass --broker to enable remote pairing."
  );
}

console.log(`agent-relay: serving local relay at http://${env.BIND_HOST}:${env.PORT}`);
if (brokerConfig) {
  console.log(`agent-relay: using public broker ${brokerConfig.controlUrl}`);
}
console.log(`agent-relay: workspace/state directory is ${userCwd}`);

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
  console.log(`agent-relay: starting bundled relay-server binary ${relayServerBinary}`);
} else {
  console.warn("agent-relay: starting relay-server via cargo fallback; install a prebuilt package to avoid Rust/Cargo.");
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

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    console.error(`agent-relay: ${flag} requires a value.`);
    process.exit(2);
  }
  return value;
}

function normalizeBrokerOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    console.error(`agent-relay: invalid broker URL \`${value}\`: ${error.message}`);
    process.exit(2);
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";

  const protocol = parsed.protocol.toLowerCase();
  if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
    console.error("agent-relay: broker URL must start with http://, https://, ws://, or wss://.");
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
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT") {
    console.error(`agent-relay: ${message}`);
    process.exit(1);
  }
}

function resolveRelayServerBinary() {
  const override = process.env.AGENT_RELAY_SERVER_BIN;
  if (override) {
    if (existsSync(override)) {
      return override;
    }
    console.error(`agent-relay: AGENT_RELAY_SERVER_BIN does not exist: ${override}`);
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
  return `@agent-relay/relay-${target}`;
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
  console.log(`agent-relay

Run a local relay-server from the npm package.

Usage:
  agent-relay [--broker <url>] [--port <port>] [--host <ip>] [--no-broker]

Defaults:
  --host        127.0.0.1
  --port        8787
  --broker      AGENT_RELAY_PUBLIC_BROKER_URL, if set by the package publisher or user

Binary resolution:
  Uses AGENT_RELAY_SERVER_BIN, a package-local bin/<platform>-<arch>/relay-server,
  package-local bin/relay-server, or an installed @agent-relay/relay-<platform>-<arch>
  package. Falls back to Cargo only when no prebuilt binary is present.

Examples:
  agent-relay
  agent-relay --broker https://broker.example.com
  AGENT_RELAY_PUBLIC_BROKER_URL=https://broker.example.com npx agent-relay
  agent-relay --no-broker
`);
}
