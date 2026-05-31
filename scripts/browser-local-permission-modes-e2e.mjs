// Browser e2e: prove that the permission mode chosen for a session actually
// changes runtime behavior end-to-end — not just that the setting persists.
//
// Runs the fake provider with FAKE_PROVIDER_ENFORCE_APPROVALS=1 so a non-bypass
// turn parks on a real approval banner:
//   - bypass (YOLO)  -> send a turn -> reply appears, NO approval banner;
//   - untrusted      -> send a turn -> approval banner appears -> approve -> reply.
//
// This is the UI-level complement to the Rust fake_provider approval tests, and
// the regression net for the class of bug where a permission-mode change never
// reaches the running session.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PROMPT = "Reply with exactly: pong";
const EXPECTED_REPLY = "pong";
const APPROVAL_BANNER = ".pending-action-banner-approval";

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[local-permission-modes-e2e] ${message}${suffix}`);
}

async function waitForActiveSession(relayPort, { approvalPolicy, cwd }) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchSession(relayPort);
    if (
      last.active_thread_id &&
      last.current_cwd === cwd &&
      last.approval_policy === approvalPolicy
    ) {
      return last.active_thread_id;
    }
    await delay(200);
  }
  assert.fail(`timed out waiting for ${approvalPolicy} session: ${JSON.stringify(last)}`);
}

async function sendMessage(page) {
  const input = page.locator("#message-input");
  await input.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await input.fill(PROMPT);
  await page.click("#send-button");
}

async function waitForReply(page) {
  await page.waitForFunction(
    (expected) => (document.querySelector("#transcript")?.textContent || "").includes(expected),
    EXPECTED_REPLY,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForNoPendingApproval(relayPort) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchSession(relayPort);
    if (!last.pending_approvals || last.pending_approvals.length === 0) {
      return;
    }
    await delay(200);
  }
  assert.fail(`approval was never cleared: ${JSON.stringify(last?.pending_approvals)}`);
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-perm-modes-"));
  const statePath = path.join(stateDir, "session.json");
  const bypassCwd = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-perm-bypass-"))
  );
  const askCwd = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-perm-ask-"))
  );

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake", FAKE_PROVIDER_ENFORCE_APPROVALS: "1" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;

  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-permission-modes-e2e" });
    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    // --- Scenario 1: bypass (YOLO) — no approval should ever appear ----------
    await startLocalSession(page, {
      cwd: bypassCwd,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    await waitForActiveSession(relayPort, { approvalPolicy: "bypass", cwd: bypassCwd });
    logStep("bypass session active");

    await sendMessage(page);
    await waitForReply(page);
    assert.equal(
      await page.locator(APPROVAL_BANNER).count(),
      0,
      "a bypass turn must not surface an approval banner",
    );
    logStep("bypass turn replied with no approval banner");

    // --- Scenario 2: untrusted — turn must park on an approval banner --------
    await startLocalSession(page, {
      cwd: askCwd,
      approvalPolicy: "untrusted",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    await waitForActiveSession(relayPort, { approvalPolicy: "untrusted", cwd: askCwd });
    logStep("untrusted session active");

    await sendMessage(page);
    await page.waitForSelector(APPROVAL_BANNER, { timeout: TIMEOUT_MS });
    logStep("approval banner appeared for untrusted turn");

    // Approving it must let the turn proceed to a reply.
    await page.click(`${APPROVAL_BANNER} [data-approval-decision="approve"]`);
    await waitForReply(page);
    // The banner container is hidden (not removed) once resolved, so confirm
    // the approval cleared via authoritative server state rather than the DOM.
    await waitForNoPendingApproval(relayPort);
    logStep("approved untrusted turn replied and approval cleared");

    console.log(
      JSON.stringify({ relayPort, bypassCwd, askCwd, ok: true }, null, 2),
    );
  } catch (error) {
    logStep("failed", { message: error instanceof Error ? error.message : String(error) });
    await writeFailureArtifacts({
      scenario: "local-permission-modes",
      relay,
      localPage: page,
      metadata: { relayPort, statePath, bypassCwd, askCwd },
    });
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    for (const cwd of [bypassCwd, askCwd]) {
      await deleteThreadsForCwdAndWait(relayPort, cwd).catch((error) => {
        console.error(`[cleanup] failed to delete threads for ${cwd}: ${error.message}`);
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(bypassCwd, { recursive: true, force: true }).catch(() => {});
    await fs.rm(askCwd, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
