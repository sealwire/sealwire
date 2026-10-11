import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";
import { webkit } from "playwright";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const SHOTS = path.join(ROOT, "artifacts/e2e/review-session-layout");
const LONG_NAME = "Reviewer 460 · Agent relay security fixes: CSRF on GET, git diff flags, session ownership and remote mobile layout";
const REVIEWERS = [
  { reviewerThreadId: "rev-460", label: `${LONG_NAME} · first pass` },
  { reviewerThreadId: "rev-461", label: `${LONG_NAME} · second pass` },
  { reviewerThreadId: "rev-462", label: `审查会话 · ${"手机适配和会话安全检查".repeat(5)}` },
  { reviewerThreadId: "rev-463", label: `Reviewer-${"long_session_name_".repeat(8)}` },
].map((entry) => ({ ...entry, provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" }));

// Mount the shared launcher with the app's stylesheet: no live relay or provider is needed.
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ReviewLauncher } from ${JSON.stringify(path.join(ROOT, "frontend/shared/review-panel.js"))};
const surface = new URLSearchParams(location.search).get("surface");
createRoot(document.getElementById("root")).render(React.createElement(ReviewLauncher, {
  panelId: "review-panel-" + surface,
  defaultProvider: "codex",
  activeProvider: "codex",
  providerOptions: [{ value: "codex", label: "Codex" }],
  models: [{ provider: "codex", model: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", supported_reasoning_efforts: ["high", "xhigh"] }],
  initialReviewerThreadId: "rev-460",
  reusableReviewers: window.reusableReviewers,
  onSubmit: (payload) => { window.submitted = payload; return true; },
}));
`;

function readLayout() {
  const dialog = document.querySelector("dialog");
  const body = dialog.querySelector(".session-dialog-body");
  const trigger = dialog.querySelector("[id$='-reviewer-session']");
  const value = trigger.querySelector(".setting-pill-value");
  const label = trigger.querySelector(".setting-pill-label");
  const caret = trigger.querySelector(".setting-pill-caret");
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  };
  return {
    body: box(body),
    bodyClientWidth: body.clientWidth,
    bodyScrollWidth: body.scrollWidth,
    trigger: box(trigger),
    label: box(label),
    caret: box(caret),
    modelCaret: box(dialog.querySelector(".model-picker-caret")),
    title: trigger.title,
    valueClientWidth: value.clientWidth,
    valueScrollWidth: value.scrollWidth,
    controls: [...dialog.querySelectorAll(".setting-pill-trigger")].map(box),
  };
}

async function main() {
  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-review-session-layout-"));
  let server;
  let browser;
  try {
    await fs.mkdir(SHOTS, { recursive: true });
    await esbuild.build({
      stdin: { contents: fixture, resolveDir: ROOT },
      bundle: true,
      format: "esm",
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: path.join(buildDir, "harness.js"),
      logLevel: "silent",
    });
    for (const name of ["styles.css", "conversation.css", "review-cards.css", "delegate-cards.css", "goal-cards.css", "fork-cards.css"]) {
      await fs.copyFile(path.join(ROOT, "frontend", name), path.join(buildDir, name));
    }
    await fs.writeFile(path.join(buildDir, "index.html"), `<!doctype html><html data-theme="light"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/styles.css">
      </head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`);
    server = await startStaticServer({ rootDir: buildDir });
    ({ browser } = await launchBrowser({ browserType: process.env.E2E_BROWSER === "webkit" ? webkit : undefined }));
    for (const [surface, width, lengths] of [
      ["local", 1280], ["remote", 1280], ["remote", 320], ["remote", 390], ["remote", 430],
      ["remote", 390, [47, 48, 47, 48, 47]],
      ["local", 1280, [79, 80, 81]],
      ["local", 1280, [77, 78, 79]],
    ]) {
      const phone = width < 600;
      const reviewers = lengths
        ? lengths.map((length, index) => ({
            ...REVIEWERS[0],
            reviewerThreadId: `rev-${460 + index}`,
            label: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega".slice(0, length),
          }))
        : REVIEWERS;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        hasTouch: phone,
        isMobile: phone,
      });
      const page = await context.newPage();
      await page.addInitScript((entries) => { window.reusableReviewers = entries; }, reviewers);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const name = `${surface}-${width}` + (lengths ? `-wrap-${lengths.join("-")}` : "");
      try {
        await page.goto(`http://127.0.0.1:${server.port}/?surface=${surface}`);
        await page.locator(".review-launch-button").click();
        const trigger = page.locator(`#review-panel-${surface}-reviewer-session`);
        await trigger.waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
        const layout = await page.evaluate(readLayout);
        const detail = `${name}: ${JSON.stringify(layout)}`;
        assert.ok(layout.bodyScrollWidth <= layout.bodyClientWidth + 1, `review body overflows — ${detail}`);
        for (const control of layout.controls) {
          assert.ok(control.left >= layout.body.left && control.right <= layout.body.right, `control escapes the body — ${detail}`);
        }
        if (!lengths) {
          assert.ok(layout.valueScrollWidth > layout.valueClientWidth, `long session should ellipsize — ${detail}`);
        }
        assert.ok(layout.label.width > 35 && layout.caret.width === 10, `label and dropdown arrow stay visible — ${detail}`);
        assert.equal(layout.caret.width, layout.modelCaret.width, `${name}: dropdown arrows use the same size`);
        assert.equal(layout.title, `Reuse: ${reviewers[0].label}`);
        if (phone) {
          assert.ok(layout.trigger.width >= layout.bodyClientWidth - 42, `session uses its own row — ${detail}`);
        }

        await (phone ? trigger.tap() : trigger.click());
        const menu = page.locator(".setting-pill-menu[data-placed='true']");
        await menu.waitFor({ state: "visible" });
        await page.waitForFunction(() => getComputedStyle(document.querySelector("[id$='-reviewer-session'] .setting-pill-caret")).transform === "matrix(-1, 0, 0, -1, 0, 0)");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const attachment = await menu.evaluate((node) => {
          const trigger = document.querySelector("[id$='-reviewer-session']");
          const t = trigger.getBoundingClientRect();
          const m = node.getBoundingClientRect();
          const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
          return {
            gap: node.dataset.placement === "above" ? t.top - m.bottom : m.top - t.bottom,
            placement: node.dataset.placement,
            triggerReachable: hit === trigger || trigger.contains(hit),
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
          };
        });
        assert.ok(attachment.gap >= 5 && attachment.gap <= 7, `${name}: menu must keep a 6px gap from its trigger — ${JSON.stringify(attachment)}`);
        assert.ok(attachment.triggerReachable, `${name}: the open menu covers its trigger`);
        if (lengths) {
          assert.equal(attachment.placement, "above", `${name}: wrapping menu fits above the trigger`);
          assert.ok(attachment.scrollHeight <= attachment.clientHeight + 1, `${name}: menu should fit without scrolling`);
        }
        const menuBox = await menu.boundingBox();
        assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width, `${name}: session menu escapes the viewport`);
        assert.ok(menuBox.y >= 0 && menuBox.y + menuBox.height <= (phone ? 844 : 900), `${name}: session menu escapes vertically`);
        for (const reviewer of reviewers) {
          const option = menu.locator(`[data-value='${reviewer.reviewerThreadId}']`);
          await option.scrollIntoViewIfNeeded();
          assert.equal(await option.getAttribute("title"), `Reuse: ${reviewer.label}`);
          const text = await option.locator(".setting-pill-option-label").evaluate((node) => ({
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            height: node.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
          }));
          assert.ok(text.scrollWidth <= text.clientWidth + 1, `${name}: ${reviewer.reviewerThreadId} is still clipped horizontally`);
          if (!lengths) {
            assert.ok(text.height > text.lineHeight * 1.5, `${name}: the long option should wrap`);
          }
          assert.ok(text.height <= text.lineHeight * 2 + 1, `${name}: ${reviewer.reviewerThreadId} exceeds two visible lines`);
        }
        await menu.locator("[data-value='rev-461']").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SHOTS, `${name}-menu.png`) });
        await (phone ? menu.locator("[data-value='rev-461']").tap() : menu.locator("[data-value='rev-461']").click());
        await menu.waitFor({ state: "detached" });
        await page.locator(`#review-panel-${surface}-submit`).click();
        assert.equal(await page.evaluate(() => window.submitted.reviewerThreadId), "rev-461");
        assert.deepEqual(errors, [], `${name}: browser errors`);
        console.log(`review session layout: ${name} passed`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(buildDir, { recursive: true, force: true });
  }
}

await main();
