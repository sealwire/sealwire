// On a phone the drawer scrolls as one column, so with a long session list New session sat
// far above and Settings far below. Both must stay on screen however far the list scrolls.
// Serves the built web/ bundle and stubs the relay socket: no relay, broker or worker.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { addEncryptedBrokerInitScript } from "./e2e/harness/encrypted-broker-mock.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const WEB_ROOT = path.join(process.cwd(), "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const THREAD_COUNT = 40;

function installFakeRelay({ relayId, threadCount }) {
  const relayProfile = {
    relayId,
    relayLabel: "Fake Relay",
    brokerUrl: "ws://fake-broker.test",
    brokerChannelId: "room-e2e",
    relayPeerId: "relay-peer-e2e",
    securityMode: "private",
    deviceId: "device-e2e",
    deviceLabel: "Browser E2E",
    hasStoredPayloadSecret: true,
    deviceJoinTicket: "device-join-ticket-e2e",
    deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  // One folder each, so every session is its own group and the list runs long.
  const threads = Array.from({ length: threadCount }, (_, index) => ({
    id: `thread-${index}`,
    name: `Drawer session ${index}`,
    preview: `Preview ${index}`,
    cwd: `/tmp/e2e-drawer/repo-${String(index).padStart(2, "0")}`,
    updated_at: threadCount - index,
    source: "codex",
    status: "completed",
    model_provider: "openai",
  }));
  const snapshot = {
    provider: "codex",
    service_ready: true,
    codex_connected: true,
    broker_connected: true,
    broker_channel_id: "room-e2e",
    broker_peer_id: "relay-peer-e2e",
    security_mode: "private",
    e2ee_enabled: true,
    broker_can_read_content: false,
    audit_enabled: false,
    active_thread_id: null,
    active_controller_device_id: "device-e2e",
    active_controller_last_seen_at: Math.floor(Date.now() / 1000),
    controller_lease_expires_at: Math.floor(Date.now() / 1000) + 60,
    controller_lease_seconds: 15,
    active_turn_id: null,
    current_status: "idle",
    active_flags: [],
    current_cwd: "/tmp/e2e-drawer",
    projects_revision: 1,
    model: "gpt-5.4",
    available_models: [],
    approval_policy: "never",
    sandbox: "workspace-write",
    reasoning_effort: "medium",
    allowed_roots: [],
    device_records: [],
    paired_devices: [],
    pending_pairing_requests: [],
    pending_approvals: [],
    transcript_truncated: false,
    transcript: [],
    logs: [],
  };

  window.localStorage.setItem(
    "agent-relay.remote-state",
    JSON.stringify({
      schemaVersion: 1,
      activeRelayId: relayId,
      clientAuth: null,
      remoteProfiles: { [relayId]: relayProfile },
    })
  );

  window.__agentRelaySecretReady = false;
  const openRequest = indexedDB.open("agent-relay-secrets", 1);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    for (const store of ["payload-secrets", "secret-keys"]) {
      if (!database.objectStoreNames.contains(store)) {
        database.createObjectStore(store, { keyPath: "id" });
      }
    }
  };
  openRequest.onsuccess = () => {
    const tx = openRequest.result.transaction("payload-secrets", "readwrite");
    tx.objectStore("payload-secrets").put({ id: relayId, kind: "software", payloadSecret: "payload-secret-e2e" });
    tx.oncomplete = () => {
      window.__agentRelaySecretReady = true;
    };
  };

  // Keep in step with broker-client.js, or the page silently drops every answer.
  const BROKER_PROTOCOL_VERSION = 2;
  const RELAY_PROTOCOL_VERSION = 5;

  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"));
        this.#emit({
          type: "welcome",
          protocol_version: BROKER_PROTOCOL_VERSION,
          peer_id: "surface-e2e",
          channel_id: "room-e2e",
          peers: [{ peer_id: "relay-peer-e2e", role: "relay" }],
        });
        this.#emit({ type: "presence", kind: "joined", peer: { peer_id: "relay-peer-e2e", role: "relay" } });
        this.#emit({
          type: "message",
          payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot },
        });
      });
    }
    send(raw) {
      const payload = JSON.parse(raw).payload;
      const request = payload?.request || {};
      if (request.type === "heartbeat") {
        this.#respond(payload.action_id, { action: "heartbeat", ok: true, snapshot });
      } else if (request.type === "list_threads") {
        this.#respond(payload.action_id, { action: "list_threads", ok: true, snapshot, threads: { threads } });
      } else if (request.type === "fetch_projects") {
        this.#respond(payload.action_id, {
          action: "fetch_projects",
          ok: true,
          snapshot,
          projects: { projects_revision: 1, projects: [], thread_project_id: {} },
        });
      }
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }));
    }
    #respond(actionId, result) {
      this.#emit({
        type: "message",
        payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "remote_action_result", action_id: actionId, ...result },
      });
    }
    #emit(rawFrame) {
      const frame = rawFrame.type === "message" ? { from_role: "relay", from_peer_id: "relay-peer-e2e", ...rawFrame } : rawFrame;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }
  window.WebSocket = window.__sealwireEncryptedMock(FakeWebSocket);
}

// On screen means inside the viewport AND the topmost thing at its centre, so a button
// covered by the list, or parked below the fold, both fail.
function onScreen(selector) {
  const node = document.querySelector(selector);
  if (!node) return { selector, missing: true };
  const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    selector,
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    viewport: window.innerHeight,
    visible: rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight && Boolean(hit && node.contains(hit)),
  };
}

async function openPage(browser, server, viewport, mobile) {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, locale: "en-US" });
  const page = await context.newPage();
  attachPageDebugLogging(page, "remote", { prefix: "remote-mobile-drawer-actions-e2e" });
  await addEncryptedBrokerInitScript(page, installFakeRelay, { relayId: "relay-e2e", threadCount: THREAD_COUNT });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, { timeout: TIMEOUT_MS });
  await page.reload({ waitUntil: "domcontentloaded" });
  // The list is virtualized, so its height, not its row count, says it is long.
  await page.waitForFunction(
    () => (document.querySelector("#remote-threads-list")?.getBoundingClientRect().height || 0) > 1500,
    null,
    { timeout: TIMEOUT_MS }
  );
  return { context, page };
}

async function main() {
  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: { "/manifest.webmanifest": "remote-manifest.webmanifest" },
    stripStaticPrefix: true,
  });
  const { browser } = await launchBrowser();
  try {
    const { context, page } = await openPage(browser, server, { width: 390, height: 844 }, true);
    await page.tap("#remote-nav-toggle-button");
    await page.waitForFunction(
      () => document.querySelector(".remote-app-shell")?.dataset.remoteNavState === "open",
      null,
      { timeout: TIMEOUT_MS }
    );
    // The drawer slides in; measure after it lands.
    await page.waitForTimeout(500);

    const buttons = ["#remote-session-toggle", "#remote-sidebar-settings"];
    const atTop = await Promise.all(buttons.map((selector) => page.evaluate(onScreen, selector)));
    assert.ok(atTop.every((entry) => entry.visible), `drawer just opened: ${JSON.stringify(atTop)}`);

    await page.evaluate(() => {
      const drawer = document.querySelector(".remote-app-shell .sidebar");
      drawer.scrollTop = drawer.scrollHeight;
    });
    await page.waitForTimeout(250);
    const atBottom = await Promise.all(buttons.map((selector) => page.evaluate(onScreen, selector)));
    assert.ok(atBottom.every((entry) => entry.visible), `drawer scrolled to the end: ${JSON.stringify(atBottom)}`);

    assert.equal(
      await page.locator(".remote-app-shell .sidebar .start-session-split").count(),
      0,
      "the phone drawer still carries the old New session split button"
    );
    // Settings › This device is one tap away on the gear, so the sidebar drops the row.
    assert.equal(await page.locator("#open-pairing-modal").count(), 0, "the phone drawer still shows Device Pairing · Manage");

    await page.tap("#remote-session-toggle");
    await page.waitForFunction(() => Boolean(document.getElementById("remote-start-session-dialog")?.open), null, {
      timeout: TIMEOUT_MS,
    });
    await context.close();

    const settingsRun = await openPage(browser, server, { width: 390, height: 844 }, true);
    await settingsRun.page.tap("#remote-nav-toggle-button");
    await settingsRun.page.waitForTimeout(500);
    await settingsRun.page.tap("#remote-sidebar-settings");
    await settingsRun.page.waitForFunction(() => Boolean(document.getElementById("remote-settings-modal")?.open), null, {
      timeout: TIMEOUT_MS,
    });
    await settingsRun.context.close();

    // A desktop sidebar is a column of its own with the list scrolling inside it: unchanged.
    const desktop = await openPage(browser, server, { width: 1280, height: 800 }, false);
    assert.equal(await desktop.page.locator(".remote-app-shell .sidebar .start-session-split").count(), 1);
    assert.equal(await desktop.page.locator(".remote-app-shell .sidebar-fab-bar").count(), 0);
    assert.equal(await desktop.page.locator("#open-pairing-modal").count(), 0, "the desktop sidebar still shows Device Pairing · Manage");
    await desktop.context.close();

    console.log("[remote-mobile-drawer-actions-e2e] ok");
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
