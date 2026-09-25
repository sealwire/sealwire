// Regression: a running review's "···" menu (Stop review / Delete review) must be tall
// enough to hold its rows. The card's clip once capped it to the room inside the card,
// so Delete review hung below the menu's background and read as a differently styled button.
//
//   npm run test:browser:review-menu
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const DEVICE = "review-menu-e2e";

async function main() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-review-menu-")));
  const cwd = path.join(base, "project");
  await fs.mkdir(cwd);
  // The reviewer's turn never finishes, so the review stays running for the whole test.
  const scenarioPath = path.join(base, "scenario.json");
  await fs.writeFile(
    scenarioPath,
    JSON.stringify({
      matchers: [
        {
          contains: ["review"],
          scenario: { chunks: ["Reviewing…", " done"], chunk_delay_ms: 600000 },
        },
      ],
    })
  );

  const relayPort = await getFreePort();
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(base, "session.json"),
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      FAKE_PROVIDER_CONTROL_DIR: path.join(base, "control"),
      FAKE_PROVIDER_SCENARIO_PATH: scenarioPath,
    },
  });
  const url = (pathname) => `http://127.0.0.1:${relayPort}${pathname}`;
  const post = (pathname, body) =>
    fetch(url(pathname), {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).then((response) => response.json());

  let browser = null;
  let context = null;
  try {
    await waitForHealth(url("/api/health"));
    const trusted = await post("/api/workspace/trust", { cwd });
    assert.ok(trusted.ok, `workspace trust failed: ${JSON.stringify(trusted.error)}`);
    const started = await post("/api/session/start", { cwd, device_id: DEVICE, provider: "fake" });
    assert.ok(started.ok, `start_session failed: ${JSON.stringify(started.error)}`);
    // A last message to brief from, so the review skips the recap turn on the author.
    const sent = await post("/api/session/message", {
      device_id: DEVICE,
      text: "hello there",
      thread_id: started.data.active_thread_id,
    });
    assert.ok(sent.ok, `send_message failed: ${JSON.stringify(sent.error)}`);
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = await fetch(url("/api/session")).then((response) => response.json());
      if (!snapshot.data?.active_turn_id) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const review = await post("/api/session/review", {
      device_id: DEVICE,
      recap_source: "last_message",
      reviewer_provider: "fake",
    });
    assert.ok(review.ok, `request_review failed: ${JSON.stringify(review.error)}`);

    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 800 } },
    }));
    const page = await context.newPage();
    await page.goto(url("/"), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#workspace-changes-rail", { state: "visible", timeout: TIMEOUT_MS });
    await page.locator("#review-panel-rail-tabs button", { hasText: "Agents" }).click();
    const card = page.locator("#workspace-changes-rail .reviewer-review.reviewer-tone-active");
    await card.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await card.locator(".reviewer-menu-button").click();
    await page.waitForSelector(".reviewer-menu-list[data-placed='true']", { timeout: TIMEOUT_MS });

    const metrics = await page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      const menu = document.querySelector(".reviewer-menu-list");
      return {
        menu: rect(menu),
        items: [...menu.querySelectorAll(".overflow-menu-item")].map((item) => ({
          text: item.textContent,
          ...rect(item),
        })),
      };
    });
    const detail = JSON.stringify(metrics);
    assert.deepEqual(
      metrics.items.map((item) => item.text),
      ["Stop review", "Delete review"],
      `expected the running review's two actions — ${detail}`
    );
    for (const item of metrics.items) {
      assert.ok(
        item.top >= metrics.menu.top - 0.5 && item.bottom <= metrics.menu.bottom + 0.5,
        `"${item.text}" must sit inside the menu's own box, not hang below it — ${detail}`
      );
    }
    console.log(JSON.stringify({ ok: true, ...metrics }, null, 2));
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
