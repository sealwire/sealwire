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
  { length: 20 },
  (_, index) => `transcript-delta-e2e-${index + 1}`
).join("\n");
const DEFAULT_PROMPT = [
  "Reply with exactly these 20 lines, one per line, and no extra text:",
  DEFAULT_EXPECTED_REPLY,
].join("\n");
const PROMPT = process.env.BROWSER_E2E_DELTA_PROMPT || DEFAULT_PROMPT;
const EXPECTED_REPLY = process.env.BROWSER_E2E_DELTA_EXPECTED_REPLY
  || (!process.env.BROWSER_E2E_DELTA_PROMPT
    ? DEFAULT_EXPECTED_REPLY
    : PROMPT.replace(/^Reply with exactly:\s*/u, ""));
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-1";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_ROOM_ID || "browser-public-delta-e2e-room";

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
  const relayStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-delta-e2e-")
  );
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-delta-codex-");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-delta-workspace-"))
  );

  const broker = await startPublicBroker({ brokerPort, brokerStatePath });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], {
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
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

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
    assert.ok(pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`), `pairing url should use broker public url, got: ${pairingUrl}`);

    remotePage = await context.newPage();
    // Inject counters before page JS loads so applyTranscriptDelta/applySessionSnapshot can increment them
    await remotePage.addInitScript(() => {
      window.__transcriptDeltaCount = 0;
      window.__snapshotCount = 0;
    });

    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });

    await localPage.waitForFunction(
      () => Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']")),
      null,
      { timeout: TIMEOUT_MS }
    );
    await localPage.click("[data-pairing-id][data-pairing-decision='approve']");

    await remotePage.waitForFunction(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("agent-relay.remote-state") ||
          window.localStorage.getItem("agent-relay.remote-state-v2") ||
          "null"
      );
      return Boolean(
        stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length
      );
    }, null, { timeout: TIMEOUT_MS });


    await openRemoteSessionPanel(remotePage);
    await remotePage.selectOption("#remote-approval-policy-input", "never");
    await remotePage.fill("#remote-cwd-input", workspaceDir);
    await remotePage.click("#remote-start-session-button");

    await waitForSingleStartedThread(relayPort, workspaceDir);
    await remotePage.waitForFunction(
      () => {
        const input = document.querySelector("#remote-message-input");
        return Boolean(input && !input.disabled);
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    await remotePage.fill("#remote-message-input", PROMPT);
    await remotePage.click("#remote-send-button");

    // Wait for the expected assistant reply to appear in transcript.
    await remotePage.waitForFunction(
      (expected) => {
        const assistantBodies = [
          ...document.querySelectorAll("#remote-transcript .chat-message-assistant .message-body"),
        ];
        return assistantBodies.some((node) => (node.textContent || "").includes(expected));
      },
      EXPECTED_REPLY,
      { timeout: TIMEOUT_MS }
    );

    // Verify transcript_delta was applied
    const deltaCount = await remotePage.evaluate(() => window.__transcriptDeltaCount);
    const snapshotCount = await remotePage.evaluate(() => window.__snapshotCount);

    assert.ok(
      deltaCount > 0,
      `applyTranscriptDelta should have been called at least once during the session (got 0). ` +
        `Snapshots received: ${snapshotCount}`
    );

    console.log(`transcript_delta applied: ${deltaCount}, snapshots: ${snapshotCount}`);

    await deleteThreadsForCwdAndWait(relayPort, workspaceDir);

    console.log(JSON.stringify({
      brokerPort,
      relayPort,
      workspaceDir,
      deltaCount,
      snapshotCount,
    }, null, 2));
  } catch (error) {
    dumpProcessLogs(broker);
    dumpProcessLogs(relay);
    await dumpBrowserState(localPage, remotePage);
    throw error;
  } finally {
    await browser?.close();
    await stopManagedProcess(broker);
    await stopManagedProcess(relay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function openSecurityModal(page) {
  const isOpen = await page.evaluate(() =>
    Boolean(document.querySelector("#security-modal")?.open)
  );
  if (isOpen) return;
  await page.click("#open-security-header");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#security-modal");
    return Boolean(dialog?.open);
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
  if (!needsSelection) return;

  await page.click("#remote-relays-list [data-relay-id]:not([disabled])");
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector("#remote-session-toggle");
      return Boolean(toggle && !toggle.disabled);
    },
    null,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForSingleStartedThread(relayPort, cwd, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    const threads = await fetchThreadsForCwd(relayPort, cwd);
    assert.ok(threads.length <= 1, `should not start more than one thread for ${cwd}`);
    if (
      session.active_thread_id &&
      session.current_cwd === cwd &&
      (threads.length === 0 || (threads.length === 1 && threads[0]?.id === session.active_thread_id))
    ) {
      return;
    }
    await delay(300);
  }
  throw new Error(`timed out waiting for a started thread in ${cwd}`);
}

async function fetchThreadsForCwd(relayPort, cwd) {
  const response = await fetch(
    `http://127.0.0.1:${relayPort}/api/threads?cwd=${encodeURIComponent(cwd)}&limit=200`
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload?.ok, true);
  return payload.data?.threads || [];
}

async function startPublicBroker({ brokerPort, brokerStatePath }) {
  const relayRegistrations = JSON.stringify([
    {
      relay_id: RELAY_ID,
      broker_room_id: BROKER_ROOM_ID,
      refresh_token: RELAY_REFRESH_TOKEN,
    },
  ]);

  return spawnManagedProcess("broker", "cargo", ["run", "-p", "relay-broker"], {
    BIND_HOST: "0.0.0.0",
    PORT: String(brokerPort),
    RELAY_BROKER_AUTH_MODE: "public",
    RELAY_BROKER_PUBLIC_ISSUER_SECRET: PUBLIC_ISSUER_SECRET,
    RELAY_BROKER_PUBLIC_RELAYS_JSON: relayRegistrations,
    RELAY_BROKER_PUBLIC_STATE_PATH: brokerStatePath,
  });
}

function spawnManagedProcess(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
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
  throw new Error(`timed out waiting for health: ${url}`);
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
        if (error) { reject(error); return; }
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
