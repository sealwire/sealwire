import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
  readDeviceSessionCookie,
  readStoredRemoteAuth,
  safeText,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { approvePairing, startPairingFromLocalPage, waitForPairedRemote } from "./e2e/harness/pairing.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitFor, waitForHealth } from "./e2e/harness/process.mjs";
import {
  startPublicRelay,
  waitForBrokerConnection,
  waitForRevokedDevice,
  waitForSingleStartedThread,
} from "./e2e/harness/relay.mjs";
import { sendPromptAndWaitForReply, startRemoteSession, waitForRemoteMessageInput } from "./e2e/harness/remote-session.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const BEFORE_RESTART_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_PROMPT_BEFORE ||
  "Reply with exactly: public-broker-before-restart";
const AFTER_RESTART_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_PROMPT_AFTER ||
  "Reply with exactly: public-broker-after-restart";
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_ROOM_ID || "browser-public-e2e-room";
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[public-broker-e2e] ${message}${suffix}`);
}

async function main() {
  logStep("starting");
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-browser-e2e-"));
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-public-broker-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-workspace-"))
  );

  let broker = startScenarioBroker({
    brokerPort,
    brokerStatePath,
  });
  logStep("broker started", { brokerPort });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
  logStep("broker healthy");

  const relay = startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    codexHomeDir,
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });
  logStep("relay started", { relayPort, workspaceDir });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  logStep("relay healthy");
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
  logStep("relay connected to broker");

  let browser;
  let context;
  let localPage;
  let remotePage;
  const refreshRequests = [];

  try {
    ({ browser, context } = await launchBrowser());
    logStep("browser launched");

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-broker-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    logStep("local page loaded");
    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("pairing url captured", { pairingUrl });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-broker-e2e" });
    remotePage.on("request", (request) => {
      if (/\/api\/public\/device\/(?:[^/]+\/)?ws-token$/.test(new URL(request.url()).pathname)) {
        refreshRequests.push(request.url());
        logStep("captured refresh request", { count: refreshRequests.length });
      }
    });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    logStep("remote page loaded");
    await approvePairing(localPage, TIMEOUT_MS);
    logStep("pairing approval visible");
    logStep("pairing approved");

    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    logStep("remote auth stored");

    await installDuplicateStartSessionReplayHook(remotePage);
    logStep("duplicate start-session replay hook installed");
    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });
    logStep("remote session panel opened");
    logStep("clicked start session");
    await remotePage.waitForFunction(() => Boolean(window.__capturedStartSessionFrame), null, {
      timeout: TIMEOUT_MS,
    });
    logStep("captured start-session frame");
    await remotePage.evaluate(() => window.__replayCapturedStartSessionFrame());
    logStep("replayed start-session frame");

    await waitForSingleStartedThread(relayPort, workspaceDir, {
      timeoutMs: TIMEOUT_MS,
      duplicateMessage: `duplicate start_session replay should not start more than one thread for ${workspaceDir}`,
    });
    logStep("single started thread ready");
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);
    logStep("message input ready before broker restart");

    await sendPromptAndWaitForReply(remotePage, BEFORE_RESTART_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });
    logStep("received reply before broker restart");
    const authBeforeRestart = await readStoredRemoteAuth(remotePage);
    assert.equal(
      authBeforeRestart?.hasStoredPayloadSecret,
      true,
      "paired remote should persist payload-secret availability metadata"
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(authBeforeRestart || {}, "payloadSecret"),
      false,
      "paired remote should not store payload secrets in localStorage"
    );
    assert.equal(authBeforeRestart?.deviceRefreshMode, "cookie");
    assert.equal(authBeforeRestart?.deviceRefreshToken, undefined);
    assert.equal(authBeforeRestart?.deviceJoinTicket, undefined);
    assert.equal(authBeforeRestart?.sessionClaim, undefined);
    const deviceSessionCookie = await readDeviceSessionCookie(
      context,
      `http://${lanIp}:${brokerPort}`,
      authBeforeRestart?.brokerChannelId || null
    );
    assert.ok(deviceSessionCookie, "paired remote should establish a device session cookie");
    logStep("device session cookie captured");
    await delay(3000);

    logStep("stopping broker for restart");
    await stopManagedProcess(broker);
    broker = startScenarioBroker({
      brokerPort,
      brokerStatePath,
    });
    logStep("broker restarted");
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    logStep("broker healthy after restart");
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
    logStep("relay reconnected after broker restart");

    await waitFor(() => refreshRequests.length >= 1, TIMEOUT_MS);
    logStep("refresh request observed after broker restart", { count: refreshRequests.length });
    await remotePage.waitForFunction(() => {
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return badge.trim().length > 0 && !badge.toLowerCase().includes("offline");
    }, null, { timeout: TIMEOUT_MS });
    logStep("remote status badge recovered");
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);
    logStep("message input ready after broker restart");

    await sendPromptAndWaitForReply(remotePage, AFTER_RESTART_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });
    logStep("received reply after broker restart");

    localPage.once("dialog", (dialog) => dialog.accept());
    await localPage.click("[data-revoke-device-id]");
    logStep("clicked revoke device");
    await waitForRevokedDevice(relayPort);
    logStep("device revoked");
    const authAfterRevoke = await readStoredRemoteAuth(remotePage);
    assert.equal(authAfterRevoke?.deviceRefreshMode, "cookie");
    assert.equal(authAfterRevoke?.deviceRefreshToken, undefined);
    await delay(3000);

    logStep("stopping broker after revoke");
    await stopManagedProcess(broker);
    broker = startScenarioBroker({
      brokerPort,
      brokerStatePath,
    });
    logStep("broker restarted after revoke");
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    logStep("broker healthy after revoke restart");
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
    logStep("relay reconnected after revoke restart");

    const revokedRefreshResponse = await fetch(
      `http://127.0.0.1:${brokerPort}/api/public/device/${encodeURIComponent(authBeforeRestart?.brokerChannelId || "")}/ws-token`,
      {
        method: "POST",
        headers: {
          Cookie: `${deviceSessionCookie.name}=${deviceSessionCookie.value}`,
        },
      }
    );
    assert.equal(
      revokedRefreshResponse.ok,
      false,
      "revoked device refresh token should not mint a new broker ws token"
    );
    logStep("revoked device refresh rejected");

    const relaySession = await fetchSession(relayPort);
    logStep("finished successfully", {
      refreshRequestCount: refreshRequests.length,
      activeThreadId: relaySession.active_thread_id,
    });
    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          lanIp,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          activeThreadId: relaySession.active_thread_id,
          refreshRequestCount: refreshRequests.length,
          deviceStates: relaySession.device_records?.map((device) => ({
            deviceId: device.device_id,
            state: device.lifecycle_state,
            lastPeerId: device.last_peer_id,
          })),
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    logStep("failed", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    });
    await dumpBrowserState({ localPage, remotePage });
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
    await writeFailureArtifacts({
      scenario: "public-broker",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        workspaceDir,
        refreshRequestCount: refreshRequests.length,
        fakeProvider: USE_FAKE_PROVIDER,
      },
    });
    throw error;
  } finally {
    logStep("cleanup starting");
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete public broker e2e threads for ${workspaceDir}: ${error.message}`
      );
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(relayStateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    logStep("cleanup finished");
  }
}

function startScenarioBroker({ brokerPort, brokerStatePath }) {
  return startPublicBroker({
    brokerPort,
    brokerStatePath,
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: PUBLIC_ISSUER_SECRET,
    deviceWsTtlSecs: 2,
  });
}

async function installDuplicateStartSessionReplayHook(page) {
  await page.evaluate(() => {
    if (window.__agentRelayReplayHookInstalled) {
      return;
    }

    window.__agentRelayReplayHookInstalled = true;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      window.__agentRelayLastSocket = this;
      if (
        typeof data === "string" &&
        data.includes('"kind":"encrypted_remote_action"') &&
        data.includes('"action_id":"start_session-')
      ) {
        window.__capturedStartSessionFrame = data;
      }
      return originalSend.call(this, data);
    };
    window.__replayCapturedStartSessionFrame = () => {
      if (!window.__capturedStartSessionFrame || !window.__agentRelayLastSocket) {
        throw new Error("captured start_session frame is missing");
      }
      window.__agentRelayLastSocket.send(window.__capturedStartSessionFrame);
    };
  });
}


main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
