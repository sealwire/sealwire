import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const A_PROMPT = "run deterministic thread alpha";
const A_BEFORE = "[alpha-before-release]";
const A_AFTER = "[alpha-after-release]";
const A_REPLY = `${A_BEFORE}${A_AFTER}`;
const B_PROMPT = "Reply with exactly: [beta-complete]";
const B_REPLY = "[beta-complete]";
const BARRIER = "thread-alpha";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-interleaving-"));
  const statePath = path.join(stateDir, "session.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-interleaving-workspace-"))
  );
  const fakeHarness = await createFakeProviderScenarioHarness(stateDir, {
    prompts: {
      [A_PROMPT]: {
        chunks: [A_BEFORE, A_AFTER],
        reply: A_REPLY,
        chunk_delay_ms: 5,
        pause_after_chunks: 1,
        barrier: BARRIER,
      },
    },
  });

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      FAKE_PROVIDER_BARRIER_TIMEOUT_MS: String(TIMEOUT_MS),
      ...fakeHarness.env,
    },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  let threadA;
  let threadB;
  const pageErrors = [];

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 720 } },
    }));
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-thread-interleaving-e2e" });
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    threadA = await waitForNewActiveThread(relayPort, null);
    await sendMessage(page, A_PROMPT);

    const paused = await fakeHarness.waitForBarrier(BARRIER, TIMEOUT_MS);
    assert.equal(paused.thread_id, threadA, "the paused turn must belong to thread A");
    await waitForTranscriptText(page, A_BEFORE);
    assert.equal(
      (await transcriptText(page)).includes(A_AFTER),
      false,
      "thread A must remain visibly partial while its provider barrier is closed"
    );
    assert.equal(
      (await fetchSession(relayPort)).active_thread_id,
      threadA,
      "thread A should own the live projection before switching"
    );

    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    threadB = await waitForNewActiveThread(relayPort, threadA);
    await sendMessage(page, B_PROMPT);
    await waitForTranscriptText(page, B_REPLY);
    assert.equal(
      (await transcriptText(page)).includes(A_AFTER),
      false,
      "thread B must not render thread A's unreleased output"
    );

    await fakeHarness.releaseBarrier(BARRIER);
    await waitForThreadTranscript(relayPort, threadA, A_REPLY);
    await waitForThreadIdle(relayPort, threadA);
    assert.equal(
      (await fetchSession(relayPort)).active_thread_id,
      threadB,
      "thread A's late terminal must not steal the active projection from thread B"
    );
    assert.equal(
      (await transcriptText(page)).includes(A_AFTER),
      false,
      "thread A's late delta must not leak into thread B's visible transcript"
    );
    assert.ok(
      (await transcriptText(page)).includes(B_REPLY),
      "thread B must remain visible after thread A completes in the background"
    );

    await clickThread(page, threadA);
    await waitForViewedThread(page, threadA);
    await waitForTranscriptText(page, A_REPLY);
    const restoredText = await transcriptText(page);
    assert.ok(restoredText.includes(A_BEFORE), "thread A should retain its pre-switch delta");
    assert.ok(restoredText.includes(A_AFTER), "thread A should include its background completion");
    assert.equal(
      restoredText.includes(B_REPLY),
      false,
      "viewing thread A must not contain thread B's reply"
    );
    assert.deepEqual(pageErrors, [], "the interleaving flow must not raise browser errors");

    console.log(
      JSON.stringify({ ok: true, relayPort, workspaceDir, threadA, threadB, barrier: paused }, null, 2)
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-thread-interleaving",
      relay,
      relayPort,
      localPage: page,
      metadata: { relayPort, statePath, workspaceDir, threadA, threadB },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await fakeHarness.releaseBarrier(BARRIER).catch(() => {});
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(`[cleanup] failed to delete interleaving threads: ${error.message}`);
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendMessage(page, text) {
  const input = page.locator("#message-input");
  await input.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await page.waitForFunction(
    () => !document.querySelector("#message-input")?.disabled,
    null,
    { timeout: TIMEOUT_MS }
  );
  await input.fill(text);
  await page.click("#send-button");
}

async function clickThread(page, threadId) {
  const selector = `#threads-list [data-thread-id="${threadId}"]`;
  await page.waitForSelector(selector, { timeout: TIMEOUT_MS });
  await page.click(selector);
}

async function waitForViewedThread(page, threadId) {
  await page.waitForFunction(
    (expected) =>
      Boolean(document.querySelector(`#threads-list [data-thread-id="${expected}"].is-active`)),
    threadId,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForTranscriptText(page, expected) {
  await page.waitForFunction(
    (text) => (document.querySelector("#transcript")?.textContent || "").includes(text),
    expected,
    { timeout: TIMEOUT_MS }
  );
}

async function transcriptText(page) {
  return (await page.textContent("#transcript")) || "";
}

async function waitForNewActiveThread(relayPort, previousThreadId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.active_thread_id && session.active_thread_id !== previousThreadId) {
      return session.active_thread_id;
    }
    await delay(50);
  }
  throw new Error("timed out waiting for a new active thread");
}

async function waitForThreadTranscript(relayPort, threadId, expected) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadId)}/transcript`
    );
    const payload = await response.json().catch(() => null);
    const entries = payload?.data?.entries || [];
    if (entries.some((entry) => entry.text === expected && entry.status === "completed")) {
      return;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for completed transcript on ${threadId}`);
}

async function waitForThreadIdle(relayPort, threadId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const working = (session.thread_activity || []).some(
      (activity) => activity?.thread_id === threadId
    );
    if (!working) {
      return;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${threadId} to become idle`);
}

await main();
