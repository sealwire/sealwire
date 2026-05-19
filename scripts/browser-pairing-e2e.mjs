import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { startSelfHostedBroker } from "./e2e/harness/broker.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import {
  approvePairing,
  startPairingFromLocalPage,
  waitForPairedRemote,
} from "./e2e/harness/pairing.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";
import {
  sendPromptAndWaitForReply,
  startRemoteSession,
} from "./e2e/harness/remote-session.mjs";
import { startSelfHostedRelay, waitForBrokerConnection } from "./e2e/harness/relay.mjs";

const ROOT = process.cwd();
const PAIRING_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT = process.env.BROWSER_E2E_PROMPT || "Reply with exactly: browser-pairing-e2e";
const BROKER_TICKET_SECRET =
  process.env.BROWSER_E2E_BROKER_TICKET_SECRET || "browser-e2e-broker-secret";
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-browser-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);

  const broker = startSelfHostedBroker({
    brokerPort,
    ticketSecret: BROKER_TICKET_SECRET,
  });
  const relay = startSelfHostedRelay({
    relayPort,
    relayStatePath: statePath,
    brokerPort,
    lanIp,
    brokerRoomId: "browser-e2e-room",
    peerId: "browser-e2e-relay",
    ticketSecret: BROKER_TICKET_SECRET,
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });

  let browser;
  let context;
  let localPage;
  let remotePage;
  let createdThreadId = null;
  let pairingUrl = null;

  try {
    await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
    await waitForBrokerConnection(
      `http://127.0.0.1:${relayPort}/api/session`,
      PAIRING_TIMEOUT_MS
    );

    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "pairing-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: PAIRING_TIMEOUT_MS,
    });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "pairing-e2e" });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await remotePage.waitForFunction(
      () => {
        const modal = document.querySelector("#pairing-modal");
        if (!modal) {
          return false;
        }

        const style = window.getComputedStyle(modal);
        return modal.open === false && style.display === "none";
      },
      null,
      { timeout: PAIRING_TIMEOUT_MS }
    );

    // Regression coverage: the first remote surface disconnects before local approval,
    // then reconnects on a new broker peer. Approval must still reach the new peer.
    await remotePage.close();
    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote-reconnect", { prefix: "pairing-e2e" });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });

    await approvePairing(localPage, PAIRING_TIMEOUT_MS);
    await waitForPairedRemote(remotePage, PAIRING_TIMEOUT_MS);
    await remotePage.waitForFunction(
      () => {
        const meta = document.querySelector("#device-meta")?.textContent || "";
        return meta.includes("Paired");
      },
      null,
      { timeout: PAIRING_TIMEOUT_MS }
    );

    await startRemoteSession(remotePage, {
      cwd: cwdInput,
      approvalPolicy: "never",
      timeoutMs: PAIRING_TIMEOUT_MS,
    });
    await remotePage.waitForFunction(
      () => {
        const transcript = document.querySelector("#remote-transcript")?.textContent || "";
        return transcript.includes("Session ready");
      },
      null,
      { timeout: PAIRING_TIMEOUT_MS }
    );

    const relaySessionAfterStart = await fetchSession(relayPort);
    assert.equal(
      relaySessionAfterStart.current_cwd,
      ROOT,
      `remote start should normalize cwd to ${ROOT}, got ${relaySessionAfterStart.current_cwd}`
    );

    await sendPromptAndWaitForReply(remotePage, PROMPT, { timeoutMs: PAIRING_TIMEOUT_MS });

    await remotePage.reload({ waitUntil: "domcontentloaded" });
    await remotePage.waitForFunction(
      () => {
        const input = document.querySelector("#remote-message-input");
        const badge = document.querySelector("#remote-status-badge")?.textContent || "";
        return Boolean(
          input && !input.disabled && badge.trim() && !badge.toLowerCase().includes("offline")
        );
      },
      null,
      { timeout: PAIRING_TIMEOUT_MS }
    );

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
          fakeProvider: USE_FAKE_PROVIDER,
          pairedDevices: relaySession.paired_devices?.map((device) => ({
            deviceId: device.device_id,
            label: device.label,
            lastPeerId: device.last_peer_id,
          })),
          lastAssistant: [...relaySession.transcript]
            .reverse()
            .find((entry) => entry.kind === "agent_text")?.text,
        },
        null,
        2
      )
    );
  } catch (error) {
    await dumpBrowserState({ localPage, remotePage });
    dumpProcessLogs(broker, relay);
    await writeFailureArtifacts({
      scenario: "pairing-e2e",
      broker,
      relay,
      relayPort,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        cwdInput,
        pairingUrl,
        fakeProvider: USE_FAKE_PROVIDER,
      },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
