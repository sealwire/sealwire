// Browser e2e for the "scroll to latest" floating button.
//
// Boots a local relay with the fake provider, opens a thread whose transcript
// overflows the viewport, then exercises the button at both a desktop and a
// phone viewport: scroll up -> button shows, click -> scrolls toward the bottom
// -> button hides. The transcript is a `.chat-thread` element scroller on every
// surface now (desktop and phone alike — there is no window scroller), so both
// legs escape the bottom-follow with a real wheel-up over that element.
// Requires a built `web/` bundle (run `vite build`).
//
// Run: npm run build && node scripts/browser-scroll-to-bottom-e2e.mjs
// Screenshots are written under the OS temp dir (path printed at the end).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { deleteThreadAndWait } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = 45000;
const SHOT_DIR = path.join(os.tmpdir(), "scroll-to-bottom-e2e-shots");

const LONG_PROMPT = Array.from(
  { length: 24 },
  (_, i) =>
    `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog while the `
    + `floating scroll-to-bottom button waits patiently above the composer.`
).join("\n\n");

async function startThread(relayPort, { cwd, deviceId, initialPrompt }) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      device_id: deviceId,
      initial_prompt: initialPrompt,
      approval_policy: "never",
      sandbox: "workspace-write",
      effort: "medium",
      provider: "fake",
      model: "fake-echo",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, "thread start should return 200");
  assert.ok(payload?.data?.active_thread_id, "thread id missing");
  return payload.data.active_thread_id;
}

// A REAL upward wheel over the `.chat-thread` scroller, via Chromium's input
// path. The hand-rolled bottom-follow (frontend/shared/stick-to-bottom.js)
// un-sticks ONLY on a real reader gesture — a programmatic `scrollTop = 0` +
// synthetic `scroll` event reads as layout churn and is re-glued straight back
// to the bottom, so it never reveals the button. Mirrors the escape gesture in
// browser-stick-to-bottom-e2e.mjs.
async function realWheelUp(page, deltaPx) {
  const point = await page.evaluate(() => {
    const t = document.querySelector(".chat-thread");
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (!point) return;
  await page.mouse.move(point.x, point.y);
  await delay(60); // let the hover/target settle so the wheel actually lands
  await page.mouse.wheel(0, -deltaPx);
}

async function readButtonState(page) {
  return page.evaluate(() => {
    const thread = document.querySelector(".chat-thread");
    const anchor = document.querySelector(".scroll-to-bottom");
    const button = document.querySelector(".scroll-to-bottom-button");
    const overflows = thread && thread.scrollHeight > thread.clientHeight + 1;
    const doc = document.scrollingElement || document.documentElement;
    const metrics = overflows
      ? { scrollTop: thread.scrollTop, clientHeight: thread.clientHeight, scrollHeight: thread.scrollHeight }
      : { scrollTop: window.scrollY, clientHeight: window.innerHeight, scrollHeight: doc.scrollHeight };
    return {
      hasAnchor: Boolean(anchor),
      visible: anchor?.getAttribute("data-visible") || null,
      scroller: overflows ? "chat-thread" : "window",
      ...metrics,
      distanceFromBottom: metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
      buttonOpacity: button ? getComputedStyle(button).opacity : null,
    };
  });
}

async function exercise(page, surfaceLabel) {
  await page.waitForFunction(
    () => document.querySelectorAll(".chat-thread .chat-message").length > 0,
    null,
    { timeout: TIMEOUT_MS }
  );
  // Wait for the fake-echo turn to finish streaming (the composer flips back
  // from "Stop" to "Send"), then let content-visibility settle.
  await page
    .waitForFunction(
      () => {
        const stop = document.querySelector(".stop-button");
        return !stop || stop.hasAttribute("hidden") || stop.offsetParent === null;
      },
      null,
      { timeout: TIMEOUT_MS }
    )
    .catch(() => {});
  await delay(800);

  // The transcript loads pinned to the bottom, so the button starts hidden.
  // Asserting this first means "button now visible" can only be the wheel's doing
  // — not a load-time regression that left us already scrolled up.
  const initialState = await readButtonState(page);
  console.log(`[${surfaceLabel}] initial metrics`, initialState);
  assert.equal(
    initialState.visible,
    "false",
    `${surfaceLabel}: button should start hidden with the transcript pinned to the bottom`
  );

  // 1) Scroll UP with a real wheel-up -> the button should appear. The follower
  // ignores programmatic scrolls (they'd be re-glued to the bottom), so we drive
  // Chromium's real input path. `content-visibility: auto` re-measures rows as
  // they enter the viewport, so wheel up in a retry loop until the anchor reports
  // visible (a single big wheel usually suffices).
  let buttonShown = false;
  for (let attempt = 0; attempt < 10 && !buttonShown; attempt += 1) {
    await realWheelUp(page, 2000);
    await delay(250);
    buttonShown = await page.evaluate(
      () => document.querySelector(".scroll-to-bottom")?.getAttribute("data-visible") === "true"
    );
  }
  const scrolledUpState = await readButtonState(page);
  const buttonViewportGap = await page.evaluate(() => {
    const btn = document.querySelector(".scroll-to-bottom-button");
    const r = btn?.getBoundingClientRect();
    return r ? Math.round(window.innerHeight - r.bottom) : null;
  });
  console.log(`[${surfaceLabel}] scrolled-up metrics`, scrolledUpState);
  console.log(`[${surfaceLabel}] button gap above viewport bottom (px):`, buttonViewportGap);
  assert.ok(
    buttonShown,
    `${surfaceLabel}: a real wheel-up must escape the bottom-follow and reveal the button`
  );
  // Prove the wheel actually moved the viewport UP (not that we merely started
  // scrolled up): the button appearing must be caused by this gesture.
  assert.ok(
    scrolledUpState.scrollTop < initialState.scrollTop - 400,
    `${surfaceLabel}: the real wheel-up must scroll the transcript UP `
    + `(from ${initialState.scrollTop} to ${scrolledUpState.scrollTop})`
  );
  // Let the fade-in transition settle before reading opacity / screenshotting.
  await delay(300);
  const shownState = await readButtonState(page);
  await page.screenshot({ path: path.join(SHOT_DIR, `${surfaceLabel}-button-shown.png`) });
  assert.equal(shownState.visible, "true", `${surfaceLabel}: button should be visible when scrolled up`);
  assert.equal(shownState.buttonOpacity, "1", `${surfaceLabel}: button should be fully opaque when shown`);

  // 2) Click it -> the component's OWN click handler must reach the true bottom
  // (its settle loop defeats the content-visibility undershoot) and hide the
  // button. No manual scrolling here — this verifies the real behaviour.
  const topScrollTop = shownState.scrollTop;
  // Record the active scroller's scrollTop on every frame so we can assert the
  // settle only ever moves DOWNWARD — a backward jerk is the "violent shaking"
  // regression (content-visibility estimate ↔ real height flip-flop).
  await page.evaluate(() => {
    window.__scrollSamples = [];
    const t = document.querySelector(".chat-thread");
    const overflows = t && t.scrollHeight > t.clientHeight + 1;
    const read = () => (overflows ? t.scrollTop : window.scrollY);
    let n = 0;
    const tick = () => {
      window.__scrollSamples.push(read());
      n += 1;
      if (n < 45) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.click(".scroll-to-bottom-button");
  await page.waitForFunction(
    () => document.querySelector(".scroll-to-bottom")?.getAttribute("data-visible") === "false",
    null,
    { timeout: TIMEOUT_MS }
  );
  await delay(300);
  const samples = await page.evaluate(() => window.__scrollSamples || []);
  let maxBackjump = 0;
  for (let i = 1; i < samples.length; i += 1) {
    maxBackjump = Math.max(maxBackjump, samples[i - 1] - samples[i]);
  }
  console.log(`[${surfaceLabel}] settle samples (${samples.length}), max backward jump:`, maxBackjump);
  assert.ok(
    maxBackjump <= 8,
    `${surfaceLabel}: scroll-to-bottom must not jerk backwards during settle (maxBackjump=${maxBackjump}px, samples=${JSON.stringify(samples)})`
  );
  const hiddenState = await readButtonState(page);
  await page.screenshot({ path: path.join(SHOT_DIR, `${surfaceLabel}-button-hidden.png`) });
  assert.equal(hiddenState.visible, "false", `${surfaceLabel}: button should hide once at the bottom`);
  assert.ok(
    hiddenState.scrollTop > topScrollTop + 400,
    `${surfaceLabel}: clicking should scroll toward the bottom (from ${topScrollTop} to ${hiddenState.scrollTop})`
  );
  assert.ok(
    hiddenState.distanceFromBottom <= 160,
    `${surfaceLabel}: the button's own click should land at the bottom (distance=${hiddenState.distanceFromBottom})`
  );

  return { shownState, hiddenState };
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "scroll-shot-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("scroll-shot-codex-", { requireAuth: false });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "scroll-shot-workspace-"))
  );

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let desktop;
  let phone;
  const threadIds = [];
  const results = {};
  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 680 } },
    }));

    const bootstrap = await context.newPage();
    await bootstrap.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await bootstrap.waitForFunction(
      () => Boolean(window.localStorage.getItem("agent-relay.device-id")),
      null,
      { timeout: TIMEOUT_MS }
    );
    const deviceId = await bootstrap.evaluate(() =>
      window.localStorage.getItem("agent-relay.device-id")
    );
    await bootstrap.close();

    const threadId = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: LONG_PROMPT,
    });
    threadIds.push(threadId);

    // Desktop.
    desktop = await context.newPage();
    attachPageDebugLogging(desktop, "desktop", { prefix: "scroll-to-bottom-e2e" });
    await desktop.setViewportSize({ width: 1280, height: 680 });
    await desktop.goto(`http://127.0.0.1:${relayPort}/?thread=${threadId}`, {
      waitUntil: "domcontentloaded",
    });
    await desktop.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    results.desktop = await exercise(desktop, "local-desktop");
    await desktop.close();

    // Phone.
    phone = await context.newPage();
    attachPageDebugLogging(phone, "phone", { prefix: "scroll-to-bottom-e2e" });
    await phone.setViewportSize({ width: 390, height: 740 });
    await phone.goto(`http://127.0.0.1:${relayPort}/?thread=${threadId}`, {
      waitUntil: "domcontentloaded",
    });
    await phone.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    results.phone = await exercise(phone, "local-phone");
    await phone.close();

    console.log(JSON.stringify({ relayPort, threadId, results }, null, 2));
    console.log(`\nScreenshots written to ${SHOT_DIR}`);
  } catch (error) {
    console.error(error);
    await writeFailureArtifacts({
      scenario: "scroll-to-bottom-e2e",
      relay,
      relayPort,
      localPage: desktop,
      extraPages: phone ? [phone] : [],
      metadata: { relayPort, workspaceDir, threadIds },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    dumpProcessLogs(relay);
    process.exitCode = 1;
  } finally {
    for (const id of threadIds) {
      await deleteThreadAndWait(relayPort, id, { cwd: workspaceDir }).catch(() => {});
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
