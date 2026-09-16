// Two regions, one current word.
//
// The composer has a neutral "NOT SENT" region for what it stopped itself, and a red
// error line for what actually failed. Only one of them can describe the draft in the box
// right now. A command that refuses LOCALLY never reaches an action, so its refusal used
// to appear UNDERNEATH a red line from an earlier attempt that was no longer true — two
// diagnoses at once, the older one wrong.
//
// Unit tests execute that rule, but both host wirings are pinned only structurally, and
// the controller that triggers it is the swapped-in private one. This is the only place
// the whole chain runs: real controller -> real host wiring -> what is on screen.
//
// Measured, not read: innerText is true whether or not anything was laid out, so the
// assertions here are boxes with real height plus screenshots to look at.
//
// Drives the private "/" menu, so a public checkout skips.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
const SHOTS = path.join(ROOT, ".tmp-held-supersedes-e2e");

if (existsSync(path.join(ROOT, "crates", "sealwire-private", "STUB"))) {
  console.log(
    "held-supersedes-e2e: SKIPPED — this checkout has the stub private crate, so the \"/\" menu does not exist.\n" +
      "  Run scripts/with-private.sh node scripts/browser-composer-held-supersedes-e2e.mjs instead."
  );
  process.exit(0);
}
const step = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function boxOf(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      hidden: node.hasAttribute("hidden"),
      display: style.display,
      height: rect.height,
      text: (node.textContent || "").trim(),
    };
  }, selector);
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "held-supersedes-verify-"));
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  step(`relay booting on ${relayPort}`);
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  step("relay healthy");

  let browser;
  let context;
  let relayStopped = false;
  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1440, height: 900 } },
    }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: 20000 });
    await startLocalSession(page, {
      cwd: ROOT,
      provider: "fake",
      approvalPolicy: "bypass",
      timeoutMs: 45000,
    });
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      { timeout: 45000 }
    );
    step("session ready");

    // ---- (1) a REAL red line, through the real failure path ----------------
    // Fail one send at the transport, which is what the red line is for. Routed rather
    // than faked in the page so the message travels the same code a genuine failure does.
    await page.route("**/api/session/message", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { message: "relay exploded on purpose" } }),
      })
    );
    await page.click("#message-input");
    await page.fill("#message-input", "this send is going to fail");
    await page.click("#send-button");
    await page.waitForFunction(
      () => {
        const node = document.querySelector("#composer-error");
        return node && !node.hasAttribute("hidden") && (node.textContent || "").trim().length > 0;
      },
      { timeout: 15000 }
    );
    await page.unroute("**/api/session/message");

    const staleRed = await boxOf(page, "#composer-error");
    await page.screenshot({ path: path.join(SHOTS, "1-stale-red.png") });
    assert.ok(staleRed, "#composer-error must exist");
    assert.equal(staleRed.hidden, false, "the failure has to be on screen to be superseded");
    assert.ok(staleRed.height > 5, `the red line must occupy real space, got ${JSON.stringify(staleRed)}`);
    step(`stale red line up: ${JSON.stringify(staleRed.text.slice(0, 60))}`);

    // ---- (2) a LOCAL refusal must replace it, not stack under it -----------
    await page.fill("#message-input", "");
    await page.click("#message-input");
    await page.type("#message-input", "/delegate");
    await page.waitForSelector(".composer-command-row", { timeout: 10000 });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".composer-command-pill", { timeout: 10000 });
    step("delegate pill up, submitting with nothing to say");

    // Empty instructions: the composer refuses this itself and sends nothing.
    await page.fill("#message-input", "");
    await page.click("#send-button");
    await page.waitForFunction(
      () => {
        const node = document.querySelector("#composer-held");
        return node && !node.hasAttribute("hidden") && (node.textContent || "").trim().length > 0;
      },
      { timeout: 10000 }
    );

    const held = await boxOf(page, "#composer-held");
    const redAfter = await boxOf(page, "#composer-error");
    await page.screenshot({ path: path.join(SHOTS, "2-held-supersedes.png") });

    assert.equal(held.hidden, false, "the refusal must be on screen");
    assert.ok(held.height > 5, `NOT SENT must occupy real space, got ${JSON.stringify(held)}`);
    assert.match(held.text, /cannot guess|what you want done/i, "it says what is missing");

    // The whole point: ONE current word, not two.
    assert.equal(
      redAfter?.height ?? 0,
      0,
      `the superseded red line must take up no space, got ${JSON.stringify(redAfter)}`
    );
    assert.notEqual(
      redAfter?.text,
      staleRed.text,
      "the old failure text must not still be rendered beside the new refusal"
    );
    step("PASS — the local refusal replaced the stale failure instead of stacking under it");

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!relayStopped) {
      relayStopped = true;
      await stopManagedProcess(relay).catch(() => {});
    }
  }
  console.log(`screenshots in ${SHOTS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
