import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright";

import { installFakeRelay, isPublicBuild, openComposer, readMenu, REMOTE_COMPOSER_FIXTURE } from "./browser-remote-composer-commands-e2e.mjs";
import { addEncryptedBrokerInitScript } from "./e2e/harness/encrypted-broker-mock.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const input = "#remote-message-input";
if (isPublicBuild()) {
  console.log("remote-slash-keyboard-e2e SKIPPED — swap in the private crate and rebuild web/");
  process.exit(0);
}
const screenshots = process.env.SLASH_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const server = await startStaticServer({
  rootDir: path.resolve("web"),
  indexFile: "remote.html",
  pathAliases: { "/manifest.webmanifest": "remote-manifest.webmanifest", "/sw.js": "remote-sw.js" },
  stripStaticPrefix: true,
});

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function geometry(page) {
  return page.evaluate(() => {
    const menu = document.querySelector(".composer-command-menu");
    const box = menu.getBoundingClientRect();
    return {
      top: box.top, bottom: box.bottom, height: box.height,
      viewportTop: visualViewport.offsetTop,
      viewportBottom: visualViewport.offsetTop + visualViewport.height,
      threadTop: document.querySelector(".remote-thread-panel .thread-shell").getBoundingClientRect().top,
      composerTop: document.querySelector(".composer-inner").getBoundingClientRect().top,
      focused: document.activeElement?.id,
      scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight,
    };
  });
}

function assertFits(box, label) {
  assert.ok(box.height > 50, `${label}: usable list height — ${JSON.stringify(box)}`);
  assert.ok(box.top >= Math.max(box.viewportTop, box.threadTop), `${label}: list top is visible — ${JSON.stringify(box)}`);
  assert.ok(box.bottom <= Math.min(box.viewportBottom, box.composerTop), `${label}: list bottom is visible — ${JSON.stringify(box)}`);
}

async function assertReachable(page, selector) {
  const target = page.locator(selector).first();
  await target.evaluate((row) => {
    const menu = row.closest(".composer-command-menu");
    menu.scrollTop += row.getBoundingClientRect().top - menu.getBoundingClientRect().top - 8;
  });
  const result = await target.evaluate((row) => {
    const box = row.getBoundingClientRect();
    const menu = row.closest(".composer-command-menu").getBoundingClientRect();
    return {
      visible: box.top >= Math.max(menu.top, visualViewport.offsetTop)
        && box.bottom <= Math.min(menu.bottom, visualViewport.offsetTop + visualViewport.height),
      hittable: row.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
    };
  });
  assert.deepEqual(result, { visible: true, hittable: true }, `${selector} can be read and tapped`);
}

async function assertRepeatedFilter(page, removeWithBackspace) {
  await page.fill(input, "/rev");
  await page.tap(".composer-command-row:not(.is-provider)");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "/review");
  assert.equal((await readMenu(page)).surfaceDraft.value, "");
  if (removeWithBackspace) {
    await page.press(input, "Backspace");
    assert.equal(await page.locator(".composer-command-pill").count(), 0);
    assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
      "Backspace removal is part of typing and keeps keyboard focus");
  }
  // A paste/IME commit can deliver the entire previous filter in one input event.
  // Clicking the pill to remove it refreshes React's tracker and hides this bug.
  await page.fill(input, "/rev");
  const state = await readMenu(page);
  assert.equal(state.fieldValue, "/rev");
  assert.deepEqual(state.surfaceDraft, { found: true, value: "/rev" },
    `React retains repeated text ${removeWithBackspace ? "after Backspace" : "with the command still selected"}`);
}

async function assertFilterCorrection(page) {
  await page.tap(input);
  await page.keyboard.type("/");
  await page.waitForSelector(".composer-command-expand");
  await settle(page);
  await page.keyboard.type("revzzq", { delay: 120 });
  assert.equal(await page.locator(".composer-command-menu").count(), 0);
  for (let count = 0; count < 3; count += 1) await page.keyboard.press("Backspace");
  await page.waitForSelector(".composer-command-row.is-provider");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "correcting a filter to reopen its menu must keep the keyboard focus");
  await page.keyboard.type("iew", { delay: 120 });
  assert.equal(await page.inputValue(input), "/review", "typing continues after the menu reappears");
  assert.deepEqual((await readMenu(page)).surfaceDraft, { found: true, value: "/review" });
}

async function assertContinuousTyping(page) {
  await page.tap(input);
  for (const text of ["/review", "hello", "/review"]) {
    await page.keyboard.type(text, { delay: 120 });
    assert.equal(await page.inputValue(input), text, "each character reaches the composer without refocusing");
    assert.deepEqual((await readMenu(page)).surfaceDraft, { found: true, value: text });
    assert.equal(await page.locator(".composer-command-pill").count(), 0, "typing does not accidentally select a command");
    for (const character of text) await page.keyboard.press("Backspace");
  }
  await page.keyboard.type("/rev", { delay: 120 });
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "/review");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/review", { delay: 120 });
  assert.equal(await page.inputValue(input), "/review", "typing after Backspace removal follows the same focus rule");
  assert.equal(await page.locator(".composer-command-pill").count(), 0);
  assert.deepEqual((await readMenu(page)).surfaceDraft, { found: true, value: "/review" });
}

async function assertKeyboardPick(page) {
  // Seed only the setup to isolate Enter from the separately tested initial slash.
  await page.fill(input, "/rev");
  await page.waitForSelector(".composer-command-row.is-provider");
  await settle(page);
  await page.tap(input);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "$review");
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "Enter selects a command while retaining typing focus on a touch device");
  await page.keyboard.type("check auth", { delay: 120 });
  assert.deepEqual((await readMenu(page)).surfaceDraft, { found: true, value: "check auth" });
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "$review",
    "the next Enter must not activate the pill's remove button");
  assert.equal(await page.inputValue(input), "check auth\n", "the mobile composer's Enter still inserts a newline");
  await page.tap("#remote-send-button");
  await page.waitForFunction(() => window.__sentMessages?.length === 1);
  const sent = await page.evaluate(() => window.__sentMessages[0]);
  assert.equal(sent.input.text.trimEnd(), "check auth", "the message retains the text typed after selecting a command");
  assert.deepEqual(sent.skill, { name: "review", path: "/tmp/e2e-mobile-header/.agents/skills/review/SKILL.md" });
}

async function assertKeyboardExpand(page) {
  await page.tap(input);
  await page.keyboard.type("/");
  await page.waitForSelector(".composer-command-expand");
  const count = await page.locator(".composer-command-row").count();
  for (let index = 0; index < count; index += 1) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.getAttribute(".composer-command-expand", "aria-expanded"), "true");
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "expanding with Enter from the textarea retains typing focus");
  await page.keyboard.type("rev", { delay: 120 });
  assert.deepEqual((await readMenu(page)).surfaceDraft, { found: true, value: "/rev" });
  // A trackpad click is distinct from a finger tap even on a touch-first tablet.
  await page.click(".composer-command-row.is-provider");
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "a mouse pick on a touch device retains the composer for typing");
  await page.keyboard.type("check auth", { delay: 120 });
  assert.equal(await page.inputValue(input), "check auth");
}

async function assertBackgroundFocus(page, viewport) {
  await page.fill(input, "/batch-skill-11");
  await page.waitForSelector(".composer-command-row.is-provider");
  await settle(page);
  // Another field's software keyboard must not let a catalogue refresh grab focus.
  if (viewport.height > 600) {
    await page.setViewportSize({ width: viewport.width, height: 366 });
    await settle(page);
  }
  await page.evaluate(() => window.__fakeRelay.moveSession({ current_cwd: "/tmp/e2e-elsewhere" }));
  await page.waitForFunction(() => !document.querySelector(".composer-command-menu"));
  await page.evaluate(() => {
    const other = document.createElement("input");
    other.id = "other-field";
    other.style.cssText = "position:fixed;top:80px;left:10px;z-index:999";
    document.body.append(other);
  });
  await page.tap("#other-field");
  await page.keyboard.type("ab", { delay: 120 });
  await page.evaluate(() => window.__fakeRelay.moveSession({ current_cwd: "/tmp/e2e-mobile-header" }));
  await page.waitForSelector(".composer-command-row.is-provider");
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "other-field",
    "a background catalogue update must not take focus from another field");
  await page.keyboard.type("cd", { delay: 120 });
  assert.equal(await page.inputValue("#other-field"), "abcd");
  assert.equal(await page.inputValue(input), "/batch-skill-11");

  await page.fill(input, "");
  await page.$eval(input, (node) => node.blur());
  // Move focus in the same task as the input event, before deferred placement runs.
  await page.evaluate(() => {
    const composer = document.querySelector("#remote-message-input");
    composer.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(composer, "/");
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "/" }));
    document.querySelector("#other-field").focus();
  });
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "other-field",
    "deferred menu placement respects a focus change after the input event");
}

async function assertIosKeyboard(page, viewport, dismiss) {
  // Match the native 714 -> 366 contraction, not a larger desktop-sized delta.
  await page.setViewportSize({ width: viewport.width, height: 714 });
  await settle(page);
  await page.tap(input);
  if (!dismiss) {
    await page.keyboard.type("/");
    await page.waitForSelector(".composer-command-menu");
    await page.tap(input);
  }
  // Native iOS shrank innerHeight but retained a 348px pan offset. Reproduce those
  // measurements here; only a native test can prove the software keyboard closes.
  await page.evaluate(() => Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 348 }));
  await page.setViewportSize({ width: viewport.width, height: 366 });
  if (dismiss) await page.keyboard.type("/");
  await page.waitForSelector(".composer-command-menu");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), !dismiss,
    dismiss ? "opening commands releases input focus in a keyboard-sized viewport" : "explicit filtering retains input focus");
  assert.equal((await readMenu(page)).surfaceDraft.value, "/");
  const box = await geometry(page);
  assert.ok(box.height > 100 && box.top >= box.threadTop && box.bottom <= 366,
    `iOS resize plus residual pan must leave a usable menu: ${JSON.stringify(box)}`);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, `${viewport.width}-ios-${dismiss ? "dismiss" : "filter"}.png`) });
  if (dismiss) {
    await page.tap(".composer-command-row");
    assert.equal(await page.locator(".composer-command-pill").count(), 0,
      "a touch intended for the retreating keyboard must not select a command");
    await page.evaluate(() => { delete visualViewport.offsetTop; });
    await page.setViewportSize(viewport);
    await page.waitForTimeout(1050);
    const restored = await geometry(page);
    assert.ok(restored.height > Math.min(500, (restored.composerTop - restored.threadTop) * 0.8),
      `the long touch menu uses the space released by the keyboard: ${JSON.stringify(restored)}`);
    await assertReachable(page, ".composer-command-expand");
    await page.tap(".composer-command-expand");
    const last = page.locator(".composer-command-row.is-provider").last();
    await last.evaluate((row) => { row.closest(".composer-command-menu").scrollTop = row.offsetTop; });
    await last.tap();
    assert.equal(await page.locator(".composer-command-pill").count(), 1,
      "the final command in the expanded long list is selectable");
  } else {
    await page.keyboard.type("revzzq", { delay: 120 });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("iew", { delay: 120 });
    assert.equal(await page.inputValue(input), "/review");
    assert.equal(await page.$eval(input, (node) => document.activeElement === node), true);
  }
}

async function assertInstructionEditing(page, viewport) {
  await page.fill(input, "/rev");
  await page.tap(".composer-command-row:not(.is-provider)");
  await page.tap(input);
  await page.keyboard.type("please check");
  await page.$eval(input, (node) => node.blur());
  await settle(page);
  await page.tap(input);
  await page.setViewportSize({ width: viewport.width, height: 366 });
  await page.keyboard.press("End");
  for (let count = 0; count < 11; count += 1) await page.keyboard.press("Backspace");
  await page.waitForSelector(".composer-command-row");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "argument suggestions appearing while editing instructions must not dismiss the keyboard");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("fix the login", { delay: 120 });
  assert.deepEqual((await readMenu(page)).surfaceDraft, { found: true, value: "fix the login" });
  for (const character of "fix the login") await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "session suggestions are part of editing an already selected command");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "/review");
}

async function assertDismissalGesture(page, viewport, engine) {
  // Freeze wall time, not animation frames, so down and click straddle the guard
  // deterministically even when the browser or CI host is slow.
  await page.clock.setFixedTime(new Date("2026-01-01T00:00:00Z"));
  await page.tap(input);
  await page.setViewportSize({ width: viewport.width, height: 366 });
  await page.keyboard.type("/");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), false);
  await page.setViewportSize(viewport);
  await settle(page);
  for (const elapsed of [650, 800, 1150, 1450]) {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, elapsed)));
    await page.tap(".composer-command-row");
    assert.equal(await page.locator(".composer-command-pill").count(), 0,
      "continued taps at the former keyboard position must not select or remove commands");
  }
  const row = page.locator(".composer-command-row").first();
  const box = await row.boundingBox();
  const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
  else await row.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1, bubbles: true, cancelable: true });
  await page.clock.setFixedTime(new Date("2026-01-01T00:00:03Z"));
  if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  else {
    await row.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1, bubbles: true });
    await row.dispatchEvent("click", { detail: 1, bubbles: true, cancelable: true });
  }
  assert.equal(await page.locator(".composer-command-pill").count(), 0,
    "a touch starting during dismissal stays blocked when released after the guard expires");
  assert.equal(await page.inputValue(input), "/");
  await row.tap();
  assert.equal(await page.locator(".composer-command-pill").count(), 1,
    "a fresh touch after dismissal selects normally");
}

async function assertKeyboardDetection(page, viewport, composition) {
  await page.setViewportSize({ width: viewport.width, height: 714 });
  await settle(page);
  await page.tap(input);
  if (composition) await page.dispatchEvent(input, "compositionstart", { data: "" });
  await page.setViewportSize({ width: viewport.width, height: composition ? 366 : 644 });
  await page.keyboard.type("/");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    composition ? "composition must not be interrupted by keyboard dismissal" : "browser chrome resizing is not a software keyboard");
  if (composition) {
    await page.dispatchEvent(input, "compositionend", { data: "/" });
  } else {
    await page.keyboard.press("Backspace");
    await page.setViewportSize({ width: viewport.width, height: 366 });
    await page.keyboard.type("/");
  }
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), false,
    composition ? "the committed composition opens commands and dismisses the keyboard" : "a native-sized contraction dismisses the keyboard");
  assert.equal((await readMenu(page)).surfaceDraft.value, "/");
  // Returning to filtering applies to this query, not every future slash draft.
  await page.tap(input);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("hello");
  for (const character of "hello") await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), false,
    "a new slash draft follows the same keyboard rule after an earlier filter was cleared");
  await page.tap(input);
  await page.keyboard.type("rev");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "/review");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), false,
    "a new slash draft also dismisses after removing the previous command with Backspace");
}

async function assertLandscapeFilter(page, viewport, label) {
  await page.tap(input);
  await page.keyboard.type("/");
  await page.waitForSelector(".composer-command-menu");
  await settle(page);
  await page.tap(input);
  await page.setViewportSize({ width: viewport.width, height: viewport.width === 844 ? 190 : 170 });
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true,
    "landscape filtering keeps typing focus");
  const box = await geometry(page);
  assert.ok(box.top >= 0 && box.bottom <= box.composerTop, `landscape menu fits above the input: ${JSON.stringify(box)}`);
  await assertReachable(page, ".composer-command-row");
  await assertReachable(page, ".composer-command-expand");
  await page.keyboard.type("rev");
  await settle(page);
  await assertReachable(page, ".composer-command-row.is-provider");
  if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}.png`) });
  await page.tap(".composer-command-row.is-provider");
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "$review");
}

async function assertTinyViewport(page, viewport, label) {
  await page.fill(input, "/");
  await page.waitForSelector(".composer-command-menu");
  await page.tap(input);
  await page.setViewportSize({ width: viewport.width, height: 118 });
  // Reproduce native iOS's panned input and remaining strip, including its stale offset.
  // This isolates placement; XCTest separately verifies actual keyboard taps.
  await page.evaluate(() => {
    const field = document.querySelector("#remote-message-input");
    field.closest(".composer-inner").style.transform = `translateY(${18 - field.getBoundingClientRect().top}px)`;
    Object.defineProperties(visualViewport, {
      height: { configurable: true, value: 62 },
      offsetTop: { configurable: true, value: 220 },
    });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await settle(page);
  assert.equal(await page.$eval(input, (node) => document.activeElement === node), true);
  const box = await geometry(page);
  assert.ok(box.height > 14, `even a tiny viewport must show list content: ${JSON.stringify(box)}`);
  assert.ok(box.top >= 0 && box.bottom <= 62, `the list stays in the remaining visible strip: ${JSON.stringify(box)}`);
  const reveal = async (selector) => {
    const row = page.locator(selector).first();
    await row.evaluate((node) => {
      const menu = node.closest(".composer-command-menu");
      menu.scrollTop += node.getBoundingClientRect().top - menu.getBoundingClientRect().top - 7;
    });
    const point = await row.evaluate((node) => {
      const menu = node.closest(".composer-command-menu").getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const top = Math.max(menu.top + 7, rect.top, 0);
      const bottom = Math.min(menu.bottom - 7, rect.bottom, 62);
      const x = rect.left + rect.width / 2;
      const y = (top + bottom) / 2;
      return { x, y, visibleHeight: bottom - top, hittable: node.contains(document.elementFromPoint(x, y)) };
    });
    assert.ok(point.visibleHeight > 0 && point.hittable, `${selector} has visible, tappable content: ${JSON.stringify(point)}`);
    return point;
  };
  await reveal(".composer-command-row");
  const expand = await reveal(".composer-command-expand");
  await page.touchscreen.tap(expand.x, expand.y);
  assert.equal(await page.locator(".composer-command-row").count(), 130);
  const last = await reveal('.composer-command-row.is-provider:last-child');
  if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}.png`) });
  await page.touchscreen.tap(last.x, last.y);
  assert.equal(await page.locator(".composer-command-pill-label").textContent(), "$batch-skill-119");
}

async function assertFocusAppearance(page, target, label) {
  await page.tap(input);
  await page.keyboard.type("/");
  await page.waitForSelector(".composer-command-expand");
  await settle(page);
  const selector = `.composer-command-${target}`;
  if (target === "expand") {
    await assertReachable(page, selector);
    await page.tap(selector);
  } else if (target === "list") {
    await page.keyboard.type("rev", { delay: 120 });
    await page.tap(".composer-command-row:not(.is-provider)");
    await page.waitForSelector(selector);
  } else if (target === "pill") {
    await page.fill(input, "/rev");
    await page.tap(".composer-command-row.is-provider");
    await page.waitForSelector(selector);
  }
  await settle(page);
  if (target === "expand") await assertReachable(page, selector);
  const appearance = () => page.$eval(selector, (node) => {
    const style = getComputedStyle(node);
    return {
      focused: document.activeElement === node,
      outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      shadow: style.boxShadow,
    };
  });
  if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}-pointer.png`) });
  assert.deepEqual(await appearance(), { focused: true, outline: false, shadow: "none" },
    `${target}: transferring focus after touch must not add an outline or shadow`);
  if (target === "list") return;

  // macOS WebKit includes buttons in sequential focus with Option-Tab.
  const tab = page.context().browser().browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  await page.keyboard.press(`Shift+${tab}`);
  await page.keyboard.press(tab);
  const keyboard = await appearance();
  assert.equal(keyboard.focused, true, `Tab navigation returns to the ${target}`);
  assert.ok(keyboard.outline || keyboard.shadow !== "none", `keyboard focus remains visible on the ${target}`);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}-keyboard.png`) });
  if (target === "expand") {
    const expanded = await page.getAttribute(selector, "aria-expanded");
    await page.keyboard.press("Enter");
    await settle(page);
    assert.notEqual(await page.getAttribute(selector, "aria-expanded"), expanded,
      "Enter activates the keyboard-focused expand control");
    const activated = await appearance();
    assert.equal(activated.focused, true);
    assert.ok(activated.outline || activated.shadow !== "none",
      "keyboard activation retains a visible focus indicator");
    await page.tap(selector);
    assert.deepEqual(await appearance(), { focused: true, outline: false, shadow: "none" },
      "returning to touch removes the keyboard focus decoration");
  }
}

try {
  const engines = process.env.E2E_BROWSER === "webkit" ? [["webkit", webkit]] : [["chromium", chromium]];
  for (const [engine, type] of engines) {
    const browser = await type.launch({ headless: true });
    try {
      for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 320 }, { width: 320, height: 568 }, { width: 1024, height: 1366 }, { width: 844, height: 390 }, { width: 667, height: 375 }]) {
        for (const scenario of ["typing", "keyboard-pick", "keyboard-expand", "menu", "backspace", "retained", "filter", "background", "soft-keyboard", "ios-viewport", "instructions", "dismissal-gesture", "threshold", "composition", "landscape", "tiny-viewport", "focus-list", "focus-expand", "focus-pill"]) {
          if (process.env.SLASH_SCENARIO && process.env.SLASH_SCENARIO !== scenario) continue;
          if (scenario !== "tiny-viewport" && (scenario === "landscape") !== (viewport.width === 844 || viewport.width === 667)) continue;
          if (scenario.startsWith("focus-") && viewport.height < 600) continue;
          if ((scenario === "soft-keyboard" || scenario === "ios-viewport") && viewport.height < 600) continue;
          if (["instructions", "dismissal-gesture", "threshold", "composition"].includes(scenario) && viewport.height < 600) continue;
          const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, serviceWorkers: "block" });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const label = `${engine}-${viewport.width}x${viewport.height}-${scenario}`;
          try {
            await addEncryptedBrokerInitScript(page, installFakeRelay, REMOTE_COMPOSER_FIXTURE);
            await openComposer(page, `http://127.0.0.1:${server.port}`);
            if (scenario !== "menu") {
              if (scenario.startsWith("focus-")) await assertFocusAppearance(page, scenario.slice(6), label);
              else if (scenario === "filter") await assertFilterCorrection(page);
              else if (scenario === "background") await assertBackgroundFocus(page, viewport);
              else if (scenario === "typing") await assertContinuousTyping(page);
              else if (scenario === "keyboard-pick") await assertKeyboardPick(page);
              else if (scenario === "keyboard-expand") await assertKeyboardExpand(page);
              else if (scenario === "instructions") await assertInstructionEditing(page, viewport);
              else if (scenario === "dismissal-gesture") await assertDismissalGesture(page, viewport, engine);
              else if (scenario === "landscape") await assertLandscapeFilter(page, viewport, label);
              else if (scenario === "tiny-viewport") await assertTinyViewport(page, viewport, label);
              else if (scenario === "threshold" || scenario === "composition") await assertKeyboardDetection(page, viewport, scenario === "composition");
              else if (scenario === "soft-keyboard" || scenario === "ios-viewport") await assertIosKeyboard(page, viewport, scenario === "soft-keyboard");
              else await assertRepeatedFilter(page, scenario === "backspace");
              assert.deepEqual(errors, []);
              console.log(`${label} OK`);
              continue;
            }
            await page.tap(input);
            await page.keyboard.type("/");
            await page.waitForSelector(".composer-command-expand");
            await settle(page);
            const opened = await geometry(page);
            assert.equal(await page.inputValue(input), "/", "opening keeps the slash draft");
            assert.equal((await readMenu(page)).surfaceDraft.value, "/", "React retains the slash too");
            assert.equal(opened.focused, "remote-message-input", "opening while typing preserves input focus");
            if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}-opened.png`) });

            // A synthetic viewport isolates positioning from native keyboard/scroll
            // behavior. It is a geometry regression, not evidence of iPhone behavior.
            if (viewport.height > 600) {
              await page.tap(input);
              await page.evaluate(() => {
                Object.defineProperties(visualViewport, {
                  height: { configurable: true, value: 330 },
                  offsetTop: { configurable: true, value: 110 },
                });
                visualViewport.dispatchEvent(new Event("resize"));
                visualViewport.dispatchEvent(new Event("scroll"));
              });
              await settle(page);
              const overlay = await geometry(page);
              console.log(`${label} ${JSON.stringify({ opened, overlay })}`);
              if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}-keyboard.png`) });
              assertFits(overlay, `${label} keyboard overlay`);
              assert.equal(overlay.focused, "remote-message-input", "explicitly focusing to filter stays possible");
              await assertReachable(page, ".composer-command-row");
              await assertReachable(page, ".composer-command-expand");
              await page.tap(".composer-command-expand");
              await settle(page);
              assertFits(await geometry(page), `${label} expanded during keyboard dismissal`);
              assert.notEqual((await geometry(page)).focused, "remote-message-input", "expanding dismisses the keyboard");
              await assertReachable(page, ".composer-command-expand");
              await page.evaluate(() => {
                delete visualViewport.height;
                delete visualViewport.offsetTop;
                visualViewport.dispatchEvent(new Event("resize"));
                visualViewport.dispatchEvent(new Event("scroll"));
              });
              await settle(page);
            }
            assertFits(opened, label);
            await assertReachable(page, ".composer-command-expand");
            await page.tap(".composer-command-expand");
            await settle(page);
            assert.notEqual((await geometry(page)).focused, "remote-message-input", "toggling keeps the keyboard closed");
            assert.equal(await page.evaluate(() => document.activeElement?.matches(".composer-command-expand")), true,
              "the expanded list keeps focus on its toggle");
            await page.tap(input);
            await page.keyboard.type("rev");
            assert.equal(await page.inputValue(input), "/rev", "the user can explicitly return to typing a filter");
            assert.equal((await geometry(page)).focused, "remote-message-input");
            await assertReachable(page, ".composer-command-row.is-provider");
            await page.tap(".composer-command-row.is-provider");
            await page.waitForSelector(".composer-command-pill");
            assert.equal(await page.locator(".composer-command-pill-label").textContent(), "$review");
            assert.equal(await page.inputValue(input), "");
            assert.equal(await page.$eval(input, (node) => document.activeElement === node), false, "picking does not reopen the keyboard");
            assert.equal(await page.evaluate(() => document.activeElement?.matches(".composer-command-pill")), true,
              "selecting a skill moves focus to the resulting pill");
            await page.tap(".composer-command-pill");
            assert.equal(await page.locator(".composer-command-pill").count(), 0);
            assert.equal(await page.$eval(input, (node) => document.activeElement === node), false, "removing a pill does not reopen the keyboard");
            await page.fill(input, "/rev");
            await settle(page);
            await page.tap(input);
            assert.equal(await page.inputValue(input), "/rev", "reopening and refocusing preserves the filter");
            assert.equal((await readMenu(page)).surfaceDraft.value, "/rev", "React retains the filter after removing a pill");
            assert.deepEqual(errors, []);
            console.log(`${label} OK`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
