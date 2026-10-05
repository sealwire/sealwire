import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { addEncryptedBrokerInitScript } from "./e2e/harness/encrypted-broker-mock.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { spawnManagedProcess, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const cwd = process.cwd();
const generation = "tab-cache-e2e";
const thread = (id) => ({ id, name: `Cache ${id}`, cwd, status: "idle", provider: "codex", source: "codex", updated_at: 1 });
const rows = (id, fresh = false) => Array.from({ length: fresh ? 44 : 42 }, (_, index) => ({
  item_id: `${id}-${index}`, kind: index % 2 ? "agent_text" : "user_text", status: "completed",
  turn_id: `turn-${id}-${Math.floor(index / 2)}`, order_seq: index * 1048576,
  text: `${index >= 42 ? "Fresh" : "Cached"} ${id} message ${index}\n\n${"Transcript content for checking scroll restoration. ".repeat(5)}`,
}));
const snapshot = {
  provider: "codex", provider_connected: true, transcript_generation: generation,
  active_thread_id: "live", active_turn_id: null, current_cwd: cwd, current_status: "idle",
  transcript: [], transcript_revision: 1, transcript_truncated: false,
  model: "test-model", reasoning_effort: "medium", approval_policy: "never", sandbox: "workspace-write",
  available_models: [], pending_approvals: [], pending_ask_user_questions: [], thread_activity: [],
};

async function main() {
  const port = await getFreePort();
  const unusedRelayPort = await getFreePort();
  const server = spawnManagedProcess("cache-test-vite", process.execPath, ["node_modules/vite/bin/vite.js", "--strictPort"], {
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
    page.on("pageerror", error => errors.push(error.message));
    let holdTail = false;
    let tailHeld = false;
    let tailReads = 0;
    // All API traffic is a fixture; no request reaches an existing user relay.
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname === "/api/stream") return route.abort();
      if (url.pathname === "/api/session" || url.pathname === "/api/session/heartbeat") data = snapshot;
      else if (url.pathname === "/api/threads") data = { threads: [thread("a"), thread("b"), thread("live")] };
      else if (url.pathname === "/api/projects") data = { projects_revision: 0, projects: [], thread_project_id: {} };
      else if (url.pathname === "/api/providers") data = { providers: [] };
      else if (url.pathname.endsWith("/models")) data = { models: [] };
      else if (url.pathname.endsWith("/transcript")) {
        const id = url.pathname.split("/")[3];
        const older = url.searchParams.has("before");
        const refreshing = holdTail;
        if (id === "a" && !older) {
          tailReads++;
          if (holdTail) {
            tailHeld = true;
            await new Promise(resolve => { releaseTail = resolve; });
          }
        }
        data = {
          thread_id: id, transcript_generation: generation, revision: refreshing ? 2 : 1,
          entries: older ? rows(id).slice(0, 22) : rows(id, refreshing).slice(22),
          prev_cursor: older ? null : `older-${id}`,
          thread_state: { provider: "codex", current_cwd: cwd, current_status: "idle", model: "test-model", available_models: [] },
        };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
    });
    await page.goto(base);
    await page.waitForSelector('.conversation-item[data-thread-id="a"]', { state: "attached" });
    await page.evaluate(() => document.querySelector(".sidebar-drawer")?.setAttribute("open", ""));
    await page.locator('.conversation-item[data-thread-id="a"]').dblclick();
    await page.waitForSelector("[data-transcript-entry-id]");
    const scrollArea = page.locator(".chat-thread");
    await page.waitForTimeout(200);
    const olderResponse = page.waitForResponse(response => response.url().includes("/threads/a/transcript?before="));
    await scrollArea.hover();
    await page.mouse.wheel(0, -10000);
    await olderResponse;
    await page.waitForTimeout(200);
    await scrollArea.evaluate(element => { element.scrollTop = 500; element.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(200);
    const before = await measureTranscript(page);
    assert.equal(before.visible.some(row => Number(row.id.split("-")[1]) < 22), true, "older history is visible before switching away");
    await page.locator('.conversation-item[data-thread-id="b"]').click();
    await page.waitForFunction(() => document.querySelector('[data-transcript-entry-id^="b-"]'));
    holdTail = true;
    await page.locator('.session-tab[data-thread-id="a"] .session-tab-main').click();
    await page.waitForFunction(() => document.querySelector('[data-transcript-entry-id^="a-"]'));
    await page.waitForTimeout(200);
    assert.equal(tailHeld, true, "the fresh page remains blocked");
    const restored = await measureTranscript(page);
    assert.equal(restored.visible.length > 0, true, "cached messages must occupy the viewport before the network replies");
    assert.equal(Math.abs(restored.scrollTop - before.scrollTop) < 4, true, `scroll changed: ${JSON.stringify({ before, restored })}`);
    assert.deepEqual(restored.visible.map(row => row.id), before.visible.map(row => row.id));
    const artifactDir = path.join(cwd, "artifacts/e2e/tab-transcript-cache");
    await fs.mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "cached-before-refresh.png") });
    holdTail = false;
    releaseTail();
    releaseTail = null;
    await page.waitForTimeout(200);
    assert.equal(tailReads, 2, "returning refreshes the latest page once");
    await scrollArea.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelector('[data-transcript-entry-id="a-43"]')?.textContent.includes("Fresh a"));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ before, restored, tailReads, screenshot: path.join(artifactDir, "cached-before-refresh.png") }, null, 2));
    await checkRemoteCache(context, base, artifactDir);
  } catch (error) {
    const artifactDir = path.join(cwd, "artifacts/e2e/tab-transcript-cache");
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

async function measureTranscript(page) {
  return page.evaluate(() => {
    const element = document.querySelector(".chat-thread");
    const viewport = element.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      visible: [...element.querySelectorAll("[data-transcript-entry-id]")].map(row => {
        const rect = row.getBoundingClientRect();
        return { id: row.dataset.transcriptEntryId, top: rect.top, bottom: rect.bottom, height: rect.height };
      }).filter(row => row.height > 0 && row.bottom > viewport.top && row.top < viewport.bottom),
    };
  });
}

async function checkRemoteCache(context, base, artifactDir) {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {} }) }));
  await addEncryptedBrokerInitScript(page, installRemoteFixture, {
    snapshot, generation, cwd, threads: [thread("a"), thread("b"), thread("live")],
    cachedRows: { a: rows("a"), b: rows("b") }, freshRows: rows("a", true),
  });
  try {
    await page.goto(`${base}remote.html`);
    await page.waitForFunction(() => window.__tabCacheSecretReady);
    await page.reload();
    await page.locator('.conversation-item[data-thread-id="a"]').dblclick();
    await page.waitForSelector('[data-transcript-entry-id^="a-"]');
    const scroller = page.locator("#remote-transcript");
    await page.waitForTimeout(200);
    await scroller.hover();
    await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => window.__tabCacheFixture.olderReads > 0);
    await page.waitForTimeout(200);
    await scroller.evaluate(element => { element.scrollTop = 500; });
    await page.waitForTimeout(200);
    const before = await measureTranscript(page);
    assert.equal(before.visible.some(row => Number(row.id.split("-")[1]) < 22), true);
    await page.locator('.conversation-item[data-thread-id="b"]').click();
    await page.waitForSelector('[data-transcript-entry-id^="b-"]');
    await page.evaluate(() => { window.__tabCacheFixture.holdTail = true; });
    await page.locator('.session-tab[data-thread-id="a"] .session-tab-main').click();
    await page.waitForFunction(() => window.__tabCacheFixture.held.length === 1);
    await page.waitForSelector('[data-transcript-entry-id^="a-"]');
    await page.waitForTimeout(200);
    const restored = await measureTranscript(page);
    assert.equal(Math.abs(restored.scrollTop - before.scrollTop) < 4, true, JSON.stringify({ before, restored }));
    assert.deepEqual(restored.visible.map(row => row.id), before.visible.map(row => row.id));
    await page.screenshot({ path: path.join(artifactDir, "remote-cached-before-refresh.png") });
    await page.evaluate(() => window.__tabCacheFixture.release(true));
    const notice = page.locator(".transcript-refresh-notice");
    await notice.waitFor({ state: "visible" });
    const noticeRect = await notice.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width };
    });
    assert.equal(noticeRect.top >= 0 && noticeRect.bottom < 900 && noticeRect.height > 0, true);
    await page.screenshot({ path: path.join(artifactDir, "remote-refresh-failed.png") });
    const readsBeforeRetry = await page.evaluate(() => window.__tabCacheFixture.tailReads);
    await page.evaluate(() => { window.__tabCacheFixture.holdTail = false; window.__tabCacheFixture.fresh = true; });
    await notice.getByRole("button", { name: "Retry" }).click();
    await notice.waitFor({ state: "hidden" });
    await page.waitForFunction(previous => window.__tabCacheFixture.tailReads > previous, readsBeforeRetry);
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelector('[data-transcript-entry-id="a-43"]')?.textContent.includes("Fresh a"));
    await page.locator('.conversation-item[data-thread-id="b"]').click();
    await page.waitForSelector('[data-transcript-entry-id^="b-"]');
    await page.evaluate(() => { window.__tabCacheFixture.holdTail = true; });
    await page.locator('.session-tab[data-thread-id="a"] .session-tab-main').click();
    await page.waitForFunction(() => window.__tabCacheFixture.held.length === 1);
    await page.evaluate(() => window.__tabCacheFixture.release(true));
    await notice.waitFor({ state: "visible" });
    await page.evaluate(() => window.__tabCacheFixture.activateA());
    await notice.waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(artifactDir, "remote-became-live.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ surface: "remote", before, restored, noticeRect, retry: "latest page loaded", becameLive: "warning cleared" }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(artifactDir, "remote-failure.png") });
    throw error;
  } finally {
    await page.close();
  }
}

function installRemoteFixture({ snapshot, generation, cwd, threads, cachedRows, freshRows }) {
  const relayId = "tab-cache-relay";
  const profile = {
    relayId, relayLabel: "Cache Test Relay", brokerUrl: "ws://fake-broker.test", brokerChannelId: "room-e2e",
    relayPeerId: "relay-peer-e2e", securityMode: "private", deviceId: "device-e2e", deviceLabel: "Cache Test",
    hasStoredPayloadSecret: true, deviceJoinTicket: "device-ticket-e2e", deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  localStorage.setItem("agent-relay.remote-state", JSON.stringify({ schemaVersion: 1, activeRelayId: relayId, clientAuth: null, remoteProfiles: { [relayId]: profile } }));
  const open = indexedDB.open("agent-relay-secrets", 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("payload-secrets", { keyPath: "id" });
    open.result.createObjectStore("secret-keys", { keyPath: "id" });
  };
  open.onsuccess = () => {
    const tx = open.result.transaction("payload-secrets", "readwrite");
    tx.objectStore("payload-secrets").put({ id: relayId, kind: "software", payloadSecret: "payload-secret-e2e" });
    tx.oncomplete = () => { window.__tabCacheSecretReady = true; };
  };
  const controls = window.__tabCacheFixture = { holdTail: false, held: [], tailReads: 0, olderReads: 0, fresh: false };
  let liveSnapshot = snapshot;
  class MockSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      controls.activateA = () => {
        liveSnapshot = { ...snapshot, active_thread_id: "a", transcript_revision: 3, transcript: freshRows.slice(22) };
        this.emit({ type: "message", payload: { protocol_version: 3, kind: "session_snapshot", snapshot: liveSnapshot } });
      };
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"));
        this.emit({ type: "welcome", protocol_version: 1, peer_id: "surface-e2e", channel_id: "room-e2e", peers: [{ peer_id: "relay-peer-e2e", role: "relay" }] });
        this.emit({ type: "message", payload: { protocol_version: 3, kind: "session_snapshot", snapshot } });
      });
    }
    emit(frame) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ from_role: "relay", from_peer_id: "relay-peer-e2e", ...frame }) }));
    }
    respond(actionId, action, data = {}) {
      this.emit({ type: "message", payload: { protocol_version: 3, kind: "remote_action_result", action_id: actionId, action, ok: true, snapshot: liveSnapshot, ...data } });
    }
    send(raw) {
      const { payload } = JSON.parse(raw);
      const request = payload.request;
      if (request.type === "list_threads") return this.respond(payload.action_id, request.type, { threads: { threads } });
      if (request.type === "fetch_projects") return this.respond(payload.action_id, request.type, { projects: { projects_revision: 0, projects: [], thread_project_id: {} } });
      if (request.type === "fetch_thread_transcript") {
        const id = request.input.thread_id;
        const older = request.input.before != null;
        if (id === "a") {
          if (older) controls.olderReads++;
          else controls.tailReads++;
        }
        const respond = (fail = false) => this.respond(payload.action_id, request.type, fail
          ? { ok: false, error: "test refresh failed" }
          : { thread_transcript: {
              thread_id: id, transcript_generation: generation, revision: controls.fresh ? 2 : 1,
              entries: older ? (cachedRows[id] || []).slice(0, 22) : (controls.fresh && id === "a" ? freshRows : cachedRows[id] || []).slice(22),
              prev_cursor: older ? null : `older-${id}`,
              thread_state: { provider: "codex", current_cwd: cwd, current_status: "idle", model: "test-model", available_models: [] },
            } }
        );
        if (id === "a" && !older && controls.holdTail) controls.held.push(respond);
        else respond();
        return;
      }
      this.respond(payload.action_id, request.type);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
    }
  }
  controls.release = fail => controls.held.splice(0).forEach(respond => respond(fail));
  const NativeSocket = window.WebSocket;
  const EncryptedSocket = window.__sealwireEncryptedMock(MockSocket);
  window.WebSocket = class extends EncryptedSocket {
    constructor(url, ...args) {
      if (!String(url).includes("fake-broker.test")) return new NativeSocket(url, ...args);
      super(url, ...args);
    }
  };
}

await main();
