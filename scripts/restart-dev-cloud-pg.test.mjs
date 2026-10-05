import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the Postgres dev stack passes a persistent generated issuer secret to the broker", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sealwire-dev-pg-"));
  const capture = path.join(root, "broker-env.json");
  const pkillLog = path.join(root, "pkill.log");
  try {
    // dev-full also prunes build artifacts; its repository root must be isolated.
    mkdirSync(path.join(root, "scripts"));
    for (const name of ["restart-dev-cloud-pg.sh", "dev-full.mjs", "dev-broker-secret.mjs", "dev-broker-secret-windows.ps1", "prune-cargo-target.mjs"]) {
      copyFileSync(fileURLToPath(new URL(name, import.meta.url)), path.join(root, "scripts", name));
    }
    const stub = path.join(root, "child-stub.mjs");
    writeFileSync(stub, `
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("relay-broker")) {
  writeFileSync(process.env.SEALWIRE_TEST_CAPTURE, JSON.stringify({
    issuer: process.env.RELAY_BROKER_PUBLIC_ISSUER_SECRET,
    mode: process.env.RELAY_BROKER_AUTH_MODE,
    postgres: process.env.RELAY_BROKER_PUBLIC_POSTGRES_URL,
  }));
}
if (args[0] === "npm" && !args.includes("--watch")) {
  mkdirSync("web", { recursive: true });
  writeFileSync("web/build-meta.json", JSON.stringify({ buildId: "fixture-build" }));
  process.exit(0);
}
setInterval(() => {}, 1000);
`);
    // The restart script must never send its broad kill patterns to system pkill.
    writeFileSync(path.join(root, "pkill"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SEALWIRE_TEST_PKILL_LOG"\n', { mode: 0o755 });
    writeFileSync(path.join(root, "node"), '#!/bin/sh\nexec "$SEALWIRE_TEST_NODE" "$@"\n', { mode: 0o755 });
    for (const name of ["npm", "cargo"]) {
      writeFileSync(path.join(root, name), `#!/bin/sh\nexec "$SEALWIRE_TEST_NODE" "$SEALWIRE_TEST_STUB" ${name} "$@"\n`, { mode: 0o755 });
    }
    const env = {
      PATH: `${root}:/usr/bin:/bin`,
      HOME: root,
      RELAY_STATE_PATH: path.join(root, ".agent-relay", "session.json"),
      RELAY_BROKER_PUBLIC_POSTGRES_URL: "postgres://sealwire:test@postgres.example.test/sealwire",
      RELAY_DEV_SERVER_PORT: await freePort(),
      RELAY_DEV_BROKER_PORT: await freePort(),
      RELAY_DEV_RELOAD_PORT: await freePort(),
      SEALWIRE_TEST_NODE: process.execPath,
      SEALWIRE_TEST_STUB: stub,
      SEALWIRE_TEST_CAPTURE: capture,
      SEALWIRE_TEST_PKILL_LOG: pkillLog,
    };
    let previous;
    for (let launch = 0; launch < 2; launch += 1) {
      rmSync(capture, { force: true });
      const child = spawn("/bin/sh", [path.join(root, "scripts", "restart-dev-cloud-pg.sh"), "--local"], {
        cwd: root,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stopped = once(child, "close");
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      try {
        let captured;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (child.exitCode !== null || child.signalCode !== null) assert.fail(`dev stack exited: ${stderr}`);
          try { captured = JSON.parse(readFileSync(capture, "utf8")); break; } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
          }
          await delay(50);
        }
        assert.ok(captured, `broker was not started: ${stderr}`);
        assert.equal(captured.mode, "public");
        assert.equal(captured.postgres, env.RELAY_BROKER_PUBLIC_POSTGRES_URL);
        assert.equal(Buffer.from(captured.issuer, "base64").length, 48);
        assert.equal(readFileSync(path.join(root, ".agent-relay", "dev-broker-issuer.key"), "utf8").trim(), captured.issuer);
        if (previous) assert.equal(captured.issuer, previous);
        previous = captured.issuer;
      } finally {
        child.kill("SIGTERM");
        await stopped;
      }
    }
    assert.match(readFileSync(pkillLog, "utf8"), /relay-server/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
