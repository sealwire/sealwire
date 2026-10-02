// Real-browser regression for the conversation model label. A cached provider
// catalogue must keep the visible label stable while a session snapshot briefly
// omits available_models. EXPECT_MODEL_LABEL_JITTER=1 turns the same scenario
// into a baseline reproducer for an unfixed checkout.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import {
  dumpProcessLogs,
  spawnManagedProcess,
  stopManagedProcess,
  waitFor,
  waitForHealth,
} from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const TIMEOUT_MS = 30_000;
const EXPECT_JITTER = process.env.EXPECT_MODEL_LABEL_JITTER === "1";
const SCREENSHOT_DIR = process.env.E2E_MODEL_LABEL_SCREENSHOT_DIR || "";
const CASES = [
  { provider: "codex", model: "chatgpt", displayName: "ChatGPT" },
  { provider: "cursor", model: "default[]", displayName: "Auto" },
  {
    provider: "claude_code",
    model: "default",
    displayName: "Default (recommended, Opus 5)",
  },
];

function modelOption({ provider, model, displayName }) {
  return {
    model,
    display_name: displayName,
    provider,
    supported_reasoning_efforts: ["medium", "high"],
    default_reasoning_effort: "medium",
    hidden: false,
    is_default: true,
  };
}

function sessionSnapshot(testCase, availableModels) {
  return {
    active_controller_device_id: null,
    active_thread_id: `model-label-${testCase.provider}`,
    active_turn_id: null,
    allowed_roots: [ROOT],
    approval_policy: "never",
    available_models: availableModels,
    beta_features_enabled: false,
    current_cwd: ROOT,
    current_status: "idle",
    device_records: [],
    logs: [],
    model: testCase.model,
    paired_devices: [],
    pending_approvals: [],
    pending_ask_user_questions: [],
    pending_pairing_requests: [],
    provider: testCase.provider,
    provider_connected: true,
    provider_status: [
      { provider: testCase.provider, connected: true, status: "connected" },
    ],
    reasoning_effort: "high",
    sandbox: "workspace-write",
    server_time: Date.now() / 1000,
    service_ready: true,
    thread_activity: [],
    transcript: [],
    transcript_truncated: false,
  };
}

function threadSummary(testCase) {
  return {
    id: `model-label-${testCase.provider}`,
    name: `${testCase.provider} model label`,
    preview: "Model label stability browser test",
    cwd: ROOT,
    updated_at: Date.now() / 1000,
    source: testCase.provider,
    status: "idle",
    model_provider: testCase.provider,
    provider: testCase.provider,
  };
}

function threadTranscriptPage(testCase) {
  return {
    thread_id: `model-label-${testCase.provider}`,
    prev_cursor: null,
    revision: 0,
    entries: [],
    thread_state: {
      thread_id: `model-label-${testCase.provider}`,
      provider: testCase.provider,
      current_cwd: ROOT,
      current_status: "idle",
      active_turn_id: null,
      current_phase: null,
      current_tool: null,
      last_progress_at: null,
      model: testCase.model,
      reasoning_effort: "high",
      approval_policy: "never",
      sandbox: "workspace-write",
      available_models: [modelOption(testCase)],
      review_locked: false,
      settings_writable: true,
    },
  };
}

async function fulfillJson(route, data) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data }),
  });
}

async function installModelObserver(page) {
  await page.addInitScript(() => {
    // Every case is a cold surface even though the browser context is reused.
    window.localStorage.clear();
    window.__modelLabelSamples = [];
    window.__modelSessionRenderCount = 0;
    window.__modelStreamReady = false;
    let streamController = null;
    let lastSample = "";

    window.__recordModelLabel = (source = "manual") => {
      const select = document.querySelector("#message-model");
      const label =
        document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() || "";
      const value = select?.value || "";
      if (!label) return;
      const key = `${value}\n${label}`;
      if (key === lastSample) return;
      lastSample = key;
      window.__modelLabelSamples.push({ label, source, value });
    };
    window.__resetModelLabelSamples = () => {
      window.__modelLabelSamples = [];
      lastSample = "";
      window.__recordModelLabel("baseline");
    };

    new MutationObserver(() => window.__recordModelLabel("mutation")).observe(document, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.addEventListener("agent-relay:session-updated", () => {
      window.__modelSessionRenderCount += 1;
      queueMicrotask(() => window.__recordModelLabel("session-updated"));
    });
    window.addEventListener("DOMContentLoaded", () => window.__recordModelLabel("dom-ready"));

    const nativeFetch = window.fetch.bind(window);
    window.fetch = function modelLabelFetch(input, init) {
      const rawUrl = typeof input === "string" ? input : input?.url || String(input || "");
      let pathname = "";
      try {
        pathname = new URL(rawUrl, window.location.href).pathname;
      } catch {}
      if (pathname !== "/api/stream") {
        return nativeFetch(input, init);
      }

      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
          window.__modelStreamReady = true;
        },
        cancel() {
          streamController = null;
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    };

    window.__pushModelSession = (snapshot) => {
      if (!streamController) {
        throw new Error("model-label test stream is not connected");
      }
      const block = `event: session\ndata: ${JSON.stringify(snapshot)}\n\n`;
      streamController.enqueue(new TextEncoder().encode(block));
    };
  });
}

async function pushSnapshot(page, snapshot) {
  const previousRenderCount = await page.evaluate(() => window.__modelSessionRenderCount);
  await page.evaluate((next) => window.__pushModelSession(next), snapshot);
  await page.waitForFunction(
    (previous) => window.__modelSessionRenderCount > previous,
    previousRenderCount,
    { timeout: TIMEOUT_MS }
  );
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.evaluate(() => window.__recordModelLabel("after-paint"));
}

function hasOrderedSequence(labels, expected) {
  let cursor = 0;
  for (const label of labels) {
    if (label === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return false;
}

async function runCase(context, baseUrl, testCase) {
  const page = await context.newPage();
  const catalog = [modelOption(testCase)];
  const full = sessionSnapshot(testCase, catalog);
  const empty = sessionSnapshot(testCase, []);
  const initial = EXPECT_JITTER ? full : empty;
  let modelCatalogRequests = 0;
  let modelCatalogDeliveries = 0;
  let releaseModelCatalog = () => {};
  const modelCatalogGate = EXPECT_JITTER
    ? Promise.resolve()
    : new Promise((resolve) => {
      releaseModelCatalog = resolve;
    });
  let unexpectedNativeStreamRequests = 0;
  const pageErrors = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installModelObserver(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/stream") {
      unexpectedNativeStreamRequests += 1;
      await route.abort();
      return;
    }
    if (url.pathname === "/api/session") {
      await fulfillJson(route, initial);
      return;
    }
    if (url.pathname === "/api/providers") {
      await fulfillJson(route, [testCase.provider]);
      return;
    }
    if (url.pathname === `/api/providers/${encodeURIComponent(testCase.provider)}/models`) {
      modelCatalogRequests += 1;
      await modelCatalogGate;
      await fulfillJson(route, catalog);
      modelCatalogDeliveries += 1;
      return;
    }
    if (url.pathname === "/api/threads") {
      await fulfillJson(route, { threads: [threadSummary(testCase)] });
      return;
    }
    await fulfillJson(route, []);
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    const openConversation = page.locator(`[data-open-thread-id="${full.active_thread_id}"]`);
    await openConversation.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await openConversation.click();
    if (!EXPECT_JITTER) {
      // Deterministic cold-catalog regression: enter the real conversation
      // while the provider request is held, prove the raw id is painted, then
      // release the response. No navigation/render is allowed to repair the
      // selector after release; refreshProviderCatalogs must do it itself.
      await page.waitForFunction(
        ({ model, threadId }) => {
          const form = document.querySelector("#message-form");
          const select = document.querySelector("#message-model");
          const picker = document.querySelector("#message-model-picker");
          const rect = picker?.getBoundingClientRect();
          return new URL(window.location.href).searchParams.get("thread") === threadId
            && form?.hidden === false
            && rect?.width > 0
            && rect?.height > 0
            && select?.value === model
            && picker.querySelector(".setting-pill-value")?.textContent?.trim() === model;
        },
        { ...testCase, threadId: full.active_thread_id },
        { timeout: TIMEOUT_MS }
      );
      releaseModelCatalog();
      await waitFor(() => modelCatalogDeliveries > 0, TIMEOUT_MS);
    }
    await page.waitForFunction(
      ({ displayName, model }) => {
        const select = document.querySelector("#message-model");
        return select?.value === model
          && document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() === displayName;
      },
      testCase,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForFunction(() => window.__modelStreamReady, undefined, {
      timeout: TIMEOUT_MS,
    });
    await waitFor(
      () => modelCatalogRequests > 0 && modelCatalogDeliveries > 0,
      TIMEOUT_MS
    );
    await page.waitForTimeout(100);

    await page.evaluate(() => window.__resetModelLabelSamples());
    await pushSnapshot(page, full);
    const firstFullLabel = await page.evaluate(
      () => document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() || ""
    );
    await pushSnapshot(page, empty);

    const emptyLabel = await page.evaluate(
      () => document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() || ""
    );
    if (SCREENSHOT_DIR) {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          SCREENSHOT_DIR,
          `${EXPECT_JITTER ? "main" : "fixed"}-${testCase.provider}.png`
        ),
        fullPage: true,
      });
    }

    await pushSnapshot(page, full);
    const samples = await page.evaluate(() => window.__modelLabelSamples);
    const labels = samples.map((sample) => sample.label);
    const finalLabel = await page.evaluate(
      () => document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() || ""
    );

    assert.equal(unexpectedNativeStreamRequests, 0, "the controlled stream shim must be active");
    assert.deepEqual(pageErrors, [], `page errors for ${testCase.provider}`);
    assert.equal(finalLabel, testCase.displayName, `final label for ${testCase.provider}`);
    if (EXPECT_JITTER) {
      assert.equal(emptyLabel, testCase.model, `main must expose the raw ${testCase.provider} id`);
      assert.ok(
        hasOrderedSequence(labels, [testCase.displayName, testCase.model, testCase.displayName]),
        `main did not reproduce ${testCase.provider} jitter: ${JSON.stringify(samples)}`
      );
    } else {
      assert.equal(firstFullLabel, testCase.displayName, `${testCase.provider} full label changed`);
      assert.equal(emptyLabel, testCase.displayName, `${testCase.provider} label changed on empty snapshot`);
      const firstFriendly = labels.indexOf(testCase.displayName);
      assert.ok(firstFriendly >= 0, `friendly label was never rendered for ${testCase.provider}`);
      assert.ok(
        !labels.slice(firstFriendly).includes(testCase.model),
        `${testCase.provider} flashed its raw id: ${JSON.stringify(samples)}`
      );
    }

    return { provider: testCase.provider, emptyLabel, labels, samples };
  } catch (error) {
    await writeFailureArtifacts({
      scenario: `model-label-stability-${testCase.provider}`,
      localPage: page,
      metadata: { expected: EXPECT_JITTER ? "jitter" : "stable", provider: testCase.provider },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
    throw error;
  } finally {
    releaseModelCatalog();
    await page.close().catch(() => {});
  }
}

async function runCrossProviderCase(context, baseUrl) {
  const liveCase = CASES.find(({ provider }) => provider === "claude_code");
  const viewedCase = CASES.find(({ provider }) => provider === "codex");
  const live = sessionSnapshot(liveCase, [modelOption(liveCase)]);
  const viewedThreadId = `model-label-${viewedCase.provider}`;
  const page = await context.newPage();
  const pageErrors = [];
  const fetchedCatalogs = new Set();

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installModelObserver(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/stream") {
      await route.abort();
      return;
    }
    if (url.pathname === "/api/session") {
      await fulfillJson(route, live);
      return;
    }
    if (url.pathname === "/api/providers") {
      await fulfillJson(route, [liveCase.provider, viewedCase.provider]);
      return;
    }
    for (const testCase of [liveCase, viewedCase]) {
      if (url.pathname === `/api/providers/${encodeURIComponent(testCase.provider)}/models`) {
        fetchedCatalogs.add(testCase.provider);
        await fulfillJson(route, [modelOption(testCase)]);
        return;
      }
    }
    if (url.pathname === `/api/threads/${viewedThreadId}/transcript`) {
      await fulfillJson(route, threadTranscriptPage(viewedCase));
      return;
    }
    if (url.pathname === "/api/threads") {
      await fulfillJson(route, {
        threads: [threadSummary(viewedCase), threadSummary(liveCase)],
      });
      return;
    }
    await fulfillJson(route, []);
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForFunction(() => window.__modelStreamReady, undefined, {
      timeout: TIMEOUT_MS,
    });
    await waitFor(() => fetchedCatalogs.size === 2, TIMEOUT_MS);
    const viewedRow = page.locator(`button.conversation-item[data-thread-id="${viewedThreadId}"]`);
    await viewedRow.waitFor({ state: "attached", timeout: TIMEOUT_MS });
    await page.evaluate(() => document.querySelector(".sidebar-drawer")?.setAttribute("open", ""));
    await viewedRow.click();
    await page.waitForFunction(
      ({ displayName, model, threadId }) => {
        const select = document.querySelector("#message-model");
        return new URL(window.location.href).searchParams.get("thread") === threadId
          && select?.value === model
          && document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() === displayName;
      },
      { ...viewedCase, threadId: viewedThreadId },
      { timeout: TIMEOUT_MS }
    );

    await page.evaluate(() => window.__resetModelLabelSamples());
    await pushSnapshot(page, live);
    const labelAfterPaint = await page.evaluate(
      () => document.querySelector("#message-model-picker .setting-pill-value")?.textContent?.trim() || ""
    );
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__recordModelLabel("after-deferred-render"));
    const samples = await page.evaluate(() => window.__modelLabelSamples);
    const labels = samples.map((sample) => sample.label);

    assert.deepEqual(pageErrors, [], "page errors for cross-provider view-only case");
    if (EXPECT_JITTER) {
      assert.ok(
        hasOrderedSequence(
          labels,
          [viewedCase.displayName, viewedCase.model, viewedCase.displayName]
        ),
        `main did not reproduce cross-provider jitter: ${JSON.stringify(samples)}`
      );
    } else {
      assert.equal(labelAfterPaint, viewedCase.displayName, "live snapshot repainted the viewed model");
      assert.ok(
        !labels.includes(viewedCase.model),
        `cross-provider snapshot flashed the raw viewed model id: ${JSON.stringify(samples)}`
      );
    }
    assert.ok(
      !labels.includes(liveCase.displayName) && !labels.includes(liveCase.model),
      `live provider leaked into the viewed model selector: ${JSON.stringify(samples)}`
    );

    if (SCREENSHOT_DIR) {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          SCREENSHOT_DIR,
          `${EXPECT_JITTER ? "main" : "fixed"}-cross-provider.png`
        ),
        fullPage: true,
      });
    }
    return { provider: "cross-provider-view", labels, samples };
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "model-label-stability-cross-provider",
      localPage: page,
      metadata: { liveProvider: liveCase.provider, viewedProvider: viewedCase.provider },
    }).catch((artifactError) => {
      console.error(`[e2e-artifacts] failed to write artifacts: ${artifactError.message}`);
    });
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
    [
      path.join(ROOT, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      RELAY_DEV_RELOAD: "0",
      // The browser routes every API request, but make an accidental miss fail
      // closed instead of falling through Vite to the user's relay on 8787.
      RELAY_DEV_SERVER_PORT: String(unusedRelayPort),
    }
  );
  let browser;
  let context;
  try {
    await waitForHealth(baseUrl, TIMEOUT_MS);
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
    }));
    const results = [];
    for (const testCase of CASES) {
      results.push(await runCase(context, baseUrl, testCase));
    }
    results.push(await runCrossProviderCase(context, baseUrl));
    console.log(JSON.stringify({ expected: EXPECT_JITTER ? "jitter" : "stable", results }, null, 2));
  } catch (error) {
    dumpProcessLogs(vite);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(vite);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
