// Browser e2e for the hybrid stick-to-bottom live-follow.
//
// Streams a slow fake-provider turn (~10s) and asserts, inside ONE live turn:
//   A. send-anchor releases the follow: viewport stays put while content grows
//   B. scrolling to the bottom re-joins: viewport follows the growing bottom
//   C. scrolling up releases again: viewport stays put while content grows
//   D. re-join then let the turn END: spacer collapse must land us at the true
//      bottom without an upward yank.
// Run on desktop (.chat-thread scrolls) and phone (window scrolls).
//
// Run: npm run build && AGENT_PROVIDERS=fake node scripts/browser-stick-to-bottom-e2e.mjs
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
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = 45000;
const STREAM_PROMPT = "stream-live";

const LONG_PROMPT = Array.from(
  { length: 24 },
  (_, i) =>
    `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog while the `
    + `stick-to-bottom follower decides whether to chase the stream.`
).join("\n\n");

// NOTE: the LocalWeb snapshot budget caps a live entry's text at 1600 chars
// (protocol.rs max_transcript_chars) — past that, the streamed text freezes
// until the turn completes. Keep the whole reply under the cap so the live
// window covers all phases: 32 chunks x ~46 chars ≈ 1500 chars over ~9s.
const STREAM_CHUNKS = Array.from(
  { length: 32 },
  (_, i) => `Chunk ${String(i + 1).padStart(2, "0")} keeps the live stream going.\n\n`
);

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

// In-page metric read that works for both scrollers (mirrors readScrollMetrics).
function readMetricsInPage() {
  const t = document.querySelector(".chat-thread");
  const overflows = t && t.scrollHeight > t.clientHeight + 1;
  const doc = document.scrollingElement || document.documentElement;
  const metrics = overflows
    ? { scrollTop: t.scrollTop, clientHeight: t.clientHeight, scrollHeight: t.scrollHeight }
    : { scrollTop: window.scrollY, clientHeight: window.innerHeight, scrollHeight: doc.scrollHeight };
  return {
    scroller: overflows ? "chat-thread" : "window",
    ...metrics,
    distance: Math.max(
      0,
      metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop
    ),
  };
}

function scrollActiveToBottomInPage() {
  const t = document.querySelector(".chat-thread");
  const overflows = t && t.scrollHeight > t.clientHeight + 1;
  // Rejoin after a send-anchor is gesture-gated (virtualizer measurement
  // corrections must not re-enable following), so simulate the wheel gesture
  // a real reader produces on their way down before applying the scroll.
  t?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 240 }));
  if (overflows) {
    t.scrollTop = t.scrollHeight;
  } else {
    const doc = document.scrollingElement || document.documentElement;
    window.scrollTo(0, doc.scrollHeight);
  }
}

function scrollActiveUpInPage(px) {
  const t = document.querySelector(".chat-thread");
  const overflows = t && t.scrollHeight > t.clientHeight + 1;
  // An UPWARD wheel must not release the rejoin hold (only downward-intent
  // gestures do) — dispatch it so phase C also guards that gating.
  t?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
  if (overflows) {
    t.scrollTop = Math.max(0, t.scrollTop - px);
  } else {
    window.scrollTo(0, Math.max(0, window.scrollY - px));
  }
}

// Length of the streaming reply's DOM text. Grows for every chunk even when
// the row is off-screen and `content-visibility: auto` freezes its layout
// height (which freezes scrollHeight) — so this, not scrollHeight, is the
// "is the stream still alive" signal.
function readStreamTextLenInPage() {
  const messages = document.querySelectorAll(".chat-thread .chat-message-assistant");
  const last = messages[messages.length - 1];
  return last ? (last.textContent || "").length : 0;
}

async function sample(page, count, everyMs) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const metrics = await page.evaluate(readMetricsInPage);
    metrics.streamTextLen = await page.evaluate(readStreamTextLenInPage);
    out.push(metrics);
    await delay(everyMs);
  }
  return out;
}

function spread(samples, key) {
  const values = samples.map((s) => s[key]);
  return Math.max(...values) - Math.min(...values);
}

async function exercise(page, label, { anchorSpreadTolerance = 2 } = {}) {
  // Wait for the seeded conversation + settled first turn.
  await page.waitForFunction(
    () => document.querySelectorAll(".chat-thread .chat-message").length > 0,
    null,
    { timeout: TIMEOUT_MS }
  );
  await page.waitForFunction(
    () => {
      const stop = document.querySelector(".stop-button");
      return !stop || stop.hasAttribute("hidden") || stop.offsetParent === null;
    },
    null,
    { timeout: TIMEOUT_MS }
  );
  await delay(600);

  // Sit at the bottom like a reader who just caught up.
  await page.evaluate(scrollActiveToBottomInPage);
  await delay(300);

  // Send the slow-streaming prompt through the real composer.
  const preLastAssistantText = await page.evaluate(() => {
    const replies = document.querySelectorAll(".chat-thread .chat-message-assistant");
    return replies[replies.length - 1]?.textContent || "";
  });
  await page.fill("#message-input", STREAM_PROMPT);
  await page.click("#send-button");

  // Wait for the NEW streaming reply (not just height growth from the user
  // message + spacer): the text-length metric must track the same entry across
  // all phases, or a leftover previous reply skews it. Compared by content,
  // not node count — the virtualizer's rendered-row count is not monotonic.
  await page.waitForFunction(
    (pre) => {
      const replies = document.querySelectorAll(".chat-thread .chat-message-assistant");
      const text = replies[replies.length - 1]?.textContent || "";
      return text !== pre && text.length > 40;
    },
    preLastAssistantText,
    { timeout: TIMEOUT_MS }
  );
  await delay(200);

  // ---- Phase A: send-anchor released the follow -> viewport must not move.
  const phaseA = await sample(page, 8, 150);
  const anchorInfo = await page.evaluate(() => {
    const msg = document.querySelector('[data-latest-user-message="true"]');
    const rect = msg?.getBoundingClientRect();
    return rect ? Math.round(rect.top) : null;
  });
  console.log(`[${label}] A anchored-msg viewport top: ${anchorInfo}px;`,
    `scrollTop spread ${spread(phaseA, "scrollTop")},`,
    `text growth ${phaseA.at(-1).streamTextLen - phaseA[0].streamTextLen}`);
  assert.ok(
    phaseA.at(-1).streamTextLen - phaseA[0].streamTextLen > 80,
    `${label} A: stream should be growing (${phaseA[0].streamTextLen} -> ${phaseA.at(-1).streamTextLen})`
  );
  assert.ok(
    spread(phaseA, "scrollTop") <= anchorSpreadTolerance,
    `${label} A: after send-anchor the viewport must NOT follow the stream `
    + `(scrollTop samples: ${phaseA.map((s) => s.scrollTop).join(", ")})`
  );

  // ---- Phase B: deliberately scroll to the bottom -> follow resumes.
  await page.evaluate(scrollActiveToBottomInPage);
  await delay(150);
  const phaseB = await sample(page, 10, 150);
  console.log(`[${label}] B distances: ${phaseB.map((s) => Math.round(s.distance)).join(", ")};`,
    `height growth ${phaseB.at(-1).scrollHeight - phaseB[0].scrollHeight}`);
  assert.ok(
    phaseB.at(-1).scrollHeight - phaseB[0].scrollHeight > 80,
    `${label} B: stream should still be growing`
  );
  for (let i = 1; i < phaseB.length; i += 1) {
    assert.ok(
      phaseB[i].scrollTop >= phaseB[i - 1].scrollTop - 8,
      `${label} B: following must never yank upward `
      + `(${phaseB[i - 1].scrollTop} -> ${phaseB[i].scrollTop})`
    );
  }
  assert.ok(
    phaseB.at(-1).distance <= 60,
    `${label} B: after re-joining, the viewport must track the bottom `
    + `(final distance ${phaseB.at(-1).distance})`
  );
  assert.ok(
    phaseB.at(-1).scrollTop > phaseA.at(-1).scrollTop + 60,
    `${label} B: the viewport should have moved down with the stream`
  );

  // ---- Phase C: scroll up mid-stream -> follow releases immediately.
  await page.evaluate(scrollActiveUpInPage, 500);
  await delay(150);
  const phaseC = await sample(page, 8, 150);
  console.log(`[${label}] C scrollTop spread ${spread(phaseC, "scrollTop")};`,
    `text growth ${phaseC.at(-1).streamTextLen - phaseC[0].streamTextLen}`);
  assert.ok(
    phaseC.at(-1).streamTextLen - phaseC[0].streamTextLen > 80,
    `${label} C: stream should still be growing`
  );
  assert.ok(
    spread(phaseC, "scrollTop") <= anchorSpreadTolerance,
    `${label} C: scrolling up must release the follow — the stream must not `
    + `drag the reader (scrollTop samples: ${phaseC.map((s) => s.scrollTop).join(", ")})`
  );

  // ---- Phase D: re-join, then let the turn end (spacer collapse + clamp).
  await page.evaluate(scrollActiveToBottomInPage);
  await page.waitForFunction(
    () => {
      const stop = document.querySelector(".stop-button");
      return !stop || stop.hasAttribute("hidden") || stop.offsetParent === null;
    },
    null,
    { timeout: TIMEOUT_MS }
  );
  await delay(800);
  const final = await page.evaluate(readMetricsInPage);
  console.log(`[${label}] D final distance ${Math.round(final.distance)} (${final.scroller})`);
  assert.ok(
    final.distance <= 60,
    `${label} D: turn end must land at the true bottom (distance ${final.distance})`
  );

  return { anchorViewportTop: anchorInfo, final };
}

// Findings coverage (reviewer 019f89a4): the FIRST prompt into an EMPTY thread
// must behave like every later send — anchor the message, do NOT follow the
// stream. Regression shape: the empty render records no scroll snapshot, so the
// first entries classify as "first view" -> jump-bottom -> sticky; and/or the
// follower's listener attaches too late to hear the anchor-user broadcast.
async function exerciseEmptyFirstSend(page, label, workspaceDir) {
  await page.click("#open-start-session-dialog");
  await page.waitForFunction(
    () => document.querySelector("#launch-start-session-dialog")?.open,
    null,
    { timeout: TIMEOUT_MS }
  );
  await page.fill("#cwd-input", workspaceDir);
  await page.selectOption("#provider-input", "fake");
  await page.selectOption("#approval-policy-input", "never");
  await page.click("#start-session-button");
  await page.waitForFunction(
    () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
    null,
    { timeout: TIMEOUT_MS }
  );

  // First-ever send into the empty thread.
  const preLastAssistantText = "";
  await page.fill("#message-input", STREAM_PROMPT);
  await page.click("#send-button");
  // Wait for the NEW streaming reply (not just height growth from the user
  // message + spacer): the text-length metric must track the same entry across
  // all phases, or a leftover previous reply skews it. Compared by content,
  // not node count — the virtualizer's rendered-row count is not monotonic.
  await page.waitForFunction(
    (pre) => {
      const replies = document.querySelectorAll(".chat-thread .chat-message-assistant");
      const text = replies[replies.length - 1]?.textContent || "";
      return text !== pre && text.length > 40;
    },
    preLastAssistantText,
    { timeout: TIMEOUT_MS }
  );
  await delay(200);
  const samples = await sample(page, 8, 150);
  console.log(`[${label}] first-send scrollTop spread ${spread(samples, "scrollTop")},`,
    `text growth ${samples.at(-1).streamTextLen - samples[0].streamTextLen}`);
  assert.ok(
    samples.at(-1).streamTextLen - samples[0].streamTextLen > 80,
    `${label}: stream should be growing`
  );
  assert.ok(
    spread(samples, "scrollTop") <= 2,
    `${label}: the FIRST send must anchor and not follow the stream `
    + `(scrollTop samples: ${samples.map((s) => s.scrollTop).join(", ")})`
  );

  // With the rejoin hold still armed (no gesture so far), keyboard-activate
  // the scroll-to-latest button: its click must broadcast explicit
  // "rejoin-bottom" intent (covers assistive tech) and resume live following.
  await page.waitForFunction(
    () => document.querySelector(".scroll-to-bottom")?.getAttribute("data-visible") === "true",
    null,
    { timeout: TIMEOUT_MS }
  );
  await page.focus(".scroll-to-bottom-button");
  await page.keyboard.press("Enter");
  await delay(600);
  const rejoined = await sample(page, 6, 150);
  console.log(`[${label}] post-button distances: ${rejoined.map((s) => Math.round(s.distance)).join(", ")}`);
  assert.ok(
    rejoined.at(-1).distance <= 60,
    `${label}: keyboard-activating scroll-to-latest must resume following `
    + `(final distance ${rejoined.at(-1).distance})`
  );

  // Let the turn finish so the session can be torn down cleanly.
  await page.waitForFunction(
    () => {
      const stop = document.querySelector(".stop-button");
      return !stop || stop.hasAttribute("hidden") || stop.offsetParent === null;
    },
    null,
    { timeout: TIMEOUT_MS }
  );
  return page.evaluate(async () =>
    (await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()))
      ?.data?.active_thread_id || null);
}

// Grow the thread past the 20-row virtualization threshold with quick echo
// turns, so the streaming phases also run against the TanStack virtualizer
// (whose multi-frame measurement corrections must not re-enable following).
async function growUntilVirtualized(page) {
  // Build enough history that a tall-viewport reload hydrates 20+ rows (the
  // virtualization threshold). Quick echo turns; the class check is done by
  // the caller after the reload.
  for (let i = 0; i < 12; i += 1) {
    await page.fill("#message-input", `filler ${i + 1}`);
    await page.click("#send-button");
    await page.waitForFunction(
      () => {
        const stop = document.querySelector(".stop-button");
        return !stop || stop.hasAttribute("hidden") || stop.offsetParent === null;
      },
      null,
      { timeout: TIMEOUT_MS }
    );
    await delay(120);
  }
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "stick-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("stick-e2e-codex-", { requireAuth: false });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "stick-e2e-workspace-"))
  );
  const scenario = await createFakeProviderScenarioHarness(stateDir, {
    prompts: {
      [STREAM_PROMPT]: {
        chunks: STREAM_CHUNKS,
        chunk_delay_ms: 280,
      },
    },
  });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: { AGENT_PROVIDERS: "fake", ...scenario.env },
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

    // Empty thread, first-ever send (reviewer findings 1+2).
    let fresh = await context.newPage();
    attachPageDebugLogging(fresh, "empty-first-send", { prefix: "stick-e2e" });
    await fresh.setViewportSize({ width: 1280, height: 680 });
    await fresh.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const freshThread = await exerciseEmptyFirstSend(fresh, "empty-first-send", workspaceDir);
    if (freshThread) threadIds.push(freshThread);
    await fresh.close();
    fresh = null;
    results.emptyFirstSend = "pass";

    // Desktop: `.chat-thread` is the scroller.
    const desktopThread = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: LONG_PROMPT,
    });
    threadIds.push(desktopThread);
    desktop = await context.newPage();
    attachPageDebugLogging(desktop, "desktop", { prefix: "stick-e2e" });
    await desktop.setViewportSize({ width: 1280, height: 680 });
    await desktop.goto(`http://127.0.0.1:${relayPort}/?thread=${desktopThread}`, {
      waitUntil: "domcontentloaded",
    });
    await desktop.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    results.desktop = await exercise(desktop, "desktop");

    // Same thread past the virtualization threshold: TanStack's measurement
    // corrections must not undo the send-anchor (finding 3). Local hydration
    // only fills viewport+600px worth of history, so a taller viewport is what
    // pulls enough rows into the DOM for the virtualizer to engage.
    await growUntilVirtualized(desktop);
    await desktop.setViewportSize({ width: 1280, height: 1400 });
    await desktop.reload({ waitUntil: "domcontentloaded" });
    await desktop.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    await desktop.waitForFunction(
      () => Boolean(document.querySelector(".thread-content-virtualized")),
      null,
      { timeout: TIMEOUT_MS }
    );
    results.desktopVirtualized = await exercise(desktop, "desktop-virtualized", {
      anchorSpreadTolerance: 8,
    });
    await desktop.close();
    desktop = null;

    // Phone: the window is the scroller.
    const phoneThread = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: LONG_PROMPT,
    });
    threadIds.push(phoneThread);
    phone = await context.newPage();
    attachPageDebugLogging(phone, "phone", { prefix: "stick-e2e" });
    await phone.setViewportSize({ width: 390, height: 740 });
    await phone.goto(`http://127.0.0.1:${relayPort}/?thread=${phoneThread}`, {
      waitUntil: "domcontentloaded",
    });
    await phone.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    results.phone = await exercise(phone, "phone");
    await phone.close();
    phone = null;

    console.log("\nPASS", JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error);
    await writeFailureArtifacts({
      scenario: "stick-to-bottom-e2e",
      relay,
      relayPort,
      localPage: desktop || phone,
      extraPages: [],
      metadata: { relayPort, workspaceDir, threadIds },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed: ${artifactError.message}`);
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
