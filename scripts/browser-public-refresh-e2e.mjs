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
  launchBrowser,
  readDeviceSessionCookie,
  readStoredRemoteAuth,
  safeText,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { approvePairing, startPairingFromLocalPage } from "./e2e/harness/pairing.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitFor, waitForHealth } from "./e2e/harness/process.mjs";
import {
  startPublicRelay,
  waitForBrokerConnection,
  waitForSingleStartedThread,
} from "./e2e/harness/relay.mjs";
import {
  sendPromptAndWaitForReply,
  startRemoteSession,
  waitForRemoteMessageInput,
} from "./e2e/harness/remote-session.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const BEFORE_REFRESH_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_REFRESH_PROMPT_BEFORE ||
  "Reply with exactly: public-refresh-before-expiry";
const AFTER_REFRESH_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_REFRESH_PROMPT_AFTER ||
  "Reply with exactly: public-refresh-after-reconnect";
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_ROOM_ID || "browser-public-refresh-room";
const DEVICE_WS_TTL_SECS = Number(process.env.BROWSER_E2E_PUBLIC_DEVICE_WS_TTL_SECS || 2);
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-refresh-e2e-"));
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-public-refresh-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-refresh-workspace-"))
  );

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath,
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: PUBLIC_ISSUER_SECRET,
    deviceWsTtlSecs: DEVICE_WS_TTL_SECS,
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
    codexHomeDir,
    peerId: "browser-public-refresh-relay",
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;
  const refreshRequests = [];

  try {
    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-refresh-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-refresh-e2e" });
    await remotePage.setViewportSize({ width: 390, height: 844 });
    remotePage.on("request", (request) => {
      if (request.url().endsWith("/api/public/device/ws-token")) {
        refreshRequests.push(request.url());
      }
    });
    await remotePage.goto(`http://${lanIp}:${brokerPort}`, { waitUntil: "domcontentloaded" });
    await openMobileDrawer(remotePage);
    await installSocketLifecycleHook(remotePage);
    await openPairingModal(remotePage);
    await remotePage.fill("#pairing-input", pairingUrl);
    await remotePage.click("#connect-button");

    await approvePairing(localPage, TIMEOUT_MS);
    await remotePage.waitForFunction(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("agent-relay.remote-state") ||
          window.localStorage.getItem("agent-relay.remote-state-v2") ||
          "null"
      );
      return Boolean(
        stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length
      );
    }, null, { timeout: TIMEOUT_MS });
    await remotePage.waitForFunction(() => Boolean(window.__agentRelayLastSocket), null, {
      timeout: TIMEOUT_MS,
    });

    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });

    await waitForSingleStartedThread(relayPort, workspaceDir, {
      timeoutMs: TIMEOUT_MS,
      duplicateMessage: `refresh reconnect flow should not start more than one thread for ${workspaceDir}`,
    });
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);
    await waitForMobileDrawerState(remotePage, "closed");
    await openMobileDrawer(remotePage);
    await remotePage.waitForFunction(() => {
      return Boolean(document.querySelector("[data-thread-id]"));
    }, null, { timeout: TIMEOUT_MS });
    await remotePage.click("[data-thread-id]");
    await waitForMobileDrawerState(remotePage, "closed");

    await sendPromptAndWaitForReply(remotePage, BEFORE_REFRESH_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });

    const authBeforeExpiry = await readStoredRemoteAuth(remotePage);
    assertRemoteAuthUsesCookieOnly(authBeforeExpiry);
    const deviceSessionCookie = await readDeviceSessionCookie(
      context,
      `http://${lanIp}:${brokerPort}`
    );
    assert.ok(deviceSessionCookie, "paired remote should establish a device session cookie");

    await delay((DEVICE_WS_TTL_SECS + 1) * 1000);
    await remotePage.evaluate(() => window.__agentRelayForceSocketClose("test_token_expired"));
    await waitFor(() => refreshRequests.length >= 1, TIMEOUT_MS);

    await remotePage.waitForFunction(() => {
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return badge.trim().length > 0 && !badge.toLowerCase().includes("offline");
    }, null, { timeout: TIMEOUT_MS });
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);

    await sendPromptAndWaitForReply(remotePage, AFTER_REFRESH_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });
    assertRemoteAuthUsesCookieOnly(await readStoredRemoteAuth(remotePage));

    const relaySession = await fetchSession(relayPort);
    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          remoteNavState: await remotePage.evaluate(
            () => document.querySelector(".app-shell")?.dataset.remoteNavState || null
          ),
          activeThreadId: relaySession.active_thread_id,
          refreshRequestCount: refreshRequests.length,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "public-refresh",
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
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete public refresh e2e threads for ${workspaceDir}: ${error.message}`
      );
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(relayStateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function openMobileDrawer(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector("#remote-nav-toggle-button");
    return Boolean(button && !button.hidden);
  }, null, { timeout: TIMEOUT_MS });
  await page.click("#remote-nav-toggle-button");
  await waitForMobileDrawerState(page, "open");
}

async function waitForMobileDrawerState(page, state) {
  await page.waitForFunction(
    (expected) => document.querySelector(".app-shell")?.dataset.remoteNavState === expected,
    state,
    { timeout: TIMEOUT_MS }
  );
}

async function openPairingModal(page) {
  const isOpen = await page.evaluate(() =>
    Boolean(document.querySelector("#pairing-modal")?.open)
  );
  if (isOpen) {
    return;
  }

  await page.click("#open-pairing-modal");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#pairing-modal");
    return Boolean(dialog?.open);
  }, null, { timeout: TIMEOUT_MS });
}

async function installSocketLifecycleHook(page) {
  await page.evaluate(() => {
    if (window.__agentRelaySocketLifecycleHookInstalled) {
      return;
    }

    window.__agentRelaySocketLifecycleHookInstalled = true;
    const NativeWebSocket = window.WebSocket;
    window.__agentRelaySentActionIds = [];
    window.__agentRelayReceivedActionIds = [];

    class InstrumentedWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__agentRelayLastSocket = this;
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const frame = JSON.parse(event.data);
            const actionId = frame?.payload?.action_id;
            if (actionId) {
              window.__agentRelayReceivedActionIds.push(actionId);
            }
          } catch {}
        });
      }

      send(data) {
        if (typeof data === "string") {
          try {
            const frame = JSON.parse(data);
            const actionId = frame?.payload?.action_id;
            if (actionId) {
              window.__agentRelaySentActionIds.push(actionId);
            }
          } catch {}
        }
        return super.send(data);
      }
    }

    window.WebSocket = InstrumentedWebSocket;
    window.__agentRelayForceSocketClose = (reason = "test_disconnect") => {
      if (!window.__agentRelayLastSocket) {
        throw new Error("no broker socket has been observed yet");
      }
      window.__agentRelayLastSocket.close(4101, reason);
    };
  });
}

function assertRemoteAuthUsesCookieOnly(auth) {
  assert.equal(
    auth?.hasStoredPayloadSecret,
    true,
    "paired remote should persist payload-secret availability metadata"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(auth || {}, "payloadSecret"),
    false,
    "paired remote should not store payload secrets in localStorage"
  );
  assert.equal(auth?.deviceRefreshMode, "cookie");
  assert.equal(auth?.deviceRefreshToken, undefined);
  assert.equal(auth?.deviceJoinTicket, undefined);
  assert.equal(auth?.sessionClaim, undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
