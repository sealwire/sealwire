import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

// Opening a Codex thread and then a Claude one must never put the Codex model in
// the Claude composer, including while the Claude thread's own settings load.
// A send into a thread that is not live must carry that thread's effort, not the live one's.
const ROOT = process.cwd();
const LIVE_CLAUDE = "claude-live-thread";
const CODEX_THREAD = "codex-saved-thread";
const SAVED_CLAUDE = "claude-saved-thread";
const RELAY_GENERATION = "model-carryover-e2e-gen";
const CLAUDE_MODELS = [
  model("default", "Default (Opus 5)", true),
  model("opus[1m]", "Opus (1M context)"),
  model("sonnet", "Sonnet"),
];
const CODEX_MODELS = [
  model("gpt-6.1-sol", "GPT-6.1-Sol", true),
  model("gpt-6-astra", "GPT-6-Astra"),
];
const CODEX_MODEL_IDS = CODEX_MODELS.map((entry) => entry.model);

function model(name, displayName, isDefault = false) {
  return {
    model: name,
    display_name: displayName,
    provider: "",
    supported_reasoning_efforts: ["low", "medium", "high"],
    default_reasoning_effort: "medium",
    hidden: false,
    is_default: isDefault,
  };
}

function thread(id, provider, name, updatedAt) {
  return {
    id,
    name,
    preview: `${name} preview`,
    cwd: ROOT,
    updated_at: updatedAt,
    source: provider,
    status: "idle",
    model_provider: provider,
    provider,
  };
}

function transcriptPage(threadId, provider, modelId, effort, models) {
  return {
    ok: true,
    data: {
      thread_id: threadId,
      transcript_generation: RELAY_GENERATION,
      prev_cursor: null,
      revision: 0,
      entries: [
        {
          item_id: `${threadId}-user-1`,
          kind: "user_text",
          text: `Hello from ${threadId}`,
          status: "completed",
          turn_id: "turn-1",
          tool: null,
        },
      ],
      thread_state: {
        thread_id: threadId,
        provider,
        current_cwd: ROOT,
        current_status: "idle",
        active_turn_id: null,
        current_phase: null,
        current_tool: null,
        last_progress_at: null,
        model: modelId,
        reasoning_effort: effort,
        approval_policy: "never",
        sandbox: "workspace-write",
        available_models: models,
        review_locked: false,
        settings_writable: true,
      },
    },
  };
}

async function composerModel(page) {
  return page.evaluate(() => ({
    value: document.querySelector("#message-model")?.value || "",
    options: [...(document.querySelector("#message-model")?.options || [])].map(
      (option) => option.value
    ),
    chip: document.querySelector("#composer-model-mount")?.textContent || "",
  }));
}

function assertNoCodexModel(label, snapshot) {
  const leaked = snapshot.options.filter((value) => CODEX_MODEL_IDS.includes(value));
  if (leaked.length || /6\.1|Sol/i.test(snapshot.chip)) {
    throw new Error(`${label}: Codex model shown in a Claude composer: ${JSON.stringify(snapshot)}`);
  }
}

async function sendAndCapture(page, sends, text) {
  const before = sends.length;
  await page.fill("#message-input", text);
  await page.evaluate(() => document.querySelector("#message-form")?.requestSubmit());
  const deadline = Date.now() + 5000;
  while (sends.length === before && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
  if (sends.length === before) throw new Error(`send "${text}" never reached the relay`);
  return sends.at(-1);
}

function assertSent(label, body, expected) {
  const got = { thread_id: body.thread_id, model: body.model ?? "", effort: body.effort ?? "" };
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`${label}: sent ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}

async function openThread(page, threadId) {
  await page.evaluate(() => {
    document.querySelector(".sidebar-drawer")?.setAttribute("open", "");
  });
  await page.click(`[data-thread-id="${threadId}"]`);
  await page.waitForFunction(
    (id) => new URL(window.location.href).searchParams.get("thread") === id,
    threadId
  );
}

async function main() {
  const port = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-carryover-"));
  const relay = startLocalRelay({
    relayPort: port,
    relayStateDb: path.join(stateDir, "sealwire.db"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  let context;
  let page;
  let releaseSavedClaude;
  const savedClaudeHeld = new Promise((resolve) => {
    releaseSavedClaude = resolve;
  });

  try {
    await waitForHealth(`${base}/api/health`);
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-model-carryover-e2e" });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route(/\/api\/providers(\?|$)/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: ["claude_code", "codex"] }),
      })
    );
    await page.route(/\/api\/providers\/[^/]+\/models/, (route) => {
      const provider = new URL(route.request().url()).pathname.split("/")[3];
      const data = provider === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data }),
      });
    });
    await page.route(/\/api\/session(\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      Object.assign(payload.data, {
        provider: "claude_code",
        provider_connected: true,
        active_thread_id: LIVE_CLAUDE,
        active_turn_id: null,
        active_controller_device_id: null,
        current_cwd: ROOT,
        current_status: "idle",
        model: "opus[1m]",
        reasoning_effort: "high",
        approval_policy: "never",
        sandbox: "workspace-write",
        available_models: CLAUDE_MODELS,
        transcript: [],
        transcript_truncated: false,
        transcript_generation: RELAY_GENERATION,
      });
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.route(/\/api\/threads(\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.data = {
        threads: [
          thread(CODEX_THREAD, "codex", "Saved Codex thread", 3),
          thread(SAVED_CLAUDE, "claude_code", "Saved Claude thread", 2),
          thread(LIVE_CLAUDE, "claude_code", "Live Claude thread", 1),
        ],
      };
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.route(`**/api/threads/${CODEX_THREAD}/transcript**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(transcriptPage(CODEX_THREAD, "codex", "gpt-6.1-sol", "medium", CODEX_MODELS)),
      })
    );
    await page.route(`**/api/threads/${SAVED_CLAUDE}/transcript**`, async (route) => {
      await savedClaudeHeld;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          transcriptPage(SAVED_CLAUDE, "claude_code", "opus[1m]", "low", CLAUDE_MODELS)
        ),
      });
    });
    const sends = [];
    await page.route("**/api/session/message", (route) => {
      sends.push(JSON.parse(route.request().postData() || "{}"));
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "captured by e2e" }),
      });
    });
    await page.route("**/api/stream**", (route) => route.abort());

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-thread-id="${CODEX_THREAD}"]`, { state: "attached" });

    await openThread(page, CODEX_THREAD);
    await page.waitForFunction(
      () => document.querySelector("#message-model")?.value === "gpt-6.1-sol"
    );

    // The saved Claude thread's page is held, so its own model is not known yet.
    await openThread(page, SAVED_CLAUDE);
    await page.waitForTimeout(400);
    const whileLoading = await composerModel(page);
    assertNoCodexModel("saved Claude thread while loading", whileLoading);
    // Its own settings are unknown yet, so the relay must be left to use them.
    assertSent("send while loading", await sendAndCapture(page, sends, "while loading"), {
      thread_id: SAVED_CLAUDE,
      model: "",
      effort: "",
    });

    releaseSavedClaude();
    await page.waitForFunction(
      () => document.querySelector("#message-model")?.value === "opus[1m]"
    );
    assertNoCodexModel("saved Claude thread after load", await composerModel(page));
    assertSent("send after load", await sendAndCapture(page, sends, "after load"), {
      thread_id: SAVED_CLAUDE,
      model: "opus[1m]",
      effort: "low",
    });

    await openThread(page, CODEX_THREAD);
    await page.waitForFunction(
      () => document.querySelector("#message-model")?.value === "gpt-6.1-sol"
    );
    await openThread(page, LIVE_CLAUDE);
    await page.waitForFunction(
      () => document.querySelector("#message-model")?.value === "opus[1m]"
    );
    assertNoCodexModel("live Claude thread", await composerModel(page));

    if (pageErrors.length) {
      throw new Error(`page errors: ${pageErrors.join("; ")}`);
    }
    console.log("model carryover e2e passed");
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-model-carryover-e2e",
      relay,
      relayPort: port,
      localPage: page,
      metadata: { relayPort: port },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    dumpProcessLogs(relay);
    throw error;
  } finally {
    releaseSavedClaude?.();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
