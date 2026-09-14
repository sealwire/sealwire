// A goal stopped for the user puts its QUESTION in the card. Clamped to two lines,
// the options it is asking about are off-screen and the run cannot be answered.
//
// Measured, not asserted on text: the DOM holds the whole string either way, so
// innerText proves nothing — only scrollHeight against clientHeight does.
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const WEB_ROOT = path.join(process.cwd(), "web");
const LONG_QUESTION = Array.from({ length: 14 }, (_, i) => `选项 ${i}：这是一句足够长的说明文字，用来撑出多行。`).join("");

async function measure(page, className) {
  return page.evaluate((cls) => {
    document.querySelectorAll(".probe-card").forEach((n) => n.remove());
    const card = document.createElement("article");
    card.className = "reviewer-card reviewer-goal probe-card";
    card.style.width = "320px";
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = window.__probeText;
    card.append(p);
    document.body.append(card);
    return { scrollHeight: p.scrollHeight, clientHeight: p.clientHeight };
  }, className);
}

async function main() {
  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: { "/manifest.webmanifest": "remote-manifest.webmanifest", "/static/remote-sw.js": "remote-sw.js" },
    stripStaticPrefix: true,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const { browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 390, height: 844 } } });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate((text) => { window.__probeText = text; }, LONG_QUESTION);

    const clamped = await measure(page, "reviewer-card-result");
    assert.ok(
      clamped.scrollHeight > clamped.clientHeight + 4,
      `the fixture must actually overflow, or this test proves nothing — ${JSON.stringify(clamped)}`
    );

    const question = await measure(page, "reviewer-card-result is-question");
    assert.ok(
      question.scrollHeight <= question.clientHeight + 4,
      `a question the run is stopped on must be readable in full, not clipped to a preview — ${JSON.stringify(question)}`
    );

    console.log(`goal-question-readable-e2e OK ${JSON.stringify({ clamped, question })}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
