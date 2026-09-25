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
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import {
  approvePairing,
  closeSecurityModal,
  startPairingFromLocalPage,
  waitForPairedRemote,
} from "./e2e/harness/pairing.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";
import { startPublicRelay, waitForBrokerConnection } from "./e2e/harness/relay.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const A_PROMPT = "run public deterministic thread alpha";
const A_BEFORE = "[public-alpha-before-release]";
const A_AFTER = "[public-alpha-after-release]";
const A_REPLY = `${A_BEFORE}${A_AFTER}`;
const B_PROMPT = "Reply with exactly: [public-beta-complete]";
const B_REPLY = "[public-beta-complete]";
const BARRIER = "public-thread-alpha";
const DELEGATE_QUESTION = "[delegated-question-visibility-probe]";
const DELEGATE_BARRIER = "delegated-question-stream";
const DIRECT_QUESTION = "[direct-question-visibility-probe]";
const DIRECT_BARRIER = "direct-question-stream";
const PROBE_MESSAGE_VISIBILITY = process.env.PROBE_MESSAGE_VISIBILITY === "1";
const ISSUER_SECRET = "browser-public-interleaving-issuer";
const RELAY_REFRESH_TOKEN = "browser-public-interleaving-refresh";
const RELAY_ID = "browser-public-interleaving-relay";
const BROKER_ROOM_ID = "browser-public-interleaving-room";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-interleaving-"));
  const relayStatePath = path.join(stateDir, "session.json");
  const brokerStatePath = path.join(stateDir, "public-control.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-interleaving-workspace-"))
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
    matchers: [{
      contains: [DELEGATE_QUESTION, "Another agent asked for this"],
      scenario: {
        tool_calls: 12,
        tool_call_delay_ms: 25,
        reasoning_between_tools: true,
        chunks: ["Delegated reply began. ", "Delegated reply still streaming."],
        chunk_delay_ms: 100,
        pause_after_chunks: 1,
        barrier: DELEGATE_BARRIER,
      },
    }, {
      contains: [DIRECT_QUESTION],
      scenario: {
        tool_calls: 18,
        tool_call_delay_ms: 0,
        reasoning_between_tools: true,
        chunks: ["Direct reply began. ", "Direct reply still streaming."],
        chunk_delay_ms: 100,
        pause_after_chunks: 1,
        barrier: DIRECT_BARRIER,
      },
    }],
  });

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath,
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: ISSUER_SECRET,
  });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    peerId: "browser-public-interleaving-relay-peer",
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      FAKE_PROVIDER_BARRIER_TIMEOUT_MS: String(TIMEOUT_MS),
      ...fakeHarness.env,
    },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;
  let threadA;
  let threadB;
  const pageErrors = [];

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 720 } },
    }));
    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-thread-interleaving-e2e" });
    localPage.on("pageerror", (error) => pageErrors.push(`local: ${error.stack || error.message}`));
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });
    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-thread-interleaving-e2e" });
    remotePage.on("pageerror", (error) => pageErrors.push(`remote: ${error.stack || error.message}`));
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    await closeSecurityModal(localPage);
    await selectFirstRelayIfNeeded(remotePage);

    await startLocalSession(localPage, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    threadA = await waitForNewActiveThread(relayPort, null);
    await waitForLocalViewedThread(localPage, threadA);
    await sendLocalMessage(localPage, A_PROMPT);
    const paused = await fakeHarness.waitForBarrier(BARRIER, TIMEOUT_MS);
    assert.equal(paused.thread_id, threadA, "the paused public turn must belong to thread A");
    await waitForText(localPage, "#transcript", A_BEFORE);

    await startLocalSession(localPage, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });
    threadB = await waitForNewActiveThread(relayPort, threadA);
    // Drafts are per thread: text typed before the page switches stays with the old one.
    await waitForLocalViewedThread(localPage, threadB);
    await localPage.waitForFunction(
      (priorReply) => !(document.querySelector("#transcript")?.textContent || "").includes(priorReply),
      A_BEFORE,
      { timeout: TIMEOUT_MS }
    );
    await sendLocalMessage(localPage, B_PROMPT);
    await waitForText(localPage, "#transcript", B_REPLY);

    await remotePage.click("#remote-threads-refresh-button");
    await waitForThreadRow(remotePage, threadA);
    await waitForThreadRow(remotePage, threadB);
    await remotePage.click(remoteThreadSelector(threadB));
    await waitForViewedThread(remotePage, threadB);
    await waitForText(remotePage, "#remote-transcript", B_REPLY);
    assertNoText(localPage, "#transcript", A_AFTER, "local B before release");
    assertNoText(remotePage, "#remote-transcript", A_AFTER, "remote B before release");

    if (PROBE_MESSAGE_VISIBILITY) {
      await remotePage.waitForFunction(() =>
        !document.querySelector("#remote-message-input")?.disabled, null, { timeout: TIMEOUT_MS });
      await remotePage.fill("#remote-message-input", DIRECT_QUESTION);
      await remotePage.click("#remote-send-button");
      await fakeHarness.waitForBarrier(DIRECT_BARRIER, TIMEOUT_MS);
      const directBackend = await fetch(
        `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadB)}/transcript`
      ).then((response) => response.json());
      assert.ok(directBackend.data?.entries?.some((entry) => (entry.text || "").includes(DIRECT_QUESTION)));
      await delay(1500);
      const directRemoteVisible = await remotePage.evaluate((marker) =>
        [...document.querySelectorAll("#remote-transcript .chat-message-user")]
          .some((node) => (node.textContent || "").includes(marker)), DIRECT_QUESTION);
      console.log(JSON.stringify({ directQuestion: { whileStreaming: directRemoteVisible } }));
      await fakeHarness.releaseBarrier(DIRECT_BARRIER);
      await waitForThreadIdle(relayPort, threadB);
    }

    await fakeHarness.releaseBarrier(BARRIER);
    await waitForThreadTranscript(relayPort, threadA, A_REPLY);
    await waitForThreadIdle(relayPort, threadA);
    assert.equal(
      (await fetchSession(relayPort)).active_thread_id,
      threadB,
      "thread A's late public terminal must not steal the live projection from B"
    );
    assertNoText(localPage, "#transcript", A_AFTER, "local B after release");
    assertNoText(remotePage, "#remote-transcript", A_AFTER, "remote B after release");
    assert.ok((await textOf(localPage, "#transcript")).includes(B_REPLY));
    assert.ok((await textOf(remotePage, "#remote-transcript")).includes(B_REPLY));

    await remotePage.click("#remote-threads-refresh-button");
    await waitForThreadRow(remotePage, threadA);
    await remotePage.click(remoteThreadSelector(threadA));
    await waitForViewedThread(remotePage, threadA);
    await waitForText(remotePage, "#remote-transcript", A_REPLY);
    const remoteA = await textOf(remotePage, "#remote-transcript");
    assert.equal(remoteA.includes(B_REPLY), false, "remote A must not contain thread B's reply");
    assert.ok(
      (await textOf(localPage, "#transcript")).includes(B_REPLY),
      "remote view-only navigation must leave local B visible"
    );
    assert.equal(
      (await fetchSession(relayPort)).active_thread_id,
      threadB,
      "remote view-only navigation to A must not mutate relay control"
    );

    if (PROBE_MESSAGE_VISIBILITY) {
      // A person delegates from the active B into the background A. Sample the
      // remote view before and after taking over and reloading.
      const delegateResponse = await fetch(`http://127.0.0.1:${relayPort}/api/session/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
        body: JSON.stringify({ thread_id: threadB, agent: threadA, message: DELEGATE_QUESTION }),
      });
      const delegateResult = await delegateResponse.json();
      assert.equal(delegateResponse.ok, true, JSON.stringify(delegateResult));
      assert.equal(delegateResult.isError, false, JSON.stringify(delegateResult));
      await fakeHarness.waitForBarrier(DELEGATE_BARRIER, TIMEOUT_MS);
      const backendQuestion = await fetch(
        `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadA)}/transcript`
      ).then((response) => response.json());
      assert.ok(
        backendQuestion.data?.entries?.some((entry) => (entry.text || "").includes(DELEGATE_QUESTION)),
        "relay must hold the delegated question while the peer is streaming"
      );
      const questionVisible = async () => {
        await remotePage.evaluate(() => {
          const pane = document.querySelector("#remote-transcript");
          if (pane) pane.scrollTop = 0;
        });
        await delay(1500);
        return remotePage.evaluate((marker) =>
          [...document.querySelectorAll("#remote-transcript .chat-message-user")]
            .some((node) => (node.textContent || "").includes(marker)), DELEGATE_QUESTION);
      };
      const beforeTakeover = await questionVisible();
      const canTakeOver = await remotePage.evaluate(() =>
        Boolean(document.querySelector("#remote-take-over-button:not([disabled]):not([hidden])")));
      let afterTakeover = null;
      if (canTakeOver) {
        await remotePage.click("#remote-take-over-button");
        await remotePage.waitForTimeout(1000);
        afterTakeover = await questionVisible();
      }
      const remoteUrl = remotePage.url();
      await remotePage.goto(remoteUrl, { waitUntil: "domcontentloaded" });
      await remotePage.waitForSelector("#remote-transcript", { timeout: TIMEOUT_MS });
      const afterRefresh = await questionVisible();
      console.log(JSON.stringify({
        delegatedQuestion: { beforeTakeover, canTakeOver, afterTakeover, afterRefresh },
      }));
      assert.equal(afterRefresh, true, "a fresh remote page must show the delegated question");
      assert.equal(beforeTakeover, true, "a remote observer should show the delegated question without refresh");
    }
    assert.deepEqual(pageErrors, [], "the local + remote flow must not raise browser errors");

    console.log(
      JSON.stringify(
        {
          ok: true,
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          threadA,
          threadB,
          barrier: paused,
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "public-thread-interleaving",
      broker,
      relay,
      relayPort,
      localPage,
      remotePage,
      metadata: { brokerPort, relayPort, lanIp, workspaceDir, threadA, threadB },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    await dumpBrowserState({ localPage, remotePage });
    dumpProcessLogs(broker, relay);
    throw error;
  } finally {
    await fakeHarness.releaseBarrier(BARRIER).catch(() => {});
    await fakeHarness.releaseBarrier(DIRECT_BARRIER).catch(() => {});
    await fakeHarness.releaseBarrier(DELEGATE_BARRIER).catch(() => {});
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(`[cleanup] failed to delete public interleaving threads: ${error.message}`);
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function selectFirstRelayIfNeeded(page) {
  const disabled = await page.evaluate(() => Boolean(document.querySelector("#remote-session-toggle")?.disabled));
  if (!disabled) return;
  await page.click("#remote-relays-list [data-relay-id]:not([disabled])");
  await page.waitForFunction(
    () => Boolean(document.querySelector("#remote-session-toggle:not([disabled])")),
    null,
    { timeout: TIMEOUT_MS }
  );
}

async function sendLocalMessage(page, text) {
  await page.waitForFunction(() => !document.querySelector("#message-input")?.disabled, null, {
    timeout: TIMEOUT_MS,
  });
  await page.fill("#message-input", text);
  await page.waitForFunction((expected) =>
    document.querySelector("#message-input")?.value === expected, text, { timeout: TIMEOUT_MS });
  await page.click("#send-button");
}

async function waitForLocalViewedThread(page, threadId) {
  await page.waitForSelector(`#threads-list [data-thread-id="${threadId}"].is-active`, {
    timeout: TIMEOUT_MS,
  });
}

function remoteThreadSelector(threadId) {
  return `#remote-threads-list [data-thread-id="${threadId}"]`;
}

async function waitForThreadRow(page, threadId) {
  await page.waitForSelector(remoteThreadSelector(threadId), { timeout: TIMEOUT_MS });
}

async function waitForViewedThread(page, threadId) {
  await page.waitForFunction(
    (expected) =>
      Boolean(
        document.querySelector(
          `#remote-threads-list [data-thread-id="${expected}"].is-active`
        )
      ),
    threadId,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) =>
      (document.querySelector(selector)?.textContent || "").includes(expected),
    { selector, expected },
    { timeout: TIMEOUT_MS }
  );
}

async function textOf(page, selector) {
  return (await page.textContent(selector)) || "";
}

async function assertNoText(page, selector, unexpected, label) {
  assert.equal(
    (await textOf(page, selector)).includes(unexpected),
    false,
    `${label} must not contain ${unexpected}`
  );
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
  throw new Error("timed out waiting for a new active public thread");
}

async function waitForThreadTranscript(relayPort, threadId, expected) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadId)}/transcript`
    );
    const payload = await response.json().catch(() => null);
    if (
      (payload?.data?.entries || []).some(
        (entry) => entry.text === expected && entry.status === "completed"
      )
    ) {
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
    if (!(session.thread_activity || []).some((item) => item?.thread_id === threadId)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${threadId} to become idle`);
}

await main();
