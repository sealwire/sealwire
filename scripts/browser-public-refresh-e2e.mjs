import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { sha256 } from "@noble/hashes/sha2.js";
import { chromium } from "playwright";
import nacl from "tweetnacl";
import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";

const ROOT = process.cwd();
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

const managedProcesses = [];
const remoteConsoleMessages = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  remoteConsoleMessages.length = 0;
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-refresh-e2e-"));
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-refresh-workspace-"))
  );

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
      RELAY_BROKER_PEER_ID: "browser-public-refresh-relay",
      RELAY_BROKER_RELAY_ID: RELAY_ID,
      RELAY_BROKER_RELAY_REFRESH_TOKEN: RELAY_REFRESH_TOKEN,
    }
  );
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;
  const refreshRequests = [];

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();

    localPage = await context.newPage();
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await openSecurityModal(localPage);
    await localPage.click("#start-pairing-button");
    await localPage.waitForFunction(() => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(input && input.value.startsWith("http"));
    });
    const pairingUrl = await localPage.inputValue("#pairing-link-input");
    assert.ok(
      pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
      `pairing url should use broker public url, got: ${pairingUrl}`
    );

    remotePage = await context.newPage();
    remotePage.on("console", (message) => {
      remoteConsoleMessages.push(`[${message.type()}] ${message.text()}`);
    });
    remotePage.on("request", (request) => {
      if (request.url().endsWith("/api/public/device/ws-token")) {
        refreshRequests.push(request.url());
      }
    });
    await remotePage.goto(`http://${lanIp}:${brokerPort}`, { waitUntil: "domcontentloaded" });
    await installSocketLifecycleHook(remotePage);
    await openPairingModal(remotePage);
    await remotePage.fill("#pairing-input", pairingUrl);
    await remotePage.click("#connect-button");

    await localPage.waitForFunction(() => {
      return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
    }, null, { timeout: TIMEOUT_MS });
    await localPage.click("[data-pairing-id][data-pairing-decision='approve']");

    await remotePage.waitForFunction(() => {
      const stored = JSON.parse(window.localStorage.getItem("agent-relay.remote-state-v2") || "null");
      return Boolean(stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length);
    }, null, { timeout: TIMEOUT_MS });
    await remotePage.waitForFunction(() => Boolean(window.__agentRelayLastSocket), null, {
      timeout: TIMEOUT_MS,
    });

    await openRemoteSessionPanel(remotePage);
    await remotePage.selectOption("#remote-approval-policy-input", "never");
    await remotePage.fill("#remote-cwd-input", workspaceDir);
    await remotePage.click("#remote-start-session-button");

    await waitForSingleStartedThread(relayPort, workspaceDir);
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });

    await sendPromptAndWaitForReply(remotePage, BEFORE_REFRESH_PROMPT);

    const authBeforeExpiry = await readStoredRemoteAuth(remotePage);
    assert.equal(
      authBeforeExpiry?.hasStoredPayloadSecret,
      true,
      "paired remote should persist payload-secret availability metadata"
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(authBeforeExpiry || {}, "payloadSecret"),
      false,
      "paired remote should not store payload secrets in localStorage"
    );
    assert.equal(authBeforeExpiry?.deviceRefreshMode, "cookie");
    assert.equal(authBeforeExpiry?.deviceRefreshToken, undefined);
    assert.equal(authBeforeExpiry?.deviceJoinTicket, undefined);
    assert.equal(authBeforeExpiry?.sessionClaim, undefined);
    const deviceSessionCookie = await readDeviceSessionCookie(
      context,
      `http://${lanIp}:${brokerPort}`
    );
    assert.ok(deviceSessionCookie, "paired remote should establish a device session cookie");

    await delay((DEVICE_WS_TTL_SECS + 1) * 1000);
    await remotePage.evaluate(() => window.__agentRelayForceSocketClose("test_token_expired"));
    await waitFor(() => refreshRequests.length >= 1);

    await remotePage.waitForFunction(() => {
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return badge.trim().length > 0 && !badge.toLowerCase().includes("offline");
    }, null, { timeout: TIMEOUT_MS });
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });

    await sendPromptAndWaitForReply(remotePage, AFTER_REFRESH_PROMPT);
    const authAfterRefresh = await readStoredRemoteAuth(remotePage);
    assert.equal(authAfterRefresh?.hasStoredPayloadSecret, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(authAfterRefresh || {}, "payloadSecret"),
      false
    );
    assert.equal(authAfterRefresh?.deviceRefreshMode, "cookie");
    assert.equal(authAfterRefresh?.deviceRefreshToken, undefined);
    assert.equal(authAfterRefresh?.deviceJoinTicket, undefined);
    assert.equal(authAfterRefresh?.sessionClaim, undefined);

    const relaySession = await fetchSession(relayPort);
    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          activeThreadId: relaySession.active_thread_id,
          refreshRequestCount: refreshRequests.length,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
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
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete public refresh e2e threads for ${workspaceDir}: ${error.message}`
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

async function openPairingModal(page) {
  const isOpen = await page.evaluate(() => Boolean(document.querySelector("#pairing-modal")?.open));
  if (isOpen) {
    return;
  }

  await page.click("#open-pairing-modal");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#pairing-modal");
    return Boolean(dialog?.open);
  });
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
      RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS: String(DEVICE_WS_TTL_SECS),
    }
  );
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
    window.__agentRelayReceivedPayloads = {};

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
              window.__agentRelayReceivedPayloads[actionId] = frame.payload;
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

async function waitForSingleStartedThread(relayPort, cwd, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const startPrefix = `Started a new Codex thread in ${cwd}.`;

  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const startLogs = (session.logs || []).filter((entry) => entry.message.includes(startPrefix));

    assert.ok(
      startLogs.length <= 1,
      `refresh reconnect flow should not start more than one thread for ${cwd}`
    );

    if (session.active_thread_id && startLogs.length === 1) {
      return;
    }

    await delay(300);
  }

  throw new Error(`timed out waiting for a single started thread in ${cwd}`);
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
    try {
      const sentActionIds = await remotePage.evaluate(() => window.__agentRelaySentActionIds || []);
      console.error("\n[remote sent actions]");
      console.error(sentActionIds.join("\n"));
    } catch {}
    try {
      const receivedActionIds = await remotePage.evaluate(
        () => window.__agentRelayReceivedActionIds || []
      );
      console.error("\n[remote received actions]");
      console.error(receivedActionIds.join("\n"));
    } catch {}
    if (remoteConsoleMessages.length) {
      console.error("\n[remote console]");
      console.error(remoteConsoleMessages.join("\n"));
    }
    try {
      const debugInfo = await remotePage.evaluate(() => {
        const parsed = JSON.parse(
          window.localStorage.getItem("agent-relay.remote-state-v2") || "null"
        );
        const activeRelayId =
          parsed?.activeRelayId || Object.keys(parsed?.remoteProfiles || {})[0] || null;
        const activeProfile = activeRelayId ? parsed.remoteProfiles?.[activeRelayId] || null : null;
        const receivedPayloads = window.__agentRelayReceivedPayloads || {};
        const lastClaimChallengeActionId = (window.__agentRelayReceivedActionIds || [])
          .filter((actionId) => actionId.startsWith("claim_challenge-"))
          .at(-1);
        return {
          payloadSecret: activeProfile?.payloadSecret || null,
          lastClaimChallengeActionId,
          lastClaimChallengePayload: lastClaimChallengeActionId
            ? receivedPayloads[lastClaimChallengeActionId] || null
            : null,
        };
      });
      if (debugInfo?.lastClaimChallengePayload?.envelope && debugInfo.payloadSecret) {
        console.error("\n[remote last claim_challenge result]");
        console.error(
          JSON.stringify(
            decryptEnvelope(debugInfo.payloadSecret, debugInfo.lastClaimChallengePayload.envelope),
            null,
            2
          )
        );
      }
    } catch {}
  }
}

function decryptEnvelope(secret, envelope) {
  const key = sha256(new TextEncoder().encode(secret));
  const nonce = Buffer.from(envelope.nonce, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const plaintext = nacl.secretbox.open(
    new Uint8Array(ciphertext),
    new Uint8Array(nonce),
    key
  );
  if (!plaintext) {
    throw new Error("failed to decrypt debug envelope");
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
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
