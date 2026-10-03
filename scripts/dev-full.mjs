import { spawn } from "node:child_process";
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveDevBrokerIssuerSecret, resolveDevBrokerTicketSecret } from "./dev-broker-secret.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const relayPort = process.env.RELAY_DEV_SERVER_PORT || "8787";
const brokerPort = process.env.RELAY_DEV_BROKER_PORT || "8788";
const reloadPort = process.env.RELAY_DEV_RELOAD_PORT || "5174";
const localhostOnly =
  process.env.RELAY_DEV_LOCALHOST_ONLY === "1" ||
  process.env.RELAY_DEV_LOCALHOST_ONLY === "true";
const detectedLanIp = localhostOnly ? null : resolvePrivateIpv4();
const defaultBrokerHost = localhostOnly || !detectedLanIp ? "127.0.0.1" : detectedLanIp;
const defaultBrokerBindHost = localhostOnly || !detectedLanIp ? "127.0.0.1" : "0.0.0.0";

const defaultBrokerUrl = `ws://${defaultBrokerHost}:${brokerPort}`;
const brokerPublicUrl = process.env.RELAY_BROKER_PUBLIC_URL || defaultBrokerUrl;
const buildMetaPath = new URL("../web/build-meta.json", import.meta.url);

const sharedEnv = {
  ...process.env,
  RELAY_DEV_SERVER_PORT: relayPort,
  RELAY_DEV_BROKER_PORT: brokerPort,
};

const brokerTicketSecret = resolveDevBrokerTicketSecret();

const buildEnv = {
  ...sharedEnv,
  RELAY_DEV_RELOAD: "1",
  RELAY_DEV_RELOAD_PORT: reloadPort,
};

const brokerEnv = {
  ...sharedEnv,
  PORT: process.env.RELAY_BROKER_PORT || brokerPort,
  BIND_HOST:
    process.env.RELAY_BROKER_BIND_HOST || process.env.BIND_HOST || defaultBrokerBindHost,
  RELAY_BROKER_TICKET_SECRET: brokerTicketSecret,
};
if (process.env.RELAY_BROKER_AUTH_MODE?.trim().toLowerCase() === "public") {
  brokerEnv.RELAY_BROKER_PUBLIC_ISSUER_SECRET = resolveDevBrokerIssuerSecret();
}

const relayEnv = {
  ...sharedEnv,
  PORT: process.env.RELAY_SERVER_PORT || relayPort,
  BIND_HOST: process.env.RELAY_SERVER_BIND_HOST || process.env.BIND_HOST || "127.0.0.1",
  RELAY_BROKER_URL: process.env.RELAY_BROKER_URL || defaultBrokerUrl,
  RELAY_BROKER_PUBLIC_URL: brokerPublicUrl,
  RELAY_BROKER_CHANNEL_ID: process.env.RELAY_BROKER_CHANNEL_ID || "dev-room",
  RELAY_BROKER_PEER_ID: process.env.RELAY_BROKER_PEER_ID || "local-relay",
  RELAY_BROKER_TICKET_SECRET: brokerTicketSecret,
};

const children = [];
let shuttingDown = false;
let reloadServer = null;
const reloadClients = new Set();
let lastBuildId = null;

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
  unwatchFile(buildMetaPath);
  if (reloadServer) {
    reloadServer.close();
    for (const client of reloadClients) {
      try { client.end(); } catch {}
    }
    reloadClients.clear();
  }
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
  { name: "dev-reload", port: reloadPort },
]);

startReloadServer();

console.log("[dev:full] Building frontend assets for relay-server and relay-broker...");
await runCommand(npmCommand, ["run", "build"], buildEnv);
logCurrentBuildMeta("Initial frontend build");
watchFrontendBuildMeta();

// Drop the stale cargo generations left by previous runs before this one adds
// another. cargo never garbage-collects target/, so without this every restart
// leaves a full extra copy of every first-party crate behind — that is how
// target/debug reached 94G here. Runs BEFORE cargo so the generation it is about
// to reuse is the newest, which is exactly what the prune keeps.
// Never fatal: a dev loop must still come up if the prune cannot run.
await runCommand(
  process.execPath,
  [fileURLToPath(new URL("prune-cargo-target.mjs", import.meta.url))],
  buildEnv
).catch((error) => {
  console.warn(`[dev:full] target prune skipped: ${error.message}`);
});

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
  buildEnv
);
spawnManaged("relay-broker", "cargo", ["run", "-p", "relay-broker"], brokerEnv);
// Build with the private crate when this checkout has it.
// Without this, `scripts/with-private.sh npm run dev:full` would swap the private
// crate in and then build a relay that ignores it — a dev loop where task teams
// answer "not available in this build".
//
// The tell is the stub's own marker file, not a module the private crate happens
// to have today, so whatever goes private next needs no change here.
const isStub = existsSync(
  new URL("../crates/sealwire-private/STUB", import.meta.url)
);
const relayArgs = ["run", "-p", "relay-server"];
if (isStub) {
  console.log("[dev:full] stub private crate — task list and task team are off");
} else {
  relayArgs.push("--features", "private");
  console.log("[dev:full] private crate present — building with it");
}

// The dev loop runs with in-development features unlocked. Set SEALWIRE_BETA=0
// to see the locked preview a plain `npx sealwire` gets.
if (relayEnv.SEALWIRE_BETA === undefined) {
  relayEnv.SEALWIRE_BETA = "1";
}
console.log(
  relayEnv.SEALWIRE_BETA === "1"
    ? "[dev:full] beta features ON (Tasks unlocked)"
    : `[dev:full] beta features OFF (SEALWIRE_BETA=${relayEnv.SEALWIRE_BETA})`
);

spawnManaged("relay-server", "cargo", relayArgs, relayEnv);

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

function watchFrontendBuildMeta() {
  watchFile(buildMetaPath, { interval: 250 }, (current, previous) => {
    if (!current.mtimeMs || current.mtimeMs === previous.mtimeMs) {
      return;
    }
    logCurrentBuildMeta("Frontend rebuilt");
  });
}

function logCurrentBuildMeta(prefix) {
  try {
    const meta = JSON.parse(readFileSync(buildMetaPath, "utf8"));
    console.log(`[dev:full] ${prefix}: ${meta.buildId} (${meta.builtAtIso})`);
    lastBuildId = meta.buildId;
    broadcastReload(meta.buildId);
  } catch (error) {
    console.warn(`[dev:full] ${prefix}, but build metadata could not be read: ${error.message}`);
  }
}

function startReloadServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== "/dev/reload") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    if (lastBuildId) {
      res.write(`event: reload\ndata: ${lastBuildId}\n\n`);
    }
    const keepalive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);
    keepalive.unref();
    reloadClients.add(res);
    req.on("close", () => {
      clearInterval(keepalive);
      reloadClients.delete(res);
    });
  });
  server.on("error", (err) => {
    console.warn(`[dev:full] dev-reload server error: ${err.message}`);
  });
  server.listen(Number(reloadPort), "0.0.0.0", () => {
    console.log(`[dev:full] Dev reload SSE: http://127.0.0.1:${reloadPort}/dev/reload`);
  });
  reloadServer = server;
}

function broadcastReload(buildId) {
  const payload = `event: reload\ndata: ${buildId}\n\n`;
  for (const client of reloadClients) {
    try {
      client.write(payload);
    } catch {
      reloadClients.delete(client);
    }
  }
}
