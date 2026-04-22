import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";

const ROOT = process.cwd();
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

const managedProcesses = [];

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[public-broker-e2e] ${message}${suffix}`);
}

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  logStep("starting");
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-browser-e2e-"));
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-public-broker-codex-");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-workspace-"))
  );

  let broker = await startPublicBroker({
    brokerPort,
    brokerStatePath,
  });
  logStep("broker started", { brokerPort });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
  logStep("broker healthy");

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
      RELAY_BROKER_PEER_ID: "browser-public-relay",
      RELAY_BROKER_RELAY_ID: RELAY_ID,
      RELAY_BROKER_RELAY_REFRESH_TOKEN: RELAY_REFRESH_TOKEN,
      CODEX_HOME: codexHomeDir,
    }
  );
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
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    logStep("browser launched");

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local");
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    logStep("local page loaded");
    await openSecurityModal(localPage);
    logStep("security modal opened");
    await localPage.click("#start-pairing-button");
    logStep("clicked start pairing");
    await localPage.waitForFunction(() => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(input && input.value.startsWith("http"));
    });
    logStep("pairing link ready");
    const pairingUrl = await localPage.inputValue("#pairing-link-input");
    logStep("pairing url captured", { pairingUrl });
    assert.ok(
      pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
      `pairing url should use broker public url, got: ${pairingUrl}`
    );

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote");
    remotePage.on("request", (request) => {
      if (request.url().endsWith("/api/public/device/ws-token")) {
        refreshRequests.push(request.url());
        logStep("captured refresh request", { count: refreshRequests.length });
      }
    });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    logStep("remote page loaded");
    await localPage.waitForFunction(() => {
      return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
    }, null, { timeout: TIMEOUT_MS });
    logStep("pairing approval visible");
    await localPage.click("[data-pairing-id][data-pairing-decision='approve']");
    logStep("pairing approved");

    await remotePage.waitForFunction(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("agent-relay.remote-state")
          || window.localStorage.getItem("agent-relay.remote-state-v2")
          || "null"
      );
      return Boolean(stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length);
    }, null, { timeout: TIMEOUT_MS });
    logStep("remote auth stored");

    await installDuplicateStartSessionReplayHook(remotePage);
    logStep("duplicate start-session replay hook installed");
    await openRemoteSessionPanel(remotePage);
    logStep("remote session panel opened");
    await remotePage.selectOption("#remote-approval-policy-input", "never");
    await remotePage.fill("#remote-cwd-input", workspaceDir);
    await remotePage.click("#remote-start-session-button");
    logStep("clicked start session");
    await remotePage.waitForFunction(() => Boolean(window.__capturedStartSessionFrame), null, {
      timeout: TIMEOUT_MS,
    });
    logStep("captured start-session frame");
    await remotePage.evaluate(() => window.__replayCapturedStartSessionFrame());
    logStep("replayed start-session frame");

    await waitForSingleStartedThread(relayPort, workspaceDir);
    logStep("single started thread ready");
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });
    logStep("message input ready before broker restart");

    await sendPromptAndWaitForReply(remotePage, BEFORE_RESTART_PROMPT);
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
      `http://${lanIp}:${brokerPort}`
    );
    assert.ok(deviceSessionCookie, "paired remote should establish a device session cookie");
    logStep("device session cookie captured");
    await delay(3000);

    logStep("stopping broker for restart");
    await stopManagedProcess(broker);
    broker = await startPublicBroker({
      brokerPort,
      brokerStatePath,
    });
    logStep("broker restarted");
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    logStep("broker healthy after restart");
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
    logStep("relay reconnected after broker restart");

    await waitFor(() => refreshRequests.length >= 1);
    logStep("refresh request observed after broker restart", { count: refreshRequests.length });
    await remotePage.waitForFunction(() => {
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return badge.trim().length > 0 && !badge.toLowerCase().includes("offline");
    }, null, { timeout: TIMEOUT_MS });
    logStep("remote status badge recovered");
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });
    logStep("message input ready after broker restart");

    await sendPromptAndWaitForReply(remotePage, AFTER_RESTART_PROMPT);
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
    broker = await startPublicBroker({
      brokerPort,
      brokerStatePath,
    });
    logStep("broker restarted after revoke");
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    logStep("broker healthy after revoke restart");
    await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
    logStep("relay reconnected after revoke restart");

    const revokedRefreshResponse = await fetch(
      `http://127.0.0.1:${brokerPort}/api/public/device/ws-token`,
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
    await dumpBrowserState(localPage, remotePage);
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
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

function attachPageDebugLogging(page, label) {
  page.on("console", (message) => {
    const text = message.text();
    if (!text) {
      return;
    }
    console.log(`[public-broker-e2e:${label}:console:${message.type()}] ${text}`);
  });
  page.on("pageerror", (error) => {
    console.error(`[public-broker-e2e:${label}:pageerror] ${error.stack || error.message}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    console.error(
      `[public-broker-e2e:${label}:requestfailed] ${request.method()} ${request.url()} ${failure?.errorText || ""}`.trim()
    );
  });
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

async function startPublicBroker({ brokerPort, brokerStatePath }) {
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
      RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS: "2",
    }
  );
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

async function openRemoteSessionPanel(page) {
  await selectFirstRelayIfNeeded(page);
  await page.click("#remote-session-toggle");
  await page.waitForFunction(() => {
    const panel = document.querySelector("#remote-session-panel");
    return Boolean(panel && !panel.hidden);
  });
  await page.click("#remote-session-panel summary");
  await page.waitForFunction(() => {
    const details = document.querySelector("#remote-session-panel details");
    return Boolean(details && details.open);
  });
}

async function selectFirstRelayIfNeeded(page) {
  const needsSelection = await page.evaluate(() => {
    const toggle = document.querySelector("#remote-session-toggle");
    return Boolean(toggle?.disabled);
  });
  if (!needsSelection) {
    return;
  }

  await page.click("#remote-relays-list [data-relay-id]:not([disabled])");
  await page.waitForFunction(() => {
    const toggle = document.querySelector("#remote-session-toggle");
    return Boolean(toggle && !toggle.disabled);
  }, null, { timeout: TIMEOUT_MS });
}

async function sendPromptAndWaitForReply(page, prompt) {
  await page.waitForFunction(() => {
    const input = document.querySelector("#remote-message-input");
    return Boolean(input && !input.disabled);
  }, null, { timeout: TIMEOUT_MS });
  await page.fill("#remote-message-input", prompt);
  await page.click("#remote-send-button");

  const expectedReply = prompt.replace("Reply with exactly: ", "");
  await page.waitForFunction(
    (expected) => {
      const transcript = document.querySelector("#remote-transcript")?.textContent || "";
      return transcript.includes(expected);
    },
    expectedReply,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForRevokedDevice(relayPort, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.device_records?.some((device) => device.lifecycle_state === "revoked")) {
      return;
    }
    await delay(300);
  }
  throw new Error("timed out waiting for revoked device state");
}

async function waitForSingleStartedThread(relayPort, cwd, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const threads = await fetchThreadsForCwd(relayPort, cwd);

    assert.ok(
      threads.length <= 1,
      `duplicate start_session replay should not start more than one thread for ${cwd}`
    );

    if (
      session.active_thread_id
      && session.current_cwd === cwd
      && (
        threads.length === 0
        || (threads.length === 1 && threads[0]?.id === session.active_thread_id)
      )
    ) {
      return;
    }

    await delay(300);
  }

  throw new Error(`timed out waiting for a single started thread in ${cwd}`);
}

async function fetchThreadsForCwd(relayPort, cwd) {
  const response = await fetch(
    `http://127.0.0.1:${relayPort}/api/threads?cwd=${encodeURIComponent(cwd)}&limit=200`
  );
  const payload = await response.json();
  assert.equal(response.status, 200, `thread list should load for ${cwd}`);
  assert.equal(payload?.ok, true, `thread list payload should succeed for ${cwd}`);
  return payload.data?.threads || [];
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

async function waitFor(predicate, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }

  throw new Error("timed out waiting for condition");
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
