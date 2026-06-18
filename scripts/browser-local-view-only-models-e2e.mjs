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

const ROOT = process.cwd();
const ACTIVE_THREAD_ID = "claude-active-thread";
const VIEWED_THREAD_ID = "codex-saved-thread";
const CLAUDE_MODELS = [
  model("default", "Default (Opus 4.8)", "anthropic", true),
  model("sonnet", "Sonnet 4.6", "anthropic"),
  model("haiku", "Haiku 4.5", "anthropic"),
];
const CODEX_MODELS = [
  model("gpt-5.5", "GPT-5.5", "codex", true),
  model("gpt-5.3-codex", "GPT-5.3 Codex", "codex"),
];

function model(name, displayName, provider, isDefault = false) {
  return {
    model: name,
    display_name: displayName,
    provider,
    supported_reasoning_efforts: ["medium", "high"],
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

async function main() {
  const port = await getFreePort();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "view-only-models-"));
  const relay = startLocalRelay({
    relayPort: port,
    relayStatePath: path.join(stateDir, "session.json"),
    extraEnv: { AGENT_PROVIDERS: "fake" },
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  let context;
  let page;

  try {
    await waitForHealth(`${base}/api/health`);
    ({ browser, context } = await launchBrowser());
    page = await context.newPage();
    attachPageDebugLogging(page, "local", { prefix: "local-view-only-models-e2e" });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route(/\/api\/session(\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      Object.assign(payload.data, {
        provider: "claude_code",
        provider_connected: true,
        active_thread_id: ACTIVE_THREAD_ID,
        active_turn_id: null,
        active_controller_device_id: null,
        current_cwd: ROOT,
        current_status: "idle",
        model: "default",
        reasoning_effort: "high",
        approval_policy: "default",
        sandbox: "workspace-write",
        available_models: CLAUDE_MODELS,
        transcript: [],
        transcript_truncated: false,
      });
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.route(/\/api\/threads(\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.data = {
        threads: [
          thread(VIEWED_THREAD_ID, "codex", "Saved Codex thread", 2),
          thread(ACTIVE_THREAD_ID, "claude_code", "Live Claude thread", 1),
        ],
      };
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.route(
      `**/api/threads/${VIEWED_THREAD_ID}/transcript**`,
      async (route) => {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: {
              thread_id: VIEWED_THREAD_ID,
              prev_cursor: null,
              revision: 0,
              entries: [
                {
                  item_id: "codex-user-1",
                  kind: "user_text",
                  text: "Open the saved Codex thread.",
                  status: "completed",
                  turn_id: "turn-1",
                  tool: null,
                },
              ],
              thread_state: {
                thread_id: VIEWED_THREAD_ID,
                provider: "codex",
                current_cwd: ROOT,
                current_status: "idle",
                active_turn_id: null,
                current_phase: null,
                current_tool: null,
                last_progress_at: null,
                model: "default",
                reasoning_effort: "medium",
                approval_policy: "never",
                sandbox: "workspace-write",
                available_models: CODEX_MODELS,
                review_locked: false,
                settings_writable: true,
              },
            },
          }),
        });
      }
    );
    await page.route("**/api/stream**", (route) => route.abort());

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-thread-id="${VIEWED_THREAD_ID}"]`, {
      state: "attached",
    });
    await page.evaluate(() => {
      document.querySelector(".sidebar-drawer")?.setAttribute("open", "");
    });
    await page.click(`[data-thread-id="${VIEWED_THREAD_ID}"]`);
    await page.waitForFunction(
      (threadId) =>
        new URL(window.location.href).searchParams.get("thread") === threadId
        && /read-only/i.test(
          document.querySelector("#workspace-subtitle")?.textContent || ""
        ),
      VIEWED_THREAD_ID
    );
    await page.waitForFunction(
      () =>
        [...(document.querySelector("#message-model")?.options || [])]
          .some((option) => option.value === "gpt-5.5")
    );

    const result = await page.evaluate(() => ({
      subtitle: document.querySelector("#workspace-subtitle")?.textContent || "",
      value: document.querySelector("#message-model")?.value || "",
      options: [...(document.querySelector("#message-model")?.options || [])]
        .map((option) => option.value),
    }));

    if (!result.options.includes("gpt-5.5")) {
      throw new Error(`Codex model catalog was not rendered: ${JSON.stringify(result)}`);
    }
    if (result.options.some((value) => ["default", "sonnet", "haiku"].includes(value))) {
      throw new Error(`Claude models leaked into the Codex view: ${JSON.stringify(result)}`);
    }
    if (pageErrors.length) {
      throw new Error(`page errors: ${pageErrors.join("; ")}`);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "local-view-only-models-e2e",
      relay,
      relayPort: port,
      localPage: page,
      metadata: {
        relayPort: port,
        activeThreadId: ACTIVE_THREAD_ID,
        viewedThreadId: VIEWED_THREAD_ID,
      },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    dumpProcessLogs(relay);
    throw error;
  } finally {
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
