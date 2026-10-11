import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import { openSessionsDrawer } from "./drawer.mjs";

test("sessions drawer retries when a render closes it during the hold", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <details class="sidebar-drawer">
      <summary class="sidebar-drawer-summary">Sessions</summary>
      <div id="threads-list"><button data-thread-id="thread-1">Session</button></div>
    </details>
  `);
  await page.evaluate(() => {
    const drawer = document.querySelector(".sidebar-drawer");
    drawer.querySelector("summary").addEventListener("click", () => {
      setTimeout(() => {
        drawer.open = false;
      }, 50);
    }, { once: true });
  });

  await openSessionsDrawer(page);

  const row = page.locator('[data-thread-id="thread-1"]');
  assert.equal(await row.isVisible(), true, "session row should be visible after reopening");
  await row.click();
});
