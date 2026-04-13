import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { deleteThreadAndWait, fetchSession } from "./e2e-thread-cleanup.mjs";

const ROOT = process.cwd();
const LOCAL_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const PROMPT = process.env.BROWSER_E2E_LOCAL_PROMPT || "Reply with exactly: local-browser-e2e";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const cwdInput = toTildePath(ROOT);

  const relay = spawnManagedProcess(
    "relay",
    "cargo",
    ["run", "-p", "relay-server"],
    {
      PORT: String(relayPort),
      RELAY_STATE_PATH: statePath,
    }
  );

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  let createdThreadId = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    assert.match(
      (await page.textContent("#overview-session-title")) || "",
      /^(Pick a workspace(?: to launch)?|Ready in .+)$/,
      "overview should show either the empty launch prompt or the preselected workspace state"
    );
    assert.ok(
      ((await page.textContent("#overview-security-title")) || "").trim().length > 0,
      "overview should describe relay posture"
    );
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
    await page.waitForFunction(
      (expectedWorkspace) => {
        const title = document.querySelector("#workspace-title")?.textContent || "";
        const subtitle = document.querySelector("#workspace-subtitle")?.textContent || "";
        const status = document.querySelector("#status-badge")?.textContent || "";
        return (
          title.includes(expectedWorkspace) &&
          subtitle.toLowerCase().includes("live thread") &&
          status.trim().length > 0
        );
      },
      path.basename(ROOT),
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.click("#open-session-details");
    await page.waitForFunction(() => {
      const modal = document.querySelector("#session-details-modal");
      return Boolean(modal?.open);
    });
    assert.match(
      (await page.textContent("#overview-session-copy")) || "",
      /control|continue the live thread/i,
      "session details should describe the live session state"
    );
    assert.match(
      (await page.textContent("#session-meta")) || "",
      /never/i,
      "session details should reflect the selected approval policy"
    );
    await page.click("#close-session-details-modal");

    const messageInput = page.locator("#message-input");
    await assertEnabled(messageInput);
    await messageInput.fill(PROMPT);
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
    createdThreadId = relaySession.active_thread_id;

    console.log(
      JSON.stringify(
        {
          relayPort,
          cwdInput,
          activeThreadId: relaySession.active_thread_id,
          currentCwd: relaySession.current_cwd,
          lastAssistant: [...relaySession.transcript]
            .reverse()
            .find((entry) => entry.role === "assistant")?.text,
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
    if (createdThreadId) {
      await deleteThreadAndWait(relayPort, createdThreadId, { cwd: ROOT }).catch((error) => {
        console.error(
          `[cleanup] failed to delete local session e2e thread ${createdThreadId}: ${error.message}`
        );
      });
    }
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

async function assertEnabled(locator) {
  await locator.waitFor({ state: "visible", timeout: LOCAL_TIMEOUT_MS });
  const disabled = await locator.evaluate((element) => element.disabled);
  assert.equal(disabled, false, "expected locator to be enabled");
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

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address?.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

await main();
