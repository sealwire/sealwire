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

async function assertBackgroundFocus(page) {
  await page.fill(input, "/batch-skill-11");
  await page.waitForSelector(".composer-command-row.is-provider");
  await settle(page);
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
      for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 320 }, { width: 320, height: 568 }, { width: 1024, height: 1366 }]) {
        for (const scenario of ["typing", "keyboard-pick", "keyboard-expand", "menu", "backspace", "retained", "filter", "background", "focus-list", "focus-expand", "focus-pill"]) {
          if (process.env.SLASH_SCENARIO && process.env.SLASH_SCENARIO !== scenario) continue;
          if (scenario.startsWith("focus-") && viewport.height < 600) continue;
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
              else if (scenario === "background") await assertBackgroundFocus(page);
              else if (scenario === "typing") await assertContinuousTyping(page);
              else if (scenario === "keyboard-pick") await assertKeyboardPick(page);
              else if (scenario === "keyboard-expand") await assertKeyboardExpand(page);
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
