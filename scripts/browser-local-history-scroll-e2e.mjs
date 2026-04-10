import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";
import { deleteThreadAndWait } from "./e2e-thread-cleanup.mjs";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-scroll-e2e-"));
  const statePath = path.join(stateDir, "session.json");

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
  const threadIds = [];

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: {
        width: 2048,
        height: 1180,
      },
    });
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    const deviceId = await page.evaluate(() =>
      window.localStorage.getItem("agent-relay.device-id")
    );
    assert.ok(deviceId, "page should persist a local device id");

    for (let index = 0; index < 10; index += 1) {
      threadIds.push(
        await startThread(relayPort, {
          cwd: ROOT,
          deviceId,
          initialPrompt: `history-scroll-${index}`,
        })
      );
    }

    const activeThreadId = threadIds.at(-1);
    assert.ok(activeThreadId, "scroll e2e should create an active thread");

    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${activeThreadId}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () =>
        document.querySelector(".app-shell")?.dataset.view === "conversation" &&
        document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    await page.waitForFunction(() => {
      const list = document.querySelector("#threads-list");
      const items = document.querySelectorAll("#threads-list [data-thread-id]");
      return Boolean(list && items.length >= 10 && list.scrollHeight > list.clientHeight);
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const initialMetrics = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing");
      }

      const before = list.scrollTop;
      list.scrollTop = 480;
      list.dispatchEvent(new Event("scroll"));

      return {
        before,
        after: list.scrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
        renderedHeight: getComputedStyle(list).height,
      };
    });

    assert.equal(initialMetrics.overflowY, "auto", "thread history should remain an overflow container");
    assert(
      initialMetrics.scrollHeight > initialMetrics.clientHeight,
      `thread history should overflow in thread mode (client=${initialMetrics.clientHeight}, scroll=${initialMetrics.scrollHeight})`
    );
    assert(
      initialMetrics.after > initialMetrics.before,
      `thread history should be programmatically scrollable (before=${initialMetrics.before}, after=${initialMetrics.after})`
    );

    const targetThreadId = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        return null;
      }

      const listRect = list.getBoundingClientRect();
      const buttons = [...list.querySelectorAll("[data-thread-id]")];
      const candidate = buttons.find((button) => {
        const rect = button.getBoundingClientRect();
        return (
          !button.classList.contains("is-active") &&
          rect.top >= listRect.top &&
          rect.bottom <= listRect.bottom
        );
      });

      return candidate?.dataset.threadId || null;
    });

    assert.ok(targetThreadId, "scroll e2e should find a visible thread to switch to");
    await page.evaluate((threadId) => {
      const button = document.querySelector(`#threads-list [data-thread-id="${threadId}"]`);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`missing thread button ${threadId}`);
      }
      button.click();
    }, targetThreadId);

    await page.waitForFunction(
      (expectedThreadId) => {
        const activeButton = document.querySelector(
          `#threads-list [data-thread-id="${expectedThreadId}"]`
        );
        return (
          window.location.search.includes(expectedThreadId) &&
          activeButton?.classList.contains("is-active")
        );
      },
      targetThreadId,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    const postSwitchMetrics = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing after switch");
      }

      return {
        scrollTop: list.scrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
      };
    });

    assert(
      postSwitchMetrics.scrollHeight > postSwitchMetrics.clientHeight,
      `thread list should remain scrollable after switching threads (client=${postSwitchMetrics.clientHeight}, scroll=${postSwitchMetrics.scrollHeight})`
    );
    assert.equal(
      postSwitchMetrics.overflowY,
      "auto",
      "thread list should stay an overflow container after switching threads"
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          activeThreadId,
          targetThreadId,
          initialMetrics,
          postSwitchMetrics,
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
    for (const threadId of threadIds.reverse()) {
      await deleteThreadAndWait(relayPort, threadId, { cwd: ROOT }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete scroll e2e thread ${threadId}: ${error.message}`
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

async function startThread(relayPort, { cwd, deviceId, initialPrompt }) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cwd,
      device_id: deviceId,
      initial_prompt: initialPrompt,
      approval_policy: "never",
      sandbox: "workspace-write",
      effort: "medium",
    }),
  });

  const payload = await response.json();
  assert.equal(response.status, 200, `failed to start thread ${initialPrompt}`);
  assert.equal(payload?.ok, true, `thread start payload should succeed for ${initialPrompt}`);
  assert.ok(payload?.data?.active_thread_id, `thread id missing for ${initialPrompt}`);
  return payload.data.active_thread_id;
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
  try {
    console.error(
      await page.evaluate(() => {
        const list = document.querySelector("#threads-list");
        return JSON.stringify(
          {
            appView: document.querySelector(".app-shell")?.dataset.view || null,
            chatView: document.querySelector(".chat-shell")?.dataset.view || null,
            listClientHeight: list?.clientHeight || 0,
            listScrollHeight: list?.scrollHeight || 0,
            listScrollTop: list?.scrollTop || 0,
            listOverflowY: list ? getComputedStyle(list).overflowY : null,
          },
          null,
          2
        );
      })
    );
  } catch {}
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
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to acquire an ephemeral port")));
        return;
      }
      const { port } = address;
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
