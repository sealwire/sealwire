import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
  safeText,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import {
  approvePairing,
  closeSecurityModal,
  startPairingFromLocalPage,
  waitForPairedRemote,
} from "./e2e/harness/pairing.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";
import {
  startPublicRelay,
  waitForBrokerConnection,
} from "./e2e/harness/relay.mjs";

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
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

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
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-public-remote-follow-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-remote-follow-workspace-"))
  );

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath,
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: PUBLIC_ISSUER_SECRET,
  });
  logStep("broker started", { brokerPort });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
  logStep("broker healthy");

  const relay = startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    codexHomeDir,
    peerId: "browser-public-remote-follow-relay",
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });
  logStep("relay started", { relayPort, workspaceDir });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);
  logStep("relay connected to broker");

  let browser;
  let context;
  let localPage;
  let remotePage;

  try {
    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-remote-follow-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    logStep("local page loaded");

    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });
    logStep("pairing url ready", { pairingUrl });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-remote-follow-e2e" });
    await installRemoteObserverHooks(remotePage);
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    logStep("remote page loaded");

    await approvePairing(localPage, TIMEOUT_MS);
    logStep("pairing approved");

    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    logStep("remote paired");
    await closeSecurityModal(localPage);
    logStep("local security modal closed");

    await startLocalSession(localPage, {
      cwd: workspaceDir,
      approvalPolicy: "never",
      provider: USE_FAKE_PROVIDER ? "fake" : undefined,
      model: USE_FAKE_PROVIDER ? "fake-echo" : undefined,
      timeoutMs: TIMEOUT_MS,
    });
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

    const remoteThreadsLayout = await remotePage.evaluate(() => {
      const list = document.querySelector("#remote-threads-list");
      const sidebar = document.querySelector(".remote-app-shell .sidebar");
      return {
        listHasScrollRootAttribute: Boolean(list?.hasAttribute("data-thread-list-scroll-root")),
        listOverflowY: list ? window.getComputedStyle(list).overflowY : "",
        sidebarOverflowY: sidebar ? window.getComputedStyle(sidebar).overflowY : "",
      };
    });
    assert.deepEqual(
      remoteThreadsLayout,
      {
        listHasScrollRootAttribute: false,
        listOverflowY: "visible",
        sidebarOverflowY: "auto",
      },
      "remote threads should scroll with the sidebar instead of freezing its heading"
    );

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

    const messageInput = await ensureLocalMessageInputEnabled(localPage);
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
    await writeFailureArtifacts({
      scenario: "public-remote-follow",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        workspaceDir,
        fakeProvider: USE_FAKE_PROVIDER,
      },
    });
    dumpProcessLogs(broker, relay);
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

async function ensureLocalMessageInputEnabled(page) {
  const locator = page.locator("#message-input");
  await assertEnabled(locator);
  const disabled = await locator.evaluate((element) => element.disabled);
  if (!disabled) {
    return locator;
  }

  const canTakeOver = await page.evaluate(() => {
    const button = document.querySelector("#take-over-button");
    if (!button || button.hidden || button.disabled) {
      return false;
    }
    const style = window.getComputedStyle(button);
    return style.visibility !== "hidden" && style.display !== "none";
  });
  assert.equal(canTakeOver, true, "local page should offer control takeover when composer is read-only");
  await page.click("#take-over-button");
  await page.waitForFunction(() => {
    const input = document.querySelector("#message-input");
    return Boolean(input && !input.disabled);
  }, null, { timeout: TIMEOUT_MS });
  return locator;
}

async function assertEnabled(locator) {
  await locator.waitFor({ state: "visible", timeout: TIMEOUT_MS });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
