// Regression: "Cursor 讲完不加载" — the history you scrolled up to read
// disappears while the thread you are watching finishes talking.
//
// The pane under test is the read-only projection: you are looking at thread B
// while the relay's active thread is A, so B renders from a "pin" fed by the
// transcript-page API. Scrolling up prepends older pages into that pin. Each time
// B looks like it stopped working, `shouldRefreshViewedThread` fires a terminal
// refresh that refetches the NEWEST page and merges it in — and the merge keeps
// the older prefix only while `historyExtended` is set. `refreshedPinPage`
// computed that flag and did not return it, so the pin stored `undefined`: the
// first refresh kept the prefix, the next one dropped it and rewound `olderCursor`
// to the tail page's. Fixed in 24026a24 / ac4f4b80.
//
// Why a real Cursor session rather than the fake provider: the edge this keys on
// is Cursor-shaped. `thread_activity` drops a Cursor thread that is still
// streaming (see resolveViewOnlyPinWasWorking in local/view-only-thread.js), so a
// single Cursor turn fires that refresh over and over — observed here at ~60/s
// while text arrives. That is why the reader loses their history in practice, and
// why one refresh is not enough to reproduce it.
//
// Hermetic. `CURSOR_CONFIG_DIR` is the first thing Cursor's path resolution
// consults, so the run is pointed at a temp directory holding throwaway clones of
// real sessions, each re-pointed at a temp cwd. The user's own sessions are never
// listed, resumed or prompted. It DOES spend one real Cursor turn on the clone —
// nothing else produces the edge.
//
// Run: npm run test:browser:cursor-view-only-history
// Row identity is `row_id`; `item_id` is the relay's compatibility alias carrying
// the same value (see frontend/shared/transcript-row-key.js). Reading the alias
// alone makes these assertions pass whatever the two do, so they guard nothing —
// prefer `row_id` for the same reason client code must.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { createArtifactWriter } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { openSessionsDrawer } from "./e2e/harness/drawer.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.CURSOR_VIEW_ONLY_E2E_TIMEOUT_MS || 60000);
// A whole Cursor turn, including `session/load` of a long history.
const TURN_TIMEOUT_MS = Number(process.env.CURSOR_VIEW_ONLY_TURN_TIMEOUT_MS || 300000);
const DEVICE_ID = "cursor-view-only-history-e2e";
// Fixed ids, so a run killed mid-flight leaves findable directories in the temp
// config rather than a growing pile of random ones.
const CLONE_ID_PREFIX = "e2e11570-0000-4000-8000-0000000000";
// Long enough to still be streaming while history is paged in, cheap enough to be
// one completion with no tool use.
const PROMPT =
  "Reply with the numbers 1 through 600, one per line, and nothing else. "
  + "Do not use any tools and do not read or write any files.";
// Only clone sessions in this band: below it there is no history to page, above it
// both the copy and the turn's context get expensive.
const MIN_STORE_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CLONE_CANDIDATES = 5;
// A clone needs this many transcript pages (its tail plus older ones) to be worth
// spending a turn on: fewer and there is no prefix to lose.
const MIN_PAGEABLE_PAGES = 3;
// Paging history in has to have made the pane this much longer, or losing it again
// would be within the noise of a row or two.
const MIN_PREFIX_ROWS = 5;
// The refresh has to have fired at least twice after the prefix landed: the first
// one loses the flag, the second is the one that drops the prefix.
const MIN_TERMINAL_REFRESHES = 2;
// ...and the pane has to have been observed at its top often enough afterwards for
// "the history is still there" to mean something.
const MIN_TOP_SAMPLES_AFTER = 10;

async function main() {
  const candidates = await rankClonableSessions(
    path.join(realCursorConfigDir(), "acp-sessions")
  );
  if (!candidates.length) {
    console.log(JSON.stringify({ ok: true, skipped: "no local Cursor ACP session to clone" }));
    return;
  }

  const cursorConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-vo-cfg-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-vo-state-"));
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-vo-ws-"))
  );
  const artifacts = createArtifactWriter("cursor-view-only-history-e2e");

  let relay;
  let browser;
  let context;
  let page;
  try {
    const clones = [];
    for (const [index, candidate] of candidates.entries()) {
      const id = `${CLONE_ID_PREFIX}${String(index + 1).padStart(2, "0")}`;
      await fs.cp(candidate.dir, path.join(cursorConfigDir, "acp-sessions", id), {
        recursive: true,
      });
      // Re-point the clone at a throwaway cwd. The source's cwd is a real
      // checkout, and the turn below runs an agent in whatever this names.
      await fs.writeFile(
        path.join(cursorConfigDir, "acp-sessions", id, "meta.json"),
        JSON.stringify({
          schemaVersion: 1,
          cwd: workspaceDir,
          title: `Relay view-only history e2e ${index + 1}`,
        })
      );
      clones.push({ id, source: candidate.id, storeBytes: candidate.storeBytes });
    }

    const relayPort = await getFreePort();
    relay = startLocalRelay({
      relayPort,
      relayStatePath: path.join(stateDir, "session.json"),
      extraEnv: {
        AGENT_PROVIDERS: "cursor,fake",
        CURSOR_CONFIG_DIR: cursorConfigDir,
        // `cursor-agent` installs to ~/.local/bin, which an npm script's
        // non-interactive shell does not always carry on PATH.
        PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH || ""}`,
      },
    });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`, TIMEOUT_MS);

    const providers = await getJson(relayPort, "/api/providers");
    if (!providers.data?.includes("cursor")) {
      console.log(JSON.stringify({ ok: true, skipped: "cursor provider is not available" }));
      return;
    }
    const cursorStatus = ((await getJson(relayPort, "/api/session")).data?.provider_status || [])
      .find((row) => row.provider === "cursor");
    if (!cursorStatus?.connected) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: `cursor is not connected (${cursorStatus?.status}); run \`cursor-agent login\``,
        })
      );
      return;
    }

    // The isolated config lists exactly the clones, which also proves
    // CURSOR_CONFIG_DIR is honoured — if it were not, the session about to be
    // prompted would be one of the user's own.
    assert.deepEqual(
      (await listCursorThreadIds(relayPort)).sort(),
      clones.map((clone) => clone.id).sort(),
      "the isolated config dir should expose exactly the clones"
    );

    // A clone is only usable if its transcript really pages. Take the smallest
    // that qualifies: the whole history is re-sent as context when the turn runs.
    let viewed = null;
    const probes = [];
    for (const clone of clones) {
      const probe = { ...clone, ...(await drainTranscript(relayPort, clone.id)) };
      probes.push(probe);
      if (!viewed && probe.pages >= MIN_PAGEABLE_PAGES && probe.oldestEntryId) {
        viewed = probe;
      }
    }
    console.log("clone probes:", JSON.stringify(probes, null, 2));
    if (!viewed) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped:
            `no clonable Cursor session has ${MIN_PAGEABLE_PAGES}+ transcript pages of history`,
          probes,
        })
      );
      return;
    }
    // The reference the whole test turns on, and it comes from the relay's own
    // storage rather than from the pane: once every older page has been scrolled
    // in, the transcript must start at the thread's oldest entry and stay there.
    const VIEWED = viewed.id;
    const OLDEST = viewed.oldestEntryId;

    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 900 } },
    }));
    page = await context.newPage();

    // Serve each older page ONCE. After the thread's history has been scrolled in
    // there is nothing legitimate left to fetch, so a repeat of a cursor already
    // served is the rewind this regression causes — and answering it would repair
    // the dropped prefix before it could be measured, turning the broken code
    // green. Aborting rather than answering with an empty page is deliberate:
    // `mergeOlderViewOnlyPage` sets `historyExtended` for ANY page it accepts.
    const servedCursors = new Set();
    const rewoundCursors = [];
    await page.route(
      (url) => url.pathname.endsWith("/transcript") && url.searchParams.has("before"),
      (route) => {
        const before = new URL(route.request().url()).searchParams.get("before");
        if (servedCursors.has(before)) {
          rewoundCursors.push(before);
          return route.abort();
        }
        servedCursors.add(before);
        return route.continue();
      }
    );

    // Every transcript fetch, split by which one it is: `?before=` is the
    // scroll-up loader, a bare one is the terminal refresh under test. The
    // refresh count is asserted on, so a run where it never fired fails loudly
    // instead of passing vacuously.
    const olderPageRequests = [];
    const tailRefreshRequests = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/threads/") || !url.pathname.endsWith("/transcript")) {
        return;
      }
      (url.searchParams.has("before") ? olderPageRequests : tailRefreshRequests).push({
        at: Date.now(),
        search: url.search,
      });
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelectorAll("#threads-list [data-thread-id]").length > 0,
      null,
      { timeout: TIMEOUT_MS }
    );

    // --- put the viewed thread to work, then take control away from it --------
    // Sending is what makes a Cursor thread work, and sending also takes over the
    // relay's active thread — so control has to be parked elsewhere straight
    // after, or the thread renders live instead of read-only.
    const sent = await postJson(relayPort, "/api/session/message", {
      text: PROMPT,
      thread_id: VIEWED,
      device_id: DEVICE_ID,
    });
    assert.equal(sent.ok, true, `sending to the cloned Cursor thread failed: ${sent.error?.message}`);
    const turnStartedAt = Date.now();

    const parked = await postJson(relayPort, "/api/session/start", {
      cwd: workspaceDir,
      device_id: DEVICE_ID,
      initial_prompt: "park control here",
      approval_policy: "never",
      sandbox: "workspace-write",
      effort: "medium",
      provider: "fake",
      model: "fake-echo",
    });
    assert.equal(
      parked.ok,
      true,
      `parking control on a throwaway thread failed: ${parked.error?.message}`
    );
    await waitFor(
      async () => (await sessionData(relayPort)).active_thread_id !== VIEWED,
      TIMEOUT_MS,
      "the relay never moved its active thread off the viewed Cursor thread"
    );

    // --- open it read-only ----------------------------------------------------
    await openSessionsDrawer(page, { timeoutMs: TIMEOUT_MS });
    await page.click(`#threads-list [data-thread-id="${VIEWED}"]`);
    await page.waitForFunction(
      (threadId) => new URL(window.location.href).searchParams.get("thread") === threadId,
      VIEWED,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#transcript [data-transcript-entry-id]").length > 0,
      null,
      { timeout: TIMEOUT_MS }
    );

    // A transcript opens at its bottom, so this is the tail page and nothing else
    // — the baseline the size assertion at the end is measured against.
    const tailOnly = withTotalRows(await page.evaluate(measure));
    const liveThreadId = (await sessionData(relayPort)).active_thread_id;
    console.log("tail page only:", JSON.stringify(tailOnly));
    // The precondition, in the only two facts that define it. Without BOTH there
    // is no read-only projection on screen and everything below is measuring an
    // ordinary live conversation. (The composer is not a signal: a view-only pane
    // still lets you type — sending is what takes control — so it is disabled
    // only while a turn runs.)
    assert.equal(tailOnly.viewedThreadId, VIEWED, "the cloned Cursor thread must be on screen");
    assert.notEqual(
      liveThreadId,
      VIEWED,
      "the viewed thread must not also be the relay's active thread, or the pane is not read-only"
    );

    // Watch the top of the transcript continuously from here on, because a
    // before/after pair does not catch this. On the pre-fix code the prefix was
    // gone 1.8s after it landed and came BACK before the run ended — racing
    // refreshes rebuild the pin from a `prior` that still has it — so both
    // settled measurements agreed and only the samples in between disagreed.
    await startTopSampler(page);

    // --- scroll up until older pages stop arriving ----------------------------
    for (
      let sweep = 0, seen = -1;
      sweep < 8 && seen !== servedCursors.size;
      sweep += 1
    ) {
      seen = servedCursors.size;
      await wheelBy(page, -1500, 8);
      await delay(600);
    }
    await screenshot(page, artifacts, "1-history-scrolled-in.png");
    const samplesAtPaging = await readSamples(page);
    const arrivedIndex = samplesAtPaging.findIndex((sample) => sample.topEntryId === OLDEST);
    console.log(
      "paged in:",
      JSON.stringify({
        cursorsServed: [...servedCursors],
        oldestEntryId: OLDEST,
        arrivedAtSample: arrivedIndex,
        samples: samplesAtPaging.length,
      })
    );
    assert.ok(
      arrivedIndex >= 0,
      `scrolling up never brought the thread's oldest entry (${OLDEST}) to the top of the `
        + `read-only transcript. ?before= pages served: ${[...servedCursors].join(", ") || "none"}`
    );

    // --- let the Cursor turn finish: working -> idle is the trigger -----------
    const arrivedAt = samplesAtPaging[arrivedIndex].t;
    await waitFor(
      async () => (await threadState(relayPort, VIEWED)).active_turn_id == null,
      TURN_TIMEOUT_MS,
      "the Cursor turn never finished"
    );
    console.log(`cursor turn finished after ${Math.round((Date.now() - turnStartedAt) / 1000)}s`);
    await delay(2000);

    const refreshesAfter = tailRefreshRequests.filter((entry) => entry.at >= arrivedAt).length;
    assert.ok(
      refreshesAfter >= MIN_TERMINAL_REFRESHES,
      `the read-only pane refreshed ${refreshesAfter} time(s) after the history landed; this `
        + `regression needs ${MIN_TERMINAL_REFRESHES} (the first loses the flag, the second drops `
        + "the prefix), so the run did not exercise it — most likely the Cursor turn was over "
        + "before the scrolling finished"
    );

    // --- the claim ------------------------------------------------------------
    const samples = await readSamples(page);
    const watched = samples.filter(
      (sample) => sample.t >= arrivedAt && sample.scrollTop <= 2 && sample.topOnScreen
    );
    const strayed = watched.filter((sample) => sample.topEntryId !== OLDEST);
    const afterRefreshes = watched.filter(
      (sample) => sample.t >= tailRefreshRequests[tailRefreshRequests.length - 1].at
    );
    await screenshot(page, artifacts, "2-after-turn-settled.png");
    console.log(
      "watched:",
      JSON.stringify({
        samples: samples.length,
        atTopSinceHistoryLanded: watched.length,
        afterTheLastRefresh: afterRefreshes.length,
        terminalRefreshesAfterHistoryLanded: refreshesAfter,
        rewoundCursorsRefused: rewoundCursors,
        distinctTopEntryIds: [...new Set(watched.map((sample) => sample.topEntryId))],
      })
    );

    assert.equal(
      strayed.length,
      0,
      "the read-only transcript stopped starting at the history that was scrolled in: "
        + `${strayed.length} of ${watched.length} samples showed `
        + `${JSON.stringify([...new Set(strayed.map((sample) => sample.topEntryId))])} at the top `
        + `instead of ${OLDEST}, first ${Math.round((strayed[0]?.t ?? 0) - arrivedAt)}ms after it `
        + `landed. Refused rewind fetches: ${JSON.stringify(rewoundCursors)}`
    );
    assert.ok(
      afterRefreshes.length >= MIN_TOP_SAMPLES_AFTER,
      `the pane was only observed at its top ${afterRefreshes.length} time(s) after the last `
        + "refresh, which is too few to call the history retained"
    );

    // And once more the way a reader would: scroll back up after everything has
    // settled. Weaker than the sampler above (the pre-fix run passed this), but
    // it is the state a person is actually left looking at.
    const settledTop = await measuredAtTop(page);
    const settledBottom = await measuredAtBottom(page);
    console.log("settled — top:", JSON.stringify(settledTop));
    console.log("settled — bottom:", JSON.stringify(settledBottom));
    assert.equal(
      settledTop.firstEntryId,
      OLDEST,
      "after the turn, scrolling back to the top no longer reaches the thread's oldest entry: "
        + `${settledTop.firstEntryId} instead of ${OLDEST}`
    );
    assert.ok(
      settledBottom.totalRows - tailOnly.totalRows >= MIN_PREFIX_ROWS,
      `the read-only transcript is back to ${settledBottom.totalRows} rows, barely more than the `
        + `${tailOnly.totalRows} it had before any history was scrolled in`
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          viewedThread: VIEWED,
          clonedFrom: viewed.source,
          oldestEntryId: OLDEST,
          olderPagesServed: servedCursors.size,
          terminalRefreshesAfterHistoryLanded: refreshesAfter,
          rows: { tailOnly: tailOnly.totalRows, settled: settledBottom.totalRows },
          artifacts: artifacts.dir,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (page) {
      await screenshot(page, artifacts, "failure.png");
    }
    // To a file, not the console: the relay logs one line per transcript delta,
    // and dumping them here buries the assertion that just failed.
    await artifacts.writeProcessLog("relay.log", relay).catch(() => {});
    console.error(`[cursor-view-only-history-e2e] artifacts: ${artifacts.dir}`);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(cursorConfigDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Record what is at the very top of the transcript, in the page, every 50ms.
// A sample only counts while the first row is genuinely on screen, which past the
// virtualization threshold means the virtualizer's own `data-index="0"` — its
// statement that this row IS the first of the list. Below the threshold every
// entry is mounted, so the transcript's first entry is simply its first child.
async function startTopSampler(page) {
  await page.evaluate(() => {
    window.__viewOnlyHistorySamples = [];
    window.__viewOnlyHistorySampler = setInterval(() => {
      const scroller = document.querySelector("#transcript");
      const content = scroller?.querySelector(".thread-content");
      if (!scroller || !content) {
        return;
      }
      const topRow = scroller.querySelector(".transcript-virtual-spacer")
        ? scroller.querySelector('.transcript-virtual-row[data-index="0"]')
        : content;
      window.__viewOnlyHistorySamples.push({
        t: Date.now(),
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        topOnScreen: Boolean(topRow),
        topEntryId:
          topRow?.querySelector("[data-transcript-entry-id]")?.getAttribute(
            "data-transcript-entry-id"
          ) || null,
      });
    }, 50);
  });
}

function readSamples(page) {
  return page.evaluate(() => window.__viewOnlyHistorySamples || []);
}

// Everything measured about the pane, from geometry and ids only. `innerText`
// would report entries the virtualizer never rendered and CSS never laid out, so
// it cannot answer "is the history still on screen".
function measure() {
  const scroller = document.querySelector("#transcript");
  if (!scroller) {
    return { error: "no #transcript" };
  }
  const indices = [...scroller.querySelectorAll(".transcript-virtual-row")]
    .map((row) => Number(row.dataset.index))
    .filter((index) => Number.isFinite(index));
  const entryIds = [...scroller.querySelectorAll("[data-transcript-entry-id]")].map((node) =>
    node.getAttribute("data-transcript-entry-id")
  );
  return {
    scrollTop: Math.round(scroller.scrollTop),
    scrollHeight: Math.round(scroller.scrollHeight),
    clientHeight: scroller.clientHeight,
    virtualized: Boolean(scroller.querySelector(".transcript-virtual-spacer")),
    minRowIndex: indices.length ? Math.min(...indices) : null,
    maxRowIndex: indices.length ? Math.max(...indices) : null,
    renderedEntryIds: entryIds.length,
    viewedThreadId: new URL(window.location.href).searchParams.get("thread") || "",
  };
}

// How long the transcript is. The virtualizer stamps every row it renders with
// that row's index into the full list, so the last one rendered at the bottom IS
// the last row; below the virtualization threshold every entry is in the DOM and
// can simply be counted.
function withTotalRows(stats) {
  return {
    ...stats,
    totalRows: stats.maxRowIndex == null ? stats.renderedEntryIds : stats.maxRowIndex + 1,
  };
}

// Scroll the way a reader does. `scrollTop = 0` does NOT work on this pane: the
// stick-to-bottom follower derives stickiness from scroll INTENT, so an assigned
// offset is re-pinned on the next frame — the sentinel never comes into view and
// no older page is ever requested. Measured: 12 assignments produced 0 fetches,
// the same gesture on the wheel produced 8.
async function wheelBy(page, deltaY, steps) {
  const box = await page.locator("#transcript").boundingBox();
  assert.ok(box, "the transcript must be on screen before it can be scrolled");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, deltaY);
    await delay(90);
  }
}

async function scrollToEdge(page, edge) {
  let previous = null;
  for (let sweep = 0; sweep < 12; sweep += 1) {
    await wheelBy(page, edge === "top" ? -1500 : 1500, 8);
    await delay(300);
    const { scrollTop } = await page.evaluate(measure);
    if (scrollTop === previous) {
      break;
    }
    previous = scrollTop;
  }
  await delay(400);
}

async function measuredAtTop(page) {
  await scrollToEdge(page, "top");
  const top = await page.evaluate(() => {
    const scroller = document.querySelector("#transcript");
    const topRow = scroller?.querySelector(".transcript-virtual-spacer")
      ? scroller.querySelector('.transcript-virtual-row[data-index="0"]')
      : scroller?.querySelector(".thread-content");
    return {
      firstEntryId:
        topRow?.querySelector("[data-transcript-entry-id]")?.getAttribute(
          "data-transcript-entry-id"
        ) || null,
    };
  });
  return { ...(await page.evaluate(measure)), ...top };
}

async function measuredAtBottom(page) {
  await scrollToEdge(page, "bottom");
  return withTotalRows(await page.evaluate(measure));
}

async function screenshot(page, artifacts, name) {
  try {
    await fs.mkdir(artifacts.dir, { recursive: true });
    await page.screenshot({ path: path.join(artifacts.dir, name), fullPage: false });
  } catch {}
}

async function sessionData(relayPort) {
  return (await getJson(relayPort, "/api/session")).data || {};
}

// The viewed thread's own liveness. `/api/session` reports the ACTIVE thread's
// turn, and `thread_activity` deliberately drops a streaming Cursor thread, so
// neither can say whether this one is still working.
async function threadState(relayPort, threadId) {
  return (await getJson(relayPort, `/api/threads/${threadId}/transcript`)).data?.thread_state || {};
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }
  throw new Error(message);
}

// How much history a thread has, in the transport pages the pane scrolls through,
// and which entry sits at the very start of it. Pages are byte-budgeted, so an
// entry count says nothing about how many scroll-ups it takes to reach the top.
async function drainTranscript(relayPort, threadId, maxPages = 24) {
  let cursor = null;
  let pages = 0;
  let entries = 0;
  let oldestEntryId = null;
  while (pages < maxPages) {
    const query = cursor == null ? "" : `?before=${encodeURIComponent(cursor)}`;
    const data =
      (await getJson(relayPort, `/api/threads/${threadId}/transcript${query}`)).data || {};
    const page = data.entries || [];
    entries += page.length;
    pages += 1;
    if (page.length) {
      oldestEntryId = page[0].row_id ?? page[0].item_id ?? null;
    }
    if (data.prev_cursor == null) {
      return { pages, entries, oldestEntryId, exhausted: true };
    }
    cursor = data.prev_cursor;
  }
  return { pages, entries, oldestEntryId, exhausted: false };
}

async function listCursorThreadIds(relayPort) {
  return ((await getJson(relayPort, "/api/threads")).data?.threads || [])
    .filter((thread) => thread.provider === "cursor")
    .map((thread) => thread.id);
}

function realCursorConfigDir() {
  const explicit = process.env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "cursor") : path.join(os.homedir(), ".cursor");
}

// Clonable the way `session/list` means it: a `meta.json` carrying a title and a
// cwd, plus a `store.db`. Smallest first — the smallest store that still pages is
// the cheapest turn to spend.
async function rankClonableSessions(sessionsDir) {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(CLONE_ID_PREFIX)) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    const store = await fs.stat(path.join(dir, "store.db")).catch(() => null);
    if (!store || store.size < MIN_STORE_BYTES || store.size > MAX_STORE_BYTES) {
      continue;
    }
    const meta = await fs
      .readFile(path.join(dir, "meta.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (meta?.cwd && meta?.title) {
      found.push({ id: entry.name, dir, storeBytes: store.size });
    }
  }
  found.sort((a, b) => a.storeBytes - b.storeBytes);
  return found.slice(0, MAX_CLONE_CANDIDATES);
}

async function getJson(relayPort, pathName) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    headers: { "X-Agent-Relay-CSRF": "1" },
  });
  return response.json();
}

async function postJson(relayPort, pathName, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: JSON.stringify(body),
  });
  return response.json();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
