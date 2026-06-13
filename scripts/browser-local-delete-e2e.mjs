import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { prepareSeededCodexHome } from "./e2e-codex-home.mjs";
import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT =
  process.env.BROWSER_E2E_LOCAL_DELETE_PROMPT || "Reply with exactly: local-delete-browser-e2e";
const USE_FAKE_PROVIDER = process.env.AGENT_PROVIDERS === "fake";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-delete-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const codexHomeDir = await prepareSeededCodexHome("agent-relay-local-delete-codex-", {
    requireAuth: !USE_FAKE_PROVIDER,
  });
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-delete-workspace-"))
  );
  const cwdInput = toTildePath(workspaceDir);
  const cleanupThreadIds = [];

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    codexHomeDir,
    extraEnv: USE_FAKE_PROVIDER ? { AGENT_PROVIDERS: "fake" } : {},
  });

  let browser;
  let context;
  let page;

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-delete-e2e" });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: LOCAL_TIMEOUT_MS });
    await page.waitForFunction(
      () => Boolean(localStorage.getItem("agent-relay.device-id")),
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    const deviceId = await page.evaluate(() => localStorage.getItem("agent-relay.device-id"));
    assert.ok(deviceId, "local delete e2e should have a browser device id");

    const fallbackThreadId = await startThread(relayPort, {
      cwd: workspaceDir,
      deviceId,
      initialPrompt: "Reply with exactly: local-delete-fallback-e2e",
      provider: USE_FAKE_PROVIDER ? "fake" : undefined,
      model: USE_FAKE_PROVIDER ? "fake-echo" : undefined,
    });
    cleanupThreadIds.push(fallbackThreadId);

    await startLocalSession(page, {
      cwd: cwdInput,
      approvalPolicy: "never",
      provider: USE_FAKE_PROVIDER ? "fake" : undefined,
      model: USE_FAKE_PROVIDER ? "fake-echo" : undefined,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });

    await page.waitForFunction(
      () => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return transcript.includes("Session ready");
      },
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    await page.fill("#message-input", PROMPT);
    await page.click("#send-button");
    const expectedReply = PROMPT.replace("Reply with exactly: ", "");
    await page.waitForFunction(
      (expected) => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return transcript.includes(expected);
      },
      expectedReply,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const relaySession = await fetchSession(relayPort);
    const threadId = relaySession.active_thread_id;
    assert.ok(threadId, "local delete e2e should create an active thread");
    cleanupThreadIds.push(threadId);
    assert.notEqual(threadId, fallbackThreadId, "delete target should be different from fallback");
    await waitForThreadIdle(relayPort, threadId);

    page.once("dialog", (dialog) => dialog.accept());
    await openThreadContextMenu(page, threadId, "#delete-thread-button");
    await page.click("#delete-thread-button");

    await waitForThreadMissing(relayPort, workspaceDir, threadId);
    await page.waitForFunction(
      (deletedThreadId) => !document.querySelector(`[data-thread-id="${deletedThreadId}"]`),
      threadId,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.waitForFunction(
      (expectedThreadId) => {
        const shell = document.querySelector(".app-shell");
        const chatShell = document.querySelector(".chat-shell");
        const activeThread = document.querySelector(`[data-thread-id="${expectedThreadId}"]`);
        return (
          shell?.dataset.view === "conversation" &&
          chatShell?.dataset.view === "conversation" &&
          activeThread?.classList.contains("is-active") &&
          new URL(window.location.href).searchParams.get("thread") === expectedThreadId
        );
      },
      fallbackThreadId,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    // Viewing is decoupled from control ("Decouple thread viewing from targeted
    // control"): after the controlled thread is deleted the relay clears its
    // active session, and the UI navigates VIEW-ONLY to the adjacent thread
    // (asserted above) WITHOUT resuming it on the relay — only a send takes
    // control. So the relay reports no controlled thread here even though the
    // user is now viewing fallbackThreadId.
    const relayAfterDelete = await fetchSession(relayPort);
    assert.equal(
      relayAfterDelete.active_thread_id,
      null,
      "deleting the controlled thread should clear the relay's active session (view-only navigation never resumes it)"
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          cwdInput,
          deletedThreadId: threadId,
          fallbackThreadId,
          currentStatus: relayAfterDelete.current_status,
          fakeProvider: USE_FAKE_PROVIDER,
        },
        null,
        2
      )
    );
  } catch (error) {
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    await writeFailureArtifacts({
      scenario: "local-delete-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: { cwdInput, fakeProvider: USE_FAKE_PROVIDER },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    throw error;
  } finally {
    for (const threadId of cleanupThreadIds.reverse()) {
      await deleteThreadAndWait(relayPort, threadId, {
        cwd: workspaceDir,
        timeoutMs: LOCAL_TIMEOUT_MS,
      }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete local delete e2e thread ${threadId}: ${error.message}`
          );
        }
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(codexHomeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
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

async function waitForThreadMissing(relayPort, cwd, threadId, timeoutMs = LOCAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads?cwd=${encodeURIComponent(cwd)}`
    );
    const payload = await response.json();
    if (response.ok && payload?.ok) {
      const threads = payload.data?.threads || [];
      if (!threads.some((thread) => thread.id === threadId)) {
        return;
      }
    }
    await delay(250);
  }

  throw new Error(`timed out waiting for deleted thread ${threadId} to disappear`);
}

async function waitForThreadIdle(relayPort, threadId, timeoutMs = LOCAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort);
    if (session.active_thread_id === threadId && !session.active_turn_id) {
      return session;
    }
    await delay(250);
  }

  throw new Error(`timed out waiting for thread ${threadId} to become idle before deletion`);
}

async function openThreadContextMenu(page, threadId, actionSelector) {
  const target = page.locator(`#threads-list [data-thread-id="${threadId}"]`);
  await target.waitFor({ state: "visible", timeout: LOCAL_TIMEOUT_MS });
  await target.scrollIntoViewIfNeeded({ timeout: LOCAL_TIMEOUT_MS });
  const box = await target.boundingBox({ timeout: LOCAL_TIMEOUT_MS });
  assert.ok(box, `thread row ${threadId} should have a bounding box before opening menu`);
  await target.click({
    button: "right",
    position: {
      x: Math.min(box.width / 2, 160),
      y: Math.min(box.height / 2, 24),
    },
    timeout: LOCAL_TIMEOUT_MS,
  });
  await page.waitForFunction(
    ({ actionSelector, threadId }) => {
      const menu = document.querySelector("#thread-context-menu");
      const button = document.querySelector(actionSelector);
      const row = [...document.querySelectorAll("#threads-list [data-thread-id]")].find(
        (element) => element.dataset.threadId === threadId
      );
      return Boolean(
        menu &&
          !menu.hidden &&
          button &&
          !button.disabled &&
          row?.classList.contains("is-context-target")
      );
    },
    { actionSelector, threadId },
    { timeout: LOCAL_TIMEOUT_MS }
  );
}

async function startThread(relayPort, { cwd, deviceId, initialPrompt, provider, model }) {
  const body = {
    cwd,
    device_id: deviceId,
    initial_prompt: initialPrompt,
    approval_policy: "never",
    sandbox: "workspace-write",
    effort: "medium",
  };
  if (provider) {
    body.provider = provider;
  }
  if (model) {
    body.model = model;
  }

  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  assert.equal(response.status, 200, `failed to start thread ${initialPrompt}`);
  assert.equal(payload?.ok, true, `thread start payload should succeed for ${initialPrompt}`);
  assert.ok(payload?.data?.active_thread_id, `thread id missing for ${initialPrompt}`);
  return payload.data.active_thread_id;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
