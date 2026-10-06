// Drives the local web UI to verify that Codex-style shell commands (transcript
// kind "command", emitted running -> completed by the fake provider) fold into
// the same collapsible work-group as Claude tool calls, and that a run mixing
// commands with reasoning stays ONE chip rather than splitting per kind.
//
// Run: AGENT_PROVIDERS=fake node scripts/browser-local-command-group-e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deleteThreadsForCwdAndWait } from "./e2e-thread-cleanup.mjs";
import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import {
  attachPageDebugLogging,
  dumpBrowserState,
  launchBrowser,
} from "./e2e/harness/browser.mjs";
import { createFakeProviderScenarioHarness } from "./e2e/harness/fake-provider.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { startLocalSession } from "./e2e/harness/local-session.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 60000);
const PROMPT = "run three deterministic shell commands";
const INTERLEAVED_PROMPT = "run three commands, thinking between each";
const REPLY = "commands done";
const COMMAND_COUNT = 3;
// Each command stays "running" this long before settling. Kept generous so a
// running command is deterministically observable inline (~COUNT * DELAY of
// wall-clock) before the run collapses into the completed group.
const COMMAND_DELAY_MS = 1500;

async function main() {
  const relayPort = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-command-group-"));
  const statePath = path.join(stateDir, "sealwire.db");
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-command-group-workspace-"))
  );

  const fakeHarness = await createFakeProviderScenarioHarness(stateDir, {
    prompts: {
      [PROMPT]: {
        reply: REPLY,
        chunks: [REPLY],
        chunk_delay_ms: 5,
        tool_calls: COMMAND_COUNT,
        tool_kind: "command",
        tool_call_delay_ms: COMMAND_DELAY_MS,
      },
      [INTERLEAVED_PROMPT]: {
        reply: REPLY,
        chunks: [REPLY],
        chunk_delay_ms: 5,
        tool_calls: COMMAND_COUNT,
        tool_kind: "command",
        tool_call_delay_ms: 5,
        reasoning_between_tools: true,
      },
    },
  });

  const relay = startLocalRelay({
    relayPort,
    relayStateDb: statePath,
    extraEnv: {
      AGENT_PROVIDERS: "fake",
      ...fakeHarness.env,
    },
  });
  await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`);

  let browser;
  let context;
  let page;
  const pageErrors = [];

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 720 } },
    }));
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-command-group-e2e" });
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });

    await startLocalSession(page, {
      cwd: workspaceDir,
      approvalPolicy: "bypass",
      provider: "fake",
      model: "fake-echo",
      timeoutMs: TIMEOUT_MS,
    });

    await sendMessage(page, PROMPT);

    // 1. Running state: a still-running command renders inline as its own
    //    CommandEntry card (completed commands fold into the group and vanish
    //    from the top level, so an inline command card == a live/running one).
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-transcript-entry-kind="command"]')),
      null,
      { timeout: TIMEOUT_MS }
    );

    // 2. Completed state: all commands settle and collapse into ONE work-group
    //    chip labelled by what ran ("N commands"), with the command previews
    //    hidden while the group is collapsed.
    await page.waitForFunction(
      (count) => {
        const chip = document.querySelector(".work-group-chip");
        if (!chip) return false;
        if (!chip.textContent.includes(`${count} commands`)) return false;
        // Collapsed: members must not be mounted.
        if (document.querySelector('[data-transcript-entry-kind="command"]')) return false;
        if (document.querySelector(".chat-message-tool-run")) return false;
        return true;
      },
      COMMAND_COUNT,
      { timeout: TIMEOUT_MS }
    );

    const chips = await page.locator(".work-group-chip").count();
    assert.equal(chips, 1, "the command run must collapse into exactly one group chip");
    assert.equal(
      await page.locator(".chat-message-tool-run").count(),
      0,
      "collapsed group must not mount any command previews"
    );

    // 3. Expand the group; every command card mounts and shows its preview text.
    await page.click(".work-group-chip");
    await page.waitForFunction(
      (count) => document.querySelectorAll(".chat-message-tool-run").length === count,
      COMMAND_COUNT,
      { timeout: TIMEOUT_MS }
    );
    // Every distinct command must be present exactly once — guards against a
    // group that renders one member N times instead of the N real commands.
    const expandedText = await transcriptText(page);
    for (let n = 1; n <= COMMAND_COUNT; n += 1) {
      assert.match(
        expandedText,
        new RegExp(`fake-command-${n}(?!\\d)`),
        `expanded group must render command #${n}`
      );
    }
    assert.equal(
      await page.locator(".work-group-chip-open").count(),
      1,
      "the chip must show its open state after expanding"
    );

    // 4. Tools interleaved with reasoning still collapse into ONE chip.
    await page.click(".work-group-chip");
    await sendMessage(page, INTERLEAVED_PROMPT);
    await page.waitForFunction(
      (count) => {
        const chips = [...document.querySelectorAll(".work-group-chip")];
        return chips.some(
          (chip) =>
            chip.textContent.includes(`${count} commands`)
            && chip.textContent.includes(`${count} thoughts`)
        );
      },
      COMMAND_COUNT,
      { timeout: TIMEOUT_MS }
    );
    // By label, not by counting chips: virtualization unmounts them off-screen.
    const kindSplitChips = await page.evaluate(() =>
      [...document.querySelectorAll(".work-group-chip")]
        .map((chip) => chip.textContent.trim())
        .filter((label) => /thoughts?/.test(label) && !/commands?/.test(label))
    );
    assert.deepEqual(
      kindSplitChips,
      [],
      "reasoning must fold in with the commands, never into a chip of its own"
    );
    const interleavedChip = page
      .locator(".work-group-chip", { hasText: `${COMMAND_COUNT} thoughts` })
      .first();
    assert.equal(
      await page.locator(".work-group-chip-thinking").count(),
      1,
      "a chip holding reasoning must carry the thinking marker"
    );

    await interleavedChip.click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('.is-group-member[data-transcript-entry-kind="reasoning"]')
          .length === count,
      COMMAND_COUNT,
      { timeout: TIMEOUT_MS }
    );
    const memberKinds = await page.evaluate(() =>
      [...document.querySelectorAll(".is-group-member")].map((row) =>
        row.getAttribute("data-transcript-entry-kind")
      )
    );
    assert.ok(
      memberKinds.includes("command") && memberKinds.includes("reasoning"),
      `an expanded work group must restore both kinds, got ${memberKinds.join(",")}`
    );

    assert.deepEqual(pageErrors, [], "the command-group flow must not raise browser errors");

    console.log(
      JSON.stringify(
        { ok: true, relayPort, workspaceDir, commandCount: COMMAND_COUNT },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-command-group",
      relay,
      relayPort,
      localPage: page,
      metadata: { relayPort, statePath, workspaceDir },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    await dumpBrowserState({ localPage: page });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await deleteThreadsForCwdAndWait(relayPort, workspaceDir).catch((error) => {
      console.error(`[cleanup] failed to delete command-group threads: ${error.message}`);
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendMessage(page, text) {
  const input = page.locator("#message-input");
  await input.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await page.waitForFunction(
    () => !document.querySelector("#message-input")?.disabled,
    null,
    { timeout: TIMEOUT_MS }
  );
  await input.fill(text);
  await page.click("#send-button");
}

async function transcriptText(page) {
  return (await page.textContent("#transcript")) || "";
}

await main();
