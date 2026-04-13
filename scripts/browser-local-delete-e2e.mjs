import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { fetchSession } from "./e2e-thread-cleanup.mjs";

const ROOT = process.cwd();
const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT =
  process.env.BROWSER_E2E_LOCAL_DELETE_PROMPT || "Reply with exactly: local-delete-browser-e2e";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-delete-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);

  const relay = spawnManagedProcess("relay", "cargo", ["run", "-p", "relay-server"], {
    PORT: String(relayPort),
    RELAY_STATE_PATH: statePath,
  });

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.fill("#cwd-input", cwdInput);
    await page.click("#open-launch-settings");
    await page.waitForFunction(() => {
      const modal = document.querySelector("#launch-settings-modal");
      return Boolean(modal?.open);
    });
    await page.selectOption("#approval-policy-input", "never");
    await page.click("#close-launch-settings-modal");
    await page.click("#start-session-button");

    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.includes("Session ready");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

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

    const target = page.locator(`[data-thread-id="${threadId}"]`);
    await target.waitFor({ state: "visible", timeout: LOCAL_TIMEOUT_MS });
    page.once("dialog", (dialog) => dialog.accept());
    await target.click({ button: "right" });
    await page.waitForFunction(() => {
      const menu = document.querySelector("#thread-context-menu");
      const button = document.querySelector("#delete-thread-button");
      return Boolean(menu && !menu.hidden && button && !button.disabled);
    }, null, { timeout: LOCAL_TIMEOUT_MS });
    await page.click("#delete-thread-button");

    await waitForThreadMissing(relayPort, threadId);
    await page.waitForFunction(
      (deletedThreadId) => !document.querySelector(`[data-thread-id="${deletedThreadId}"]`),
      threadId,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const relayAfterDelete = await fetchSession(relayPort);
    assert.equal(
      relayAfterDelete.active_thread_id,
      null,
      "deleting the current idle session should clear the active session"
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          cwdInput,
          deletedThreadId: threadId,
          currentStatus: relayAfterDelete.current_status,
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
  if (child._logBuffer.length > 120) {
    child._logBuffer.splice(0, child._logBuffer.length - 120);
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
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`timed out waiting for health endpoint: ${url}`);
}

async function waitForThreadMissing(relayPort, threadId, timeoutMs = LOCAL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads?cwd=${encodeURIComponent(ROOT)}`
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

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to acquire an ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
    server.on("error", reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
