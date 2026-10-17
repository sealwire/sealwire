import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const name = `terminal-performance-${process.pid}`;
const html = path.resolve(`frontend/${name}.html`), script = path.resolve(`frontend/${name}.js`);
const port = await getFreePort(), relayPort = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const fixture = await fs.readFile(new URL("./e2e/fixtures/terminal-performance.js", import.meta.url), "utf8");
await fs.writeFile(script, fixture.replace("../../../frontend/", "./"));
await fs.writeFile(html, `<html><body><div id="root"></div><script type="module" src="./${name}.js"></script></body></html>`);
const vite = spawnManagedProcess("terminal-performance-vite", process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { RELAY_DEV_RELOAD: "0", RELAY_DEV_SERVER_PORT: String(relayPort) });
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
let browser;
try {
  await waitForHealth(origin, 30000);
  ({ browser } = await launchBrowser());
  for (const [delay, keyInterval] of [[0, 90], [80, 90], [80, 20]]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/static/${name}.html?delay=${delay}`);
    await page.getByText("Live terminal", { exact: true }).waitFor();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("abcdefghijklmnopqrst", { delay: keyInterval });
    await page.waitForFunction(() => window.__metrics.latencies.length === 20);
    const result = await page.evaluate(() => structuredClone(window.__metrics));
    const median = percentile(result.latencies, 0.5);
    assert.ok(median < delay * 2 + 70, `echo latency ${median}ms with ${delay}ms simulated request delay`);
    if (keyInterval < delay) {
      assert.ok(result.inputRequests < 12, "unacknowledged keystrokes must merge into the next request");
    }
    assert.equal(result.resizeWrites, 1);
    console.log(JSON.stringify({ simulatedRequestDelayMs: delay, keyIntervalMs: keyInterval, inputRequests: result.inputRequests, keyEchoMedianMs: median, keyEchoP95Ms: percentile(result.latencies, 0.95), parseMedianMs: percentile(result.parseTimes, 0.5), resizeWrites: result.resizeWrites, pollRequests: result.reads, typed: result.latencies.length }));
    assert.equal(result.sent, "abcdefghijklmnopqrst");
    if (delay === 0) {
      const elapsed = await page.evaluate(async () => {
        const start = performance.now(); await window.__burst(256 * 1024); return performance.now() - start;
      });
      assert.ok(elapsed < 650, `256 KiB burst took ${elapsed}ms`);
      console.log(JSON.stringify({ burstBytes: 256 * 1024, burstMs: elapsed }));
      const shot = path.join(os.tmpdir(), "sealwire-terminal-stream-performance.png");
      await page.screenshot({ path: shot });
      console.log(shot);
    }
    assert.deepEqual(errors, []);
    if (keyInterval < delay) {
      await page.keyboard.type("uv", { delay: 0 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.__metrics.inputChunks.includes("\x1b"));
      await page.keyboard.type("wxyz", { delay: 0 });
      await page.getByRole("button", { name: "Close terminal", exact: true }).click();
      await page.getByText("Terminal closed; session keeps running", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__metrics.sent), "abcdefghijklmnopqrstuv\x1bwxyz", "closing must flush every pending key in order");
    }
    await page.close();
  }
} finally {
  await browser?.close(); await stopManagedProcess(vite);
  await Promise.all([fs.rm(html, { force: true }), fs.rm(script, { force: true })]);
}
