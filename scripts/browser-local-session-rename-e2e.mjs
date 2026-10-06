// Drives the local web UI to verify renaming a session tab end to end.
//
// The invariant this exists to protect is NOT "an input appeared" — it is that a
// user-chosen title beats the provider's own, survives a relay restart, and is visible
// to every other client. The unit tests pin each of those layers; this proves they are
// actually wired to the gesture a person performs.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-session-rename-e2e.mjs
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

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const SHOT_DIR = process.env.BROWSER_E2E_SHOT_DIR || "";

function tabTitles(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".session-tab")].map((tab) => ({
      threadId: tab.dataset.threadId || "",
      title: tab.querySelector(".session-tab-title")?.textContent || "",
      editing: tab.dataset.editing === "true",
    }))
  );
}

// The relay's own answer, independent of anything the browser is holding — this is what
// a SECOND client (the phone) would receive.
function apiThreads(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/threads?limit=50", { credentials: "same-origin" });
    const payload = await response.json();
    return (payload?.data?.threads || []).map((thread) => ({
      id: thread.id,
      name: thread.name,
      renamed: thread.renamed,
    }));
  });
}

async function shot(page, name) {
  if (!SHOT_DIR) return;
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

async function renameFocusedTab(page, threadId, text, shotName = "") {
  const tab = `\.session-tab[data-thread-id="${threadId}"]`;
  // Right-click opens the tab's menu; its Rename… opens the box in place.
  await page.click(tab, { button: "right" });
  await page
    .locator('.context-menu[aria-label^="Tab "] .context-menu-button', { hasText: "Rename…" })
    .click({ timeout: TIMEOUT_MS });
  await page.waitForSelector(`${tab} .session-tab-title-input`, { timeout: TIMEOUT_MS });
  await page.fill(`${tab} .session-tab-title-input`, text);
  if (shotName) {
    await shot(page, shotName);
  }
  await page.press(`${tab} .session-tab-title-input`, "Enter");
}

async function main() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-rename-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sealwire-rename-cwd-"));
  const relayStateDb = path.join(stateDir, "sealwire.db");
  const relayPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${relayPort}`;

  let relay = startLocalRelay({
    relayPort,
    relayStateDb,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`${baseUrl}/api/health`, TIMEOUT_MS);

  const { browser, context } = await launchBrowser();
  const page = await context.newPage();
  attachPageDebugLogging(page);

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await startLocalSession(page, {
      cwd: workspace,
      provider: "fake",
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => (document.querySelector("#transcript")?.textContent || "").includes("Session ready"),
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForSelector(".session-tab", { timeout: TIMEOUT_MS });

    // --- 1. baseline: the provider named it -------------------------------------
    // A brand-new tab renders before the thread list arrives, so it briefly shows the
    // short-id fallback. Wait for the provider's own title to land — asserting on the
    // first frame would be asserting on the fallback.
    await page.waitForFunction(
      () =>
        document.querySelector(".session-tab .session-tab-title")?.textContent
        === "Fake E2E Session",
      null,
      { timeout: TIMEOUT_MS }
    );
    const [baseTab] = await tabTitles(page);
    const threadId = baseTab.threadId;
    assert.ok(threadId, "the started session must have a tab");
    const providerName = baseTab.title;
    const before = await apiThreads(page);
    assert.ok(
      !before.find((t) => t.id === threadId)?.renamed,
      "a never-renamed session must not report an override"
    );
    await shot(page, "rename-01-before");

    // --- 2. rename via the tab's own inline editor -------------------------------
    await renameFocusedTab(page, threadId, "Auth work", "rename-01b-editing");
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.session-tab[data-thread-id="${id}"] .session-tab-title`)
          ?.textContent === "Auth work",
      threadId,
      { timeout: TIMEOUT_MS }
    );
    const renamedTabs = await tabTitles(page);
    assert.equal(renamedTabs[0].title, "Auth work");
    assert.equal(renamedTabs[0].editing, false, "committing must close the editor");
    await shot(page, "rename-02-renamed");

    // The sidebar renders from the same `thread.name`, so it must agree — a strip and a
    // list disagreeing about a session is the bug class this whole surface has.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-thread-title]")].some(
          (row) => row.getAttribute("data-thread-title") === "Auth work"
        ),
      null,
      { timeout: TIMEOUT_MS }
    );

    // --- 3. the relay is the source of truth, not the browser --------------------
    const afterRename = await apiThreads(page);
    const row = afterRename.find((thread) => thread.id === threadId);
    assert.equal(row.name, "Auth work", "the relay must serve the user's title");
    assert.equal(
      row.renamed,
      true,
      "`renamed` distinguishes the user's choice from the agent's guess"
    );

    // --- 4. THE invariant: the provider re-titling cannot take it back ------------
    // A turn makes the fake provider re-derive and re-upsert its own summary — the
    // exact drift the feature exists to stop.
    await page.fill("#message-input", "hello there");
    await page.click("#send-button");
    await page.waitForSelector("#transcript .chat-message-assistant", { timeout: TIMEOUT_MS });
    await page.waitForFunction(
      async () => {
        const response = await fetch("/api/session", { credentials: "same-origin" })
          .then((r) => r.json())
          .catch(() => null);
        return response?.data && !response.data.active_turn_id;
      },
      null,
      { timeout: TIMEOUT_MS }
    );
    const afterTurn = await apiThreads(page);
    assert.equal(
      afterTurn.find((thread) => thread.id === threadId)?.name,
      "Auth work",
      "a completed turn must not let the provider retitle a renamed session"
    );

    // --- 5. it survives a relay restart ------------------------------------------
    await stopManagedProcess(relay);
    relay = startLocalRelay({
      relayPort,
      relayStateDb,
      extraEnv: { AGENT_PROVIDERS: "fake" },
    });
    await waitForHealth(`${baseUrl}/api/health`, TIMEOUT_MS);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".session-tab", { timeout: TIMEOUT_MS });
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.session-tab[data-thread-id="${id}"] .session-tab-title`)
          ?.textContent === "Auth work",
      threadId,
      { timeout: TIMEOUT_MS }
    );
    const afterRestart = await apiThreads(page);
    assert.equal(
      afterRestart.find((thread) => thread.id === threadId)?.renamed,
      true,
      "a rename that does not survive a restart is worse than no rename"
    );
    await shot(page, "rename-03-after-restart");

    // --- 6. reset hands the title back to the agent ------------------------------
    await renameFocusedTab(page, threadId, "");
    await page.waitForFunction(
      (args) =>
        document.querySelector(`.session-tab[data-thread-id="${args.id}"] .session-tab-title`)
          ?.textContent === args.name,
      { id: threadId, name: providerName },
      { timeout: TIMEOUT_MS }
    );
    const afterReset = await apiThreads(page);
    const resetRow = afterReset.find((thread) => thread.id === threadId);
    assert.equal(resetRow.name, providerName, "resetting must restore the agent's own title");
    assert.ok(!resetRow.renamed, "the override must be gone, not merely blanked");
    await shot(page, "rename-04-reset");

    console.log("local session rename e2e: PASS");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopManagedProcess(relay).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
