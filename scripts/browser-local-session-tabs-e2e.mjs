// Drives the local web UI to verify the per-project session tab strip: a started
// session appears as a tab, a second session adds a second tab, clicking a tab
// switches the viewed transcript, pinning floats a tab into the pinned zone, and
// closing removes the tab without deleting the session.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-session-tabs-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";
import { confirmThreadMenuRemoval } from "./e2e/harness/thread-menu.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
// A second tab bucket now means a second real PROJECT. It used to mean "Projects mode
// with nothing selected" — a context that only existed because a toggle could put you
// there, and which no longer has an entrance.
const TABS_PROJECT = "Tabs Project";
const SHOT_DIR = process.env.BROWSER_E2E_SHOT_DIR || "";

// The view route is the ONLY thing that puts a session on screen: with no `?thread=`
// the renderer shows the console home or a project overview, never the active
// conversation. So coherence is read from the route and the DOM — deliberately NOT
// from `active_thread_id`, which says nothing about what is displayed.
function coherence(page) {
  return page.evaluate(() => ({
    routedThreadId: new URL(window.location.href).searchParams.get("thread"),
    mainView: document.querySelector(".chat-shell")?.dataset.view || null,
    focusedTabThreadId:
      document.querySelector(".session-tab.is-focused")?.dataset.threadId || null,
    tabThreadIds: [...document.querySelectorAll(".session-tab")].map(
      (tab) => tab.dataset.threadId || ""
    ),
  }));
}

function assertCoherent(state, label) {
  const where = `route=${state.routedThreadId} view=${state.mainView} `
    + `focus=${state.focusedTabThreadId} tabs=${JSON.stringify(state.tabThreadIds)}`;

  if (state.routedThreadId) {
    // The route is how a tab gets opened, so a routed session with no tab means the
    // strip lost track of what is on screen.
    if (!state.tabThreadIds.includes(state.routedThreadId)) {
      throw new Error(`${label}: the routed session has no tab — ${where}`);
    }
    if (state.focusedTabThreadId !== state.routedThreadId) {
      throw new Error(`${label}: the highlight disagrees with the route — ${where}`);
    }
    // A routed session settles into the conversation view in BOTH directions, including
    // a read-only one: the view-only projection rewrites the rendered session's
    // active_thread_id to the viewed thread (local/view-only-thread.js), so
    // isViewingConversation ends up true. Reaching it is asynchronous — the projection
    // has to load first — which is why this is polled rather than sampled.
    if (state.mainView !== "conversation") {
      throw new Error(`${label}: a routed session is not rendered as a conversation — ${where}`);
    }
    return;
  }

  // No route means Home or a project overview is showing. Nothing is on screen for a
  // tab to be "current" for, so nothing may be highlighted — including when a relay
  // session is active, which is exactly where the old active-thread fallback lied.
  if (state.focusedTabThreadId) {
    throw new Error(`${label}: a tab claims focus while no session is routed — ${where}`);
  }
  // Cross-check against the renderer: with no view route the main area must not be a
  // conversation.
  //
  // Only this direction is asserted. The converse does NOT hold — the renderer's
  // `isViewingConversation` is `viewThreadId === active_thread_id`, so a routed but
  // NON-active session renders read-only inside the console view, and demanding
  // "route ⇒ conversation" would fail on every view-only tab.
  if (state.mainView === "conversation") {
    throw new Error(`${label}: a conversation is rendered with no session routed — ${where}`);
  }
}

/**
 * Wait until the strip, the route and the main area agree, then assert it.
 *
 * The invariant is EVENTUAL, not instantaneous: React renders asynchronously, and the
 * route is written inside a view transition, so sampling one moment after a navigation
 * catches a legitimate in-between frame. Polling still fails loudly — the final
 * assertion runs on the last sample if it never settles.
 */
async function waitForCoherent(page, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = await coherence(page);
  while (Date.now() < deadline) {
    try {
      assertCoherent(last, label);
      return last;
    } catch {
      await page.waitForTimeout(100);
      last = await coherence(page);
    }
  }
  assertCoherent(last, `${label} (never settled)`);
  return last;
}

// The sidebar no longer carries a `data-thread-view` mode — there is no mode. What a
// tab bucket belongs to is the routed CONTEXT: the default workspace, or a pinned
// project. Read from history state, which is what the tab workspaces are keyed on.
function sidebarViewMode(page) {
  return page.evaluate(() =>
    window.history.state?.context?.projectId ? "projects" : "sessions"
  );
}

// Pin a project from the switcher. Replaces `click("#threads-view-projects")`: with the
// toggle gone there is no project-less "Projects mode" to enter — a second tab bucket
// now means a second real project.
async function selectProjectInSwitcher(page, name) {
  await page.waitForSelector(".project-switcher-trigger", { state: "attached", timeout: TIMEOUT_MS });
  const alreadyOpen = await page.evaluate(
    () => document.querySelector(".project-switcher-trigger")?.getAttribute("aria-expanded") === "true"
  );
  if (!alreadyOpen) {
    await page.click(".project-switcher-trigger", { timeout: TIMEOUT_MS });
  }
  await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
  await projectSwitcherOption(page, name).click({ timeout: TIMEOUT_MS });
  await page.waitForFunction(
    (target) => window.history.state?.context?.projectId
      && [...document.querySelectorAll("#threads-list .thread-group-header-project .thread-group-name")]
        .some((node) => node.textContent.trim() === target),
    name,
    { timeout: TIMEOUT_MS }
  );
}

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
    () => !window.history.state?.context?.projectId,
    { timeout: TIMEOUT_MS }
  );
}

function tabState(page) {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".session-tab")];
    return {
      count: tabs.length,
      titles: tabs.map((tab) => tab.querySelector(".session-tab-title")?.textContent || ""),
      threadIds: tabs.map((tab) => tab.dataset.threadId || ""),
      pinned: tabs.map((tab) => tab.className.includes("is-pinned")),
      // The tab the next sidebar click will replace. Italic in the strip; the
      // data attribute exists so this can be asserted rather than eyeballed.
      previewThreadIds: tabs
        .filter((tab) => tab.dataset.preview === "true")
        .map((tab) => tab.dataset.threadId || ""),
      focusedThreadId:
        document.querySelector(".session-tab.is-focused")?.dataset.threadId || null,
      stripPresent: Boolean(document.querySelector(".session-tab-strip")),
    };
  });
}

async function clearTabPersistence(page) {
  await page.evaluate(async () => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("sealwire:tab-workspace:")) {
        window.localStorage.removeItem(key);
      }
    }
    await new Promise((resolve, reject) => {
      const request = window.indexedDB.deleteDatabase("sealwire-session-view");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error("failed to clear tab database"));
      request.onblocked = () => reject(new Error("tab database deletion was blocked"));
    });
  });
}

function persistedWorkspace(page, key) {
  return page.evaluate(
    (workspaceKey) =>
      new Promise((resolve, reject) => {
        const request = window.indexedDB.open("sealwire-session-view", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("tab-workspaces")) {
            request.result.createObjectStore("tab-workspaces", { keyPath: "key" });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("tab-workspaces")) {
            database.close();
            resolve(null);
            return;
          }
          const transaction = database.transaction("tab-workspaces", "readonly");
          const getRequest = transaction.objectStore("tab-workspaces").get(workspaceKey);
          getRequest.onsuccess = () => resolve(getRequest.result?.workspace || null);
          getRequest.onerror = () =>
            reject(getRequest.error || new Error("failed to read tab workspace"));
          transaction.oncomplete = () => database.close();
        };
        request.onerror = () =>
          reject(request.error || new Error("failed to open tab database"));
      }),
    key
  );
}

// The sessions list lives in a <details> drawer that is collapsed off the
// conversation view; open it so its rows are laid out and clickable.
async function openThreadDrawer(page) {
  await page.evaluate(() => {
    const drawer = document.querySelector(".sidebar-drawer");
    if (drawer && !drawer.open) {
      drawer.open = true;
      drawer.dispatchEvent(new Event("toggle"));
    }
  });
}

async function shoot(page, name) {
  if (!SHOT_DIR) {
    return;
  }
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
}

async function run() {
  const relayPort = await getFreePort();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-tabs-e2e-"));
  const workspaceDir = path.join(tmp, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(tmp, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  let browser;
  const pageErrors = [];
  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    const launched = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 800 } },
    });
    browser = launched.browser;
    const page = await launched.context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-session-tabs-e2e" });
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    // Project creation and delete both prompt; `promptValue` is what a prompt answers
    // with, and confirms are accepted.
    let promptValue = "";
    page.on("dialog", async (dialog) => {
      if (dialog.type() === "prompt") {
        await dialog.accept(promptValue);
        return;
      }
      await dialog.accept();
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    // --- The strip mounts even with nothing open ---
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });

    // --- A started session becomes a tab, without any explicit "open" click.
    // This is the path that has no viewThreadId, so it proves the strip tracks
    // whatever the main area is actually showing. ---
    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 1, {
      timeout: TIMEOUT_MS,
    });
    const first = await tabState(page);
    assert.equal(first.count, 1, "the started session shows as one tab");
    const threadA = first.threadIds[0];
    assert.ok(threadA, "the tab carries its thread id");
    assert.equal(first.focusedThreadId, threadA, "the started session's tab is focused");
    await shoot(page, "01-one-tab");

    // --- A second session adds a second tab and takes focus ---
    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 2, {
      timeout: TIMEOUT_MS,
    });
    const two = await tabState(page);
    const threadB = two.threadIds.find((id) => id !== threadA);
    assert.ok(threadB, "the second session has its own tab");
    assert.equal(two.focusedThreadId, threadB, "the newest session is focused");
    await shoot(page, "02-two-tabs");

    // --- Clicking a tab switches which session is viewed ---
    await page.click(`.session-tab[data-thread-id="${threadA}"] .session-tab-main`);
    await page.waitForFunction(
      (id) => document.querySelector(".session-tab.is-focused")?.dataset.threadId === id,
      threadA,
      { timeout: TIMEOUT_MS }
    );
    const routed = await page.evaluate(() => new URL(window.location.href).searchParams.get("thread"));
    assert.equal(routed, threadA, "focusing a tab routes the viewed thread");
    await shoot(page, "03-switched");

    // --- Pinning floats the tab to the front of the strip ---
    await page.click(`.session-tab[data-thread-id="${threadB}"] .session-tab-pin`);
    await page.waitForFunction(
      (id) => document.querySelector(".session-tab")?.dataset.threadId === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );
    const pinned = await tabState(page);
    assert.deepEqual(pinned.pinned, [true, false], "the pinned tab holds the first slot");
    assert.equal(pinned.threadIds[0], threadB);
    await shoot(page, "04-pinned");

    // --- Closing removes the tab but not the session ---
    await page.click(`.session-tab[data-thread-id="${threadA}"] .session-tab-close`);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 1, {
      timeout: TIMEOUT_MS,
    });
    const afterClose = await tabState(page);
    assert.deepEqual(afterClose.threadIds, [threadB], "only the closed tab went away");

    // The relay wraps list responses in an envelope: { ok, data: { threads } }.
    const threadsStillOnRelay = await page.evaluate(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/threads?limit=50`);
      const body = await response.json();
      return (body.data?.threads || []).map((thread) => thread.id);
    }, relayPort);
    assert.ok(
      threadsStillOnRelay.includes(threadA),
      "closing a tab must not delete the session from the relay"
    );
    await shoot(page, "05-closed");


    // --- Tabs survive a reload (browser-local persistence) ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab", { timeout: TIMEOUT_MS });
    const reloaded = await tabState(page);
    assert.ok(
      reloaded.threadIds.includes(threadB),
      `the pinned tab survives a reload, got ${JSON.stringify(reloaded.threadIds)}`
    );

    // --- Closing the LAST tab must not resurrect it ---
    // The strip used to adopt the relay's active thread whenever the route was
    // empty, so emptying the strip immediately refilled it.
    await page.click(`.session-tab[data-thread-id="${threadB}"] .session-tab-pin`);
    // Unpinning re-renders the strip, so wait for that to land before clicking the
    // close button — otherwise the second click races the re-render.
    await page.waitForFunction(
      (id) =>
        !document
          .querySelector(`.session-tab[data-thread-id="${id}"]`)
          ?.className.includes("is-pinned"),
      threadB,
      { timeout: TIMEOUT_MS }
    );
    await page.click(`.session-tab[data-thread-id="${threadB}"] .session-tab-close`);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 0, {
      timeout: TIMEOUT_MS,
    });
    await page.waitForTimeout(600); // let a snapshot/render cycle go by
    const emptied = await tabState(page);
    assert.equal(emptied.count, 0, "closing the last tab leaves the strip empty");
    assert.ok(emptied.stripPresent, "the strip itself stays mounted when empty");
    await shoot(page, "06-emptied");

    // --- Back/forward keeps the strip and the transcript in agreement ---
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const backState = await tabState(page);
    const routedBack = await page.evaluate(() =>
      new URL(window.location.href).searchParams.get("thread")
    );
    if (routedBack) {
      assert.ok(
        backState.threadIds.includes(routedBack),
        `history navigation to ${routedBack} must re-open its tab, got `
          + JSON.stringify(backState.threadIds)
      );
    }

    // --- Browsing peeks; only a deliberate gesture keeps a tab ---
    // A sidebar click used to append a tab per row it touched, so scrolling the
    // list looking for a session left a dozen tabs behind. It now reuses ONE
    // preview tab; a double click (or a pin, a drag, or sending a message) is
    // what keeps a session. The session still opens on the FIRST click — peeking
    // must stay as immediate as it always was.
    await clearTabPersistence(page);
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-switcher-trigger", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadA}"]`, {
      timeout: TIMEOUT_MS,
    });

    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );
    const peeked = await tabState(page);
    assert.deepEqual(peeked.threadIds, [threadA], "a peek opens the session immediately");
    assert.deepEqual(
      peeked.previewThreadIds,
      [threadA],
      "a browsed session lands in the preview tab"
    );
    await waitForCoherent(page, "after peeking at a session");

    // A refresh is not a gesture: it must neither keep the peek nor lose it.
    // Preview-ness is persisted state, so it has to survive the round trip
    // through IndexedDB and come back still replaceable — a reload that quietly
    // pinned whatever you were looking at would grow the pile one refresh at a
    // time. (A link to a session you are NOT holding open still opens a kept tab;
    // that is the "launching straight onto a session's URL" case further down.)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab", { timeout: TIMEOUT_MS });
    await page.waitForFunction(
      (id) => {
        const tabs = [...document.querySelectorAll(".session-tab")];
        return tabs.length === 1
          && tabs[0].dataset.threadId === id
          && tabs[0].dataset.preview === "true";
      },
      threadA,
      { timeout: TIMEOUT_MS }
    );
    await waitForCoherent(page, "after refreshing on a peeked session");
    await openThreadDrawer(page);

    // The whole point: the second peek REPLACES the first instead of stacking.
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      (id) => {
        const tabs = [...document.querySelectorAll(".session-tab")];
        return tabs.length === 1 && tabs[0].dataset.threadId === id;
      },
      threadB,
      { timeout: TIMEOUT_MS }
    );
    await waitForCoherent(page, "after peeking at a second session");

    // Back/Forward retraces a browse, so it must reuse the preview slot too.
    // Every peek pushes a history entry; if replaying one deposited a permanent
    // tab, walking back through a browse would rebuild the pile the preview tab
    // exists to prevent.
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (id) => {
        const tabs = [...document.querySelectorAll(".session-tab")];
        return tabs.length === 1
          && tabs[0].dataset.threadId === id
          && tabs[0].dataset.preview === "true";
      },
      threadA,
      { timeout: TIMEOUT_MS }
    );
    await waitForCoherent(page, "after stepping back through a browse");

    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (id) => {
        const tabs = [...document.querySelectorAll(".session-tab")];
        return tabs.length === 1 && tabs[0].dataset.threadId === id;
      },
      threadB,
      { timeout: TIMEOUT_MS }
    );
    await waitForCoherent(page, "after stepping forward again");

    // A double click keeps it, so the next peek can no longer take its slot.
    //
    // This assertion is also the regression guard for a real trap: while a root
    // view transition is running, the page does not receive the SECOND click of a
    // double click at all — the gesture silently degrades to a single click. A
    // peek therefore commits without a transition (see render-session.js); if
    // that ever goes back, this times out rather than failing somewhere subtle.
    await page.dblclick(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      () => document.querySelectorAll(".session-tab[data-preview]").length === 0,
      { timeout: TIMEOUT_MS }
    );
    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`);
    await page.waitForFunction(
      () => document.querySelectorAll(".session-tab").length === 2,
      { timeout: TIMEOUT_MS }
    );
    const keptAndPeeked = await tabState(page);
    assert.deepEqual(
      [...keptAndPeeked.threadIds].sort(),
      [threadA, threadB].sort(),
      "the kept session survives the next peek"
    );
    assert.deepEqual(
      keptAndPeeked.previewThreadIds,
      [threadA],
      "only the freshly peeked session stays replaceable"
    );
    await waitForCoherent(page, "after keeping one session and peeking another");

    // The SAME keep gesture on the tab itself. This is the other end of the
    // journey — you peeked from the sidebar, you stayed, now you keep it from the
    // strip — and it walks into exactly the same trap: if focusing a tab starts a
    // root view transition, the second click of this double click never reaches
    // the page and the gesture silently degrades into a plain focus. Tab focus is
    // therefore transition-free (app.js), and this is the guard.
    await page.dblclick(`.session-tab[data-thread-id="${threadA}"] .session-tab-main`);
    await page.waitForFunction(
      () => document.querySelectorAll(".session-tab[data-preview]").length === 0,
      { timeout: TIMEOUT_MS }
    );
    const keptFromStrip = await tabState(page);
    assert.deepEqual(
      keptFromStrip.previewThreadIds,
      [],
      "double-clicking the tab keeps it, same as double-clicking the row"
    );
    assert.deepEqual(
      [...keptFromStrip.threadIds].sort(),
      [threadA, threadB].sort(),
      "keeping a tab neither opens nor closes anything"
    );
    await waitForCoherent(page, "after keeping a session from the tab strip");
    await shoot(page, "06b-preview-tabs");

    // --- Sessions mode and Projects mode keep separate tab sets ---
    // Switching back to Sessions leaves `activeProjectId` set, so keying the tab
    // bucket off that value alone made Sessions mode share the last project's tabs.
    // Start this section from a clean slate: the earlier steps (notably the
    // back/forward re-open) leave persisted tabs behind, and this assertion is about
    // isolation between buckets, not about what those steps left.
    await clearTabPersistence(page);
    await fetch(`http://127.0.0.1:${relayPort}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", name: TABS_PROJECT }),
    });
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-switcher-trigger", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);

    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadA}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );
    const sessionsTabs = (await tabState(page)).threadIds;
    assert.deepEqual(sessionsTabs, [threadA], "Sessions mode holds exactly the opened session");

    await waitForCoherent(page, "sessions mode with one open session");

    await selectProjectInSwitcher(page, TABS_PROJECT);
    await page.waitForFunction(() => document.querySelectorAll(".session-tab").length === 0, {
      timeout: TIMEOUT_MS,
    });
    assert.deepEqual(
      (await tabState(page)).threadIds,
      [],
      "a fresh Projects workspace starts empty rather than inheriting Sessions"
    );
    // The mode switch changed which sessions are "open", so the route had to follow.
    // Leaving it pointed at the Sessions thread would render that transcript under an
    // empty strip — the strip and the main area describing different things.
    const inProjects = await coherence(page);
    await waitForCoherent(page, "after switching to Projects");
    assert.equal(
      inProjects.routedThreadId,
      null,
      `an empty Projects workspace must clear the route, got ${inProjects.routedThreadId}`
    );
    await shoot(page, "07-projects-mode-empty");

    await selectDefaultWorkspaceInSwitcher(page);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );
    // Coming back restores that workspace's focused session, route included.
    const backInSessions = await coherence(page);
    await waitForCoherent(page, "after switching back to Sessions");
    assert.equal(
      backInSessions.routedThreadId,
      threadA,
      "returning to Sessions restores its focused session"
    );
    assert.deepEqual(
      (await tabState(page)).threadIds,
      sessionsTabs,
      "switching back restores the Sessions tab set"
    );
    await shoot(page, "08-sessions-mode-restored");

    // --- Back restores the context an entry was made in, with no side effect on the
    // current tab set ---
    // A tab set belongs to a project, so a session opened in Sessions mode must not be
    // adopted into a project's strip just because you pressed back while that project
    // was selected. The entry carries its own view mode, so back returns there.
    assert.equal(await sidebarViewMode(page), "sessions", "starting in Sessions mode");
    await selectProjectInSwitcher(page, TABS_PROJECT);
    const projectsStrip = (await tabState(page)).threadIds;

    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => !window.history.state?.context?.projectId,
      { timeout: TIMEOUT_MS }
    );
    const restored = await waitForCoherent(page, "after back from Projects into Sessions");
    assert.deepEqual(
      restored.tabThreadIds,
      sessionsTabs,
      "back lands in the Sessions tab set it came from"
    );

    // And the Projects strip is untouched — nothing was adopted into it.
    await selectProjectInSwitcher(page, TABS_PROJECT);
    assert.deepEqual(
      (await tabState(page)).threadIds,
      projectsStrip,
      "the project's tab set gained nothing from the back navigation"
    );
    await selectDefaultWorkspaceInSwitcher(page);
    await shoot(page, "08b-context-restored");

    // --- A reload keeps the view context, not just the thread ---
    // The URL only carries the thread, so a reload used to come back in the default
    // Sessions context and drop the session into the wrong tab set.
    await selectProjectInSwitcher(page, TABS_PROJECT);
    // A SECOND project, so the restore is provably project-specific rather than just
    // "some project". Creating one selects it, which is what makes the tab bucket its own.
    promptValue = "Reload Project";
    await page.click(".project-switcher-trigger");
    await page.waitForSelector(".project-switcher-menu", { timeout: TIMEOUT_MS });
    await page
      .locator(".project-switcher-create")
      .first()
      .click({ timeout: TIMEOUT_MS });
    // Wait for the NAME, not merely for "some project is pinned" — the previously
    // pinned one is still pinned for a render or two, so a bare selector wait passes
    // against the wrong project and the assertion below then reports it as a failure
    // of creation rather than of the wait.
    await page.waitForFunction(
      () =>
        (document.querySelector(".thread-group-header-project.is-active .thread-group-name")
          ?.textContent || "").includes("Reload Project"),
      { timeout: TIMEOUT_MS }
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", {
      state: "attached",
      timeout: TIMEOUT_MS,
    });
    assert.equal(
      await sidebarViewMode(page),
      "projects",
      "a reload restores the pinned project rather than defaulting to the default workspace"
    );
    // Reload closes the sidebar drawer in conversation-sized layouts. The selected
    // project row still renders inside it, so this assertion is about state/identity,
    // not whether the drawer currently lays the row out.
    await page.waitForSelector(".thread-group-header-project.is-active", {
      state: "attached",
      timeout: TIMEOUT_MS,
    });
    assert.match(
      await page.evaluate(
        () => document.querySelector(".thread-group-header-project.is-active")?.textContent || ""
      ),
      /Reload Project/,
      "the selected project survives the reload, so the tab bucket does too"
    );
    await waitForCoherent(page, "after reloading in Projects mode");
    await shoot(page, "08c-projects-reload");

    // --- Legacy and stale history context entries degrade safely ---
    // Exercise these on a separate page so their synthetic same-document history
    // entries cannot disturb the delete/back/forward sequence below.
    const historyPage = await launched.context.newPage();
    historyPage.on("pageerror", (error) =>
      pageErrors.push(`[historyPage] ${error.stack || error.message}`)
    );
    await historyPage.goto(`http://127.0.0.1:${relayPort}`, {
      waitUntil: "domcontentloaded",
    });
    await historyPage.waitForSelector(".project-switcher-trigger", { timeout: TIMEOUT_MS });
    await selectProjectInSwitcher(historyPage, TABS_PROJECT);
    const validProjectEntry = await historyPage.evaluate(() => window.history.state);
    const validProjectTitle = await historyPage.evaluate(
      () => document.querySelector(".thread-group-header-project.is-active")?.textContent || ""
    );

    // Entries created before view-context history shipped carry `{}`. Landing on one
    // must keep the context already on screen, not reinterpret the missing viewMode as
    // Sessions and jump away.
    await historyPage.evaluate((entry) => {
      window.history.pushState({}, "", window.location.href);
      window.history.pushState(entry, "", window.location.href);
    }, validProjectEntry);
    await historyPage.goBack();
    await historyPage.waitForTimeout(300);
    assert.equal(
      await sidebarViewMode(historyPage),
      "projects",
      "a legacy empty history state keeps the current view mode"
    );
    assert.equal(
      await historyPage.evaluate(
        () => document.querySelector(".thread-group-header-project.is-active")?.textContent || ""
      ),
      validProjectTitle,
      "a legacy empty history state keeps the current project"
    );

    // A history entry can outlive its project. It must not select that dead id or
    // implicitly create a tab workspace bucket for it.
    const deletedProjectId = "deleted-project-from-history";
    await historyPage.evaluate(
      ({ current, deletedId }) => {
        window.history.pushState(
          {
            threadId: null,
            viewMode: "projects",
            projectId: deletedId,
          },
          "",
          window.location.href
        );
        window.history.pushState(current, "", window.location.href);
      },
      { current: validProjectEntry, deletedId: deletedProjectId }
    );
    await historyPage.goBack();
    await historyPage.waitForFunction(
      () => !document.querySelector(".thread-group-header-project.is-active"),
      { timeout: TIMEOUT_MS }
    );
    // Was "projects": a legacy entry naming a deleted project used to keep you in
    // Projects mode with nothing selected. That landing spot is gone with the toggle —
    // "no project selected" IS the default workspace — so the fallback is `sessions`.
    // The invariant the step actually guards is the line below it, unchanged: the
    // deleted project must not get a persisted tab workspace out of being restored.
    assert.equal(
      await sidebarViewMode(historyPage),
      "sessions",
      "a deleted project entry falls back to the default workspace, dropping its invalid selection"
    );
    assert.equal(
      await persistedWorkspace(historyPage, deletedProjectId),
      null,
      "restoring a deleted project must not create a persisted tab workspace for it"
    );
    await historyPage.close();

    await selectDefaultWorkspaceInSwitcher(page);

    // --- Deleting a session must not let history resurrect its tab ---
    // History entries outlive threads, so backing onto a deleted session's entry
    // used to re-create the very tab the delete had just swept.
    await openThreadDrawer(page);
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );

    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadA}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadA}"]`, { button: "right" });
    await page.waitForSelector("#delete-thread-button", { timeout: TIMEOUT_MS });
    await page.click("#delete-thread-button");
    await confirmThreadMenuRemoval(page, { timeoutMs: TIMEOUT_MS });
    await page.waitForFunction(
      (id) => ![...document.querySelectorAll(".session-tab")].some((tab) => tab.dataset.threadId === id),
      threadA,
      { timeout: TIMEOUT_MS }
    );

    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const afterBackOntoDeleted = await coherence(page);
    assert.ok(
      !afterBackOntoDeleted.tabThreadIds.includes(threadA),
      `history must not resurrect a deleted session's tab, got `
        + JSON.stringify(afterBackOntoDeleted.tabThreadIds)
    );
    // Refusing the tab is not enough: the route must not be left pointing at the dead
    // session either, or the main area shows it with no tab to match.
    assert.notEqual(
      afterBackOntoDeleted.routedThreadId,
      threadA,
      "the route must not stay on a deleted session"
    );
    await waitForCoherent(page, "after backing onto a deleted session");

    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const afterForward = await coherence(page);
    assert.ok(
      !afterForward.tabThreadIds.includes(threadA),
      "forward navigation must not resurrect it either"
    );
    await waitForCoherent(page, "after forward navigation");
    await shoot(page, "09-deleted-not-resurrected");

    // --- The tombstone has to survive a reload ---
    // History entries outlive the page, so an in-memory-only tombstone is empty again
    // exactly when the stale entries are still in the back stack.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const afterReloadBack = await coherence(page);
    assert.ok(
      !afterReloadBack.tabThreadIds.includes(threadA),
      `a reload must not lose the tombstone, got ${JSON.stringify(afterReloadBack.tabThreadIds)}`
    );
    await waitForCoherent(page, "after delete → reload → back");

    // --- Home shows no session, so no tab may be highlighted ---
    // Even with a live relay session: an empty route means Home, not the active
    // conversation, which is where the old active-thread fallback lied.
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );
    await waitForCoherent(page, "viewing a session before going Home");

    // The sidebar's "Back to console" button was retired (it was a legacy
    // duplicate); the header's back arrow is the surviving way home.
    await page.click("#go-console-home");
    await page.waitForFunction(
      () => !new URL(window.location.href).searchParams.get("thread"),
      { timeout: TIMEOUT_MS }
    );
    await page.waitForTimeout(400);
    const atHome = await coherence(page);
    assert.ok(atHome.tabThreadIds.length > 0, "the strip still lists the open sessions at Home");
    await waitForCoherent(page, "at Home with an open session");
    await shoot(page, "10-home-no-focus");

    // --- Home's explicit "Open live conversation" KEEPS the session ---
    // It names one session and you pressed it on purpose — that is a keep, the
    // same class of gesture as a double click. Merely routing to it would leave a
    // session you deliberately opened sitting in the disposable slot, for the
    // next sidebar click to throw away.
    const liveThreadId = await page.evaluate(
      () => document.querySelector("[data-open-thread-id]")?.dataset.openThreadId || null
    );
    assert.ok(liveThreadId, "Home offers an explicit way into the live conversation");

    // Peek it first, so "keeps it" is something this test can actually observe.
    await openThreadDrawer(page);
    await page.click(`button.conversation-item[data-thread-id="${liveThreadId}"]`);
    await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll(".session-tab[data-preview]")].some(
          (tab) => tab.dataset.threadId === id
        ),
      liveThreadId,
      { timeout: TIMEOUT_MS }
    );
    await page.click("#go-console-home");
    await page.waitForFunction(
      () => !new URL(window.location.href).searchParams.get("thread"),
      { timeout: TIMEOUT_MS }
    );
    await page.click(`[data-open-thread-id="${liveThreadId}"]`);
    await page.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      liveThreadId,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForTimeout(400);
    const afterExplicitOpen = await tabState(page);
    assert.ok(
      !afterExplicitOpen.previewThreadIds.includes(liveThreadId),
      "an explicit Open live conversation keeps the session rather than leaving it disposable, got "
        + JSON.stringify(afterExplicitOpen.previewThreadIds)
    );
    await waitForCoherent(page, "after opening the live conversation from Home");

    // --- Launching straight onto a deleted session's URL ---
    // The initial load adopts `?thread=` from the address bar without going through
    // any navigation handler, so it needs the same tombstone reconciliation that
    // back/forward does — this used to be the one entry point that skipped it and
    // created a dead tab on startup.
    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${encodeURIComponent(threadA)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await page.waitForTimeout(1200);
    const launchedOnDeleted = await coherence(page);
    assert.ok(
      !launchedOnDeleted.tabThreadIds.includes(threadA),
      `launching on a deleted session must not create its tab, got `
        + JSON.stringify(launchedOnDeleted.tabThreadIds)
    );
    assert.notEqual(
      launchedOnDeleted.routedThreadId,
      threadA,
      "the dead route must be replaced, not kept"
    );
    await waitForCoherent(page, "after launching on a deleted session's URL");
    await shoot(page, "11-launch-on-deleted");

    // --- A deletion in one window is honoured by another already-open window ---
    // The tombstone check reads storage on every navigation instead of caching a copy
    // at page init, so window B does not need a reload to learn about A's deletion.
    const pageB = await launched.context.newPage();
    pageB.on("pageerror", (error) => pageErrors.push(`[pageB] ${error.stack || error.message}`));
    await pageB.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await pageB.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await openThreadDrawer(pageB);
    await pageB.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await pageB.click(`button.conversation-item[data-thread-id="${threadB}"]`);
    await pageB.waitForFunction(
      (id) => new URL(window.location.href).searchParams.get("thread") === id,
      threadB,
      { timeout: TIMEOUT_MS }
    );

    // Window A deletes the session window B is sitting on.
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await openThreadDrawer(page);
    await page.waitForSelector(`button.conversation-item[data-thread-id="${threadB}"]`, {
      timeout: TIMEOUT_MS,
    });
    await page.click(`button.conversation-item[data-thread-id="${threadB}"]`, { button: "right" });
    await page.waitForSelector("#delete-thread-button", { timeout: TIMEOUT_MS });
    await page.click("#delete-thread-button");
    await confirmThreadMenuRemoval(page, { timeoutMs: TIMEOUT_MS });
    await page.waitForTimeout(1000);

    // B still has the dead tab rendered. Clicking it is the most direct path and does
    // NOT go through the navigation-time sweep, so the click handler has to notice the
    // tombstone itself rather than routing to a session that no longer exists.
    const deadTab = `.session-tab[data-thread-id="${threadB}"]`;
    assert.ok(
      await pageB.$(deadTab),
      "the second window must still hold its in-memory tab so the dead-click path is exercised"
    );
    await pageB.click(`${deadTab} .session-tab-main`);
    await pageB.waitForTimeout(1000);
    const afterClickingDead = await coherence(pageB);
    assert.ok(
      !afterClickingDead.tabThreadIds.includes(threadB),
      `clicking a tab deleted by another window must drop it, got `
        + JSON.stringify(afterClickingDead.tabThreadIds)
    );
    assert.notEqual(
      afterClickingDead.routedThreadId,
      threadB,
      "clicking a dead tab must not route to it"
    );
    await waitForCoherent(pageB, "second window after clicking a dead tab");

    // B navigates back onto the now-dead session; no reload, no storage event.
    await pageB.goBack({ waitUntil: "domcontentloaded" });
    await pageB.waitForTimeout(1000);
    const windowB = await coherence(pageB);
    assert.ok(
      !windowB.tabThreadIds.includes(threadB),
      `another window's deletion must be honoured without a reload, got `
        + JSON.stringify(windowB.tabThreadIds)
    );
    await waitForCoherent(pageB, "second window after the first deleted the session");
    await pageB.close();

    assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join("\n")}`);
    console.log("local session tabs e2e: OK");
  } finally {
    await browser?.close?.();
    await stopManagedProcess(relay);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
