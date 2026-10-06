// Regression: seed a long tool-call-heavy local transcript, run six concurrent
// live fake sessions, then switch back and verify bottom-follow survives.
// Run: npm run build && node scripts/browser-local-multi-live-follow-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { importLegacySession } from "./e2e/harness/state-db.mjs";

const TIMEOUT_MS = 45000;
const THREAD_ID = "thread-toolcalls-repro";
const N_TURNS = 14; // user prompt + tool group + short agent text, x N
const TOOLS_PER_TURN = 12; // adjacent tool_calls -> one collapsed work chip
const LIVE_PROMPT = "stream fake tool calls";
const LIVE_TOOL_CALLS = 14;
const LIVE_BARRIER = "hold-live-tail";
const LIVE_SESSION_COUNT = 6;
const LOST_FOLLOW_DISTANCE_PX = 160;
// Force each 20KB transport tail to contain only a fraction of a tool-heavy
// turn. In the UI those raw entries collapse into one short work-group row,
// matching the saved-session blank-space regression.
const SEEDED_TOOL_PREVIEW = "seeded tool output ".repeat(70);

function livePrompt(index) {
  return index === 0 ? LIVE_PROMPT : `${LIVE_PROMPT} ${index + 1}`;
}

function liveBarrier(index) {
  return index === 0 ? LIVE_BARRIER : `${LIVE_BARRIER}-${index + 1}`;
}

function toolEntry(turn, i) {
  return {
    item_id: `tool-${turn}-${i}`,
    kind: "tool_call",
    text: null,
    status: "completed",
    turn_id: `turn-${turn}`,
    tool: {
      item_type: "command",
      name: "Bash",
      title: `ls -la path/number/${turn}/${i}`,
      detail: `ran command ${i} in turn ${turn}\n${SEEDED_TOOL_PREVIEW}`,
      query: null, path: null, url: null, command: `ls -la ${i}`,
      input_preview: `ls -la ${i}`, result_preview: `result ${i}\n${SEEDED_TOOL_PREVIEW}`,
      diff: null, file_changes: [],
    },
  };
}

function buildSeed() {
  const entries = [];
  for (let turn = 1; turn <= N_TURNS; turn += 1) {
    entries.push({
      item_id: `user-${turn}`, kind: "user_text",
      text: `设计 Project 组织结构和导航架构 (turn ${turn})`,
      status: "completed", turn_id: `turn-${turn}`, tool: null,
    });
    for (let i = 1; i <= TOOLS_PER_TURN; i += 1) entries.push(toolEntry(turn, i));
    entries.push({
      item_id: `agent-${turn}`, kind: "agent_text",
      text: `Done with turn ${turn}.`,
      status: "completed", turn_id: `turn-${turn}`, tool: null,
    });
  }
  return entries;
}

function measure() {
  const t = document.querySelector(".chat-thread");
  if (!t) return { error: "no .chat-thread" };
  const trect = t.getBoundingClientRect();
  const msgs = Array.from(t.querySelectorAll(".chat-message"));
  const rectOf = (m) => m.getBoundingClientRect();
  const visible = msgs.filter((m) => { const r = rectOf(m); return r.bottom > trect.top + 1 && r.top < trect.bottom - 1; });
  const lowestVisibleBottom = visible.length ? Math.max(...visible.map((m) => rectOf(m).bottom)) : trect.top;
  const toolGroups = t.querySelectorAll(".chat-message-work-group").length;
  return {
    scrollTop: Math.round(t.scrollTop),
    scrollHeight: Math.round(t.scrollHeight),
    clientHeight: t.clientHeight,
    distance: Math.round(Math.max(0, t.scrollHeight - t.clientHeight - t.scrollTop)),
    msgCount: msgs.length,
    visibleCount: visible.length,
    toolGroupsInDom: toolGroups,
    runningMessages: msgs.filter((m) => m.dataset.status === "running").length,
    threadRows: document.querySelectorAll("#threads-list [data-thread-id]").length,
    visiblyWorkingThreadRows: Array.from(
      document.querySelectorAll("#threads-list [data-thread-id]")
    ).filter((row) => /working|agenting/i.test(row.textContent || "")).length,
    blankBelowVisibleContent: Math.round(trect.bottom - lowestVisibleBottom),
    virtualized: Boolean(document.querySelector(".thread-content-virtualized")),
    viewLabel: document.querySelector("#workspace-subtitle")?.textContent || "",
    // Which thread is on screen. The route is the authority — the header subtitle
    // used to spell out "read-only · saved session" but no longer does.
    viewedThreadId: new URL(window.location.href).searchParams.get("thread") || "",
    lastVisibleText: visible.length ? (visible[visible.length - 1].textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) : null,
  };
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "seedtc-"));
  const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "seedtc-ws-")));
  const statePath = path.join(stateDir, "sealwire.db");
  const legacySessionPath = path.join(stateDir, "seed-session.json");
  const seedPath = path.join(stateDir, "seed.json");

  await fs.writeFile(legacySessionPath, JSON.stringify({
    schema_version: 2, active_thread_id: THREAD_ID, active_controller_device_id: null,
    active_controller_last_seen_at: null, current_status: "idle", active_flags: [],
    current_cwd: ws, model: "fake-echo", approval_policy: "never", sandbox: "workspace-write",
    reasoning_effort: "medium", allowed_roots: [ws], device_records: {}, paired_devices: {},
  }, null, 2));
  importLegacySession({ sessionPath: legacySessionPath, relayStateDb: statePath });
  await fs.writeFile(seedPath, JSON.stringify(buildSeed(), null, 2));
  const liveScenarios = Object.fromEntries(
    Array.from({ length: LIVE_SESSION_COUNT }, (_, index) => [
      livePrompt(index),
      {
        chunks: ["Live tool-call turn completed."],
        chunk_delay_ms: 20,
        tool_calls: LIVE_TOOL_CALLS,
        tool_call_delay_ms: 300,
        pause_after_chunks: 0,
        barrier: liveBarrier(index),
      },
    ])
  );
  const scenarioHarness = await createFakeProviderScenarioHarness(stateDir, {
    prompts: liveScenarios,
  });

  const relay = startLocalRelay({
    relayPort, relayStateDb: statePath,
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      FAKE_PROVIDER_SEED_PATH: seedPath,
      ...scenarioHarness.env,
    },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser, context, page;
  try {
    ({ browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 1280, height: 800 } } }));
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await delay(1500);
    const diag = await page.evaluate((id) => ({
      view: document.querySelector(".chat-shell")?.dataset.view || "(none)",
      openBtns: document.querySelectorAll("[data-open-thread-id]").length,
      thisBtn: Boolean(document.querySelector(`[data-open-thread-id="${id}"]`)),
      msgs: document.querySelectorAll(".chat-thread .chat-message").length,
      bodySnippet: (document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
    }), THREAD_ID);
    console.log("DIAG after load:", JSON.stringify(diag));
    if (diag.view !== "conversation") {
      // Open by thread id, not by label. This used to click "Continue latest",
      // a sidebar button that no longer exists, and fall back to
      // `text=Fake E2E Session` — which matches the sidebar row, the tab AND the
      // context menu, so it picked a hidden one and timed out on visibility.
      // `data-open-thread-id` is unique (the DIAG above asserts openBtns === 1).
      // The list lives in a <details> drawer, so make sure it is open first.
      await page.evaluate(() => {
        document.querySelector(".sidebar-drawer")?.setAttribute("open", "");
      });
      await page.click(`[data-open-thread-id="${THREAD_ID}"]`, { timeout: 8000 });
    }
    await page.waitForFunction(() => document.querySelector(".chat-shell")?.dataset.view === "conversation", null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".chat-thread .chat-message").length > 0, null, { timeout: TIMEOUT_MS });
    await delay(500);

    console.log(`\nseeded ${N_TURNS} turns x ${TOOLS_PER_TURN} tool calls. Opening...`);
    console.log("===== after opening the tool-heavy thread =====");
    console.log("  settled:", JSON.stringify(await page.evaluate(measure)));

    const messageInput = page.locator("#message-input");
    await messageInput.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await messageInput.fill(LIVE_PROMPT);
    await page.click("#send-button");

    const liveThreadIds = [THREAD_ID];
    const knownThreadIds = new Set(liveThreadIds);
    for (let index = 1; index < LIVE_SESSION_COUNT; index += 1) {
      await startLocalSession(page, {
        cwd: ws,
        approvalPolicy: "bypass",
        provider: "fake",
        model: "fake-echo",
        timeoutMs: TIMEOUT_MS,
      });
      const threadId = await waitForNewThread(page, knownThreadIds);
      liveThreadIds.push(threadId);
      knownThreadIds.add(threadId);
      await sendMessage(page, livePrompt(index));
    }
    await page.click(`#threads-list [data-thread-id="${THREAD_ID}"]`);
    await page.waitForFunction(
      (threadId) =>
        Boolean(document.querySelector(`#threads-list [data-thread-id="${threadId}"].is-active`)),
      THREAD_ID,
      { timeout: TIMEOUT_MS }
    );

    console.log(
      `\n===== viewing the seeded thread while ${LIVE_SESSION_COUNT} sessions stream =====`
    );
    console.log("  thread ids:", JSON.stringify(liveThreadIds));
    let maxLiveDistance = 0;
    let maxNextFrameDistance = 0;
    for (let sample = 1; sample <= 12; sample += 1) {
      await delay(250);
      const stats = await page.evaluate(measure);
      maxLiveDistance = Math.max(maxLiveDistance, stats.distance || 0);
      console.log(
        `  +${(sample * 0.25).toFixed(2)}s:`,
        JSON.stringify(stats)
      );
      // TanStack can expose its intermediate estimated geometry to JS between
      // a commit and the next animation frame. Give the follower that frame to
      // re-pin; the old bug remained thousands of pixels away indefinitely.
      if (stats.distance > LOST_FOLLOW_DISTANCE_PX) {
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
        );
        const nextFrameStats = await page.evaluate(measure);
        maxNextFrameDistance = Math.max(
          maxNextFrameDistance,
          nextFrameStats.distance || 0
        );
        console.log("    next frame:", JSON.stringify(nextFrameStats));
      }
    }

    await scenarioHarness.waitForBarrier(LIVE_BARRIER, TIMEOUT_MS);
    console.log("\n===== live turn held after tool calls, before assistant text =====");
    const heldStats = await page.evaluate(measure);
    console.log("  held:", JSON.stringify(heldStats));
    await delay(1500);
    const heldLaterStats = await page.evaluate(measure);
    console.log("  held +1.5s:", JSON.stringify(heldLaterStats));
    assert.ok(
      maxNextFrameDistance <= LOST_FOLLOW_DISTANCE_PX,
      `switching back remained ${maxNextFrameDistance}px from the tail after a paint frame (raw max ${maxLiveDistance}px)`
    );
    assert.ok(
      heldStats.distance <= 4 && heldLaterStats.distance <= 4,
      `the held live thread did not settle at the tail (${heldStats.distance}px then ${heldLaterStats.distance}px)`
    );
    assert.ok(
      heldLaterStats.scrollHeight - heldLaterStats.clientHeight > 160
        && heldLaterStats.blankBelowVisibleContent <= 160,
      `the read-only working refresh collapsed loaded history back to a short tail (${JSON.stringify(heldLaterStats)})`
    );
    // Self-check: this regression is only meaningful while the SAVED thread is on
    // screen and some OTHER thread is the live one — that pair is what "read-only
    // projection" means. This used to be a regex on the header subtitle, which was
    // a proxy for the same thing until that line was dropped from the header.
    // Asserting the state directly is stricter than asserting its old label.
    const liveThreadId = await page.evaluate(() =>
      fetch("/api/session")
        .then((r) => r.json())
        .then((r) => r.data?.active_thread_id || "")
        .catch(() => "")
    );
    assert.equal(
      heldLaterStats.viewedThreadId,
      THREAD_ID,
      "the regression must exercise the saved read-only projection"
    );
    assert.notEqual(
      liveThreadId,
      THREAD_ID,
      "the saved thread must not also be the live one, or nothing read-only is being exercised"
    );

    await scenarioHarness.releaseBarrier(LIVE_BARRIER);
    await page.waitForFunction(
      async () => (await (await fetch("/api/session")).json()).active_turn_id == null,
      null,
      { timeout: TIMEOUT_MS }
    );
    await delay(500);
    console.log("\n===== after live turn settles =====");
    const settledStats = await page.evaluate(measure);
    console.log("  settled:", JSON.stringify(settledStats));
    assert.ok(
      settledStats.distance <= 4,
      `the completed live thread ended ${settledStats.distance}px from the tail`
    );
    console.log(
      "\nPASS: switching among six live sessions retained bottom-follow without a reload."
    );
  } catch (e) {
    console.error("REPRO ERROR:", e?.stack || e);
    process.exitCode = 1;
  } finally {
    for (let index = 0; index < LIVE_SESSION_COUNT; index += 1) {
      await scenarioHarness.releaseBarrier(liveBarrier(index)).catch(() => {});
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendMessage(page, text) {
  const input = page.locator("#message-input");
  await input.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await page.waitForFunction(
    () => !document.querySelector("#message-input")?.disabled,
    null,
    { timeout: TIMEOUT_MS }
  );
  await input.fill(text);
  await page.click("#send-button");
}

async function waitForNewThread(page, knownThreadIds) {
  const known = [...knownThreadIds];
  const handle = await page.waitForFunction(
    (existingIds) =>
      Array.from(document.querySelectorAll("#threads-list [data-thread-id]")).find(
        (row) => !existingIds.includes(row.dataset.threadId)
      )?.dataset.threadId || null,
    known,
    { timeout: TIMEOUT_MS }
  );
  return handle.jsonValue();
}

main();
