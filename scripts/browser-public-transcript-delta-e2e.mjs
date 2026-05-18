import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { deleteThreadsForCwdAndWait } from "./e2e-thread-cleanup.mjs";
import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { dumpBrowserState, launchBrowser } from "./e2e/harness/browser.mjs";
import { startPublicBroker } from "./e2e/harness/broker.mjs";
import { approvePairing, startPairingFromLocalPage, waitForPairedRemote } from "./e2e/harness/pairing.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";
import { startPublicRelay, waitForBrokerConnection, waitForSingleStartedThread } from "./e2e/harness/relay.mjs";
import { startRemoteSession, waitForRemoteMessageInput } from "./e2e/harness/remote-session.mjs";

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
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const relayStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-delta-e2e-")
  );
  const relayStatePath = path.join(relayStateDir, "session.json");
  const brokerStatePath = path.join(relayStateDir, "public-control.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-delta-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-delta-workspace-"))
  );

  const broker = startPublicBroker({
    brokerPort,
    brokerStatePath,
    relayId: RELAY_ID,
    brokerRoomId: BROKER_ROOM_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    issuerSecret: PUBLIC_ISSUER_SECRET,
  });
  await waitForHealth(`http://127.0.0.1:${brokerPort}/api/health`);

  const relay = startPublicRelay({
    relayPort,
    relayStatePath,
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    codexHomeDir,
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
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
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });

    remotePage = await context.newPage();
    // Inject counters before page JS loads so applyTranscriptDelta/applySessionSnapshot can increment them
    await remotePage.addInitScript(() => {
      window.__transcriptDeltaCount = 0;
      window.__snapshotCount = 0;
    });

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
    await dumpBrowserState({ localPage, remotePage });
    await writeFailureArtifacts({
      scenario: "public-transcript-delta",
      broker,
      relay,
      localPage,
      remotePage,
      metadata: {
        brokerPort,
        relayPort,
        workspaceDir,
        fakeProvider: USE_FAKE_PROVIDER,
      },
    });
    throw error;
  } finally {
    await browser?.close();
    await stopManagedProcess(broker);
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(relayStateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
