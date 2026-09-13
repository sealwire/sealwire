// Regression guard for the remote mobile chat header.
//
// On the remote surface at mobile width the chat shell must be pinned to one
// viewport (height:100dvh + overflow:hidden) so the transcript scrolls inside
// it and the position:sticky header — which holds the ☰ nav drawer toggle —
// stays at the top. A CSS specificity regression once let
// `.chat-shell[data-view="conversation"] { height:100% }` (0,2,0) out-specify
// the mobile `.remote-chat-shell { height:100dvh }` rule; with the mobile
// .app-shell at height:auto, height:100% collapsed to auto, the shell grew to
// full content height, the whole page scrolled, and the burger scrolled off
// the top. This test fails if that ever comes back.
//
// Deliberately lightweight: it serves the built web/ bundle over a static
// server and stubs the relay WebSocket — no relay / broker / worker process.

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
const THREAD_ID = "thread-mobile-header-e2e";
const PROJECT_ID = "project-mobile-header-e2e";
const PROJECT_NAME = "Mobile Project With A Very Long Header Name";
const LONG_PROMPT_TAIL = "MOBILE-HEADER-TAIL-E2E";
const FULL_TEXT = buildFullTranscriptText();
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function readLayout(page) {
  return page.evaluate(() => {
    const rectTop = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const shell = document.querySelector(".app-shell");
    const burger = document.querySelector("#remote-nav-toggle-button");
    const title = document.querySelector(".remote-chat-shell .project-switcher-trigger");
    const status = document.querySelector("#remote-status-badge");
    const info = document.querySelector("#remote-open-session-details");
    const transcript = document.querySelector("#remote-transcript");
    const se = document.scrollingElement || document.documentElement;
    const titleBox = title?.getBoundingClientRect?.();
    const statusBox = status?.getBoundingClientRect?.();
    const infoBox = info?.getBoundingClientRect?.();
    return {
      navMode: shell?.getAttribute("data-remote-nav-mode") ?? null,
      burgerVisible: burger ? burger.offsetParent !== null && !burger.hidden : false,
      headerTop: rectTop(".remote-chat-shell .chat-header"),
      burgerTop: rectTop("#remote-nav-toggle-button"),
      headerTitle: title?.textContent?.trim() || "",
      statusText: status?.textContent?.trim() || "",
      statusVisible: status ? status.offsetParent !== null && !status.hidden : false,
      infoVisible: info ? info.offsetParent !== null && !info.hidden : false,
      titleRight: titleBox ? Math.round(titleBox.right) : null,
      statusLeft: statusBox ? Math.round(statusBox.left) : null,
      statusRight: statusBox ? Math.round(statusBox.right) : null,
      infoLeft: infoBox ? Math.round(infoBox.left) : null,
      pageScrollTop: Math.round(se.scrollTop),
      transcriptScrollTop: transcript ? Math.round(transcript.scrollTop) : null,
      transcriptScrollHeight: transcript ? Math.round(transcript.scrollHeight) : null,
      transcriptClientHeight: transcript ? Math.round(transcript.clientHeight) : null,
    };
  });
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
  const { browser, context } = await launchBrowser({
    contextOptions: {
      viewport: MOBILE_VIEWPORT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    },
  });
  const page = await context.newPage();
  attachPageDebugLogging(page, "remote", { prefix: "remote-mobile-header-e2e" });

  try {
    await page.addInitScript(
      ({ relayId, threadId, projectId, projectName, fullText }) => {
        const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";
        const REMOTE_STATE_SCHEMA_VERSION = 1;
        const REMOTE_SECRET_DB_NAME = "agent-relay-secrets";
        const REMOTE_SECRET_STORE_NAME = "payload-secrets";
        const REMOTE_SECRET_KEY_STORE_NAME = "secret-keys";
        const relayProfile = {
          relayId,
          relayLabel: "Fake Relay",
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
        const truncatedText = `${fullText.slice(0, 1200)}...`;
        const threadSummary = {
          id: threadId,
          name: "Mobile Header E2E",
          preview: truncatedText,
          cwd: "/tmp/e2e-mobile-header",
          updated_at: 1,
          source: "codex",
          status: "completed",
          model_provider: "openai",
        };
        const truncatedSnapshot = {
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
          active_turn_id: "turn-e2e",
          current_status: "completed",
          active_flags: [],
          current_cwd: "/tmp/e2e-mobile-header",
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
          pending_approvals: [
            {
              request_id: "approval-mobile-header-e2e",
              thread_id: threadId,
              kind: "exec",
              summary: "Run command?",
              detail: "The test fixture keeps a visible header alert beside a long project name.",
              cwd: "/tmp/e2e-mobile-header",
              command: "echo mobile-header",
              supports_session_scope: false,
            },
          ],
          transcript_truncated: true,
          transcript: [
            {
              item_id: "item-long-1",
              kind: "user_text",
              text: truncatedText,
              status: "completed",
              turn_id: "turn-e2e",
              tool: null,
            },
          ],
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

        // Keep in step with broker-client.js. It drops a payload whose relay version it
        // does not know via `renderLog`, so a stale fixture reaches no console: the page
        // connects, sends its requests, and silently ignores every answer.
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
                payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot: truncatedSnapshot },
              });
            });
          }
          send(raw) {
            const frame = JSON.parse(raw);
            const payload = frame.payload;
            const request = payload?.request || {};
            if (request.type === "heartbeat") {
              this.#respond(payload.action_id, { action: "heartbeat", ok: true, snapshot: truncatedSnapshot });
              return;
            }
            if (request.type === "list_threads") {
              this.#respond(payload.action_id, {
                action: "list_threads",
                ok: true,
                snapshot: truncatedSnapshot,
                threads: { threads: [threadSummary] },
              });
              return;
            }
            if (request.type === "fetch_projects") {
              this.#respond(payload.action_id, {
                action: "fetch_projects",
                ok: true,
                snapshot: truncatedSnapshot,
                projects: {
                  projects_revision: 1,
                  projects: [{ id: projectId, name: projectName }],
                  thread_project_id: { [threadId]: projectId },
                },
              });
              return;
            }
            if (request.type === "fetch_thread_transcript") {
              this.#respond(payload.action_id, {
                action: "fetch_thread_transcript",
                ok: true,
                snapshot: truncatedSnapshot,
                thread_transcript: {
                  thread_id: threadId,
                  entries: [
                    {
                      item_id: "item-long-1",
                      kind: "user_text",
                      text: fullText,
                      status: "completed",
                      turn_id: "turn-e2e",
                      tool: null,
                    },
                  ],
                  prev_cursor: null,
                },
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
          #emit(frame) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
          }
        }
        window.WebSocket = FakeWebSocket;
      },
      {
        relayId: RELAY_ID,
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        projectName: PROJECT_NAME,
        fullText: FULL_TEXT,
      }
    );

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, { timeout: TIMEOUT_MS });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const t = document.querySelector("#remote-transcript")?.textContent || "";
      return t.includes("MOBILE-HEADER-TAIL-E2E");
    }, null, { timeout: TIMEOUT_MS });
    await page.waitForSelector(".remote-chat-shell .project-switcher-trigger", { timeout: TIMEOUT_MS });
    await page.click(".remote-chat-shell .project-switcher-trigger");
    await page
      .locator(".remote-chat-shell .project-switcher-option", { hasText: PROJECT_NAME })
      .first()
      .click({ timeout: TIMEOUT_MS });
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".remote-chat-shell .project-switcher-trigger")?.textContent?.includes(expected),
      PROJECT_NAME,
      { timeout: TIMEOUT_MS }
    );
    await page.waitForTimeout(400);

    // Force the worst case: try to scroll the page itself to the bottom, and
    // scroll the transcript to the bottom. A correct layout keeps the page from
    // scrolling at all and confines scrolling to the inner transcript.
    await page.evaluate(() => {
      const se = document.scrollingElement || document.documentElement;
      se.scrollTop = se.scrollHeight;
      const t = document.querySelector("#remote-transcript");
      if (t) t.scrollTop = t.scrollHeight;
    });
    await page.waitForTimeout(250);

    const layout = await readLayout(page);

    assert.equal(
      layout.navMode,
      "drawer",
      `expected mobile drawer nav mode at ${MOBILE_VIEWPORT.width}px, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.burgerVisible,
      `expected the nav burger toggle to be visible, got ${JSON.stringify(layout)}`
    );
    assert.equal(
      layout.headerTitle,
      PROJECT_NAME,
      `expected the mobile header switcher to render the selected project, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.infoVisible,
      `expected the session details button to stay visible beside the title, got ${JSON.stringify(layout)}`
    );
    assert.equal(
      layout.statusText,
      "Approval",
      `expected a visible compact approval badge in the crowded header, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.statusVisible,
      `expected the compact status badge to stay visible beside the title, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.titleRight != null &&
        layout.statusLeft != null &&
        layout.titleRight <= layout.statusLeft + 2,
      `expected the project title to truncate before the status badge, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.statusRight != null &&
        layout.infoLeft != null &&
        layout.statusRight <= layout.infoLeft + 2,
      `expected the status badge to stay before the info button, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.transcriptScrollHeight != null &&
        layout.transcriptClientHeight != null &&
        layout.transcriptScrollHeight > layout.transcriptClientHeight + 50,
      `expected the transcript to overflow its own bounded scroll area, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.pageScrollTop <= 2,
      `expected the page itself NOT to scroll (header must stay fixed), got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.headerTop != null && Math.abs(layout.headerTop) <= 2,
      `expected the chat header to stay pinned at the top after scrolling, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.burgerTop != null && layout.burgerTop >= 0 && layout.burgerTop <= MOBILE_VIEWPORT.height,
      `expected the nav burger to remain within the viewport after scrolling, got ${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.transcriptScrollTop != null && layout.transcriptScrollTop > 50,
      `expected scrolling to move the inner transcript (not the page), got ${JSON.stringify(layout)}`
    );

    // Desktop header-band sync must not stretch the drawer brand row. Open the
    // nav drawer and prove the Sealwire row stays content-height (not ~67px).
    await page.tap("#remote-nav-toggle-button");
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
    const drawerBrand = await page.evaluate(() => {
      const bar = document.querySelector(".remote-app-shell .sidebar-top-bar");
      if (!bar) return null;
      const rect = bar.getBoundingClientRect();
      const band = getComputedStyle(document.documentElement)
        .getPropertyValue("--header-band-height")
        .trim();
      return {
        height: Math.round(rect.height * 100) / 100,
        headerBandHeight: band,
        minHeight: getComputedStyle(bar).minHeight,
        marginBottom: getComputedStyle(bar).marginBottom,
      };
    });
    assert.ok(drawerBrand, "expected the remote drawer brand row to be present");
    assert.ok(
      drawerBrand.height > 0 && drawerBrand.height <= 48,
      `drawer brand row must stay content-height, not the desktop header band — ${JSON.stringify(drawerBrand)}`
    );
    assert.equal(
      drawerBrand.minHeight,
      "0px",
      `drawer brand must clear desktop min-height — ${JSON.stringify(drawerBrand)}`
    );
    assert.equal(
      drawerBrand.marginBottom,
      "0px",
      `drawer brand must clear desktop stack-gap cancel — ${JSON.stringify(drawerBrand)}`
    );

    console.log(`remote-mobile-header-e2e OK ${JSON.stringify({ layout, drawerBrand })}`);
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "remote-mobile-header-e2e",
      remotePage: page,
      metadata: { origin, relayId: RELAY_ID, threadId: THREAD_ID, viewport: MOBILE_VIEWPORT },
    }).catch((artifactError) => {
      console.error(
        artifactError instanceof Error ? artifactError.stack || artifactError.message : String(artifactError)
      );
    });
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  }
}

function buildFullTranscriptText() {
  const segments = [];
  for (let index = 0; index < 220; index += 1) {
    segments.push(`MOBILE-HEADER-SEGMENT-${String(index).padStart(4, "0")}`);
  }
  segments.push(LONG_PROMPT_TAIL);
  return `Store this exact user message in the thread history.\n${segments.join(" ")}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
