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
  launchBrowser,
  safeText,
} from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
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
  startPublicRelay,
  waitForBrokerConnection,
  waitForSingleStartedThread,
} from "./e2e/harness/relay.mjs";
import {
  sendPromptAndWaitForReply,
  startRemoteSession,
  waitForRemoteMessageInput,
} from "./e2e/harness/remote-session.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const ENROLLMENT_PROMPT =
  process.env.BROWSER_E2E_PUBLIC_ENROLLMENT_PROMPT ||
  "Reply with exactly: public-enrollment-e2e";
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer";
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

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

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath,
    issuerSecret: PUBLIC_ISSUER_SECRET,
  });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
    peerId: "browser-public-enrollment-relay",
    registrationPath,
    identityPath,
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });
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
  let pairingUrl;

  try {
    ({ browser, context } = await launchBrowser());

    localPage = await context.newPage();
    attachPageDebugLogging(localPage, "local", { prefix: "public-enrollment-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });

    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-enrollment-e2e" });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);

    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "never",
      timeoutMs: TIMEOUT_MS,
    });
    await waitForSingleStartedThread(relayPort, workspaceDir, { timeoutMs: TIMEOUT_MS });
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);

    await sendPromptAndWaitForReply(remotePage, ENROLLMENT_PROMPT, {
      timeoutMs: TIMEOUT_MS,
    });
    await remotePage.reload({ waitUntil: "domcontentloaded" });
    await waitForRemoteOnline(remotePage, TIMEOUT_MS);
    await waitForRemoteMessageInput(remotePage, TIMEOUT_MS);

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
    await writeFailureArtifacts({
      scenario: "public-enrollment",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        lanIp,
        workspaceDir,
        registrationPath,
        identityPath,
        pairingOrigin: pairingUrl ? new URL(pairingUrl).origin : null,
        relayId: registration.relay_id,
        brokerRoomId: registration.broker_room_id,
        fakeProvider: USE_FAKE_PROVIDER,
      },
    });
    dumpProcessLogs(broker, relay);
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

async function waitForRemoteOnline(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const badge = document.querySelector("#remote-status-badge")?.textContent || "";
      return badge.trim().length > 0 && !badge.toLowerCase().includes("offline");
    },
    null,
    { timeout: timeoutMs }
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
