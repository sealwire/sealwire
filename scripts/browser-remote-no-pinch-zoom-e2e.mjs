// A pinch on the remote page in a phone browser must not zoom it, matching the iOS app.
// Chromium honours the viewport meta only with `isMobile`, so this runs as a phone.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const WEB_ROOT = path.join(process.cwd(), "web");

async function main() {
  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: { "/manifest.webmanifest": "remote-manifest.webmanifest" },
    stripStaticPrefix: true,
  });
  const { browser, context } = await launchBrowser({
    contextOptions: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
    },
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.synthesizePinchGesture", {
      x: 195,
      y: 422,
      scaleFactor: 3,
      gestureSourceType: "touch",
    });
    await page.waitForTimeout(500);
    const scale = await page.evaluate(() => window.visualViewport.scale);
    assert.equal(scale, 1, `pinching zoomed the remote page to ${scale}x`);
    console.log("[remote-no-pinch-zoom-e2e] ok: pinch left the page at 1x");
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
