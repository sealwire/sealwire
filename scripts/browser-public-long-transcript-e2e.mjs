import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-long-transcript-e2e";
const LONG_PROMPT_TAIL = "LONG-HYDRATE-TAIL-REMOTE-E2E";
const FULL_TEXT = buildFullTranscriptText();

async function main() {
  const server = await startStaticServer();
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.addInitScript(
      ({ relayId, threadId, fullText }) => {
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
          name: "Long Transcript E2E",
          preview: truncatedText,
          cwd: "/tmp/e2e-long-transcript",
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
          current_cwd: "/tmp/e2e-long-transcript",
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
            remoteProfiles: {
              [relayId]: relayProfile,
            },
          })
        );

        window.__agentRelayFetchThreadTranscriptCount = 0;
        window.__agentRelayFakeSnapshotCount = 0;
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
                peer_id: "surface-e2e",
                channel_id: "room-e2e",
                peers: [{ peer_id: "relay-peer-e2e", role: "relay" }],
              });
              this.#emit({
                type: "presence",
                kind: "joined",
                peer: { peer_id: "relay-peer-e2e", role: "relay" },
              });
            });
          }

          send(raw) {
            const frame = JSON.parse(raw);
            const payload = frame.payload;
            const request = payload?.request || {};

            if (request.type === "heartbeat") {
              window.__agentRelayFakeSnapshotCount += 1;
              this.#respond(payload.action_id, {
                action: "heartbeat",
                ok: true,
                snapshot: truncatedSnapshot,
              });
              return;
            }

            if (request.type === "list_threads") {
              this.#respond(payload.action_id, {
                action: "list_threads",
                ok: true,
                snapshot: truncatedSnapshot,
                threads: {
                  threads: [threadSummary],
                },
              });
              return;
            }

            if (request.type === "fetch_thread_transcript") {
              const cursor = request.input?.cursor || 0;
              window.__agentRelayFetchThreadTranscriptCount += 1;
              this.#respond(payload.action_id, {
                action: "fetch_thread_transcript",
                ok: true,
                snapshot: truncatedSnapshot,
                thread_transcript: {
                  thread_id: threadId,
                  chunks:
                    cursor === 0
                      ? [
                          {
                            entry_index: 0,
                            item_id: "item-long-1",
                            kind: "user_text",
                            text: fullText.slice(0, 4000),
                            status: "completed",
                            turn_id: "turn-e2e",
                            tool: null,
                            chunk_index: 0,
                            chunk_count: 2,
                          },
                        ]
                      : [
                          {
                            entry_index: 0,
                            item_id: "item-long-1",
                            kind: "user_text",
                            text: fullText.slice(4000),
                            status: "completed",
                            turn_id: "turn-e2e",
                            tool: null,
                            chunk_index: 1,
                            chunk_count: 2,
                          },
                        ],
                  next_cursor: cursor === 0 ? 1 : null,
                },
              });

              if (cursor !== 0) {
                setTimeout(() => {
                  window.__agentRelayFakeSnapshotCount += 1;
                  this.#emit({
                    type: "message",
                    payload: {
                      kind: "session_snapshot",
                      snapshot: truncatedSnapshot,
                    },
                  });
                }, 50);
              }
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
                kind: "remote_action_result",
                action_id: actionId,
                ...result,
              },
            });
          }

          #emit(frame) {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify(frame),
              })
            );
          }
        }

        window.WebSocket = FakeWebSocket;
      },
      {
        relayId: RELAY_ID,
        threadId: THREAD_ID,
        fullText: FULL_TEXT,
      }
    );

    await page.goto(`${origin}/remote.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, {
      timeout: TIMEOUT_MS,
    });
    await page.reload({ waitUntil: "domcontentloaded" });

    try {
      await page.waitForFunction(() => {
        const transcript = document.querySelector("#remote-transcript")?.textContent || "";
        return transcript.includes("LONG-HYDRATE-TAIL-REMOTE-E2E");
      }, null, { timeout: TIMEOUT_MS });

      await page.waitForFunction(() => {
        return (
          Number(window.__agentRelayFetchThreadTranscriptCount || 0) >= 2 &&
          Number(window.__agentRelayFakeSnapshotCount || 0) >= 2
        );
      }, null, { timeout: TIMEOUT_MS });

      const transcriptText = (await page.textContent("#remote-transcript")) || "";
      assert.ok(transcriptText.includes(LONG_PROMPT_TAIL));
      const layout = await page.evaluate(() => {
        const composer = document.querySelector("#remote-message-form");
        const transcript = document.querySelector("#remote-transcript");
        const shell = document.querySelector(".remote-chat-shell");
        const composerRect = composer?.getBoundingClientRect();
        const transcriptRect = transcript?.getBoundingClientRect();
        const shellRect = shell?.getBoundingClientRect();
        return {
          viewportHeight: window.innerHeight,
          composerTop: composerRect?.top ?? null,
          composerBottom: composerRect?.bottom ?? null,
          transcriptTop: transcriptRect?.top ?? null,
          transcriptBottom: transcriptRect?.bottom ?? null,
          transcriptClientHeight: transcript?.clientHeight ?? null,
          transcriptScrollHeight: transcript?.scrollHeight ?? null,
          shellBottom: shellRect?.bottom ?? null,
        };
      });
      assert.ok(
        layout.composerBottom != null &&
          layout.viewportHeight != null &&
          layout.composerBottom <= layout.viewportHeight + 2,
        `expected remote composer to stay inside the viewport, got ${JSON.stringify(layout)}`
      );
      assert.ok(
        layout.composerTop != null &&
          layout.transcriptBottom != null &&
          layout.composerTop >= layout.transcriptBottom - 2,
        `expected transcript to end above the remote composer, got ${JSON.stringify(layout)}`
      );
      assert.ok(
        layout.transcriptScrollHeight != null &&
          layout.transcriptClientHeight != null &&
          layout.transcriptScrollHeight > layout.transcriptClientHeight,
        `expected transcript to scroll independently when long, got ${JSON.stringify(layout)}`
      );

      console.log(
        JSON.stringify(
          {
            fetchThreadTranscriptCount: await page.evaluate(
              () => window.__agentRelayFetchThreadTranscriptCount || 0
            ),
            fakeSnapshotCount: await page.evaluate(
              () => window.__agentRelayFakeSnapshotCount || 0
            ),
            layout,
            transcriptTail: transcriptText.slice(-160),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            fetchThreadTranscriptCount: await page.evaluate(
              () => window.__agentRelayFetchThreadTranscriptCount || 0
            ),
            fakeSnapshotCount: await page.evaluate(
              () => window.__agentRelayFakeSnapshotCount || 0
            ),
            remoteState: await page.evaluate(() =>
              window.localStorage.getItem("agent-relay.remote-state")
            ),
            socketType: await page.evaluate(() => String(window.WebSocket)),
            secretReady: await page.evaluate(() => window.__agentRelaySecretReady === true),
            transcriptText: (await page.textContent("#remote-transcript")) || "",
            clientLog: (await page.textContent("#remote-client-log")) || "",
            sessionToggle: (await page.textContent("#remote-session-toggle")) || "",
          },
          null,
          2
        )
      );
      throw error;
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.server.close(resolve));
  }
}

function buildFullTranscriptText() {
  const segments = [];
  for (let index = 0; index < 220; index += 1) {
    segments.push(`LONG-HYDRATE-SEGMENT-${String(index).padStart(4, "0")}`);
  }
  segments.push(LONG_PROMPT_TAIL);
  return `Store this exact user message in the thread history.\n${segments.join(" ")}`;
}

async function startStaticServer() {
  const port = await getFreePort();
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const relativePath = resolveWebPath(requestUrl.pathname);
    let filePath = path.join(WEB_ROOT, relativePath);
    if (!filePath.startsWith(WEB_ROOT)) {
      response.writeHead(403).end("forbidden");
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentType(filePath),
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return { port, server };
}

function resolveWebPath(pathname) {
  if (pathname === "/") {
    return "index.html";
  }
  if (pathname === "/manifest.webmanifest") {
    return "remote-manifest.webmanifest";
  }
  if (pathname.startsWith("/static/assets/")) {
    return pathname.replace(/^\/static\//, "");
  }
  if (pathname === "/static/icon.svg") {
    return "icon.svg";
  }
  if (pathname === "/static/remote-sw.js") {
    return "remote-sw.js";
  }
  return pathname.replace(/^\/+/, "");
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  return "application/octet-stream";
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
