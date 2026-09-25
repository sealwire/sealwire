// Regression: Changes/Agents belongs on the session tab line like the sidebar's Sessions
// row, leaving the rail's title row to the hide toggle, which must not scroll away.
//
//   npm run test:browser:rail-toggle-align
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

function toTildePath(absolutePath) {
  const home = os.homedir();
  if (absolutePath === home) return "~";
  if (absolutePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absolutePath)}`;
  }
  return absolutePath;
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-rail-toggle-"));
  const statePath = path.join(stateDir, "session.json");

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  const { browser, context } = await launchBrowser();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog");
    await startLocalSession(page, {
      cwd: toTildePath(ROOT),
      provider: "fake",
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      null,
      { timeout: TIMEOUT_MS }
    );

    await page.waitForSelector("#workspace-changes-rail", { state: "visible" });
    await page.waitForSelector("#rail-top-toggle", { state: "visible" });
    await page.waitForSelector(".session-tab", { state: "visible", timeout: TIMEOUT_MS });
    await page.waitForFunction(() =>
      Boolean(
        getComputedStyle(document.documentElement).getPropertyValue("--header-band-height").trim()
      )
    );

    const measure = () =>
      page.evaluate(() => {
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            width: r.width,
            cy: r.top + r.height / 2,
          };
        };
        return {
          toggle: rect("#rail-top-toggle"),
          seg: rect("#review-panel-rail-tabs"),
          tab: rect(".session-tab"),
          chatHeader: rect(".chat-shell > .chat-header"),
          rail: rect("#workspace-changes-rail"),
        };
      });

    const assertLayout = (metrics, at) => {
      const detail = JSON.stringify(metrics);
      assert.ok(metrics.toggle, `[${at}] expected #rail-top-toggle to be present`);
      assert.ok(metrics.seg, `[${at}] expected the Changes/Agents segmented control`);
      assert.ok(metrics.tab, `[${at}] expected a session tab`);
      assert.ok(metrics.chatHeader, `[${at}] expected the chat-header`);

      const tabLine = Math.abs(metrics.seg.cy - metrics.tab.cy);
      assert.ok(
        tabLine <= 1.5,
        `[${at}] Changes/Agents must sit on the session tab line (|Δcenter| = ` +
          `${tabLine.toFixed(1)}px) — ${detail}`
      );
      const titleRow = Math.abs(metrics.toggle.cy - metrics.chatHeader.cy);
      assert.ok(
        titleRow <= 1.5,
        `[${at}] the rail toggle must stay on the chat-header's title row (|Δcenter| = ` +
          `${titleRow.toFixed(1)}px) — ${detail}`
      );
      assert.ok(
        metrics.toggle.bottom <= metrics.seg.top,
        `[${at}] the toggle must not overlap the Changes/Agents switch — ${detail}`
      );
    };

    // 1) Default rail width. Let any launch-time width transition settle first.
    await page.waitForFunction(() => {
      const rail = document.querySelector("#workspace-changes-rail");
      return rail && Math.abs(rail.getBoundingClientRect().width - 320) <= 2;
    });
    const defaultMetrics = await measure();
    assertLayout(defaultMetrics, "default-width");

    // 2) Minimum rail width (createPanelControl clamps --right-rail-width to 260px). The
    //    grid column animates over 220ms, so wait for the rail to actually get there.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--right-rail-width", "260px");
    });
    await page.waitForFunction(() => {
      const rail = document.querySelector("#workspace-changes-rail");
      return rail && Math.abs(rail.getBoundingClientRect().width - 260) <= 2;
    });
    const narrowMetrics = await measure();
    assertLayout(narrowMetrics, "min-width-260");

    // 3) Scrolled, by a real wheel. CSSOM because the CSP refuses inline <style>; two
    //    frames because the compositor routes the wheel by the last committed scroll tree.
    await page.evaluate(async () => {
      document.querySelector("#workspace-changes-rail .right-panel-tabs").style.minHeight =
        "3000px";
      for (let i = 0; i < 2; i += 1) await new Promise((r) => requestAnimationFrame(r));
    });
    await page.mouse.move(narrowMetrics.rail.left + narrowMetrics.rail.width / 2, 400);
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => {
      const rail = document.querySelector("#workspace-changes-rail");
      return [rail, ...rail.querySelectorAll("*")].some((el) => el.scrollTop > 0);
    });
    await page.waitForTimeout(150);
    const scrolledMetrics = await measure();
    assertLayout(scrolledMetrics, "scrolled");
    const toggleDrift = Math.abs(scrolledMetrics.toggle.top - narrowMetrics.toggle.top);
    assert.ok(
      toggleDrift <= 0.5,
      `[scrolled] the rail toggle must not scroll away (moved ${toggleDrift.toFixed(1)}px)`
    );

    console.log(
      JSON.stringify(
        { ok: true, default: defaultMetrics, narrow: narrowMetrics, scrolled: scrolledMetrics },
        null,
        2
      )
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
