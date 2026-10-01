// Drives the local web UI to verify the two sidebar narrowing controls — the title
// SEARCH and the activity BELL — and the places they are wired into the rest of the
// shell. Everything here is a regression that shipped broken once:
//
//   * a search result had to stay actionable — right-click once closed the menu the
//     instant it opened, and archive swept only the authoritative list, leaving a dead
//     session on screen as a clickable row;
//   * the bell had to cut ACROSS Projects mode rather than sit there looking active
//     while the project tree ignored it;
//   * a row must not vanish from under the pointer when its state moves on while the
//     bell is narrowed to the state it just left;
//   * "Reviewing" had to be its own bucket, distinguishable from "Working".
//
// TWO THINGS THIS FILE DOES NOT COVER, on purpose:
//
//   * the DEPTH of search — finding a thread past the truncated page — needs ~300 seeded
//     threads, so it lives in Rust (`thread_search_scans_past_the_page_limit`);
//   * consequently every row here is in `state.threads` too, so `findVisibleThread`'s
//     union never has to do any work. A row that exists ONLY in the search slice is
//     covered by the unit tests in `frontend/shared/thread-search.test.mjs`. Do not read
//     the fork assertion below as proof of that union — it is not.
//
// Approvals are enforced so a turn parks deterministically: that is what produces a
// real "needs input", and what holds a review job non-terminal long enough to observe
// the "Reviewing" bucket without racing the fake provider.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-search-filter-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { openSessionsDrawer } from "./e2e/harness/drawer.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";
import { confirmThreadMenuRemoval } from "./e2e/harness/thread-menu.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const DEVICE = "search-filter-device";

const startedAt = Date.now();
const step = (message) =>
  console.error(`[step +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);

async function api(relayPort, method, apiPath, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${apiPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.equal(
    response.status,
    200,
    `${method} ${apiPath} -> ${response.status}: ${JSON.stringify(payload)}`
  );
  assert.equal(payload?.ok, true, `${method} ${apiPath} not ok: ${JSON.stringify(payload)}`);
  return payload.data;
}

async function startNamedSession(relayPort, cwd, name) {
  const started = await api(relayPort, "POST", "/api/session/start", {
    cwd,
    device_id: DEVICE,
    provider: "fake",
    model: "fake-echo",
    approval_policy: "never",
    sandbox: "workspace-write",
    effort: "medium",
  });
  const threadId = started.active_thread_id;
  assert.ok(threadId, `started thread id for ${name}`);
  await api(relayPort, "POST", `/api/threads/${threadId}/rename`, { name, device_id: null });
  return threadId;
}

async function snapshot(relayPort) {
  return api(relayPort, "GET", "/api/session");
}

// Approvals are enforced, so a sent turn parks here until it is decided.
async function waitForApproval(relayPort, threadId) {
  for (let i = 0; i < 200; i += 1) {
    const data = await snapshot(relayPort);
    const hit = (data.pending_approvals || []).find((a) => !threadId || a.thread_id === threadId);
    if (hit) return hit;
    await delay(150);
  }
  throw new Error(`no approval ever parked for ${threadId || "any thread"}`);
}

// A turn that has been approved still has to finish. `/api/session/review` refuses to
// start while one is in progress, so the review phase has to wait for the relay to go
// quiet rather than for the approval call to return.
async function waitForNoActiveTurn(relayPort) {
  for (let i = 0; i < 200; i += 1) {
    const data = await snapshot(relayPort);
    if (!data.active_turn_id && (data.pending_approvals || []).length === 0) return;
    await delay(150);
  }
  throw new Error("a turn never settled");
}

async function approveFor(relayPort, threadId) {
  const approval = await waitForApproval(relayPort, threadId);
  await api(relayPort, "POST", `/api/approvals/${approval.request_id || approval.id}`, {
    decision: "approve",
    scope: "once",
    device_id: DEVICE,
  });
}

// The sessions list lives in a collapsed <details> drawer off the conversation view.
const openDrawer = (page) => openSessionsDrawer(page, { timeoutMs: TIMEOUT_MS });

const rowTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#threads-list .conversation-item")].map((n) =>
      (n.dataset.threadTitle || n.textContent || "").trim()
    )
  );

const rowIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#threads-list .conversation-item")].map((n) => n.dataset.threadId)
  );

const groupLabels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) =>
      n.textContent.trim()
    )
  );

const countLine = (page) =>
  page.evaluate(() => document.querySelector("#threads-count")?.textContent?.trim() || "");

// Never assume a toggle's position — read it. An inverted assumption here once made a
// passing log look like proof of the opposite behaviour.
const bellIsOn = (page) =>
  page.evaluate(() =>
    Boolean(document.querySelector(".sidebar-bell-toggle")?.classList.contains("is-active"))
  );

async function setBell(page, want) {
  if ((await bellIsOn(page)) !== want) {
    await page.click(".sidebar-bell-toggle");
    await page.waitForFunction(
      (expected) =>
        Boolean(document.querySelector(".sidebar-bell-toggle")?.classList.contains("is-active"))
        === expected,
      want,
      { timeout: TIMEOUT_MS }
    );
  }
  assert.equal(await bellIsOn(page), want, `bell should be ${want ? "on" : "off"}`);
}

async function setSearch(page, query) {
  // "Is the field open?" is now "does the field EXIST?". It used to be permanently
  // mounted and toggled with `hidden`, because app.js reached three ids inside it; it is
  // a shared component now and simply is not rendered when closed. Probing `hidden` here
  // would read `undefined` on a missing node and report every closed field as OPEN.
  const open = await page.evaluate(() => Boolean(document.querySelector(".sidebar-search")));
  if (!open) {
    await page.click(".sidebar-search-toggle");
    await page.waitForSelector(".sidebar-search-input", { state: "visible", timeout: TIMEOUT_MS });
  }
  // Clear first: `pressSequentially` types at the CARET rather than replacing the value, so
  // consecutive calls would otherwise concatenate ("auth" + "zzz-no-such-session"). A
  // one-shot `fill("")` is fine for the clear — the risk being guarded below is in typing a
  // word, not in emptying the field.
  await page.fill(".sidebar-search-input", "");

  // pressSequentially, NOT fill. Local's field is a CONTROLLED input now — its value comes
  // from `threadListStore.searchUi.draft` — and `fill` sets the whole value in one shot with
  // a single event, which is precisely the shape that hides a controlled-input bug: bind the
  // value to the debounced query instead of the draft and real key-by-key typing has React
  // restore the previous value after every keystroke, so a word ends up searching for its
  // last letter. `fill` passes cleanly through that bug. Remote's suite already types for
  // this reason; local acquired the same risk when the field stopped being imperative.
  await page.locator(".sidebar-search-input").pressSequentially(query, { delay: 25 });
  await page
    .waitForFunction(
      (expected) => document.querySelector(".sidebar-search-input")?.value === expected,
      query,
      { timeout: TIMEOUT_MS }
    )
    .catch(async () => {
      throw new Error(
        `the field lost characters while typing ${JSON.stringify(query)}: `
          + `${JSON.stringify(await page.inputValue(".sidebar-search-input"))}`
      );
    });
}

// Close any open thread menu without touching the search box.
async function dismissMenu(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  const open = await page.evaluate(() => {
    const menu = document.querySelector("#thread-context-menu");
    return Boolean(menu && !menu.hidden);
  });
  if (open) {
    await page.keyboard.press("Escape");
  }
}

// Right-click a row and wait for its menu. Retried, because the list repaints as the
// search settles: a contextmenu event that lands on a node React is in the middle of
// replacing is simply lost, and under load that is common rather than rare.
async function openThreadMenu(page, threadId) {
  // Peel anything a previous step left open — the menu paints AT the cursor, so a stale
  // one sits on top of the row this right-click has to hit. Blur FIRST: Escape inside
  // the search box means "close and clear the search", which would silently undo the
  // very query the row was found by.
  await dismissMenu(page);
  // ATTACHED, not visible. The list is virtualized, so under load a freshly rendered row
  // can be in the DOM a beat before the virtualizer has measured it — and
  // `waitForSelector` defaults to visible, which turns that beat into a 45s timeout.
  await page
    .waitForFunction(
      (id) => Boolean(document.querySelector(`#threads-list [data-thread-id="${id}"]`)),
      threadId,
      { timeout: TIMEOUT_MS }
    )
    .catch(async () => {
      throw new Error(
        `row ${threadId} never rendered; list holds ${JSON.stringify(await rowIds(page))}`
      );
    });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page
      .locator(`#threads-list [data-thread-id="${threadId}"]`)
      .click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
    const opened = await page
      .waitForFunction(
        (id) => {
          const menu = document.querySelector("#thread-context-menu");
          if (!menu || menu.hidden || menu.getBoundingClientRect().height === 0) return false;
          // ...and it must be THIS row's menu, not a leftover from the previous step.
          const row = document.querySelector("#threads-list .conversation-item.is-context-target");
          return !row || row.dataset.threadId === id;
        },
        threadId,
        { timeout: 3000 }
      )
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    await dismissMenu(page);
    await delay(250);
  }
  throw new Error(`the context menu never opened for ${threadId}`);
}

async function waitForRowCount(page, expected, why) {
  await page
    .waitForFunction(
      (n) => document.querySelectorAll("#threads-list .conversation-item").length === n,
      expected,
      { timeout: TIMEOUT_MS }
    )
    .catch(async () => {
      throw new Error(
        `${why}: expected ${expected} rows, saw ${JSON.stringify(await rowTitles(page))}`
      );
    });
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-search-filter-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-search-filter-codex-", {
    requireAuth: false,
  });
  const workspace = path.join(stateDir, "search-filter-ws");
  await fs.mkdir(workspace, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: { AGENT_PROVIDERS: "fake", FAKE_PROVIDER_ENFORCE_APPROVALS: "1" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  // Step 9 asks for a real review, and a review collects a workspace diff. Starting an
  // agent in a directory is a deliberate local action but not permission for ambient
  // git probes, so without an explicit grant the job dies on "is not a granted
  // workspace" — a TERMINAL status, which means the parent never enters the Reviewing
  // bucket and the assertion reads as "the dot never appeared". Mirror the local UI's
  // trust step, exactly as `review-recap-modes-e2e.mjs` and `cwd-drift-e2e.mjs` do.
  await api(relayPort, "POST", "/api/workspace/trust", { cwd: workspace });

  let browser;
  let context;
  let page;
  try {
    step("1. seed three named sessions over the API");
    const idleId = await startNamedSession(relayPort, workspace, "Quiet notes");
    // A throwaway idle session for the archive step: a thread parked on an approval is
    // busy, and the relay refuses to archive one.
    const scratchId = await startNamedSession(relayPort, workspace, "Scratch pad");
    const doneId = await startNamedSession(relayPort, workspace, "Refactor the auth guard");
    await api(relayPort, "POST", "/api/session/message", {
      text: "go",
      thread_id: doneId,
      device_id: DEVICE,
    });
    await waitForApproval(relayPort, doneId);

    const blockedId = await startNamedSession(relayPort, workspace, "Auth token rotation");
    await api(relayPort, "POST", "/api/session/message", {
      text: "go",
      thread_id: blockedId,
      device_id: DEVICE,
    });
    await waitForApproval(relayPort, blockedId);

    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(page);
    await waitForRowCount(page, 4, "the four seeded sessions should list");

    step("2. search narrows by title, and clearing restores the full list");
    await setSearch(page, "auth");
    await waitForRowCount(page, 2, "'auth' matches two of the three titles");
    assert.equal(await countLine(page), "2 results", "the count line reports matches, not folders");
    const matched = await rowTitles(page);
    assert.ok(
      matched.every((title) => title.toLowerCase().includes("auth")),
      `every row should match the query: ${JSON.stringify(matched)}`
    );

    await setSearch(page, "zzz-no-such-session");
    await waitForRowCount(page, 0, "a query matching nothing empties the list");
    const emptyNote = await page.evaluate(
      () => document.querySelector("#threads-list")?.textContent?.trim() || ""
    );
    assert.match(
      emptyNote,
      /zzz-no-such-session/,
      `the empty state names the query so a typo is visible: ${emptyNote}`
    );

    await page.click(".sidebar-search-clear");
    await waitForRowCount(page, 4, "clearing the query restores the authoritative list");

    step("3. a search result stays actionable: right-click keeps its menu open");
    // Deliberately the IDLE session: a thread parked on an approval still holds a live
    // (paused) turn, and the relay rejects forking one — so a disabled Fork there would
    // say nothing. What this pins is that the row-level actions survive being reached
    // from the search view at all; the beyond-the-page case is unit-tested (see header).
    await setSearch(page, "Quiet");
    await waitForRowCount(page, 1, "'Quiet' matches one session");
    // `.context-menu` is position:fixed, so offsetParent is ALWAYS null — openThreadMenu
    // measures the box instead.
    await openThreadMenu(page, idleId);
    const forkUsable = await page.evaluate(() => {
      const button = document.querySelector("#fork-thread-button");
      return button ? !button.disabled : "missing";
    });
    assert.equal(forkUsable, true, "fork must resolve a row reached through search");
    await dismissMenu(page);

    step("4. archiving from the search view sweeps the row out of the results");
    await setSearch(page, "Scratch");
    await waitForRowCount(page, 1, "'Scratch' matches one session");
    await openThreadMenu(page, scratchId);
    await page.waitForSelector("#thread-context-menu:not([hidden]) #archive-thread-button", {
      timeout: TIMEOUT_MS,
    });
    await page.click("#archive-thread-button");
    await confirmThreadMenuRemoval(page, { timeoutMs: TIMEOUT_MS });
    await waitForRowCount(
      page,
      0,
      "the archived row must leave the SEARCH slice, not just state.threads"
    );

    await page.click(".sidebar-search-clear");
    await page.click(".sidebar-search-toggle");
    await waitForRowCount(page, 3, "the archived session is gone from the resting list too");

    step("5. put both busy threads in the background, then let one finish");
    // Attention badges are for threads you are NOT looking at, and `completed` is only
    // set when the work→idle transition happens while you are away.
    await page.click(`#threads-list [data-thread-id="${idleId}"]`);
    await delay(800);
    await approveFor(relayPort, doneId);

    step("6. the bell buckets by state and hides idle sessions");
    await setBell(page, true);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .join("|") === "Needs input|Done",
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`bell buckets were ${JSON.stringify(await groupLabels(page))}`);
    });
    const bellIds = await rowIds(page);
    assert.ok(!bellIds.includes(idleId), "an idle session has no state and no bucket");
    assert.ok(bellIds.includes(blockedId), "the parked session belongs to Needs input");

    // The bell is a plain on/off toggle: no pill row, no per-state selection. The bucket
    // headers ARE the readout, so a second one above the list would only restate them.
    assert.equal(
      await page.evaluate(() => document.querySelectorAll(".activity-filter-pill").length),
      0,
      "the bell must not render a pill row"
    );

    step("7. retention when a bucketed row's state changes");
    assert.ok(
      (await groupLabels(page)).includes("Needs input"),
      "precondition: the parked session is the only thing under Needs input"
    );

    // Answer it. The row must NOT vanish — it moves to the bucket it is actually in.
    await approveFor(relayPort, blockedId);
    await page.waitForFunction(
      (id) => {
        const row = document.querySelector(`#threads-list [data-thread-id="${id}"]`);
        const dot = row?.querySelector(".conversation-activity-dot");
        return Boolean(row) && !dot?.classList.contains("is-attention-input");
      },
      blockedId,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the answered row left the narrowed list instead of being retained: ${JSON.stringify(
          await rowIds(page)
        )}`
      );
    });
    assert.ok(
      (await rowIds(page)).includes(blockedId),
      "a row that has matched stays listed after its state moves on"
    );
    assert.ok(
      !(await groupLabels(page)).includes("Needs input"),
      "...and it is shown under its CURRENT state, not frozen in the bucket it entered by"
    );

    step("7b. clicking a bucketed row must not make it vanish under the click");
    // Opening a thread clears its attention badge (`threadAttention.clear` in
    // onResumeThread). A "Done" row therefore becomes STATELESS the instant you click
    // it — and without retention remembering the bucket it was last in, it would drop
    // out of the list under the pointer, which is the worst possible moment.
    assert.ok(
      (await groupLabels(page)).includes("Done"),
      "precondition: the finished session sits under Done"
    );
    const clickTarget = doneId;
    assert.ok(
      (await rowIds(page)).includes(clickTarget),
      "precondition: the finished session is listed before it is clicked"
    );
    await page.click(`#threads-list [data-thread-id="${clickTarget}"]`);
    await delay(1200);
    assert.ok(
      (await rowIds(page)).includes(clickTarget),
      "the row you just clicked must still be listed after its badge is cleared"
    );

    step("8. the bell cuts across a pinned project");
    await setBell(page, false);
    const created = await api(relayPort, "POST", "/api/projects", {
      action: "create",
      name: "Alpha",
    });
    const projectId = created.projects.find((p) => p.name === "Alpha")?.id;
    assert.ok(projectId, `created project: ${JSON.stringify(created)}`);
    // The Sessions/Projects toggle is gone; a project is reached by selecting it in the
    // switcher, which PINS it to the top of a list that stays complete.
    await page.click(".project-switcher-trigger");
    await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
    await projectSwitcherOption(page, "Alpha").click({ timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#threads-list .thread-group-name")].some(
          (n) => n.textContent.trim() === "Alpha"
        ),
      undefined,
      { timeout: TIMEOUT_MS }
    );

    await setBell(page, true);
    await page.waitForFunction(
      () => {
        const labels = [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) =>
          n.textContent.trim()
        );
        return labels.length > 0 && !labels.includes("Alpha");
      },
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the bell did not take over Projects mode: ${JSON.stringify(await groupLabels(page))}`
      );
    });

    await setBell(page, false);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#threads-list .thread-group-name")].some(
          (n) => n.textContent.trim() === "Alpha"
        ),
      undefined,
      { timeout: TIMEOUT_MS }
    );
    // Unpin through the switcher — the Sessions/Projects toggle it used to click no
    // longer exists, and leaving "Alpha" pinned would put a project group at the top of
    // every bucket assertion below.
    await page.click(".project-switcher-trigger");
    await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
    await projectSwitcherOption(page, "All sessions").click({ timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () => !document.querySelector("#threads-list .thread-group-header-project"),
      undefined,
      { timeout: TIMEOUT_MS }
    );

    step("9. a live review puts its PARENT in the Reviewing bucket");
    // `last_message` skips the parent's own recap turn, so the parent stays idle while a
    // separate reviewer thread works — which is exactly what "Reviewing" means. Enforced
    // approvals park the reviewer, holding the job non-terminal instead of racing it.
    await api(relayPort, "POST", "/api/session/message", {
      text: "seed for review",
      thread_id: idleId,
      device_id: DEVICE,
    });
    await approveFor(relayPort, idleId);
    await waitForNoActiveTurn(relayPort);
    await api(relayPort, "POST", "/api/session/review", {
      thread_id: idleId,
      reviewer_provider: "fake",
      recap_source: "last_message",
      device_id: DEVICE,
    });

    await setBell(page, true);
    await page.waitForFunction(
      (id) => {
        const row = document.querySelector(`#threads-list [data-thread-id="${id}"]`);
        const dot = row?.querySelector(".conversation-activity-dot");
        return Boolean(dot?.classList.contains("is-reviewing"));
      },
      idleId,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the reviewed parent never showed a Reviewing dot; buckets: ${JSON.stringify(
          await groupLabels(page)
        )}`
      );
    });
    assert.ok(
      (await groupLabels(page)).includes("Reviewing"),
      "Reviewing is its own bucket, not folded into Working"
    );

    console.log("SEARCH_FILTER_E2E: PASS");
  } catch (error) {
    console.error("SEARCH_FILTER_E2E: FAIL");
    console.error(error);
    dumpProcessLogs(relay);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
