// A deep file path must give up its DIRECTORY, never its basename.
//
// The transcript used to render a file-change header as one flat string with
// `text-overflow: ellipsis`, which clips from the END — so on a narrow screen
// the part being scanned for, the filename, was the first thing to disappear
// ("crates/relay-server/src/state/relay/appro…"). The workspace-diff rail had
// already solved this by splitting the path and letting the two halves shrink
// at different rates; the transcript now uses the same treatment.
//
// WHY THIS IS A BROWSER TEST. The unit test in frontend/shared/diff-file-name.test.mjs
// server-renders the markup and can prove the two spans exist. It cannot prove
// the thing that actually matters, because that is a layout outcome: which half
// gives way when the row runs out of room. `.diff-file-dir` and
// `.diff-file-base` carry `flex: 0 1000 auto` / `flex: 0 1 auto` (styles.css),
// and those shrink factors only mean anything once a real engine lays the row
// out inside a real width. A CSS-declaration assertion would pass just as
// happily with the factors swapped, which is the exact failure this guards.
//
// The fixture is seeded rather than driven through a provider: the fake
// provider does not emit fileChange entries, and the assertion is about
// rendering a path, not about how the path arrived.
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
const TURN_ID = "turn-file-diff-path";
const THREAD_ID = "thread-file-diff-path";
const EDIT_ITEM_ID = "tool:edit-deep-path";

// Deep enough that the directory cannot fit a phone, with a basename long
// enough that clipping it would be unmistakable.
const REL_DIR = "crates/relay-server/src/state/relay/approval";
const BASENAME = "rotation_grace_window.rs";
const TEST_FILE = `${REL_DIR}/${BASENAME}`;

// Phone width. The transcript column is released to the viewport below 900px
// (conversation.css), which is what puts the header under pressure.
const PHONE = { width: 390, height: 780 };
const DESKTOP = { width: 1400, height: 900 };

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-diff-path-state-"));
  const statePath = path.join(stateDir, "session.json");
  const seedPath = path.join(stateDir, "fake-transcript-seed.json");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-diff-path-workspace-"))
  );
  const absolutePath = path.join(workspaceDir, TEST_FILE);

  const diff = [
    `diff --git a/${TEST_FILE} b/${TEST_FILE}`,
    `--- a/${TEST_FILE}`,
    `+++ b/${TEST_FILE}`,
    "@@ -1,2 +1,3 @@",
    " fn rotation_grace_window() -> Duration {",
    "+    Duration::from_secs(90)",
    " }",
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, "fn rotation_grace_window() -> Duration {\n}\n", "utf8");
  await runCommand("git", ["init"], { cwd: workspaceDir });
  await runCommand("git", ["add", "-A"], { cwd: workspaceDir });
  await runCommand(
    "git",
    [
      "-c",
      "user.name=Agent Relay E2E",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "-m",
      "seed deep path fixture",
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
    await page.setViewportSize(DESKTOP);

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

    // The edit lands folded into a collapsed diff-group chip; open it.
    await page.waitForFunction(
      (itemId) =>
        Boolean(
          document.querySelector(".diff-group-chip") ||
            document.querySelector(`[data-transcript-entry-id="${itemId}"]`)
        ),
      EDIT_ITEM_ID,
      { timeout: TIMEOUT_MS }
    );
    await page.evaluate(() => {
      const chip = document.querySelector(".diff-group-chip:not(.diff-group-chip-open)");
      if (chip instanceof HTMLButtonElement) {
        chip.click();
      }
    });
    await page.waitForSelector("#transcript .diff-file-name", { timeout: TIMEOUT_MS });

    // 1. The path is rendered as two addressable halves, not one string.
    const parts = await readParts(page);
    assert.equal(
      parts.dirText,
      `${REL_DIR}/`,
      "the directory half must keep its trailing slash so the two halves read as one path"
    );
    assert.equal(parts.baseText, BASENAME, "the basename must be its own element");

    // 2. The directory is de-emphasised. Colour, not weight — matching the rail.
    assert.notEqual(
      parts.dirColor,
      parts.baseColor,
      "the directory must be visually quieter than the basename, or splitting them buys nothing"
    );

    // 3. With room, nothing is clipped.
    assert.equal(parts.dirTruncated, false, "a wide transcript should show the whole path");
    assert.equal(parts.baseTruncated, false, "a wide transcript should show the whole path");

    // 4. THE POINT. Squeezed to a phone, the directory gives way and the
    //    basename survives intact.
    await page.setViewportSize(PHONE);
    await page.waitForFunction(
      () => {
        const dir = document.querySelector("#transcript .diff-file-dir");
        return Boolean(dir) && dir.scrollWidth > dir.clientWidth + 1;
      },
      null,
      { timeout: TIMEOUT_MS }
    );
    const narrow = await readParts(page);

    assert.equal(
      narrow.dirTruncated,
      true,
      "on a phone the directory must be the half that gives up space"
    );
    assert.equal(
      narrow.baseTruncated,
      false,
      `the basename must stay whole on a phone — it is what the reader is looking for `
        + `(basename showed ${narrow.baseVisibleWidth}px of ${narrow.baseFullWidth}px)`
    );
    assert.ok(
      narrow.dirVisibleWidth < parts.dirVisibleWidth,
      "the directory should actually have shrunk, not merely reported truncation"
    );

    console.log(
      JSON.stringify(
        {
          relayPort,
          file: TEST_FILE,
          desktop: { dir: parts.dirVisibleWidth, base: parts.baseVisibleWidth },
          phone: { dir: narrow.dirVisibleWidth, base: narrow.baseVisibleWidth },
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-file-diff-path-e2e",
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

// Scoped to #transcript: the workspace-diff rail uses the same class names, and
// picking up its header instead would make this pass while the transcript — the
// surface actually under test — regressed.
async function readParts(page) {
  return page.evaluate(() => {
    const dir = document.querySelector("#transcript .diff-file-dir");
    const base = document.querySelector("#transcript .diff-file-base");
    if (!dir || !base) {
      throw new Error("expected a split file header in the transcript");
    }
    // +1px of slack: sub-pixel text metrics make scrollWidth exceed clientWidth
    // by a fraction on rows that are not actually clipped.
    const clipped = (el) => el.scrollWidth > el.clientWidth + 1;
    return {
      dirText: dir.textContent,
      baseText: base.textContent,
      dirColor: getComputedStyle(dir).color,
      baseColor: getComputedStyle(base).color,
      dirTruncated: clipped(dir),
      baseTruncated: clipped(base),
      dirVisibleWidth: Math.round(dir.clientWidth),
      baseVisibleWidth: Math.round(base.clientWidth),
      baseFullWidth: Math.round(base.scrollWidth),
    };
  });
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
