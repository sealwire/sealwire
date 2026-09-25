// Regression: Changes/Agents shares the rail's title row with the hide toggle, and the
// branch picker under it sits on the session tab line, previewing another tree or not.
//
//   npm run test:browser:rail-toggle-align
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const execFileAsync = promisify(execFile);

// A linked worktree gives the picker a second tree to preview.
async function initRepoWithWorktree(base) {
  const main = path.join(base, "mainwt");
  const linked = path.join(base, "linkedwt");
  const git = (cwd, args) => execFileAsync("git", args, { cwd });
  await fs.mkdir(main, { recursive: true });
  await git(main, ["init", "-q", "-b", "main"]);
  await git(main, ["config", "user.email", "e2e@example.com"]);
  await git(main, ["config", "user.name", "E2E"]);
  await fs.writeFile(path.join(main, "seed.txt"), "line1\n", "utf8");
  await git(main, ["add", "seed.txt"]);
  await git(main, ["commit", "-q", "-m", "seed"]);
  await git(main, ["worktree", "add", "-q", "-b", "feature", linked]);
  return { mainCwd: main, linkedCwd: linked };
}

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
  // realpath: macOS tmp is a symlink, and the picker lists trees by their real path.
  const stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-rail-toggle-"))
  );
  const statePath = path.join(stateDir, "session.json");
  const { mainCwd } = await initRepoWithWorktree(stateDir);

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  // Untrusted, the relay runs no git there, so the picker would have no worktrees to offer.
  const trusted = await fetch(`http://127.0.0.1:${relayPort}/api/workspace/trust`, {
    body: JSON.stringify({ cwd: mainCwd }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.ok(trusted.ok, `workspace trust failed: ${JSON.stringify(trusted.error)}`);

  const { browser, context } = await launchBrowser();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog");
    await startLocalSession(page, {
      cwd: toTildePath(mainCwd),
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
    await page.waitForSelector("#workspace-changes-rail .workspace-picker-trigger", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
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
          tree: rect("#workspace-changes-rail .workspace-picker-trigger"),
          tab: rect(".session-tab"),
          chatHeader: rect(".chat-shell > .chat-header"),
          rail: rect("#workspace-changes-rail"),
        };
      });

    const assertLayout = (metrics, at) => {
      const detail = JSON.stringify(metrics);
      for (const key of ["toggle", "seg", "tree", "tab", "chatHeader"]) {
        assert.ok(metrics[key], `[${at}] expected ${key} to be present — ${detail}`);
      }
      const titleRow = Math.abs(metrics.seg.cy - metrics.chatHeader.cy);
      assert.ok(
        titleRow <= 1.5,
        `[${at}] Changes/Agents must sit on the chat-header's title row (|Δcenter| = ` +
          `${titleRow.toFixed(1)}px) — ${detail}`
      );
      const toggleRow = Math.abs(metrics.toggle.cy - metrics.seg.cy);
      assert.ok(
        toggleRow <= 1.5,
        `[${at}] the rail toggle must share the Changes/Agents row (|Δcenter| = ` +
          `${toggleRow.toFixed(1)}px) — ${detail}`
      );
      assert.ok(
        metrics.toggle.left >= metrics.seg.right,
        `[${at}] the toggle must not overlap the Changes/Agents switch — ${detail}`
      );
      const tabLine = Math.abs(metrics.tree.cy - metrics.tab.cy);
      assert.ok(
        tabLine <= 1.5,
        `[${at}] the branch picker must sit on the session tab line (|Δcenter| = ` +
          `${tabLine.toFixed(1)}px) — ${detail}`
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

    // 3) Previewing another tree: the "Viewing" label must not push the picker off the line.
    await page.click("#workspace-changes-rail .workspace-picker-trigger");
    await page
      .locator("#workspace-changes-rail .workspace-picker-row", { hasText: "linkedwt" })
      .click({ timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () =>
        document.querySelector("#workspace-changes-rail .thread-workspace-label")?.textContent ===
        "Viewing",
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForTimeout(150);
    const previewMetrics = await measure();
    assertLayout(previewMetrics, "previewing");

    // 4) Scrolled, by a real wheel. CSSOM because the CSP refuses inline <style>; two
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
    for (const key of ["toggle", "seg"]) {
      const drift = Math.abs(scrolledMetrics[key].top - narrowMetrics[key].top);
      assert.ok(
        drift <= 0.5,
        `[scrolled] the rail's ${key} must not scroll away (moved ${drift.toFixed(1)}px)`
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          default: defaultMetrics,
          narrow: narrowMetrics,
          previewing: previewMetrics,
          scrolled: scrolledMetrics,
        },
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
