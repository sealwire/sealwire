import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const relayPort = process.env.RELAY_DEV_SERVER_PORT || "8787";
const brokerPort = process.env.RELAY_DEV_BROKER_PORT || "8788";
const localhostOnly =
  process.env.RELAY_DEV_LOCALHOST_ONLY === "1" ||
  process.env.RELAY_DEV_LOCALHOST_ONLY === "true";
const detectedLanIp = localhostOnly ? null : resolvePrivateIpv4();
const defaultBrokerHost = localhostOnly || !detectedLanIp ? "127.0.0.1" : detectedLanIp;
const defaultBrokerBindHost = localhostOnly || !detectedLanIp ? "127.0.0.1" : "0.0.0.0";

const defaultBrokerUrl = `ws://${defaultBrokerHost}:${brokerPort}`;
const brokerPublicUrl = process.env.RELAY_BROKER_PUBLIC_URL || defaultBrokerUrl;

const sharedEnv = {
  ...process.env,
  RELAY_DEV_SERVER_PORT: relayPort,
  RELAY_DEV_BROKER_PORT: brokerPort,
};

const brokerEnv = {
  ...sharedEnv,
  PORT: process.env.RELAY_BROKER_PORT || brokerPort,
  BIND_HOST:
    process.env.RELAY_BROKER_BIND_HOST || process.env.BIND_HOST || defaultBrokerBindHost,
  RELAY_BROKER_TICKET_SECRET:
    process.env.RELAY_BROKER_TICKET_SECRET || "change-me-dev-broker-ticket-secret",
};

const relayEnv = {
  ...sharedEnv,
  PORT: process.env.RELAY_SERVER_PORT || relayPort,
  BIND_HOST: process.env.RELAY_SERVER_BIND_HOST || process.env.BIND_HOST || "127.0.0.1",
  RELAY_BROKER_URL: process.env.RELAY_BROKER_URL || defaultBrokerUrl,
  RELAY_BROKER_PUBLIC_URL: brokerPublicUrl,
  RELAY_BROKER_CHANNEL_ID: process.env.RELAY_BROKER_CHANNEL_ID || "dev-room",
  RELAY_BROKER_PEER_ID: process.env.RELAY_BROKER_PEER_ID || "local-relay",
  RELAY_BROKER_TICKET_SECRET:
    process.env.RELAY_BROKER_TICKET_SECRET || "change-me-dev-broker-ticket-secret",
};

const children = [];
let shuttingDown = false;

function spawnManaged(name, command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.error(`[dev:full] ${name} exited unexpectedly (${reason}). Stopping the other processes.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await ensurePortsAreAvailable([
  { name: "relay-server", port: relayPort },
  { name: "relay-broker", port: brokerPort },
]);

console.log("[dev:full] Building frontend assets for relay-server and relay-broker...");
await runCommand(npmCommand, ["run", "build"], sharedEnv);

console.log("[dev:full] Starting frontend build watcher, relay-broker, and relay-server...");
console.log(`[dev:full] Relay:  http://127.0.0.1:${relayPort}`);
console.log(`[dev:full] Broker: http://127.0.0.1:${brokerPort}`);
if (detectedLanIp && !localhostOnly) {
  console.log(`[dev:full] LAN broker: http://${detectedLanIp}:${brokerPort}`);
}
if (brokerPublicUrl !== defaultBrokerUrl) {
  console.log(`[dev:full] Pairing links will use broker public URL: ${brokerPublicUrl}`);
} else {
  console.log(`[dev:full] Pairing links default to ${brokerPublicUrl}`);
}
console.log("[dev:full] Static frontend assets are served from ./web and rebuilt on change.");

spawnManaged(
  "frontend-build",
  npmCommand,
  ["run", "build", "--", "--watch"],
  sharedEnv
);
spawnManaged("relay-broker", "cargo", ["run", "-p", "relay-broker"], brokerEnv);
spawnManaged("relay-server", "cargo", ["run", "-p", "relay-server"], relayEnv);

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code ?? 0}`}`
        )
      );
    });
  });
}

async function ensurePortsAreAvailable(ports) {
  for (const { name, port } of ports) {
    const available = await canBindPort(Number(port));
    if (!available) {
      console.error(`[dev:full] ${name} port ${port} is already in use. Stop the existing process or override the port env vars first.`);
      process.exit(1);
    }
  }
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ host: "0.0.0.0", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function resolvePrivateIpv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      if (
        entry.address.startsWith("10.") ||
        entry.address.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)
      ) {
        return entry.address;
      }
    }
  }
  return null;
}
