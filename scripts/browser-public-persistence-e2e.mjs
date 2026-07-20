import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

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
  process.env.BROWSER_E2E_PUBLIC_PERSISTENCE_ROOM_ID || "browser-public-persistence-room";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-persistence-"));
  const relayStatePath = path.join(stateDir, "session.json");
  const brokerStatePath = path.join(stateDir, "public-control.json");

  let broker = startPublicBroker({
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
    peerId: "browser-public-persistence-relay",
    extraEnv: process.env.AGENT_PROVIDERS === "fake" ? { AGENT_PROVIDERS: "fake" } : {},
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let localContext;
  let remoteContext;
  let localPage;
  let remotePage;

  try {
    ({ browser, context: localContext } = await launchBrowser());
    remoteContext = await browser.newContext();
    localPage = await localContext.newPage();
    remotePage = await remoteContext.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-persistence-e2e" });
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-persistence-e2e" });

    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });

    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    await waitForStoredPayloadSecretMetadata(remotePage);

    const authBeforeRestart = await readStoredRemoteAuth(remotePage);
    assertCookieOnlyDeviceAuth(authBeforeRestart);
    const deviceSessionCookie = await readDeviceSessionCookie(
      remoteContext,
      `http://${lanIp}:${brokerPort}`,
      authBeforeRestart?.brokerChannelId || null
    );
    assert.ok(deviceSessionCookie, "paired remote should establish a device session cookie");

    await waitForPersistedDeviceGrant(brokerStatePath, authBeforeRestart.deviceId);
    await remotePage.reload({ waitUntil: "domcontentloaded" });
    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    await waitForStoredPayloadSecretMetadata(remotePage);
    assertCookieOnlyDeviceAuth(await readStoredRemoteAuth(remotePage));

    await stopManagedProcess(broker);
    broker = startPublicBroker({
      brokerPort,
      brokerStatePath,
      relayId: RELAY_ID,
      brokerRoomId: BROKER_ROOM_ID,
      relayRefreshToken: RELAY_REFRESH_TOKEN,
      issuerSecret: PUBLIC_ISSUER_SECRET,
    });
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

    const refreshed = await issueDeviceWsTokenWithCookie(
      brokerPort,
      `${deviceSessionCookie.name}=${deviceSessionCookie.value}`,
      authBeforeRestart?.brokerChannelId || null
    );
    assert.ok(refreshed.device_ws_token, "broker restart should still allow device ws token minting");
    assert.equal(
      typeof refreshed.device_ws_token_expires_at,
      "number",
      "refreshed device ws token should expose an expiry"
    );

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          deviceId: authBeforeRestart.deviceId,
          persistedStatePath: brokerStatePath,
          refreshedTokenExpiresAt: refreshed.device_ws_token_expires_at,
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "public-persistence",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        fakeProvider: process.env.AGENT_PROVIDERS === "fake",
      },
    });
    dumpProcessLogs(broker, relay);
    throw error;
  } finally {
    await remoteContext?.close().catch(() => {});
    await localContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

function assertCookieOnlyDeviceAuth(auth) {
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

async function waitForStoredPayloadSecretMetadata(remotePage) {
  await remotePage.waitForFunction(() => {
    const parsed = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state") ||
        window.localStorage.getItem("agent-relay.remote-state-v2") ||
        "null"
    );
    if (!parsed?.remoteProfiles) {
      return false;
    }
    const activeRelayId = parsed.activeRelayId || Object.keys(parsed.remoteProfiles)[0] || null;
    const profile = activeRelayId ? parsed.remoteProfiles[activeRelayId] || null : null;
    return profile?.hasStoredPayloadSecret === true;
  }, null, { timeout: TIMEOUT_MS });
}

async function waitForPersistedDeviceGrant(statePath, deviceId, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      const grants = Array.isArray(parsed?.device_grants) ? parsed.device_grants : [];
      if (grants.some((grant) => grant?.device_id === deviceId)) {
        return parsed;
      }
    } catch {}
    await delay(300);
  }

  throw new Error(`timed out waiting for persisted device grant for ${deviceId}`);
}

async function issueDeviceWsTokenWithCookie(brokerPort, cookieHeader, room = null) {
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
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "device ws token refresh failed");
  }
  return payload;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
