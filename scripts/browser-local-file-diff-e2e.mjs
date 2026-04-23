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
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const FILE_CHANGE_ITEM_ID = "file-change-e2e";
const TEST_FILE = "note.txt";

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-file-diff-state-"));
  const statePath = path.join(stateDir, "session.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-file-diff-workspace-"))
  );
  const testFilePath = path.join(workspaceDir, TEST_FILE);
  const diff = [
    `diff --git a/${TEST_FILE} b/${TEST_FILE}`,
    "index 5e6d6fb..3e75765 100644",
    `--- a/${TEST_FILE}`,
    `+++ b/${TEST_FILE}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

  await fs.writeFile(testFilePath, "new\n", "utf8");
  await runCommand("git", ["init"], { cwd: workspaceDir });
  await writeSeedState(statePath, workspaceDir, diff);

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
    await page.waitForFunction(
      (itemId) => Boolean(document.querySelector(`[data-item-id="${itemId}"]`)),
      FILE_CHANGE_ITEM_ID,
      { timeout: TIMEOUT_MS }
    );

    await page.click(`[data-transcript-toggle="entry"][data-item-id="${FILE_CHANGE_ITEM_ID}"]`);
    await page.waitForFunction(
      () => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return (
          transcript.includes("Hide diff") &&
          transcript.includes("-old") &&
          transcript.includes("+new") &&
          transcript.includes("note.txt")
        );
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    assert.equal(await fs.readFile(testFilePath, "utf8"), "new\n");

    await page.click(`[data-file-change-action="rollback"][data-item-id="${FILE_CHANGE_ITEM_ID}"]`);
    await waitForFileContents(testFilePath, "old\n");
    await page.waitForFunction(
      () => (document.querySelector("#client-log")?.textContent || "").includes("File change rolled back."),
      null,
      { timeout: TIMEOUT_MS }
    );

    await page.click(`[data-file-change-action="reapply"][data-item-id="${FILE_CHANGE_ITEM_ID}"]`);
    await waitForFileContents(testFilePath, "new\n");
    await page.waitForFunction(
      () => (document.querySelector("#client-log")?.textContent || "").includes("File change reapplied."),
      null,
      { timeout: TIMEOUT_MS }
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          workspaceDir,
          file: TEST_FILE,
          finalContents: await fs.readFile(testFilePath, "utf8"),
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
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeSeedState(statePath, workspaceDir, diff) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        schema_version: 2,
        active_thread_id: "thread-file-diff-e2e",
        active_controller_device_id: null,
        active_controller_last_seen_at: null,
        current_status: "idle",
        active_flags: [],
        current_cwd: workspaceDir,
        model: "gpt-5.4",
        approval_policy: "never",
        sandbox: "workspace-write",
        reasoning_effort: "medium",
        allowed_roots: [workspaceDir],
        device_records: {},
        paired_devices: {},
        transcript: [
          {
            item_id: FILE_CHANGE_ITEM_ID,
            kind: "ToolCall",
            text: null,
            status: "completed",
            turn_id: "turn-file-diff-e2e",
            tool: {
              item_type: "fileChange",
              name: "File change",
              title: "Codex changed note.txt.",
              detail: "Target files: note.txt",
              query: null,
              path: TEST_FILE,
              url: null,
              command: null,
              input_preview: null,
              result_preview: null,
              diff,
              file_changes: [
                {
                  path: TEST_FILE,
                  change_type: "update",
                  diff,
                },
              ],
            },
          },
        ],
        logs: [],
      },
      null,
      2
    ),
    "utf8"
  );
}

async function waitForFileContents(filePath, expected, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await fs.readFile(filePath, "utf8");
      if (contents === expected) {
        return;
      }
    } catch {}
    await delay(150);
  }
  const actual = await fs.readFile(filePath, "utf8").catch((error) => String(error));
  throw new Error(`timed out waiting for ${filePath} to contain ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
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
  console.error(await safeText(page, "#transcript"));
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

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
