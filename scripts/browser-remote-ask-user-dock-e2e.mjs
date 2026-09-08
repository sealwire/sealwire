// The phone half of the docked question card.
//
// On a 390x844 screen the card has to be reachable without scrolling and must
// not eat the composer: the transcript gives way, not the input. Docking it also
// has to survive this surface's own layout, which is a different flex column
// from the desktop one — so this is measured in a real browser rather than
// argued from the cascade.
//
// Lightweight like browser-remote-mobile-header-e2e.mjs: the built web/ bundle
// over a static server with a stubbed relay socket — no relay, broker or worker.
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-ask-user-e2e";
const THREAD_ID = "thread-ask-user-dock-e2e";
const TRAILING_TEXT = "Meanwhile, here is some context.";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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
  let browser;
  let context;
  let page;

  try {
    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: MOBILE_VIEWPORT, hasTouch: true, isMobile: true },
    }));
    page = await context.newPage();
    attachPageDebugLogging(page, "remote", { prefix: "remote-ask-user-dock-e2e" });

    await page.addInitScript(
      ({ relayId, threadId, trailingText }) => {
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
        const questions = [
          {
            question: "Which approach?",
            header: "Approach",
            multi_select: false,
            options: [
              { label: "Option A", description: "Take the direct route" },
              { label: "Option B", description: "Take the careful route" },
            ],
          },
          {
            question: "Which surface?",
            header: "Surface",
            multi_select: false,
            options: [
              { label: "Local", description: "" },
              { label: "Remote", description: "" },
            ],
          },
        ];
        const threadSummary = {
          id: threadId,
          name: "Ask User Dock E2E",
          preview: "a question is pending",
          cwd: "/tmp/e2e-ask-user-dock",
          updated_at: 1,
          source: "claude_code",
          status: "active",
          model_provider: "anthropic",
        };
        const snapshot = {
          provider: "claude_code",
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
          current_status: "active",
          active_flags: ["waitingOnAskUser"],
          current_cwd: "/tmp/e2e-ask-user-dock",
          projects_revision: 1,
          model: "claude-sonnet-4-6",
          available_models: [],
          approval_policy: "never",
          sandbox: "workspace-write",
          reasoning_effort: "medium",
          allowed_roots: [],
          device_records: [],
          paired_devices: [],
          pending_pairing_requests: [],
          pending_approvals: [],
          pending_ask_user_questions: [
            {
              request_id: "ask-dock-e2e",
              tool_use_id: "toolu-dock-e2e",
              thread_id: threadId,
              requested_at: 1,
              question_count: questions.length,
              questions_inline_complete: true,
              detail_available: false,
              questions,
            },
          ],
          transcript_truncated: false,
          transcript: [
            {
              item_id: "item-user-1",
              kind: "user_text",
              text: "pick something for me",
              status: "completed",
              turn_id: "turn-e2e",
              tool: null,
            },
            {
              item_id: "tool:toolu-dock-e2e",
              kind: "tool_call",
              text: null,
              status: "running",
              turn_id: "turn-e2e",
              tool: {
                name: "AskUserQuestion",
                input_preview: JSON.stringify({ questions }),
              },
            },
            {
              item_id: "item-trailing-1",
              kind: "agent_text",
              text: trailingText,
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

        window.__askUserSubmissions = [];
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

        let answered = false;
        const currentSnapshot = () =>
          answered ? { ...snapshot, pending_ask_user_questions: [], active_flags: [] } : snapshot;

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
                payload: {
                  protocol_version: RELAY_PROTOCOL_VERSION,
                  kind: "session_snapshot",
                  snapshot,
                },
              });
            });
          }
          send(raw) {
            const frame = JSON.parse(raw);
            const payload = frame.payload;
            const request = payload?.request || {};
            if (request.type === "submit_ask_user_answer") {
              window.__askUserSubmissions.push(request);
              // The relay drops the question the moment the provider takes the
              // answer, so the stub must too — otherwise the test can never see
              // the dock clear, and would pass with the clearing removed.
              answered = true;
              this.#respond(payload.action_id, {
                action: "submit_ask_user_answer",
                ok: true,
                snapshot: currentSnapshot(),
                ask_user_answer_receipt: { request_id: request.request_id, message: "Answer sent." },
              });
              this.#emit({
                type: "message",
                payload: {
                  protocol_version: RELAY_PROTOCOL_VERSION,
                  kind: "session_snapshot",
                  snapshot: currentSnapshot(),
                },
              });
              return;
            }
            if (request.type === "heartbeat") {
              this.#respond(payload.action_id, {
                action: "heartbeat",
                ok: true,
                snapshot: currentSnapshot(),
              });
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
                projects: { projects_revision: 1, projects: [], thread_project_id: {} },
              });
              return;
            }
            if (request.type === "fetch_thread_transcript") {
              this.#respond(payload.action_id, {
                action: "fetch_thread_transcript",
                ok: true,
                snapshot,
                thread_transcript: {
                  thread_id: threadId,
                  entries: snapshot.transcript,
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
      },
      { relayId: RELAY_ID, threadId: THREAD_ID, trailingText: TRAILING_TEXT }
    );

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, {
      timeout: TIMEOUT_MS,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".ask-user-dock .ask-user-option-button", { timeout: TIMEOUT_MS });

    const layout = await page.evaluate(() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      };
      const scroller = document.querySelector("#remote-transcript");
      const live = document.querySelector(".chat-message-ask-user-interactive");
      const composer = document.querySelector("#remote-message-form");
      const option = document.querySelector(".ask-user-dock .ask-user-option-button");
      return {
        viewport: window.innerHeight,
        liveCards: document.querySelectorAll(".chat-message-ask-user-interactive").length,
        liveInScroller: Boolean(scroller && live && scroller.contains(live)),
        liveInDock: Boolean(live?.closest(".ask-user-dock")),
        optionsInScroller: scroller
          ? scroller.querySelectorAll(".ask-user-option-button").length
          : -1,
        recordInScroller: scroller
          ? scroller.querySelectorAll(".chat-message-ask-user").length
          : -1,
        scroller: rect(scroller),
        dock: rect(document.querySelector(".ask-user-dock")),
        option: rect(option),
        composer: rect(composer),
      };
    });
    console.log(`[remote-ask-user-dock] ${JSON.stringify(layout)}`);

    assert.equal(layout.liveCards, 1, "the question must be live in exactly one place");
    assert.equal(layout.liveInScroller, false, "the live card must be outside the transcript");
    assert.ok(layout.liveInDock, "the live card belongs to the dock");
    assert.equal(
      layout.optionsInScroller,
      0,
      "the conversation must not show options that cannot be tapped"
    );
    assert.equal(layout.recordInScroller, 1, "the record of the ask stays in the conversation");
    assert.ok(
      layout.option.top >= 0 && layout.option.bottom <= layout.viewport,
      `the first option must be on screen without scrolling `
      + `(option ${layout.option.top}-${layout.option.bottom}, viewport ${layout.viewport})`
    );
    assert.ok(
      layout.composer.bottom <= layout.viewport + 1 && layout.composer.top >= layout.dock.bottom - 1,
      `the composer must stay below the dock and on screen `
      + `(dock ends ${layout.dock.bottom}, composer ${layout.composer.top}-${layout.composer.bottom})`
    );
    assert.ok(
      layout.scroller.h > 120,
      `the conversation must keep usable height beside the card (got ${layout.scroller.h})`
    );

    // A real tap, not a synthetic click: this is the gesture that was being lost.
    await page.tap(".ask-user-dock .ask-user-option-button");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".ask-user-dock .ask-user-option-button")
          ?.getAttribute("aria-pressed") === "true",
      null,
      { timeout: TIMEOUT_MS }
    );

    // Finish the wizard: without this the test would pass with the submit path
    // deleted, which is most of what a reader needs the card for.
    await page.tap(".ask-user-dock .ask-user-wizard-next");
    await page.waitForFunction(
      () => document.querySelector(".ask-user-dock")?.textContent?.includes("Which surface?"),
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.tap(".ask-user-dock .ask-user-option-button");
    await page.tap(".ask-user-dock .ask-user-submit-button");
    await page.waitForFunction(() => window.__askUserSubmissions.length > 0, null, {
      timeout: TIMEOUT_MS,
    });
    const submissions = await page.evaluate(() => window.__askUserSubmissions);
    console.log(`[remote-ask-user-dock] submitted ${JSON.stringify(submissions)}`);
    assert.equal(submissions.length, 1, "one answer, sent once");
    assert.equal(submissions[0].request_id, "ask-dock-e2e");
    assert.deepEqual(
      submissions[0].input?.answers,
      { "Which approach?": "Option A", "Which surface?": "Local" },
      "both questions must be answered with what was tapped"
    );

    // Answered means gone: the card must leave the dock, and the conversation
    // must keep the record of the ask.
    await page.waitForFunction(
      () => !document.querySelector(".ask-user-dock .chat-message-ask-user-interactive"),
      null,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await page.locator(".chat-thread .chat-message-ask-user").count(),
      1,
      "the answered question stays in the conversation as a record"
    );

    if (process.env.REMOTE_ASK_USER_E2E_SHOT) {
      await page.screenshot({ path: process.env.REMOTE_ASK_USER_E2E_SHOT });
      console.log(`[remote-ask-user-dock] screenshot ${process.env.REMOTE_ASK_USER_E2E_SHOT}`);
    }

    console.log(JSON.stringify({ ok: true, viewport: MOBILE_VIEWPORT }, null, 2));
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "remote-ask-user-dock",
      remotePage: page,
      metadata: { origin },
    }).catch(() => {});
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

await main();
