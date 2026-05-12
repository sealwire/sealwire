import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const ROOT = process.cwd();
const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const managedProcesses = [];

process.on("exit", () => {
  for (const child of managedProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
});

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-browser-claude-e2e-"));
  const statePath = path.join(stateDir, "session.json");

  const relay = spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], {
    AGENT_PROVIDERS: "claude_code",
    PORT: String(relayPort),
    RELAY_STATE_PATH: statePath,
  });

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;

  try {
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

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000,
      },
    });
    page = await context.newPage();

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

    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.trim().length > 0 && !transcript.includes("No transcript");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const providerDotLabel = await renderedThread
      .locator(".conversation-provider-dot")
      .first()
      .getAttribute("aria-label");
    assert.equal(providerDotLabel, "Claude Code");

    await page.click("#open-session-details");
    await page.waitForFunction(() => {
      const modal = document.querySelector("#session-details-modal");
      const meta = document.querySelector("#session-meta")?.textContent || "";
      return Boolean(modal?.open) && meta.includes("Claude Code");
    }, null, { timeout: LOCAL_TIMEOUT_MS });
    await page.click("#close-session-details-modal");

    page.once("dialog", (dialog) => {
      assert.match(dialog.message(), /Claude Code storage/);
      dialog.dismiss();
    });
    await renderedThread.click({ button: "right" });
    await page.waitForFunction(() => {
      const menu = document.querySelector("#thread-context-menu");
      const button = document.querySelector("#delete-thread-button");
      return Boolean(menu && !menu.hidden && button && !button.disabled);
    }, null, { timeout: LOCAL_TIMEOUT_MS });
    await page.click("#delete-thread-button");

    page.once("dialog", (dialog) => dialog.accept());
    await renderedThread.click({ button: "right" });
    await page.waitForFunction(() => {
      const menu = document.querySelector("#thread-context-menu");
      const button = document.querySelector("#archive-thread-button");
      return Boolean(menu && !menu.hidden && button && !button.disabled);
    }, null, { timeout: LOCAL_TIMEOUT_MS });
    await page.click("#archive-thread-button");
    await page.waitForFunction(() => {
      const log = document.querySelector("#client-log")?.textContent || "";
      return /Failed to archive local session: .*archive is not supported/i.test(log);
    }, null, { timeout: LOCAL_TIMEOUT_MS });

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
    await dumpBrowserState(page);
    dumpProcessLogs(relay);
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
  if (child._logBuffer.length > 160) {
    child._logBuffer.splice(0, child._logBuffer.length - 160);
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

async function dumpBrowserState(page) {
  if (!page) {
    return;
  }
  console.error("\n[local page]");
  console.error(await safeText(page, "#client-log"));
  console.error(await safeText(page, "#transcript"));
}

async function safeText(page, selector) {
  try {
    return (await page.textContent(selector)) || "";
  } catch {
    return "";
  }
}

async function waitForHealth(url, timeoutMs = LOCAL_TIMEOUT_MS) {
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

function cssEscapeForSelector(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
