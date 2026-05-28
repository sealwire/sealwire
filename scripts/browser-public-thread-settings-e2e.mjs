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
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import {
  approvePairing,
  closeSecurityModal,
  startPairingFromLocalPage,
  waitForPairedRemote,
} from "./e2e/harness/pairing.mjs";
import {
  selectFirstRelayIfNeeded,
  startRemoteSession,
} from "./e2e/harness/remote-session.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";
import {
  startPublicRelay,
  waitForBrokerConnection,
} from "./e2e/harness/relay.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-settings";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_THREAD_SETTINGS_ROOM_ID || "browser-public-thread-settings-room";

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[public-thread-settings-e2e] ${message}${suffix}`);
}

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-settings-"));
  const relayStatePath = path.join(stateDir, "session.json");
  const brokerStatePath = path.join(stateDir, "public-control.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-settings-workspace-"))
  );

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath,
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: PUBLIC_ISSUER_SECRET,
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
    peerId: "browser-public-thread-settings-relay",
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;

  try {
    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-thread-settings-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("pairing url ready", { pairingUrl });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-thread-settings-e2e" });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    await closeSecurityModal(localPage);
    logStep("remote paired");

    await selectFirstRelayIfNeeded(remotePage, TIMEOUT_MS);

    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      effort: "high",
      timeoutMs: TIMEOUT_MS,
    });
    const threadA = await waitForSession(relayPort, {
      approvalPolicy: "bypass",
      cwd: workspaceDir,
      effort: "high",
      timeoutMs: TIMEOUT_MS,
    });
    logStep("thread A ready", { threadA });

    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "untrusted",
      effort: "low",
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

    await waitForRemoteThread(remotePage, threadA);
    await waitForRemoteThread(remotePage, threadB);

    await clickRemoteThread(remotePage, threadA);
    await waitForSession(relayPort, {
      approvalPolicy: "bypass",
      cwd: workspaceDir,
      effort: "high",
      threadId: threadA,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("remote resumed thread A with remembered settings");

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          threadA,
          threadB,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
          localClientLog: await safeText(localPage, "#client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    logStep("failed", { message: error instanceof Error ? error.message : String(error) });
    await writeFailureArtifacts({
      scenario: "public-thread-settings",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        workspaceDir,
      },
    });
    dumpProcessLogs(broker, relay);
    await dumpBrowserState({ localPage, remotePage });
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete public thread-settings e2e threads for ${workspaceDir}: ${error.message}`
      );
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForRemoteThread(page, threadId) {
  await page.waitForFunction(
    (expectedThreadId) => {
      return Boolean(
        document.querySelector(`#remote-threads-list [data-thread-id="${expectedThreadId}"]`)
      );
    },
    threadId,
    { timeout: TIMEOUT_MS }
  );
}

async function clickRemoteThread(page, threadId) {
  await page.waitForFunction(
    (expectedThreadId) => {
      const button = document.querySelector(
        `#remote-threads-list [data-thread-id="${expectedThreadId}"]`
      );
      if (!button) {
        return false;
      }
      button.click();
      return true;
    },
    threadId,
    { timeout: TIMEOUT_MS }
  );
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
