// The local New session dialog stays open while a start is in flight, so it can be
// cancelled, reopened and pasted into before the relay answers. Neither may lose work.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { waitForDialogOpen } from "./e2e/harness/start-session-dialog.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const DIALOG = "launch-start-session-dialog";

function step(message) {
  console.log(`[local-start-in-flight-e2e] ${message}`);
}

// Holds every /api/session/start until released, so "in flight" lasts as long as the test needs.
async function holdStarts(page) {
  const gate = { seen: 0, release: null };
  let held = new Promise((resolve) => (gate.release = resolve));
  gate.rearm = () => {
    held = new Promise((resolve) => (gate.release = resolve));
  };
  await page.route("**/api/session/start", async (route) => {
    gate.seen += 1;
    await held;
    await route.continue();
  });
  return gate;
}

async function waitForStarts(page, gate, count) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (gate.seen < count) {
    assert.ok(Date.now() < deadline, `expected ${count} start request(s), saw ${gate.seen}`);
    await page.waitForTimeout(50);
  }
}

const dialogOpen = (page) => page.evaluate((id) => Boolean(document.getElementById(id)?.open), DIALOG);

// Dispatched as a real paste so it goes through the page's own paste handler.
function pasteImageIntoPrompt(page) {
  return page.evaluate((id) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
      ),
      (c) => c.charCodeAt(0)
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "late-shot.png", { type: "image/png" }));
    document
      .getElementById(`${id}-start-prompt`)
      .dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    return document.querySelectorAll("#start-prompt-attachments .composer-attachment").length;
  }, DIALOG);
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-start-in-flight-"));
  const relay = startLocalRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let page;
  try {
    let context;
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    const gate = await holdStarts(page);

    // Start A, cancel it mid-flight, open the dialog again: A's acceptance must not close it.
    await startLocalSession(page, { cwd: ROOT, provider: "fake", timeoutMs: TIMEOUT_MS });
    await waitForStarts(page, gate, 1);
    await page.click(`#${DIALOG} .session-dialog-cancel`);
    await page.waitForFunction((id) => !document.getElementById(id)?.open, DIALOG);
    await page.click("#open-start-session-dialog");
    await waitForDialogOpen(page, DIALOG, TIMEOUT_MS);
    gate.release();
    await page.waitForFunction(
      (id) => {
        const dialog = document.getElementById(id);
        return !dialog?.open || document.getElementById(`${id}-start`)?.textContent.includes("Start session");
      },
      DIALOG,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await dialogOpen(page),
      true,
      "the start cancelled from an earlier opening closed the dialog the user reopened"
    );
    step("a cancelled start's acceptance leaves the reopened dialog alone");

    // Start B, then paste mid-flight: the image could not ride along, so it must be refused.
    gate.rearm();
    await page.click(`#${DIALOG}-start`);
    await waitForStarts(page, gate, 2);
    assert.equal(
      await pasteImageIntoPrompt(page),
      0,
      "an image pasted after Start is not sent, and the close on success would drop it"
    );
    assert.deepEqual(
      await page.evaluate(
        (id) => ({
          prompt: document.getElementById(`${id}-start-prompt`).readOnly,
          workspace: document.querySelector(`#${id} .workspace-picker-trigger`).disabled,
          model: document.getElementById(`${id}-model`).disabled,
        }),
        DIALOG
      ),
      { prompt: true, workspace: true, model: true },
      "the draft that was sent must not be editable while it is starting"
    );
    gate.release();
    await page.waitForFunction((id) => !document.getElementById(id)?.open, DIALOG, {
      timeout: TIMEOUT_MS,
    });
    step("a paste while starting is refused, and the accepted start closes the dialog");
    step("PASS");
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-start-in-flight-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: { stateDir },
    }).catch(() => {});
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("[local-start-in-flight-e2e] FAILED", error);
  process.exitCode = 1;
});
