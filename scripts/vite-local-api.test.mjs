import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function verifyLocalProxy(script, context) {
  const addresses = Object.values(os.networkInterfaces()).flat().filter((address) => address?.family === "IPv4" && !address.internal);
  if (addresses.length === 0) {
    context.skip("LAN isolation requires a non-loopback IPv4 interface");
    return;
  }
  const upstream = http.createServer((_request, response) => response.end("isolated-relay"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const [command, ...args] = pkg.scripts[script].split(/\s+/);
  assert.equal(command, "vite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), ...args, "--port", String(port), "--strictPort"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      RELAY_DEV_VITE_PORT: String(port),
      RELAY_DEV_SERVER_PORT: String(upstream.address().port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.fail(`Vite exited: ${stderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/security-probe`, { signal: AbortSignal.timeout(500) });
        assert.equal(await response.text(), "isolated-relay");
        ready = true;
        break;
      } catch {
        await delay(50);
      }
    }
    assert.ok(ready, `Vite did not start: ${stderr}`);
    for (const { address } of addresses) {
      await assert.rejects(fetch(`http://${address}:${port}/api/security-probe`, { signal: AbortSignal.timeout(1000) }));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGTERM");
      await stopped;
    }
    await new Promise((resolve) => upstream.close(resolve));
  }
}

for (const script of ["dev", "preview"]) {
  test(`npm run ${script} proxies the local API while refusing LAN connections`, { timeout: 15000 }, (context) => verifyLocalProxy(script, context));
}
