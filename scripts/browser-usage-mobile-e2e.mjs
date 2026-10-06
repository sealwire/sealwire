// The Usage screen on a phone and on a desktop, driven only through controls a
// person can see and tap, with the production stylesheet untouched.
//
// The bug this pins: at <=960px the shell's single-column rule lost to the
// desktop `.app-shell[data-view="usage"]` columns, so a 390px phone gave Usage
// 90px beside an empty sidebar track, with no way back to Sessions.
//
// Needs the private build (`cargo build -p relay-server --features private`)
// and E2E_USE_BUILT_BINARIES=1: SEALWIRE_BETA only unlocks Usage when the binary
// was built with the feature. E2E_RELAY_BIN runs a binary built elsewhere.
//
// The fake provider reports no tokens, so `/api/usage` is passed through and its
// answer given spend and per-session rows that point at real threads.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createArtifactWriter, writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const DESKTOP = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 };
const PROMPTS = ["Per-session usage under the Usage chart", "Review relay reconnect backoff"];

async function main() {
  const relayPort = await getFreePort();
  const base = `http://127.0.0.1:${relayPort}`;
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-usage-mobile-e2e-"));
  const workspace = path.join(stateDir, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const artifacts = createArtifactWriter("usage-mobile-e2e");
  await fs.mkdir(artifacts.dir, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStateDb: path.join(stateDir, "sealwire.db"),
    extraEnv: { AGENT_PROVIDERS: "fake", SEALWIRE_BETA: "1" },
    ...(process.env.E2E_RELAY_BIN
      ? { resolveCommand: () => ({ command: process.env.E2E_RELAY_BIN, args: [] }) }
      : {}),
  });

  let browser = null;
  let page = null;
  try {
    await waitForHealth(`${base}/api/health`);
    const snapshot = await api(base, "/api/session");
    assert.equal(
      snapshot?.data?.beta_features_enabled,
      true,
      "Usage is beta-gated; this suite needs a --features private relay with SEALWIRE_BETA=1"
    );
    const threadIds = [];
    for (const prompt of PROMPTS) {
      const started = await api(base, "/api/session/start", {
        cwd: workspace,
        device_id: "usage-mobile-e2e",
        initial_prompt: prompt,
        approval_policy: "never",
        sandbox: "workspace-write",
        effort: "medium",
      });
      assert.ok(started?.data?.active_thread_id, `start failed: ${JSON.stringify(started)}`);
      threadIds.push(started.data.active_thread_id);
    }

    const launched = await launchBrowser({ contextOptions: PHONE });
    browser = launched.browser;
    const phone = launched.context;

    // An empty ledger first: the screen that has nothing to show still has a way out.
    page = await phone.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await tapNav(page, "Usage");
    await page.waitForSelector(".usage-empty", { timeout: TIMEOUT_MS });
    await assertPhoneShell(page, "empty");
    await page.screenshot({ path: path.join(artifacts.dir, "phone-empty.png") });
    await page.close();

    page = await phone.newPage();
    await seedUsage(page, threadIds);
    const writes = recordWrites(page, base);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await tapNav(page, "Usage");
    await page.waitForSelector(".usage-sessions h3", { timeout: TIMEOUT_MS });
    await assertPhoneShell(page, "report");
    await page.screenshot({ path: path.join(artifacts.dir, "phone-usage-top.png") });

    const rows = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll(".usage-session-row")].map((row) => {
        const r = row.getBoundingClientRect();
        const tokens = row.querySelector(".usage-session-tokens").getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height, tokensRight: tokens.right, vw };
      });
    });
    assert.equal(rows.length, 5, "five sessions before the list is expanded");
    for (const row of rows) {
      assert.ok(row.left >= 0 && row.right <= row.vw, `a session row runs off the phone: ${JSON.stringify(row)}`);
      assert.ok(row.tokensRight <= row.vw, `a token count is cut off: ${JSON.stringify(row)}`);
      assert.ok(row.height >= 44, `a session row is too short to tap: ${row.height}px`);
    }
    // The bar the list below describes is on screen, and the chart is not cut off.
    await page.locator(".usage-center .usage-chart").scrollIntoViewIfNeeded();
    const chart = await page.evaluate(() => {
      const box = document.querySelector(".usage-center .usage-chart");
      const frame = box.getBoundingClientRect();
      const today = box.querySelector(".usage-chart-col.is-today").getBoundingClientRect();
      const label = box.querySelector(".usage-chart-labels .is-today").getBoundingClientRect();
      const labelMid = (label.left + label.right) / 2;
      return {
        clippedBy: box.scrollHeight - box.clientHeight,
        barsFit: (() => {
          const bars = box.querySelector(".usage-chart-bars").getBoundingClientRect();
          return bars.left >= frame.left - 1 && bars.right <= frame.right + 1;
        })(),
        todayInView: today.left >= frame.left - 1 && today.right <= frame.right + 1,
        todayLabelUnderItsBar: labelMid >= today.left - 1 && labelMid <= today.right + 1,
        legendShown: box.querySelector(".usage-chart-legend").getBoundingClientRect().bottom <= frame.bottom + 1,
      };
    });
    assert.deepEqual(
      chart,
      { clippedBy: 0, barsFit: true, todayInView: true, todayLabelUnderItsBar: true, legendShown: true },
      "phone chart shows today, under its own label, without scrolling"
    );
    await page.locator(".usage-center").screenshot({ path: path.join(artifacts.dir, "phone-chart-and-sessions.png") });
    await page.locator(".usage-sessions").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts.dir, "phone-usage-sessions.png") });
    await page.locator(".usage-sessions-more").tap();
    assert.equal(await page.locator(".usage-session-row").count(), 7);
    await page.locator(".usage-sessions").screenshot({ path: path.join(artifacts.dir, "phone-sessions-expanded.png") });

    // Back to Sessions with the visible control, then in again the same way.
    await page.locator(".usage-toolbar").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Back to sessions" }).tap();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.view !== "usage", null, {
      timeout: TIMEOUT_MS,
    });
    assert.ok(await page.locator(".sidebar-nav-row", { hasText: "Usage" }).isVisible(), "Sessions shows the nav again");
    await page.screenshot({ path: path.join(artifacts.dir, "phone-back-to-sessions.png") });

    await tapNav(page, "Usage");
    await page.waitForSelector(".usage-sessions h3", { timeout: TIMEOUT_MS });
    const before = writes.length;
    await page.locator(".usage-session-row", { hasText: PROMPTS[1] }).tap();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.view === "conversation", null, {
      timeout: TIMEOUT_MS,
    });
    assert.ok(page.url().includes(threadIds[1]), `the row opened ${page.url()}, not ${threadIds[1]}`);
    await page.waitForFunction((text) => document.body.textContent.includes(text), PROMPTS[1], { timeout: TIMEOUT_MS });
    await page.waitForTimeout(500);
    assert.deepEqual(writes.slice(before), [], "opening a session from Usage must not write anything");
    await page.screenshot({ path: path.join(artifacts.dir, "phone-opened-session.png") });
    await page.close();

    // Desktop keeps its three-column report and no phone-only back button.
    const desktop = await browser.newContext(DESKTOP);
    page = await desktop.newPage();
    await seedUsage(page, threadIds);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.locator(".sidebar-nav-row", { hasText: "Usage" }).click();
    await page.waitForSelector(".usage-sessions h3", { timeout: TIMEOUT_MS });
    const layout = await page.evaluate(() => ({
      sidebar: document.querySelector(".app-shell > .sidebar").getBoundingClientRect().width,
      columns: getComputedStyle(document.querySelector(".usage-grid")).gridTemplateColumns.split(" ").length,
      back: getComputedStyle(document.querySelector(".usage-back")).display,
    }));
    assert.ok(layout.sidebar > 200, `desktop keeps its sidebar: ${JSON.stringify(layout)}`);
    assert.equal(layout.columns, 3, `desktop keeps rails around the chart: ${JSON.stringify(layout)}`);
    assert.equal(layout.back, "none", "the back button is phone-only");
    await page.screenshot({ path: path.join(artifacts.dir, "desktop-usage.png"), fullPage: true });
    await page.locator('.usage-tabs button', { hasText: "Week" }).click();
    await page.waitForFunction(() => document.querySelector(".usage-sessions h3")?.textContent === "This week's sessions", null, {
      timeout: TIMEOUT_MS,
    });
    const week = await page.evaluate(() => ({
      hint: document.querySelector(".usage-week .usage-chart-day-hint") !== null,
      options: document.querySelectorAll('.usage-week [role="option"]').length,
      cursor: getComputedStyle(document.querySelector(".usage-week .usage-chart-col")).cursor,
    }));
    assert.deepEqual(week, { hint: false, options: 0, cursor: "auto" }, "week bars do not invite a click");
    await page.locator(".usage-week").screenshot({ path: path.join(artifacts.dir, "desktop-week.png") });
    await desktop.close();

    console.log(`usage mobile e2e passed; screenshots in ${artifacts.dir}`);
  } catch (error) {
    await writeFailureArtifacts({ scenario: "usage-mobile-e2e", relay, relayPort, localPage: page }).catch(() => {});
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
  }
}

async function api(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

// A nav row the person can actually see: Playwright refuses to tap a hidden one.
async function tapNav(page, label) {
  const row = page.locator(".sidebar-nav-row", { hasText: label });
  await row.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await row.tap();
}

async function assertPhoneShell(page, label) {
  const shell = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const mount = document.querySelector("#usage-report").getBoundingClientRect();
    const sidebar = document.querySelector(".app-shell > .sidebar").getBoundingClientRect();
    return { vw, mountLeft: mount.left, mountWidth: mount.width, sidebarWidth: sidebar.width, overflow: document.documentElement.scrollWidth - vw };
  });
  assert.ok(
    shell.mountLeft === 0 && Math.abs(shell.mountWidth - shell.vw) <= 1,
    `${label}: Usage must fill the phone, got ${JSON.stringify(shell)}`
  );
  assert.equal(shell.sidebarWidth, 0, `${label}: the sidebar must not sit beside Usage on a phone`);
  assert.ok(shell.overflow <= 0, `${label}: the page scrolls sideways by ${shell.overflow}px`);
  const back = page.getByRole("button", { name: "Back to sessions" });
  assert.ok(await back.isVisible(), `${label}: there is no visible way back to Sessions`);
}

function recordWrites(page, base) {
  const writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().startsWith(base)) {
      writes.push(`${request.method()} ${request.url().slice(base.length)}`);
    }
  });
  return writes;
}

async function seedUsage(page, threadIds) {
  await page.route("**/api/usage?**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, data: withSpend(payload.data, threadIds) } });
  });
}

function withSpend(report, threadIds) {
  const today = [
    { thread_id: threadIds[0], provider: "claude_code", title: PROMPTS[0], total: 612_000 },
    { thread_id: threadIds[1], provider: "codex", title: PROMPTS[1], total: 468_000 },
    {
      thread_id: "e2e-long",
      provider: "claude_code",
      title: "Investigate why the Android web header overflows when the relay name is extremely long and the bell badge shows 99+",
      total: 391_000,
    },
    { thread_id: "019a3f5e-7c21-7d40-b6a2-5f1e0c9d2a88", provider: "codex", total: 252_000 },
    { thread_id: "e2e-notes", provider: "claude_code", title: "Draft release notes for 0.9", total: 241_000 },
    { thread_id: "e2e-broker", provider: "claude_code", title: "Explain the broker rotation grace window", total: 194_000 },
    { thread_id: "e2e-rename", provider: "codex", title: "Flaky e2e: workspace rename", total: 58_000 },
  ];
  const groups = ["claude_code", "codex"].map((provider) => {
    const total = today.filter((s) => s.provider === provider).reduce((sum, s) => sum + s.total, 0);
    return { provider, model: provider === "codex" ? "gpt-5" : "claude-opus-4", total, input: total, cached_input: 0, output: 0, turns: 4 };
  });
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  const lastKey = report.buckets.at(-1).key;
  return {
    ...report,
    providers: [
      { key: "claude_code", label: "Claude", reports_usage: true },
      { key: "codex", label: "Codex", reports_usage: true },
      { key: "cursor", label: "Cursor", reports_usage: false },
    ],
    totals: { ...report.totals, total },
    buckets: report.buckets.map((b) => (b.key === lastKey ? { ...b, groups } : b)),
    sessions: [{ key: lastKey, sessions: today }],
    ...(report.today
      ? { today: { ...report.today, totals: { ...report.today.totals, total }, groups } }
      : {}),
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
