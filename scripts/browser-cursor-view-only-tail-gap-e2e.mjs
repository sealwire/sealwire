// Regression: "Cursor finishes talking, never loads" — the read-only pane never
// settles once the turn is over.
//
// A delta the pin's reducer REFUSES raises `tailGap`, meaning "there is a hole at
// the newest end", and a repair fetch is what fills it. Nothing throttles that
// path: `shouldRefreshViewedThread` answers `needsRepair` before it looks at
// anything else, and the 300ms poll that used to pace it is gone. So a gap that a
// settled fetch does not CLEAR arms another fetch on the settle's own re-render,
// forever. `loadViewOnlyTranscript` used to carry the gap forward unconditionally
// (`livePin?.tailGap ? {...built, tailGap: true} : built`) on both the success and
// the error branch; 3e53a2ae made it conditional on `deltaDuringFetch`, so only a
// gap raised while THIS fetch was in flight survives it.
//
// Why the refusal happens for real here: `mergeRefreshedViewOnlyPage` treats the
// fetched page as authoritative inside its window, so a refresh that lands while
// Cursor streams replaces the pin's live text with the server's shorter copy —
// and the next delta's `text_offset` is then past what the pin holds, which is
// exactly the refusal. A read-only Cursor thread refreshes many times a second
// (`thread_activity` drops a streaming Cursor thread, so the working→idle edge
// fires over and over), so this race runs hundreds of times per turn.
//
// What it proves, after the turn is over: the newest entry the RELAY holds is the
// newest entry on screen, and the pane stops refetching. Both matter — a loop that
// never converges is invisible in a single settled screenshot.
//
// Hermetic. `CURSOR_CONFIG_DIR` is the first thing Cursor's path resolution
// consults, so the run is pointed at a temp directory holding throwaway clones of
// real sessions, each re-pointed at a temp cwd. The user's own sessions are never
// listed, resumed or prompted. It DOES spend one real Cursor turn on the clone —
// the refusal is a race against a live stream and nothing else produces it.
//
// Run: npm run test:browser:cursor-view-only-tail-gap
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

const TIMEOUT_MS = Number(process.env.CURSOR_TAIL_GAP_E2E_TIMEOUT_MS || 60000);
// A whole Cursor turn, including `session/load` of a long history.
const TURN_TIMEOUT_MS = Number(process.env.CURSOR_TAIL_GAP_TURN_TIMEOUT_MS || 300000);
const DEVICE_ID = "cursor-view-only-tail-gap-e2e";
// Fixed ids, so a run killed mid-flight leaves findable directories in the temp
// config rather than a growing pile of random ones.
const CLONE_ID_PREFIX = "e2e3e53a-0000-4000-8000-0000000000";
// Long enough that refreshes race the stream for many seconds, cheap enough to be
// one completion with no tool use.
const PROMPT =
  "Reply with the numbers 1 through 400, one per line, and nothing else. "
  + "Do not use any tools and do not read or write any files.";
// Big enough to have a real transcript, small enough that the turn's context is
// cheap; the clone's whole history is re-sent when the turn runs.
const MIN_STORE_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CLONE_CANDIDATES = 3;
// After the relay says the turn is over, the pane is allowed this long to run the
// repairs that are supposed to converge.
const SETTLE_MS = Number(process.env.CURSOR_TAIL_GAP_SETTLE_MS || 6000);
// ...and then nothing legitimate refetches this thread's tail for this long.
const QUIET_MS = Number(process.env.CURSOR_TAIL_GAP_QUIET_MS || 10000);
// A converged pane refetches nothing in the quiet window. The slack is for a late
// session frame, not for a loop — an unthrottled repair produces one fetch per
// render, i.e. hundreds.
const MAX_QUIET_REFETCHES = 2;
// The refresh path has to have actually run during the turn, or a quiet window
// afterwards proves nothing at all.
const MIN_REFETCHES_DURING_TURN = 10;
// The tail claim is sampled over time, so it needs enough samples with the bottom
// of the list genuinely on screen to mean anything.
const MIN_BOTTOM_SAMPLES = 12;

async function main() {
  const candidates = await rankClonableSessions(
    path.join(realCursorConfigDir(), "acp-sessions")
  );
  if (!candidates.length) {
    console.log(JSON.stringify({ ok: true, skipped: "no local Cursor ACP session to clone" }));
    return;
  }

  const cursorConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-gap-cfg-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-gap-state-"));
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-gap-ws-"))
  );
  const artifacts = createArtifactWriter("cursor-view-only-tail-gap-e2e");

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
          title: `Relay view-only tail-gap e2e ${index + 1}`,
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

    let viewed = null;
    const probes = [];
    for (const clone of clones) {
      const probe = { ...clone, ...(await tailOfTranscript(relayPort, clone.id)) };
      probes.push(probe);
      if (!viewed && probe.entries > 0) {
        viewed = probe;
      }
    }
    console.log("clone probes:", JSON.stringify(probes, null, 2));
    if (!viewed) {
      console.log(
        JSON.stringify({ ok: true, skipped: "no clonable Cursor session has a transcript", probes })
      );
      return;
    }
    const VIEWED = viewed.id;

    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 900 } },
    }));
    page = await context.newPage();

    // Every transcript fetch for the viewed thread, split by which one it is:
    // `?before=` is the scroll-up loader, a bare one is the tail refresh — and
    // after the turn ends, a bare one can only be a tailGap repair.
    const tailFetches = [];
    const olderFetches = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname !== `/api/threads/${VIEWED}/transcript`) {
        return;
      }
      (url.searchParams.has("before") ? olderFetches : tailFetches).push(Date.now());
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
    const openedAt = Date.now();

    const liveThreadId = (await sessionData(relayPort)).active_thread_id;
    const opened = await page.evaluate(measure);
    console.log("opened read-only:", JSON.stringify(opened));
    // The precondition, in the only two facts that define it. Without BOTH there
    // is no read-only projection on screen and everything below is measuring an
    // ordinary live conversation.
    assert.equal(opened.viewedThreadId, VIEWED, "the cloned Cursor thread must be on screen");
    assert.notEqual(
      liveThreadId,
      VIEWED,
      "the viewed thread must not also be the relay's active thread, or the pane is not read-only"
    );

    await startBottomSampler(page);

    // --- let the Cursor turn finish -------------------------------------------
    await waitFor(
      async () => (await threadState(relayPort, VIEWED)).active_turn_id == null,
      TURN_TIMEOUT_MS,
      "the Cursor turn never finished"
    );
    const turnEndedAt = Date.now();
    console.log(`cursor turn finished after ${Math.round((turnEndedAt - turnStartedAt) / 1000)}s`);
    await screenshot(page, artifacts, "1-turn-ended.png");

    // Repairs are legitimate right after the turn; they just have to stop.
    await delay(SETTLE_MS);
    const quietFrom = Date.now();
    await delay(QUIET_MS);
    const quietTo = Date.now();

    // --- what the relay actually holds ---------------------------------------
    const serverTail = await tailOfTranscript(relayPort, VIEWED);
    const samples = await readSamples(page);
    const duringTurn = tailFetches.filter((at) => at >= openedAt && at <= turnEndedAt).length;
    const quietFetches = tailFetches.filter((at) => at >= quietFrom && at <= quietTo);
    const inQuiet = samples.filter((sample) => sample.t >= quietFrom && sample.t <= quietTo);
    const atBottom = inQuiet.filter((sample) => sample.atBottom && sample.lastEntryId);
    const strayed = atBottom.filter((sample) => sample.lastEntryId !== serverTail.newestEntryId);

    await screenshot(page, artifacts, "2-quiet-window.png");
    console.log(
      "measured:",
      JSON.stringify(
        {
          serverNewestEntryId: serverTail.newestEntryId,
          serverTailEntries: serverTail.tail,
          tailFetches: {
            total: tailFetches.length,
            duringTurn,
            afterTurnBeforeQuiet: tailFetches.filter(
              (at) => at > turnEndedAt && at < quietFrom
            ).length,
            inQuietWindow: quietFetches.length,
            perSecondInQuietWindow: perSecond(quietFetches, quietFrom, quietTo),
          },
          olderFetches: olderFetches.length,
          samples: {
            total: samples.length,
            inQuietWindow: inQuiet.length,
            atBottomInQuietWindow: atBottom.length,
            distinctBottomEntryIds: [...new Set(atBottom.map((s) => s.lastEntryId))],
          },
        },
        null,
        2
      )
    );

    // --- the run has to have exercised the path -------------------------------
    assert.ok(
      duringTurn >= MIN_REFETCHES_DURING_TURN,
      `the read-only pane refetched the tail only ${duringTurn} time(s) while the Cursor turn ran, `
        + `below the ${MIN_REFETCHES_DURING_TURN} this needs. The refresh path never ran hot, so no `
        + "delta could have been refused and the quiet window below proves nothing"
    );

    // --- claim 1: the newest thing the relay holds is the newest thing on screen
    const settledBottom = await measuredAtBottom(page);
    console.log("settled — bottom:", JSON.stringify(settledBottom));
    assert.equal(
      settledBottom.lastEntryId,
      serverTail.newestEntryId,
      "the read-only transcript never caught up with the finished turn: the relay's newest entry is "
        + `${serverTail.newestEntryId} (${serverTail.newestEntryKind}) but the pane ends at `
        + `${settledBottom.lastEntryId}. Server tail: ${JSON.stringify(serverTail.tail)}`
    );
    assert.ok(
      atBottom.length >= MIN_BOTTOM_SAMPLES,
      `the bottom of the list was only on screen for ${atBottom.length} of ${inQuiet.length} `
        + `samples in the quiet window, too few to call the tail settled — the pane never stayed `
        + "at its end"
    );
    assert.equal(
      strayed.length,
      0,
      `the read-only transcript kept losing its newest entry: ${strayed.length} of `
        + `${atBottom.length} samples ended at `
        + `${JSON.stringify([...new Set(strayed.map((s) => s.lastEntryId))])} instead of `
        + `${serverTail.newestEntryId}, first ${Math.round((strayed[0]?.t ?? 0) - quietFrom)}ms `
        + "into the quiet window"
    );

    // --- claim 2: the repair converges ----------------------------------------
    assert.ok(
      quietFetches.length <= MAX_QUIET_REFETCHES,
      `the read-only pane refetched its tail ${quietFetches.length} time(s) in the `
        + `${Math.round((quietTo - quietFrom) / 1000)}s quiet window that began `
        + `${Math.round((quietFrom - turnEndedAt) / 1000)}s after the Cursor turn ended `
        + `(${perSecond(quietFetches, quietFrom, quietTo).join(", ")} per second). Nothing is left `
        + "to fetch: the thread is idle and nothing throttles this path, so a tail gap that a "
        + "settled fetch does not clear re-arms the repair on its own re-render, forever"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          viewedThread: VIEWED,
          clonedFrom: viewed.source,
          newestEntryId: serverTail.newestEntryId,
          tailFetches: { duringTurn, inQuietWindow: quietFetches.length },
          bottomSamplesInQuietWindow: atBottom.length,
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
    console.error(`[cursor-view-only-tail-gap-e2e] artifacts: ${artifacts.dir}`);
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

// Record the END of the transcript, in the page, every 100ms. A settled
// before/after pair cannot tell a converged pane from one that is rebuilding
// itself continuously and happened to look right when it was read.
async function startBottomSampler(page) {
  await page.evaluate(() => {
    window.__tailGapSamples = [];
    window.__tailGapSampler = setInterval(() => {
      const scroller = document.querySelector("#transcript");
      const content = scroller?.querySelector(".thread-content");
      if (!scroller || !content) {
        return;
      }
      // Past the virtualization threshold only a window of rows is mounted, and
      // the virtualizer's own `data-index` is what says which row this is; below
      // it every entry is in the DOM under `.thread-content`.
      const rows = scroller.querySelector(".transcript-virtual-spacer")
        ? [...scroller.querySelectorAll(".transcript-virtual-row")]
        : [];
      const container = rows.length
        ? rows.reduce((best, row) =>
            (Number(row.dataset.index) > Number(best.dataset.index) ? row : best))
        : content;
      const ids = [...container.querySelectorAll("[data-transcript-entry-id]")];
      window.__tailGapSamples.push({
        t: Date.now(),
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        atBottom:
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 8,
        lastEntryId: ids.length
          ? ids[ids.length - 1].getAttribute("data-transcript-entry-id")
          : null,
      });
    }, 100);
  });
}

function readSamples(page) {
  return page.evaluate(() => window.__tailGapSamples || []);
}

// Everything measured about the pane, from geometry and ids only. `innerText`
// would report entries the virtualizer never rendered and CSS never laid out.
function measure() {
  const scroller = document.querySelector("#transcript");
  if (!scroller) {
    return { error: "no #transcript" };
  }
  const indices = [...scroller.querySelectorAll(".transcript-virtual-row")]
    .map((row) => Number(row.dataset.index))
    .filter((index) => Number.isFinite(index));
  const rows = scroller.querySelector(".transcript-virtual-spacer")
    ? [...scroller.querySelectorAll(".transcript-virtual-row")]
    : [];
  const container = rows.length
    ? rows.reduce((best, row) =>
        (Number(row.dataset.index) > Number(best.dataset.index) ? row : best))
    : scroller.querySelector(".thread-content");
  const lastIds = [...(container?.querySelectorAll("[data-transcript-entry-id]") || [])];
  return {
    scrollTop: Math.round(scroller.scrollTop),
    scrollHeight: Math.round(scroller.scrollHeight),
    clientHeight: scroller.clientHeight,
    virtualized: Boolean(scroller.querySelector(".transcript-virtual-spacer")),
    minRowIndex: indices.length ? Math.min(...indices) : null,
    maxRowIndex: indices.length ? Math.max(...indices) : null,
    renderedEntryIds: scroller.querySelectorAll("[data-transcript-entry-id]").length,
    lastEntryId: lastIds.length
      ? lastIds[lastIds.length - 1].getAttribute("data-transcript-entry-id")
      : null,
    viewedThreadId: new URL(window.location.href).searchParams.get("thread") || "",
  };
}

// Scroll the way a reader does. `scrollTop = ...` does NOT work on this pane: the
// stick-to-bottom follower derives stickiness from scroll INTENT, so an assigned
// offset is re-pinned on the next frame.
async function wheelBy(page, deltaY, steps) {
  const box = await page.locator("#transcript").boundingBox();
  assert.ok(box, "the transcript must be on screen before it can be scrolled");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, deltaY);
    await delay(90);
  }
}

async function measuredAtBottom(page) {
  let previous = null;
  for (let sweep = 0; sweep < 12; sweep += 1) {
    await wheelBy(page, 1500, 8);
    await delay(300);
    const { scrollTop } = await page.evaluate(measure);
    if (scrollTop === previous) {
      break;
    }
    previous = scrollTop;
  }
  await delay(400);
  return page.evaluate(measure);
}

async function screenshot(page, artifacts, name) {
  try {
    await fs.mkdir(artifacts.dir, { recursive: true });
    await page.screenshot({ path: path.join(artifacts.dir, name), fullPage: false });
  } catch {}
}

function perSecond(timestamps, from, to) {
  const buckets = new Array(Math.max(1, Math.round((to - from) / 1000))).fill(0);
  for (const at of timestamps) {
    const bucket = Math.min(buckets.length - 1, Math.floor((at - from) / 1000));
    buckets[bucket] += 1;
  }
  return buckets;
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

// The newest end of a thread as the RELAY holds it — the reference the pane is
// measured against, taken from storage rather than from the pane itself.
async function tailOfTranscript(relayPort, threadId) {
  const data = (await getJson(relayPort, `/api/threads/${threadId}/transcript`)).data || {};
  const entries = data.entries || [];
  const newest = entries[entries.length - 1] || null;
  return {
    entries: entries.length,
    newestEntryId: newest?.row_id ?? newest?.item_id ?? null,
    newestEntryKind: newest?.kind ?? null,
    tail: entries.slice(-4).map((entry) => ({ id: entry.row_id ?? entry.item_id, kind: entry.kind })),
  };
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
// cwd, plus a `store.db`. Smallest first — the smallest is the cheapest turn.
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
