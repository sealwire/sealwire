import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}

// A broker-connected relay needs a self-hosted signing key, and refuses to make one
// when the database already holds phones paired through Cloud — so a local dev
// relay that joins a broker cannot start on a real ~/.sealwire.
test("dev:full starts a local relay with no broker, even with broker vars in the shell", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-full-"));
  const relayCapture = path.join(root, "relay-env.json");
  const brokerMarker = path.join(root, "broker-started");
  try {
    mkdirSync(path.join(root, "scripts"));
    for (const name of ["dev-full.mjs", "dev-broker-secret.mjs", "dev-broker-secret-windows.ps1", "prune-cargo-target.mjs"]) {
      copyFileSync(fileURLToPath(new URL(name, import.meta.url)), path.join(root, "scripts", name));
    }
    const stub = path.join(root, "child-stub.mjs");
    writeFileSync(stub, `
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("relay-broker")) writeFileSync(process.env.SEALWIRE_TEST_BROKER_MARKER, "1");
if (args.includes("relay-server")) {
  const broker = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("RELAY_BROKER_")));
  writeFileSync(process.env.SEALWIRE_TEST_CAPTURE, JSON.stringify(broker));
}
if (args[0] === "npm" && !args.includes("--watch")) {
  mkdirSync("web", { recursive: true });
  writeFileSync("web/build-meta.json", JSON.stringify({ buildId: "fixture-build" }));
  process.exit(0);
}
setInterval(() => {}, 1000);
`);
    for (const name of ["npm", "cargo"]) {
      writeFileSync(path.join(root, name), `#!/bin/sh\nexec "$SEALWIRE_TEST_NODE" "$SEALWIRE_TEST_STUB" ${name} "$@"\n`, { mode: 0o755 });
    }
    const env = {
      PATH: `${root}:/usr/bin:/bin`,
      HOME: root,
      RELAY_STATE_DB: path.join(root, ".sealwire", "sealwire.db"),
      RELAY_DEV_SERVER_PORT: await freePort(),
      RELAY_DEV_BROKER_PORT: await freePort(),
      RELAY_DEV_RELOAD_PORT: await freePort(),
      RELAY_BROKER_URL: "ws://127.0.0.1:8788",
      RELAY_BROKER_CHANNEL_ID: "dev-room",
      SEALWIRE_TEST_NODE: process.execPath,
      SEALWIRE_TEST_STUB: stub,
      SEALWIRE_TEST_CAPTURE: relayCapture,
      SEALWIRE_TEST_BROKER_MARKER: brokerMarker,
    };
    const child = spawn(process.execPath, [path.join(root, "scripts", "dev-full.mjs")], {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stopped = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      let relayBrokerEnv;
      for (let attempt = 0; attempt < 100 && !relayBrokerEnv; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) assert.fail(`dev stack exited: ${stderr}`);
        try { relayBrokerEnv = JSON.parse(readFileSync(relayCapture, "utf8")); } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          await delay(50);
        }
      }
      assert.ok(relayBrokerEnv, `relay-server was not started: ${stderr}`);
      assert.deepEqual(relayBrokerEnv, {}, "a local dev relay must not be handed any broker setting");
      assert.equal(existsSync(brokerMarker), false, "dev:full must not start a broker");
    } finally {
      child.kill("SIGTERM");
      await stopped;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
