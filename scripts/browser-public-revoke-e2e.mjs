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
  process.env.BROWSER_E2E_PUBLIC_REVOKE_ROOM_ID || "browser-public-revoke-room";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-revoke-"));
  const relayStatePath = path.join(stateDir, "session.json");
  const brokerStatePath = path.join(stateDir, "public-control.json");

  const broker = startPublicBroker({
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
      RELAY_BROKER_PEER_ID: "browser-public-revoke-relay",
      RELAY_BROKER_RELAY_ID: RELAY_ID,
      RELAY_BROKER_RELAY_REFRESH_TOKEN: RELAY_REFRESH_TOKEN,
    }
  );
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let localContext;
  let localPage;
  const remoteContexts = [];

  try {
    browser = await chromium.launch({ headless: true });
    localContext = await browser.newContext();
    localPage = await localContext.newPage();
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const deviceA = await pairDevice(browser, localPage, lanIp, brokerPort);
    const deviceB = await pairDevice(browser, localPage, lanIp, brokerPort);
    const deviceC = await pairDevice(browser, localPage, lanIp, brokerPort);
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
      deviceA.cookie
    );
    assert.equal(
      revokedOneRefresh.ok,
      false,
      "revoke one should make the old device refresh token unusable"
    );

    const keptBeforeBulkRefresh = await issueDeviceWsToken(
      brokerPort,
      deviceB.cookie
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
      deviceC.cookie
    );
    assert.equal(
      revokedOtherRefresh.ok,
      false,
      "bulk revoke should make the revoked device refresh token unusable"
    );

    const keptAfterBulkRefresh = await issueDeviceWsToken(
      brokerPort,
      deviceB.cookie
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
    await dumpBrowserState(localPage, ...remoteContexts.map((context) => context.__page).filter(Boolean));
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

async function pairDevice(browser, localPage, lanIp, brokerPort) {
  const context = await browser.newContext();
  const page = await context.newPage();
  context.__page = page;
  const previousUrl = await localPage.inputValue("#pairing-link-input").catch(() => "");
  const pairingUrl = await startPairingFromLocalPage(localPage, previousUrl);
  assert.ok(
    pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
    `pairing url should use broker public url, got: ${pairingUrl}`
  );
  await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
  await approvePendingPairing(localPage);
  await waitForPairedRemote(page);
  const auth = await readStoredRemoteAuth(page);
  assert.ok(auth?.deviceId, "paired remote should persist a device id");
  assert.equal(auth?.deviceRefreshMode, "cookie");
  assert.equal(auth?.deviceRefreshToken, undefined);
  assert.equal(auth?.deviceJoinTicket, undefined);
  assert.equal(auth?.sessionClaim, undefined);
  const cookie = await readDeviceSessionCookie(context, `http://${lanIp}:${brokerPort}`);
  assert.ok(cookie, "paired remote should establish a device session cookie");
  return {
    auth,
    cookie: `${cookie.name}=${cookie.value}`,
    context,
    page,
    pairingUrl,
  };
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
    const stored = JSON.parse(window.localStorage.getItem("agent-relay.remote-state-v2") || "null");
    return Boolean(stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length);
  }, null, { timeout: TIMEOUT_MS });
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

async function tryIssueDeviceWsToken(brokerPort, cookieHeader) {
  const response = await fetch(`http://127.0.0.1:${brokerPort}/api/public/device/ws-token`, {
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

async function issueDeviceWsToken(brokerPort, cookieHeader) {
  const result = await tryIssueDeviceWsToken(brokerPort, cookieHeader);
  if (!result.ok) {
    throw new Error(result.payload?.message || result.payload?.error || "device ws token refresh failed");
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

async function fetchSession(relayPort) {
  return fetch(`http://127.0.0.1:${relayPort}/api/session`)
    .then((response) => response.json())
    .then((response) => response.data);
}

async function readStoredRemoteAuth(page) {
  return page.evaluate(() => {
    const parsed = JSON.parse(window.localStorage.getItem("agent-relay.remote-state-v2") || "null");
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

async function dumpBrowserState(...pages) {
  const labels = ["local page", "remote a", "remote b", "remote c"];
  for (const [index, page] of pages.entries()) {
    if (!page) {
      continue;
    }
    console.error(`\n[${labels[index] || `page-${index}`}]`);
    console.error(await safeText(page, index === 0 ? "#client-log" : "#remote-client-log"));
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
