import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const ROOT = process.cwd();
const models = {
  codex: [{ model: "gpt-6-luna", display_name: "GPT-6-Luna", is_default: true }],
  claude_code: [{ model: "haiku", display_name: "Haiku", is_default: true }],
};
const threads = [
  { id: "original", name: "Original", provider: "codex" },
  { id: "other", name: "Other Codex", provider: "codex" },
  { id: "restricted", name: "Restricted Claude", provider: "claude_code" },
  { id: "pi", name: "Pi", provider: "pi" },
].map((thread) => ({ ...thread, cwd: ROOT, source: thread.provider, status: "idle", updated_at: 1 }));
function snapshot(thread = threads[0], settings = {}) {
  return {
    active_thread_id: thread.id, active_turn_id: null, provider: thread.provider,
    native_terminal_providers: ["codex", "claude_code"], current_cwd: ROOT,
    current_status: "idle", approval_policy: "on-request", sandbox: "workspace-write",
    model: models[thread.provider]?.[0]?.model, available_models: models[thread.provider] || [],
    reasoning_effort: "medium", service_ready: true, provider_connected: true,
    provider_status: [{ provider: thread.provider, connected: true, status: "connected" }],
    allowed_roots: [ROOT], device_records: [], paired_devices: [], logs: [],
    pending_approvals: [], pending_ask_user_questions: [], pending_pairing_requests: [],
    transcript: [], transcript_truncated: false, thread_activity: [], ...settings,
  };
}
async function routeApi(page) {
  const starts = [], opens = [], settings = [];
  let live = snapshot();
  const localThreads = [...threads];
  const respond = (route, data) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/stream") return route.abort();
    if (pathname === "/api/session") return respond(route, live);
    if (pathname === "/api/providers") return respond(route, ["codex", "claude_code", "cursor", "opencode", "pi"]);
    const provider = pathname.match(/^\/api\/providers\/([^/]+)\/models$/)?.[1];
    if (provider) return respond(route, models[provider] || []);
    if (pathname === "/api/threads") return respond(route, { threads: localThreads });
    if (pathname === "/api/session/start") {
      const body = request.postDataJSON();
      starts.push(body);
      live = snapshot({ id: `created-${starts.length}`, provider: body.provider }, { approval_policy: body.approval_policy, sandbox: body.sandbox });
      if (body.provider === "claude_code" && body.initial_prompt) {
        live.active_turn_id = "initial-turn";
        const initial = live;
        setTimeout(() => { initial.active_turn_id = null; }, 1400);
      }
      localThreads.push({ id: live.active_thread_id, provider: body.provider, name: "New terminal", cwd: ROOT, status: "idle", updated_at: 2 });
      return respond(route, live);
    }
    if (pathname === "/api/session/settings") settings.push(request.postDataJSON());
    const threadId = new URL(request.url()).searchParams.get("thread_id");
    const transcriptThreadId = pathname.match(/^\/api\/threads\/([^/]+)\/transcript$/)?.[1];
    if (transcriptThreadId) {
      const thread = localThreads.find((thread) => thread.id === transcriptThreadId);
      return respond(route, { thread_id: transcriptThreadId, entries: [], prev_cursor: null, thread_state: { ...snapshot(thread), settings_writable: true } });
    }
    if (pathname === "/api/session/view") return respond(route, snapshot(threads.find((thread) => thread.id === threadId)));
    if (pathname === "/api/session/terminal/open") {
      const body = request.postDataJSON();
      assert.equal(live.active_turn_id, null, "wait until the initial SDK turn finishes");
      opens.push(body);
      if (body.thread_id === "restricted") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "Claude terminal requires Full access (YOLO)" } }) });
      return respond(route, { thread_id: body.thread_id, terminal_id: "pty", offset: 1, data: Buffer.from("Sealwire native TUI\r\n").toString("base64"), cols: 80, rows: 20, reset: true, exited: false });
    }
    if (pathname === "/api/session/terminal/read") return respond(route, { thread_id: threadId, terminal_id: "pty", offset: 1, cols: 80, rows: 20, data: "", reset: false, exited: false });
    return respond(route, []);
  });
  return { starts, opens, settings };
}
async function choose(page, provider, presentation, model) {
  await page.locator("#launch-start-session-dialog-model").click();
  const back = page.locator(".model-picker-back");
  if (await back.isVisible()) await back.click();
  const row = page.locator(`[data-provider-row="${provider}${presentation === "terminal" ? ":terminal" : ""}"]`);
  await row.click();
  await page.locator(`.model-picker-layer [data-provider="${provider}"][data-value="${model}"]`).click();
}
async function showSidebar(page) {
  if (!await page.locator("#open-start-session-dialog").isVisible()) {
    if (await page.locator("#go-console-home").isVisible()) await page.locator("#go-console-home").click();
    else await page.locator("#toggle-left-panel").click();
    await page.locator("#open-start-session-dialog").waitFor({ state: "visible" });
  }
}
async function runCase(browser, origin, mobile, locale) {
  const context = await browser.newContext({ locale, serviceWorkers: "block", viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const calls = await routeApi(page);
  try {
    await page.goto(origin);
    console.log("loaded", mobile, locale);
    await page.locator("#open-start-session-dialog").click();
    await page.locator("#launch-start-session-dialog-model").click();
    // A phone initially shows models in place of providers; use its Back row.
    const back = page.locator(".model-picker-back");
    if (await back.isVisible()) await back.click();
    for (const provider of ["codex", "claude_code"]) {
      const row = page.locator(`[data-provider-row="${provider}:terminal"]`);
      await row.scrollIntoViewIfNeeded();
      const visible = await row.locator(".context-menu-label").evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, text: node.textContent }));
      assert.ok(visible.width > 0 && visible.scroll <= visible.width + 1, JSON.stringify(visible));
      assert.match(visible.text, /terminal|终端/i);
    }
    const shot = path.join(os.tmpdir(), `sealwire-terminal-launch-${mobile ? "phone" : "desktop"}-${locale}.png`);
    await page.screenshot({ path: shot });
    await page.keyboard.press("Escape");
    console.log("menu verified", shot);
    await choose(page, "claude_code", "terminal", "haiku");
    const dialog = page.locator("#launch-start-session-dialog");
    assert.match(await dialog.textContent(), /YOLO/);
    assert.match(await dialog.locator("#launch-start-session-dialog-approval").textContent(), /Full access|完全访问/);
    if (mobile) await dialog.locator("#launch-start-session-dialog-start-prompt").fill("Initial prompt exactly once");
    await dialog.locator('#launch-start-session-dialog-start').click();
    await page.locator('.session-presentation[data-session-mode="terminal"] .xterm').waitFor();
    await page.waitForFunction(() => document.querySelector(".native-terminal-status")?.textContent?.match(/Live terminal|终端已连接/));
    assert.equal(calls.starts.length, 1);
    assert.equal(calls.starts[0].provider, "claude_code");
    assert.equal(calls.starts[0].approval_policy, "bypass");
    assert.equal(calls.starts[0].sandbox, "danger-full-access");
    assert.equal(calls.starts[0].initial_prompt, mobile ? "Initial prompt exactly once" : null);
    assert.equal(calls.opens[0].thread_id, "created-1");
    // The currently mounted transcript must react to a context-menu mode request.
    await page.locator('.session-presentation-controls button[aria-pressed="false"]').click();
    await page.locator('.session-tab[data-thread-id="created-1"]').click({ button: "right" });
    const terminalLabel = locale.startsWith("zh") ? "在终端中打开" : "Open in terminal";
    await page.getByRole("menuitem", { name: terminalLabel, exact: true }).click();
    await page.locator('.session-presentation[data-session-mode="terminal"]').waitFor();
    await showSidebar(page);
    await page.locator("#open-start-session-dialog").click();
    await choose(page, "codex", "terminal", "gpt-6-luna");
    await page.locator("#launch-start-session-dialog-start-prompt").fill("Codex first prompt once");
    await page.locator("#launch-start-session-dialog-start").click();
    await page.waitForFunction(() => location.search.includes("created-2"));
    await page.waitForFunction(() => document.querySelector(".native-terminal-status")?.textContent?.match(/Live terminal|终端已连接/));
    assert.equal(calls.starts.length, 2);
    assert.equal(calls.starts[1].provider, "codex");
    assert.equal(calls.starts[1].initial_prompt, "Codex first prompt once");
    assert.equal(calls.opens.at(-1).thread_id, "created-2");
    await showSidebar(page);
    await page.locator('#threads-list [data-thread-id="restricted"]').click({ button: "right" });
    await page.locator("#terminal-thread-button").click();
    await page.locator(".native-terminal-error").waitFor();
    assert.equal(calls.opens.at(-1).thread_id, "restricted");
    assert.match(await page.locator(".native-terminal-error").textContent(), /YOLO/);
    if (!mobile) {
      await showSidebar(page);
      await page.locator('#threads-list [data-thread-id="pi"]').click({ button: "right" });
      assert.equal(await page.locator("#terminal-thread-button").isVisible(), false);
      await page.keyboard.press("Escape");
    }
    assert.equal(calls.settings.length, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, mobile, locale, shot, starts: calls.starts.length, opens: calls.opens.map((input) => input.thread_id) }));
  } catch (error) {
    await page.screenshot({ path: path.join(os.tmpdir(), "sealwire-terminal-entrypoints-failed.png") });
    console.error({ errors, starts: calls.starts, opens: calls.opens });
    throw error;
  } finally { await context.close(); }
}
const port = await getFreePort(), relayPort = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const vite = spawnManagedProcess("vite", process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { RELAY_DEV_RELOAD: "0", RELAY_DEV_SERVER_PORT: String(relayPort) });
let browser;
try {
  await waitForHealth(origin, 30000);
  ({ browser } = await launchBrowser());
  await runCase(browser, origin, false, "zh-CN");
  await runCase(browser, origin, true, "en-US");
} finally { await browser?.close(); await stopManagedProcess(vite); }
