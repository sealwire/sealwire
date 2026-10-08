import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { webkit } from "playwright";

import { launchBrowser, readProtocolFrames } from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { waitForPairedRemote } from "./e2e/harness/pairing.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcesses, waitFor, waitForHealth } from "./e2e/harness/process.mjs";
import { startPublicRelay, waitForBrokerConnection } from "./e2e/harness/relay.mjs";
import { waitForRemoteMessageInput } from "./e2e/harness/remote-session.mjs";

const TIMEOUT = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const MOBILE = { width: 390, height: 844 };
const TASK = "DELEGATE-MOBILE-REAL-BROKER 检查手机输入";
const DELEGATE_NAME = "手机受托者";
const CASE = process.env.DELEGATE_E2E_CASE || "all";
assert.ok(["all", "keyboard", "scroll", "refresh"].includes(CASE), `Unknown case: ${CASE}`);
const BROWSER = process.env.E2E_BROWSER === "webkit" ? "webkit" : "chromium";
const ARTIFACT_DIR = path.resolve("target/e2e/remote-delegate", BROWSER, CASE);

function isPublicBuild() {
  const controller = path.resolve("crates/sealwire-private/frontend/composer-command-controller.js");
  if (!existsSync(controller)) return true;
  return readFileSync(controller, "utf8").includes("Public-checkout placeholder");
}

async function settleMenu(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function clearCommand(page) {
  await page.fill("#remote-message-input", "");
  await page.press("#remote-message-input", "Backspace");
}

async function firstDelegateVisible(page) {
  await settleMenu(page);
  const bounds = await page.evaluate(() => {
    const menu = document.querySelector(".composer-command-menu");
    const row = menu.querySelector(".composer-command-row");
    const box = row.getBoundingClientRect();
    const frame = menu.getBoundingClientRect();
    const threadTop = document.querySelector(".remote-thread-panel .thread-shell").getBoundingClientRect().top;
    return {
      visible: box.top >= Math.max(frame.top, visualViewport.offsetTop, threadTop)
        && box.bottom <= Math.min(frame.bottom, visualViewport.offsetTop + visualViewport.height)
        && row.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
      scrollTop: menu.scrollTop, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight,
      rowTop: box.top, rowBottom: box.bottom, threadTop,
    };
  });
  assert.equal(bounds.visible, true, `first delegate must be visible and clickable: ${JSON.stringify(bounds)}`);
  assert.equal(bounds.scrollTop, 0, "first choice must retain the menu's top padding");
  assert.ok(bounds.scrollHeight > bounds.clientHeight, "delegate list must overflow to reproduce retained scrolling");
  assert.equal(await page.locator(".composer-command-name").first().textContent(), DELEGATE_NAME);
  assert.equal(await page.locator(".composer-command-kind").first().textContent(), "Delegatee");
}

async function main() {
  if (isPublicBuild()) {
    console.log("remote-delegate-e2e SKIPPED — public checkout: /delegate requires the private frontend.");
    return;
  }
  await fs.rm(ARTIFACT_DIR, { recursive: true, force: true });
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-remote-delegate-")));
  const cwd = path.join(stateDir, "project");
  await fs.mkdir(cwd);
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const scenario = await createFakeProviderScenarioHarness(stateDir, {
    matchers: [{
      contains: ["Another agent is about to be given this task"],
      scenario: { reply: `${TASK}\nCheck input focus and the first delegate.\n\n## Context\nA mobile browser is connected through a real broker.` },
    }, {
      contains: [TASK, "Do it yourself unless"],
      scenario: { reply: "Mobile delegation checked.", report_back: { answer: "Mobile delegation checked." } },
    }],
  });
  let broker;
  let relay;
  let browser;
  let page;
  try {
    broker = startPublicBroker({
      brokerPort,
      brokerStatePath: path.join(stateDir, "broker.json"),
      issuerSecret: "delegate-browser-e2e-issuer-0123456789abcdef",
    });
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`, TIMEOUT);
    relay = startPublicRelay({
      relayPort,
      relayStateDb: path.join(stateDir, "sealwire.db"),
      brokerPort,
      lanIp: "127.0.0.1",
      codexHomeDir: path.join(stateDir, "codex"),
      peerId: "delegate-browser-e2e-relay",
      extraEnv: { AGENT_PROVIDERS: "fake", SEALWIRE_BETA: "1", ...scenario.env },
    });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`, TIMEOUT);
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`, TIMEOUT);
    console.log(`Real broker ${brokerPort}, isolated relay ${relayPort}; state ${stateDir}`);

    const api = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${relayPort}${route}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
        body: body ? JSON.stringify({ device_id: "delegate-browser-e2e", ...body }) : undefined,
      });
      const result = await response.json();
      assert.ok(response.ok && result.ok !== false && !result.isError, `${route}: ${JSON.stringify(result.error || result)}`);
      return result.data || result;
    };
    await api("/api/workspace/trust", { cwd, trusted: true });
    await api("/api/allowed-roots", { allowed_roots: [cwd] });
    const started = await api("/api/session/start", { cwd, provider: "fake", model: "fake-echo", approval_policy: "bypass" });
    const sourceId = started.active_thread_id;
    assert.ok(sourceId);

    // Multiple real relationships keep the delegate list overflowing after the command changes.
    for (let index = 0; index < 4; index++) {
      const peer = await api("/api/session/start", { cwd, provider: "fake", model: "fake-echo", approval_policy: "bypass" });
      await api(`/api/threads/${encodeURIComponent(peer.active_thread_id)}/rename`, { name: `已有受托者 ${index}` });
      await api("/api/session/delegate", { thread_id: sourceId, agent: peer.active_thread_id, message: `${TASK} seed ${index}` });
      await waitFor(async () => (await api("/api/session/reviews")).asks?.some((ask) =>
        ask.asker_thread_id === sourceId && ask.peer_thread_id === peer.active_thread_id && ask.status === "done"), TIMEOUT);
    }
    await api("/api/session/resume", { thread_id: sourceId });
    const seededIds = new Set((await api("/api/session/reviews")).asks.map((ask) => ask.id));
    const ticket = await api("/api/pairing/start", { path_scope: [cwd] });
    const launched = await launchBrowser({
      browserType: BROWSER === "webkit" ? webkit : undefined,
      contextOptions: { viewport: MOBILE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
    });
    browser = launched.browser;
    page = await launched.context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(ticket.pairing_url, { waitUntil: "domcontentloaded" });
    await waitFor(async () => {
      const devices = await api("/api/devices");
      return devices.pending_pairing_requests?.some((request) => request.pairing_id === ticket.pairing_id);
    }, TIMEOUT);
    await api(`/api/pairings/${encodeURIComponent(ticket.pairing_id)}/decision`, { decision: "approve" });
    await waitForPairedRemote(page, TIMEOUT);
    await waitForRemoteMessageInput(page, TIMEOUT);
    console.log("PASS browser paired through real broker");

    const input = "#remote-message-input";
    await page.fill(input, "/delegate fake ");
    await page.fill(input, TASK);
    await page.locator("#remote-send-button").tap();
    let firstAsk;
    await waitFor(async () => {
      const reviews = await api("/api/session/reviews");
      firstAsk = reviews.asks?.find((ask) => ask.asker_thread_id === sourceId && !seededIds.has(ask.id) && ask.status === "done");
      return firstAsk;
    }, TIMEOUT);
    const peerId = firstAsk.peer_thread_id;
    assert.ok(peerId && peerId !== sourceId);
    await api(`/api/threads/${encodeURIComponent(peerId)}/rename`, { name: DELEGATE_NAME });
    await waitForRemoteMessageInput(page, TIMEOUT);
    console.log("PASS /delegate sent over real broker; peer answered through report_back");

    await page.setViewportSize({ width: 390, height: 320 });
    await page.evaluate(() => Object.defineProperty(screen, "height", { configurable: true, value: 844 }));
    const waitForDelegate = () => page.waitForFunction((name) =>
      document.querySelector(".composer-command-name")?.textContent === name, DELEGATE_NAME, { timeout: TIMEOUT });

    if (CASE === "all" || CASE === "keyboard") {
      await page.focus(input);
      await page.evaluate(() => {
        window.__delegateInputBlurs = [];
        document.querySelector("#remote-message-input").addEventListener("blur", (event) => {
          window.__delegateInputBlurs.push(event.target.value);
        });
      });
      await page.keyboard.type("/delegate ");
      await waitForDelegate();
      await settleMenu(page);
      assert.deepEqual(await page.evaluate(() => window.__delegateInputBlurs), [], "typing /delegate must never close the keyboard by blurring");
      assert.equal(await page.$eval(input, (node) => document.activeElement === node), true);
      await firstDelegateVisible(page);
      for (const height of [480, 320]) {
        await page.setViewportSize({ width: 390, height });
        await page.evaluate(() => {
          Object.defineProperty(screen, "height", { configurable: true, value: 844 });
          visualViewport.dispatchEvent(new Event("resize"));
        });
        await settleMenu(page);
        assert.deepEqual(await page.evaluate(() => window.__delegateInputBlurs), [], "keyboard viewport changes must not blur the input");
        await firstDelegateVisible(page);
      }
      await page.keyboard.type("@手机");
      assert.equal(await page.inputValue(input), "@手机", "typing must continue without refocusing");
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "keyboard-320.png") });
      console.log("PASS typing and resizing never blur the input");
      await clearCommand(page);
    }
    if (CASE === "all" || CASE === "scroll") {
      await page.fill(input, "/");
      await page.waitForSelector(".composer-command-menu", { timeout: TIMEOUT });
      const scrollTop = await page.evaluate(() => {
        const menu = document.querySelector(".composer-command-menu");
        menu.scrollTop = 120;
        return menu.scrollTop;
      });
      assert.ok(scrollTop > 0, "command menu must be scrolled before selecting /delegate");
      await page.locator(".composer-command-row").filter({ hasText: "/delegate" }).tap();
      await waitForDelegate();
      await firstDelegateVisible(page);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "scroll-320.png") });
      console.log("PASS first delegate visible after selecting from a scrolled menu");
    }
    if (CASE === "all" || CASE === "refresh") {
      await clearCommand(page);
      await page.fill(input, "/delegate ");
      await waitForDelegate();
      await settleMenu(page);
      const scrollTop = await page.evaluate(() => {
        const menu = document.querySelector(".composer-command-menu");
        menu.scrollTop = menu.scrollHeight;
        return menu.scrollTop;
      });
      assert.ok(scrollTop > 0);
      const updatedName = `${DELEGATE_NAME} 更新`;
      await api(`/api/threads/${encodeURIComponent(peerId)}/rename`, { name: updatedName });
      await page.waitForFunction((name) => document.querySelector(".composer-command-name")?.textContent === name,
        updatedName, { timeout: TIMEOUT });
      await settleMenu(page);
      assert.equal(await page.$eval(".composer-command-menu", (menu) => menu.scrollTop), scrollTop,
        "background catalog updates must preserve the reader's scroll position");
      await api(`/api/threads/${encodeURIComponent(peerId)}/rename`, { name: DELEGATE_NAME });
      await waitForDelegate();
      console.log("PASS background catalog updates preserve menu scrolling");
    }
    await clearCommand(page);
    await page.fill(input, "/delegate ");
    await waitForDelegate();
    await page.keyboard.type("@手机");
    await page.locator(".composer-command-row").first().tap();
    assert.equal(await page.locator(".composer-command-pill.is-peer .composer-command-pill-label").textContent(), DELEGATE_NAME);
    await page.keyboard.type(`${TASK} 再检查一次`);
    await page.locator("#remote-send-button").tap();
    await waitFor(async () => {
      const reviews = await api("/api/session/reviews");
      return reviews.asks?.some((ask) => ask.id !== firstAsk.id && ask.asker_thread_id === sourceId
        && ask.peer_thread_id === peerId && ask.status === "done");
    }, TIMEOUT);
    const frames = await readProtocolFrames(page);
    assert.ok(frames.some((frame) => frame.direction === "send" && /encrypted/.test(frame.kind)), "requests must use encrypted broker transport");
    assert.deepEqual(errors, []);
    console.log("PASS continued typing and delegatee reuse over encrypted broker transport");
    await fs.writeFile(path.join(ARTIFACT_DIR, "result.json"), JSON.stringify({ brokerPort, relayPort, sourceId, peerId, case: CASE, passed: true }, null, 2));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "failure.png") }).catch(() => {});
      await fs.writeFile(path.join(ARTIFACT_DIR, "page.txt"), await page.locator("body").textContent()).catch(() => {});
    }
    dumpProcessLogs(relay, broker);
    throw error;
  } finally {
    await browser?.close();
    await stopManagedProcesses([relay, broker]);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
