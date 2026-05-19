import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-browser-claude-e2e-"));
  const statePath = path.join(stateDir, "session.json");

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "claude_code" },
  });

  let browser;
  let context;
  let page;

  try {
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`, LOCAL_TIMEOUT_MS);

    const providers = await fetchEnvelope(relayPort, "/api/providers");
    assert.ok(
      providers.data?.includes("claude_code"),
      "relay should expose the Claude Code provider"
    );

    const threads = (await fetchEnvelope(relayPort, "/api/threads")).data?.threads || [];
    const claudeThreads = threads.filter((thread) => thread.provider === "claude_code");
    if (!claudeThreads.length) {
      console.log(JSON.stringify({ ok: true, skipped: "no local Claude Code sessions found" }));
      return;
    }

    const resumed = await resumeFirstReadableClaudeThread(relayPort, claudeThreads);
    if (!resumed) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: "Claude Code sessions exist, but none had readable transcript history",
          thread_count: claudeThreads.length,
        })
      );
      return;
    }

    const { thread, session } = resumed;
    if (hasMissingClaudeNativeBinary(session)) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: "Claude Code sessions exist, but the native Claude Code binary is unavailable",
          threadId: thread.id,
        })
      );
      return;
    }

    ({ browser, context } = await launchBrowser({
      contextOptions: {
        viewport: {
          width: 1440,
          height: 1000,
        },
      },
    }));
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "claude-local-e2e" });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${encodeURIComponent(thread.id)}`, {
      waitUntil: "domcontentloaded",
    });

    const threadSelector = `[data-thread-id="${cssEscapeForSelector(thread.id)}"]`;
    await page.waitForFunction(
      ({ selector }) => {
        const row = document.querySelector(selector);
        const shell = document.querySelector(".app-shell");
        return shell?.dataset.view === "conversation" && row?.dataset.threadProvider === "claude_code";
      },
      { selector: threadSelector },
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const renderedThread = page.locator(threadSelector);
    await renderedThread.click();

    await page.waitForFunction(
      (expectedThreadId) => {
        const row = document.querySelector(`[data-thread-id="${CSS.escape(expectedThreadId)}"]`);
        const shell = document.querySelector(".app-shell");
        return (
          shell?.dataset.view === "conversation" &&
          row?.classList.contains("is-active") &&
          new URL(window.location.href).searchParams.get("thread") === expectedThreadId
        );
      },
      thread.id,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    await page.waitForFunction(
      () => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return transcript.trim().length > 0 && !transcript.includes("No transcript");
      },
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const providerDotLabel = await renderedThread
      .locator(".conversation-provider-dot")
      .first()
      .getAttribute("aria-label");
    assert.equal(providerDotLabel, "Claude Code");

    await page.click("#open-session-details");
    await page.waitForFunction(
      () => {
        const modal = document.querySelector("#session-details-modal");
        const meta = document.querySelector("#session-meta")?.textContent || "";
        return Boolean(modal?.open) && meta.includes("Claude Code");
      },
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.click("#close-session-details-modal");

    page.once("dialog", (dialog) => {
      assert.match(dialog.message(), /Claude Code storage/);
      dialog.dismiss();
    });
    await renderedThread.click({ button: "right" });
    await page.waitForFunction(
      () => {
        const menu = document.querySelector("#thread-context-menu");
        const button = document.querySelector("#delete-thread-button");
        return Boolean(menu && !menu.hidden && button && !button.disabled);
      },
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.click("#delete-thread-button");

    page.once("dialog", (dialog) => dialog.accept());
    await renderedThread.click({ button: "right" });
    await page.waitForFunction(
      () => {
        const menu = document.querySelector("#thread-context-menu");
        const button = document.querySelector("#archive-thread-button");
        return Boolean(menu && !menu.hidden && button && !button.disabled);
      },
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.click("#archive-thread-button");
    await page.waitForFunction(
      () => {
        const log = document.querySelector("#client-log")?.textContent || "";
        return /Failed to archive local session: .*archive is not supported/i.test(log);
      },
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const relaySession = await fetchEnvelope(relayPort, "/api/session");
    assert.equal(relaySession.data?.provider, "claude_code");
    assert.equal(relaySession.data?.active_thread_id, thread.id);

    console.log(
      JSON.stringify(
        {
          ok: true,
          provider: session.provider,
          threadId: thread.id,
          transcriptEntries: session.transcript.length,
          browser: {
            providerBadge: "Claude Code",
            deleteConfirm: "provider-aware",
            archive: "unsupported",
          },
        },
        null,
        2
      )
    );
  } catch (error) {
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    await writeFailureArtifacts({
      scenario: "claude-local-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: { relayPort },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resumeFirstReadableClaudeThread(relayPort, threads) {
  for (const thread of threads.slice(0, 16)) {
    try {
      const payload = await postEnvelope(relayPort, "/api/session/resume", {
        thread_id: thread.id,
        device_id: "browser-claude-local-e2e",
      });
      const transcript = payload.data?.transcript || [];
      if (payload.ok && transcript.length) {
        return {
          thread,
          session: payload.data,
        };
      }
    } catch {
      // Try another local Claude Code session; stale sessions can be unreadable.
    }
  }
  return null;
}

function hasMissingClaudeNativeBinary(session) {
  return (session.logs || []).some((entry) =>
    /Claude Code native binary not found/i.test(entry?.message || "")
  );
}

async function fetchEnvelope(relayPort, pathName) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`);
  return response.json();
}

async function postEnvelope(relayPort, pathName, body = undefined) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathName}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

function cssEscapeForSelector(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
