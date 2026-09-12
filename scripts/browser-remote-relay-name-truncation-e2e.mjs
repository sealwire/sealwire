// Regression: the remote sidebar relay name must use the 1fr title track, not
// collapse into the 14px lead slot.
//
// `.conversation-item` is a 3-column grid (`14px | 1fr | auto`) sized for
// (lead, title, meta). Session rows always emit `.conversation-lead`. Relay
// rows used to skip it, so the title landed in the 14px column and ellipsised
// to one character ("r...") while "Open relay" sat alone in the 1fr track.
//
// `innerText` is not evidence: Chromium returns the full string through a CSS
// ellipsis. Only `scrollWidth` vs `clientWidth` (and a clientWidth that is
// clearly larger than the 14px lead) prove the glyphs got the room.
//
// Runs at both a phone drawer width and a desktop sidebar width — the grid
// bug is viewport-independent, but the drawer path is the one that surfaces
// the row for a phone user.
//
// Lightweight: static `web/` + stubbed WebSocket. No relay / broker / worker.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-relay-name-e2e";
// Short enough to fit a phone drawer once the title is in the 1fr track, long
// enough that a 14px box can only show one glyph + ellipsis — the reported bug.
const RELAY_LABEL = "relay-on-macbook";
const LEAD_SLOT_PX = 14;
// Anything at-or-under the lead slot is the old bug. Real titles clear this by
// a wide margin once they sit in the 1fr track.
const MIN_TITLE_CLIENT_WIDTH_PX = LEAD_SLOT_PX * 3;

const PHONE = {
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  viewport: { height: 844, width: 390 },
};
const DESKTOP = {
  hasTouch: false,
  isMobile: false,
  viewport: { height: 900, width: 1280 },
};

function logStep(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[remote-relay-name-truncation-e2e] ${message}${suffix}`);
}

function buildInitScript() {
  return ({ relayId, relayLabel, threadId }) => {
    const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";
    const REMOTE_STATE_SCHEMA_VERSION = 1;
    const REMOTE_SECRET_DB_NAME = "agent-relay-secrets";
    const REMOTE_SECRET_STORE_NAME = "payload-secrets";
    const REMOTE_SECRET_KEY_STORE_NAME = "secret-keys";
    const relayProfile = {
      relayId,
      relayLabel,
      brokerUrl: "ws://fake-broker.test",
      brokerChannelId: "room-e2e",
      relayPeerId: "relay-peer-e2e",
      securityMode: "managed",
      deviceId: "device-e2e",
      deviceLabel: "Browser E2E",
      hasStoredPayloadSecret: true,
      deviceJoinTicket: "device-join-ticket-e2e",
      deviceJoinTicketExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const threadSummary = {
      id: threadId,
      name: "Relay Name Truncation E2E",
      preview: "seeded",
      cwd: "/tmp/e2e-relay-name",
      updated_at: 1,
      source: "codex",
      status: "completed",
      model_provider: "openai",
    };
    const snapshot = {
      provider: "codex",
      service_ready: true,
      codex_connected: true,
      broker_connected: true,
      broker_channel_id: "room-e2e",
      broker_peer_id: "relay-peer-e2e",
      security_mode: "managed",
      e2ee_enabled: false,
      broker_can_read_content: true,
      audit_enabled: false,
      active_thread_id: threadId,
      active_controller_device_id: "device-e2e",
      active_controller_last_seen_at: Math.floor(Date.now() / 1000),
      controller_lease_expires_at: Math.floor(Date.now() / 1000) + 60,
      controller_lease_seconds: 15,
      active_turn_id: null,
      current_status: "completed",
      active_flags: [],
      current_cwd: "/tmp/e2e-relay-name",
      projects_revision: 1,
      model: "gpt-5.5",
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
      REMOTE_STATE_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
        activeRelayId: relayId,
        clientAuth: null,
        remoteProfiles: { [relayId]: relayProfile },
      })
    );

    window.__agentRelaySecretReady = false;
    const openRequest = indexedDB.open(REMOTE_SECRET_DB_NAME, 1);
    openRequest.onupgradeneeded = () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains(REMOTE_SECRET_STORE_NAME)) {
        database.createObjectStore(REMOTE_SECRET_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(REMOTE_SECRET_KEY_STORE_NAME)) {
        database.createObjectStore(REMOTE_SECRET_KEY_STORE_NAME, { keyPath: "id" });
      }
    };
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      const tx = database.transaction(REMOTE_SECRET_STORE_NAME, "readwrite");
      tx.objectStore(REMOTE_SECRET_STORE_NAME).put({
        id: relayId,
        kind: "software",
        payloadSecret: "payload-secret-e2e",
      });
      tx.oncomplete = () => {
        window.__agentRelaySecretReady = true;
      };
    };

    const BROKER_PROTOCOL_VERSION = 1;
    const RELAY_PROTOCOL_VERSION = 2;

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
          this.#emit({
            type: "presence",
            kind: "joined",
            peer: { peer_id: "relay-peer-e2e", role: "relay" },
          });
          this.#emit({
            type: "message",
            payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot },
          });
        });
      }
      send(raw) {
        const frame = JSON.parse(raw);
        const payload = frame.payload;
        const request = payload?.request || {};
        if (request.type === "heartbeat") {
          this.#respond(payload.action_id, { action: "heartbeat", ok: true, snapshot });
          return;
        }
        if (request.type === "list_threads") {
          this.#respond(payload.action_id, {
            action: "list_threads",
            ok: true,
            snapshot,
            threads: { threads: [threadSummary] },
          });
          return;
        }
        if (request.type === "fetch_projects") {
          this.#respond(payload.action_id, {
            action: "fetch_projects",
            ok: true,
            snapshot,
            projects: {
              projects_revision: 1,
              projects: [],
              thread_project_id: {},
            },
          });
          return;
        }
        this.#respond(payload.action_id, {
          action: request.type || "unknown",
          ok: true,
          snapshot,
        });
      }
      close() {
        this.readyState = 3;
      }
      #respond(actionId, result) {
        this.#emit({
          type: "message",
          payload: {
            protocol_version: RELAY_PROTOCOL_VERSION,
            kind: "remote_action_result",
            action_id: actionId,
            ...result,
          },
        });
      }
      #emit(frame) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
    }
    window.WebSocket = FakeWebSocket;
  };
}

async function openRelayList(page, profile) {
  if (profile.isMobile) {
    await page.waitForSelector("#remote-nav-toggle-button", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    const open = await page.evaluate(
      () => document.querySelector(".remote-app-shell")?.dataset.remoteNavState === "open"
    );
    if (!open) {
      await page.click("#remote-nav-toggle-button");
    }
    // Wait for the drawer GEOMETRY, not just the attribute — attribute flips
    // first, then the sidebar slides in.
    await page.waitForFunction(
      () => {
        const shell = document.querySelector(".remote-app-shell");
        const aside = document.querySelector(".remote-app-shell .sidebar");
        if (shell?.dataset.remoteNavState !== "open" || !aside) return false;
        return aside.getBoundingClientRect().left >= 0;
      },
      undefined,
      { timeout: TIMEOUT_MS }
    );
  }

  await page.waitForSelector("#remote-relays-list .conversation-item", {
    state: "visible",
    timeout: TIMEOUT_MS,
  });
}

async function readRelayTitleMetrics(page, expectedLabel) {
  return page.evaluate((label) => {
    const row = document.querySelector("#remote-relays-list .conversation-item");
    if (!row) return { found: false };
    const lead = row.querySelector(".conversation-lead");
    const title = row.querySelector(".conversation-title");
    const meta = row.querySelector(".conversation-meta");
    if (!title) return { found: false, reason: "no title" };
    const titleRect = title.getBoundingClientRect();
    const leadRect = lead?.getBoundingClientRect();
    const metaRect = meta?.getBoundingClientRect();
    return {
      found: true,
      label: title.textContent?.trim() || "",
      expectedLabel: label,
      hasLead: Boolean(lead),
      title: {
        clientWidth: title.clientWidth,
        scrollWidth: title.scrollWidth,
        width: Math.round(titleRect.width * 100) / 100,
        left: Math.round(titleRect.left * 100) / 100,
        right: Math.round(titleRect.right * 100) / 100,
      },
      lead: lead
        ? {
            width: Math.round(leadRect.width * 100) / 100,
            left: Math.round(leadRect.left * 100) / 100,
            right: Math.round(leadRect.right * 100) / 100,
          }
        : null,
      meta: meta
        ? {
            text: meta.textContent?.trim() || "",
            left: Math.round(metaRect.left * 100) / 100,
            right: Math.round(metaRect.right * 100) / 100,
          }
        : null,
      viewportWidth: window.innerWidth,
    };
  }, expectedLabel);
}

function assertTitleUsesFrTrack(metrics, name) {
  assert.equal(metrics.found, true, `[${name}] expected a relay row in #remote-relays-list`);
  assert.equal(
    metrics.label,
    RELAY_LABEL,
    `[${name}] unexpected relay title text: ${JSON.stringify(metrics)}`
  );
  assert.equal(
    metrics.hasLead,
    true,
    `[${name}] relay rows must reserve .conversation-lead — without it the title sits in the 14px track`
  );

  // The reported bug: title.clientWidth ≈ 14px. A healthy title in the 1fr track
  // is many times that, even in a phone drawer with the CTA on the right.
  assert.ok(
    metrics.title.clientWidth >= MIN_TITLE_CLIENT_WIDTH_PX,
    `[${name}] title clientWidth must clear the 14px lead slot (got ${metrics.title.clientWidth}px; `
      + `need ≥ ${MIN_TITLE_CLIENT_WIDTH_PX}px) — ${JSON.stringify(metrics)}`
  );

  // This label fits once it has the 1fr track. scrollWidth > clientWidth here is
  // the ellipsis the screenshot showed ("r...").
  assert.ok(
    metrics.title.scrollWidth <= metrics.title.clientWidth + 1,
    `[${name}] "${RELAY_LABEL}" must fully fit (scrollWidth ${metrics.title.scrollWidth} vs `
      + `clientWidth ${metrics.title.clientWidth}) — ${JSON.stringify(metrics)}`
  );

  if (metrics.lead && metrics.meta) {
    assert.ok(
      metrics.title.left >= metrics.lead.right - 1,
      `[${name}] title must start at/after the lead slot, got ${JSON.stringify(metrics)}`
    );
    assert.ok(
      metrics.meta.left >= metrics.title.right - 1,
      `[${name}] meta ("Open relay") must sit to the right of the title, got ${JSON.stringify(metrics)}`
    );
  }
}

async function runPass(browser, profile, name) {
  const context = await browser.newContext(profile);
  const page = await context.newPage();
  attachPageDebugLogging(page, name, { prefix: "remote-relay-name-truncation-e2e" });
  return { context, page };
}

async function main() {
  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: {
      "/manifest.webmanifest": "remote-manifest.webmanifest",
      "/static/remote-sw.js": "remote-sw.js",
    },
    stripStaticPrefix: true,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const { browser } = await launchBrowser({ contextOptions: DESKTOP });

  let context;
  let page;

  try {
    for (const [name, profile] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      ({ context, page } = await runPass(browser, profile, name));

      await page.addInitScript(buildInitScript(), {
        relayId: RELAY_ID,
        relayLabel: RELAY_LABEL,
        threadId: THREAD_ID,
      });

      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, {
        timeout: TIMEOUT_MS,
      });
      await page.reload({ waitUntil: "domcontentloaded" });

      await openRelayList(page, profile);
      const metrics = await readRelayTitleMetrics(page, RELAY_LABEL);
      logStep(`${name} metrics`, metrics);
      assertTitleUsesFrTrack(metrics, name);
      logStep(`${name} PASS`);

      await page.close();
      await context.close();
      context = null;
      page = null;
    }

    logStep("PASS");
  } catch (error) {
    await writeFailureArtifacts({
      localPage: page,
      metadata: { desktop: DESKTOP.viewport, phone: PHONE.viewport, relayLabel: RELAY_LABEL },
      scenario: "remote-relay-name-truncation",
    }).catch(() => {});
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[remote-relay-name-truncation-e2e] FAILED", error);
  process.exitCode = 1;
});
