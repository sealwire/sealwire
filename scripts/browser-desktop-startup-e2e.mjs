// Desktop startup page e2e: the built page (frontend/desktop/desktop.js) in a real
// Chromium against a stubbed Tauri bridge. macOS has no headless driver for the
// native shell, so this is how the page's IPC wiring gets checked automatically;
// the window, tray and relay lifecycle are covered by the Rust suite and a real run.
import assert from "node:assert/strict";
import process from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startStaticServer } from "./e2e/harness/static-server.mjs";
import { launchBrowser, attachPageDebugLogging } from "./e2e/harness/browser.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const WEB_DIR = fileURLToPath(new URL("../web", import.meta.url));
const SCREENSHOT = process.env.DESKTOP_STARTUP_SCREENSHOT || "";

const STARTING = { phase: "starting", logs: [] };
const FAILED = {
  phase: "failed",
  message:
    "relay-server: another relay is already running (pid 4242, port 8787) against the state database this one would use.",
  logs: [
    "started relay-server (pid 5151) on port 8787",
    "relay-server: another relay is already running (pid 4242, port 8787) against the state database this one would use.",
    "relay-server (pid 5151) exited with code Some(1)",
  ],
};

// `@tauri-apps/api`'s invoke() and listen() both go through
// window.__TAURI_INTERNALS__, so replacing it stubs the whole native bridge.
function installTauriStub(fixtures) {
  const invokeLog = [];
  const callbacks = new Map();
  const listeners = {};
  let nextId = 1;
  window.__invokeLog = invokeLog;

  window.__emitTauriEvent = (event, payload) => {
    const entry = callbacks.get(listeners[event]);
    if (!entry) {
      return false;
    }
    entry.cb({ event, id: listeners[event], payload });
    return true;
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback(cb, once = false) {
      const id = nextId++;
      callbacks.set(id, { cb, once });
      return id;
    },
    async invoke(cmd, payload = {}) {
      invokeLog.push({ cmd, payload: payload ?? {} });
      if (cmd === "plugin:event|listen") {
        listeners[payload?.event] = payload?.handler;
        return nextId++;
      }
      return cmd in fixtures ? fixtures[cmd] : null;
    },
  };
}

async function invokeCount(page, cmd) {
  return page.evaluate(
    (name) => (window.__invokeLog || []).filter((entry) => entry.cmd === name).length,
    cmd
  );
}

async function emit(page, status) {
  const delivered = await page.evaluate(
    (payload) => window.__emitTauriEvent("desktop://status", payload),
    status
  );
  assert.equal(delivered, true, "the page must listen for desktop://status");
}

async function waitForState(page, state) {
  await page.waitForSelector(`.startup[data-state="${state}"]`, { timeout: TIMEOUT_MS });
}

async function main() {
  if (!existsSync(`${WEB_DIR}/desktop.html`)) {
    throw new Error("web/desktop.html not found — run `npm run build` first (the npm script does).");
  }
  const staticServer = await startStaticServer({
    rootDir: WEB_DIR,
    indexFile: "desktop.html",
    stripStaticPrefix: true,
  });
  const baseUrl = `http://${staticServer.host}:${staticServer.port}/`;

  const { browser, context } = await launchBrowser();
  const pageErrors = [];
  try {
    await context.addInitScript(installTauriStub, { desktop_status: STARTING, desktop_retry: null });
    const page = await context.newPage();
    attachPageDebugLogging(page, "desktop-startup");
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(baseUrl, { waitUntil: "load", timeout: TIMEOUT_MS });
    await waitForState(page, "starting");

    assert.equal(await invokeCount(page, "desktop_status"), 1, "status is read once on load");
    assert.equal(await invokeCount(page, "plugin:event|listen"), 1, "status updates are subscribed");
    assert.match(await page.textContent(".startup-title"), /Starting Sealwire/);
    assert.equal(await page.$(".startup-retry"), null, "no retry while starting");
    assert.equal(await page.$("input, select"), null, "the startup page asks nothing of the user");

    await emit(page, FAILED);
    await waitForState(page, "failed");
    assert.match(await page.textContent(".startup-title"), /isn't running/);
    assert.equal(await page.textContent(".startup-detail"), FAILED.message);
    await page.click(".startup-logs summary");
    assert.equal(await page.textContent(".startup-logs pre"), FAILED.logs.join("\n"));
    if (SCREENSHOT) {
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.screenshot({ path: SCREENSHOT });
    }

    await page.click(".startup-retry");
    await page.waitForFunction(
      () => (window.__invokeLog || []).some((entry) => entry.cmd === "desktop_retry"),
      undefined,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(await page.isDisabled(".startup-retry"), true, "retry cannot be sent twice");

    await emit(page, STARTING);
    await waitForState(page, "starting");

    assert.deepEqual(pageErrors, [], `startup page must not raise page errors: ${pageErrors}`);
    console.log("desktop-startup e2e: PASS");
  } finally {
    await browser.close().catch(() => {});
    await staticServer.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("desktop-startup e2e: FAIL");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
