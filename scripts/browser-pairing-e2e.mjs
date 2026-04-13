import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";

const ROOT = process.cwd();
const PAIRING_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT = process.env.BROWSER_E2E_PROMPT || "Reply with exactly: browser-pairing-e2e";
const BROKER_TICKET_SECRET =
  process.env.BROWSER_E2E_BROKER_TICKET_SECRET || "browser-e2e-broker-secret";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-browser-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);

  const broker = spawnManagedProcess(
    "broker",
    "cargo",
    ["run", "-p", "relay-broker"],
    {
      BIND_HOST: "0.0.0.0",
      PORT: String(brokerPort),
      RELAY_BROKER_TICKET_SECRET: BROKER_TICKET_SECRET,
    }
  );
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = spawnManagedProcess(
    "relay",
    "cargo",
    ["run", "-p", "relay-server"],
    {
      PORT: String(relayPort),
      RELAY_STATE_PATH: statePath,
      RELAY_BROKER_URL: `ws://127.0.0.1:${brokerPort}`,
      RELAY_BROKER_PUBLIC_URL: `ws://${lanIp}:${brokerPort}`,
      RELAY_BROKER_CHANNEL_ID: "browser-e2e-room",
      RELAY_BROKER_PEER_ID: "browser-e2e-relay",
      RELAY_BROKER_TICKET_SECRET: BROKER_TICKET_SECRET,
    }
  );
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;
  let createdThreadId = null;

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
    await remotePage.waitForFunction(() => {
      const modal = document.querySelector("#pairing-modal");
      if (!modal) {
        return false;
      }

      const style = window.getComputedStyle(modal);
      return modal.open === false && style.display === "none";
    }, null, { timeout: PAIRING_TIMEOUT_MS });
    await localPage.waitForFunction(() => {
      return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
    }, null, { timeout: PAIRING_TIMEOUT_MS });

    // Regression coverage: the first remote surface disconnects before local approval,
    // then reconnects on a new broker peer. Approval must still reach the new peer.
    await remotePage.close();
    remotePage = await context.newPage();
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });

    await localPage.click("[data-pairing-id][data-pairing-decision='approve']");
    await remotePage.waitForFunction(() => {
      const meta = document.querySelector("#device-meta")?.textContent || "";
      return meta.includes("Paired");
    }, null, { timeout: PAIRING_TIMEOUT_MS });

    await remotePage.click("#remote-session-toggle");
    await remotePage.waitForFunction(() => {
      const panel = document.querySelector("#remote-session-panel");
      return Boolean(panel && !panel.hidden);
    });
    await remotePage.click("#remote-session-panel summary");
    await remotePage.waitForFunction(() => {
      const details = document.querySelector("#remote-session-panel details");
      return Boolean(details && details.open);
    });
    await remotePage.selectOption("#remote-approval-policy-input", "never");
    await remotePage.fill("#remote-cwd-input", cwdInput);
    await remotePage.click("#remote-start-session-button");

    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    }, null, { timeout: PAIRING_TIMEOUT_MS });
    await remotePage.waitForFunction(() => {
      const transcript = document.querySelector("#remote-transcript")?.textContent || "";
      return transcript.includes("Session ready");
    }, null, { timeout: PAIRING_TIMEOUT_MS });

    const relaySessionAfterStart = await fetchSession(relayPort);
    assert.equal(
      relaySessionAfterStart.current_cwd,
      ROOT,
      `remote start should normalize cwd to ${ROOT}, got ${relaySessionAfterStart.current_cwd}`
    );

    await remotePage.fill("#remote-message-input", PROMPT);
    await remotePage.click("#remote-send-button");

    const expectedReply = PROMPT.replace("Reply with exactly: ", "");
    await remotePage.waitForFunction(
      (expected) => {
        const transcript = document.querySelector("#remote-transcript")?.textContent || "";
        return transcript.includes(expected);
      },
      expectedReply,
      { timeout: PAIRING_TIMEOUT_MS }
    );

    await remotePage.reload({ waitUntil: "domcontentloaded" });
    await remotePage.waitForFunction(() => {
      const input = document.querySelector("#remote-message-input");
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return Boolean(input && !input.disabled && badge.trim() && !badge.toLowerCase().includes("offline"));
    }, null, { timeout: PAIRING_TIMEOUT_MS });

    const remoteStatus = await remotePage.textContent("#remote-status-badge");
    const remoteDeviceMeta = await remotePage.textContent("#device-meta");
    const relaySession = await fetchSession(relayPort);
    createdThreadId = relaySession.active_thread_id;

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          lanIp,
          cwdInput,
          pairingUrl,
          remoteStatus,
          remoteDeviceMeta,
          activeThreadId: relaySession.active_thread_id,
          currentCwd: relaySession.current_cwd,
          pairedDevices: relaySession.paired_devices?.map((device) => ({
            deviceId: device.device_id,
            label: device.label,
            lastPeerId: device.last_peer_id,
          })),
          lastAssistant: [...relaySession.transcript]
            .reverse()
            .find((entry) => entry.role === "assistant")?.text,
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
    if (createdThreadId) {
      await deleteThreadAndWait(relayPort, createdThreadId, { cwd: ROOT }).catch((error) => {
        console.error(
          `[cleanup] failed to delete pairing e2e thread ${createdThreadId}: ${error.message}`
        );
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function openSecurityModal(page) {
  await page.click("#open-security-header");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#security-modal");
    return Boolean(dialog?.open);
  });
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
  if (child._logBuffer.length > 120) {
    child._logBuffer.splice(0, child._logBuffer.length - 120);
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

function toTildePath(absolutePath) {
  const home = os.homedir();
  if (absolutePath === home) {
    return "~";
  }
  if (absolutePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absolutePath)}`;
  }
  return absolutePath;
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
        /^172\.(1[6-9]|2\\d|3[0-1])\\./.test(address.address)
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
