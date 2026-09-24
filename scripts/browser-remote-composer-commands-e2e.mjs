// The composer's "/" menu on a phone, in a real browser.
//
// Two things jsdom cannot answer. The menu has to be reachable at 390px — a host
// rendered outside the composer box, or clipped by it, is a menu nobody can tap.
// And the remote composer is a CONTROLLED React input: the controller rewrites the
// field after committing a pill, and if that write does not reach React's tracker
// the next render puts the command text back underneath the pill. That failure is
// invisible to a DOM assertion on the node's own value — only a real render shows it.
//
// Needs the private build: a public checkout has no commands to offer, and the menu
// correctly never opens. Same lightweight fixture as the mobile header test — a
// static server over web/ with the relay WebSocket stubbed.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-composer-commands-e2e";
const PROJECT_ID = "project-mobile-header-e2e";
const PROJECT_NAME = "Mobile Project With A Very Long Header Name";
const LONG_PROMPT_TAIL = "MOBILE-HEADER-TAIL-E2E";
const FULL_TEXT = buildFullTranscriptText();
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function readMenu(page) {
  return page.evaluate(() => {
    const box = document.querySelector(".composer-inner");
    const host = document.querySelector(".composer-command-host");
    const field = document.querySelector("#remote-message-input");
    const rows = [...document.querySelectorAll(".composer-command-menu [role='option'], .composer-command-menu li")];
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    };
    return {
      hostInsideBox: Boolean(host && box && box.contains(host)),
      hostRect: rect(host),
      fieldRect: rect(field),
      fieldValue: field ? field.value : null,
      // What the surface BELIEVES is in the field. The DOM alone cannot tell a correct
      // empty field from one React will refill on its next render, and the difference
      // is what gets sent as the next ordinary message.
      surfaceDraft: (() => {
        if (!field) return { found: false, value: null };
        const key = Object.keys(field).find((name) => name.startsWith("__reactProps$"));
        // Reported as not-found rather than as an empty value: an upgrade that renames
        // this key must fail as "this test can no longer see", not as "the bug is back".
        if (!key) return { found: false, value: null };
        return { found: true, value: field[key].value ?? null };
      })(),

      rowCount: rows.length,
      firstRowText: rows[0]?.textContent?.trim() || null,
      rowRect: rect(rows[0]),
      pills: [...document.querySelectorAll(".composer-command-pill")].map((p) => p.textContent.trim()),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

// Decided from the build, not from the page: a public checkout genuinely has no
// commands, and guessing that from "nothing opened" blames the build for a broken
// wiring — which is exactly what it did when the field stopped reaching the controller.
function isPublicBuild() {
  const controller = path.join(ROOT, "crates/sealwire-private/frontend/composer-command-controller.js");
  if (!existsSync(controller)) return true;
  return readFileSync(controller, "utf8").includes("Public-checkout placeholder");
}

async function main() {
  if (isPublicBuild()) {
    console.log(
      "remote-composer-commands-e2e SKIPPED — public checkout: the \"/\" commands are private. " +
        "Swap the private crate in (npm run dev:full, or scripts/with-private.sh), rebuild web/, and re-run."
    );
    return;
  }

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
          // No turn in flight: Send is gated on that, and a permanently disabled
          // button would make every assertion about sending pass for the wrong reason.
          active_turn_id: null,
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

        // What the fake relay currently reports; a test can move the session's folder.
        let liveSnapshot = truncatedSnapshot;

        class FakeWebSocket extends EventTarget {
          static OPEN = 1;
          constructor(url) {
            super();
            this.url = url;
            this.readyState = FakeWebSocket.OPEN;
            window.__fakeRelay = {
              moveSession: (patch) => {
                liveSnapshot = { ...truncatedSnapshot, ...patch };
                this.#emit({
                  type: "message",
                  payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot: liveSnapshot },
                });
              },
            };
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
                payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot: liveSnapshot },
              });
            });
          }
          send(raw) {
            const frame = JSON.parse(raw);
            const payload = frame.payload;
            const request = payload?.request || {};
            // The provider's own skills for this thread, including one that shares a
            // name with Sealwire's `/review`.
            if (request.type === "fetch_thread_skills") {
              this.#respond(payload.action_id, {
                action: "fetch_thread_skills",
                ok: true,
                thread_skills: {
                  thread_id: request.thread_id,
                  provider: "codex",
                  cwd: "/tmp/e2e-mobile-header",
                  source: "runtime",
                  invocation: "skill_input",
                  skills: [
                    {
                      name: "review",
                      description: "The repository's own review checklist, which is long enough to need truncating on a phone",
                      scope: "repo",
                      path: "/tmp/e2e-mobile-header/.agents/skills/review/SKILL.md",
                    },
                    {
                      name: "spreadsheets:Spreadsheets",
                      description: "Create and edit spreadsheets",
                      scope: "plugin",
                      origin: "spreadsheets@openai-primary-runtime",
                      path: "/home/.codex/plugins/spreadsheets/SKILL.md",
                    },
                  ],
                },
              });
              return;
            }
            if (request.type === "claim_challenge") {
              this.#respond(payload.action_id, {
                action: "claim_challenge",
                ok: true,
                claim_challenge_id: "challenge-e2e",
                claim_challenge: "challenge-bytes-e2e",
                claim_challenge_expires_at: Math.floor(Date.now() / 1000) + 60,
              });
              return;
            }
            if (request.type === "claim_device") {
              window.__claimedAt = Date.now();
              this.#respond(payload.action_id, {
                action: "claim_device",
                ok: true,
                session_claim: "session-claim-e2e",
                session_claim_expires_at: Math.floor(Date.now() / 1000) + 3600,
              });
              return;
            }
            if (request.type === "send_message") {
              window.__sentMessages = [...(window.__sentMessages || []), request];
              this.#respond(payload.action_id, { action: "send_message", ok: true, snapshot: liveSnapshot });
              return;
            }
            if (request.type === "heartbeat") {
              this.#respond(payload.action_id, { action: "heartbeat", ok: true, snapshot: liveSnapshot });
              return;
            }
            if (request.type === "list_threads") {
              if (window.__claimedAt) window.__listsAfterClaim = (window.__listsAfterClaim || 0) + 1;
              this.#respond(payload.action_id, {
                action: "list_threads",
                ok: true,
                snapshot: liveSnapshot,
                threads: { threads: [threadSummary] },
              });
              return;
            }
            if (request.type === "fetch_projects") {
              this.#respond(payload.action_id, {
                action: "fetch_projects",
                ok: true,
                snapshot: liveSnapshot,
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
                snapshot: liveSnapshot,
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
            // The surface drops a payload not stamped as the relay's, which a real broker
            // does; without this every answer below is silently ignored.
            const stamped =
              frame.type === "message"
                ? { from_role: "relay", from_peer_id: "relay-peer-e2e", ...frame }
                : frame;
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(stamped) }));
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
    await page.waitForSelector("#remote-message-input", { timeout: TIMEOUT_MS });
    // The claim answered at boot is followed by a re-sync that re-opens the session; a
    // draft typed while that is still landing is what the re-open replaces.
    await page.waitForFunction(() => (window.__listsAfterClaim || 0) > 0, null, { timeout: TIMEOUT_MS });
    await page.waitForTimeout(500);

    // Type the way a person does, so the controller's own input listener runs.
    await page.click("#remote-message-input");
    await page.type("#remote-message-input", "/", { delay: 30 });
    try {
      await page.waitForFunction(
        () => document.querySelectorAll(".composer-command-menu [role='option'], .composer-command-menu li").length > 0,
        null,
        { timeout: TIMEOUT_MS }
      );
    } catch (error) {
      const host = await page.$(".composer-command-host");
      throw new Error(
        host
          ? `the "/" host is mounted but no menu opened — the controller never bound the field: ${error.message}`
          : `the composer rendered no "/" host at all: ${error.message}`
      );
    }

    const open = await readMenu(page);
    assert.ok(
      open.hostInsideBox,
      `the "/" host must render inside the composer box, not as a banner above it — ${JSON.stringify(open)}`
    );
    assert.ok(
      open.rowRect && open.rowRect.width > 0 && open.rowRect.height > 0,
      `menu rows must have real size at ${MOBILE_VIEWPORT.width}px — ${JSON.stringify(open)}`
    );
    assert.ok(
      open.rowRect.top >= 0 && open.rowRect.top <= open.viewportHeight,
      `menu rows must be inside the viewport, not off-screen — ${JSON.stringify(open)}`
    );
    assert.ok(
      open.rowRect.left >= 0 && open.rowRect.left + open.rowRect.width <= open.viewportWidth + 2,
      `menu rows must not overflow the phone's width — ${JSON.stringify(open)}`
    );

    // Commit the first command, then prove the text the controller consumed does not
    // come back. This is the controlled-input bug: React re-renders from its own copy
    // of the draft, so a write it did not see is undone a frame later.
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll(".composer-command-pill").length > 0,
      null,
      { timeout: TIMEOUT_MS }
    );
    const committed = await readMenu(page);
    assert.ok(
      committed.pills.length > 0,
      `picking a row must commit a pill — ${JSON.stringify(committed)}`
    );
    assert.equal(
      committed.fieldValue,
      "",
      `the committed command must be consumed from the field — ${JSON.stringify(committed)}`
    );

    assert.ok(
      committed.surfaceDraft.found,
      "this test reads React's own copy of the draft through an internal key; it is gone, " +
        "so the check below can no longer see what it is asserting and must be rewritten"
    );
    assert.equal(
      committed.surfaceDraft.value,
      "",
      `the surface must agree the field is empty. Left holding the command text, the next \
ordinary message sends THAT instead of what the user types — ${JSON.stringify(committed)}`
    );

    // The provider's own skills sit beside Sealwire's commands. Peel the pill staged
    // above, then ask for the name both sides own.
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => !document.querySelector(".composer-command-pill"), null, {
      timeout: TIMEOUT_MS,
    });
    await page.type("#remote-message-input", "/rev", { delay: 30 });
    await page.waitForSelector(".composer-command-row.is-provider", { timeout: TIMEOUT_MS });
    const skillRows = await page.evaluate(() =>
      [...document.querySelectorAll(".composer-command-menu [role='option']")].map((row) => {
        const box = row.getBoundingClientRect();
        const origin = row.querySelector(".composer-command-origin");
        const originBox = origin?.getBoundingClientRect();
        return {
          name: row.querySelector(".composer-command-name")?.textContent || "",
          origin: origin?.textContent || "",
          mark: row.querySelector(".composer-command-mark")?.getAttribute("data-provider") || "",
          right: Math.round(box.right),
          originVisible: Boolean(originBox && originBox.width > 0 && originBox.right <= box.right + 1),
        };
      })
    );
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    assert.deepEqual(
      skillRows.map(({ name, origin, mark }) => ({ name, origin, mark })),
      [
        { name: "/review", origin: "Sealwire", mark: "" },
        { name: "$review", origin: "Repo", mark: "codex" },
      ],
      `Sealwire's /review and Codex's $review must be two labelled rows — ${JSON.stringify(skillRows)}`
    );
    for (const row of skillRows) {
      assert.ok(row.right <= viewportWidth + 2, `a row overflows the phone — ${JSON.stringify(row)}`);
      assert.ok(row.originVisible, `the origin label is clipped out of its row — ${JSON.stringify(row)}`);
    }
    if (process.env.SKILLS_SCREENSHOT) {
      await page.screenshot({ path: process.env.SKILLS_SCREENSHOT });
    }

    // The session moves folder under the open menu, with nothing typed. The Codex row
    // was listed for the old folder and must leave at once; Sealwire's stays.
    const menuRows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".composer-command-menu [role='option']")].map(
          (row) => row.querySelector(".composer-command-origin")?.textContent || ""
        )
      );
    await page.evaluate(() => window.__fakeRelay.moveSession({ current_cwd: "/tmp/e2e-elsewhere" }));
    await page.waitForFunction(
      () => !document.querySelector(".composer-command-row.is-provider"),
      null,
      { timeout: TIMEOUT_MS }
    );
    assert.deepEqual(await menuRows(), ["Sealwire"], "only Sealwire's row may stay on screen");
    assert.equal(await page.inputValue("#remote-message-input"), "/rev", "the draft is untouched");
    await page.evaluate(() => window.__fakeRelay.moveSession({ current_cwd: "/tmp/e2e-mobile-header" }));
    await page.waitForSelector(".composer-command-row.is-provider", { timeout: TIMEOUT_MS });

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".composer-command-pill")].some((p) => p.textContent.includes("$review")),
      null,
      { timeout: TIMEOUT_MS }
    );
    await page.type("#remote-message-input", "the parser", { delay: 10 });
    await page.click("#remote-send-button");
    await page.waitForFunction(() => (window.__sentMessages || []).length > 0, null, { timeout: TIMEOUT_MS });
    const sent = await page.evaluate(() => window.__sentMessages[0]);
    assert.equal(sent.input.text, "the parser", `the words go as the message — ${JSON.stringify(sent)}`);
    assert.deepEqual(
      sent.skill,
      { name: "review", path: "/tmp/e2e-mobile-header/.agents/skills/review/SKILL.md" },
      `the picked skill rides beside the text, by path — ${JSON.stringify(sent)}`
    );
    await page.waitForFunction(() => !document.querySelector(".composer-command-pill"), null, {
      timeout: TIMEOUT_MS,
    });

    console.log(`remote-composer-commands-e2e OK ${JSON.stringify({ open, committed, skillRows, sent })}`);
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "remote-composer-commands-e2e",
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
