// A /goal refused for length has to be ON SCREEN, and a long goal has to say on its
// card that it is re-sent every turn. Both used to reach only the client log, which
// sits behind Settings → Log on the desktop and is `display: none` on the phone.
//
// Measured, not read: innerText is true whether or not anything was laid out, so every
// assertion here is a box with real height, plus a screenshot to look at.
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
const SHOTS = path.join(ROOT, ".tmp-goal-length-e2e");

if (existsSync(path.join(ROOT, "crates", "sealwire-private", "STUB"))) {
  console.log(
    "goal-length-e2e: SKIPPED — this checkout has the stub private crate, so /goal does not exist.\n" +
      "  Run scripts/with-private.sh npm run test:browser:goal-length instead."
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
      text: (node.textContent || "").trim(),
      hidden: node.hasAttribute("hidden"),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      display: style.display,
      visibility: style.visibility,
    };
  }, selector);
}

async function composerLook(page) {
  return page.evaluate(() => {
    const node = document.querySelector("#message-input");
    const field = node?.closest(".composer-inner");
    const style = getComputedStyle(node);
    return {
      color: style.color,
      cursor: style.cursor,
      fieldBackground: field ? getComputedStyle(field).backgroundColor : null,
    };
  });
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-length-verify-"));
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
    step("page loaded");
    await page.waitForSelector("#open-start-session-dialog", { timeout: 20000 });
    step("shell ready");
    step("starting fake session");
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

    // ---- (1) the refusal has to be ON SCREEN -------------------------------
    step("session ready");
    await page.click("#message-input");
    await page.type("#message-input", "/goal");
    step("typed /goal, waiting for menu");
    await page.waitForSelector(".composer-command-row", { timeout: 10000 });
    await page.keyboard.press("Enter");
    step("menu up, picking");
    await page.waitForSelector(".composer-command-pill", { timeout: 10000 });
    step("pill created");

    const objective = `Aim: ${"x".repeat(8200)}`;
    await page.fill("#message-input", objective);
    await page.click("#send-button");
    step("submitted, waiting for the refusal line");

    // The gate stops this before the relay hears about it, so it lands in "not sent",
    // not on the error line — which is for things that actually broke.
    await page.waitForFunction(
      () => {
        const node = document.querySelector("#composer-held");
        return node && !node.hasAttribute("hidden") && (node.textContent || "").trim().length > 0;
      },
      { timeout: 10000 }
    );
    const refusal = await boxOf(page, "#composer-held");
    const errorLine = await boxOf(page, "#composer-error");
    await page.screenshot({ path: path.join(SHOTS, "1-refusal.png") });

    assert.ok(refusal, "#composer-held must exist");
    assert.equal(errorLine?.height, 0, "nothing broke, so the error line stays down");
    assert.equal(refusal.hidden, false, "it must not still be hidden");
    assert.ok(refusal.height > 10, `it must occupy real space, got ${JSON.stringify(refusal)}`);
    assert.notEqual(refusal.display, "none");
    assert.match(refusal.text, /8205 characters/, "names what was written");
    assert.match(refusal.text, /Trim 205/, "names how much to cut");

    // The draft survives, or the fix is "retype it".
    const kept = await page.inputValue("#message-input");
    assert.equal(kept.length, objective.length, "the draft must still be there to edit");

    // ---- (2) the notice has to be on the Goal card -------------------------
    const deviceId = await page.evaluate(async () => {
      const r = await fetch("/api/session", { credentials: "same-origin" }).then((x) => x.json());
      return r?.data?.active_controller_device_id || null;
    });
    assert.ok(deviceId, "need the controlling device id to set a goal");

    const longGoal = `Ship the phone menu. ${"Detail. ".repeat(320)}`;
    const setResult = await page.evaluate(
      async ({ objective: obj, deviceId: dev }) => {
        const session = await fetch("/api/session", { credentials: "same-origin" }).then((x) => x.json());
        const threadId = session?.data?.active_thread_id;
        const response = await fetch("/api/session/goal", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
          body: JSON.stringify({ thread_id: threadId, objective: obj, device_id: dev }),
        });
        return { status: response.status, body: await response.text() };
      },
      { objective: longGoal, deviceId }
    );
    assert.ok(
      setResult.status < 400 && !setResult.body.includes('"isError":true'),
      `the goal must actually be set: ${JSON.stringify(setResult)}`
    );

    step(`goal set: ${setResult.status}`);
    // The rail is already open; what is needed is its Agents tab.
    await page.click('.right-panel-tabs-header button:has-text("Agents")');
    step("Agents tab open");
    await page.waitForSelector(".reviewer-goal-length", { timeout: 15000 });
    const notice = await boxOf(page, ".reviewer-goal-length");
    await page.screenshot({ path: path.join(SHOTS, "2-goal-card.png") });

    assert.ok(notice.height > 8, `the notice must be laid out, got ${JSON.stringify(notice)}`);
    assert.match(notice.text, /re-sent in full every turn/);
    assert.match(notice.text, new RegExp(`${longGoal.trim().length} characters`));

    // ---- (3) the composer LOOKS held while a command runs -------------------
    // It is already `disabled` — the defect was that it looked exactly like a draft
    // you were still typing, so the only cue was the cursor on hover.
    const idleLook = await composerLook(page);
    await page.route("**/api/session/goal", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });
    await page.fill("#message-input", "ship the phone menu");
    await page.click("#send-button");
    await page.waitForFunction(
      () => document.querySelector("#message-input")?.disabled === true,
      { timeout: 10000 }
    );
    const heldLook = await composerLook(page);
    await page.keyboard.type("XXXX").catch(() => {});
    const afterTyping = await page.inputValue("#message-input");
    await page.screenshot({ path: path.join(SHOTS, "3-held.png") });
    step("composer held");

    assert.equal(afterTyping, "ship the phone menu", "a held composer takes no keystrokes");

    // The phone's textarea is `#remote-message-input`; the desktop's is `#message-input`.
    // Measuring only the one this page happens to render is how the freeze shipped
    // never having applied on the phone at all, green the whole way.
    const bothIds = await page.evaluate(() => {
      const out = {};
      for (const id of ["message-input", "remote-message-input"]) {
        document.querySelectorAll(".probe-frozen").forEach((n) => n.remove());
        const box = document.createElement("div");
        box.className = "composer-inner is-frozen probe-frozen";
        const field = document.createElement("textarea");
        field.id = id;
        box.append(field);
        document.body.append(box);
        const style = getComputedStyle(field);
        out[id] = { color: style.color, cursor: style.cursor };
      }
      document.querySelectorAll(".probe-frozen").forEach((n) => n.remove());
      return out;
    });
    assert.deepEqual(
      bothIds["remote-message-input"],
      bothIds["message-input"],
      `the freeze must not be keyed to one surface's id — ${JSON.stringify(bothIds)}`
    );
    assert.equal(bothIds["remote-message-input"].cursor, "not-allowed");
    assert.notEqual(
      heldLook.color,
      idleLook.color,
      `held draft must not be the same ink as a live one — ${JSON.stringify(heldLook)}`
    );
    assert.notEqual(heldLook.fieldBackground, idleLook.fieldBackground, "nor the same fill");
    assert.equal(heldLook.cursor, "not-allowed");
    await page.unroute("**/api/session/goal");
    await page.waitForFunction(
      () => document.querySelector("#message-input")?.disabled === false,
      { timeout: 15000 }
    );

    // ---- (3) a REFUSED card button reports on the card ---------------------
    // The relay going away is the refusal that is reachable on demand; the 200 +
    // isError branch is pinned by unit tests. What matters here is WHERE it lands.
    await page.waitForSelector(".reviewer-goal", { timeout: 15000 });
    await stopManagedProcess(relay).catch(() => {});
    relayStopped = true;
    step("relay stopped; pressing Stop on the card");

    await page.click('.reviewer-goal .reviewer-card-button:has-text("Stop")');
    await page.waitForSelector(".reviewer-goal-error", { timeout: 20000 });
    const cardError = await boxOf(page, ".reviewer-goal-error");
    await page.screenshot({ path: path.join(SHOTS, "3-card-refusal.png") });

    assert.ok(
      cardError.height > 8,
      `the card's own line must be laid out: ${JSON.stringify(cardError)}`
    );
    assert.ok(cardError.text.trim().length > 0, "and it must say why");
    // The point of moving it here: on a phone the composer is behind the modal.
    const composerAfter = await boxOf(page, "#composer-held");
    assert.notEqual(
      composerAfter?.text,
      cardError.text,
      "a card refusal belongs on the card, not copied onto the composer"
    );

    assert.deepEqual(errors, [], "no page errors");
    console.log("goal-length-e2e OK");
    console.log("  card   :", JSON.stringify(cardError));
    console.log("  held   :", JSON.stringify(heldLook));
    console.log("  refusal:", JSON.stringify(refusal));
    console.log("  notice :", JSON.stringify(notice));
    console.log("  card   :", JSON.stringify(cardError));
    console.log("  held   :", JSON.stringify(heldLook));
    console.log("  shots  :", SHOTS);
  } catch (error) {
    try {
      const pages = context ? context.pages() : [];
      if (pages[0]) await pages[0].screenshot({ path: path.join(SHOTS, "failure.png") });
    } catch {}
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (!relayStopped) await stopManagedProcess(relay).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
