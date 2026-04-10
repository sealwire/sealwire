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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-local-groups-e2e-"));
  const statePath = path.join(stateDir, "session.json");
  const requestedWorkspaces = {
    root: path.join(stateDir, "thread-groups-e2e-root"),
    nested: path.join(stateDir, "thread-groups-e2e-nested"),
  };
  const workspaces = {
    root: "",
    nested: "",
  };
  const threadFixtures = [];

  await fs.mkdir(requestedWorkspaces.root, { recursive: true });
  await fs.mkdir(requestedWorkspaces.nested, { recursive: true });

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

  try {
    threadFixtures.push({
      id: await startThread(relayPort, {
        cwd: requestedWorkspaces.root,
        deviceId: "thread-groups-e2e-device",
        initialPrompt: "group-root-older",
      }),
      cwd: requestedWorkspaces.root,
    });

    await delay(1100);

    threadFixtures.push({
      id: await startThread(relayPort, {
        cwd: requestedWorkspaces.nested,
        deviceId: "thread-groups-e2e-device",
        initialPrompt: "group-nested-newer",
      }),
      cwd: requestedWorkspaces.nested,
    });

    const listedThreads = await waitForThreads(relayPort, threadFixtures.map((fixture) => fixture.id));
    workspaces.root =
      listedThreads.find((thread) => thread.id === threadFixtures[0].id)?.cwd || requestedWorkspaces.root;
    workspaces.nested =
      listedThreads.find((thread) => thread.id === threadFixtures[1].id)?.cwd || requestedWorkspaces.nested;
    threadFixtures[0].cwd = workspaces.root;
    threadFixtures[1].cwd = workspaces.nested;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: {
        width: 1600,
        height: 1200,
      },
    });
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => {
      const groups = document.querySelectorAll("#threads-list .thread-group");
      return groups.length >= 2;
    }, null, { timeout: LOCAL_TIMEOUT_MS });

    const latestByWorkspace = await fetchLatestWorkspaceTimes(relayPort, [
      workspaces.root,
      workspaces.nested,
    ]);

    const grouping = await page.evaluate(() => {
      const groups = [...document.querySelectorAll("#threads-list .thread-group")];
      const cwdInput = document.querySelector("#cwd-input");

      return {
        groupLabels: groups.map((group) =>
          group.querySelector(".thread-group-name")?.textContent?.trim() || ""
        ),
        groupCwds: groups.map((group) => group.dataset.threadGroupCwd || ""),
        nestedThreadCwds: groups.map((group) =>
          [...group.querySelectorAll("[data-thread-id]")].map((button) => button.dataset.threadCwd || "")
        ),
        countText: document.querySelector("#threads-count")?.textContent?.trim() || "",
        selectedWorkspaceValue: cwdInput instanceof HTMLInputElement ? cwdInput.value : "",
      };
    });

    const rootIndex = grouping.groupCwds.indexOf(workspaces.root);
    const nestedIndex = grouping.groupCwds.indexOf(workspaces.nested);
    const expectedWorkspaceOrder = [workspaces.root, workspaces.nested].sort((left, right) => {
      const timeDiff = (latestByWorkspace.get(right) || 0) - (latestByWorkspace.get(left) || 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return path.basename(left).localeCompare(path.basename(right));
    });

    assert(rootIndex >= 0, `root workspace group should exist: ${JSON.stringify(grouping.groupCwds)}`);
    assert(nestedIndex >= 0, `nested workspace group should exist: ${JSON.stringify(grouping.groupCwds)}`);
    assert(
      grouping.groupCwds.indexOf(expectedWorkspaceOrder[0]) <
        grouping.groupCwds.indexOf(expectedWorkspaceOrder[1]),
      `workspace groups should sort by latest thread activity: ${JSON.stringify({
        expectedWorkspaceOrder,
        latestByWorkspace: Object.fromEntries(latestByWorkspace),
        rendered: grouping.groupCwds,
      })}`
    );
    assert(
      grouping.nestedThreadCwds[nestedIndex].every((cwd) => cwd === workspaces.nested),
      `nested workspace group should only contain nested threads: ${JSON.stringify(grouping.nestedThreadCwds[nestedIndex])}`
    );
    assert(
      grouping.nestedThreadCwds[rootIndex].every((cwd) => cwd === workspaces.root),
      `root workspace group should only contain root threads: ${JSON.stringify(grouping.nestedThreadCwds[rootIndex])}`
    );
    assert(
      grouping.countText.includes("folders") && grouping.countText.includes("threads"),
      `threads count should summarize grouped history: ${grouping.countText}`
    );
    assert.equal(
      grouping.selectedWorkspaceValue,
      workspaces.nested,
      "current workspace should follow the newest active session on initial load"
    );

    const rootWorkspaceSelector = `[data-select-workspace="${cssEscapeForSelector(workspaces.root)}"]`;
    await page.evaluate(({ expectedWorkspace, selector }) => {
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error(`missing workspace header for ${expectedWorkspace}`);
      }
      button.click();
    }, { expectedWorkspace: workspaces.root, selector: rootWorkspaceSelector });

    await page.waitForFunction(
      (expectedWorkspace) => {
        const input = document.querySelector("#cwd-input");
        const selectedGroup = document.querySelector(".thread-group.is-selected-workspace");
        return (
          input instanceof HTMLInputElement &&
          input.value === expectedWorkspace &&
          selectedGroup?.dataset.threadGroupCwd === expectedWorkspace
        );
      },
      workspaces.root,
      { timeout: LOCAL_TIMEOUT_MS }
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          grouping,
          selectedWorkspaceAfterClick: workspaces.root,
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
    for (const fixture of threadFixtures.reverse()) {
      await deleteThreadAndWait(relayPort, fixture.id, { cwd: fixture.cwd }).catch((error) => {
        if (!error.message.includes("not found")) {
          console.error(
            `[cleanup] failed to delete grouped thread ${fixture.id}: ${error.message}`
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

async function waitForThreads(relayPort, threadIds, timeoutMs = LOCAL_TIMEOUT_MS) {
  const pending = new Set(threadIds);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${relayPort}/api/threads?limit=200`);
    const payload = await response.json();
    assert.equal(response.status, 200, "thread list should load while waiting for grouped fixtures");
    assert.equal(payload?.ok, true, "thread list payload should succeed while waiting for grouped fixtures");

    const threads = payload.data?.threads || [];
    threads.forEach((thread) => {
      if (pending.has(thread.id)) {
        pending.delete(thread.id);
      }
    });

    if (pending.size === 0) {
      return threads;
    }

    await delay(250);
  }

  throw new Error(`timed out waiting for grouped fixture threads: ${[...pending].join(", ")}`);
}

async function fetchLatestWorkspaceTimes(relayPort, workspaces) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/threads?limit=200`);
  const payload = await response.json();
  assert.equal(response.status, 200, "thread list should load for workspace ordering checks");
  assert.equal(payload?.ok, true, "thread list payload should succeed for workspace ordering checks");

  const latestByWorkspace = new Map(workspaces.map((workspace) => [workspace, 0]));
  for (const thread of payload.data?.threads || []) {
    if (!latestByWorkspace.has(thread.cwd)) {
      continue;
    }
    latestByWorkspace.set(
      thread.cwd,
      Math.max(latestByWorkspace.get(thread.cwd) || 0, Number(thread.updated_at) || 0)
    );
  }
  return latestByWorkspace;
}

function cssEscapeForSelector(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
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

  console.error("\n[grouped thread page]");
  try {
    console.error(
      await page.evaluate(() => {
        const groups = [...document.querySelectorAll("#threads-list .thread-group")].map((group) => ({
          cwd: group.dataset.threadGroupCwd || null,
          label: group.querySelector(".thread-group-name")?.textContent?.trim() || null,
          threadCount: group.querySelectorAll("[data-thread-id]").length,
        }));

        return JSON.stringify(
          {
            appView: document.querySelector(".app-shell")?.dataset.view || null,
            selectedWorkspace:
              document.querySelector("#cwd-input") instanceof HTMLInputElement
                ? document.querySelector("#cwd-input").value
                : null,
            groups,
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
