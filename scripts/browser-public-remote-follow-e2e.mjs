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
const DEFAULT_EXPECTED_REPLY = Array.from(
  { length: 12 },
  (_, index) => `public-remote-follow-${index + 1}`
).join("\n");
const DEFAULT_PROMPT = [
  "Reply with exactly these 12 lines, one per line, and no extra text:",
  DEFAULT_EXPECTED_REPLY,
].join("\n");
const PROMPT = process.env.BROWSER_E2E_PUBLIC_REMOTE_FOLLOW_PROMPT || DEFAULT_PROMPT;
const EXPECTED_REPLY = process.env.BROWSER_E2E_PUBLIC_REMOTE_FOLLOW_EXPECTED_REPLY
  || (!process.env.BROWSER_E2E_PUBLIC_REMOTE_FOLLOW_PROMPT
    ? DEFAULT_EXPECTED_REPLY
    : PROMPT.replace(/^Reply with exactly:\s*/u, ""));
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_REMOTE_FOLLOW_ROOM_ID || "browser-public-remote-follow-room";

const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[public-remote-follow-e2e] ${message}${suffix}`);
}

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-public-remote-follow-")
  );
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-public-remote-follow-codex-");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-remote-follow-workspace-"))
  );

  const broker = await startPublicBroker({ brokerPort, brokerStatePath });
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
      RELAY_BROKER_PEER_ID: "browser-public-remote-follow-relay",
      RELAY_BROKER_RELAY_ID: RELAY_ID,
      RELAY_BROKER_RELAY_REFRESH_TOKEN: RELAY_REFRESH_TOKEN,
      CODEX_HOME: codexHomeDir,
    }
  );
  logStep("relay started", { relayPort, workspaceDir });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
  logStep("relay connected to broker");

  let browser;
  let context;
  let localPage;
  let remotePage;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local");
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    logStep("local page loaded");

    await openSecurityModal(localPage);
    await localPage.click("#start-pairing-button");
    await localPage.waitForFunction(() => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(input && input.value.startsWith("http"));
    }, null, { timeout: TIMEOUT_MS });
    const pairingUrl = await localPage.inputValue("#pairing-link-input");
    assert.ok(
      pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
      `pairing url should use broker public url, got: ${pairingUrl}`
    );
    logStep("pairing url ready", { pairingUrl });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote");
    await installRemoteObserverHooks(remotePage);
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    logStep("remote page loaded");

    await localPage.waitForFunction(() => {
      return Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']"));
    }, null, { timeout: TIMEOUT_MS });
    await localPage.click("[data-pairing-id][data-pairing-decision='approve']");
    logStep("pairing approved");

    await waitForPairedRemote(remotePage);
    logStep("remote paired");
    await closeSecurityModal(localPage);
    logStep("local security modal closed");

    await localPage.fill("#cwd-input", workspaceDir);
    await localPage.click("#open-launch-settings");
    await localPage.waitForFunction(() => {
      const modal = document.querySelector("#launch-settings-modal");
      return Boolean(modal?.open);
    }, null, { timeout: TIMEOUT_MS });
    await localPage.selectOption("#approval-policy-input", "never");
    await localPage.click("#close-launch-settings-modal");
    await localPage.click("#start-session-button");
    logStep("local session start requested");

    await localPage.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.includes("Session ready");
    }, null, { timeout: TIMEOUT_MS });

    const relaySession = await waitForActiveThread(relayPort, workspaceDir);
    const threadId = relaySession.active_thread_id;
    assert.ok(threadId, "local page should start a live thread");
    logStep("local session ready", { threadId });

    await selectFirstRelayIfNeeded(remotePage);
    await remotePage.fill("#remote-threads-cwd-input", workspaceDir);
    await remotePage.click("#remote-threads-refresh-button");
    logStep("remote threads refresh requested");

    await remotePage.waitForFunction(
      (expectedThreadId) => {
        return Boolean(
          document.querySelector(
            `#remote-threads-list [data-thread-id="${expectedThreadId}"]`
          )
        );
      },
      threadId,
      { timeout: TIMEOUT_MS }
    );
    logStep("remote thread listed", { threadId });

    await remotePage.click(`#remote-threads-list [data-thread-id="${threadId}"]`);
    logStep("remote resume requested", { threadId });

    await remotePage.waitForFunction(
      (expectedThreadId) => {
        const transcript = document.querySelector("#remote-transcript");
        return (
          document.querySelector(`#remote-threads-list [data-thread-id="${expectedThreadId}"]`)
            ?.classList.contains("is-active") &&
          Boolean(transcript)
        );
      },
      threadId,
      { timeout: TIMEOUT_MS }
    );

    const remoteTakeOverCountBeforeSend = await remotePage.evaluate(
      () => window.__agentRelayTakeOverCount || 0
    );
    const remoteTranscriptBeforeSend = await safeText(remotePage, "#remote-transcript");
    logStep("remote observer attached", {
      remoteTakeOverCountBeforeSend,
      remoteTranscriptBeforeSendLength: remoteTranscriptBeforeSend.length,
    });

    const messageInput = localPage.locator("#message-input");
    await assertEnabled(messageInput);
    await messageInput.fill(PROMPT);
    await localPage.click("#send-button");
    logStep("local message sent");

    await localPage.waitForFunction(
      (expected) => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return transcript.includes(expected);
      },
      EXPECTED_REPLY,
      { timeout: TIMEOUT_MS }
    );
    logStep("local assistant reply visible");

    await remotePage.waitForFunction(
      (expected) => {
        const transcript = document.querySelector("#remote-transcript")?.textContent || "";
        return transcript.includes(expected);
      },
      EXPECTED_REPLY,
      { timeout: TIMEOUT_MS }
    );
    logStep("remote observed assistant reply");

    const remoteStats = await remotePage.evaluate(() => ({
      takeOverCount: window.__agentRelayTakeOverCount || 0,
      transcriptText: document.querySelector("#remote-transcript")?.textContent || "",
    }));

    assert.equal(
      remoteStats.takeOverCount,
      remoteTakeOverCountBeforeSend,
      "remote observer should not take over the session to receive updates"
    );
    assert.ok(
      remoteStats.transcriptText.includes(EXPECTED_REPLY),
      "remote transcript should include the local Codex reply"
    );
    assert.notEqual(
      remoteStats.transcriptText,
      remoteTranscriptBeforeSend,
      "remote transcript should update after the local Codex reply"
    );

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          pairingOrigin: new URL(pairingUrl).origin,
          workspaceDir,
          activeThreadId: threadId,
          remoteTakeOverCountBeforeSend,
          remoteTakeOverCountAfterSend: remoteStats.takeOverCount,
          remoteTranscriptBeforeSendLength: remoteTranscriptBeforeSend.length,
          remoteTranscriptAfterSendLength: remoteStats.transcriptText.length,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
          localClientLog: await safeText(localPage, "#client-log"),
        },
        null,
        2
      )
    );
  } catch (error) {
    logStep("failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
    await dumpBrowserState(localPage, remotePage);
    throw error;
  } finally {
    logStep("cleanup starting");
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(
        `[cleanup] failed to delete public remote-follow e2e threads for ${workspaceDir}: ${error.message}`
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
    console.log(`[public-remote-follow-e2e:${label}:console:${message.type()}] ${text}`);
  });
  page.on("pageerror", (error) => {
    console.error(
      `[public-remote-follow-e2e:${label}:pageerror] ${error.stack || error.message}`
    );
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    console.error(
      `[public-remote-follow-e2e:${label}:requestfailed] ${request.method()} ${request.url()} ${failure?.errorText || ""}`.trim()
    );
  });
}

async function installRemoteObserverHooks(page) {
  await page.addInitScript(() => {
    window.__transcriptDeltaCount = 0;
    window.__agentRelayTakeOverCount = 0;
    const NativeWebSocket = window.WebSocket;

    class InstrumentedWebSocket extends NativeWebSocket {
      send(data) {
        if (typeof data === "string") {
          if (data.includes('"action_id":"take_over-')) {
            window.__agentRelayTakeOverCount += 1;
          }
        }
        return super.send(data);
      }
    }

    window.WebSocket = InstrumentedWebSocket;
  });
}

async function waitForPairedRemote(page) {
  await page.waitForFunction(() => {
    const stored = JSON.parse(
      window.localStorage.getItem("agent-relay.remote-state")
        || window.localStorage.getItem("agent-relay.remote-state-v2")
        || "null"
    );
    return Boolean(
      stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length
    );
  }, null, { timeout: TIMEOUT_MS });
}

async function waitForActiveThread(relayPort, cwd, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.active_thread_id && session.current_cwd === cwd) {
      return session;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for active thread in ${cwd}`);
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
  }, null, { timeout: TIMEOUT_MS });
}

async function closeSecurityModal(page) {
  const isOpen = await page.evaluate(() => Boolean(document.querySelector("#security-modal")?.open));
  if (!isOpen) {
    return;
  }

  await page.click("#close-security-modal");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#security-modal");
    return !dialog?.open;
  }, null, { timeout: TIMEOUT_MS });
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

async function assertEnabled(locator) {
  await locator.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  const disabled = await locator.evaluate((element) => element.disabled);
  assert.equal(disabled, false, "expected locator to be enabled");
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
    }
  );
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
  if (child._logBuffer.length > 200) {
    child._logBuffer.splice(0, child._logBuffer.length - 200);
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

async function waitForBrokerConnection(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
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
  throw new Error(`timed out waiting for broker connection at ${url}`);
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
