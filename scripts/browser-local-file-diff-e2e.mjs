import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const FILE_CHANGE_ITEM_ID = "file-change-e2e";
const THREAD_ID = "thread-file-diff-e2e";
const TEST_FILE = "note.txt";

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

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
  });

  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;

  try {
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (threadId) => Boolean(document.querySelector(`[data-open-thread-id="${threadId}"]`)),
      THREAD_ID,
      { timeout: TIMEOUT_MS }
    );
    await page.evaluate((threadId) => {
      const button = document.querySelector(`[data-open-thread-id="${threadId}"]`);
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    }, THREAD_ID);
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForFunction(
      (itemId) => Boolean(document.querySelector(`[data-item-id="${itemId}"]`)),
      FILE_CHANGE_ITEM_ID,
      { timeout: TIMEOUT_MS }
    );

    await page.evaluate((itemId) => {
      const toggle = document.querySelector(
        `[data-transcript-toggle="entry"][data-item-id="${itemId}"]`
      );
      if (toggle instanceof HTMLElement) {
        toggle.click();
      }
    }, FILE_CHANGE_ITEM_ID);
    await page.waitForFunction(
      () => {
        const transcript = document.querySelector("#transcript")?.textContent || "";
        return (
          transcript.includes("old") &&
          transcript.includes("new") &&
          transcript.includes("note.txt")
        );
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    await assertActionButton(page, "rollback");
    await assertActionButton(page, "reapply");
    assert.equal(await fs.readFile(testFilePath, "utf8"), "new\n");

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
    await writeFailureArtifacts({
      scenario: "local-file-diff-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: {
        statePath,
        workspaceDir,
        testFilePath,
      },
    }).catch((artifactError) => {
      console.error(
        artifactError instanceof Error
          ? artifactError.stack || artifactError.message
          : String(artifactError)
      );
    });
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
        active_thread_id: THREAD_ID,
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
            kind: "tool_call",
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

async function assertActionButton(page, direction) {
  await page.waitForSelector(`[data-file-change-action="${direction}"][data-item-id="${FILE_CHANGE_ITEM_ID}"]`, {
    state: "attached",
    timeout: TIMEOUT_MS,
  });
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
