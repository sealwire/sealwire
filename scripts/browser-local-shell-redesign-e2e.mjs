// Drives the local web UI to verify the shell redesign: the far-left icon rail, the
// consolidated Settings modal (Providers/Devices/Access/Log), Settings reachability
// on a narrow (mobile) viewport, the project actions menu (visible button + right-click),
// the icon-rail folder re-expanding a collapsed sidebar, and the live footer status.
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-shell-redesign-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

// Open the sessions/projects <details> drawer so its list rows are laid out (it's
// collapsed off the conversation view).
async function openThreadDrawer(page) {
  await page.evaluate(() => {
    const d = document.querySelector(".sidebar-drawer");
    if (d && !d.open) {
      d.open = true;
      d.dispatchEvent(new Event("toggle"));
    }
  });
}

// Pick a project in the switcher above the tab strip. Exactly one project is
// pinned at a time, so its header — and the rename/delete affordances on it —
// exist only while it is the selection; this is the way to any other project.
// "New project" moved into the switcher's own menu when the Projects toolbar went with
// the Sessions/Projects toggle. Three call sites, one path.
async function createProjectFromSwitcher(page) {
  await page.waitForSelector(".project-switcher-trigger", { timeout: TIMEOUT_MS });
  const alreadyOpen = await page.evaluate(
    () => document.querySelector(".project-switcher-trigger")?.getAttribute("aria-expanded") === "true"
  );
  if (!alreadyOpen) {
    await page.click(".project-switcher-trigger", { timeout: TIMEOUT_MS });
  }
  await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
  await page.locator(".project-switcher-create").first().click({ timeout: TIMEOUT_MS });
}

// Scoped to the header's own menu: the session menu also has a (hidden) "Rename…".
const headerMenuRow = (page, label) =>
  page.locator('.context-menu[aria-label^="Project "] .context-menu-button', { hasText: label }).first();

// Rename the pinned project in place, once its header's menu is open.
async function renameFromHeaderMenu(page, name) {
  await headerMenuRow(page, "Rename…").click({ timeout: TIMEOUT_MS });
  await page.fill("#threads-list .thread-group-name-input", name, { timeout: TIMEOUT_MS });
  await page.press("#threads-list .thread-group-name-input", "Enter");
}

// Right-click a project's header and delete it. A project with sessions asks first, in
// the menu itself; an empty one goes at once.
async function deleteFromHeader(page, name) {
  await page
    .locator("#threads-list .thread-group-header-project", { hasText: name })
    .first()
    .click({ button: "right" });
  await headerMenuRow(page, "Delete project…").click({ timeout: TIMEOUT_MS });
  const confirm = page.locator(".context-menu .context-menu-confirm-danger");
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click({ timeout: TIMEOUT_MS });
  }
}

// The switcher's way back to an unpinned list.
async function selectDefaultWorkspaceInSwitcher(page) {
  await page.waitForSelector(".project-switcher-trigger", { timeout: TIMEOUT_MS });
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
    { timeout: TIMEOUT_MS }
  );
}

async function selectProjectInSwitcher(page, name) {
  await page.waitForSelector(".project-switcher-trigger", { state: "attached", timeout: TIMEOUT_MS });
  // Read-then-act: blind-toggling would CLOSE an already-open menu and hang the
  // option wait below for the full timeout.
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

async function run() {
  const relayPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shell-redesign-e2e-"));
  const relay = startLocalRelay({
    relayPort,
    relayStateDb: path.join(tmp, "sealwire.db"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser();
    browser = launched.browser;
    const page = await launched.context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    let promptValue = "Alpha Project";
    page.on("dialog", async (d) => {
      await d.accept(d.type() === "prompt" ? promptValue : undefined);
    });

    // --- The sidebar has chrome BEFORE the relay answers ---
    // The nav, search toggle and bell are rendered into mounts by render-session, and
    // `boot()` does not reach its first render until `loadSession` has returned. The shell's own synchronous render paints only empty mounts, so
    // without an explicit paint at module scope the sidebar is chromeless for the whole
    // round trip — unbounded if the relay is slow or down.
    //
    // A separate page with `/api/session` held open makes that window wide enough to
    // observe. It has to be its own page: stalling the shared one would poison every
    // assertion below it.
    const slowPage = await launched.context.newPage();
    const SESSION_STALL_MS = 4000;
    await slowPage.route("**/api/session**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, SESSION_STALL_MS));
      // The handler outlives the page: the assertions below finish long before the stall
      // does, and closing the page makes the pending route unroutable. An uncaught throw
      // here becomes an UNHANDLED REJECTION that kills the whole suite with
      // "Route is already handled!" — a failure that looks nothing like the thing being
      // tested, and which masked this assertion entirely the first time round.
      try {
        await route.continue();
      } catch {
        // The page went away while this request was parked. Nothing to continue.
      }
    });
    await slowPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await slowPage.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });

    // `.local-frame` is NOT a signal that the chrome has had a chance to render. It comes
    // from the 18 KB ENTRY chunk, which runs to completion before DOMContentLoaded; the
    // paint lives in `app.js`, a ~194 KB chunk pulled in afterwards by
    // `void import("./app.js")` and absent from index.html's modulepreload list. So
    // asserting immediately after `waitForSelector` races a 194 KB fetch+parse against two
    // CDP round trips — it wins on a warm cache and loses cold, and its failure looks
    // EXACTLY like the bug it guards ("the sidebar has no destinations"). That is the worst
    // kind of guard: when it goes red you cannot tell product from test.
    //
    // Waiting for the chrome itself costs nothing in the passing case and does not weaken
    // the assertion, because the wait must expire well inside the stall — see below.
    const BOOT_CHROME_WAIT_MS = 3000;
    assert.ok(
      BOOT_CHROME_WAIT_MS < SESSION_STALL_MS,
      `the wait (${BOOT_CHROME_WAIT_MS}ms) must expire while /api/session is still stalled `
        + `(${SESSION_STALL_MS}ms), or "the chrome arrived before the relay answered" proves nothing`
    );
    await slowPage
      .waitForSelector('.sidebar-nav [data-destination="sessions"]', {
        timeout: BOOT_CHROME_WAIT_MS,
      })
      // Swallowed on purpose: the snapshot below names every missing piece, which is a far
      // better failure message than a bare selector timeout.
      .catch(() => {});

    const bootChrome = await slowPage.evaluate(() => ({
      // Named individually: counting would let "one destination" pass as "has a nav".
      sessions: !!document.querySelector('.sidebar-nav [data-destination="sessions"]'),
      tasks: !!document.querySelector('.sidebar-nav [data-destination="tasks"]'),
      railSessions: !!document.querySelector('.icon-rail [data-destination="sessions"]'),
      railTasks: !!document.querySelector('.icon-rail [data-destination="tasks"]'),
      searchToggle: !!document.querySelector(".sidebar-search-toggle"),
      bellToggle: !!document.querySelector(".sidebar-bell-toggle"),
    }));
    // Closed without unrouting: the stalled handler is left to time out on its own and
    // swallow its own error (see the try/catch above). Unrouting here would resolve the
    // pending route and race the same "already handled" throw.
    await slowPage.close();
    assert.ok(
      bootChrome.sessions && bootChrome.tasks,
      `the sidebar needs both destinations before the relay answers: ${JSON.stringify(bootChrome)}`
    );
    assert.ok(
      bootChrome.railSessions && bootChrome.railTasks,
      "the collapsed rail is the whole nav, and boots collapsed for anyone who quit that "
        + `way — it cannot wait for the network: ${JSON.stringify(bootChrome)}`
    );
    assert.ok(
      bootChrome.searchToggle && bootChrome.bellToggle,
      `the top-bar controls must exist before the relay answers: ${JSON.stringify(bootChrome)}`
    );

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(500);

    // --- Icon rail: mounted, but only SHOWN while the sidebar is collapsed ---
    // The rail's Projects folder was retired: the one job only it did — bringing a
    // collapsed nav panel back — belongs to #toggle-left-panel (asserted below).
    // The seal logo and the gear also live in the sidebar while it is open, so an
    // expanded rail would render both of them twice.
    //
    // What the rail DOES carry is the sidebar's navigation, because while the panel
    // is collapsed the rail is the only navigation on screen. Both destinations, or
    // a collapsed user cannot reach one of them at all.
    //
    // This assertion counted 1 (gear only) for a while after Tasks was added to the
    // rail, so it was red on main before Sessions joined it. Naming each occupant
    // rather than only counting them is what keeps a miscount from reading as an
    // arbitrary number to bump.
    const rail = await page.evaluate(() => {
      const r = document.querySelector(".icon-rail");
      return {
        present: !!r,
        visible: r ? getComputedStyle(r).display !== "none" : false,
        hasLogo: !!r?.querySelector(".icon-rail-logo"),
        hasHome: !!r?.querySelector("#icon-rail-home"),
        // Addressed by `data-destination`, not by id: the rail's two buttons come
        // from the shared SidebarNavRail now, and a shared component cannot carry
        // ids that would collide the moment remote mounts it too.
        hasSessions: !!r?.querySelector('[data-destination="sessions"]'),
        hasTasks: !!r?.querySelector('[data-destination="tasks"]'),
        hasUsage: !!r?.querySelector('[data-destination="usage"]'),
        hasGear: !!r?.querySelector("#icon-rail-settings"),
        buttons: r ? r.querySelectorAll("button").length : 0,
      };
    });
    assert.ok(rail.present && rail.hasLogo && rail.hasGear, `icon rail: ${JSON.stringify(rail)}`);
    assert.equal(rail.hasHome, false, `the rail's Projects folder is retired: ${JSON.stringify(rail)}`);
    // Collapsed, the rail IS the whole nav, so it has to offer every destination —
    // a subset strands the ones it leaves out, which is the bug the Sessions button
    // was added to fix. `usage` joined `sessions` and `tasks` as a third destination
    // (see SIDEBAR_NAV_DESTINATIONS) and this had not caught up: it checked two and
    // then pinned the count at three, so the new one was both unasserted and, via the
    // count, actively refused.
    assert.ok(
      rail.hasSessions && rail.hasTasks && rail.hasUsage,
      `collapsed, the rail is the whole nav — it needs every destination: ${JSON.stringify(rail)}`
    );
    // One button per destination, plus the gear (which is not a destination — it
    // opens a modal). Adding a destination should move this number.
    assert.equal(
      rail.buttons,
      4,
      `icon rail is Sessions + Tasks + Usage + gear: ${JSON.stringify(rail)}`
    );
    assert.equal(rail.visible, false, `an expanded sidebar hides the rail: ${JSON.stringify(rail)}`);

    // The brand and Settings the rail used to carry are on the open sidebar.
    const expandedChrome = await page.evaluate(() => ({
      brandLogo: !!document.querySelector(".sidebar-brand .sidebar-brand-logo"),
      footerGear: !!document.querySelector("#sidebar-host-status #sidebar-settings"),
    }));
    assert.ok(
      expandedChrome.brandLogo && expandedChrome.footerGear,
      `expanded sidebar owns brand + Settings: ${JSON.stringify(expandedChrome)}`
    );

    // --- Settings modal + tabs (desktop entry: sidebar footer gear) ---
    await page.click("#sidebar-settings");
    await page.waitForFunction(() => document.querySelector("#settings-modal")?.open, { timeout: TIMEOUT_MS });
    for (const tab of ["providers", "devices", "access", "log"]) {
      await page.click(`#settings-tab-${tab}`);
      const ok = await page.evaluate((t) => {
        const panel = document.querySelector(`[data-settings-panel="${t}"]`);
        const others = [...document.querySelectorAll("[data-settings-panel]")].filter(
          (p) => p.getAttribute("data-settings-panel") !== t
        );
        return panel && !panel.hidden && others.every((p) => p.hidden);
      }, tab);
      assert.ok(ok, `settings tab "${tab}" activates its panel`);
    }
    // The controls the pairing and allowed-roots harnesses drive.
    const controlsOk = await page.evaluate(() =>
      ["#paired-devices-list", "#start-pairing-button", "#allowed-roots-list", "#add-allowed-root-button"].every(
        (s) => !!document.querySelector(s)
      )
    );
    assert.ok(controlsOk, "Devices and Access expose the pairing / roots controls");
    await page.click("#close-settings-modal");
    await page.waitForFunction(() => !document.querySelector("#settings-modal")?.open);

    // --- Footer status reflects the live SSE stream (connected -> Live) ---
    const footer = await page.evaluate(() => {
      const el = document.querySelector("#sidebar-host-status");
      return { text: document.querySelector("#sidebar-host-label")?.textContent || "", degraded: el?.classList.contains("is-degraded") };
    });
    assert.ok(/Live/.test(footer.text) && !footer.degraded, `footer live while stream connected: ${JSON.stringify(footer)}`);

    // --- A collapsed sidebar can be brought back ---
    // This used to go through the icon rail's folder. That button is gone, so the
    // header's panel toggle is now the only way back — which makes this assertion
    // more important, not less: it is the sole escape from a collapsed sidebar.
    // It is rendered only while `body.sidebar-collapsed`, so it cannot be clicked
    // before the collapse lands.
    await page.click("#sidebar-top-toggle");
    await page.waitForFunction(() => document.body.classList.contains("sidebar-collapsed"), { timeout: TIMEOUT_MS });

    // Collapsed, the rail is the ONLY brand and the only Settings entry left: the
    // sidebar that holds the replacements is `visibility: hidden` in this exact
    // state, so if the rail stayed hidden here the window would have neither.
    const collapsedRail = await page.evaluate(() => {
      const r = document.querySelector(".icon-rail");
      return {
        visible: r ? getComputedStyle(r).display !== "none" : false,
        gearHittable: !!r?.querySelector("#icon-rail-settings")?.offsetParent,
      };
    });
    assert.ok(
      collapsedRail.visible && collapsedRail.gearHittable,
      `a collapsed sidebar restores the rail: ${JSON.stringify(collapsedRail)}`
    );

    await page.click("#toggle-left-panel");
    await page.waitForFunction(() => !document.body.classList.contains("sidebar-collapsed"), { timeout: TIMEOUT_MS });

    // --- Project actions: visible button opens the menu, Rename works ---
    // The Sessions/Projects toggle and its toolbar are gone: "New project" is an entry
    // in the switcher's own menu, and the project's header exists only while that
    // project is PINNED — which creating it does.
    await openThreadDrawer(page);
    await createProjectFromSwitcher(page);
    await selectProjectInSwitcher(page, "Alpha Project");
    // A project's actions live behind the header's "⋯" and its right-click. The three
    // access paths this guards: visible/tappable, mouse (right-click), and keyboard.
    await page.waitForSelector("#threads-list .thread-group-header-project", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    const projectName = () =>
      page.evaluate(
        () => document.querySelector("#threads-list .thread-group-name")?.textContent || ""
      );

    // (a) the "⋯" button (keyboard/touch reachable) opens the menu; Rename edits in place
    await page.locator("#threads-list .thread-group-more").first().click();
    await renameFromHeaderMenu(page, "Beta Project");
    await page.waitForFunction(
      () => (document.querySelector("#threads-list .thread-group-name")?.textContent || "").includes("Beta"),
      { timeout: TIMEOUT_MS }
    );

    // (b) right-click on the project header opens the same menu (mouse path)
    await page.locator("#threads-list .thread-group-header-project").first().click({ button: "right" });
    await renameFromHeaderMenu(page, "Gamma Project");
    await page.waitForFunction(
      () => (document.querySelector("#threads-list .thread-group-name")?.textContent || "").includes("Gamma"),
      { timeout: TIMEOUT_MS }
    );
    assert.match(await projectName(), /Gamma/, "the header shows the renamed project");

    // (c) keyboard path: "⋯" is focusable, and F2 on the focused row renames, so
    // project management is not mouse-only.
    await page.locator("#threads-list .thread-group-more").first().focus();
    const moreFocusable = await page.evaluate(
      () => document.activeElement?.classList.contains("thread-group-more")
    );
    assert.ok(moreFocusable, "the actions button is keyboard-focusable on the project header");
    await page.locator("#threads-list .thread-group-header-project .thread-group-toggle").first().focus();
    await page.keyboard.press("F2");
    await page.waitForSelector("#threads-list .thread-group-name-input", { timeout: TIMEOUT_MS });
    await page.keyboard.press("Escape");

    // --- Deleting the selected project must not strand a stale selection ---
    // Add a sibling so there's something to fall back to after deletion.
    promptValue = "Second Project";
    await createProjectFromSwitcher(page);
    await page.waitForFunction(
      () => [...document.querySelectorAll("#threads-list .thread-group-name")].some((n) => /Second/.test(n.textContent || "")),
      { timeout: TIMEOUT_MS }
    );
    // Select "Gamma" so it's the active project entering the delete. Creating
    // "Second Project" just auto-selected IT, and only the selected project is
    // pinned as a header — so getting back to Gamma goes through the switcher.
    // That is the point of the control: it is the only way to reach a project that
    // is not the current one.
    await selectProjectInSwitcher(page, "Gamma Project");
    await page.waitForFunction(
      () =>
        document
          .querySelector("#threads-list .thread-group-header-project.is-active .thread-group-name")
          ?.textContent?.trim() === "Gamma Project",
      { timeout: TIMEOUT_MS }
    );
    // Delete it -> the selection CLEARS. This used to assert that the sibling "Second
    // Project" auto-selected instead. That behaviour went with the Sessions/Projects
    // toggle: it existed so entering Projects mode always had something to show, and
    // with no mode to enter, landing you in an arbitrary surviving project would be the
    // sidebar choosing a container on your behalf. No selection means the default
    // workspace, which is a real destination.
    // Record every routed context for the duration of the delete. The END state cannot
    // tell the two candidate behaviours apart: navigating to a surviving project and
    // then having `dropStaleProjectSelection` clear it lands in exactly the same place
    // as never navigating at all. Only the TRANSIT differs — and a user sees it as a
    // flash of someone else's session list. Verified: with the survivor branch restored,
    // every end-state assertion below still passes and this one fails.
    const deletedProjectId = await page.evaluate(
      () => document.querySelector("#threads-list .thread-group-header-project")?.dataset.projectId || null
    );
    assert.ok(deletedProjectId, "the project about to be deleted is the pinned one");
    await page.evaluate(() => {
      window.__routedContexts = [];
      for (const name of ["pushState", "replaceState"]) {
        const original = history[name].bind(history);
        history[name] = (state, title, url) => {
          window.__routedContexts.push(state?.context ?? null);
          return original(state, title, url);
        };
      }
    });

    await deleteFromHeader(page, "Gamma");
    // Settle on the REFRESHED switcher, not on the header disappearing. "No project
    // header" is also true for a frame in the middle of the refetch, so waiting for it
    // can pass against a fallback navigation that has not run yet — and then the next
    // step selects the survivor anyway, hiding the difference completely.
    await page.click(".project-switcher-trigger");
    await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () => {
        const options = [...document.querySelectorAll(".project-switcher-option")]
          .map((node) => node.querySelector(".project-switcher-option-label")?.textContent?.trim() || "");
        return options.includes("Second Project") && !options.includes("Gamma Project");
      },
      { timeout: TIMEOUT_MS }
    );
    const afterDelete = await page.evaluate(() => ({
      activeOption:
        document
          .querySelector(".project-switcher-option.is-active")
          ?.querySelector(".project-switcher-option-label")
          ?.textContent?.trim() || null,
      routedProjectId: window.history.state?.context?.projectId || null,
      projectHeaders: document.querySelectorAll("#threads-list .thread-group-header-project").length,
    }));
    await page.keyboard.press("Escape");

    // A survivor EXISTS at this point, which is the whole point: deleting the project
    // you are in returns you to the default workspace rather than to whichever project
    // happens to sort first.
    assert.equal(
      afterDelete.routedProjectId,
      null,
      `deleting the selected project must land in the default workspace, got ${afterDelete.routedProjectId}`
    );
    assert.equal(afterDelete.activeOption, "All sessions", "and the menu says so");
    assert.equal(afterDelete.projectHeaders, 0, "with no project pinned in the list");

    const strayed = await page.evaluate(
      (deleted) =>
        (window.__routedContexts || [])
          .map((context) => context?.projectId || null)
          .filter((id) => id && id !== deleted),
      deletedProjectId
    );
    assert.deepEqual(
      strayed,
      [],
      `deleting a project must not route through another one on the way out, got ${JSON.stringify(strayed)}`
    );

    // Delete the remaining project too. Its header exists only while it is pinned, so
    // reaching it goes through the switcher — which is the point of the control.
    await selectProjectInSwitcher(page, "Second Project");
    await deleteFromHeader(page, "Second");
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#threads-list .thread-group-header-project").length === 0
        && !document.querySelector("#threads-list .thread-group-header-project.is-active"),
      { timeout: TIMEOUT_MS }
    );
    // A newly-created project auto-selects (the stale id no longer blocks it).
    promptValue = "Fresh Project";
    await createProjectFromSwitcher(page);
    await page.waitForFunction(
      () => {
        const active = document.querySelector("#threads-list .thread-group-header-project.is-active .thread-group-name")?.textContent?.trim();
        return active === "Fresh Project";
      },
      { timeout: TIMEOUT_MS }
    );

    // --- A late-resolving delete must not overrule where you went meanwhile ---
    // The delete decides where to leave you. Deciding at CONFIRM time makes that
    // decision outlive the request: the switcher stays interactive for the whole round
    // trip, so a user who deletes A and then picks B gets yanked back out of B when the
    // response lands. The window is one network round trip, which is exactly long
    // enough for a phone on a slow link.
    promptValue = "Race Project";
    await createProjectFromSwitcher(page);
    await page.waitForFunction(
      () =>
        document.querySelector("#threads-list .thread-group-header-project.is-active .thread-group-name")
          ?.textContent?.trim() === "Race Project",
      { timeout: TIMEOUT_MS }
    );

    let releaseDelete;
    const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
    let gatingDelete = true;
    await page.route("**/api/projects", async (route) => {
      const request = route.request();
      if (gatingDelete && request.method() === "POST" && (request.postData() || "").includes('"delete"')) {
        gatingDelete = false;
        await deleteGate;
      }
      return route.continue();
    });

    await deleteFromHeader(page, "Race Project");

    // ...and while it is in flight, go somewhere else on purpose.
    await selectProjectInSwitcher(page, "Fresh Project");
    const survivorId = await page.evaluate(
      () => document.querySelector("#threads-list .thread-group-header-project")?.dataset.projectId || null
    );
    assert.ok(survivorId, "parked on the surviving project before releasing the delete");

    releaseDelete();
    // Open the menu FIRST, then wait for its refreshed contents. The previous version
    // required the menu to already be open inside the predicate — which selecting
    // "Fresh Project" had just closed — so it burned Playwright's default timeout on
    // every run and only ever reached the list through its own `.catch()`. It also
    // passed `{ timeout }` as the predicate's ARGUMENT rather than as options, so the
    // timeout it did wait was the default rather than the one written here.
    await page.click(".project-switcher-trigger");
    await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll(".project-switcher-option")]
          .map((node) => node.querySelector(".project-switcher-option-label")?.textContent?.trim() || "")
          .includes("Race Project"),
      undefined,
      { timeout: TIMEOUT_MS }
    );
    await page.keyboard.press("Escape");

    assert.equal(
      await page.evaluate(() => window.history.state?.context?.projectId || null),
      survivorId,
      "a delete that resolves late must not overrule a navigation made while it was in flight"
    );
    await page.unroute("**/api/projects");

    // --- Real SSE disconnect -> polling -> reconnect updates the footer status ---
    // Block the stream so the client falls back to /api/session polling (footer
    // "Polling"), then restore it so the stream reconnects (footer "Live").
    const streamPage = await launched.context.newPage();
    // Watch this page's errors too. They were collected only for `page`, so anything that
    // threw HERE was invisible: the footer assertion below would time out with no
    // indication that a render had died on the way to writing it. That is a bad failure to
    // debug, because a stalled footer looks like a stream-reconnect timing problem.
    const streamPageErrors = [];
    streamPage.on("pageerror", (err) => streamPageErrors.push(String(err)));
    streamPage.on("console", (msg) => {
      if (msg.type() === "error") streamPageErrors.push(`console: ${msg.text()}`);
    });
    const withStreamPageErrors = (message) =>
      streamPageErrors.length ? `${message} — page errors: ${streamPageErrors.join(" | ")}` : message;

    // `**/api/stream**`, NOT `**/api/stream`. The trailing `**` is load-bearing: the
    // client appends `surface_id`, `surface_generation` and `device_id` as query
    // parameters, each only when it has one (`frontend/session-stream.js`). Playwright
    // matches a glob against the FULL url, so the bare pattern misses
    // `/api/stream?surface_id=…` — and whether those params exist yet depends on how far
    // device-identity adoption has got, which made this test fail ~25% of the time with a
    // footer that correctly read "Live" because the stream had never actually been
    // blocked. `browser-local-view-only-models-e2e.mjs` already had this right.
    const STREAM_ROUTE = "**/api/stream**";
    let abortedStreamRequests = 0;
    await streamPage.route(STREAM_ROUTE, (route) => {
      abortedStreamRequests += 1;
      return route.abort();
    });
    await streamPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await streamPage.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    // Assert the BLOCK happened before asserting what it caused. Without this, the glob
    // bug surfaced as a 30-second timeout on an unrelated-looking footer assertion; a
    // route that matches nothing should fail saying exactly that.
    for (let waited = 0; abortedStreamRequests === 0 && waited < TIMEOUT_MS; waited += 100) {
      await streamPage.waitForTimeout(100);
    }
    assert.ok(
      abortedStreamRequests > 0,
      "the stream route matched nothing, so the stream was never blocked — the client "
        + "appends surface_id/device_id query params, so the glob needs a trailing **"
    );
    await streamPage
      .waitForFunction(
        () => {
          const el = document.querySelector("#sidebar-host-status");
          return (
            el?.classList.contains("is-degraded") &&
            /Polling/.test(document.querySelector("#sidebar-host-label")?.textContent || "")
          );
        },
        { timeout: TIMEOUT_MS }
      )
      .catch(async (error) => {
        // Say what the footer ACTUALLY held. "Timeout exceeded" alone cannot distinguish
        // "the stream never dropped" from "it dropped and nothing repainted the footer".
        const actual = await streamPage
          .evaluate(() => ({
            classes: document.querySelector("#sidebar-host-status")?.className ?? null,
            label: document.querySelector("#sidebar-host-label")?.textContent ?? null,
          }))
          .catch(() => null);
        throw new Error(
          withStreamPageErrors(
            `footer never went to Polling: ${JSON.stringify(actual)} (${error.message})`
          )
        );
      });
    await streamPage.unroute(STREAM_ROUTE);
    await streamPage.waitForFunction(
      () => {
        const el = document.querySelector("#sidebar-host-status");
        return (
          !el?.classList.contains("is-degraded") &&
          /Live/.test(document.querySelector("#sidebar-host-label")?.textContent || "")
        );
      },
      { timeout: TIMEOUT_MS }
    );
    await streamPage.close();

    // --- Mobile (narrow) viewport: rail hidden, header gear reaches Settings ---
    // Reload into a clean state so the stacked mobile layout puts the sticky header
    // near the top (the prior projects/drawer state would push it far down).
    // View context deliberately survives reload, so return to the default workspace
    // explicitly instead of relying on reload to unpin a preceding project.
    await selectDefaultWorkspaceInSwitcher(page);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(400);
    const mobile = await page.evaluate(() => {
      const rail = document.querySelector(".icon-rail");
      const railHidden = !rail || getComputedStyle(rail).display === "none" || rail.offsetParent === null;
      const gear = document.querySelector("#open-settings-header");
      const gearVisible = !!gear && getComputedStyle(gear).display !== "none";
      return { railHidden, gearVisible };
    });
    assert.ok(mobile.railHidden, "icon rail is hidden on narrow viewport");
    assert.ok(mobile.gearVisible, "header Settings gear is visible on narrow viewport");
    await page.click("#open-settings-header");
    await page.waitForFunction(() => document.querySelector("#settings-modal")?.open, { timeout: TIMEOUT_MS });
    await page.click("#settings-tab-log");
    const mobileLogOk = await page.evaluate(() => {
      const panel = document.querySelector('[data-settings-panel="log"]');
      return panel && !panel.hidden;
    });
    assert.ok(mobileLogOk, "Settings tabs switch on narrow viewport");

    // --- 320px: the Settings modal + its tab strip must not overflow horizontally ---
    await page.setViewportSize({ width: 320, height: 700 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".local-frame", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(300);
    await page.click("#open-settings-header");
    await page.waitForFunction(() => document.querySelector("#settings-modal")?.open, { timeout: TIMEOUT_MS });
    const narrow = await page.evaluate(() => {
      const modal = document.querySelector("#settings-modal");
      const tabs = document.querySelector(".settings-nav-items");
      return {
        modalOverflowsX: modal.scrollWidth > modal.clientWidth + 2,
        modalWithinViewport: Math.ceil(modal.getBoundingClientRect().right) <= window.innerWidth,
        // the section nav wraps rather than scrolls, so every section stays reachable
        tabsOverflowX: tabs ? tabs.scrollWidth > tabs.clientWidth + 2 : true,
      };
    });
    assert.ok(!narrow.modalOverflowsX, `settings modal must not overflow horizontally at 320px: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.modalWithinViewport, `settings modal fits the 320px viewport: ${JSON.stringify(narrow)}`);
    assert.ok(!narrow.tabsOverflowX, `settings tab strip wraps instead of overflowing at 320px: ${JSON.stringify(narrow)}`);

    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
    assert.equal(consoleErrors.length, 0, `console errors: ${consoleErrors.join(" | ")}`);

    console.log("browser-local-shell-redesign-e2e: PASS");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch((error) => {
  console.error("browser-local-shell-redesign-e2e: FAIL");
  console.error(error);
  process.exit(1);
});
