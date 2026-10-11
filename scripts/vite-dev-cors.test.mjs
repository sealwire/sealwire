import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Another page on this machine (a second dev server, a local tool with an XSS) has a
// `localhost` origin too. If the dev server answers its CORS preflight, that page can
// send the relay's CSRF header through the proxy and drive the API — approvals included.
const FOREIGN_LOCALHOST_ORIGIN = "http://localhost:4000";

async function withDevServer(run) {
  const upstream = http.createServer((_request, response) => response.end("relay"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--port", String(port), "--strictPort"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        RELAY_DEV_VITE_PORT: String(port),
        RELAY_DEV_SERVER_PORT: String(upstream.address().port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.fail(`Vite exited: ${stderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        assert.equal(await response.text(), "relay");
        ready = true;
        break;
      } catch {
        await delay(50);
      }
    }
    assert.ok(ready, `Vite did not start: ${stderr}`);
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGTERM");
      await stopped;
    }
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test("npm run dev does not grant CORS to other localhost origins", { timeout: 15000 }, () =>
  withDevServer(async (base) => {
    const preflight = await fetch(`${base}/api/session/message`, {
      method: "OPTIONS",
      headers: {
        Origin: FOREIGN_LOCALHOST_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-agent-relay-csrf,content-type",
      },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      null,
      "a preflight from another localhost page must not be approved"
    );
    assert.equal(preflight.headers.get("access-control-allow-headers"), null);

    const read = await fetch(`${base}/api/session`, {
      headers: { Origin: FOREIGN_LOCALHOST_ORIGIN },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(
      read.headers.get("access-control-allow-origin"),
      null,
      "a cross-origin GET must stay unreadable to another localhost page"
    );
  })
);
