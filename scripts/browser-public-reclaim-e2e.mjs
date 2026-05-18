import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  launchBrowser,
  readStoredRemoteAuth,
  safeText,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { approvePairing, startPairingFromLocalPage, waitForPairedRemote } from "./e2e/harness/pairing.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
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
const BEFORE_RESTART_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_RECLAIM_PROMPT_BEFORE ||
  "Reply with exactly: public-reclaim-before-restart";
const AFTER_RESTART_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_RECLAIM_PROMPT_AFTER ||
  "Reply with exactly: public-reclaim-after-restart";
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_RECLAIM_ROOM_ID || "browser-public-reclaim-room";
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-reclaim-e2e-"));
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-reclaim-workspace-"))
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

  let relay = startRelay({ relayPort, relayStatePath, brokerPort, lanIp });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;
  let createdThreadId = null;
  let authBeforeRestart = null;
  let authAfterRestart = null;
  let payloadSecretBeforeRestart = null;
  let payloadSecretAfterRestart = null;

  try {
    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-reclaim-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-reclaim-e2e" });
    await installClaimLifecycleHook(remotePage);
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });

    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);

    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });

    await waitForSingleStartedThread(relayPort, workspaceDir, {
      timeoutMs: TIMEOUT_MS,
      duplicateMessage: `reclaim flow should not start more than one thread for ${workspaceDir}`,
    });
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);

    await sendPromptAndWaitForReply(remotePage, BEFORE_RESTART_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });

    const claimCountsBeforeRestart = await readClaimCounters(remotePage);
    assert.ok(
      claimCountsBeforeRestart.claimChallengeCount >= 1,
      "initial remote pairing/control flow should issue at least one claim_challenge"
    );
    assert.ok(
      claimCountsBeforeRestart.claimDeviceCount >= 1,
      "initial remote pairing/control flow should issue at least one claim_device"
    );

    const relaySessionBeforeRestart = await fetchSession(relayPort);
    createdThreadId = relaySessionBeforeRestart.active_thread_id;
    assert.ok(createdThreadId, "remote start should create an active thread before relay restart");
    authBeforeRestart = await readStoredRemoteAuth(remotePage);
    assertStoredPayloadSecretMetadata(authBeforeRestart);
    payloadSecretBeforeRestart = await readPersistedPayloadSecret(remotePage);
    assert.ok(payloadSecretBeforeRestart, "paired remote should persist a payload secret");
    await waitForPersistedRelayState(relayStatePath, createdThreadId);
    await waitForPersistedPayloadSecret(
      relayStatePath,
      authBeforeRestart.deviceId,
      payloadSecretBeforeRestart
    );

    await stopManagedProcess(relay);
    relay = startRelay({ relayPort, relayStatePath, brokerPort, lanIp });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

    await remotePage.waitForFunction(
      ({ beforeChallenge, beforeDevice }) => {
        return (
          (window.__agentRelayClaimChallengeCount || 0) > beforeChallenge &&
          (window.__agentRelayClaimDeviceCount || 0) > beforeDevice
        );
      },
      {
        beforeChallenge: claimCountsBeforeRestart.claimChallengeCount,
        beforeDevice: claimCountsBeforeRestart.claimDeviceCount,
      },
      { timeout: TIMEOUT_MS }
    );

    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);

    const relaySessionAfterRestart = await fetchSession(relayPort);
    assert.equal(
      relaySessionAfterRestart.active_thread_id,
      createdThreadId,
      "relay restart should restore the previously active thread"
    );
    assert.equal(
      relaySessionAfterRestart.current_cwd,
      workspaceDir,
      "relay restart should restore the active session cwd"
    );
    authAfterRestart = await readStoredRemoteAuth(remotePage);
    assertStoredPayloadSecretMetadata(authAfterRestart);
    payloadSecretAfterRestart = await readPersistedPayloadSecret(remotePage);
    assert.ok(payloadSecretAfterRestart, "payload secret should still be persisted after reclaim");
    assert.equal(
      payloadSecretAfterRestart,
      payloadSecretBeforeRestart,
      "reclaim should not rotate the payload secret"
    );
    await waitForPersistedPayloadSecret(
      relayStatePath,
      authAfterRestart.deviceId,
      payloadSecretAfterRestart
    );

    await sendPromptAndWaitForReply(remotePage, AFTER_RESTART_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });
    const claimCountsAfterRestart = await readClaimCounters(remotePage);

    assert.ok(
      claimCountsAfterRestart.claimChallengeCount > claimCountsBeforeRestart.claimChallengeCount,
      "relay restart should trigger an automatic claim_challenge"
    );
    assert.ok(
      claimCountsAfterRestart.claimDeviceCount > claimCountsBeforeRestart.claimDeviceCount,
      "relay restart should trigger an automatic claim_device"
    );

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          activeThreadId: createdThreadId,
          claimCountsBeforeRestart,
          claimCountsAfterRestart,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "public-reclaim",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        workspaceDir,
        activeThreadId: createdThreadId,
        fakeProvider: USE_FAKE_PROVIDER,
        authBeforeRestartDeviceId: authBeforeRestart?.deviceId || null,
        authAfterRestartDeviceId: authAfterRestart?.deviceId || null,
        authBeforeRestartHash: hashIfString(payloadSecretBeforeRestart),
        authAfterRestartHash: hashIfString(payloadSecretAfterRestart),
      },
    });
    dumpProcessLogs(broker, relay);
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete public reclaim e2e threads for ${workspaceDir}: ${error.message}`
      );
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(relayStateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

function startRelay({ relayPort, relayStatePath, brokerPort, lanIp }) {
  return startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    peerId: "browser-public-reclaim-relay",
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });
}

function assertStoredPayloadSecretMetadata(auth) {
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
}

async function installClaimLifecycleHook(page) {
  await page.addInitScript(() => {
    if (window.__agentRelayClaimLifecycleHookInstalled) {
      return;
    }

    window.__agentRelayClaimLifecycleHookInstalled = true;
    window.__agentRelayClaimChallengeCount = 0;
    window.__agentRelayClaimDeviceCount = 0;
    const NativeWebSocket = window.WebSocket;

    class InstrumentedWebSocket extends NativeWebSocket {
      send(data) {
        if (typeof data === "string") {
          if (data.includes('"action_id":"claim_challenge-')) {
            window.__agentRelayClaimChallengeCount += 1;
          }
          if (data.includes('"action_id":"claim_device-')) {
            window.__agentRelayClaimDeviceCount += 1;
          }
        }
        return super.send(data);
      }
    }

    window.WebSocket = InstrumentedWebSocket;
  });
}

async function readClaimCounters(page) {
  return page.evaluate(() => ({
    claimChallengeCount: window.__agentRelayClaimChallengeCount || 0,
    claimDeviceCount: window.__agentRelayClaimDeviceCount || 0,
  }));
}

async function waitForPersistedRelayState(statePath, expectedThreadId, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.active_thread_id === expectedThreadId) {
        return parsed;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for relay state persistence for ${expectedThreadId}`);
}

async function waitForPersistedPayloadSecret(
  statePath,
  deviceId,
  payloadSecret,
  timeoutMs = TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  let lastPersistedSecret = null;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      const persistedSecret = parsed?.paired_devices?.[deviceId]?.payload_secret || null;
      lastPersistedSecret = persistedSecret;
      if (persistedSecret === payloadSecret) {
        return parsed;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(
    `timed out waiting for persisted payload secret for ${deviceId} (last seen ${lastPersistedSecret})`
  );
}

async function readPersistedPayloadSecret(page) {
  return page.evaluate(async () => {
    const parsed = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state") ||
        window.localStorage.getItem("agent-relay.remote-state-v2") ||
        "null"
    );
    if (!parsed?.remoteProfiles) {
      return null;
    }
    const activeRelayId = parsed.activeRelayId || Object.keys(parsed.remoteProfiles)[0] || null;
    if (!activeRelayId || !window.indexedDB) {
      return null;
    }

    const database = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open("agent-relay-secrets", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("failed to open payload-secret database"));
    });

    try {
      const record = await new Promise((resolve, reject) => {
        const transaction = database.transaction("payload-secrets", "readonly");
        const store = transaction.objectStore("payload-secrets");
        const request = store.get(activeRelayId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("failed to read payload secret record"));
      });

      if (!record) {
        return null;
      }

      if (record.kind === "software" && typeof record.payloadSecret === "string") {
        return record.payloadSecret;
      }

      if (!record.iv || !record.ciphertext || !window.crypto?.subtle) {
        return null;
      }

      const keyRecord = await new Promise((resolve, reject) => {
        const transaction = database.transaction("secret-keys", "readonly");
        const store = transaction.objectStore("secret-keys");
        const request = store.get("payload-secret-key-v1");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("failed to read payload-secret key"));
      });

      if (!keyRecord?.key) {
        return null;
      }

      const base64ToBytes = (value) => {
        const binary = window.atob(value);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      };

      const plaintext = await window.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(record.iv),
        },
        keyRecord.key,
        base64ToBytes(record.ciphertext)
      );
      return new TextDecoder().decode(plaintext);
    } finally {
      database.close();
    }
  });
}

function hashIfString(value) {
  return typeof value === "string" ? createHash("sha256").update(value, "utf8").digest("hex") : null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
