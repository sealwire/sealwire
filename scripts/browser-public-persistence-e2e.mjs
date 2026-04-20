import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_PERSISTENCE_ROOM_ID || "browser-public-persistence-room";

const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

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
  });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = spawnManagedProcess(
    "relay",
    "cargo",
    ["run", "-p", "relay-server"],
    {
      PORT: String(relayPort),
      RELAY_STATE_PATH: relayStatePath,
      RELAY_BROKER_URL: `ws://127.0.0.1:${brokerPort}`,
      RELAY_BROKER_PUBLIC_URL: `ws://${lanIp}:${brokerPort}`,
      RELAY_BROKER_CONTROL_URL: `http://127.0.0.1:${brokerPort}`,
      RELAY_BROKER_AUTH_MODE: "public",
      RELAY_BROKER_CHANNEL_ID: BROKER_ROOM_ID,
      RELAY_BROKER_PEER_ID: "browser-public-persistence-relay",
      RELAY_BROKER_RELAY_ID: RELAY_ID,
      RELAY_BROKER_RELAY_REFRESH_TOKEN: RELAY_REFRESH_TOKEN,
    }
  );
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let localContext;
  let remoteContext;
  let localPage;
  let remotePage;

  try {
    browser = await chromium.launch({ headless: true });
    localContext = await browser.newContext();
    remoteContext = await browser.newContext();
    localPage = await localContext.newPage();
    remotePage = await remoteContext.newPage();

    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const pairingUrl = await startPairingFromLocalPage(localPage);
    assert.ok(
      pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
      `pairing url should use broker public url, got: ${pairingUrl}`
    );

    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePendingPairing(localPage);
    await waitForPairedRemote(remotePage);
    await waitForStoredPayloadSecretMetadata(remotePage);

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
      remoteContext,
      `http://${lanIp}:${brokerPort}`
    );
    assert.ok(deviceSessionCookie, "paired remote should establish a device session cookie");

    await waitForPersistedDeviceGrant(brokerStatePath, authBeforeRestart.deviceId);
    await remotePage.reload({ waitUntil: "domcontentloaded" });
    await waitForPairedRemote(remotePage);
    await waitForStoredPayloadSecretMetadata(remotePage);

    await stopManagedProcess(broker);
    broker = startPublicBroker({
      brokerPort,
      brokerStatePath,
    });
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

    const refreshed = await issueDeviceWsTokenWithCookie(
      brokerPort,
      `${deviceSessionCookie.name}=${deviceSessionCookie.value}`
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
    await dumpBrowserState(localPage, remotePage);
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
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

function startPublicBroker({ brokerPort, brokerStatePath }) {
  const relayRegistrations = JSON.stringify([
    {
      relay_id: RELAY_ID,
      broker_room_id: BROKER_ROOM_ID,
      refresh_token: RELAY_REFRESH_TOKEN,
    },
  ]);

  return spawnManagedProcess(
    "broker",
    "cargo",
    ["run", "-p", "relay-broker"],
    {
      BIND_HOST: "0.0.0.0",
      PORT: String(brokerPort),
      RELAY_BROKER_AUTH_MODE: "public",
      RELAY_BROKER_PUBLIC_ISSUER_SECRET: PUBLIC_ISSUER_SECRET,
      RELAY_BROKER_PUBLIC_RELAYS_JSON: relayRegistrations,
      RELAY_BROKER_PUBLIC_STATE_PATH: brokerStatePath,
    }
  );
}

async function startPairingFromLocalPage(localPage, previousUrl = "") {
  await openSecurityModal(localPage);
  await localPage.click("#start-pairing-button");
  await localPage.waitForFunction(
    (previous) => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(
        input &&
          input.value.startsWith("http") &&
          (!previous || input.value !== previous)
      );
    },
    previousUrl,
    { timeout: TIMEOUT_MS }
  );
  return localPage.inputValue("#pairing-link-input");
}

async function openSecurityModal(page) {
  const isOpen = await page.evaluate(() => Boolean(document.querySelector("#security-modal")?.open));
  if (isOpen) {
    return;
  }

  await page.click("#open-security-header");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#security-modal");
    return Boolean(dialog?.open);
  });
}

async function approvePendingPairing(localPage) {
  await localPage.waitForFunction(() => {
    return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
  }, null, { timeout: TIMEOUT_MS });
  await localPage.click("[data-pairing-id][data-pairing-decision='approve']");
}

async function waitForPairedRemote(remotePage) {
  await remotePage.waitForFunction(() => {
    const stored = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state")
        || window.localStorage.getItem("agent-relay.remote-state-v2")
        || "null"
    );
    return Boolean(stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length);
  }, null, { timeout: TIMEOUT_MS });
}

async function waitForStoredPayloadSecretMetadata(remotePage) {
  await remotePage.waitForFunction(() => {
    const parsed = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state")
        || window.localStorage.getItem("agent-relay.remote-state-v2")
        || "null"
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

async function issueDeviceWsTokenWithCookie(brokerPort, cookieHeader) {
  const response = await fetch(`http://127.0.0.1:${brokerPort}/api/public/device/ws-token`, {
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

async function readStoredRemoteAuth(page) {
  return page.evaluate(() => {
    const parsed = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state")
        || window.localStorage.getItem("agent-relay.remote-state-v2")
        || "null"
    );
    if (!parsed?.remoteProfiles) {
      return null;
    }
    const activeRelayId =
      parsed.activeRelayId || Object.keys(parsed.remoteProfiles)[0] || null;
    return activeRelayId ? parsed.remoteProfiles[activeRelayId] || null : null;
  });
}

async function readDeviceSessionCookie(context, origin) {
  const cookies = await context.cookies(
    new URL("/api/public/device/ws-token", origin).toString()
  );
  return cookies.find((cookie) => cookie.name === "agent_relay_device_session") || null;
}

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child._logName = name;
  child._logBuffer = [];
  child.stdout.on("data", (chunk) => appendLog(child, chunk));
  child.stderr.on("data", (chunk) => appendLog(child, chunk));
  managedProcesses.push(child);
  return child;
}

function appendLog(child, chunk) {
  const text = chunk.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  child._logBuffer.push(...lines);
  if (child._logBuffer.length > 160) {
    child._logBuffer.splice(0, child._logBuffer.length - 160);
  }
}

async function stopManagedProcess(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) {
    return;
  }

  console.error(`\n[${child._logName} logs]`);
  console.error(lines.join("\n"));
}

async function dumpBrowserState(localPage, remotePage) {
  if (localPage) {
    console.error("\n[local page]");
    console.error(await safeText(localPage, "#client-log"));
  }
  if (remotePage) {
    console.error("\n[remote page]");
    console.error(await safeText(remotePage, "#remote-client-log"));
  }
}

async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}

async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`timed out waiting for health endpoint: ${url}`);
}

async function waitForBrokerConnection(sessionUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(sessionUrl);
      if (!response.ok) {
        throw new Error(`unexpected status ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.data?.broker_connected) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error("timed out waiting for relay broker connection");
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function resolvePrivateIpv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }
      if (
        address.address.startsWith("10.") ||
        address.address.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address.address)
      ) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
