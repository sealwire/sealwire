// Regression: ONE edited file must draw ONE card.
//
// The Claude worker reports a change's `path` ABSOLUTE (that is how the relay tells which
// worktree a thread has been writing in) while the patch header inside its diff is
// repo-RELATIVE (what `git apply` requires). Those two spellings only meet at the far end
// of the pipeline: the relay strips diff bodies out of the snapshot, and the entry-detail
// endpoint hands them back with the body moved onto `tool.diff`
// (`externalize_nested_file_change_diffs`) and the per-change body cleared. The renderer
// then saw an absolute path carrying no diff beside a relative path carrying the real one,
// matched them by exact string, and drew a card for each — two stacked cards for one edit,
// the first with no +/− counts.
//
// The invariant is unit-tested in frontend/transcript-react.test.mjs; this drives the whole
// path (snapshot strip → detail fetch → render) in a real browser, because that round trip
// is what puts the two spellings in the same list.
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
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);
const TURN_ID = "turn-file-diff-cards";
const THREAD_ID = "thread-file-diff-cards";
const EDIT_ITEM_ID = "tool:edit-cards";
const TEST_FILE = "package-lock.json";

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-diff-cards-state-"));
  const statePath = path.join(stateDir, "session.json");
  const seedPath = path.join(stateDir, "fake-transcript-seed.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-diff-cards-workspace-"))
  );
  const absolutePath = path.join(workspaceDir, TEST_FILE);

  // The patch header is repo-relative while the change's `path` is absolute — exactly what
  // claude-worker's fileChangeTool emits (see claude-worker/file-diff.mjs).
  const diff = [
    `diff --git a/${TEST_FILE} b/${TEST_FILE}`,
    `--- a/${TEST_FILE}`,
    `+++ b/${TEST_FILE}`,
    "@@ -1,3 +1,3 @@",
    " {",
    '-  "lockfileVersion": 3,',
    '+  "lockfileVersion": 4,',
    " }",
    "",
  ].join("\n");

  await runCommand("git", ["init"], { cwd: workspaceDir });
  await fs.writeFile(absolutePath, '{\n  "lockfileVersion": 4,\n}\n', "utf8");
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
      "seed file diff cards fixture",
    ],
    { cwd: workspaceDir }
  );

  await writeSeedState(statePath, workspaceDir);
  await writeSeedTranscript(seedPath, absolutePath, diff);

  const relay = startLocalRelay({
    relayPort,
    relayStatePath: statePath,
    extraEnv: { AGENT_PROVIDERS: "fake", FAKE_PROVIDER_SEED_PATH: seedPath },
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
      document.querySelector(`[data-open-thread-id="${threadId}"]`)?.click();
    }, THREAD_ID);
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.dataset.view === "conversation",
      null,
      { timeout: TIMEOUT_MS }
    );

    // The edit is consolidated into a collapsed diff-group chip; expand it to reach the card.
    await page.waitForFunction(
      (itemId) =>
        Boolean(
          document.querySelector(".chat-message-diff-group .work-group-chip") ||
            document.querySelector(`[data-transcript-entry-id="${itemId}"]`)
        ),
      EDIT_ITEM_ID,
      { timeout: TIMEOUT_MS }
    );
    await page.evaluate(() => {
      const chip = document.querySelector(
        ".chat-message-diff-group .work-group-chip:not(.work-group-chip-open)"
      );
      if (chip instanceof HTMLButtonElement) {
        chip.click();
      }
    });
    await page.waitForFunction(
      (itemId) => Boolean(document.querySelector(`[data-transcript-entry-id="${itemId}"]`)),
      EDIT_ITEM_ID,
      { timeout: TIMEOUT_MS }
    );

    const chipLabel =
      (await page.textContent(".chat-message-diff-group .work-group-lead").catch(() => "")) || "";
    if (chipLabel) {
      assert.match(
        chipLabel.replace(/\s+/g, " ").trim(),
        /1 file change\b/,
        `one edited file must be counted once (chip read ${JSON.stringify(chipLabel)})`
      );
    }
    assert.equal(
      await page.locator(".diff-file-section").count(),
      1,
      "one edited file must draw exactly one file section, not one per path spelling"
    );

    // Opening the section is what fetches the detail — the response that carries the
    // relative-header patch beside the absolute path.
    await page.evaluate(() => {
      const summary = document.querySelector(".diff-file-section > summary");
      if (summary instanceof HTMLElement) {
        summary.click();
      }
    });
    // Settle on EITHER outcome so a regression reports the extra card rather than timing
    // out: the duplicate appears in the same render as the loaded body, and the body lands
    // in the OTHER section, so waiting only for diff rows would just hang.
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".diff-file-section").length > 1 ||
        document.querySelectorAll(".diff-line-add").length > 0,
      null,
      { timeout: TIMEOUT_MS }
    );

    assert.equal(
      await page.locator(".diff-file-section").count(),
      1,
      "the loaded detail must fold onto the existing section, not add a second card"
    );
    assert.ok(
      (await page.locator(".diff-line-add").count()) > 0,
      "the opened section must show the loaded diff body"
    );
    const sectionText = (await page.textContent(".diff-file-section")) || "";
    assert.match(
      sectionText,
      /lockfileVersion/,
      "the single section must carry the real diff body, not an empty placeholder"
    );
    assert.doesNotMatch(
      sectionText,
      /Diff unavailable for this file/,
      "no section may be left holding a path with no diff"
    );

    console.log(JSON.stringify({ relayPort, workspaceDir, file: TEST_FILE, sections: 1 }, null, 2));
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-file-diff-cards-e2e",
      relay,
      relayPort,
      localPage: page,
      metadata: { statePath, workspaceDir, absolutePath },
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
        model: "sonnet",
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

// A JSON array of TranscriptEntryView served by the fake provider as the resumed thread's
// transcript. One entry, shaped exactly as the Claude worker emits an edit.
async function writeSeedTranscript(seedPath, absolutePath, diff) {
  await fs.mkdir(path.dirname(seedPath), { recursive: true });
  await fs.writeFile(
    seedPath,
    JSON.stringify(
      [
        {
          item_id: EDIT_ITEM_ID,
          kind: "tool_call",
          text: null,
          status: "completed",
          turn_id: TURN_ID,
          tool: {
            item_type: "fileChange",
            name: "Edit",
            title: `Claude edited ${TEST_FILE}.`,
            detail: `Claude edited ${TEST_FILE}.`,
            query: null,
            path: absolutePath,
            url: null,
            command: null,
            input_preview: null,
            result_preview: null,
            diff,
            file_changes: [{ path: absolutePath, change_type: "modify", diff }],
          },
        },
      ],
      null,
      2
    ),
    "utf8"
  );
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
