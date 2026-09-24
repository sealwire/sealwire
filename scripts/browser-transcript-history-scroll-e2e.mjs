// Browser e2e for scrolling UP through transcript history on the local surface.
//
//   prompt-paged-in-*  A long turn's prompt arrives with an older page; paging it
//                      in must not drag the reader back to the bottom (wheel, touch).
//   follow-*-escape    Small gestures release the live bottom-follow (a trackpad's
//                      first pixels, a flick whose scroll lands after the lift).
//   read-only-top      A long read-only thread pages to its first message, even
//                      with the scroller clamped at the very top.
//   thread-switch      Leaving an exhausted read-only thread for a long one still
//                      pages the new thread, with no tab switch.
//
// Run: npm run build && AGENT_PROVIDERS=fake E2E_USE_BUILT_BINARIES=1 \
//        node scripts/browser-transcript-history-scroll-e2e.mjs
// SCROLL_E2E_WEB_ROOT=<dir> serves another frontend build (a before/after run);
// SCROLL_E2E_BROWSER_CHANNEL=chrome drives the installed system Chrome;
// SCROLL_E2E_ONLY=<leg,...> runs a subset.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { openSessionsDrawer } from "./e2e/harness/drawer.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = 45000;
const WEB_ROOT = process.env.SCROLL_E2E_WEB_ROOT || "";
const BROWSER_CHANNEL = process.env.SCROLL_E2E_BROWSER_CHANNEL || undefined;
const ONLY = new Set((process.env.SCROLL_E2E_ONLY || "").split(",").filter(Boolean));

const LIVE_PROMPT = "long-turn-live";
const IDLE_PROMPT = "long-idle-history";
// Tall paragraphs: the rows after the prompt must outgrow the viewport plus the
// loader's 600px prefetch band, or the prompt is paged in before anyone scrolls.
const PARAGRAPH_PAD = "This sentence pads the paragraph so it wraps across a couple of lines. ".repeat(2);
const paragraphs = (count, label) => Array.from(
  { length: count },
  (_, index) => `${label} paragraph ${String(index + 1).padStart(2, "0")}. ${PARAGRAPH_PAD}\n\n`
);
const LIVE_CHUNKS = paragraphs(70, "Live");
// Opened once this much of the reply has streamed (see PARAGRAPH_PAD).
const LIVE_OPEN_AT_CHARS = 5000;
// Past one prefetch burst (8 pages), so reaching the top takes more than one.
const IDLE_TURNS_LONG = 20;
const IDLE_TURNS = 8;
// "Yanked to the bottom" reads as ~0; a reader left in history is thousands of px up.
const YANKED_DISTANCE_PX = 150;

function selected(leg) {
  return ONLY.size === 0 || ONLY.has(leg);
}

async function api(relayPort, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.ok(response.ok && payload.ok, `${pathname} failed: ${JSON.stringify(payload.error)}`);
  return payload.data;
}

async function startThread(relayPort, { cwd, deviceId, prompt }) {
  const data = await api(relayPort, "/api/session/start", {
    cwd,
    device_id: deviceId,
    initial_prompt: prompt,
    approval_policy: "never",
    sandbox: "workspace-write",
    effort: "medium",
    provider: "fake",
    model: "fake-echo",
  });
  assert.ok(data?.active_thread_id, "thread id missing");
  return data.active_thread_id;
}

async function waitForSession(relayPort, predicate, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await api(relayPort, "/api/session");
    if (predicate(session)) return session;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const waitIdle = (relayPort, threadId) =>
  waitForSession(
    relayPort,
    (session) => session.active_thread_id === threadId && !session.active_turn_id,
    `${threadId} to settle`
  );

// The snapshot caps live text, so read the reply's progress from the page API.
async function waitStreamedChars(relayPort, threadId, minChars) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = await api(relayPort, `/api/threads/${encodeURIComponent(threadId)}/transcript`);
    const last = page.entries?.at(-1);
    if (last?.kind === "agent_text" && (last.text || "").length >= minChars) return;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${threadId} to stream ${minChars} chars`);
}

async function buildLongHistory(relayPort, { cwd, deviceId, prompt, turns = IDLE_TURNS }) {
  const threadId = await startThread(relayPort, { cwd, deviceId, prompt });
  await waitIdle(relayPort, threadId);
  for (let turn = 1; turn < turns; turn += 1) {
    await api(relayPort, "/api/session/message", {
      device_id: deviceId,
      text: `${IDLE_PROMPT} follow-up ${turn}`,
      thread_id: threadId,
    });
    await waitIdle(relayPort, threadId);
  }
  return threadId;
}

function readMetricsInPage() {
  const scroller = document.querySelector(".chat-thread");
  if (!scroller) return null;
  return {
    distance: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)),
    scrollTop: Math.round(scroller.scrollTop),
    scrollHeight: scroller.scrollHeight,
  };
}

function promptRenderedInPage(prompt) {
  return [...document.querySelectorAll(".chat-thread .chat-message-user")]
    .some((node) => (node.textContent || "").includes(prompt));
}

async function openThread(page, relayPort, threadId) {
  await page.goto(`http://127.0.0.1:${relayPort}/?thread=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => document.querySelector(".chat-shell")?.dataset.view === "conversation"
      && document.querySelectorAll(".chat-thread .chat-message").length > 0,
    null,
    { timeout: TIMEOUT_MS }
  );
  await delay(800);
}

async function wheelUp(page, deltaPx) {
  const box = await page.locator(".chat-thread").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -deltaPx);
}

// A real finger drag via CDP: moving DOWN scrolls the content up.
async function touchPullDown(page, client, { distance = 300, steps = 12 } = {}) {
  const box = await page.locator(".chat-thread").boundingBox();
  const x = Math.round(box.x + box.width / 2);
  let y = Math.round(box.y + box.height * 0.25);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 0; step < steps; step += 1) {
    y += Math.round(distance / steps);
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await delay(16);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// Scroll up with `gesture` until the thread's own prompt is rendered.
async function scrollUpUntilPrompt(page, prompt, gesture, { attempts = 60, settleMs = 300 } = {}) {
  const trail = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await page.evaluate(promptRenderedInPage, prompt)) {
      return { found: true, attempts: attempt, trail };
    }
    await gesture();
    await delay(settleMs);
    const metrics = await page.evaluate(readMetricsInPage);
    trail.push(metrics?.scrollTop);
  }
  return { found: await page.evaluate(promptRenderedInPage, prompt), attempts, trail };
}

async function legPromptPagedIn(browser, { relayPort, cwd, deviceId, label, viewport, touch }) {
  const prompt = `${LIVE_PROMPT} ${label}`;
  const threadId = await startThread(relayPort, { cwd, deviceId, prompt });
  await waitStreamedChars(relayPort, threadId, LIVE_OPEN_AT_CHARS);

  const context = await browser.newContext({ hasTouch: touch, viewport });
  const page = await context.newPage();
  const client = touch ? await context.newCDPSession(page) : null;
  try {
    await openThread(page, relayPort, threadId);
    assert.equal(
      await page.evaluate(promptRenderedInPage, prompt),
      false,
      `${label}: precondition — the turn's prompt must start outside the first window`
    );

    const gesture = touch
      ? () => touchPullDown(page, client)
      : () => wheelUp(page, 1500);
    const scrolled = await scrollUpUntilPrompt(page, prompt, gesture);
    assert.ok(scrolled.found, `${label}: scrolling up never reached the prompt (${JSON.stringify(scrolled.trail)})`);
    const revisionAtReveal = (await api(relayPort, "/api/session")).transcript_revision;

    const samples = [];
    for (let index = 0; index < 14; index += 1) {
      await delay(150);
      samples.push(await page.evaluate(readMetricsInPage));
    }
    const session = await api(relayPort, "/api/session");
    assert.ok(
      session.active_turn_id && session.transcript_revision > revisionAtReveal,
      `${label}: the reply must still be streaming while the reader sits in history`
    );
    const distances = samples.map((sample) => sample.distance);
    console.log(`[${label}] prompt reached after ${scrolled.attempts} gestures; distances ${distances.join(", ")}`);
    assert.ok(
      Math.min(...distances) > YANKED_DISTANCE_PX,
      `${label}: paging the prompt in must not pull the reader back to the bottom `
        + `(distances after the reveal: ${distances.join(", ")})`
    );
    await waitIdle(relayPort, threadId);
    return { attempts: scrolled.attempts, minDistance: Math.min(...distances) };
  } finally {
    await client?.detach().catch(() => {});
    await context.close();
  }
}

// Following a live reply at the bottom, a small reader gesture must still escape:
// a trackpad's first few pixels, or a flick whose scroll lands after the lift.
async function legFollowEscape(browser, { relayPort, cwd, deviceId, label, touch }) {
  const threadId = await startThread(relayPort, { cwd, deviceId, prompt: `${LIVE_PROMPT} ${label}` });
  await waitStreamedChars(relayPort, threadId, 1500);
  const viewport = touch ? { width: 390, height: 740 } : { width: 1280, height: 720 };
  const context = await browser.newContext({ hasTouch: touch, viewport });
  const page = await context.newPage();
  const client = touch ? await context.newCDPSession(page) : null;
  try {
    await openThread(page, relayPort, threadId);
    const before = await page.evaluate(readMetricsInPage);
    assert.ok(before.distance <= 4, `${label}: precondition — following the bottom (${before.distance})`);
    const box = await page.locator(".chat-thread").boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    if (touch) {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 40 }] });
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 110 }] });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(x, y);
      for (let step = 0; step < 12; step += 1) {
        await page.mouse.wheel(0, -3);
        await delay(16);
      }
    }
    const distances = [];
    for (let index = 0; index < 10; index += 1) {
      await delay(150);
      distances.push((await page.evaluate(readMetricsInPage)).distance);
    }
    assert.ok((await api(relayPort, "/api/session")).active_turn_id, `${label}: must still be streaming`);
    console.log(`[${label}] distances after the gesture: ${distances.join(", ")}`);
    assert.ok(
      distances.at(-1) > 20 && distances.at(-1) >= distances[0],
      `${label}: the gesture must release the follow while the reply streams (${distances.join(", ")})`
    );
    await waitIdle(relayPort, threadId);
    return { distances };
  } finally {
    await client?.detach().catch(() => {});
    await context.close();
  }
}

async function legReadOnlyTop(browser, { relayPort, cwd, deviceId }) {
  const prompt = `${IDLE_PROMPT} read-only`;
  const idleThread = await buildLongHistory(relayPort, { cwd, deviceId, prompt, turns: IDLE_TURNS_LONG });
  // Starting another thread makes the long one a read-only (non-active) view.
  const liveThread = await startThread(relayPort, { cwd, deviceId, prompt: "short live thread" });
  await waitIdle(relayPort, liveThread);

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await openThread(page, relayPort, idleThread);
    assert.equal(
      await page.evaluate(promptRenderedInPage, prompt),
      false,
      "read-only-top: precondition — the first message must start several pages up"
    );
    // Each wheel at the clamped top must keep paging on its own; before, the
    // loader sat idle until some unrelated re-render happened to poke it.
    const scrolled = await scrollUpUntilPrompt(page, prompt, () => wheelUp(page, 4000), {
      attempts: 12,
      settleMs: 400,
    });
    const atTop = scrolled.trail.filter((top) => top === 0).length;
    console.log(`[read-only-top] reached=${scrolled.found} after ${scrolled.attempts} wheels; at scrollTop 0 for ${atTop}`);
    assert.ok(
      scrolled.found,
      `read-only-top: scrolling up must page a read-only thread to its first message `
        + `(scrollTop per wheel: ${JSON.stringify(scrolled.trail)})`
    );
    return { attempts: scrolled.attempts, wheelsAtTop: atTop };
  } finally {
    await context.close();
  }
}

async function legThreadSwitch(browser, { relayPort, cwd, deviceId }) {
  const shortThread = await startThread(relayPort, { cwd, deviceId, prompt: "short exhausted thread" });
  await waitIdle(relayPort, shortThread);
  const longPrompt = `${IDLE_PROMPT} switch-target`;
  const longThread = await buildLongHistory(relayPort, { cwd, deviceId, prompt: longPrompt });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    // The short thread is read-only now; scrolling to its top exhausts its history.
    await openThread(page, relayPort, shortThread);
    for (let index = 0; index < 4; index += 1) {
      await wheelUp(page, 3000);
      await delay(250);
    }

    await openSessionsDrawer(page, { timeoutMs: TIMEOUT_MS });
    const row = page.locator(`#threads-list [data-thread-id="${longThread}"]`).first();
    await row.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await row.click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".chat-thread .chat-message")].length > 0
        && !document.querySelector(".chat-thread .chat-message-user")?.textContent?.includes("short exhausted thread"),
      null,
      { timeout: TIMEOUT_MS }
    );
    await delay(800);
    const scrolled = await scrollUpUntilPrompt(page, longPrompt, () => wheelUp(page, 4000), {
      attempts: 50,
      settleMs: 400,
    });
    console.log(`[thread-switch] reached=${scrolled.found} after ${scrolled.attempts} wheels`);
    assert.ok(
      scrolled.found,
      `thread-switch: the newly shown thread must page its own history without a tab switch `
        + `(scrollTop per wheel: ${JSON.stringify(scrolled.trail)})`
    );
    return { attempts: scrolled.attempts };
  } finally {
    await context.close();
  }
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-scroll-e2e-"));
  const codexHomeDir = await prepareSeededCodexHome("history-scroll-e2e-codex-", { requireAuth: false });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "history-scroll-e2e-workspace-"))
  );
  const scenario = await createFakeProviderScenarioHarness(stateDir, {
    matchers: [
      {
        contains: [LIVE_PROMPT],
        scenario: {
          tool_calls: 40,
          reasoning_between_tools: true,
          tool_call_delay_ms: 20,
          chunks: LIVE_CHUNKS,
          chunk_delay_ms: 300,
        },
      },
      {
        contains: [IDLE_PROMPT],
        scenario: {
          tool_calls: 20,
          reasoning_between_tools: true,
          tool_call_delay_ms: 1,
          chunks: paragraphs(12, "Idle"),
          chunk_delay_ms: 0,
        },
      },
    ],
  });
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    codexHomeDir,
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      ...scenario.env,
      ...(WEB_ROOT ? { RELAY_WEB_ROOT: WEB_ROOT } : {}),
    },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  const browser = await chromium.launch({ headless: true, channel: BROWSER_CHANNEL });
  const results = { webRoot: WEB_ROOT || "worktree web/", browser: BROWSER_CHANNEL || "playwright chromium" };
  const failures = [];
  try {
    const bootstrap = await browser.newPage();
    await bootstrap.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await bootstrap.waitForFunction(
      () => Boolean(window.localStorage.getItem("agent-relay.device-id")),
      null,
      { timeout: TIMEOUT_MS }
    );
    const deviceId = await bootstrap.evaluate(() => window.localStorage.getItem("agent-relay.device-id"));
    await bootstrap.close();
    const shared = { relayPort, cwd: workspaceDir, deviceId };

    const legs = [
      ["prompt-paged-in-desktop", () => legPromptPagedIn(browser, {
        ...shared, label: "desktop", viewport: { width: 1280, height: 720 }, touch: false,
      })],
      ["prompt-paged-in-phone", () => legPromptPagedIn(browser, {
        ...shared, label: "phone", viewport: { width: 390, height: 740 }, touch: true,
      })],
      ["follow-trackpad-escape", () => legFollowEscape(browser, {
        ...shared, label: "follow-trackpad-escape", touch: false,
      })],
      ["follow-flick-escape", () => legFollowEscape(browser, {
        ...shared, label: "follow-flick-escape", touch: true,
      })],
      ["read-only-top", () => legReadOnlyTop(browser, shared)],
      ["thread-switch", () => legThreadSwitch(browser, shared)],
    ];
    for (const [name, run] of legs) {
      if (!selected(name)) continue;
      try {
        results[name] = await run();
      } catch (error) {
        results[name] = `FAIL: ${error.message}`;
        failures.push(name);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await stopManagedProcess(relay);
    if (failures.length) dumpProcessLogs(relay);
  }
  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    throw new Error(`failed legs: ${failures.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
