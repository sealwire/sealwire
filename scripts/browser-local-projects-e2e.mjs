// Drives the local web UI to verify the Projects experience: selecting a project
// PINS it as a group on top of cwd grouping (it does not swap the grouping axis),
// passive propagation of API membership changes, degrading OPEN when the Projects
// payload is unavailable or in flight (the list stays complete — it just isn't
// pinned yet), the thread context-menu project actions (assign / unassign /
// new+assign) and their fail-closed/stale guards, and project Rename/Delete via the
// project context menu, which now lives on the pinned group's own header.
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-projects-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { ALL_SESSIONS_LABEL } from "../frontend/shared/header-labels.js";
import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { openSessionsDrawer } from "./e2e/harness/drawer.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

// Progress breadcrumbs on stderr. This script has ~12 phases behind 45s waits (and one
// reopen loop that can retry 40×), so a silent run is indistinguishable from a hang —
// these say which phase owns the stall.
const startedAt = Date.now();
const step = (message) => console.error(`[step +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);

async function api(relayPort, method, apiPath, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${apiPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${method} ${apiPath} -> ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.ok, true, `${method} ${apiPath} not ok: ${JSON.stringify(payload)}`);
  return payload.data;
}

// Poll the dedicated Projects channel until a thread's membership matches (server
// truth). `expectedProjectId = null` means "unassigned".
async function waitForMembership(relayPort, threadId, expectedProjectId) {
  for (let i = 0; i < 100; i += 1) {
    const data = await api(relayPort, "GET", "/api/projects");
    const current = data.thread_project_id[threadId] ?? null;
    if (current === (expectedProjectId ?? null)) return current;
    await delay(150);
  }
  throw new Error(`membership for ${threadId} never became ${expectedProjectId ?? "unassigned"}`);
}

// The sessions/projects list lives in a collapsed <details> drawer off the
// conversation view — open it so its rows are laid out. Shared, because opening it
// by assigning `.open` races the store that owns the flag; see the harness note.
const openDrawer = (page) => openSessionsDrawer(page, { timeoutMs: TIMEOUT_MS });

const projectNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim())
  );

// Right-click a thread row (Sessions mode), open its second-level "Project ›" flyout,
// and read that flyout's buttons — the current one prefixed "✓ ", as its aria-checked says. Projects live one level down now: the menu itself only
// carries the trigger row.
async function openThreadMenu(page, tid) {
  // Dismiss whatever a previous step left open first: the menu paints AT the cursor, so
  // a stale one sits on top of the very row this right-click has to hit. Two presses
  // because Escape peels one level at a time (flyout, then menu).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    (t) => {
      const count = document.querySelector("#threads-count")?.textContent || "";
      if (count.includes("Loading projects")) return false;
      return !!document.querySelector(`#threads-list [data-thread-id="${t}"]`);
    },
    tid,
    { timeout: TIMEOUT_MS }
  );
  await page.locator(`#threads-list [data-thread-id="${tid}"]`).click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
  await page.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
  await openThreadProjectSubmenu(page);
  await page.waitForFunction(() => {
    const submenu = document.querySelector("#thread-project-submenu");
    return submenu && !submenu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0;
  }, null, { timeout: TIMEOUT_MS });
  return page.evaluate(() => [...document.querySelectorAll("#thread-project-actions button")].map((b) => (b.getAttribute("aria-checked") === "true" ? "✓ " : "") + b.textContent.trim()));
}

// Reveal the second level with a REAL pointer hover, which is how a mouse user gets
// there — a synthetic .click() would skip hit-testing and pass even if the row were
// covered. The pointer parks on a neighbouring row first for two reasons: hover() that
// lands where the pointer already sits fires no mouseenter (silent flake), and crossing
// off the trigger must dismiss the flyout, so reopening proves that rule too.
async function openThreadProjectSubmenu(page) {
  await page.locator("#fork-thread-button").hover({ timeout: TIMEOUT_MS });
  await page.locator("#thread-project-submenu-trigger").hover({ timeout: TIMEOUT_MS });
  await page.waitForSelector("#thread-project-submenu:not([hidden])", { timeout: TIMEOUT_MS });
}

// The trigger row's own value text — the session's project as shown WITHOUT opening the
// flyout ("None" when unassigned).
const threadProjectTriggerValue = (page) =>
  page.evaluate(() => document.querySelector("#thread-project-current-label")?.textContent?.trim() || null);

// Right-click a thread row and read the FIRST level only — no flyout. This is the
// "projects moved one level down" contract: the menu itself carries a single trigger row
// naming the session's project, and zero Project buttons.
async function readThreadMenuFirstLevel(page, tid) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator(`#threads-list [data-thread-id="${tid}"]`).click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
  await page.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
  return page.evaluate(() => ({
    triggerValue: document.querySelector("#thread-project-current-label")?.textContent?.trim() || null,
    submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
    // Rendered, not merely present: the rows are BUILT when the menu opens (so a
    // Projects refresh can withdraw them) but live inside the hidden flyout, so what
    // matters is that none of them are on screen at the first level.
    visibleProjectButtons: [...document.querySelectorAll("#thread-project-actions button")].filter(
      (b) => b.getClientRects().length > 0
    ).length,
    menuButtonLabels: [...document.querySelectorAll("#thread-context-menu .context-menu-button")].map((b) =>
      b.textContent.trim()
    ),
  }));
}

// Geometry of both panels once the flyout is open — it must sit fully on screen and
// beside (never on top of) the menu it flew out of.
const threadMenuGeometry = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector("#thread-context-menu").getBoundingClientRect();
    const submenu = document.querySelector("#thread-project-submenu").getBoundingClientRect();
    return {
      insideViewport:
        submenu.left >= 0
        && submenu.top >= 0
        && submenu.right <= window.innerWidth
        && submenu.bottom <= window.innerHeight,
      horizontallyClear: submenu.left >= menu.right || submenu.right <= menu.left,
      menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
      submenu: { left: submenu.left, right: submenu.right, top: submenu.top, bottom: submenu.bottom },
    };
  });

// Pick a row in the open flyout with a REAL pointer click. Deliberately not a synthetic
// element.click(): the flyout lives OUTSIDE #thread-context-menu, so a genuine click is
// the only thing that exercises the document-level dismiss handler — which would
// otherwise tear the menu down before the action ran.
async function clickThreadProjectButton(page, predicate) {
  const index = await page.evaluate((arg) => {
    const buttons = [...document.querySelectorAll("#thread-project-actions button")];
    return buttons.findIndex((b) => {
      const text = b.textContent.trim();
      return arg.exact ? text.replace(/^✓\s*/, "") === arg.exact : text.includes(arg.includes);
    });
  }, predicate);
  assert.ok(
    index >= 0,
    `flyout row ${JSON.stringify(predicate)} not found: ${JSON.stringify(
      await page.evaluate(() => [...document.querySelectorAll("#thread-project-actions button")].map((b) => (b.getAttribute("aria-checked") === "true" ? "✓ " : "") + b.textContent.trim()))
    )}`
  );
  await page.locator("#thread-project-actions button").nth(index).click({ timeout: TIMEOUT_MS });
}

// Reopen a thread menu until its Project buttons satisfy `match(labels)`.
async function waitForThreadMenuState(page, tid, match) {
  for (let i = 0; i < 40; i += 1) {
    const labels = await openThreadMenu(page, tid);
    if (match(labels)) return labels;
    // Escape peels one level per press: flyout, then the menu itself. Both must go, or
    // the still-open menu covers the thread row the next right-click needs to hit.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await delay(200);
  }
  throw new Error("thread context menu never reached the expected Project state");
}

// Pick a project in the switcher above the tab strip. This is the ONLY way to
// reach a given project's header now: exactly one project is pinned at a time, so
// its rename/delete affordances exist only while it is the selection. Returns once
// the pinned group has actually rendered under that name.
async function selectProjectInSwitcher(page, name) {
  await page.waitForSelector(".project-switcher-trigger", { state: "attached", timeout: TIMEOUT_MS });
  // Read-then-act, never blind-toggle: if the menu is already open, clicking the
  // trigger would close it and the option wait below would hang for the full 45s.
  const alreadyOpen = await page.evaluate(
    () => document.querySelector(".project-switcher-trigger")?.getAttribute("aria-expanded") === "true"
  );
  if (!alreadyOpen) {
    await page.click(".project-switcher-trigger", { timeout: TIMEOUT_MS });
  }
  await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
  await projectSwitcherOption(page, name).click({ timeout: TIMEOUT_MS });
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("#threads-list .thread-group-header-project .thread-group-name")]
      .some((r) => r.textContent.trim() === n),
    name,
    { timeout: TIMEOUT_MS }
  );
}

// The switcher's own way back to an unpinned list.
async function selectDefaultWorkspaceInSwitcher(page) {
  await page.waitForSelector(".project-switcher-trigger", { state: "attached", timeout: TIMEOUT_MS });
  const alreadyOpen = await page.evaluate(
    () => document.querySelector(".project-switcher-trigger")?.getAttribute("aria-expanded") === "true"
  );
  if (!alreadyOpen) {
    await page.click(".project-switcher-trigger", { timeout: TIMEOUT_MS });
  }
  await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
  await projectSwitcherOption(page, "All sessions").click({ timeout: TIMEOUT_MS });
  await page.waitForFunction(
    () => !document.querySelector("#threads-list .thread-group-header-project"),
    undefined,
    { timeout: TIMEOUT_MS }
  );
}

// Right-click the pinned project's header to open its menu.
async function openProjectMenu(page, name) {
  await selectProjectInSwitcher(page, name);
  const row = page
    .locator("#threads-list .thread-group-header-project", { hasText: name })
    .first();
  await row.click({ button: "right", timeout: TIMEOUT_MS });
  await page.waitForSelector(".context-menu[aria-label^=\"Project \"]", { timeout: TIMEOUT_MS });
}

// Scoped to the header's own menu: the session menu also has a (hidden) "Rename…".
const projectMenuRow = (page, label) =>
  page.locator('.context-menu[aria-label^="Project "] .context-menu-button', { hasText: label }).first();

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-projects-toggle-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-projects-toggle-codex-", { requireAuth: false });
  const workspace = path.join(stateDir, "projects-toggle-ws");
  await fs.mkdir(workspace, { recursive: true });

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
  try {
    step("1-3. start a fake session, create + assign a project (API)");
    // 1. Start a fake session so a thread exists; 2-3. create + assign a Project.
    const started = await api(relayPort, "POST", "/api/session/start", {
      cwd: workspace,
      device_id: "projects-toggle-device",
      initial_prompt: "hello-projects",
      provider: "fake",
      model: "fake-echo",
      approval_policy: "never",
      sandbox: "workspace-write",
      effort: "medium",
    });
    const threadId = started.active_thread_id;
    assert.ok(threadId, "started thread id");
    for (let i = 0; i < 50; i += 1) {
      const list = await api(relayPort, "GET", "/api/threads?limit=50");
      if ((list.threads || []).some((t) => t.id === threadId)) break;
      await delay(200);
    }

    const created = await api(relayPort, "POST", "/api/projects", { action: "create", name: "VerifyProj" });
    const projectId = created.projects.find((p) => p.name === "VerifyProj")?.id;
    assert.ok(projectId, `created project id: ${JSON.stringify(created)}`);
    await api(relayPort, "POST", "/api/projects", { action: "assign", thread_id: threadId, project_id: projectId });
    const fetched = await api(relayPort, "GET", "/api/projects");
    assert.ok(fetched.projects_revision > 0, `projects_revision > 0: ${fetched.projects_revision}`);
    assert.equal(fetched.thread_project_id[threadId], projectId, "GET /api/projects membership");

    step("4. load the UI");

    // 4. Load the UI (Sessions mode by default).
    ({ browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 1400, height: 1000 } } }));
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(page);
    await page.waitForFunction(
      () => document.querySelectorAll("#threads-list .thread-group").length >= 1,
      null,
      { timeout: TIMEOUT_MS }
    );
    const sessionsView = await page.evaluate(() => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      // Inverted deliberately: this asserted the toggle EXISTED. Selecting a project
      // pins it to the top of a list that stays complete, so there was never a second
      // mode to switch into — the switcher is the whole control, and a leftover toggle
      // would be a second, disagreeing answer to "what am I looking at".
      hasToggle: !!document.querySelector("#threads-view-projects") || !!document.querySelector("#threads-view-sessions"),
      hasSwitcher: !!document.querySelector(".project-switcher-trigger"),
    }));
    assert.equal(sessionsView.hasToggle, false, "the Sessions/Projects toggle is gone");
    assert.ok(sessionsView.hasSwitcher, "and the switcher is what replaced it");
    assert.match(sessionsView.countText, /folder/, `default workspace shows folder grouping: ${sessionsView.countText}`);

    step("4b. the switcher menu actually reacts to the cursor");

    // A real computed-style check, in the browser, of what the stylesheet guard can
    // only approximate. That guard resolves var() chains itself and cannot see the
    // full cascade — and its first version was green while the active row's hover
    // painted the row's own colour, because it compared declaration source text.
    // Here the browser does the resolving.
    let hoverColours = null;
    {
      await page.click(".project-switcher-trigger", { timeout: TIMEOUT_MS });
      await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
      const bg = (selector) =>
        page.evaluate(
          (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor,
          selector
        );
      const menu = await bg(".project-switcher-menu");
      // The default-workspace row is the active one here (no project selected yet).
      const activeRest = await bg(".project-switcher-option.is-active");
      const plainRest = await bg(".project-switcher-option:not(.is-active)");
      // Settle past the transition before reading. `button` carries
      // `transition: background 120ms` globally, so an immediate read returns the
      // value the colour is animating AWAY from — this check reported every hover
      // as dead on its first run for exactly that reason. A fixed wait is right
      // here: it waits out a known-duration animation rather than polling for the
      // assertion, which would make the test true by construction.
      const SETTLE_MS = 300;
      await page.hover(".project-switcher-option:not(.is-active)", { timeout: TIMEOUT_MS });
      await delay(SETTLE_MS);
      const plainHover = await bg(".project-switcher-option:not(.is-active)");
      await page.hover(".project-switcher-option.is-active", { timeout: TIMEOUT_MS });
      await delay(SETTLE_MS);
      const activeHover = await bg(".project-switcher-option.is-active");
      hoverColours = { menu, activeRest, plainRest, plainHover, activeHover };
      // Leave the menu closed; an open overlay sits on top of the rows step 5 clicks.
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector(".project-switcher-menu"),
        null,
        { timeout: TIMEOUT_MS }
      );
    }

    step("5. the pinned project's rows");

    // 5. Pin a project from the switcher: its group leads the list, with its sessions
    //    nested underneath — and every other session stays exactly where it was.
    await selectProjectInSwitcher(page, "VerifyProj");
    const projectsView = await page.evaluate(({ name, threadId }) => {
      const row = [...document.querySelectorAll("#threads-list .thread-group-header-project")].find(
        (r) => r.querySelector(".thread-group-name")?.textContent?.trim() === name
      );
      return {
        countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
        projectRows: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
        // Projects mode builds its groups from the project list alone, so a
        // session's row is present here IF AND ONLY IF it is assigned. That is a
        // stronger signal than the old "N sessions" badge (now removed — the
        // nested rows already say the count, and it crowded the fold control).
        hasAssignedSession: Boolean(
          document.querySelector(`#threads-list [data-thread-id="${threadId}"]`)
        ),
        verifyBadge: row?.querySelector(".thread-group-badges")?.textContent?.trim() || "",
        hasActionsButton: !!row?.closest(".thread-group-header-project")?.querySelector(".thread-group-more"),
        pinnedFirst:
          [...document.querySelectorAll("#threads-list .thread-group-header")][0]
            ?.classList.contains("thread-group-header-project") || false,
      };
    }, { name: "VerifyProj", threadId });

    step("6. back to the default workspace");

    // 6. Unpin by choosing the default workspace — the switcher's own way back.
    await selectDefaultWorkspaceInSwitcher(page);
    const backToSessions = await page.evaluate(() => ({
      noProjectGroup: !document.querySelector("#threads-list .thread-group-header-project"),
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
    }));

    step("7. passive membership propagation");

    // 7. Passive propagation: an API unassign (no browser action) flows through the
    // snapshot's projects_revision -> refetch -> re-render, dropping the project's
    // session count. Then re-assign restores it.
    await selectProjectInSwitcher(page, "VerifyProj");
    const verifyBadge = (page) =>
      page.evaluate((name) => {
        const row = [...document.querySelectorAll("#threads-list .thread-group-header-project")].find(
          (r) => r.querySelector(".thread-group-name")?.textContent?.trim() === name
        );
        return row?.querySelector(".thread-group-badges")?.textContent?.trim() || "";
      }, "VerifyProj");
    await api(relayPort, "POST", "/api/projects", { action: "unassign", thread_id: threadId });
    let unassignPropagated = false;
    try {
      // Unassigning MOVES the row, it does not remove it. This assertion used to
      // wait for the row to disappear, which was correct when a project group was
      // the whole list; under pinning a session that leaves a project falls back
      // into its own cwd group and stays on screen. Waiting for "gone" would now be
      // waiting for a session to be lost — the exact thing the design forbids.
      //
      // So: out of the pinned group, still in the list.
      //
      // Read via `data-thread-cwd`, which carries the row's GROUP cwd. The pinned
      // project group has an empty cwd (it is not a directory), so a non-empty
      // value is proof the row landed in a real folder group.
      //
      // NOT via `.closest(".thread-group")`: the list is virtualized FLAT, so a
      // header and its rows are siblings, and `.thread-group` is the header's own
      // class. closest() therefore returns null from any session row, and the
      // earlier form of this check — `!closest(...)?.querySelector(...)` — was
      // `!undefined`, i.e. true for every row that existed. It passed whether or
      // not the row had moved.
      await page.waitForFunction(
        (id) => {
          const row = document.querySelector(`#threads-list [data-thread-id="${id}"]`);
          // Still present: losing the row is the failure this exists to catch.
          if (!row) return false;
          return (row.getAttribute("data-thread-cwd") || "") !== "";
        },
        threadId,
        { timeout: TIMEOUT_MS }
      );
      unassignPropagated = true;
    } catch {}

    // 7b. An UNASSIGNED row must open into the Sessions context, not the project
    // that happens to be selected. Pinning is what made this reachable: the list
    // keeps every session, so an unassigned row now sits one click from a pinned
    // project at all times. Expressing "no project" as a null context let
    // `setThreadRoute` fall back to the current one, which filed the session into
    // that project's tab workspace and left the switcher still naming it.
    //
    // The switcher label is the observable: it reports the live context.
    let unassignedOpenedInSessions = null;
    if (unassignPropagated) {
      await page.click(`#threads-list [data-thread-id="${threadId}"]`, { timeout: TIMEOUT_MS });
      // Wait for the label rather than sleeping a fixed span — this is a POSITIVE
      // signal, so there is something to wait for. (The negative checks in steps 8
      // and 9 keep their fixed delay on purpose: "no placeholder ever appeared" has
      // no event to await, and polling for absence only polls luck.)
      //
      // Swallowed and re-read rather than left to time out, so a failure reports
      // WHICH project it wrongly adopted instead of an anonymous timeout.
      // Short timeout on purpose: this is a local state update that lands in well
      // under a second, and the wait is expected to EXPIRE when the bug is present.
      // Borrowing the 45s default would spend 45s reaching a failure it already knew.
      try {
        await page.waitForFunction(
          (expected) => document.querySelector(".project-switcher-trigger")?.textContent?.trim() === expected,
          ALL_SESSIONS_LABEL,
          { timeout: 8000 }
        );
      } catch {}
      unassignedOpenedInSessions = await page.evaluate(
        () => document.querySelector(".project-switcher-trigger")?.textContent?.trim() || ""
      );
    }

    const afterUnassignBadge = await verifyBadge(page);
    await api(relayPort, "POST", "/api/projects", { action: "assign", thread_id: threadId, project_id: projectId });

    step("8. fail OPEN on a failed fetch");

    // 8. Fail OPEN. This used to fail CLOSED — an error placeholder and no rows —
    // and that was right while selecting a project SWAPPED the grouping axis: an
    // unusable membership map would have mis-grouped the entire list.
    //
    // Pinning changed the calculus. A project is now lifted ON TOP of cwd grouping,
    // so an unresolved project id degrades to plain cwd grouping, which shows every
    // session correctly — just not yet lifted. The failure mode went from "the list
    // is wrong" to "the list is not yet sorted", and blanking a complete list for
    // the latter is the worse answer. What must NOT happen is a session vanishing.
    const failPage = await context.newPage();
    await failPage.route("**/api/projects*", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "boom" } }) });
      }
      return route.continue();
    });
    await failPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(failPage);
    await failPage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });
    await selectProjectInSwitcher(failPage, "VerifyProj").catch(() => {
      // Expected on this page: the projects GET fails, so the switcher can offer no
      // project to pin. The point of the step is what the LIST does about it.
    });
    // Give the (failing) fetch time to settle so this observes the resolved state
    // rather than the moment before it: with no placeholder to wait FOR, a bare
    // assertion here would pass trivially against the pre-click list.
    await delay(800);
    const failedFetch = await failPage.evaluate((id) => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      bodyText: document.querySelector("#threads-list")?.textContent?.trim() || "",
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      // The one thing that must survive: the session is still reachable.
      hasSessionRow: Boolean(document.querySelector(`#threads-list [data-thread-id="${id}"]`)),
      // No project group can be pinned when membership could not be fetched.
      projectHeaders: document.querySelectorAll("#threads-list .thread-group-header-project").length,
    }), threadId);
    await failPage.close();

    step("9. stay usable through a held refresh");

    // 9. A newer-revision fetch held in flight must NOT blank the list. Same reason
    // as step 8: the rows are all present and correct, only the pinning may be a
    // revision behind. The pinned group survives the refresh rather than the list
    // flashing empty and back — a sidebar that strobes on every project mutation is
    // worse than one that is briefly a revision stale.
    const gatePage = await context.newPage();
    let holdRefresh = false;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    await gatePage.route("**/api/projects*", async (route) => {
      if (route.request().method() === "GET" && holdRefresh) await refreshGate;
      return route.continue();
    });
    await gatePage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(gatePage);
    await gatePage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });
    await selectProjectInSwitcher(gatePage, "VerifyProj");
    holdRefresh = true;
    await api(relayPort, "POST", "/api/projects", { action: "create", name: "GateProj2" });
    // Long enough for a blanking regression to be observable: the old code swapped
    // to a placeholder as soon as `projectsLoading` flipped, which is immediate.
    await delay(800);
    const gatePending = await gatePage.evaluate((id) => ({
      countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
      groupLabels: [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      hasSessionRow: Boolean(document.querySelector(`#threads-list [data-thread-id="${id}"]`)),
    }), threadId);
    releaseRefresh();
    holdRefresh = false;
    await gatePage.waitForFunction(
      (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].map((n) => n.textContent.trim()).includes(name),
      "VerifyProj",
      { timeout: TIMEOUT_MS }
    );
    await gatePage.close();

    step("10. CRUD UI flows");

    // 10. CRUD UI: toolbar create + thread-menu assign/unassign/new + project-menu
    // rename/delete — the real user flows.
    const crudPage = await context.newPage();
    let nextPrompt = "";
    crudPage.on("dialog", (dialog) => { void dialog.accept(dialog.type() === "prompt" ? nextPrompt : undefined); });
    await crudPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(crudPage);
    await crudPage.waitForFunction(() => document.querySelectorAll("#threads-list .thread-group").length >= 1, null, { timeout: TIMEOUT_MS });

    let menuItems = [];
    let assignedMenuItems = [];
    let triggerValueBeforeAssign = null;
    let triggerValueAssigned = null;
    let triggerValueUnassigned = null;
    let assignConfirmed = null;
    let currentMarked = false;
    let unassignConfirmed = "unset";
    let menuCreateAssign = null;
    let renameConfirmed = false;
    let deleteConfirmed = false;
    let firstLevel = null;
    let geometry = null;
    let keyboardNav = null;
    try {
      step("10. crud flow: create UiCrudProj from the switcher menu");
      // The Projects toolbar and its create button went with the toggle — "New project"
      // is an entry in the switcher's own menu now, which is also the only place it can
      // live once there is no mode whose chrome could host it.
      await crudPage.waitForSelector(".project-switcher-trigger", { timeout: TIMEOUT_MS });
      nextPrompt = "UiCrudProj";
      await crudPage.click(".project-switcher-trigger", { timeout: TIMEOUT_MS });
      await crudPage.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
      await crudPage.locator(".project-switcher-create").first().click({ timeout: TIMEOUT_MS });
      await crudPage.waitForFunction(
        async (name) => {
          const response = await fetch("/api/projects");
          const data = await response.json();
          return (data.projects || []).some((project) => project.name === name);
        },
        "UiCrudProj",
        { timeout: TIMEOUT_MS }
      );
      const afterCreate = await api(relayPort, "GET", "/api/projects");
      const uiProjId = afterCreate.projects.find((p) => p.name === "UiCrudProj")?.id;
      assert.ok(uiProjId, `toolbar-created project id: ${JSON.stringify(afterCreate.projects.map((p) => p.name))}`);

      // Assign / unassign / new+assign via the THREAD context menu, from an unpinned
      // list — the row's own menu, not the switcher's.
      await selectDefaultWorkspaceInSwitcher(crudPage);
      step("10a. first level only (no flyout)");
      // Level one on its own: Projects are NOT here, just the trigger row naming one.
      firstLevel = await readThreadMenuFirstLevel(crudPage, threadId);
      triggerValueBeforeAssign = firstLevel.triggerValue;
      step("10b. hover-open the flyout and assign UiCrudProj");
      menuItems = await openThreadMenu(crudPage, threadId);
      geometry = await threadMenuGeometry(crudPage);
      await clickThreadProjectButton(crudPage, { exact: "UiCrudProj" });
      assignConfirmed = await waitForMembership(relayPort, threadId, uiProjId);
      assignedMenuItems = await waitForThreadMenuState(crudPage, threadId, (labels) =>
        labels.some((t) => t.startsWith("✓ UiCrudProj"))
      );
      // The trigger row names the session's project without opening the flyout.
      triggerValueAssigned = await threadProjectTriggerValue(crudPage);
      currentMarked = true;

      step("10c. keyboard: ArrowRight into the flyout, Escape peels one level at a time");
      // Escape #1 closes only the flyout and returns focus to the trigger; ArrowRight
      // re-enters it and lands on the first row; Escape #1 again, #2 closes the menu.
      await openThreadMenu(crudPage, threadId);
      await crudPage.keyboard.press("Escape");
      const afterFirstEscape = await crudPage.evaluate(() => ({
        submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
        menuStillOpen: !document.querySelector("#thread-context-menu")?.hidden,
        focusOnTrigger: document.activeElement?.id === "thread-project-submenu-trigger",
      }));
      await crudPage.keyboard.press("ArrowRight");
      const afterArrowRight = await crudPage.evaluate(() => ({
        submenuOpen: !document.querySelector("#thread-project-submenu")?.hidden,
        focusInsideSubmenu: !!document.activeElement?.closest("#thread-project-submenu"),
        // role="menu" on the panel obliges its rows to be menuitems.
        rowsAreMenuItems: [...document.querySelectorAll("#thread-project-actions button")].every(
          (b) => ["menuitem", "menuitemradio"].includes(b.getAttribute("role"))
        ),
      }));
      // ArrowLeft walks back out to the trigger without dismissing the whole menu.
      await crudPage.keyboard.press("ArrowLeft");
      const afterArrowLeft = await crudPage.evaluate(() => ({
        submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
        menuStillOpen: !document.querySelector("#thread-context-menu")?.hidden,
        focusOnTrigger: document.activeElement?.id === "thread-project-submenu-trigger",
      }));
      await crudPage.keyboard.press("ArrowRight"); // back in, so Escape has a level to peel
      await crudPage.keyboard.press("Escape");
      await crudPage.keyboard.press("Escape");
      const afterSecondEscape = await crudPage.evaluate(() => ({
        menuHidden: !!document.querySelector("#thread-context-menu")?.hidden,
        submenuHidden: !!document.querySelector("#thread-project-submenu")?.hidden,
      }));
      keyboardNav = { afterFirstEscape, afterArrowRight, afterArrowLeft, afterSecondEscape };

      step("10d. remove from project");
      await openThreadMenu(crudPage, threadId);
      await clickThreadProjectButton(crudPage, { includes: "Remove from project" });
      unassignConfirmed = await waitForMembership(relayPort, threadId, null);
      // Back to no project: nothing is checked, and the trigger row says so.
      await waitForThreadMenuState(crudPage, threadId, (labels) => !labels.some((t) => t.startsWith("✓")));
      triggerValueUnassigned = await threadProjectTriggerValue(crudPage);

      step("10e. new project from the flyout");
      await openThreadMenu(crudPage, threadId);
      nextPrompt = "UiMenuProj";
      await clickThreadProjectButton(crudPage, { includes: "New project" });
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        const proj = data.projects.find((p) => p.name === "UiMenuProj");
        if (proj && data.thread_project_id[threadId] === proj.id) { menuCreateAssign = proj.id; break; }
        await delay(150);
      }

      // Rename + delete "UiCrudProj" via its header's menu. Its header exists only while
      // that project is pinned, which `openProjectMenu` handles by selecting it first.
      // Rename edits the name in place; no prompt.
      const renameTargetId = uiProjId;
      await openProjectMenu(crudPage, "UiCrudProj");
      await projectMenuRow(crudPage, "Rename…").click({ timeout: TIMEOUT_MS });
      await crudPage.fill("#threads-list .thread-group-name-input", "UiRenamedProj", { timeout: TIMEOUT_MS });
      await crudPage.press("#threads-list .thread-group-name-input", "Enter");
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        const renamed = data.projects.find((p) => p.id === renameTargetId);
        if (renamed && renamed.name === "UiRenamedProj") { renameConfirmed = true; break; }
        await delay(150);
      }
      await crudPage.waitForFunction(
        (name) => [...document.querySelectorAll("#threads-list .thread-group-name")].some((n) => n.textContent.trim() === name),
        "UiRenamedProj",
        { timeout: TIMEOUT_MS }
      );
      await openProjectMenu(crudPage, "UiRenamedProj");
      await projectMenuRow(crudPage, "Delete project…").click({ timeout: TIMEOUT_MS });
      // Its only session moved to UiMenuProj above, so there is nothing to confirm: it goes
      // at once and an Undo is offered instead.
      await crudPage.waitForSelector(".undo-toast", { timeout: TIMEOUT_MS });
      for (let i = 0; i < 100; i += 1) {
        const data = await api(relayPort, "GET", "/api/projects");
        if (!data.projects.some((p) => p.id === renameTargetId)) { deleteConfirmed = true; break; }
        await delay(150);
      }
    } finally {
      await crudPage.close();
    }

    step("11. thread-menu fail-closed");

    // 11. Thread-menu fail-closed (Sessions mode, GET fails): NO actionable Project
    // buttons, only a non-interactive "unavailable" note.
    const menuFailPage = await context.newPage();
    await menuFailPage.route("**/api/projects*", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "boom" } }) });
      }
      return route.continue();
    });
    await menuFailPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(menuFailPage);
    const menuFailTarget = menuFailPage.locator(`#threads-list [data-thread-id="${threadId}"]`);
    await menuFailTarget.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await menuFailTarget.click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
    await menuFailPage.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
    await openThreadProjectSubmenu(menuFailPage);
    await menuFailPage.waitForFunction(() => {
      const submenu = document.querySelector("#thread-project-submenu");
      const note = document.querySelector("#thread-project-actions .context-menu-note");
      return submenu && !submenu.hidden && !!note;
    }, null, { timeout: TIMEOUT_MS });
    const menuFailClosed = await menuFailPage.evaluate(() => ({
      buttonCount: document.querySelectorAll("#thread-project-actions button").length,
      note: document.querySelector("#thread-project-actions .context-menu-note")?.textContent?.trim() || null,
      // Must NOT read "None" — that would assert non-membership we can't vouch for.
      triggerValue: document.querySelector("#thread-project-current-label")?.textContent?.trim() || null,
    }));
    await menuFailPage.close();

    step("12. open thread-menu goes stale");

    // 12. Open thread-menu goes stale: a held newer-revision refresh withdraws buttons.
    const staleMenuPage = await context.newPage();
    let holdMenuRefresh = false;
    let releaseMenuRefresh;
    const menuRefreshGate = new Promise((resolve) => { releaseMenuRefresh = resolve; });
    await staleMenuPage.route("**/api/projects*", async (route) => {
      if (route.request().method() === "GET" && holdMenuRefresh) await menuRefreshGate;
      return route.continue();
    });
    await staleMenuPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openDrawer(staleMenuPage);
    const staleTarget = staleMenuPage.locator(`#threads-list [data-thread-id="${threadId}"]`);
    await staleTarget.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await staleTarget.click({ button: "right", position: { x: 24, y: 16 }, timeout: TIMEOUT_MS });
    await staleMenuPage.waitForSelector("#thread-context-menu:not([hidden]) #thread-project-submenu-trigger", { timeout: TIMEOUT_MS });
    await openThreadProjectSubmenu(staleMenuPage);
    await staleMenuPage.waitForFunction(
      () => { const submenu = document.querySelector("#thread-project-submenu"); return submenu && !submenu.hidden && document.querySelectorAll("#thread-project-actions button").length > 0; },
      null,
      { timeout: TIMEOUT_MS }
    );
    holdMenuRefresh = true;
    await api(relayPort, "POST", "/api/projects", { action: "create", name: "StaleBump" });
    await staleMenuPage.waitForFunction(
      () => document.querySelectorAll("#thread-project-actions button").length === 0 && !!document.querySelector("#thread-project-actions .context-menu-note"),
      null,
      { timeout: TIMEOUT_MS }
    );
    const staleMenu = await staleMenuPage.evaluate(() => ({
      buttonCount: document.querySelectorAll("#thread-project-actions button").length,
      note: document.querySelector("#thread-project-actions .context-menu-note")?.textContent?.trim() || null,
      menuOpen: !document.querySelector("#thread-context-menu")?.hidden,
    }));
    releaseMenuRefresh();
    holdMenuRefresh = false;
    await staleMenuPage.close();

    console.log(JSON.stringify({
      sessionsView, projectsView, backToSessions,
      unassignPropagated, unassignedOpenedInSessions, afterUnassignBadge, failedFetch, gatePending,
      crud: { menuItems, assignedMenuItems, triggerValueBeforeAssign, triggerValueAssigned, triggerValueUnassigned, assignConfirmed, currentMarked, unassignConfirmed, menuCreateAssign, renameConfirmed, deleteConfirmed },
      submenu: { firstLevel, geometry, keyboardNav },
      menuFailClosed, staleMenu,
    }, null, 2));

    // --- Assertions ---
    // Computed, not declared: this is the assertion the stylesheet guard cannot
    // make, and the one that was silently false for a whole commit.
    assert.notEqual(
      hoverColours.plainHover,
      hoverColours.plainRest,
      `a menu row must change colour under the cursor: ${JSON.stringify(hoverColours)}`
    );
    assert.notEqual(
      hoverColours.plainHover,
      hoverColours.menu,
      `the hover highlight must differ from the menu it sits on: ${JSON.stringify(hoverColours)}`
    );
    assert.notEqual(
      hoverColours.activeHover,
      hoverColours.activeRest,
      `the SELECTED row must react too, or it is the one row that goes dead: ${JSON.stringify(hoverColours)}`
    );

    assert.ok(projectsView.projectRows.includes("VerifyProj"), "the selected project is pinned as a group");
    // The count describes FOLDERS and sessions, not projects: a pinned project is
    // lifted on top of cwd grouping rather than replacing it, and the pinned group
    // is deliberately not counted as a folder (it is not one).
    assert.match(
      projectsView.countText,
      /folder/,
      `a pinned project still counts folders, not projects: ${projectsView.countText}`
    );
    assert.ok(
      projectsView.hasAssignedSession,
      `the assigned session shows under its pinned project: ${JSON.stringify(projectsView.projectRows)}`
    );
    assert.ok(projectsView.hasActionsButton, "each project header exposes visible action buttons (touch/keyboard reachable)");
    assert.ok(projectsView.pinnedFirst, "the pinned project's group leads the list");
    assert.ok(backToSessions.noProjectGroup, "and choosing the default workspace unpins it");
    assert.match(backToSessions.countText, /folder/, `back to Sessions shows folder grouping: ${backToSessions.countText}`);
    assert.ok(
      unassignPropagated,
      `an API unassign moves the row OUT of the pinned group while keeping it in the list: ${afterUnassignBadge}`
    );
    assert.equal(
      unassignedOpenedInSessions,
      ALL_SESSIONS_LABEL,
      `opening an unassigned row must leave the selected project, not adopt it into P's tab set: ${unassignedOpenedInSessions}`
    );

    // Fail OPEN, and the assertion that matters is the negative one: no session is
    // lost. A placeholder here would now be a regression, not a safeguard.
    assert.ok(
      failedFetch.hasSessionRow,
      `a failed Projects fetch must not cost the list a session: ${failedFetch.bodyText}`
    );
    assert.ok(
      failedFetch.groupLabels.length > 0,
      `a failed Projects fetch still renders cwd groups: ${JSON.stringify(failedFetch.groupLabels)}`
    );
    assert.equal(
      failedFetch.projectHeaders,
      0,
      "nothing can be pinned when membership could not be fetched"
    );
    assert.doesNotMatch(
      failedFetch.countText,
      /unavailable|Loading/i,
      `no placeholder replaces a list that is entirely intact: ${failedFetch.countText}`
    );

    // A refresh in flight must not strobe the list. Being one revision stale about
    // WHICH project is pinned is invisible; blanking every row is not.
    assert.ok(
      gatePending.hasSessionRow,
      "a pending Projects refresh keeps every session on screen"
    );
    assert.ok(
      gatePending.groupLabels.includes("VerifyProj"),
      `the pinned group survives a refresh in flight: ${JSON.stringify(gatePending.groupLabels)}`
    );
    assert.doesNotMatch(
      gatePending.countText,
      /unavailable|Loading/i,
      `no placeholder while a refresh is in flight: ${gatePending.countText}`
    );

    assert.ok(menuItems.some((t) => t.replace(/^✓\s*/, "") === "UiCrudProj"), `thread menu lists the toolbar-created project: ${JSON.stringify(menuItems)}`);
    assert.ok(assignConfirmed, "assigning via the thread menu recorded membership server-side");
    assert.ok(currentMarked, "the assigned project is marked current (✓) on reopen");
    // Second-level menu contract: the session's own project leads the flyout, and the
    // first-level row names it without opening anything.
    assert.match(
      assignedMenuItems[0] || "",
      /^✓ UiCrudProj$/,
      `the session's own project leads the flyout: ${JSON.stringify(assignedMenuItems)}`
    );
    assert.equal(triggerValueAssigned, "UiCrudProj", `the trigger row names the session's project: ${triggerValueAssigned}`);
    assert.notEqual(triggerValueBeforeAssign, "UiCrudProj", "the trigger row didn't already claim the target project");
    assert.equal(triggerValueUnassigned, "None", `after Remove, the trigger row reads None: ${triggerValueUnassigned}`);

    // Projects live one level DOWN: the menu itself shows only the trigger row.
    assert.equal(firstLevel.submenuHidden, true, "the flyout starts closed on a fresh right-click");
    assert.equal(
      firstLevel.visibleProjectButtons,
      0,
      `no Project rows are on screen at the first level: ${firstLevel.visibleProjectButtons}`
    );
    assert.equal(
      firstLevel.menuButtonLabels.filter((label) => label.startsWith("Project")).length,
      1,
      `exactly one Project row at the first level: ${JSON.stringify(firstLevel.menuButtonLabels)}`
    );
    // That single row carries the session's project name (label + value concatenated).
    assert.match(
      firstLevel.menuButtonLabels.find((label) => label.startsWith("Project")) || "",
      new RegExp(`^Project${firstLevel.triggerValue}$`),
      `the Project row names the current project: ${JSON.stringify(firstLevel)}`
    );
    assert.ok(
      firstLevel.triggerValue && firstLevel.triggerValue !== "None",
      `the seeded session shows its project at the first level: ${firstLevel.triggerValue}`
    );

    assert.equal(geometry.insideViewport, true, `the flyout stays on screen: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.horizontallyClear, true, `the flyout sits beside the menu, not over it: ${JSON.stringify(geometry)}`);

    assert.deepEqual(
      keyboardNav.afterFirstEscape,
      { submenuHidden: true, menuStillOpen: true, focusOnTrigger: true },
      `Escape peels the flyout only, handing focus back to the trigger: ${JSON.stringify(keyboardNav.afterFirstEscape)}`
    );
    assert.deepEqual(
      keyboardNav.afterArrowRight,
      { submenuOpen: true, focusInsideSubmenu: true, rowsAreMenuItems: true },
      `ArrowRight enters the flyout and focuses a row: ${JSON.stringify(keyboardNav.afterArrowRight)}`
    );
    assert.deepEqual(
      keyboardNav.afterArrowLeft,
      { submenuHidden: true, menuStillOpen: true, focusOnTrigger: true },
      `ArrowLeft leaves the flyout without closing the menu: ${JSON.stringify(keyboardNav.afterArrowLeft)}`
    );
    assert.deepEqual(
      keyboardNav.afterSecondEscape,
      { menuHidden: true, submenuHidden: true },
      `a second Escape closes the menu itself: ${JSON.stringify(keyboardNav.afterSecondEscape)}`
    );
    assert.equal(unassignConfirmed, null, "removing via the thread menu cleared membership server-side");
    assert.ok(menuCreateAssign, "'New project…' both creates the project and assigns the session");
    assert.ok(renameConfirmed, "renaming via the project context menu updates the name server-side");
    assert.ok(deleteConfirmed, "deleting via the project context menu removes the project server-side");

    assert.equal(menuFailClosed.buttonCount, 0, `no Project mutation buttons while the fetch is failing: ${menuFailClosed.buttonCount}`);
    assert.match(menuFailClosed.note || "", /Projects unavailable|Loading projects/, `a fail-closed note replaces the controls: ${menuFailClosed.note}`);
    assert.match(
      menuFailClosed.triggerValue || "",
      /Unavailable|Loading/,
      `the trigger row shows a status word, never "None", while the payload is untrustworthy: ${menuFailClosed.triggerValue}`
    );

    assert.equal(staleMenu.buttonCount, 0, `an open thread menu withdraws its buttons on a pending refresh: ${staleMenu.buttonCount}`);
    assert.match(staleMenu.note || "", /Loading projects/, `the open thread menu falls closed to a loading note: ${staleMenu.note}`);
    assert.ok(staleMenu.menuOpen, "the thread menu stays open while its controls are withdrawn");

    console.log("PROJECTS_TOGGLE_E2E: PASS");
  } catch (error) {
    console.error("PROJECTS_TOGGLE_E2E: FAIL");
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
