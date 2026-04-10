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
  let threadId = null;

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

    const startResult = await page.evaluate(
      async ({ cwd, deviceId }) => {
        const response = await fetch("/api/session/start", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cwd,
            device_id: deviceId,
            approval_policy: "never",
            sandbox: "workspace-write",
            effort: "medium",
          }),
        });

        return {
          status: response.status,
          payload: await response.json(),
        };
      },
      {
        cwd: ROOT,
        deviceId,
      }
    );

    assert.equal(startResult.status, 200, "local scroll e2e should start a session");
    assert.equal(startResult.payload?.ok, true, "session start payload should succeed");

    threadId = startResult.payload?.data?.active_thread_id || null;
    assert.ok(threadId, "session start should return an active thread id");

    await page.goto(`http://127.0.0.1:${relayPort}/?thread=${threadId}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForFunction(
      () =>
        document.querySelector(".app-shell")?.dataset.view === "conversation" &&
        document.querySelector(".chat-shell")?.dataset.view === "conversation",
      null,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    await page.evaluate(() => {
      const drawer = document.querySelector(".sidebar-drawer");
      const homeButton = document.querySelector("#go-console-home-sidebar");
      const list = document.querySelector("#threads-list");

      if (!drawer || !list) {
        throw new Error("history drawer is missing");
      }

      drawer.open = true;
      if (homeButton) {
        homeButton.hidden = false;
      }

      list.innerHTML = Array.from({ length: 40 }, (_, index) => {
        const label = `Thread ${index + 1}`;
        return `
          <button class="conversation-item${index === 0 ? " is-active" : ""}" type="button" data-thread-id="fake-${index}">
            <span class="conversation-title">${label}</span>
            <span class="conversation-preview">Preview ${label} with enough copy to wrap visually.</span>
            <span class="conversation-meta">2026-04-10 15:${String(index).padStart(2, "0")}</span>
          </button>
        `;
      }).join("");

      window.dispatchEvent(new Event("resize"));
    });

    await page.waitForFunction(() => {
      const list = document.querySelector("#threads-list");
      return Boolean(list && list.scrollHeight > list.clientHeight);
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const metrics = await page.evaluate(() => {
      const list = document.querySelector("#threads-list");
      if (!list) {
        throw new Error("thread list missing");
      }

      const before = list.scrollTop;
      list.scrollTop = 480;

      return {
        before,
        after: list.scrollTop,
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
        renderedHeight: getComputedStyle(list).height,
      };
    });

    assert.equal(metrics.overflowY, "auto", "thread history should remain an overflow container");
    assert(
      metrics.scrollHeight > metrics.clientHeight,
      `thread history should overflow in thread mode (client=${metrics.clientHeight}, scroll=${metrics.scrollHeight})`
    );
    assert(
      metrics.after > metrics.before,
      `thread history should be programmatically scrollable (before=${metrics.before}, after=${metrics.after})`
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          threadId,
          metrics,
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
    if (threadId) {
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
