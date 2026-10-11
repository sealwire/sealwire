// The remote composer's provider-command tap in Mobile Safari on an iOS Simulator.
//
// Playwright's WebKit port catches layout and engine regressions, but it is not the
// WebKit build shipped inside iOS. This manual test uses Apple's SafariDriver and an
// actual Simulator. It exercises the native pointer/touch event chain and proves the
// selected command becomes a composer pill. SafariDriver suppresses the software
// keyboard, so this checks native touch and DOM focus, not iOS keyboard geometry.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  installFakeRelay,
  REMOTE_COMPOSER_FIXTURE,
} from "./browser-remote-composer-commands-e2e.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";
import { installEncryptedMock, pinRelayVerifyKey } from "./e2e/harness/encrypted-broker-mock.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function isPublicBuild() {
  const controller = path.join(ROOT, "crates/sealwire-private/frontend/composer-command-controller.js");
  return !existsSync(controller) || readFileSync(controller, "utf8").includes("Public-checkout placeholder");
}

function availableIphones() {
  const runtimes = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "-j"])).devices;
  return Object.values(runtimes)
    .flat()
    .filter((device) => device.name?.startsWith("iPhone") && device.isAvailable !== false);
}

function chooseSimulator() {
  const devices = availableIphones();
  const requested = process.env.IOS_SIMULATOR_UDID;
  if (requested) {
    const match = devices.find((device) => device.udid === requested);
    assert.ok(match, `IOS_SIMULATOR_UDID ${requested} is not an available iPhone Simulator`);
    return match;
  }
  const selected = devices.find((device) => device.state === "Booted") || devices[0];
  assert.ok(selected, "Xcode has no available iPhone Simulator runtime");
  return selected;
}

function dismissSafariOnboarding(udid) {
  run("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "write",
    "com.apple.mobilesafari",
    "WBSOnboardingStatesDefaultsKeyV0.2",
    "-dict",
    "CustomizeStartPage",
    "-int",
    "2",
    "EnableCloudSync",
    "-int",
    "2",
    "EnableHighlights",
    "-int",
    "2",
    "ExtensionsDiscovery",
    "-int",
    "2",
    "SetDefaultBrowser",
    "-int",
    "2",
    "TipForMoreButton",
    "-int",
    "2",
  ]);
}

async function waitForDriver(origin, child) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`safaridriver exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/status`);
      if (response.ok) return;
    } catch {
      // SafariDriver has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for safaridriver");
}

async function command(driverOrigin, sessionId, endpoint, { method = "POST", body } = {}) {
  const sessionPath = sessionId ? `/session/${sessionId}` : "";
  const response = await fetch(`${driverOrigin}${sessionPath}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    throw new Error(`SafariDriver ${method} ${endpoint}: ${JSON.stringify(payload.value || payload)}`);
  }
  return payload.value;
}

function execute(driverOrigin, sessionId, script, args = []) {
  return command(driverOrigin, sessionId, "/execute/sync", { body: { script, args } });
}

async function waitFor(check, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let result;
  while (Date.now() < deadline) {
    result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function loadRemoteFixture(driverOrigin, sessionId, origin) {
  const html = await readFile(path.join(WEB_ROOT, "remote.html"), "utf8");
  const moduleMatch = html.match(/<script\s+type="module"[^>]+src="([^"]+)"[^>]*><\/script>/);
  assert.ok(moduleMatch, "built remote.html has no module entrypoint");
  const shell = html.replace(moduleMatch[0], "");

  await command(driverOrigin, sessionId, "/url", { body: { url: `${origin}/ios-harness` } });
  await execute(
    driverOrigin,
    sessionId,
    "document.open(); document.write(arguments[0]); document.close(); return true;",
    [shell]
  );
  await execute(
    driverOrigin,
    sessionId,
    `${await readFile(path.join(ROOT, "node_modules/tweetnacl/nacl-fast.min.js"), "utf8")}\n(${installEncryptedMock.toString()})(); return true;`
  );
  await execute(
    driverOrigin,
    sessionId,
    `return (${installFakeRelay.toString()})(arguments[0]);`,
    [REMOTE_COMPOSER_FIXTURE]
  );
  await execute(driverOrigin, sessionId, `(${pinRelayVerifyKey.toString()})(); return true;`);
  await waitFor(
    () => execute(driverOrigin, sessionId, "return window.__agentRelaySecretReady === true;"),
    "the fake relay secret"
  );
  await execute(
    driverOrigin,
    sessionId,
    `const entry = document.createElement("script");
     entry.type = "module";
     entry.src = arguments[0];
     document.head.appendChild(entry);
     return true;`,
    [`${origin}${moduleMatch[1]}`]
  );
  await waitFor(
    () => execute(driverOrigin, sessionId, "return Boolean(document.querySelector('#remote-message-input'));"),
    "the remote composer"
  );
  await waitFor(
    () =>
      execute(
        driverOrigin,
        sessionId,
        `const transcript = document.querySelector("#remote-transcript")?.textContent || "";
         return transcript.includes("MOBILE-HEADER-TAIL-E2E") && (window.__listsAfterClaim || 0) > 0;`
      ),
    "the claimed remote session"
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function openProviderMenu(driverOrigin, sessionId) {
  await execute(
    driverOrigin,
    sessionId,
    `const input = document.querySelector("#remote-message-input");
     const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
     setter.call(input, "/rev");
     input.dispatchEvent(new InputEvent("input", {
       bubbles: true,
       inputType: "insertText",
       data: "/rev",
     }));
     input.focus();
     if (!window.__iosCommandEvents) {
       for (const type of ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel", "click"]) {
         document.addEventListener(type, (event) => {
           window.__iosCommandEvents.push({
             type,
             target: event.target?.className || "",
             tag: event.target?.tagName || "",
             pointerType: event.pointerType || "",
             trusted: event.isTrusted,
           });
         }, true);
       }
     }
     window.__iosCommandEvents = [];
     return true;`
  );
  return waitFor(
    async () => {
      const rows = await execute(
        driverOrigin,
        sessionId,
        `return [...document.querySelectorAll(".composer-command-row")].map((row) => ({
          text: row.innerText,
          className: row.className,
        }));`
      );
      return rows.some((row) => row.className.includes("is-provider")) && rows;
    },
    "the provider command row"
  );
}

async function tapElement(driverOrigin, sessionId, selector) {
  const element = await command(driverOrigin, sessionId, "/element", {
    body: { using: "css selector", value: selector },
  });
  assert.ok(element[ELEMENT_KEY], `SafariDriver did not return ${selector}`);
  await command(driverOrigin, sessionId, `/element/${element[ELEMENT_KEY]}/click`, { body: {} });

  // On the iOS driver, element click begins the native finger contact. Releasing
  // input sources ends that contact and emits the pointerup/touchend side of the tap.
  await command(driverOrigin, sessionId, "/actions", { method: "DELETE" });
}

async function tapProviderCommand(driverOrigin, sessionId) {
  await tapElement(driverOrigin, sessionId, ".composer-command-row.is-provider");
  return waitFor(
    async () => {
      const state = await execute(
        driverOrigin,
        sessionId,
        `return {
          pills: [...document.querySelectorAll(".composer-command-pill-label")].map((pill) => pill.textContent),
          value: document.querySelector("#remote-message-input")?.value,
          menuOpen: Boolean(document.querySelector(".composer-command-menu")),
          events: window.__iosCommandEvents || [],
        };`
      );
      return state.pills.length > 0 && state;
    },
    "the selected command pill"
  );
}

async function tapPillPart(driverOrigin, sessionId, selector) {
  await execute(driverOrigin, sessionId, "window.__iosCommandEvents = []; return true;");
  const point = await execute(driverOrigin, sessionId, `const part = document.querySelector(arguments[0]);
    const box = part.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
    return { x, y, hittable: part.closest('button').contains(document.elementFromPoint(x, y)) };`, [selector]);
  assert.equal(point.hittable, true, `${selector} is not covered — ${JSON.stringify(point)}`);
  // Element-click rejects these non-interactive spans. iOS SafariDriver maps a
  // mouse source to native touch; assertNativeTouch verifies the received events.
  await command(driverOrigin, sessionId, "/actions", { body: { actions: [{
    type: "pointer", id: "pill-tap", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", duration: 0, origin: "viewport", x: point.x, y: point.y },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ],
  }] } });
  await command(driverOrigin, sessionId, "/actions", { method: "DELETE" });
}

function assertNativeTouch(events, label) {
  const pointerEvents = events.filter((event) => event.type === "pointerdown" || event.type === "pointerup");
  console.log(`${label}: ${JSON.stringify(pointerEvents)}`);
  for (const type of ["pointerdown", "pointerup"]) {
    assert.equal(pointerEvents.filter((event) => event.type === type).length, 1,
      `${label}: each native ${type} is recorded exactly once`);
    assert.ok(pointerEvents.some((event) => event.type === type && event.pointerType === "touch"
      && event.trusted && String(event.target).includes("composer-command")),
    `${label}: trusted ${type} must take the touch path — ${JSON.stringify(events)}`);
  }
}

async function assertSlashMenu(driverOrigin, sessionId, udid) {
  const read = (script) => execute(driverOrigin, sessionId, script);
  await tapElement(driverOrigin, sessionId, "#remote-message-input");
  // Seed the draft like the provider-tap fixture; this is not a keyboard input test.
  await read(`const input = document.querySelector('#remote-message-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '/');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/' }));
    return true;`);
  await waitFor(() => read(`return document.querySelector('.composer-command-expand')
    && document.activeElement?.id === 'remote-message-input';`), "slash commands retaining input focus");
  if (process.env.IOS_SCREENSHOT) {
    run("xcrun", ["simctl", "io", udid, "screenshot", process.env.IOS_SCREENSHOT.replace(/\.png$/, "-menu.png")]);
  }

  assert.equal(await read("return document.activeElement?.id;"), "remote-message-input", "opening the menu keeps typing focus");
  for (const selector of [".composer-command-row", ".composer-command-expand"]) {
    await execute(driverOrigin, sessionId, `const row = document.querySelector(arguments[0]);
      const menu = row.closest('.composer-command-menu');
      menu.scrollTop += row.getBoundingClientRect().top - menu.getBoundingClientRect().top - 8;
      return true;`, [selector]);
    const box = await execute(driverOrigin, sessionId, `const row = document.querySelector(arguments[0]);
      const r = row.getBoundingClientRect();
      const menu = row.closest('.composer-command-menu').getBoundingClientRect();
      return { top: menu.top, bottom: menu.bottom, viewportTop: visualViewport.offsetTop,
        viewportBottom: visualViewport.offsetTop + visualViewport.height,
        rowTop: r.top, rowBottom: r.bottom,
        hittable: row.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };`, [selector]);
    assert.ok(box.top >= box.viewportTop && box.bottom <= box.viewportBottom,
      `the complete menu fits the native Safari viewport — ${JSON.stringify(box)}`);
    assert.ok(box.rowTop >= box.top && box.rowBottom <= box.bottom && box.hittable,
      `${selector} is readable and tappable while the input is focused — ${JSON.stringify(box)}`);
  }
  if (process.env.IOS_SCREENSHOT) {
    run("xcrun", ["simctl", "io", udid, "screenshot", process.env.IOS_SCREENSHOT.replace(/\.png$/, "-focused.png")]);
  }
  await tapElement(driverOrigin, sessionId, ".composer-command-expand");
  await waitFor(() => read(`return document.querySelector('.composer-command-expand')?.getAttribute('aria-expanded') === 'true'
    && document.activeElement?.matches('.composer-command-expand');`), "expanding without focusing the composer");
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("ios-remote-composer-commands-e2e SKIPPED — iOS Simulator requires macOS and Xcode");
    return;
  }
  if (isPublicBuild()) {
    console.log(
      "ios-remote-composer-commands-e2e SKIPPED — public checkout: swap in the private crate and rebuild web/"
    );
    return;
  }

  const simulator = chooseSimulator();
  const bootedByTest = simulator.state !== "Booted";
  if (bootedByTest) run("xcrun", ["simctl", "boot", simulator.udid]);
  run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", simulator.udid]);
  run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  dismissSafariOnboarding(simulator.udid);

  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: {
      "/manifest.webmanifest": "remote-manifest.webmanifest",
      "/sw.js": "remote-sw.js",
    },
    stripStaticPrefix: true,
  });
  const driverPort = await getFreePort();
  const driverOrigin = `http://127.0.0.1:${driverPort}`;
  const safaridriver = process.env.SAFARIDRIVER_PATH || run("xcrun", ["--find", "safaridriver"]);
  const driver = spawn(safaridriver, ["-p", String(driverPort)], { stdio: ["ignore", "pipe", "pipe"] });
  let driverOutput = "";
  driver.stdout.on("data", (chunk) => (driverOutput += chunk));
  driver.stderr.on("data", (chunk) => (driverOutput += chunk));
  let sessionId;

  try {
    await waitForDriver(driverOrigin, driver);
    const session = await command(driverOrigin, null, "/session", {
      body: {
        capabilities: {
          alwaysMatch: {
            browserName: "Safari",
            platformName: "iOS",
            "safari:useSimulator": true,
            "safari:deviceUDID": simulator.udid,
          },
        },
      },
    });
    sessionId = session.sessionId;
    const origin = `http://127.0.0.1:${server.port}`;
    await loadRemoteFixture(driverOrigin, sessionId, origin);
    if (await execute(driverOrigin, sessionId, "return Boolean(document.querySelector('.ios-install-hint__close'));")) {
      await tapElement(driverOrigin, sessionId, ".ios-install-hint__close");
      await waitFor(() => execute(driverOrigin, sessionId, "return !document.querySelector('#ios-install-hint');"),
        "the install hint to stop covering the composer");
    }
    await assertSlashMenu(driverOrigin, sessionId, simulator.udid);
    const rows = await openProviderMenu(driverOrigin, sessionId);
    assert.deepEqual(
      rows.map((row) => row.text.split("\n")[0]),
      ["/review", "$review"],
      "Mobile Safari shows both the Sealwire command and provider skill"
    );
    const selected = await tapProviderCommand(driverOrigin, sessionId);
    assert.deepEqual(selected.pills, ["$review"], "the iOS tap commits the provider skill");
    assert.equal(selected.value, "", "the selected command text is consumed");
    assert.equal(selected.menuOpen, false, "the command menu closes after the iOS tap");
    assert.notEqual(await execute(driverOrigin, sessionId, "return document.activeElement?.id;"),
      "remote-message-input", "picking the skill does not reopen the keyboard");
    assertNativeTouch(selected.events, "select provider command");

    for (const selector of [".composer-command-pill-label", ".composer-command-pill-clear"]) {
      await tapPillPart(driverOrigin, sessionId, selector);
      await waitFor(
        () => execute(driverOrigin, sessionId, "return !document.querySelector('.composer-command-pill');"),
        `removing the pill through ${selector}`
      );
      assertNativeTouch(await execute(driverOrigin, sessionId, "return window.__iosCommandEvents;"), selector);
      if (selector === ".composer-command-pill-label") {
        await openProviderMenu(driverOrigin, sessionId);
        await tapProviderCommand(driverOrigin, sessionId);
      }
    }

    if (process.env.IOS_SCREENSHOT) {
      run("xcrun", ["simctl", "io", simulator.udid, "screenshot", process.env.IOS_SCREENSHOT]);
    }
    console.log(
      `ios-remote-composer-commands-e2e OK — ${simulator.name} (${simulator.udid}) selected and removed $review`
    );
  } catch (error) {
    if (sessionId) {
      console.error(await execute(driverOrigin, sessionId, `return {
        draft: document.querySelector('#remote-message-input')?.value,
        focused: document.activeElement?.outerHTML?.slice(0, 500),
        rows: document.querySelectorAll('.composer-command-row').length,
        finePointer: matchMedia('(pointer: fine)').matches,
        viewport: { top: visualViewport.offsetTop, height: visualViewport.height }
      };`).catch(() => null));
      if (process.env.IOS_SCREENSHOT) {
        run("xcrun", ["simctl", "io", simulator.udid, "screenshot", process.env.IOS_SCREENSHOT.replace(/\.png$/, "-failure.png")]);
      }
    }
    if (driverOutput.trim()) console.error(driverOutput.trim());
    throw error;
  } finally {
    if (sessionId) {
      await command(driverOrigin, sessionId, "", { method: "DELETE" }).catch(() => {});
    }
    driver.kill("SIGTERM");
    await server.close();
    if (bootedByTest && process.env.IOS_KEEP_SIMULATOR !== "1") {
      run("xcrun", ["simctl", "shutdown", simulator.udid]);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
