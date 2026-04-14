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

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const ENROLLMENT_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_ENROLLMENT_PROMPT ||
  "Reply with exactly: public-enrollment-e2e";
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-enrollment-"));
  const relayStatePath = path.join(stateDir, "session.json");
  const brokerStatePath = path.join(stateDir, "public-control.json");
  const registrationPath = path.join(stateDir, "public-registration.json");
  const identityPath = path.join(stateDir, "public-identity.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-enrollment-workspace-"))
  );

  const broker = startPublicBroker({ brokerPort, brokerStatePath });
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
      RELAY_BROKER_PEER_ID: "browser-public-enrollment-relay",
      RELAY_BROKER_REGISTRATION_PATH: registrationPath,
      RELAY_BROKER_IDENTITY_PATH: identityPath,
    }
  );
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
  const registration = await waitForRegistration(registrationPath);
  const identity = await waitForIdentity(identityPath);
  assert.ok(registration.relay_id?.startsWith("relay-"));
  assert.ok(registration.broker_room_id?.startsWith("room-"));
  assert.ok(registration.relay_refresh_token?.startsWith("rref-"));
  assert.ok(identity.relay_signing_seed, "relay identity should persist a signing seed");

  let browser;
  let context;
  let localPage;
  let remotePage;
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
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await localPage.waitForFunction(() => {
      return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
    }, null, { timeout: TIMEOUT_MS });
    await localPage.click("[data-pairing-id][data-pairing-decision='approve']");

    await remotePage.waitForFunction(() => {
      const stored = JSON.parse(window.localStorage.getItem("agent-relay.remote-state-v2") || "null");
      return Boolean(stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length);
    }, null, { timeout: TIMEOUT_MS });

    await openRemoteSessionPanel(remotePage);
    await remotePage.selectOption("#remote-approval-policy-input", "never");
    await remotePage.fill("#remote-cwd-input", workspaceDir);
    await remotePage.click("#remote-start-session-button");
    await waitForSingleStartedThread(relayPort, workspaceDir);

    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: TIMEOUT_MS });

    await sendPromptAndWaitForReply(remotePage, ENROLLMENT_PROMPT);
    await remotePage.reload({ waitUntil: "domcontentloaded" });
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return Boolean(input && !input.disabled && badge.trim() && !badge.toLowerCase().includes("offline"));
    }, null, { timeout: TIMEOUT_MS });

    const relaySession = await fetchSession(relayPort);
    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          lanIp,
          workspaceDir,
          activeThreadId: relaySession.active_thread_id,
          relayId: registration.relay_id,
          brokerRoomId: registration.broker_room_id,
          pairingOrigin: new URL(pairingUrl).origin,
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
        `[cleanup] failed to delete public enrollment e2e threads for ${workspaceDir}: ${error.message}`
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

async function openSecurityModal(page) {
  const isOpen = await page.evaluate(() => Boolean(document.querySelector("#security-modal")?.open));
  if (isOpen) return;
  await page.click("#open-security-header");
  await page.waitForFunction(() => Boolean(document.querySelector("#security-modal")?.open));
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

function startPublicBroker({ brokerPort, brokerStatePath }) {
  return spawnManagedProcess(
    "broker",
    "cargo",
    ["run", "-p", "relay-broker"],
    {
      BIND_HOST: "0.0.0.0",
      PORT: String(brokerPort),
      RELAY_BROKER_AUTH_MODE: "public",
      RELAY_BROKER_PUBLIC_ISSUER_SECRET: PUBLIC_ISSUER_SECRET,
      RELAY_BROKER_PUBLIC_STATE_PATH: brokerStatePath,
    }
  );
}

async function waitForRegistration(registrationPath, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(registrationPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.relay_id && parsed?.broker_room_id && parsed?.relay_refresh_token) {
        return parsed;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for relay registration file: ${registrationPath}`);
}

async function waitForIdentity(identityPath, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(identityPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.relay_signing_seed) {
        return parsed;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`timed out waiting for relay identity file: ${identityPath}`);
}

async function waitForSingleStartedThread(relayPort, cwd, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const startPrefix = `Started a new Codex thread in ${cwd}.`;

  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const startLogs = (session.logs || []).filter((entry) => entry.message.includes(startPrefix));
    if (session.active_thread_id && startLogs.length === 1) {
      return;
    }
    await delay(300);
  }

  throw new Error(`timed out waiting for a single started thread in ${cwd}`);
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
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function dumpProcessLogs(child) {
  const lines = child?._logBuffer || [];
  if (!lines.length) return;
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
      if (response.ok) return;
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
      if (!response.ok) throw new Error(`unexpected status ${response.status}`);
      const payload = await response.json();
      if (payload?.data?.broker_connected) return;
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
      if (address.family !== "IPv4" || address.internal) continue;
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
