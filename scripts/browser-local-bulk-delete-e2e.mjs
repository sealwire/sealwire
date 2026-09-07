// Shift/Cmd multi-select in the local sidebar, and the batch delete it feeds.
//
// Every defect this guards was found in a browser and is invisible to the unit
// suites, because each lives in a seam between modules: the row's click handler and
// the selection layer, the menu's captured batch and the rows actually on screen, the
// menu's reset path and a right-click that fires no `click` event.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { dumpBrowserState, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const SESSION_COUNT = 5;
const STEP_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);

// Serialized inside the page: id plus the three row states this suite reasons about.
const rows = () =>
  Array.from(document.querySelectorAll(".conversation-item[data-thread-id]")).map((el) => ({
    id: el.dataset.threadId,
    selected: el.classList.contains("is-multi-selected"),
    active: el.classList.contains("is-active"),
    ariaSelected: el.getAttribute("aria-selected"),
  }));

const menuState = () => ({
  open: !document.querySelector("#thread-context-menu")?.hidden,
  deleteLabel: document.querySelector("#delete-thread-button")?.textContent,
  rename: document.querySelector("#rename-thread-button")?.disabled,
  projects: document.querySelector("#thread-project-submenu-trigger")?.disabled,
  fork: document.querySelector("#fork-thread-button")?.disabled,
  archive: document.querySelector("#archive-thread-button")?.disabled,
});

// Playwright resolves a selector, then clicks the coordinates it found. A list still
// settling after a refresh re-sorts under that gap and the click lands on the
// neighbouring row — so wait for the order to stop moving before aiming at it.
async function settledOrder(page) {
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = (await page.evaluate(rows)).map((row) => row.id).join(",");
    if (current && current === previous) {
      return current.split(",");
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("the session list never stopped re-ordering");
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-bulk-delete-e2e-"));
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-bulk-delete-workspace-"))
  );
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });

  let browser;
  let context;
  let page;
  const pageErrors = [];

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });

    for (let index = 0; index < SESSION_COUNT; index += 1) {
      await startLocalSession(page, {
        cwd: workspaceDir,
        provider: "fake",
        approvalPolicy: "never",
      });
      await page.waitForFunction(
        (n) => document.querySelectorAll(".conversation-item[data-thread-id]").length >= n,
        index + 1,
        { timeout: STEP_TIMEOUT_MS }
      );
    }
    await page.waitForFunction(async () => {
      const snapshot = await fetch("/api/session").then((r) => r.json()).catch(() => null);
      return snapshot?.data && !snapshot.data.active_turn_id;
    }, null, { timeout: STEP_TIMEOUT_MS });

    const sel = (id) => `.conversation-item[data-thread-id="${id}"]`;
    const listed = await page.evaluate(rows);
    assert.ok(listed.length >= SESSION_COUNT, `expected ${SESSION_COUNT} rows, got ${listed.length}`);
    const activeBefore = listed.find((row) => row.active)?.id || null;

    // --- Cmd+click toggles a row without opening it ---
    await page.click(sel(listed[1].id), { modifiers: ["Meta"] });
    await page.click(sel(listed[3].id), { modifiers: ["Meta"] });
    let now = await page.evaluate(rows);
    assert.deepEqual(
      now.filter((row) => row.selected).map((row) => row.id).sort(),
      [listed[1].id, listed[3].id].sort(),
      "cmd+click must select exactly the clicked rows"
    );
    assert.equal(
      now.find((row) => row.active)?.id || null,
      activeBefore,
      "cmd+click must not open a session"
    );
    assert.equal(
      now.find((row) => row.id === listed[1].id)?.ariaSelected,
      "true",
      "a selected row must report its state to assistive tech"
    );

    // The highlight has to be a real visual change, not just a class name: `is-active`
    // and the resting row already share a background, so this asserts on paint.
    const paint = await page.evaluate(
      ([selectedId, plainId]) => {
        const read = (id) => {
          const style = getComputedStyle(
            document.querySelector(`.conversation-item[data-thread-id="${id}"]`)
          );
          return { background: style.backgroundColor, border: style.borderColor };
        };
        return { selected: read(selectedId), plain: read(plainId) };
      },
      [listed[1].id, listed[2].id]
    );
    assert.notEqual(
      paint.selected.background,
      paint.plain.background,
      "a selected row must be filled differently from an unselected one"
    );
    assert.notEqual(
      paint.selected.border,
      paint.plain.border,
      "a selected row must be outlined differently from an unselected one"
    );

    await page.click(sel(listed[3].id), { modifiers: ["Meta"] });
    now = await page.evaluate(rows);
    assert.deepEqual(
      now.filter((row) => row.selected).map((row) => row.id),
      [listed[1].id],
      "cmd+click on a selected row must deselect it"
    );

    // --- Shift+click extends a range from the anchor a plain click set ---
    // Regression: a plain click did not reach the selection layer, so it left no
    // anchor and shift ranged from whatever row was cmd+clicked last. Opening a
    // session also re-sorts the sidebar, so the range runs over the order on screen
    // at click time — read it back rather than reusing the order from before.
    await page.click(sel(listed[0].id));
    const order = await settledOrder(page);
    const anchorIndex = order.indexOf(listed[0].id);
    const targetIndex = anchorIndex + 2;
    assert.ok(targetIndex < order.length, "need two rows below the anchor to range over");
    await page.click(sel(order[targetIndex]), { modifiers: ["Shift"] });
    const range = order.slice(anchorIndex, targetIndex + 1);
    now = await page.evaluate(rows);
    assert.deepEqual(
      now.filter((row) => row.selected).map((row) => row.id),
      range,
      "shift+click must select the whole run between the anchor and the click"
    );

    // Shift-extend must not have dragged a text highlight across the rows it crossed.
    assert.equal(
      await page.evaluate(() => String(window.getSelection() || "")),
      "",
      "shift+click must not paint a text selection"
    );

    // --- Right-clicking inside the selection aims the menu at the batch ---
    await page.click(sel(range[1]), { button: "right" });
    await page.waitForFunction(() => !document.querySelector("#thread-context-menu")?.hidden, null, {
      timeout: STEP_TIMEOUT_MS,
    });
    const batchMenu = await page.evaluate(menuState);
    assert.equal(batchMenu.deleteLabel, "Delete 3 sessions permanently");
    // Every other action takes ONE session. Leaving them live would act on a different
    // set than the rows the user can see highlighted.
    for (const action of ["fork", "archive", "rename", "projects"]) {
      assert.equal(batchMenu[action], true, `${action} must be disabled for a batch`);
    }

    // --- ...and the menu resets when it reopens on a single row ---
    // Regression: no Escape first, on purpose. A right-click fires no `click`, so the
    // document's click-to-close never runs and the menu is rebuilt in place — which is
    // exactly where a one-way disable stayed stuck.
    const outsider = order.find((id) => !range.includes(id));
    await page.click(sel(outsider), { button: "right" });
    await page.waitForFunction(
      () => document.querySelector("#delete-thread-button")?.textContent === "Delete permanently",
      null,
      { timeout: STEP_TIMEOUT_MS }
    );
    const singleMenu = await page.evaluate(menuState);
    assert.equal(singleMenu.rename, false, "rename must come back for a single session");
    assert.equal(singleMenu.projects, false, "the Projects flyout must come back too");
    await page.keyboard.press("Escape");

    // --- A selection taken off screen must not stay armed ---
    // Regression: search swaps the row source without touching the thread list the
    // "is it still around?" check consults, so the menu stayed open over an empty list
    // with its delete still naming the old batch.
    await page.click(sel(order[0]), { modifiers: ["Meta"] });
    await page.click(sel(order[1]), { modifiers: ["Meta"] });
    await page.click(sel(order[1]), { button: "right" });
    await page.waitForFunction(
      () =>
        document.querySelector("#delete-thread-button")?.textContent
        === "Delete 2 sessions permanently",
      null,
      { timeout: STEP_TIMEOUT_MS }
    );
    await page.click(".sidebar-search-toggle");
    await page.waitForSelector(".sidebar-search-input", { timeout: STEP_TIMEOUT_MS });
    await page.fill(".sidebar-search-input", "zzz-matches-no-session");
    await page.waitForFunction(
      () => document.querySelectorAll(".conversation-item[data-thread-id]").length === 0,
      null,
      { timeout: STEP_TIMEOUT_MS }
    );
    assert.equal(
      (await page.evaluate(menuState)).open,
      false,
      "a menu whose rows left the screen must close"
    );

    await page.fill(".sidebar-search-input", "");
    await page.waitForFunction(
      (n) => document.querySelectorAll(".conversation-item[data-thread-id]").length >= n,
      order.length,
      { timeout: STEP_TIMEOUT_MS }
    );
    assert.equal(
      (await page.evaluate(rows)).filter((row) => row.selected).length,
      0,
      "a selection a search hid must not come back when the search clears"
    );

    // --- A batch member vanishing under an open menu must disarm it ---
    // Regression: the menu closed only when the row it was opened ON disappeared. It
    // holds a snapshot of the WHOLE batch, so a different member going away left it
    // able to delete a session that was no longer listed.
    await page.click(sel(range[0]), { modifiers: ["Meta"] });
    await page.click(sel(range[2]), { modifiers: ["Shift"] });
    await page.click(sel(range[1]), { button: "right" });
    await page.waitForFunction(
      () =>
        document.querySelector("#delete-thread-button")?.textContent
        === "Delete 3 sessions permanently",
      null,
      { timeout: STEP_TIMEOUT_MS }
    );
    // Delete a NON-anchor member behind the UI's back — another client, or a refresh
    // that drops it — so the right-clicked row itself stays on screen.
    await page.evaluate(async (id) => {
      await fetch(`/api/threads/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Agent-Relay-CSRF": "1" },
        credentials: "same-origin",
      });
    }, range[2]);
    await page.click("#threads-refresh-button");
    await page.waitForFunction(
      (id) => !document.querySelector(`.conversation-item[data-thread-id="${id}"]`),
      range[2],
      { timeout: STEP_TIMEOUT_MS }
    );
    assert.equal(
      (await page.evaluate(menuState)).open,
      false,
      "the menu must close once its batch stops matching what is on screen"
    );

    // --- Escape clears a selection when no menu is over it ---
    assert.ok(
      (await page.evaluate(rows)).filter((row) => row.selected).length > 0,
      "the pruned remains of the range should still be selected here"
    );
    await page.keyboard.press("Escape");
    assert.equal(
      (await page.evaluate(rows)).filter((row) => row.selected).length,
      0,
      "Escape with no menu open must clear the selection"
    );

    // --- Confirming deletes the whole batch, and only the batch ---
    const settled = await settledOrder(page);
    const batch = settled.slice(0, 2);
    const survivors = settled.slice(2);
    assert.ok(survivors.length > 0, "keep at least one session out of the batch");
    await page.click(sel(batch[0]), { modifiers: ["Meta"] });
    await page.click(sel(batch[1]), { modifiers: ["Meta"] });
    await page.click(sel(batch[1]), { button: "right" });
    await page.waitForFunction(
      () =>
        document.querySelector("#delete-thread-button")?.textContent
        === "Delete 2 sessions permanently",
      null,
      { timeout: STEP_TIMEOUT_MS }
    );
    await page.click("#delete-thread-button");
    await page.waitForFunction(
      (ids) =>
        ids.every((id) => !document.querySelector(`.conversation-item[data-thread-id="${id}"]`)),
      batch,
      { timeout: STEP_TIMEOUT_MS }
    );

    assert.ok(
      dialogs.some((message) => /Permanently delete 2 sessions\?/.test(message)),
      `the confirm must name the count; saw ${JSON.stringify(dialogs)}`
    );
    now = await page.evaluate(rows);
    for (const id of survivors) {
      assert.ok(now.some((row) => row.id === id), `unselected session ${id} must survive`);
    }
    assert.equal(
      now.filter((row) => row.selected).length,
      0,
      "the selection must be cleared after the delete"
    );

    // The relay has to agree — a row leaving the DOM is not a delete.
    const serverThreadIds = await page.evaluate(async () => {
      const payload = await fetch("/api/threads").then((r) => r.json());
      return (payload.data?.threads || []).map((thread) => thread.id);
    });
    for (const id of batch) {
      assert.ok(!serverThreadIds.includes(id), `relay still lists deleted thread ${id}`);
    }

    assert.deepEqual(pageErrors, [], "the page must not have thrown");
    console.log("PASS  local bulk delete (shift/cmd multi-select)");
  } catch (error) {
    await dumpBrowserState({ localPage: page }).catch(() => {});
    dumpProcessLogs(relay);
    await writeFailureArtifacts({
      scenario: "local-bulk-delete-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: { workspaceDir, pageErrors },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
