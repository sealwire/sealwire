// Regression: the transcript paints rows ON TOP of each other while this device
// is view-only — the state where another device holds the controller lease, the
// "Background session is running" banner is up and the composer is disabled.
//
// Rows are absolutely positioned by the virtualizer (`.transcript-virtual-row`,
// conversation.css), so a row whose measured height is smaller than what it
// actually paints does not push the next row down: it overlaps it. `innerText`
// stays perfect through that, which is why this asserts on rects only.
//
// Loaded twice on that same view-only path — clean, then with one send stored twice
// under one item id — so a failure names what made the difference rather than
// reporting a bare number.
//
// Run: npm run test:browser:view-only-transcript-overlap
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
// The thread under test is NOT the relay's active one: that is what puts it on the
// view-only projection (a pin fed by the transcript-page API) instead of the live
// snapshot window, and the live window happens to collapse duplicate ids in a Map.
const ACTIVE_THREAD_ID = "some-other-active-thread";
const THREAD_ID = "overlap-thread";
const OTHER_DEVICE = "the-device-that-holds-control";
// A real relay stamps this on both the snapshot and every page; the client refuses to
// mix runs, so a fixture that stamps only one side renders nothing at all.
const GENERATION = "e2e-generation";
// Past TRANSCRIPT_VIRTUALIZATION_THRESHOLD (20), so the absolutely-positioned
// virtual rows are the thing under test rather than the plain flex column.
const ENTRY_COUNT = 36;
// A row has to be tall enough that mis-measuring it overlaps something visible.
const LONG_USER_TEXT = [
  "你可以继续做第二批吗？我们除了这个reviewer 基线外，我还想加一种no op operation，",
  "比如我们review的不是changes，而是另外一个agent/用户claim，比如说subtask说要overall",
  "verification作为一个subtask，然后有一个round是review，那么reviewer也可以支持no op",
  "review。你觉得需要加吗？还是现在已经支持了？",
].join("\n");

function thread(id, name, status, updatedAt) {
  return {
    id,
    name,
    preview: `${name} preview`,
    cwd: ROOT,
    updated_at: updatedAt,
    source: "codex",
    status,
    model_provider: "codex",
    provider: "codex",
  };
}

// "clean"  — one row per send, the way a healthy relay serves it.
// "sameId" — the same item id twice. The relay no longer produces this, but a
//            transcript that already holds it must still lay out correctly.
function buildTranscript(mode) {
  const entries = [];
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const turnId = `turn-${Math.floor(index / 3)}`;
    if (index % 3 === 0) {
      entries.push({
        item_id: `user-${index}`,
        kind: "user_text",
        text: `${LONG_USER_TEXT}\n\n(#${index})`,
        status: "completed",
        turn_id: turnId,
        tool: null,
      });
      // Exactly the corruption a real relay served: ONE send stored twice under
      // one item_id, differing only in status. Kept in the fixture because a
      // transcript that already has it on disk still has to lay out correctly.
      if (mode === "sameId") {
        entries.splice(entries.length - 1, 0, {
          item_id: `user-${index}`,
          kind: "user_text",
          text: `${LONG_USER_TEXT}\n\n(#${index})`,
          status: "running",
          turn_id: turnId,
          tool: null,
        });
      }
    } else if (index % 3 === 1) {
      entries.push({
        item_id: `agent-${index}`,
        kind: "agent_text",
        text: `回答 #${index}。\n\n${LONG_USER_TEXT}`,
        status: "completed",
        turn_id: turnId,
        tool: null,
      });
    } else {
      entries.push({
        item_id: `reasoning-${index}`,
        kind: "reasoning",
        text: `思考 #${index}: ${LONG_USER_TEXT}`,
        status: "completed",
        turn_id: turnId,
        tool: null,
      });
    }
  }
  return entries;
}

function sessionPayload() {
  return {
    provider: "codex",
    provider_connected: true,
    transcript_generation: GENERATION,
    active_thread_id: ACTIVE_THREAD_ID,
    active_turn_id: "turn-live",
    // Another device holds the lease, so this one cannot write.
    active_controller_device_id: OTHER_DEVICE,
    current_cwd: ROOT,
    current_status: "working",
    // The production shape for a long session: the snapshot carries a compacted
    // tail and the window is filled from the transcript API.
    transcript_truncated: true,
    model: "gpt-5.5",
    reasoning_effort: "medium",
    approval_policy: "never",
    sandbox: "workspace-write",
    available_models: [
      {
        model: "gpt-5.5",
        display_name: "GPT-5.5",
        provider: "codex",
        supported_reasoning_efforts: ["medium", "high"],
        default_reasoning_effort: "medium",
        hidden: false,
        is_default: true,
      },
    ],
    transcript: [],
    pending_approvals: [],
  };
}

/** Overlap between absolutely-positioned rows, in CSS px, worst pair first. */
async function measureRowOverlaps(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".transcript-virtual-row")]
      .map((row) => ({ row, rect: row.getBoundingClientRect() }))
      .sort((a, b) => a.rect.top - b.rect.top);
    const overlaps = [];
    for (let index = 0; index < rows.length - 1; index += 1) {
      const current = rows[index];
      const next = rows[index + 1];
      // The row box is what the virtualizer positions; `scrollHeight` is what the
      // row actually needs. A row that needs more than its box has already spilled
      // onto whatever is painted below it.
      const painted = Math.max(current.rect.height, current.row.scrollHeight);
      const overlap = current.rect.top + painted - next.rect.top;
      if (overlap > 1) {
        overlaps.push({
          index: Number(current.row.dataset.index),
          nextIndex: Number(next.row.dataset.index),
          overlapPx: Math.round(overlap),
          boxHeight: Math.round(current.rect.height),
          neededHeight: current.row.scrollHeight,
        });
      }
    }
    // One rendered bubble per distinct send. Measured alongside the rects because a
    // duplicate can surface either way: colliding as a React key it OVERLAPS, but a
    // duplicate that lays out cleanly would pass a rect-only check while still
    // showing the reader the same message twice.
    const userTexts = [...document.querySelectorAll(".chat-message-user")].map(
      (row) => row.textContent || ""
    );
    return {
      rowCount: rows.length,
      renderedUserRows: userTexts.length,
      distinctUserRows: new Set(userTexts).size,
      overlaps: overlaps.sort((a, b) => b.overlapPx - a.overlapPx),
    };
  });
}

/**
 * Read the whole conversation the way a person does. Rows are only mis-measured
 * once they have LEFT the viewport, so a transcript that is only ever rendered at
 * rest never shows this — the reader has to have scrolled past them first.
 */
async function scrollThroughTranscript(page) {
  const passes = [
    { to: "top", steps: 14 },
    { to: "bottom", steps: 14 },
  ];
  for (const pass of passes) {
    for (let step = 0; step < pass.steps; step += 1) {
      await page.evaluate((direction) => {
        const scroller = document.querySelector(".chat-thread");
        if (!scroller) return;
        scroller.scrollTop += direction === "top" ? -scroller.clientHeight * 0.75 : scroller.clientHeight * 0.75;
      }, pass.to);
      // One frame per step, so the virtualizer and its ResizeObserver both run.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
    }
  }
}

async function loadTranscript(page, base, mode) {
  await page.route(/\/api\/session(\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    Object.assign(payload.data, sessionPayload());
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route(/\/api\/threads(\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data = {
      threads: [
        thread(THREAD_ID, "Background codex session", "active", 2),
        thread(ACTIVE_THREAD_ID, "The thread this relay is on", "idle", 1),
      ],
    };
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route(`**/api/threads/${THREAD_ID}/transcript**`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          thread_id: THREAD_ID,
          transcript_generation: GENERATION,
          prev_cursor: null,
          revision: 1,
          entries: buildTranscript(mode),
          thread_state: {
            thread_id: THREAD_ID,
            provider: "codex",
            current_cwd: ROOT,
            // Working, and owned by another device: that pair is what puts the
            // "Background session is running" banner up.
            current_status: "active",
            active_turn_id: "turn-live",
            current_phase: "thinking",
            current_tool: null,
            last_progress_at: null,
            model: "gpt-5.5",
            reasoning_effort: "medium",
            approval_policy: "never",
            sandbox: "workspace-write",
            available_models: [],
            review_locked: false,
            settings_writable: false,
          },
        },
      }),
    });
  });
  await page.route("**/api/stream**", (route) => route.abort());

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-thread-id="${THREAD_ID}"]`, { state: "attached" });
  await page.evaluate(() => {
    document.querySelector(".sidebar-drawer")?.setAttribute("open", "");
  });
  await page.click(`[data-thread-id="${THREAD_ID}"]`);
  await page.waitForFunction(
    (threadId) => new URL(window.location.href).searchParams.get("thread") === threadId,
    THREAD_ID
  );
  await page.waitForSelector(".transcript-virtual-row", { state: "attached" });
  await scrollThroughTranscript(page);
  // Rows are measured by a ResizeObserver after mount; sample once the count and
  // the total size have stopped moving, so this is not racing the first paint.
  await page.waitForFunction(() => {
    const spacer = document.querySelector(".transcript-virtual-spacer");
    if (!spacer) return false;
    const signature = `${document.querySelectorAll(".transcript-virtual-row").length}:${spacer.style.height}`;
    const settled = window.__overlapSignature === signature;
    window.__overlapSignature = signature;
    return settled;
  }, { polling: 250, timeout: 15000 });
}

async function main() {
  const port = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "view-only-overlap-"));
  const relay = startLocalRelay({
    relayPort: port,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  let context;
  let page;

  try {
    await waitForHealth(`${base}/api/health`);
    ({ browser, context } = await launchBrowser());
    const results = {};

    for (const mode of ["clean", "sameId"]) {
      page = await context.newPage();
      attachPageDebugLogging(page, "local", { prefix: "view-only-overlap-e2e" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await loadTranscript(page, base, mode);
      const banner = await page.evaluate(() => {
        const element = document.querySelector("#control-banner");
        return {
          hidden: element ? element.hidden : null,
          summary: document.querySelector("#control-summary")?.textContent || "",
          composerDisabled: document.querySelector("#message-input")?.disabled === true,
          composerPlaceholder: document.querySelector("#message-input")?.placeholder || "",
        };
      });
      results[mode] = {
        banner,
        ...(await measureRowOverlaps(page)),
      };
      await page.close();
      page = null;
    }

    console.log(JSON.stringify(results, null, 2));

    // The projection has to actually be the view-only one, or the overlap numbers
    // below are measuring the wrong screen.
    for (const [label, result] of Object.entries(results)) {
      if (result.banner.hidden !== false) {
        throw new Error(`${label}: the control banner never came up: ${JSON.stringify(result.banner)}`);
      }
      if (result.banner.summary !== "Background session is running") {
        throw new Error(`${label}: wrong banner copy: ${JSON.stringify(result.banner)}`);
      }
      if (result.banner.composerDisabled !== true) {
        throw new Error(`${label}: the composer stayed writable: ${JSON.stringify(result.banner)}`);
      }
      if (result.banner.composerPlaceholder !== "This session is currently running on another device.") {
        throw new Error(`${label}: wrong composer copy: ${JSON.stringify(result.banner)}`);
      }
      if (!result.rowCount) {
        throw new Error(`${label}: no virtualized rows were rendered`);
      }
      if (result.renderedUserRows !== result.distinctUserRows) {
        throw new Error(
          `${label}: ${result.renderedUserRows} user bubbles on screen for `
            + `${result.distinctUserRows} distinct sends — one send is showing twice`
        );
      }
      if (result.overlaps.length) {
        throw new Error(
          `${label}: transcript paints ${result.overlaps.length} overlapping row(s): `
            + JSON.stringify(result.overlaps.slice(0, 5))
        );
      }
    }

  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-view-only-transcript-overlap-e2e",
      relay,
      relayPort: port,
      localPage: page,
      metadata: { relayPort: port, threadId: THREAD_ID },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
