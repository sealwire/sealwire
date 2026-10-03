// Opening the model picker must show the model already chosen, without the user
// scrolling for it: in the New session dialog's models panel and in a thread's
// composer, for a model low in the list and for one folded under Other models.
//
// Serves the frontend through Vite and answers every API call in the page, so no
// relay runs; an unrouted call fails closed rather than reaching one on 8787.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  spawnManagedProcess,
  stopManagedProcess,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = 30_000;
const THREAD_ID = "thread-picker-selected";

// Three releases on show (6.1, 6, 5.6) make a list taller than the panel; 5.5 and
// older fold under Other models.
const CODEX_MODELS = [
  ...["sol", "sol-fast"].map((name) => `gpt-6.1-${name}`),
  ...["astra", "astra-fast", "astra-ultrafast", "luna", "luna-fast", "sol", "sol-fast", "terra", "terra-fast", "nova"].map(
    (name) => `gpt-6-${name}`
  ),
  ...["sol", "sol-fast", "terra", "terra-fast", "luna", "luna-fast", "nova", "nova-fast"].map(
    (name) => `gpt-5.6-${name}`
  ),
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
].map((model, index) => ({
  default_reasoning_effort: "medium",
  display_name: model.toUpperCase(),
  hidden: false,
  is_default: index === 0,
  model,
  supported_reasoning_efforts: ["medium", "high"],
}));
const CLAUDE_MODELS = [
  { display_name: "Opus 5.5", is_default: true, model: "opus" },
  { display_name: "Sonnet 5", model: "sonnet" },
];

const LOW = "gpt-5.6-nova-fast";
const FOLDED = "gpt-5.2";

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[model-picker-selected-visible-e2e] ${message}${suffix}`);
}

function sessionSnapshot(model) {
  return {
    active_controller_device_id: null,
    active_thread_id: THREAD_ID,
    active_turn_id: null,
    allowed_roots: [ROOT],
    approval_policy: "never",
    available_models: CODEX_MODELS,
    beta_features_enabled: false,
    current_cwd: ROOT,
    current_status: "idle",
    device_records: [],
    logs: [],
    model,
    paired_devices: [],
    pending_approvals: [],
    pending_ask_user_questions: [],
    pending_pairing_requests: [],
    provider: "codex",
    provider_connected: true,
    provider_status: [{ connected: true, provider: "codex", status: "connected" }],
    reasoning_effort: "medium",
    sandbox: "workspace-write",
    server_time: Date.now() / 1000,
    service_ready: true,
    thread_activity: [],
    transcript: [],
    transcript_truncated: false,
  };
}

async function fulfillJson(route, data) {
  await route.fulfill({
    body: JSON.stringify({ data, ok: true }),
    contentType: "application/json",
    status: 200,
  });
}

async function routeApi(page, { model }) {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/stream") return route.abort();
    if (pathname === "/api/session") return fulfillJson(route, sessionSnapshot(model));
    if (pathname === "/api/providers") return fulfillJson(route, ["codex", "claude_code"]);
    if (pathname === "/api/providers/codex/models") return fulfillJson(route, CODEX_MODELS);
    if (pathname === "/api/providers/claude_code/models") return fulfillJson(route, CLAUDE_MODELS);
    if (pathname === "/api/threads") {
      return fulfillJson(route, {
        threads: [
          {
            cwd: ROOT,
            id: THREAD_ID,
            model_provider: "codex",
            name: "Picker thread",
            preview: "",
            provider: "codex",
            source: "codex",
            status: "idle",
            updated_at: Date.now() / 1000,
          },
        ],
      });
    }
    return fulfillJson(route, []);
  });
}

// Runs in the page. The ticked row has to be inside its panel's visible box and on top.
function readCheckedRow() {
  const panel = document.querySelector(".model-picker-flyout") || document.querySelector(".model-picker-menu");
  const row = panel?.querySelector('.model-picker-option[aria-checked="true"]');
  if (!row) return { checked: null };
  const room = panel.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
  return {
    checked: row.dataset.value,
    inPanel: box.top >= room.top - 0.5 && box.bottom <= room.bottom + 0.5,
    onTop: Boolean(hit && (hit === row || row.contains(hit))),
    panelScrolls: panel.scrollHeight > panel.clientHeight,
    scrollTop: Math.round(panel.scrollTop),
  };
}

const frames = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function openPicker(page, triggerSelector, { flyout }) {
  await page.click(triggerSelector);
  await page.waitForSelector(flyout ? ".model-picker-flyout[data-placed='true']" : ".model-picker-menu[data-placed='true']", {
    timeout: TIMEOUT_MS,
  });
  await frames(page);
}

async function closePicker(page) {
  await page.keyboard.press("Escape");
  await page.waitForSelector(".model-picker-menu", { state: "detached", timeout: TIMEOUT_MS });
}

function assertVisible(where, wanted, seen) {
  assert.equal(seen.checked, wanted, `${where}: the ticked row is the chosen model`);
  assert.ok(seen.panelScrolls, `${where}: the list must be taller than its panel for this to mean anything`);
  assert.ok(seen.inPanel && seen.onTop, `${where}: ${wanted} must be on screen when the menu opens, got ${JSON.stringify(seen)}`);
}

async function newSessionCase(context, baseUrl, wanted) {
  const page = await context.newPage();
  const where = `New session, ${wanted}`;
  try {
    await routeApi(page, { model: "gpt-6.1-sol" });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForSelector("#open-start-session-dialog", { timeout: TIMEOUT_MS });
    await page.click("#open-start-session-dialog");
    await page.waitForFunction(() => document.getElementById("launch-start-session-dialog")?.open, null, {
      timeout: TIMEOUT_MS,
    });
    const trigger = "#launch-start-session-dialog-model";

    // Choose it the way a user does: through the menu, unfolding Other if it is there.
    await openPicker(page, trigger, { flyout: true });
    await page.evaluate(async (value) => {
      const flyout = document.querySelector(".model-picker-flyout");
      if (!flyout.querySelector(`[data-value="${value}"]`)) {
        flyout.querySelector('.model-picker-other[aria-expanded="false"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      document.querySelector(`.model-picker-flyout [data-value="${value}"]`).click();
    }, wanted);
    await page.waitForSelector(".model-picker-menu", { state: "detached", timeout: TIMEOUT_MS });

    await openPicker(page, trigger, { flyout: true });
    const seen = await page.evaluate(readCheckedRow);
    const shot = path.join(os.tmpdir(), `model-picker-new-session-${wanted}.png`);
    await page.screenshot({ path: shot });
    logStep(where, { ...seen, shot });
    assertVisible(where, wanted, seen);
    await closePicker(page);
  } catch (error) {
    await writeFailureArtifacts({ localPage: page, scenario: `model-picker-selected-new-session-${wanted}` }).catch(() => {});
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function composerCase(context, baseUrl, wanted) {
  const page = await context.newPage();
  const where = `Composer, ${wanted}`;
  try {
    await routeApi(page, { model: wanted });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    const open = page.locator(`[data-open-thread-id="${THREAD_ID}"]`);
    await open.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await open.click();
    await page.waitForFunction(
      (value) => document.querySelector("#message-model")?.value === value
        && Boolean(document.querySelector("#message-model-picker")),
      wanted,
      { timeout: TIMEOUT_MS }
    );

    await openPicker(page, "#message-model-picker", { flyout: false });
    const seen = await page.evaluate(readCheckedRow);
    const shot = path.join(os.tmpdir(), `model-picker-composer-${wanted}.png`);
    await page.screenshot({ path: shot });
    logStep(where, { ...seen, shot });
    assertVisible(where, wanted, seen);
    await closePicker(page);
  } catch (error) {
    await writeFailureArtifacts({ localPage: page, scenario: `model-picker-selected-composer-${wanted}` }).catch(() => {});
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const port = await getFreePort();
  const unusedRelayPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const vite = spawnManagedProcess(
    "vite",
    process.execPath,
    [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { RELAY_DEV_RELOAD: "0", RELAY_DEV_SERVER_PORT: String(unusedRelayPort) }
  );
  let browser;
  let context;
  const failures = [];
  try {
    await waitForHealth(baseUrl, TIMEOUT_MS);
    ({ browser, context } = await launchBrowser({
      contextOptions: { serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
    }));
    const cases = [
      () => newSessionCase(context, baseUrl, LOW),
      () => newSessionCase(context, baseUrl, FOLDED),
      () => composerCase(context, baseUrl, LOW),
      () => composerCase(context, baseUrl, FOLDED),
    ];
    // Every case runs, so one report shows which surfaces are affected.
    for (const run of cases) {
      try {
        await run();
      } catch (error) {
        failures.push(error);
        console.error(`[model-picker-selected-visible-e2e] FAIL ${error.message}`);
      }
    }
  } catch (error) {
    dumpProcessLogs(vite);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(vite);
  }
  if (failures.length) throw new Error(`${failures.length} case(s) failed`);
  logStep("PASS");
}

main().catch((error) => {
  console.error("[model-picker-selected-visible-e2e] FAILED", error.message);
  process.exitCode = 1;
});
