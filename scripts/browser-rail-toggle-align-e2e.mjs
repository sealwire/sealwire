// Regression: the right-rail's "hide panel" toggle (#rail-top-toggle) must line up
// with the Changes/Reviewer segmented tabs in the header band — same vertical
// center, and sitting in its own space to the right of the pill rather than
// overlapping it. The toggle was pinned to a fixed `top: 12px` calibrated for an
// older, shorter header; once the tabbed header band grew to --header-band-height
// the toggle rode up ~9px above the pill's center and overlapped its right end.
//
//   npm run test:browser:rail-toggle-align
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
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
    await page.click("#open-start-session-dialog");
    await page.waitForFunction(() => document.querySelector("#launch-start-session-dialog")?.open);
    await page.fill("#cwd-input", toTildePath(ROOT));
    await page.selectOption("#provider-input", "fake");
    await page.selectOption("#approval-policy-input", "never");
    await page.click("#start-session-button");
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      null,
      { timeout: TIMEOUT_MS }
    );

    await page.waitForSelector("#workspace-changes-rail", { state: "visible" });
    await page.waitForSelector("#rail-top-toggle", { state: "visible" });

    // Switch the rail's right panel to the Reviewer tab (where the screenshot was taken);
    // the header band + toggle are identical on the Changes tab, but this mirrors the report.
    await page.locator("#review-panel-rail-tabs button", { hasText: "Reviewer" }).click();
    await page.waitForTimeout(150);

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
          rail: rect("#workspace-changes-rail"),
        };
      });

    const assertAligned = (metrics, at) => {
      assert.ok(metrics.toggle, `[${at}] expected #rail-top-toggle to be present`);
      assert.ok(metrics.seg, `[${at}] expected the Changes/Reviewer segmented control`);

      const verticalDiff = Math.abs(metrics.toggle.cy - metrics.seg.cy);
      assert.ok(
        verticalDiff <= 1.5,
        `[${at}] toggle should be vertically centered with the tabs (|Δcenter| = ` +
          `${verticalDiff.toFixed(1)}px, toggle.cy=${metrics.toggle.cy}, seg.cy=${metrics.seg.cy})`
      );
      // The toggle must sit in its own space to the RIGHT of the pill, not overlap it.
      assert.ok(
        metrics.toggle.left >= metrics.seg.right,
        `[${at}] toggle should not overlap the segmented tabs (toggle.left=` +
          `${metrics.toggle.left}, seg.right=${metrics.seg.right})`
      );
      return verticalDiff;
    };

    // 1) Default rail width. Let any launch-time width transition settle first.
    await page.waitForFunction(() => {
      const rail = document.querySelector("#workspace-changes-rail");
      return rail && Math.abs(rail.getBoundingClientRect().width - 320) <= 2;
    });
    const defaultMetrics = await measure();
    const defaultDiff = assertAligned(defaultMetrics, "default-width");

    // 2) Minimum rail width (createPanelControl clamps --right-rail-width to 260px).
    //    Alignment/overlap must hold when the pill is squeezed narrow too. The grid
    //    column animates over 220ms, so WAIT for the rail to actually reach 260px —
    //    measuring mid-transition would silently assert a wider width.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--right-rail-width", "260px");
    });
    await page.waitForFunction(() => {
      const rail = document.querySelector("#workspace-changes-rail");
      return rail && Math.abs(rail.getBoundingClientRect().width - 260) <= 2;
    });
    const narrowMetrics = await measure();
    assert.ok(
      Math.abs(narrowMetrics.rail.width - 260) <= 2,
      `[min-width-260] rail should have settled at 260px (got ${narrowMetrics.rail.width})`
    );
    const narrowDiff = assertAligned(narrowMetrics, "min-width-260");

    console.log(
      JSON.stringify(
        { ok: true, default: { metrics: defaultMetrics, verticalDiff: defaultDiff },
          narrow: { metrics: narrowMetrics, verticalDiff: narrowDiff } },
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
