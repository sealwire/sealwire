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
  safeText,
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

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[local-thread-settings-e2e] ${message}${suffix}`);
}

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-settings-"));
  const statePath = path.join(stateDir, "session.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-settings-workspace-"))
  );

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;

  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-thread-settings-e2e" });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      effort: "high",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    const threadA = await waitForSession(relayPort, {
      approvalPolicy: "bypass",
      cwd: workspaceDir,
      effort: "high",
      timeoutMs: TIMEOUT_MS,
    });
    logStep("thread A ready", { threadA });

    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "untrusted",
      effort: "low",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    const threadB = await waitForSession(relayPort, {
      approvalPolicy: "untrusted",
      cwd: workspaceDir,
      effort: "low",
      notThreadId: threadA,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("thread B ready", { threadB });

    await clickThread(page, threadA);
    await waitForSession(relayPort, {
      approvalPolicy: "bypass",
      cwd: workspaceDir,
      effort: "high",
      threadId: threadA,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("thread A settings restored");

    await clickThread(page, threadB);
    await waitForSession(relayPort, {
      approvalPolicy: "untrusted",
      cwd: workspaceDir,
      effort: "low",
      threadId: threadB,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("thread B settings restored");

    console.log(
      JSON.stringify(
        {
          relayPort,
          workspaceDir,
          threadA,
          threadB,
          clientLog: await safeText(page, "#client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    logStep("failed", { message: error instanceof Error ? error.message : String(error) });
    await writeFailureArtifacts({
      scenario: "local-thread-settings",
      relay,
      localPage: page,
      metadata: {
        relayPort,
        statePath,
        workspaceDir,
      },
    });
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete local thread-settings e2e threads for ${workspaceDir}: ${error.message}`
      );
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function clickThread(page, threadId) {
  const selector = `#threads-list [data-thread-id="${threadId}"]`;
  await page.waitForSelector(selector, { timeout: TIMEOUT_MS });
  await page.click(selector);
}

async function waitForSession(
  relayPort,
  { approvalPolicy, cwd, effort, notThreadId, threadId, timeoutMs }
) {
  const deadline = Date.now() + timeoutMs;
  let lastSession = null;
  while (Date.now() < deadline) {
    lastSession = await fetchSession(relayPort);
    const activeThreadId = lastSession.active_thread_id;
    if (
      activeThreadId &&
      (!threadId || activeThreadId === threadId) &&
      (!notThreadId || activeThreadId !== notThreadId) &&
      lastSession.current_cwd === cwd &&
      lastSession.approval_policy === approvalPolicy &&
      lastSession.reasoning_effort === effort
    ) {
      return activeThreadId;
    }
    await delay(250);
  }
  assert.fail(
    `timed out waiting for session ${JSON.stringify({
      approvalPolicy,
      cwd,
      effort,
      notThreadId,
      threadId,
      lastSession,
    })}`
  );
}

await main();
