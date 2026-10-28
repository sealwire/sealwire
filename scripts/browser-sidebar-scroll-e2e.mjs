import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";
import { createServer } from "vite";
import { createArtifactWriter } from "./e2e/harness/artifacts.mjs";

const FIXTURE_ID = "/__sidebar-scroll-fixture.js";
const FIXTURE_MODULE = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ThreadGroupList } from "/shared/thread-list-react.js";

const groups = Array.from({ length: 4 }, (_, group) => ({
  cwd: "/work/project-" + group,
  label: "项目 " + group,
  threads: Array.from({ length: 30 }, (_, index) => ({
    id: group + "-" + index,
    name: "中文会话标题与较长的内容 " + group + "." + index,
    provider: index % 2 ? "claude_code" : "codex",
    updated_at: 1,
    flagged: index % 3 === 0,
  })),
}));
const params = new URLSearchParams(location.search);
const root = createRoot(document.querySelector("#threads-list"));
function renderSidebar() {
  root.render(
    React.createElement(ThreadGroupList, {
      groups: groups.map((group) => ({ ...group })),
      collapsible: true,
      activeThreadId: "0-0",
      formatThreadMeta: () => "18 小时",
      expandedGroupCwds: params.has("expanded")
        ? new Set(groups.map((group) => group.cwd))
        : new Set(),
      onThreadActions: params.has("actions") ? () => {} : null,
    })
  );
}
window.__refreshSidebar = renderSidebar;
renderSidebar();
`;

// The fixed-height shell isolates component measurements, including narrow widths.
// The real local page's narrow drawer uses document scrolling instead.
function fixturePlugin() {
  return {
    name: "sidebar-scroll-fixture",
    resolveId(id) {
      return id === FIXTURE_ID ? `\0${FIXTURE_ID}` : null;
    },
    load(id) {
      return id === `\0${FIXTURE_ID}` ? FIXTURE_MODULE : null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname !== "/__sidebar-scroll") {
          next();
          return;
        }
        const view = url.searchParams.get("view") === "console" ? "console" : "conversation";
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html>
          <html lang="zh-CN" data-theme="light"><head>
            <link rel="stylesheet" href="/styles.css">
            <style>
              ::-webkit-scrollbar { width: 15px; height: 15px; }
              ::-webkit-scrollbar-thumb { background: #888; border-radius: 8px; }
            </style>
          </head><body>
            <div class="app-shell" data-view="${view}" style="height:100dvh">
              <aside class="sidebar" style="height:100dvh">
                <div style="flex:0 0 180px"></div>
                <button class="start-session-button">＋ 新建会话</button>
                <details class="sidebar-drawer" open>
                  <summary class="sidebar-drawer-summary">
                    <p class="sidebar-caption">4 个文件夹 · 120 个会话</p>
                  </summary>
                  <div class="sidebar-drawer-body">
                    <div class="conversation-list" id="threads-list"
                      data-thread-list-scroll-root></div>
                  </div>
                </details>
              </aside>
              <main class="chat-shell"></main>
            </div>
            <script type="module" src="${FIXTURE_ID}"></script>
          </body></html>`);
      });
    },
  };
}

async function nextFrames(page, count = 4) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise(requestAnimationFrame);
    }
  }, count);
}

async function runCase(browser, baseUrl, testCase, artifacts) {
  const context = await browser.newContext({
    viewport: testCase.viewport || { width: 1280, height: 800 },
    locale: "zh-CN",
    hasTouch: Boolean(testCase.touch),
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/__sidebar-scroll?${testCase.query || ""}`);
    await page.waitForSelector(".conversation-item");
    await page.evaluate(() => document.fonts.ready);
    await nextFrames(page);
    let beforeResize = null;
    if (testCase.resizeTo) {
      beforeResize = await page.locator(".conversation-item").first().evaluate((row) => row.offsetHeight);
      await page.setViewportSize(testCase.resizeTo);
      await nextFrames(page, 8);
    }
    const initial = await page.locator("#threads-list").evaluate((list) => ({
      height: list.scrollHeight,
      viewport: list.clientHeight,
      rows: list.querySelectorAll(".conversation-item").length,
      rowHeight: list.querySelector(".conversation-item").offsetHeight,
    }));
    if (beforeResize !== null) {
      assert.notEqual(initial.rowHeight, beforeResize, "resizing must exercise a real row-height change");
    }
    assert.ok(initial.height > initial.viewport, "fixture must overflow vertically");
    assert.ok(initial.rows < 120, "fixture must still virtualize off-screen sessions");
    const topSamples = await page.evaluate(async () => {
      const list = document.querySelector("#threads-list");
      const body = list.parentElement;
      const samples = [];
      for (let frame = 0; frame < 90; frame += 1) {
        if (frame % 6 === 0) window.__refreshSidebar();
        await new Promise(requestAnimationFrame);
        const listRect = list.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        samples.push({
          top: list.scrollTop,
          y: listRect.y,
          height: listRect.height,
          width: listRect.width,
          rowY: list.querySelector(".conversation-item").getBoundingClientRect().y,
          bodyTop: bodyRect.top,
          bodyBottom: bodyRect.bottom,
          bottom: listRect.bottom,
          bodyScrollHeight: body.scrollHeight,
          bodyClientHeight: body.clientHeight,
        });
      }
      return samples;
    });
    await artifacts.writeJson(`${testCase.name}-idle-top.json`, { topSamples, errors });
    for (const sample of topSamples) {
      assert.equal(sample.top, 0, "background refreshes must keep the list at the top");
      assert.equal(sample.y, topSamples[0].y, "the list must not move vertically while idle at the top");
      assert.equal(sample.rowY, topSamples[0].rowY, "the same row must not shake vertically at the top");
      assert.equal(sample.height, topSamples[0].height, "background refreshes must not resize the scroller");
      assert.equal(sample.width, topSamples[0].width, "background refreshes must not resize the list width");
      assert.ok(Math.abs(sample.y - sample.bodyTop) <= 1, "the list must start at the drawer body top");
      assert.ok(Math.abs(sample.bottom - sample.bodyBottom) <= 1, "the list must fill its drawer body");
      assert.ok(sample.bodyScrollHeight <= sample.bodyClientHeight, "only the session list may overflow its viewport");
    }
    await page.screenshot({ path: path.join(artifacts.dir, `${testCase.name}-before.png`) });
    await page.evaluate(() => {
      window.__sidebarSamples = [];
      window.__sidebarSampling = true;
      const sample = () => {
        const list = document.querySelector("#threads-list");
        window.__sidebarSamples.push({
          top: list.scrollTop,
          height: list.scrollHeight,
          viewport: list.clientHeight,
          left: list.scrollLeft,
          width: list.clientWidth,
          scrollWidth: list.scrollWidth,
        });
        if (window.__sidebarSampling) requestAnimationFrame(sample);
      };
      sample();
    });
    await page.locator("#threads-list").hover();
    await page.mouse.wheel(0, 100_000);
    await page.waitForFunction(() => document.querySelector("#threads-list").scrollTop > 0);
    await nextFrames(page, 12);
    const samples = await page.evaluate(() => {
      window.__sidebarSampling = false;
      return window.__sidebarSamples;
    });
    await artifacts.writeJson(`${testCase.name}.json`, { initial, samples, errors });
    await page.screenshot({ path: path.join(artifacts.dir, `${testCase.name}-after.png`) });
    assert.deepEqual(errors, [], "browser must not report errors");
    for (const [index, sample] of samples.entries()) {
      assert.equal(sample.height, initial.height, "newly visible rows must not change the scroll range");
      assert.equal(sample.left, 0, "the session list must not shift horizontally");
      assert.ok(sample.scrollWidth <= sample.width, "session rows must fit the list width");
      if (index > 0) {
        assert.ok(sample.top >= samples[index - 1].top, "scrolling down must not jump back up");
      }
    }
    await page.mouse.wheel(200, 0);
    await nextFrames(page);
    const afterHorizontalWheel = await page.locator("#threads-list").evaluate((list) => ({
      left: list.scrollLeft,
      top: list.scrollTop,
    }));
    assert.equal(afterHorizontalWheel.left, 0, "a horizontal gesture must not slide the list");
    assert.equal(afterHorizontalWheel.top, samples.at(-1).top, "a horizontal gesture must not move rows vertically");
    await page.mouse.wheel(0, -100_000);
    await page.waitForFunction(() => document.querySelector("#threads-list").scrollTop === 0);
    await nextFrames(page);
    assert.equal(
      await page.locator("#threads-list").evaluate((list) => list.scrollHeight),
      initial.height,
      "returning to the top must preserve the scroll range"
    );
    return { name: testCase.name, initial, final: samples.at(-1) };
  } finally {
    await context.close();
  }
}

async function runLocalTopReturnCase(browser, baseUrl, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });
  const threadId = "local-sidebar-top";
  const catalog = [{ model: "test-model", display_name: "Test model", provider: "codex", is_default: true }];
  const snapshot = {
    active_controller_device_id: null,
    active_thread_id: threadId,
    active_turn_id: null,
    allowed_roots: [process.cwd()],
    approval_policy: "never",
    available_models: catalog,
    beta_features_enabled: false,
    current_cwd: process.cwd(),
    current_status: "idle",
    device_records: [],
    logs: [],
    model: "test-model",
    paired_devices: [],
    pending_approvals: [],
    pending_ask_user_questions: [],
    pending_pairing_requests: [],
    provider: "codex",
    provider_connected: true,
    provider_status: [{ provider: "codex", connected: true, status: "connected" }],
    reasoning_effort: "medium",
    sandbox: "workspace-write",
    server_time: Date.now() / 1000,
    service_ready: true,
    thread_activity: [],
    transcript: [],
    transcript_truncated: false,
  };
  try {
    await page.addInitScript(() => {
      window.__sidebarSessionRenders = 0;
      window.addEventListener("agent-relay:session-updated", () => {
        window.__sidebarSessionRenders += 1;
      });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.pathname !== "/api/stream") return nativeFetch(input, init);
        const body = new ReadableStream({
          start(controller) {
            window.__pushSidebarSnapshot = (next) => {
              controller.enqueue(new TextEncoder().encode(`event: session\ndata: ${JSON.stringify(next)}\n\n`));
            };
          },
        });
        return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
      };
    });
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let data = [];
      if (pathname === "/api/session") data = snapshot;
      if (pathname === "/api/providers") data = ["codex"];
      if (pathname === "/api/providers/codex/models") data = catalog;
      if (pathname === "/api/threads") {
        data = { threads: Array.from({ length: 120 }, (_, index) => ({
          id: index ? `sidebar-session-${index}` : threadId,
          name: `Session ${index}`,
          cwd: `${process.cwd()}/project-${Math.floor(index / 30)}`,
          provider: "codex",
          source: "codex",
          status: "idle",
          updated_at: 120 - index,
        })) };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
    });
    await page.goto(baseUrl);
    await page.locator(`[data-open-thread-id="${threadId}"]`).click();
    await page.waitForSelector("#threads-list .conversation-item");
    await page.waitForFunction(() => typeof window.__pushSidebarSnapshot === "function");
    const samples = await page.evaluate(async (full) => {
      const list = document.querySelector("#threads-list");
      list.scrollTop = 200;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const previousRenders = window.__sidebarSessionRenders;
      window.__pushSidebarSnapshot({ ...full, available_models: [] });
      while (window.__sidebarSessionRenders === previousRenders) await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const beforeTop = list.scrollTop;
      list.scrollTop = 0;
      const reachedTop = list.scrollTop;
      const frames = [];
      for (let frame = 0; frame < 120; frame += 1) {
        if (frame % 6 === 0) window.__pushSidebarSnapshot(full);
        await new Promise(requestAnimationFrame);
        const listRect = list.getBoundingClientRect();
        const body = list.parentElement;
        const bodyRect = body.getBoundingClientRect();
        frames.push({
          frame,
          beforeTop,
          reachedTop,
          top: list.scrollTop,
          rowY: list.querySelector(".conversation-item").getBoundingClientRect().y,
          y: listRect.y,
          height: listRect.height,
          width: listRect.width,
          bottom: listRect.bottom,
          inlineHeight: list.style.height,
          inlineMaxHeight: list.style.maxHeight,
          bodyTop: bodyRect.top,
          bodyBottom: bodyRect.bottom,
          bodyScrollHeight: body.scrollHeight,
          bodyClientHeight: body.clientHeight,
        });
      }
      return frames;
    }, snapshot);
    await artifacts.writeJson("local-top-after-scroll.json", { samples, errors });
    await page.screenshot({ path: path.join(artifacts.dir, "local-top-after-scroll.png") });
    assert.deepEqual(errors, []);
    for (const sample of samples) {
      assert.equal(sample.beforeTop, 200, "background refreshes must preserve a reader's existing scroll position");
      assert.equal(sample.reachedTop, 0, "the reader must have reached the top before the idle check");
      assert.equal(sample.top, 0, "queued background restores must not pull the reader away from the top");
      assert.equal(sample.rowY, samples[0].rowY, "the local sidebar row must stay still at the top");
      assert.equal(sample.y, samples[0].y, "background snapshots must not move the local scroller");
      assert.equal(sample.height, samples[0].height, "background snapshots must not resize the local scroller");
      assert.equal(sample.width, samples[0].width, "background snapshots must not resize the local list width");
      assert.equal(sample.inlineHeight, "", "CSS must own the local scroller height");
      assert.equal(sample.inlineMaxHeight, "", "CSS must own the local scroller maximum height");
      assert.ok(Math.abs(sample.y - sample.bodyTop) <= 1, "the local list must start at the drawer body top");
      assert.ok(Math.abs(sample.bottom - sample.bodyBottom) <= 1, "the local list must fill its drawer body");
      assert.ok(sample.bodyScrollHeight <= sample.bodyClientHeight, "the local drawer body must not overflow");
    }
    return { name: "local-top-after-scroll", frames: samples.length, top: samples.at(-1).top };
  } catch (error) {
    await artifacts.writeJson("local-top-after-scroll-failure.json", {
      error: error.message,
      url: page.url(),
      errors,
      consoleErrors,
      failedRequests,
    });
    await page.screenshot({ path: path.join(artifacts.dir, "local-top-after-scroll-failure.png") });
    throw error;
  } finally {
    await context.close();
  }
}

const artifacts = createArtifactWriter("sidebar-scroll");
const server = await createServer({
  configFile: false,
  root: path.join(process.cwd(), "frontend"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [fixturePlugin()],
  logLevel: "error",
});
let browser;
try {
  await artifacts.writeJson("cases.json", { sessions: 120, folders: 4 });
  await server.listen();
  const { port } = server.httpServer.address();
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const results = [];
  for (const testCase of [
    { name: "desktop-collapsed" },
    { name: "desktop-expanded", query: "expanded=1" },
    { name: "touch-expanded", query: "expanded=1&actions=1", touch: true },
    // These constrained component fixtures test row-height changes across 960px.
    {
      name: "narrow-to-wide-collapsed",
      query: "view=console",
      viewport: { width: 900, height: 800 },
      resizeTo: { width: 1280, height: 800 },
    },
    {
      name: "narrow-to-wide-expanded",
      query: "view=console&expanded=1",
      viewport: { width: 900, height: 800 },
      resizeTo: { width: 1280, height: 800 },
    },
    {
      name: "wide-to-narrow-collapsed",
      query: "view=console",
      resizeTo: { width: 900, height: 800 },
    },
    {
      name: "wide-to-narrow-expanded",
      query: "view=console&expanded=1",
      resizeTo: { width: 900, height: 800 },
    },
  ]) {
    results.push(await runCase(browser, `http://127.0.0.1:${port}`, testCase, artifacts));
  }
  results.push(await runLocalTopReturnCase(browser, `http://127.0.0.1:${port}`, artifacts));
  console.log(JSON.stringify({ results, artifacts: artifacts.dir }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
