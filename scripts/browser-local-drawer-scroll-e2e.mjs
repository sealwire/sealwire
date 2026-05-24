// Regression test: when the user expands the threads drawer in console view
// (no conversation selected yet), the thread list must be a bounded scroll
// viewport. Previously the drawer's scroll layout only kicked in for
// `data-view="conversation"`, leaving the list unconstrained in console view
// — wheel/touch scrolling did nothing because clientHeight == scrollHeight.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-drawer-scroll-e2e-"));
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-drawer-scroll-codex-", {
    requireAuth: false,
  });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    codexHomeDir,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 720 } },
    }));
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar-drawer") &&
        document.querySelector(".app-shell")?.dataset.view === "console" &&
        document.querySelector(".chat-shell")?.dataset.view === "console",
      null,
      { timeout: TIMEOUT_MS },
    );
    await page.waitForFunction(
      () => {
        const count = document.querySelector("#threads-count")?.textContent || "";
        return document.querySelector("#threads-list") && !/loading/i.test(count);
      },
      null,
      { timeout: TIMEOUT_MS },
    );

    const initialView = await page.evaluate(() => document.querySelector(".app-shell")?.dataset.view);
    assert.equal(initialView, "console", "should land in console view with no thread selected");

    await page.click(".sidebar-drawer-summary");
    await page.waitForFunction(() => document.querySelector(".sidebar-drawer")?.open === true, null, {
      timeout: TIMEOUT_MS,
    });

    // Drawer should NOT have flipped the app into conversation view just by opening.
    const viewAfterOpen = await page.evaluate(() => document.querySelector(".app-shell")?.dataset.view);
    assert.equal(viewAfterOpen, "console", "opening the drawer must not change app-shell view");

    // Fill after the initial session/thread render settles. Otherwise a slow CI
    // render can replace these probe rows before the layout assertion runs.
    await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      list.innerHTML = "";
      for (let i = 0; i < 80; i += 1) {
        const row = document.createElement("div");
        row.textContent = `Fake thread row ${i}`;
        row.style.padding = "12px";
        row.style.borderBottom = "1px solid #444";
        list.appendChild(row);
      }
    });

    const layout = await page.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      const body = document.querySelector(".sidebar-drawer-body");
      const list = document.querySelector("#threads-list");
      return {
        drawer: { clientH: drawer.clientHeight, scrollH: drawer.scrollHeight },
        body: { clientH: body.clientHeight, scrollH: body.scrollHeight },
        list: { clientH: list.clientHeight, scrollH: list.scrollHeight },
      };
    });

    // The thread list must be a bounded scroll viewport: lots of content,
    // but a small visible window.
    assert.ok(
      layout.list.scrollH > layout.list.clientH + 1000,
      `expected list scrollHeight (${layout.list.scrollH}) ≫ clientHeight (${layout.list.clientH})`,
    );
    assert.ok(
      layout.list.clientH > 0 && layout.list.clientH < 1000,
      `expected list clientHeight to be a reasonable viewport (got ${layout.list.clientH})`,
    );

    // Programmatic scrollTop assignment must stick (it only does if scrollH > clientH).
    await page.evaluate(() => {
      document.querySelector("#threads-list").scrollTop = 250;
    });
    const scrollAfterAssign = await page.evaluate(() => document.querySelector("#threads-list").scrollTop);
    assert.equal(scrollAfterAssign, 250, "programmatic scrollTop must apply when list is a bounded viewport");

    // Wheel over the drawer summary (the dropdown header above the list) must
    // forward into the list via the wheel proxy in console view too.
    await page.evaluate(() => {
      document.querySelector("#threads-list").scrollTop = 0;
      const summary = document.querySelector(".sidebar-drawer-summary");
      summary.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }),
      );
    });
    const scrollAfterWheel = await page.evaluate(() => document.querySelector("#threads-list").scrollTop);
    assert.ok(
      scrollAfterWheel > 0,
      `wheel-on-summary must scroll the list in console view (scrollTop=${scrollAfterWheel})`,
    );

    console.log("drawer scroll e2e: PASS", JSON.stringify(layout));
  } catch (err) {
    if (page) {
      await writeFailureArtifacts({
        scenario: "browser-local-drawer-scroll",
        relay,
        relayPort,
        localPage: page,
      }).catch(() => {});
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
  }
}

main().catch((err) => {
  console.error("drawer scroll e2e failed:", err);
  process.exit(1);
});
