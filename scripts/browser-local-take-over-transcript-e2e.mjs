import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const cwd = process.cwd();
const generation = "take-over-transcript-e2e";
const entries = Array.from({ length: 54 }, (_, index) => ({
  row_id: `a-${index}`,
  item_id: `a-${index}`,
  kind: index >= 42 || index % 2 ? "agent_text" : "user_text",
  status: "completed",
  content_state: "full",
  turn_id: `turn-${Math.min(20, Math.floor(index / 2))}`,
  order_seq: index * 1048576,
  text: `${index < 42 ? "Retained" : "Server-only"} message ${index}\n\n${"History must survive taking control of this session. ".repeat(5)}`,
}));
const initialEntries = entries.slice(0, 42);
const thread = id => ({
  id, name: `Take-over ${id}`, cwd, status: id === "a" ? "active" : "idle",
  provider: "codex", source: "codex", updated_at: 1,
});
const artifactDir = path.join(cwd, "artifacts/e2e/take-over-transcript");

async function main() {
  const port = await getFreePort();
  const unusedRelayPort = await getFreePort();
  const server = spawnManagedProcess("take-over-test-vite", process.execPath, ["node_modules/vite/bin/vite.js", "--strictPort"], {
    RELAY_DEV_VITE_PORT: String(port), RELAY_DEV_SERVER_PORT: String(unusedRelayPort),
  });
  let browser;
  let context;
  let page;
  let releaseTail;
  try {
    const base = `http://127.0.0.1:${port}/static/`;
    await waitForHealth(base);
    ({ browser, context } = await launchBrowser({ contextOptions: { viewport: { width: 1440, height: 900 } } }));
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const olderReads = [];
    let activeTailReads = 0;
    let holdActiveTail = true;
    let takeOvers = 0;
    let snapshot = {
      provider: "codex", provider_connected: true, transcript_generation: generation,
      active_thread_id: "other", active_turn_id: null, current_cwd: cwd, current_status: "idle",
      transcript: [], transcript_revision: 1, transcript_truncated: false,
      model: "test-model", reasoning_effort: "medium", approval_policy: "never", sandbox: "workspace-write",
      available_models: [], pending_approvals: [], pending_ask_user_questions: [],
      thread_activity: [{ thread_id: "a", phase: "thinking" }],
    };
    page.on("pageerror", error => errors.push(error.message));
    // Every API response is a fixture, so this browser cannot alter a live relay.
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname === "/api/stream") return route.abort();
      if (url.pathname === "/api/session" || url.pathname === "/api/session/heartbeat") data = snapshot;
      else if (url.pathname === "/api/session/take-over") {
        const input = route.request().postDataJSON();
        assert.equal(input.thread_id, "a");
        takeOvers++;
        snapshot = {
          ...snapshot, active_thread_id: "a", active_controller_device_id: input.device_id,
          active_turn_id: "turn-20", current_status: "active", transcript_revision: 2,
          transcript: entries.slice(-8), transcript_truncated: true,
        };
        data = snapshot;
      } else if (url.pathname === "/api/threads") data = { threads: [thread("a"), thread("other")] };
      else if (url.pathname === "/api/projects") data = { projects_revision: 0, projects: [], thread_project_id: {} };
      else if (url.pathname === "/api/providers") data = { providers: [] };
      else if (url.pathname.endsWith("/models")) data = { models: [] };
      else if (url.pathname.endsWith("/transcript")) {
        const id = url.pathname.split("/")[3];
        assert.equal(id, "a");
        const older = url.searchParams.has("before");
        if (!older && snapshot.active_thread_id === "a") {
          activeTailReads++;
          if (holdActiveTail) await new Promise(resolve => { releaseTail = resolve; });
        }
        if (older) olderReads.push(url.searchParams.get("before"));
        const history = snapshot.active_thread_id === "a" ? entries : initialEntries;
        const end = older ? Number(url.searchParams.get("before").slice("before-".length)) : history.length;
        const start = snapshot.active_thread_id === "a" ? Math.max(0, end - 6) : older ? 0 : 22;
        data = {
          thread_id: id, transcript_generation: generation, revision: snapshot.transcript_revision,
          entries: history.slice(start, end),
          prev_cursor: start ? `before-${start}` : null,
          thread_state: {
            provider: "codex", current_cwd: cwd, current_status: "active", active_turn_id: "turn-20",
            model: "test-model", available_models: [],
          },
        };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
    });
    await page.goto(base);
    await page.waitForSelector('.conversation-item[data-thread-id="a"]', { state: "attached" });
    await page.evaluate(() => document.querySelector(".sidebar-drawer")?.setAttribute("open", ""));
    await page.locator('.conversation-item[data-thread-id="a"]').dblclick();
    await page.waitForSelector('[data-transcript-entry-id="a-41"]');
    const scroller = page.locator(".chat-thread");
    const olderResponse = page.waitForResponse(response => response.url().includes("/threads/a/transcript?before="));
    await scroller.hover();
    await page.mouse.wheel(0, -10000);
    await olderResponse;
    await page.waitForFunction(() => document.querySelector('[data-transcript-entry-id="a-0"]'));
    await scroller.evaluate(element => { element.scrollTop = 500; element.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(200);
    const before = await measureTranscript(page);
    assert.ok(before.visible.some(row => Number(row.id.split("-")[1]) < 22));
    await fs.mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "before-take-over.png") });

    await page.locator("#take-over-button").click();
    await page.locator("#take-over-button").waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    const after = await measureTranscript(page);
    assert.equal(takeOvers, 1);
    assert.ok(after.scrollHeight >= before.scrollHeight * 0.9, JSON.stringify({ before, after }));
    assertReadingPosition(before, after);
    await page.screenshot({ path: path.join(artifactDir, "after-take-over.png") });
    assert.equal(activeTailReads, 1, "take-over must read a fresh tail even without a delta gap");
    const freshResponse = page.waitForResponse(response => response.url().endsWith("/threads/a/transcript"));
    holdActiveTail = false;
    releaseTail();
    releaseTail = null;
    await freshResponse;
    await page.waitForFunction(height => document.querySelector(".chat-thread")?.scrollHeight > height + 300, after.scrollHeight);
    const refreshed = await measureTranscript(page);
    assertReadingPosition(before, refreshed);
    await scroller.evaluate((element, top) => { element.scrollTop = top; element.dispatchEvent(new Event("scroll")); }, before.scrollHeight - 100);
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-transcript-entry-id="a-43"]');
      const viewport = document.querySelector(".chat-thread")?.getBoundingClientRect();
      const rect = row?.getBoundingClientRect();
      return rect && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const repaired = await measureTranscript(page);
    assert.ok(repaired.visible.some(row => row.id === "a-43"), "a row absent from both the pin and snapshot must become visible");
    await page.screenshot({ path: path.join(artifactDir, "after-tail-refresh.png") });
    assert.equal(activeTailReads, 1);
    assert.deepEqual(olderReads, ["before-22", "before-48", "before-42"]);
    assert.deepEqual(errors, []);
    const report = JSON.stringify({ before, after, refreshed, repaired, takeOvers, activeTailReads, olderReads, artifactDir }, null, 2);
    await fs.writeFile(path.join(artifactDir, "result.json"), `${report}\n`);
    console.log(report);
  } catch (error) {
    await fs.mkdir(artifactDir, { recursive: true });
    await page?.screenshot({ path: path.join(artifactDir, "failure.png") });
    throw error;
  } finally {
    releaseTail?.();
    await context?.close();
    await browser?.close();
    await stopManagedProcess(server);
  }
}

function assertReadingPosition(before, after) {
  const visible = after.visible.slice(0, before.visible.length);
  assert.deepEqual(visible.map(row => row.id), before.visible.map(row => row.id));
  before.visible.forEach((row, index) => {
    assert.ok(Math.abs(visible[index].top - row.top) < 4, JSON.stringify({ before, after }));
    assert.ok(Math.abs(visible[index].bottom - row.bottom) < 4, JSON.stringify({ before, after }));
  });
}

function measureTranscript(page) {
  return page.evaluate(() => {
    const element = document.querySelector(".chat-thread");
    const viewport = element.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      visible: [...element.querySelectorAll("[data-transcript-entry-id]")].map(row => {
        const rect = row.getBoundingClientRect();
        return { id: row.dataset.transcriptEntryId, top: rect.top, bottom: rect.bottom, height: rect.height };
      }).filter(row => row.height > 0 && row.bottom > viewport.top && row.top < viewport.bottom),
    };
  });
}

await main();
