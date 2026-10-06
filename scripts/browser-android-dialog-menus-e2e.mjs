// The picker menus, on a REAL mobile browser.
//
// Everything else in this suite is Chromium-on-desktop wearing a phone costume:
// `hasTouch`/`isMobile` set a few flags, but it is still the same engine, the same
// compositor, and a `visualViewport` that never moves. This drives actual Chrome
// on an actual Android device (or emulator) over adb — real touch digitiser, real
// mobile viewport, real top-layer and `overflow` behaviour.
//
// It is OPT-IN (`ANDROID_E2E=1`) and skips cleanly when no device is attached,
// because it needs an emulator booted and Chrome past its first-run screen. See
// the header of `androidDevice()` for the two setup commands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const ADB = process.env.ADB_PATH || path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb");
const CDP_PORT = Number(process.env.ANDROID_CDP_PORT || 9222);
const ATTACH_TOLERANCE_PX = 28;

function logStep(message, details) {
  console.log(`[android-dialog-menus-e2e] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

function adb(...args) {
  return execFileSync(ADB, args, { encoding: "utf8" }).trim();
}

/**
 * Requires a booted device with Chrome past its first-run screen:
 *
 *   emulator -avd <name> -no-window -no-audio -no-boot-anim
 *   adb shell am start -a android.intent.action.VIEW -d about:blank \
 *     -n com.android.chrome/com.google.android.apps.chrome.Main
 *   # then dismiss "Use without an account" once
 *
 * Playwright's own `_android.launchBrowser()` is deliberately NOT used: it asks
 * Chrome for a private debugging socket via intent extras, which release builds
 * ignore, so it hangs forever. The stock `chrome_devtools_remote` socket that
 * every Chrome exposes works, and `connectOverCDP` speaks to it directly.
 */
function androidDevice() {
  const attached = adb("devices")
    .split("\n")
    .slice(1)
    .filter((line) => line.trim().endsWith("\tdevice"));
  return attached.length ? attached[0].split("\t")[0] : null;
}

// Playwright refuses `page.tap()` on a CDP-attached context because `hasTouch`
// was never set in context options — it cannot be, the context already existed.
// The digitiser is real regardless, so drive it through the protocol.
async function tap(cdp, page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} has no box to tap`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", {
    touchPoints: [{ x, y }],
    type: "touchStart",
  });
  await cdp.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
}

function measureInPage({ menuSel, triggerSel }) {
  const trigger = document.querySelector(triggerSel);
  const menu = document.querySelector(menuSel);
  if (!trigger || !menu) {
    return { missing: !trigger ? "trigger" : "menu" };
  }
  const box = (r) => ({
    bottom: Math.round(r.bottom),
    height: Math.round(r.height),
    left: Math.round(r.left),
    right: Math.round(r.right),
    top: Math.round(r.top),
    width: Math.round(r.width),
  });
  const m = menu.getBoundingClientRect();
  const probeX = Math.round(m.left + m.width / 2);
  const probeY = Math.round(m.top + Math.min(m.height / 2, 20));
  const hit = document.elementFromPoint(probeX, probeY);
  return {
    hitIsMenu: Boolean(hit) && (hit === menu || menu.contains(hit)),
    hitTag: hit ? hit.tagName.toLowerCase() : null,
    menu: box(m),
    placement: menu.dataset.placement,
    trigger: box(trigger.getBoundingClientRect()),
    viewport: { height: window.innerHeight, width: window.innerWidth },
  };
}

async function assertMenuUsable(page, cdp, { menuSel, name, triggerSel }) {
  await page.waitForSelector(triggerSel, { state: "visible", timeout: TIMEOUT_MS });
  await tap(cdp, page, triggerSel);
  await page.waitForSelector(menuSel, { state: "attached", timeout: TIMEOUT_MS });

  const m = await page.evaluate(measureInPage, { menuSel, triggerSel });
  assert.equal(m.missing, undefined, `${name}: ${m.missing} missing`);
  const where = JSON.stringify({ menu: m.menu, trigger: m.trigger, viewport: m.viewport });

  assert.ok(m.menu.height > 0 && m.menu.width > 0, `${name}: zero-size menu — ${where}`);
  assert.ok(
    m.menu.top >= 0 && m.menu.bottom <= m.viewport.height,
    `${name}: menu is outside the viewport vertically — ${where}`
  );
  assert.ok(
    m.menu.left >= 0 && m.menu.right <= m.viewport.width,
    `${name}: menu is outside the viewport horizontally — ${where}`
  );
  const below = Math.abs(m.menu.top - m.trigger.bottom);
  const above = Math.abs(m.trigger.top - m.menu.bottom);
  assert.ok(
    below <= ATTACH_TOLERANCE_PX || above <= ATTACH_TOLERANCE_PX,
    `${name}: menu detached from trigger (below=${below} above=${above}) — ${where}`
  );
  assert.ok(m.hitIsMenu, `${name}: menu centre hits <${m.hitTag}> — ${where}`);

  logStep(`ok ${name}`, { height: m.menu.height, placement: m.placement });
  await page.keyboard.press("Escape");
  await page.waitForSelector(menuSel, { state: "detached", timeout: TIMEOUT_MS });
}

async function assertProjectSearchWithKeyboard(page, cdp) {
  const within = "#launch-start-session-dialog";
  const menuSel = `${within} .project-switcher-menu`;
  const height = await page.evaluate(() => visualViewport.height);
  await tap(cdp, page, `${within} .project-picker-trigger`);
  const menu = page.locator(menuSel);
  await menu.waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  assert.equal(await menu.locator(".context-menu-filter input").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName === "INPUT"), false);
  assert.ok(Math.abs(await page.evaluate(() => visualViewport.height) - height) < 5);
  await fs.mkdir("artifacts/e2e", { recursive: true });
  await fs.writeFile("artifacts/e2e/android-project-menu.png", execFileSync(ADB, ["exec-out", "screencap", "-p"]));

  await tap(cdp, page, `${menuSel} .project-menu-search-toggle`);
  await page.waitForFunction(
    (before) => visualViewport.height < before - 120,
    height,
    { timeout: TIMEOUT_MS }
  );
  const input = menu.locator(".context-menu-filter input");
  assert.equal(await input.evaluate((node) => node.ownerDocument.activeElement === node), true);
  await input.fill("Keyboard project");
  assert.equal(await menu.locator(".project-switcher-option").count(), 12);
  const scroller = menu.locator(".project-menu-rows");
  await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(500);
  const layout = await menu.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const inputBox = node.querySelector("input").getBoundingClientRect();
    const rows = node.querySelector(".project-menu-rows");
    const last = [...rows.querySelectorAll(".project-switcher-option")].at(-1);
    const lastBox = last.getBoundingClientRect();
    const hit = document.elementFromPoint(lastBox.left + lastBox.width / 2, lastBox.top + lastBox.height / 2);
    return {
      inputVisible: inputBox.top >= visualViewport.offsetTop
        && inputBox.bottom <= visualViewport.offsetTop + visualViewport.height,
      menuVisible: box.top >= visualViewport.offsetTop
        && box.bottom <= visualViewport.offsetTop + visualViewport.height + 1,
      rowsHeight: rows.clientHeight,
      scrollTop: rows.scrollTop,
      lastReachable: hit === last || last.contains(hit),
    };
  });
  assert.ok(layout.inputVisible && layout.menuVisible, JSON.stringify(layout));
  assert.ok(layout.rowsHeight >= 84, `keyboard leaves fewer than three rows: ${JSON.stringify(layout)}`);
  assert.ok(layout.scrollTop > 0 && layout.lastReachable, JSON.stringify(layout));
  await fs.writeFile("artifacts/e2e/android-project-search.png", execFileSync(ADB, ["exec-out", "screencap", "-p"]));
  const lastId = await menu.locator(".project-switcher-option").last().getAttribute("data-project-id");
  await tap(cdp, page, `${menuSel} [data-project-id="${lastId}"]`);
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction((before) => visualViewport.height >= before - 5, height);
  assert.ok(await page.locator(`${within}[open]`).count());
  logStep("ok project search with native keyboard", layout);
}

async function main() {
  if (!process.env.ANDROID_E2E) {
    logStep("SKIP (set ANDROID_E2E=1 to run)");
    return;
  }
  const serial = androidDevice();
  if (!serial) {
    logStep("SKIP: no adb device attached");
    return;
  }
  logStep("device", { serial });

  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-android-"));
  const relay = startLocalRelay({
    extraEnv: { AGENT_PROVIDERS: "fake,codex,claude" },
    relayPort,
    relayStateDb: path.join(stateDir, "sealwire.db"),
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  for (let index = 1; index <= 12; index += 1) {
    const response = await fetch(`http://127.0.0.1:${relayPort}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
      body: JSON.stringify({ action: "create", name: `Keyboard project ${index}`, device_id: "android-e2e" }),
    });
    assert.equal(response.status, 200, await response.text());
  }

  // The device's own loopback, pointed back at the relay on this machine.
  adb("reverse", `tcp:${relayPort}`, `tcp:${relayPort}`);
  adb("forward", `tcp:${CDP_PORT}`, "localabstract:chrome_devtools_remote");

  let browser;
  let page;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0];
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    logStep("loaded", await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      dpr: devicePixelRatio,
      touchPoints: navigator.maxTouchPoints,
      viewport: { height: innerHeight, width: innerWidth },
    })));

    await tap(cdp, page, "#open-start-session-dialog");
    await page.waitForSelector("#launch-start-session-dialog[open]", { timeout: TIMEOUT_MS });

    await assertProjectSearchWithKeyboard(page, cdp);

    const within = "#launch-start-session-dialog";
    for (const picker of [
      { menuSel: `${within} .project-switcher-menu`, name: "project", triggerSel: `${within} .project-picker-trigger` },
      { menuSel: `${within} .workspace-picker-panel`, name: "workspace", triggerSel: `${within} .workspace-picker-trigger` },
      { menuSel: `${within} .model-picker-menu`, name: "model", triggerSel: `${within}-model` },
      { menuSel: `${within} .setting-pill-menu`, name: "effort", triggerSel: `${within}-effort` },
      { menuSel: `${within} .setting-pill-menu`, name: "approval", triggerSel: `${within}-approval` },
    ]) {
      await assertMenuUsable(page, cdp, picker);
    }

    logStep("PASS");
  } catch (error) {
    if (page) {
      await page.screenshot({ path: "artifacts/e2e/android-dialog-menus.png" }).catch(() => {});
    }
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    try {
      adb("reverse", "--remove", `tcp:${relayPort}`);
    } catch {}
    await stopManagedProcess(relay).catch(() => {});
    await fs.rm(stateDir, { force: true, recursive: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("[android-dialog-menus-e2e] FAILED", error);
  process.exitCode = 1;
});
