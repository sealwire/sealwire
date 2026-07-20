import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  launchBrowser,
  readDeviceSessionCookie,
  readStoredRemoteAuth,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { approvePairing, startPairingFromLocalPage, waitForPairedRemote } from "./e2e/harness/pairing.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { startPublicRelay, waitForBrokerConnection } from "./e2e/harness/relay.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_REVOKE_ROOM_ID || "browser-public-revoke-room";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-revoke-"));
  const relayStatePath = path.join(stateDir, "session.json");
  const brokerStatePath = path.join(stateDir, "public-control.json");

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
    peerId: "browser-public-revoke-relay",
    extraEnv: process.env.AGENT_PROVIDERS === "fake" ? { AGENT_PROVIDERS: "fake" } : {},
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let localContext;
  let localPage;
  const remoteContexts = [];

  try {
    ({ browser, context: localContext } = await launchBrowser());
    localPage = await localContext.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-revoke-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const deviceA = await pairDevice(browser, localPage, lanIp, brokerPort, "a");
    const deviceB = await pairDevice(browser, localPage, lanIp, brokerPort, "b");
    const deviceC = await pairDevice(browser, localPage, lanIp, brokerPort, "c");
    remoteContexts.push(deviceA.context, deviceB.context, deviceC.context);

    await waitForDeviceLifecycleCount(relayPort, "approved", 3);

    const revokeOneReceipt = await postRelayJson(
      relayPort,
      `/api/devices/${encodeURIComponent(deviceA.auth.deviceId)}/revoke`,
      {}
    );
    assert.equal(
      revokeOneReceipt.revoked,
      true,
      "revoke one should acknowledge that the device was revoked"
    );
    await waitForDeviceState(relayPort, deviceA.auth.deviceId, "revoked");

    const revokedOneRefresh = await tryIssueDeviceWsToken(
      brokerPort,
      deviceA.cookie,
      deviceA.auth.brokerChannelId
    );
    assert.equal(
      revokedOneRefresh.ok,
      false,
      "revoke one should make the old device refresh token unusable"
    );

    const keptBeforeBulkRefresh = await issueDeviceWsToken(
      brokerPort,
      deviceB.cookie,
      deviceB.auth.brokerChannelId
    );
    assert.ok(
      keptBeforeBulkRefresh.device_ws_token,
      "a non-revoked device should still refresh after revoke one"
    );

    const revokeOthersReceipt = await postRelayJson(
      relayPort,
      `/api/devices/${encodeURIComponent(deviceB.auth.deviceId)}/revoke-others`,
      {}
    );
    assert.ok(
      revokeOthersReceipt.revoked_device_ids.includes(deviceC.auth.deviceId),
      "bulk revoke should list the revoked device"
    );
    await waitForDeviceState(relayPort, deviceB.auth.deviceId, "approved");
    await waitForDeviceState(relayPort, deviceC.auth.deviceId, "revoked");

    const revokedOtherRefresh = await tryIssueDeviceWsToken(
      brokerPort,
      deviceC.cookie,
      deviceC.auth.brokerChannelId
    );
    assert.equal(
      revokedOtherRefresh.ok,
      false,
      "bulk revoke should make the revoked device refresh token unusable"
    );

    const keptAfterBulkRefresh = await issueDeviceWsToken(
      brokerPort,
      deviceB.cookie,
      deviceB.auth.brokerChannelId
    );
    assert.ok(
      keptAfterBulkRefresh.device_ws_token,
      "the kept device should still be able to refresh after bulk revoke"
    );

    const relaySession = await fetchSession(relayPort);
    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: `http://${lanIp}:${brokerPort}`,
          keptDeviceId: deviceB.auth.deviceId,
          revokedDeviceIds: [deviceA.auth.deviceId, deviceC.auth.deviceId],
          lifecycleStates: relaySession.device_records?.map((device) => ({
            deviceId: device.device_id,
            state: device.lifecycle_state,
          })),
        },
        null,
        2
      )
    );
  } catch (error) {
    const remotePages = remoteContexts.map((context) => context.__page).filter(Boolean);
    await writeFailureArtifacts({
      scenario: "public-revoke",
      broker,
      relay,
      localPage,
      remotePage: remotePages[0],
      extraPages: remotePages.slice(1),
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        pairedRemoteCount: remotePages.length,
        fakeProvider: process.env.AGENT_PROVIDERS === "fake",
      },
    });
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    for (const context of remoteContexts) {
      await context?.close().catch(() => {});
    }
    await localContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pairDevice(browser, localPage, lanIp, brokerPort, label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  context.__page = page;
  attachPageDebugLogging(page, `remote-${label}`, { prefix: "public-revoke-e2e" });
  const previousUrl = await localPage.inputValue("#pairing-link-input").catch(() => "");
  const pairingUrl = await startPairingFromLocalPage(localPage, {
    lanIp,
    brokerPort,
    previousUrl,
    timeoutMs: TIMEOUT_MS,
  });
  await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
  await approvePairing(localPage, TIMEOUT_MS);
  await waitForPairedRemote(page, TIMEOUT_MS);
  const auth = await readStoredRemoteAuth(page);
  assert.ok(auth?.deviceId, "paired remote should persist a device id");
  assert.equal(auth?.deviceRefreshMode, "cookie");
  assert.equal(auth?.deviceRefreshToken, undefined);
  assert.equal(auth?.deviceJoinTicket, undefined);
  assert.equal(auth?.sessionClaim, undefined);
  const cookie = await readDeviceSessionCookie(
    context,
    `http://${lanIp}:${brokerPort}`,
    auth?.brokerChannelId || null
  );
  assert.ok(cookie, "paired remote should establish a device session cookie");
  return {
    auth,
    cookie: `${cookie.name}=${cookie.value}`,
    context,
    page,
    pairingUrl,
  };
}

async function postRelayJson(relayPort, pathName, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `relay request failed: ${response.status}`);
  }
  return payload.data;
}

async function tryIssueDeviceWsToken(brokerPort, cookieHeader, room = null) {
  const path =
    room &&
    Buffer.byteLength(room, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(room)
      ? `/api/public/device/${encodeURIComponent(room)}/ws-token`
      : "/api/public/device/ws-token";
  const response = await fetch(`http://127.0.0.1:${brokerPort}${path}`, {
    method: "POST",
    headers: {
      Cookie: cookieHeader,
    },
  });
  const payload = await response.json().catch(() => null);
  return {
    ok: response.ok,
    payload,
    status: response.status,
  };
}

async function issueDeviceWsToken(brokerPort, cookieHeader, room = null) {
  const result = await tryIssueDeviceWsToken(brokerPort, cookieHeader, room);
  if (!result.ok) {
    throw new Error(
      result.payload?.message || result.payload?.error || "device ws token refresh failed"
    );
  }
  return result.payload;
}

async function waitForDeviceState(relayPort, deviceId, lifecycleState, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const record = session.device_records?.find((device) => device.device_id === deviceId);
    if (record?.lifecycle_state === lifecycleState) {
      return record;
    }
    await delay(300);
  }

  throw new Error(`timed out waiting for ${deviceId} to become ${lifecycleState}`);
}

async function waitForDeviceLifecycleCount(relayPort, lifecycleState, count, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const matchingCount = (session.device_records || []).filter(
      (device) => device.lifecycle_state === lifecycleState
    ).length;
    if (matchingCount >= count) {
      return session;
    }
    await delay(300);
  }

  throw new Error(`timed out waiting for ${count} device(s) in state ${lifecycleState}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
