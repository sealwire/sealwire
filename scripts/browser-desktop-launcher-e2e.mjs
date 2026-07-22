// Desktop launcher UI e2e — the built launcher (frontend/desktop/desktop.js)
// running in a real Chromium against a STUBBED Tauri bridge.
//
// Why this exists: the launcher's whole job is IPC wiring — render
// `desktop_status`, and turn each button into the right `invoke(command, …)`.
// On macOS there is no way to drive the native Tauri shell headlessly
// (tauri-driver is Linux/Windows only), so that glue used to be verifiable only
// by a human clicking around. This test replaces `window.__TAURI_INTERNALS__`
// (which `@tauri-apps/api`'s invoke/listen/dialog all funnel through) with a fake
// that records every invoke and returns canned status, so the launcher runs with
// NO relay and NO native shell and we can assert the wiring automatically.
//
// Scope: launcher UI ↔ IPC command wiring. It does NOT cover native tray/window
// behavior or the real Rust command handlers — those stay manual (`npm run
// desktop:dev`) / are guarded separately (see the Rust suite's
// tauri_ipc_windows_are_capability_covered).
import assert from "node:assert/strict";
import process from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startStaticServer } from "./e2e/harness/static-server.mjs";
import { launchBrowser, attachPageDebugLogging } from "./e2e/harness/browser.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const WEB_DIR = fileURLToPath(new URL("../web", import.meta.url));

// Canned status the fake `desktop_status` returns: a running+ready relay, so the
// Open/Stop buttons are enabled and the Providers panel renders (see ui-util.mjs
// startDisabled/stopDisabled/openSurfaceDisabled).
const WORKSPACE = "/Users/demo/work/sealwire";
const RUNNING_STATUS = {
  config: {
    workspaceDir: WORKSPACE,
    preferredPort: 8811,
    brokerMode: "localOnly",
    customBrokerUrl: "",
  },
  relay: {
    running: true,
    ready: true,
    port: 8811,
    localUrl: "http://127.0.0.1:8811/",
    remoteUrl: "http://127.0.0.1:8811/static/remote.html",
    brokerUrl: null,
    brokerLabel: "Local relay",
    workspaceDir: WORKSPACE,
    providerStatus: [
      { provider: "claude_code", displayName: "Claude Code", status: "connected", connected: true },
      { provider: "codex", displayName: "Codex", status: "starting", connected: false, reason: "spawning" },
    ],
  },
  logs: [],
};
const STOPPED_STATUS = {
  config: RUNNING_STATUS.config,
  relay: { running: false, ready: false, brokerLabel: "Local relay", providerStatus: [] },
  logs: [],
};
const BROWSE_RESULT = "/Users/demo/picked/project";

// Installed into every page BEFORE its own scripts run. `@tauri-apps/api`'s
// invoke(), listen(), and plugin-dialog open() all call
// window.__TAURI_INTERNALS__.invoke(cmd, payload, opts) / .transformCallback(cb),
// so replacing that object is enough to fully stub the native bridge. Every
// invoke is recorded on window.__invokeLog for the assertions.
function installTauriStub(fixtures) {
  const invokeLog = [];
  const callbacks = new Map();
  const listeners = {};
  let nextId = 1;
  window.__invokeLog = invokeLog;
  window.__tauriFixtures = fixtures;

  // Deliver a backend event to a registered `listen(...)` handler, so the live
  // `desktop://relay-status` update path can be exercised.
  window.__emitTauriEvent = (event, payload) => {
    const handlerId = listeners[event];
    const entry = callbacks.get(handlerId);
    if (!entry) {
      return false;
    }
    entry.cb({ event, id: handlerId, payload });
    return true;
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback(cb, once = false) {
      const id = nextId++;
      callbacks.set(id, { cb, once });
      return id;
    },
    async invoke(cmd, payload = {}, _options) {
      invokeLog.push({ cmd, payload: payload ?? {} });
      if (cmd === "plugin:event|listen") {
        listeners[payload?.event] = payload?.handler;
        return nextId++;
      }
      if (cmd === "plugin:event|unlisten") {
        return null;
      }
      if (cmd === "plugin:dialog|open") {
        return window.__tauriFixtures.browseResult ?? null;
      }
      const responses = window.__tauriFixtures.responses || {};
      return cmd in responses ? responses[cmd] : null;
    },
  };
}

async function invokeCmds(page) {
  return page.evaluate(() => (window.__invokeLog || []).map((entry) => entry.cmd));
}

async function lastInvoke(page, cmd) {
  return page.evaluate(
    (name) => (window.__invokeLog || []).filter((entry) => entry.cmd === name).slice(-1)[0] || null,
    cmd
  );
}

async function waitForInvoke(page, cmd) {
  await page.waitForFunction(
    (name) => (window.__invokeLog || []).some((entry) => entry.cmd === name),
    cmd,
    { timeout: TIMEOUT_MS }
  );
  return lastInvoke(page, cmd);
}

async function main() {
  if (!existsSync(`${WEB_DIR}/desktop.html`)) {
    throw new Error(
      `web/desktop.html not found — run \`npm run build\` before this test ` +
        `(the npm script does this for you).`
    );
  }

  // Serve the built app. base is `/static/`, so every asset request comes in as
  // /static/… and maps back to web/… via stripStaticPrefix; desktop.html is the
  // index so `/` loads the launcher.
  const staticServer = await startStaticServer({
    rootDir: WEB_DIR,
    indexFile: "desktop.html",
    stripStaticPrefix: true,
  });
  const baseUrl = `http://${staticServer.host}:${staticServer.port}/`;

  const { browser, context } = await launchBrowser();
  const pageErrors = [];
  try {
    await context.addInitScript(installTauriStub, {
      responses: {
        desktop_status: RUNNING_STATUS,
        desktop_restart: RUNNING_STATUS,
        desktop_stop_relay: STOPPED_STATUS,
        desktop_open_surface: null,
      },
      browseResult: BROWSE_RESULT,
    });

    const page = await context.newPage();
    attachPageDebugLogging(page, "desktop-launcher");
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(baseUrl, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.waitForSelector("#desktop-root .desktop-shell", { timeout: TIMEOUT_MS });

    // 1) The launcher fetches status on boot and subscribes to live updates.
    const bootCmds = await invokeCmds(page);
    assert.ok(bootCmds.includes("desktop_status"), "launcher must call desktop_status on boot");
    assert.ok(
      bootCmds.includes("plugin:event|listen"),
      "launcher must subscribe to the relay-status event"
    );

    // 2) It renders that status: running pill, provider rows, and the config form.
    assert.equal(
      await page.getAttribute(".status-pill", "data-running"),
      "true",
      "status pill should reflect a running+ready relay"
    );
    assert.match(await page.textContent(".status-pill"), /Running on 8811/);
    const providerNames = await page.$$eval(".provider-status-name", (els) =>
      els.map((el) => el.textContent)
    );
    assert.deepEqual(
      providerNames,
      ["Claude Code", "Codex"],
      "Providers panel should render one row per provider_status entry"
    );
    assert.equal(
      await page.inputValue("#workspace-dir"),
      WORKSPACE,
      "workspace field should be seeded from status.config"
    );

    // 3) Open Local / Open Remote → desktop_open_surface with the right surface.
    assert.equal(await page.isDisabled("#open-local"), false, "Open Local enabled when ready");
    await page.click("#open-local");
    assert.deepEqual((await waitForInvoke(page, "desktop_open_surface")).payload, {
      surface: "local",
    });

    await page.click("#open-remote");
    assert.deepEqual(
      await page.evaluate(
        () =>
          window.__invokeLog
            .filter((e) => e.cmd === "desktop_open_surface")
            .slice(-1)[0].payload
      ),
      { surface: "remote" },
      "Open Remote must pass surface:'remote'"
    );

    // 4) Save & Restart → desktop_restart with the LIVE form (proves readConfigForm
    //    reads the DOM, not the stale seed): change port, turn the broker ON (the
    //    status seed is local-only, so the provider buttons start disabled), and pick
    //    the official provider.
    await page.fill("#preferred-port", "9999");
    assert.equal(
      await page.isDisabled('[data-broker-mode="hosted"]'),
      true,
      "provider buttons are disabled while the broker toggle is off"
    );
    await page.check("#broker-enabled");
    await page.click('[data-broker-mode="hosted"]');
    await page.click("#restart-relay");
    const restart = await waitForInvoke(page, "desktop_restart");
    assert.deepEqual(
      restart.payload,
      {
        input: {
          workspaceDir: WORKSPACE,
          preferredPort: 9999,
          brokerMode: "hosted",
          customBrokerUrl: "",
        },
      },
      "Save & Restart must send the edited form to desktop_restart"
    );

    // 5) Browse → plugin:dialog|open (directory picker), and the chosen path lands
    //    in the workspace field.
    await page.click("#browse-workspace");
    const browse = await waitForInvoke(page, "plugin:dialog|open");
    assert.equal(browse.payload?.options?.directory, true, "Browse opens a directory picker");
    await page.waitForFunction(
      (expected) => document.querySelector("#workspace-dir")?.value === expected,
      BROWSE_RESULT,
      { timeout: TIMEOUT_MS }
    );

    // 6) Stop → desktop_stop_relay, and the returned stopped status re-renders.
    assert.equal(await page.isDisabled("#stop-relay"), false, "Stop enabled while running");
    await page.click("#stop-relay");
    await waitForInvoke(page, "desktop_stop_relay");
    await page.waitForFunction(
      () => document.querySelector(".status-pill")?.getAttribute("data-running") === "false",
      undefined,
      { timeout: TIMEOUT_MS }
    );
    assert.match(await page.textContent(".status-pill"), /Stopped/);

    // 7) A backend-pushed relay-status event is adopted (live update wiring).
    const delivered = await page.evaluate(
      (status) => window.__emitTauriEvent("desktop://relay-status", status),
      RUNNING_STATUS
    );
    assert.equal(delivered, true, "relay-status listener should be registered");
    await page.waitForFunction(
      () => document.querySelector(".status-pill")?.getAttribute("data-running") === "true",
      undefined,
      { timeout: TIMEOUT_MS }
    );

    assert.deepEqual(pageErrors, [], `launcher must not raise page errors: ${pageErrors}`);
    console.log("desktop-launcher e2e: PASS");
  } finally {
    await context.tracing.stop().catch(() => {});
    await browser.close().catch(() => {});
    await staticServer.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("desktop-launcher e2e: FAIL");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
