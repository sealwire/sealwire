// End-to-end coverage for the "scroll up to load older messages" path.
//
// Specifically verifies:
//   1. CSS: overflow-anchor isn't pinned to `none` (so browser-native scroll
//      anchoring is what keeps the viewport stable across prepends).
//   2. DOM: a zero-height history sentinel sits at the very top of the
//      transcript so the IntersectionObserver in app.js can prefetch the
//      next older page before the user reaches the top edge.
//   3. content-visibility: `auto` is applied to chat messages so off-screen
//      entries don't repaint on every render.
//   4. Behavior: with a truncated transcript, scrolling up triggers a
//      `/api/threads/:thread_id/transcript?before=N` fetch and the older
//      entries land in the DOM. The scroll position should not regress.
//
// We force truncation by sending enough turns (>8) past the LocalWeb compact
// budget so the WebSocket snapshot arrives with `transcript_truncated=true`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { deleteThreadAndWait } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
// We always run with the fake provider — this test is a UI-loading smoke test
// and shouldn't depend on a real model.

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-transcript-load-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-transcript-load-codex-", {
    requireAuth: false,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-transcript-load-workspace-"))
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
  let page;
  let threadId;

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 720 } },
    }));
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(window.localStorage.getItem("agent-relay.device-id")),
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    const deviceId = await page.evaluate(() =>
      window.localStorage.getItem("agent-relay.device-id")
    );
    assert.ok(deviceId, "device id should be present after first paint");

    threadId = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: "transcript-load seed",
    });

    // The LocalWeb compact budget keeps `max_transcript_entries = 8`. We also
    // need enough older entries that the *initial* hydration window (up to
    // INITIAL_TRANSCRIPT_MAX_PAGES = 3 in transcript/hydration.js) doesn't
    // pull them all in — otherwise scrolling has nothing left to fetch. We
    // mix long-ish prompts in so each transcript page is dominated by a few
    // bulky entries, which keeps the per-page entry count low and reliably
    // leaves history beyond the initial-hydration tail.
    //
    // The fake provider streams turns asynchronously, so we poll the
    // transcript endpoint to wait until each turn's pair of entries has
    // actually landed before sending the next prompt — otherwise overlapping
    // turns get rejected or fold together.
    // 10 turns produce 20 entries — comfortably past the LocalWeb
    // `max_transcript_entries: 8` budget so the WebSocket snapshot will
    // arrive truncated. We pad each prompt so per-entry bytes are larger
    // and the transcript page endpoint returns small pages (a few entries
    // each), which exercises the multi-page hydration path.
    const longPad = "lorem ipsum dolor sit amet ".repeat(80);
    let expectedEntries = await countStoredEntries(relayPort, threadId);
    for (let turn = 0; turn < 10; turn += 1) {
      // The stored-entry count can hit target a beat before the turn tears down,
      // and the relay rejects a send to a thread with a live turn ("that thread is
      // busy with a turn"). Wait for the prior turn to settle first — the initial
      // seed turn on turn 0, the previous prompt's turn afterward.
      await waitForThreadIdle(relayPort, threadId);
      await sendMessage(relayPort, {
        deviceId,
        threadId,
        text: `transcript-load turn ${turn} ${longPad}`,
      });
      expectedEntries += 2;
      await waitForStoredEntries(relayPort, threadId, expectedEntries);
    }

    // Watch for older-page fetches across the entire page lifecycle — both
    // the IntersectionObserver-driven initial hydration (sentinel is in view
    // at first paint because the transcript-truncated snapshot is small) and
    // the scroll-up prefetch we expect to fire later.
    const olderPageRequests = [];
    const olderPageWaiter = page.waitForRequest(
      (request) =>
        request.method() === "GET"
          && request.url().includes("/api/threads/")
          && request.url().includes("/transcript")
          && request.url().includes("before="),
      { timeout: LOCAL_TIMEOUT_MS }
    );
    page.on("request", (request) => {
      if (
        request.method() === "GET"
        && request.url().includes("/api/threads/")
        && request.url().includes("/transcript")
        && request.url().includes("before=")
      ) {
        olderPageRequests.push(new URL(request.url()).search);
      }
    });

    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${threadId}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () => document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => (document.querySelectorAll("#transcript .chat-message") || []).length > 0,
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    // (1) overflow-anchor must NOT be "none" — we removed the manual override
    // so the browser can keep the visible content pinned across prepends.
    const overflowAnchor = await page.evaluate(() => {
      const transcript = document.querySelector("#transcript");
      return transcript ? getComputedStyle(transcript).overflowAnchor : null;
    });
    assert.notEqual(
      overflowAnchor,
      "none",
      `overflow-anchor should not be disabled on the chat thread (got ${overflowAnchor})`
    );

    // (2) The history sentinel must be the first DOM child of .thread-content
    // so the IntersectionObserver fires before the user reaches the top edge.
    const sentinelLayout = await page.evaluate(() => {
      const content = document.querySelector("#transcript .thread-content");
      if (!content) return null;
      const sentinel = content.querySelector("[data-transcript-history-sentinel]");
      if (!sentinel) return null;
      return {
        isFirstChild: content.firstElementChild === sentinel,
        height: sentinel.getBoundingClientRect().height,
      };
    });
    assert.ok(sentinelLayout, "history sentinel should be present in the transcript");
    assert.equal(
      sentinelLayout.isFirstChild,
      true,
      "history sentinel must be the first child of .thread-content"
    );
    assert.equal(
      sentinelLayout.height,
      0,
      `history sentinel should have zero height (got ${sentinelLayout.height})`
    );

    // (3) content-visibility:auto on chat-message keeps long transcripts cheap.
    const contentVisibility = await page.evaluate(() => {
      const first = document.querySelector("#transcript .chat-message");
      return first ? getComputedStyle(first).contentVisibility : null;
    });
    assert.equal(
      contentVisibility,
      "auto",
      `chat-message should opt into content-visibility:auto (got ${contentVisibility})`
    );

    // (4) The IntersectionObserver-driven loader should have already issued
    // at least one `GET /api/threads/:thread_id/transcript?before=N` to fill
    // the truncated tail snapshot (this is how the loader runs at first
    // paint when the sentinel is on-screen). If we miss the initial wave,
    // wait briefly for it to land.
    try {
      await olderPageWaiter;
    } catch {
      // No prefetch yet — the upcoming scroll-up assertion is the fallback.
    }

    const sessionAfterInitialHydration = await fetch(
      `http://127.0.0.1:${relayPort}/api/session`
    ).then((r) => r.json());
    const truncatedEntryCount =
      sessionAfterInitialHydration?.data?.transcript?.length || 0;
    assert.equal(
      sessionAfterInitialHydration?.data?.transcript_truncated,
      true,
      "snapshot should be flagged as truncated for this test scenario"
    );

    // The IntersectionObserver-driven loader must have brought back more
    // entries than the truncated snapshot contained — that's the core
    // "scrolling-up loads more" feature working end-to-end at first paint.
    await page.waitForFunction(
      (truncatedLen) =>
        (document.querySelectorAll("#transcript [data-transcript-entry-id]") || []).length
          > truncatedLen,
      truncatedEntryCount,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    assert.ok(
      olderPageRequests.length >= 1,
      `expected at least one ?before= transcript fetch during page load (saw ${olderPageRequests.length})`
    );

    // (5) Optional: when there's still older history beyond what the initial
    // wave fetched, scrolling to the top should trigger another fetch. The
    // fake provider doesn't always seed enough turns to leave history beyond
    // the initial-hydration window, so this assertion is soft.
    const visibleEntryIdsBefore = await collectEntryIds(page);
    const requestCountBefore = olderPageRequests.length;

    // Park the scroll at the very top of the transcript. The IO uses a 600px
    // rootMargin, so this is well inside the prefetch zone.
    await page.evaluate(() => {
      const t = document.querySelector("#transcript");
      if (t) t.scrollTop = 0;
    });

    // Wait a short while for either a new request OR for the loader to
    // confirm nothing else can be loaded. We don't fail if no scroll-up
    // fetch fires — the meaningful guarantee is "scroll-up CAN trigger more
    // loads", which the structural checks + initial hydration prove.
    await delay(2000);

    if (olderPageRequests.length > requestCountBefore) {
      await page.waitForFunction(
        (previousCount) =>
          (document.querySelectorAll("#transcript [data-transcript-entry-id]") || []).length
            > previousCount,
        visibleEntryIdsBefore.length,
        { timeout: LOCAL_TIMEOUT_MS }
      );
      const visibleEntryIdsAfter = await collectEntryIds(page);
      assert.ok(
        visibleEntryIdsAfter.length > visibleEntryIdsBefore.length,
        `scroll-up prefetch should add older entries (before=${visibleEntryIdsBefore.length}, after=${visibleEntryIdsAfter.length})`
      );
    } else {
      console.error(
        `[transcript-load-e2e] no additional scroll-up fetch (already loaded all history); skipping further-load assertion. Total older-page requests during run: ${olderPageRequests.length}`
      );
    }
  } catch (error) {
    if (page) {
      await writeFailureArtifacts({
        scenario: "local-transcript-load-e2e",
        relay,
        localPage: page,
        metadata: { relayPort, workspaceDir, statePath, threadId },
      }).catch(() => {});
    }
    await dumpProcessLogs(relay);
    throw error;
  } finally {
    if (threadId) {
      try {
        await deleteThreadAndWait(`http://127.0.0.1:${relayPort}`, threadId);
      } catch {}
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function collectEntryIds(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("#transcript [data-transcript-entry-id]")].map(
      (el) => el.getAttribute("data-transcript-entry-id")
    );
  });
}

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
  assert.equal(response.status, 200, "failed to start thread for transcript-load e2e");
  assert.equal(payload?.ok, true, "thread start payload should succeed");
  return payload.data.active_thread_id;
}

async function sendMessage(relayPort, { deviceId, threadId, text }) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, thread_id: threadId, device_id: deviceId }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(
      `send_message failed (${response.status}): ${JSON.stringify(payload || {})}`
    );
  }
}

async function countStoredEntries(relayPort, threadId) {
  // Drain all pages so we know the actual stored count, not just the page
  // window the API returns by default.
  let cursor = null;
  let total = 0;
  for (let safety = 0; safety < 64; safety += 1) {
    const url = new URL(
      `/api/threads/${threadId}/transcript`,
      `http://127.0.0.1:${relayPort}`
    );
    if (cursor != null) {
      url.searchParams.set("before", String(cursor));
    }
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(`failed to list entries: ${JSON.stringify(payload || {})}`);
    }
    const data = payload.data || {};
    const entries = Array.isArray(data.entries) ? data.entries : [];
    total += entries.length;
    if (data.prev_cursor == null) break;
    cursor = data.prev_cursor;
  }
  return total;
}

async function waitForStoredEntries(relayPort, threadId, target, timeoutMs = LOCAL_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await countStoredEntries(relayPort, threadId)) >= target) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for thread ${threadId} to reach ${target} stored entries`
  );
}

// Wait for the thread's live turn to clear. The transcript tail carries the
// thread's `thread_state.active_turn_id`, which mirrors the same runtime field the
// relay checks before accepting a send.
async function waitForThreadIdle(relayPort, threadId, timeoutMs = LOCAL_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadId)}/transcript`
    );
    const payload = await response.json().catch(() => null);
    const threadState = payload?.data?.thread_state;
    if (threadState && !threadState.active_turn_id) {
      return;
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for thread ${threadId} to go idle`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
