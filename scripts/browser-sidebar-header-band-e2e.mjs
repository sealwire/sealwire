// Regression: the sidebar Sealwire logo row and the chat-header must share one
// top band, so Sessions lines up with the session tab strip.
//
// Without this, `.sidebar` pads 20px from the top and `.sidebar-top-bar` is only
// content-tall, while `.chat-header` is measured into `--header-band-height`
// (~67px). Sessions then sits above or below the tabs instead of beside them.
//
// `innerText` is not evidence. Measure bottoms/tops with getBoundingClientRect.
//
//   npm run test:browser:sidebar-header-band
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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-sidebar-header-"));
  const statePath = path.join(stateDir, "session.json");

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  const { browser, context } = await launchBrowser({
    contextOptions: { viewport: { width: 1280, height: 800 } },
  });
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

    // Tabs only mean "this session is on screen" once the view route is set.
    await page.waitForFunction(
      () => Boolean(new URL(window.location.href).searchParams.get("thread")),
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForSelector(".sidebar-top-bar", { state: "visible", timeout: TIMEOUT_MS });
    await page.waitForSelector(".chat-shell > .chat-header", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    await page.waitForSelector(".sidebar-nav-row", { state: "visible", timeout: TIMEOUT_MS });
    await page.waitForSelector(".session-tab-strip", { state: "visible", timeout: TIMEOUT_MS });

    // Let header-band-sync publish --header-band-height from the chat-header.
    await page.waitForFunction(() => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(
        "--header-band-height"
      );
      return Boolean(raw.trim());
    });

    const metrics = await page.evaluate(() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top * 100) / 100,
          bottom: Math.round(r.bottom * 100) / 100,
          height: Math.round(r.height * 100) / 100,
        };
      };
      return {
        topBar: rect(document.querySelector(".sidebar-top-bar")),
        chatHeader: rect(document.querySelector(".chat-shell > .chat-header")),
        sessions: rect(document.querySelector(".sidebar-nav-row")),
        tabs: rect(document.querySelector(".session-tab-strip")),
        headerBandHeight: getComputedStyle(document.documentElement)
          .getPropertyValue("--header-band-height")
          .trim(),
      };
    });

    assert.ok(metrics.topBar, "expected .sidebar-top-bar");
    assert.ok(metrics.chatHeader, "expected .chat-header");
    assert.ok(metrics.sessions, "expected the Sessions nav row");
    assert.ok(metrics.tabs, "expected .session-tab-strip");

    const bandDelta = Math.abs(metrics.topBar.bottom - metrics.chatHeader.bottom);
    assert.ok(
      bandDelta <= 1,
      `logo row bottom must meet chat-header bottom (|Δ|=${bandDelta}px) — ${JSON.stringify(metrics)}`
    );

    const rowDelta = Math.abs(metrics.sessions.top - metrics.tabs.top);
    assert.ok(
      rowDelta <= 2,
      `Sessions top must meet the tab strip top (|Δ|=${rowDelta}px) — ${JSON.stringify(metrics)}`
    );

    console.log(JSON.stringify({ ok: true, metrics, bandDelta, rowDelta }, null, 2));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
