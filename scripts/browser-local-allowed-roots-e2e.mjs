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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-roots-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const outsideWorkspace = path.join(stateDir, "outside-project");
  await fs.mkdir(outsideWorkspace, { recursive: true });
  const normalizedOutsideWorkspace = await fs.realpath(outsideWorkspace);

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
  let outsideThreadId = null;
  let insideThreadId = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.fill("#cwd-input", outsideWorkspace);
    await page.click("#start-session-button");

    await page.waitForFunction(() => {
      const transcript = document.querySelector("#transcript")?.textContent || "";
      return transcript.includes("Session ready");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const bootstrapPrompt = "Reply with exactly: allowed-roots-bootstrap";
    await page.fill("#message-input", bootstrapPrompt);
    await page.click("#send-button");
    await page.waitForFunction(
      (expected) => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return transcript.includes(expected);
      },
      "allowed-roots-bootstrap",
      { timeout: LOCAL_TIMEOUT_MS }
    );

    let relaySession = await fetchSession(relayPort);
    outsideThreadId = relaySession.active_thread_id;
    assert.equal(
      relaySession.current_cwd,
      normalizedOutsideWorkspace,
      "outside session should start before restrictions are configured"
    );

    await page.click("#open-security-header");
    await page.fill("#allowed-roots-input", toTildePath(ROOT));
    await page.click("#save-allowed-roots-button");

    await page.waitForFunction(
      (expectedRoot) => {
        const summary = document.querySelector("#allowed-roots-summary")?.textContent || "";
        const list = document.querySelector("#allowed-roots-list")?.textContent || "";
        return summary.includes("limited") && list.includes(expectedRoot);
      },
      ROOT,
      { timeout: LOCAL_TIMEOUT_MS }
    );
    await page.click("#close-security-modal");

    await page.waitForFunction(() => {
      const log = document.querySelector("#client-log")?.textContent || "";
      return log.includes("outside the configured allowed roots");
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const messageInput = page.locator("#message-input");
    await messageInput.fill("This should be blocked");
    await page.click("#send-button");

    await waitForLogLine(
      page,
      `Prompt failed: workspace ${normalizedOutsideWorkspace} is outside this relay's allowed roots`
    );

    const resumePayload = await page.evaluate(async (threadId) => {
      const deviceId = window.localStorage.getItem("agent-relay.device-id");
      const response = await fetch("/api/session/resume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          thread_id: threadId,
          device_id: deviceId,
        }),
      });
      return {
        status: response.status,
        payload: await response.json(),
      };
    }, outsideThreadId);

    assert.equal(resumePayload.status, 400, "resume outside allowed roots should be rejected");
    assert.match(
      resumePayload.payload?.error?.message || "",
      /outside this relay's allowed roots/i,
      "resume rejection should mention allowed roots"
    );

    await page.click("#go-console-home");
    await page.waitForFunction(() => {
      const input = document.querySelector("#cwd-input");
      return Boolean(input && input.offsetParent !== null);
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    await page.fill("#cwd-input", outsideWorkspace);
    await page.click("#start-session-button");
    await waitForLogLine(
      page,
      `Session start failed: workspace ${normalizedOutsideWorkspace} is outside this relay's allowed roots`
    );

    await page.fill("#cwd-input", toTildePath(ROOT));
    await page.click("#start-session-button");

    await page.waitForFunction(
      (expectedWorkspace) => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        const title = document.querySelector("#workspace-title")?.textContent || "";
        return transcript.includes("Session ready") && title.includes(expectedWorkspace);
      },
      path.basename(ROOT),
      { timeout: LOCAL_TIMEOUT_MS }
    );

    relaySession = await fetchSession(relayPort);
    insideThreadId = relaySession.active_thread_id;
    assert.equal(relaySession.current_cwd, ROOT, "allowed workspace should still start successfully");
    assert.notEqual(
      insideThreadId,
      outsideThreadId,
      "starting inside an allowed root should create a new active thread"
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          outsideWorkspace,
          normalizedOutsideWorkspace,
          allowedRoot: ROOT,
          blockedThreadId: outsideThreadId,
          allowedThreadId: insideThreadId,
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
    if (insideThreadId || outsideThreadId) {
      await fetch(`http://127.0.0.1:${relayPort}/api/allowed-roots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          allowed_roots: [],
        }),
      }).catch(() => {});
    }
    if (insideThreadId) {
      await deleteThreadAndWait(relayPort, insideThreadId, { cwd: ROOT }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete allowed-roots e2e thread ${insideThreadId}: ${error.message}`
          );
        }
      });
    }
    if (outsideThreadId) {
      await deleteThreadAndWait(relayPort, outsideThreadId, {
        cwd: normalizedOutsideWorkspace,
      }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete blocked allowed-roots e2e thread ${outsideThreadId}: ${error.message}`
          );
        }
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

async function waitForLogLine(page, text) {
  await page.waitForFunction(
    (expected) => {
      const log = document.querySelector("#client-log")?.textContent || "";
      return log.includes(expected);
    },
    text,
    { timeout: LOCAL_TIMEOUT_MS }
  );
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
  throw new Error(`timed out waiting for ${url}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
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
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
