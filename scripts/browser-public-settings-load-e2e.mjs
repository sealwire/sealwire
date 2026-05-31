// Cross-client settings load: a session's model + permission + effort must
// appear on ANOTHER client that didn't configure them.
//
// The LOCAL page starts a session with a distinctive model/approval/effort, then
// a freshly-paired REMOTE page (think: your phone) opens that thread. The remote
// must surface all three from the session snapshot — not its own per-device
// defaults. This is the regression net for "I set high but my phone shows
// medium" and the broader "another client should load the settings" invariant.
// Provider-agnostic (fake provider stands in for codex/claude).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import {
  approvePairing,
  closeSecurityModal,
  startPairingFromLocalPage,
  waitForPairedRemote,
} from "./e2e/harness/pairing.mjs";
import { selectFirstRelayIfNeeded } from "./e2e/harness/remote-session.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";
import { startPublicRelay, waitForBrokerConnection } from "./e2e/harness/relay.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-settings-load";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_SETTINGS_LOAD_ROOM_ID || "browser-public-settings-load-room";

// What the LOCAL client configures; the REMOTE client must display all of it.
const MODEL = "fake-echo";
const APPROVAL = "bypass"; // rendered as "Full access (YOLO)"
const EFFORT = "high";

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[public-settings-load-e2e] ${message}${suffix}`);
}

async function waitForActive(relayPort, { cwd }) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchSession(relayPort);
    if (
      last.active_thread_id &&
      last.current_cwd === cwd &&
      last.approval_policy === APPROVAL &&
      last.reasoning_effort === EFFORT
    ) {
      return last.active_thread_id;
    }
    await delay(200);
  }
  assert.fail(`timed out waiting for the local session to apply settings: ${JSON.stringify(last)}`);
}

async function waitForRemoteThread(page, threadId) {
  await page.waitForFunction(
    (id) => Boolean(document.querySelector(`#remote-threads-list [data-thread-id="${id}"]`)),
    threadId,
    { timeout: TIMEOUT_MS },
  );
}

async function clickRemoteThread(page, threadId) {
  await page.waitForFunction(
    (id) => {
      const button = document.querySelector(`#remote-threads-list [data-thread-id="${id}"]`);
      if (!button) return false;
      button.click();
      return true;
    },
    threadId,
    { timeout: TIMEOUT_MS },
  );
}

async function readRemoteLoadedSettings(page) {
  // Model lives in the composer chip; permission + effort live in the popover.
  await page.waitForSelector("#remote-message-model", { timeout: TIMEOUT_MS });
  await page.waitForSelector("#remote-session-settings-button", { timeout: TIMEOUT_MS });
  await page.click("#remote-session-settings-button");
  await page.waitForSelector(".session-settings-popover", { timeout: TIMEOUT_MS });
  return page.evaluate(() => ({
    model: document.querySelector("#remote-message-model")?.value ?? null,
    effort:
      document
        .querySelector("#session-settings-effort .settings-segmented-option.is-selected")
        ?.textContent?.trim() ?? null,
    approval:
      document
        .querySelector(".approval-card.is-selected .approval-card-label")
        ?.textContent?.trim() ?? null,
  }));
}

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-settings-load-"));
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-settings-load-ws-")),
  );

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath: path.join(stateDir, "public-control.json"),
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: PUBLIC_ISSUER_SECRET,
  });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = startPublicRelay({
    relayPort,
    relayStatePath: path.join(stateDir, "session.json"),
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    peerId: "browser-public-settings-load-relay",
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);
  await waitForBrokerConnection(`http://127.0.0.1:${relayPort}/api/session`);

  let browser;
  let context;
  let localPage;
  let remotePage;

  try {
    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-settings-load-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });
    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-settings-load-e2e" });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    await closeSecurityModal(localPage);
    await selectFirstRelayIfNeeded(remotePage, TIMEOUT_MS);
    logStep("remote paired");

    // The LOCAL client configures the session; the remote never touches these.
    await localPage.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    await startLocalSession(localPage, {
      cwd: workspaceDir,
      approvalPolicy: APPROVAL,
      effort: EFFORT,
      provider: "fake",
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
    });
    const threadId = await waitForActive(relayPort, { cwd: workspaceDir });
    logStep("local started session", { threadId, MODEL, APPROVAL, EFFORT });

    // The REMOTE client opens that thread and must show everything.
    await waitForRemoteThread(remotePage, threadId);
    await clickRemoteThread(remotePage, threadId);
    const loaded = await readRemoteLoadedSettings(remotePage);
    logStep("remote loaded settings", loaded);

    assert.equal(loaded.model, MODEL, "remote must load the session's model");
    assert.match(
      loaded.effort || "",
      /high/i,
      `remote must load the session's effort (got ${loaded.effort})`,
    );
    assert.match(
      loaded.approval || "",
      /full access|yolo/i,
      `remote must load the session's permission mode (got ${loaded.approval})`,
    );
    logStep("remote loaded model + permission + effort from the session", loaded);

    console.log(JSON.stringify({ relayPort, threadId, ...loaded, ok: true }, null, 2));
  } catch (error) {
    logStep("failed", { message: error instanceof Error ? error.message : String(error) });
    await writeFailureArtifacts({
      scenario: "public-settings-load",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: { brokerPort, relayPort, lanIp, workspaceDir },
    });
    dumpProcessLogs(broker, relay);
    await dumpBrowserState({ localPage, remotePage });
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(`[cleanup] failed to delete settings-load threads: ${error.message}`);
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
