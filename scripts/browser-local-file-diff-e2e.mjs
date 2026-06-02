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
const TURN_ID = "turn-file-diff-e2e";
const TURN_DIFF_ITEM_ID = `turn-diff:${TURN_ID}`;
const THREAD_ID = "thread-file-diff-e2e";
const TEST_FILE = "note.txt";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-file-diff-state-"));
  const statePath = path.join(stateDir, "session.json");
  const seedPath = path.join(stateDir, "fake-transcript-seed.json");
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

  await runCommand("git", ["init"], { cwd: workspaceDir });
  await fs.writeFile(testFilePath, "old\n", "utf8");
  await runCommand("git", ["add", TEST_FILE], { cwd: workspaceDir });
  await runCommand(
    "git",
    [
      "-c",
      "user.name=Agent Relay E2E",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "-m",
      "seed file diff fixture",
    ],
    { cwd: workspaceDir }
  );
  await fs.writeFile(testFilePath, "new\n", "utf8");
  await writeSeedState(statePath, workspaceDir);
  await writeSeedTranscript(seedPath, diff);

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    // Transcript history is no longer persisted in relay state (it is restored
    // from the provider on resume). The fake provider has no real session
    // store, so we hand it the seeded turnDiff transcript via this fixture file.
    extraEnv: { FAKE_PROVIDER_SEED_PATH: seedPath },
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
      (itemId) => Boolean(document.querySelector(`[data-transcript-entry-id="${itemId}"]`)),
      TURN_DIFF_ITEM_ID,
      { timeout: TIMEOUT_MS }
    );

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
    await clickActionButton(page, "rollback");
    await waitForFileContents(testFilePath, "old\n");

    await assertActionButton(page, "reapply");
    await clickActionButton(page, "reapply");
    await waitForFileContents(testFilePath, "new\n");
    await assertActionButton(page, "rollback");
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

async function writeSeedState(statePath, workspaceDir) {
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
      },
      null,
      2
    ),
    "utf8"
  );
}

// Transcript history is no longer persisted in relay state. The fake provider
// reads this fixture (a JSON array of TranscriptEntryView) from
// FAKE_PROVIDER_SEED_PATH and serves it as the resumed thread's transcript, so
// the turnDiff entry renders without depending on relay-state persistence.
async function writeSeedTranscript(seedPath, diff) {
  await fs.mkdir(path.dirname(seedPath), { recursive: true });
  await fs.writeFile(
    seedPath,
    JSON.stringify(
      [
        {
          item_id: TURN_DIFF_ITEM_ID,
          kind: "tool_call",
          text: null,
          status: "completed",
          turn_id: TURN_ID,
          tool: {
            item_type: "turnDiff",
            name: "File summary",
            title: "Codex changed note.txt in this turn.",
            detail: "Target files: note.txt",
            query: null,
            path: TEST_FILE,
            url: null,
            command: null,
            input_preview: "Files:\nnote.txt",
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
      null,
      2
    ),
    "utf8"
  );
}

async function assertActionButton(page, direction) {
  await page.waitForSelector(actionButtonSelector(direction), {
    state: "attached",
    timeout: TIMEOUT_MS,
  });
}

async function clickActionButton(page, direction) {
  await assertActionButton(page, direction);
  await page.click(actionButtonSelector(direction));
}

function actionButtonSelector(direction) {
  return `[data-file-change-action="${direction}"][data-item-id="${TURN_DIFF_ITEM_ID}"]`;
}

async function waitForFileContents(filePath, expected) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastContents = null;
  while (Date.now() < deadline) {
    lastContents = await fs.readFile(filePath, "utf8");
    if (lastContents === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(lastContents, expected);
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
