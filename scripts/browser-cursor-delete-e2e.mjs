// Browser end-to-end for deleting a Cursor (ACP) session, and for what the user
// sees when that delete is refused.
//
// The bug this comes from was reported as "delete does nothing". Two separate
// defects produced that one symptom, and both need a browser to pin:
//
//   1. The relay refused every Cursor delete (ACP has no delete method), so the
//      row never moved.
//   2. The refusal was reported by writing to #client-log — a collapsed panel —
//      so nothing on screen changed either way.
//
// Fixing (1) alone would have left (2) in place and made it MORE reachable: a
// real delete has real failure modes. So this drives both halves through the
// actual context menu: a delete that works, and a delete that fails because the
// session vanished underneath the relay.
//
// Hermetic and non-destructive. `CURSOR_CONFIG_DIR` is the first thing Cursor's
// path resolution consults, so the run is pointed at a temp directory holding
// throwaway clones of a real session — the user's own sessions are never
// listed, let alone deleted. It sends no prompt, so it costs no tokens.
//
// Run: npm run test:browser:cursor-delete
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { launchBrowser } from "./e2e/harness/browser.mjs";
import { openSessionsDrawer } from "./e2e/harness/drawer.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { confirmThreadMenuRemoval } from "./e2e/harness/thread-menu.mjs";

const TIMEOUT_MS = Number(process.env.CURSOR_DELETE_E2E_TIMEOUT_MS || 60000);
// Two clones: one to delete for real, one whose directory is removed behind the
// relay's back so the delete is refused.
const DOOMED_ID = "e2e0de1e-7e00-4000-8000-00000000de1e";
const VANISHED_ID = "e2e0de1e-7e00-4000-8000-000000006024";
const DEVICE_ID = "browser-cursor-delete-e2e";

async function main() {
  const source = await findClonableSession(path.join(realCursorConfigDir(), "acp-sessions"));
  if (!source) {
    console.log(JSON.stringify({ ok: true, skipped: "no local Cursor ACP session to clone" }));
    return;
  }

  const cursorConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-cfg-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-br-"));
  const sessionDir = (id) => path.join(cursorConfigDir, "acp-sessions", id);

  let relay;
  let browser;
  try {
    for (const [id, title] of [
      [DOOMED_ID, "Relay delete e2e"],
      [VANISHED_ID, "Relay vanished e2e"],
    ]) {
      await fs.cp(source.dir, sessionDir(id), { recursive: true });
      await fs.writeFile(
        path.join(sessionDir(id), "meta.json"),
        JSON.stringify({ schemaVersion: 1, cwd: source.cwd, title })
      );
    }

    const relayPort = await getFreePort();
    relay = startLocalRelay({
      relayPort,
      relayStateDb: path.join(stateDir, "sealwire.db"),
      extraEnv: { AGENT_PROVIDERS: "cursor", CURSOR_CONFIG_DIR: cursorConfigDir },
    });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

    const providers = await getJson(relayPort, "/api/providers");
    if (!providers.data?.includes("cursor")) {
      console.log(JSON.stringify({ ok: true, skipped: "cursor provider is not available" }));
      return;
    }
    const status = (await getJson(relayPort, "/api/session")).data?.provider_status || [];
    const cursor = status.find((row) => row.provider === "cursor");
    if (!cursor?.connected) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: `cursor is not connected (${cursor?.status}); run \`cursor-agent login\``,
        })
      );
      return;
    }

    // The isolated config dir holds exactly the two clones, which also proves
    // CURSOR_CONFIG_DIR is honoured: if it were not, the user's real sessions
    // would be in this list and about to be right-clicked.
    const listed = await listCursorThreadIds(relayPort);
    assert.deepEqual(
      [...listed].sort(),
      [DOOMED_ID, VANISHED_ID].sort(),
      "the isolated config dir should expose exactly the two clones"
    );

    ({ browser } = await openApp(relayPort));
    const page = browser.page;

    // Resume one session so the app is in a conversation view — that is what
    // expands the sidebar, and it also means the delete below runs against a
    // session the relay has LOADED rather than a cold listed row (a different
    // path: it holds a live session handle and has to clear the active thread).
    const resumed = await postJson(relayPort, "/api/session/resume", {
      thread_id: DOOMED_ID,
      device_id: DEVICE_ID,
    });
    assert.equal(resumed.ok, true, `resume failed: ${resumed.error?.message}`);
    await waitForIdle(relayPort);
    await page.reload({ waitUntil: "domcontentloaded" });

    const doomedRow = await waitForVisibleThreadRow(page, DOOMED_ID);

    // --- 1. archive is not offered for a provider that cannot archive --------
    await openMenu(page, doomedRow);
    const menu = await page.evaluate(() => ({
      archive: document.querySelector("#archive-thread-button")?.hidden,
      delete: document.querySelector("#delete-thread-button")?.hidden,
    }));
    assert.equal(menu.archive, true, "Cursor has no archive, so it must not be offered");
    assert.equal(menu.delete, false, "delete must still be offered");
    await page.keyboard.press("Escape");

    // --- 2. a delete that succeeds -------------------------------------------
    const dialogs = watchDialogs(page);
    await openMenu(page, doomedRow);
    await page.click("#delete-thread-button");
    await confirmThreadMenuRemoval(page, { timeoutMs: TIMEOUT_MS });
    await page.waitForFunction(
      (id) => document.querySelector(`#threads-list [data-thread-id="${id}"]`) == null,
      DOOMED_ID,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await pathExists(sessionDir(DOOMED_ID)),
      false,
      "a successful delete must remove the session directory from disk"
    );
    assert.equal(
      dialogs.alerts.length,
      0,
      `a successful delete must not warn: ${JSON.stringify(dialogs.alerts)}`
    );

    // --- 3. a delete that fails must SAY so ----------------------------------
    // Remove the directory behind the relay's back. This is a real race (another
    // window, a `cursor-agent` that cleaned up, a sync tool), and it is the
    // cheapest way to make the relay refuse without stubbing anything.
    await fs.rm(sessionDir(VANISHED_ID), { recursive: true, force: true });

    const vanishedRow = await waitForVisibleThreadRow(page, VANISHED_ID);
    dialogs.reset();
    await openMenu(page, vanishedRow);
    await page.click("#delete-thread-button");
    await confirmThreadMenuRemoval(page, { timeoutMs: TIMEOUT_MS });

    const alerted = await waitForAlert(dialogs);
    assert.match(
      alerted,
      /Could not delete/i,
      `a refused delete must be shown, not just logged. Alerts: ${alerted}`
    );
    assert.match(
      alerted,
      /was not found in local Cursor storage/i,
      `the relay's own reason must survive to the user. Alerts: ${alerted}`
    );

    // The row must still be there: nothing was deleted, so nothing may look
    // deleted. (The old code removed the row optimistically only on success, but
    // said nothing on failure — this pins that the two halves agree.)
    assert.ok(
      await page.$(`#threads-list [data-thread-id="${VANISHED_ID}"]`),
      "a refused delete must leave the row in place"
    );

    console.log(JSON.stringify({ ok: true, deleted: DOOMED_ID, refused: VANISHED_ID }, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(cursorConfigDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function openApp(relayPort) {
  const { browser: chrome, context } = await launchBrowser();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
  return {
    browser: {
      page,
      close: async () => {
        await chrome.close();
      },
    },
  };
}

/// Accept the confirm the destructive flow opens, and record the alerts, which
/// are the channel the failure feedback uses. Playwright auto-dismisses dialogs
/// with no handler, so without this an alert would vanish silently — the very
/// thing under test.
function watchDialogs(page) {
  const state = { alerts: [], reset: () => (state.alerts.length = 0) };
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "alert") {
      state.alerts.push(dialog.message());
    }
    await dialog.accept().catch(() => {});
  });
  return state;
}

async function waitForAlert(state, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.alerts.length) return state.alerts.join(" | ");
    await delay(100);
  }
  throw new Error("timed out waiting for a visible failure notice (none was shown)");
}

async function waitForVisibleThreadRow(page, threadId) {
  // The sessions list lives in a collapsed `<details>` drawer off the
  // conversation view. Use the shared helper, NOT a direct `.open` assignment:
  // the open state is owned by the thread-list store, so setting the property
  // opens the element while the store still thinks it is shut and the next
  // render closes it again — see scripts/e2e/harness/drawer.mjs.
  await openSessionsDrawer(page, { timeoutMs: TIMEOUT_MS });
  const row = page.locator(`#threads-list [data-thread-id="${threadId}"]`).first();
  await row.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await row.scrollIntoViewIfNeeded({ timeout: TIMEOUT_MS });
  return row;
}

async function openMenu(page, row) {
  const box = await row.boundingBox({ timeout: TIMEOUT_MS });
  assert.ok(box, "the thread row should have a bounding box before opening its menu");
  await row.click({
    button: "right",
    position: { x: Math.min(box.width / 2, 160), y: Math.min(box.height / 2, 24) },
    timeout: TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => document.querySelector("#thread-context-menu")?.hidden === false,
    null,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForIdle(relayPort, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = (await getJson(relayPort, "/api/session")).data;
    if (session && !session.active_turn_id) {
      return;
    }
    await delay(250);
  }
  throw new Error("timed out waiting for the resumed session to settle");
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

async function findClonableSession(sessionsDir) {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === DOOMED_ID || entry.name === VANISHED_ID) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    if (!(await pathExists(path.join(dir, "store.db")))) continue;
    const meta = await fs
      .readFile(path.join(dir, "meta.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (meta?.cwd && meta?.title) {
      return { id: entry.name, dir, cwd: meta.cwd };
    }
  }
  return null;
}

function pathExists(target) {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

async function getJson(relayPort, pathName) {
  return (await fetch(`http://127.0.0.1:${relayPort}${pathName}`)).json();
}

async function postJson(relayPort, pathName, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
