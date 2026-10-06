// The remote half of the session-rename feature, over a real public broker.
//
// `browser-local-session-rename-e2e.mjs` proves the local surface and the relay. This one
// proves the part the local test structurally cannot: that the rename crosses the BROKER
// — the `rename_thread` remote action, its server-side `device_id` stamping, and the
// ack-only result — and that a rename made on the PHONE lands on the DESKTOP without
// anyone refreshing anything. That round trip is the actual feature request; every layer
// under it is only a means to it.
//
// It also covers what the unit tests cannot see: the `renamed` flag surviving the remote
// frame's byte-budget compaction, which is what decides whether the phone offers "use the
// agent's name" at all.
//
// Run: node scripts/browser-public-session-rename-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { deleteThreadsForCwdAndWait } from "./e2e-thread-cleanup.mjs";
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
import {
  selectFirstRelayIfNeeded,
  startRemoteSession,
} from "./e2e/harness/remote-session.mjs";
import { getFreePort, resolvePrivateIpv4 } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";
import { startPublicRelay, waitForBrokerConnection } from "./e2e/harness/relay.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PUBLIC_ISSUER_SECRET =
  process.env.BROWSER_E2E_PUBLIC_ISSUER_SECRET || "browser-e2e-public-issuer-a3f76b4c2089d15e6b0fa873c4e9521d";
const RELAY_REFRESH_TOKEN =
  process.env.BROWSER_E2E_PUBLIC_RELAY_REFRESH_TOKEN || "browser-e2e-relay-refresh";
const RELAY_ID = process.env.BROWSER_E2E_PUBLIC_RELAY_ID || "browser-e2e-relay-rename";
const BROKER_ROOM_ID =
  process.env.BROWSER_E2E_PUBLIC_SESSION_RENAME_ROOM_ID || "browser-public-session-rename-room";

const RENAMED_TITLE = "Auth work";

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[public-session-rename-e2e] ${message}${suffix}`);
}

/** The relay's own answer — the durable truth both surfaces are supposed to agree with. */
async function relayThreads(relayPort) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/threads?limit=50`);
  const payload = await response.json().catch(() => null);
  return payload?.data?.threads || [];
}

async function waitForRelayThread(relayPort, threadId, predicate, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = (await relayThreads(relayPort)).find((thread) => thread.id === threadId) || null;
    if (last && predicate(last)) {
      return last;
    }
    await delay(250);
  }
  assert.fail(`timed out waiting for ${label}; last row: ${JSON.stringify(last)}`);
}

/** The id of the session the remote just started, once the relay is listing it. */
async function waitForStartedThreadId(relayPort) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [thread] = await relayThreads(relayPort);
    if (thread?.id) {
      return thread.id;
    }
    await delay(250);
  }
  assert.fail("timed out waiting for the remote-started session to reach the relay");
}

async function waitForRemoteRow(page, threadId) {
  await page.waitForFunction(
    (id) => Boolean(document.querySelector(`#remote-threads-list [data-thread-id="${id}"]`)),
    threadId,
    { timeout: TIMEOUT_MS }
  );
}

async function waitForRemoteRowTitle(page, threadId, expected) {
  await page.waitForFunction(
    ({ id, title }) =>
      document
        .querySelector(`#remote-threads-list [data-thread-id="${id}"]`)
        ?.getAttribute("data-thread-title") === title,
    { id: threadId, title: expected },
    { timeout: TIMEOUT_MS }
  );
}

/** Open the per-session "⋯" sheet and return the labels it offers. */
async function openActionsSheet(page, threadId) {
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`#remote-threads-list [data-thread-id="${id}"]`);
      const more = row?.parentElement?.querySelector(".conversation-more");
      if (!more) {
        return false;
      }
      more.click();
      return true;
    },
    threadId,
    { timeout: TIMEOUT_MS }
  );
  await page.waitForSelector("#remote-thread-actions-sheet .thread-actions-item", {
    timeout: TIMEOUT_MS,
  });
  return page.evaluate(() =>
    [...document.querySelectorAll("#remote-thread-actions-sheet .thread-actions-item")].map(
      (item) => item.textContent.replace("✓", "").trim()
    )
  );
}

async function tapSheetItem(page, label) {
  const tapped = await page.evaluate((wanted) => {
    const item = [
      ...document.querySelectorAll("#remote-thread-actions-sheet .thread-actions-item"),
    ].find((node) => node.textContent.replace("✓", "").trim() === wanted);
    if (!item) {
      return false;
    }
    item.click();
    return true;
  }, label);
  assert.ok(tapped, `sheet item "${label}" not found`);
}

async function main() {
  const lanIp = resolvePrivateIpv4();
  const brokerPort = await getFreePort();
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-rename-"));
  const relayStateDb = path.join(stateDir, "sealwire.db");
  const brokerStatePath = path.join(stateDir, "public-control.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-public-rename-workspace-"))
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
    relayStateDb,
    brokerPort,
    lanIp,
    brokerRoomId: BROKER_ROOM_ID,
    relayId: RELAY_ID,
    relayRefreshToken: RELAY_REFRESH_TOKEN,
    peerId: "browser-public-session-rename-relay",
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
    attachPageDebugLogging(localPage, "local", { prefix: "public-session-rename-e2e" });
    await localPage.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    const pairingUrl = await startPairingFromLocalPage(localPage, {
      lanIp,
      brokerPort,
      timeoutMs: TIMEOUT_MS,
    });
    remotePage = await context.newPage();
    attachPageDebugLogging(remotePage, "remote", { prefix: "public-session-rename-e2e" });
    await remotePage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await approvePairing(localPage, TIMEOUT_MS);
    await waitForPairedRemote(remotePage, TIMEOUT_MS);
    await closeSecurityModal(localPage);
    await selectFirstRelayIfNeeded(remotePage, TIMEOUT_MS);
    logStep("remote paired");

    await startRemoteSession(remotePage, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      timeoutMs: TIMEOUT_MS,
    });
    const threadId = await waitForStartedThreadId(relayPort);
    await waitForRemoteRow(remotePage, threadId);
    logStep("session started", { threadId });

    // --- 1. baseline: the agent's own title, on both surfaces --------------------
    const providerRow = await waitForRelayThread(
      relayPort,
      threadId,
      (row) => Boolean(row.name),
      "the provider's own title"
    );
    const providerName = providerRow.name;
    assert.ok(!providerRow.renamed, "a fresh session carries no override");
    await waitForRemoteRowTitle(remotePage, threadId, providerName);

    // The reset entry must be ABSENT before there is anything to reset — proof the
    // `renamed` flag really crosses the byte-budgeted remote frame as `false`.
    const beforeLabels = await openActionsSheet(remotePage, threadId);
    assert.ok(
      beforeLabels.includes("Rename session…"),
      `expected a rename entry, got ${JSON.stringify(beforeLabels)}`
    );
    assert.ok(
      !beforeLabels.includes("Use the agent's name"),
      "a never-renamed session must not offer a reset that would do nothing"
    );

    // --- 2. rename FROM THE PHONE, over the broker -------------------------------
    remotePage.once("dialog", (dialog) => dialog.accept(RENAMED_TITLE));
    await tapSheetItem(remotePage, "Rename session…");

    // The relay is the arbiter: if this lands, the broker action, the server-side
    // device_id stamping and the persisted override all worked.
    const renamedRow = await waitForRelayThread(
      relayPort,
      threadId,
      (row) => row.name === RENAMED_TITLE,
      "the relay to record the phone's rename"
    );
    assert.equal(renamedRow.renamed, true, "the relay must mark the title as the user's");
    logStep("renamed over the broker", { threadId, name: renamedRow.name });

    await waitForRemoteRowTitle(remotePage, threadId, RENAMED_TITLE);

    // --- 3. THE REQUIREMENT: the desktop sees it, with nobody refreshing ----------
    // Nothing is clicked on the local page. It learns about the rename purely from the
    // `threads_revision` bump riding its snapshot stream.
    await localPage.waitForFunction(
      ({ id, title }) =>
        document
          .querySelector(`[data-thread-id="${id}"][data-thread-title]`)
          ?.getAttribute("data-thread-title") === title,
      { id: threadId, title: RENAMED_TITLE },
      { timeout: TIMEOUT_MS }
    );
    logStep("desktop picked the rename up unprompted");

    // --- 4. the reset entry appears once there IS an override --------------------
    const afterLabels = await openActionsSheet(remotePage, threadId);
    assert.ok(
      afterLabels.includes("Use the agent's name"),
      `expected a reset entry after renaming, got ${JSON.stringify(afterLabels)}`
    );

    // --- 5. reset from the phone, and watch both surfaces come back --------------
    await tapSheetItem(remotePage, "Use the agent's name");
    const resetRow = await waitForRelayThread(
      relayPort,
      threadId,
      (row) => !row.renamed,
      "the relay to drop the override"
    );
    assert.equal(
      resetRow.name,
      providerName,
      "resetting must restore the agent's own title, not blank the session"
    );
    await waitForRemoteRowTitle(remotePage, threadId, providerName);
    await localPage.waitForFunction(
      ({ id, title }) =>
        document
          .querySelector(`[data-thread-id="${id}"][data-thread-title]`)
          ?.getAttribute("data-thread-title") === title,
      { id: threadId, title: providerName },
      { timeout: TIMEOUT_MS }
    );
    logStep("reset propagated to both surfaces");

    console.log(
      JSON.stringify(
        {
          brokerPort,
          relayPort,
          workspaceDir,
          threadId,
          providerName,
          renamedTitle: RENAMED_TITLE,
          remoteClientLog: await safeText(remotePage, "#remote-client-log"),
        },
        null,
        2
      )
    );
    console.log("public session rename e2e: PASS");
  } catch (error) {
    logStep("failed", { message: error instanceof Error ? error.message : String(error) });
    await writeFailureArtifacts({
      scenario: "public-session-rename",
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
      console.error(`[cleanup] failed to delete rename e2e threads: ${error.message}`);
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await stopManagedProcess(broker);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
