// The remote New session dialog's two pickers, on a phone and on a desktop.
//
// The model menu must list models you can actually pick. Every fix for it so far
// was verified on the LOCAL surface, whose dialog is fed by a REST catalogue
// fetch; remote feeds the same component from the broker socket, and no browser
// spec ever opened its menu — the one remote spec that touches this dialog asks
// for a model with `modelOptional: true`, so an empty menu polls for 15s and then
// walks on. That is how an empty menu shipped three times.
//
// The workspace panel must not take the caret on a touch device, where doing so
// raises the software keyboard over the rows it just opened.
//
// A start the relay refuses must leave the dialog open with the relay's reason on
// screen. It used to close on click and log the reason where nobody looks.
//
// Deliberately lightweight: it serves the built web/ bundle over a static server
// and stubs the relay WebSocket — no relay / broker / worker process.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import {
  fillStartSessionDialog,
  waitForVisibleStartRefusal,
} from "./e2e/harness/start-session-dialog.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
// The broker handshake is a network round trip; the payload secret is a local
// IndexedDB read. Boot work that fires on the secret alone therefore runs BEFORE
// the socket opens, which is the state this spec puts the page in.
const SOCKET_OPEN_DELAY_MS = Number(process.env.FAKE_SOCKET_OPEN_DELAY_MS || 300);
const RELAY_ID = "relay-e2e";
const REFUSED_CWD = "/tmp/e2e-outside-roots";
const REFUSAL = `workspace ${REFUSED_CWD} is outside this relay's allowed roots; choose a directory under /tmp/e2e-model-picker`;
const THREAD_ID = "thread-model-picker-e2e";
const PROJECT_NAMES = [
  "Operation", "RN", "Small improvement", "UI Redesign", "poker",
  "企业code 和cloud orchestration", "神仙教母", "金融", "长任务",
  "Research", "Documentation", "Release planning", "Mobile app",
  "Design system", "Infrastructure", "Customer support",
];

const CODEX_MODELS = [
  { model: "gpt-5.5", display_name: "GPT-5.5", is_default: true },
  { model: "gpt-5.5-codex", display_name: "GPT-5.5 Codex" },
  { model: "gpt-5.4", display_name: "GPT-5.4" },
];
const CLAUDE_MODELS = [
  { model: "claude-opus-4-6", display_name: "Opus 4.6", is_default: true },
  { model: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
];

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
  console.log(`[remote-new-session-menus-e2e] ${message}${suffix}`);
}

// A row that exists in the DOM is not a row you can tap: read the menu's box and
// hit-test its first row, so a menu painted as a clipped strip fails here.
function readModelMenu() {
  const menu = document.querySelector("#remote-start-session-dialog .setting-pill-menu")
    || document.querySelector(".setting-pill-menu");
  if (!menu) {
    return { present: false };
  }
  const rows = [...menu.querySelectorAll(".setting-pill-option")].map((option) => ({
    label: option.textContent?.trim() || "",
    provider: option.dataset.provider || "",
    value: option.dataset.value || "",
  }));
  const box = menu.getBoundingClientRect();
  const first = menu.querySelector(".setting-pill-option");
  const firstBox = first?.getBoundingClientRect();
  const hit = firstBox
    ? document.elementFromPoint(
        Math.round(firstBox.left + firstBox.width / 2),
        Math.round(firstBox.top + firstBox.height / 2)
      )
    : null;
  return {
    present: true,
    emptyNote: menu.querySelector(".setting-pill-section-empty")?.textContent?.trim() || null,
    height: Math.round(box.height),
    firstRowReachable: Boolean(first && hit && (first === hit || first.contains(hit))),
    rows,
    sections: menu.querySelectorAll(".setting-pill-section").length,
    width: Math.round(box.width),
  };
}

async function openModelMenu(page, { touch }) {
  const trigger = page.locator("#remote-start-session-dialog-model");
  await trigger.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  if (touch) {
    await trigger.tap();
  } else {
    await trigger.click();
  }
  // The pill asks its host to refresh a missing catalogue as it opens, so give
  // that round trip room before reading the menu.
  await page.waitForTimeout(1200);
  return page.evaluate(readModelMenu);
}

// Where the caret went, and whether the rows are readable — the two things the
// software keyboard takes away. Chromium has no keyboard to raise, so the caret is
// the observable proxy for it.
async function openWorkspacePanel(page, { touch }) {
  const trigger = page.locator("#remote-start-session-dialog .workspace-picker-trigger");
  await trigger.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  if (touch) {
    await trigger.tap();
  } else {
    await trigger.click();
  }
  await page.waitForSelector("#remote-start-session-dialog .workspace-picker-panel", {
    state: "visible",
    timeout: TIMEOUT_MS,
  });
  return page.evaluate(() => {
    const input = document.querySelector("#remote-start-session-dialog .workspace-picker-input");
    return {
      coarsePointer: !window.matchMedia("(pointer: fine)").matches,
      inputFocused: Boolean(input) && document.activeElement === input,
      inputPresent: Boolean(input),
    };
  });
}

async function assertPhoneProjectMenuScrolls(page) {
  const within = "#remote-start-session-dialog";
  await page.locator(`${within} .project-picker-trigger`).tap();
  const menu = page.locator(`${within} .project-switcher-menu`);
  await menu.waitFor({ state: "visible", timeout: TIMEOUT_MS });
  await menu.locator('[data-project-id="project-15"]').waitFor();

  const initial = await menu.evaluate((node) => {
    const rows = [...node.querySelectorAll(".project-switcher-option")];
    const boxes = rows.map((row) => row.getBoundingClientRect());
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY,
      overlappingRows: boxes.slice(1).filter((box, index) => box.top < boxes[index].bottom - 0.5).length,
    };
  });
  assert.ok(initial.scrollHeight > initial.clientHeight, `project menu must scroll: ${JSON.stringify(initial)}`);
  assert.equal(initial.overflowY, "auto");
  assert.equal(initial.overlappingRows, 0, `project rows overlap: ${JSON.stringify(initial)}`);

  await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const bottom = await menu.evaluate((node) => {
    const last = node.lastElementChild;
    const box = last.getBoundingClientRect();
    const menuBox = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      scrollTop: node.scrollTop,
      lastVisible: box.bottom <= menuBox.bottom + 1,
      lastReachable: hit === last || last.contains(hit),
    };
  });
  assert.ok(bottom.scrollTop > 0 && bottom.lastVisible && bottom.lastReachable,
    `bottom of project menu is unreachable: ${JSON.stringify(bottom)}`);
  await menu.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const shot = path.join(os.tmpdir(), "remote-project-picker-phone.png");
  await page.screenshot({ path: shot });
  await menu.locator('[data-project-id="project-15"]').tap();
  assert.match(await page.locator(`${within} .project-picker-trigger`).getAttribute("aria-label"), /Customer support/);
  logStep("phone project menu scrolls", { ...initial, ...bottom, shot });
}

async function runPass(browser, profile, name) {
  const context = await browser.newContext(profile);
  const page = await context.newPage();
  attachPageDebugLogging(page, name, { prefix: "remote-new-session-menus-e2e" });
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
    for (const [name, profile] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      ({ context, page } = await runPass(browser, profile, name));

      await page.addInitScript(
        ({ claudeModels, codexModels, openDelayMs, projectNames, refusal, relayId, threadId }) => {
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
          const threadSummary = {
            id: threadId,
            name: "Model Picker E2E",
            preview: "seeded",
            cwd: "/tmp/e2e-model-picker",
            updated_at: 1,
            source: "codex",
            status: "completed",
            model_provider: "openai",
          };
          const projects = projectNames.map((name, index) => ({ id: `project-${index}`, name }));
          const projectThreads = projects.map((project, index) => ({
            ...threadSummary,
            id: `thread-project-${index}`,
            name: project.name,
            updated_at: Math.floor(Date.now() / 1000),
          }));
          const threadProjectId = Object.fromEntries(projects.map((project, index) => [
            `thread-project-${index}`, project.id,
          ]));
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
            current_cwd: "/tmp/e2e-model-picker",
            projects_revision: 1,
            model: "gpt-5.5",
            // The live session's own catalogue. It fills `providerModels` for the
            // chip label without ever filling the PROVIDER list, which is what
            // makes a broken menu still read "Codex · GPT-5.5" on its trigger.
            available_models: codexModels,
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

          // Counted so a failure can say whether the page ever ASKED for the
          // catalogue — "never asked" and "asked and dropped it" are different bugs.
          window.__brokerCalls = [];

          class FakeWebSocket extends EventTarget {
            static OPEN = 1;
            constructor(url) {
              super();
              this.url = url;
              // CONNECTING until the handshake lands, exactly like the real one.
              this.readyState = 0;
              setTimeout(() => {
                this.readyState = FakeWebSocket.OPEN;
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
              }, openDelayMs);
            }
            send(raw) {
              const frame = JSON.parse(raw);
              const payload = frame.payload;
              const request = payload?.request || {};
              window.__brokerCalls.push(request.type);
              const respond = (result) => this.#respond(payload.action_id, result);
              if (request.type === "heartbeat") {
                respond({ action: "heartbeat", ok: true, snapshot });
                return;
              }
              if (request.type === "list_providers") {
                respond({
                  action: "list_providers",
                  ok: true,
                  providers: ["codex", "claude_code"],
                  snapshot,
                });
                return;
              }
              if (request.type === "list_provider_models") {
                respond({
                  action: "list_provider_models",
                  ok: true,
                  models: request.provider === "claude_code" ? claudeModels : codexModels,
                  snapshot,
                });
                return;
              }
              if (request.type === "list_threads") {
                respond({
                  action: "list_threads",
                  ok: true,
                  snapshot,
                  threads: { threads: [threadSummary, ...projectThreads] },
                });
                return;
              }
              if (request.type === "fetch_projects") {
                respond({
                  action: "fetch_projects",
                  ok: true,
                  snapshot,
                  projects: { projects_revision: 1, projects, thread_project_id: threadProjectId },
                });
                return;
              }
              if (request.type === "start_session") {
                respond({ action: "start_session", ok: false, error: refusal });
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
            #emit(rawFrame) {
              // The surface drops a payload not stamped as the relay's, as a real broker does.
              const frame =
                rawFrame.type === "message"
                  ? { from_role: "relay", from_peer_id: "relay-peer-e2e", ...rawFrame }
                  : rawFrame;
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
            }
          }
          window.WebSocket = FakeWebSocket;
        },
        {
          claudeModels: CLAUDE_MODELS,
          codexModels: CODEX_MODELS,
          openDelayMs: SOCKET_OPEN_DELAY_MS,
          projectNames: PROJECT_NAMES,
          refusal: REFUSAL,
          relayId: RELAY_ID,
          threadId: THREAD_ID,
        }
      );

      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, {
        timeout: TIMEOUT_MS,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#remote-session-toggle", { timeout: TIMEOUT_MS });
      logStep(`${name} loaded`, profile.viewport);

      // At phone width the New session button lives in the slide-in nav drawer.
      if (profile.isMobile) {
        await page.waitForSelector("#remote-nav-toggle-button", {
          state: "visible",
          timeout: TIMEOUT_MS,
        });
        await page.click("#remote-nav-toggle-button");
        await page.waitForSelector("#remote-session-toggle", {
          state: "visible",
          timeout: TIMEOUT_MS,
        });
        // The drawer slides; a click mid-transform lands somewhere else.
        await page.waitForTimeout(500);
      }
      await page.click("#remote-session-toggle");
      await page.waitForFunction(
        () => Boolean(document.getElementById("remote-start-session-dialog")?.open),
        null,
        { timeout: TIMEOUT_MS }
      );
      logStep(`${name} dialog open`);

      if (profile.isMobile) {
        await assertPhoneProjectMenuScrolls(page);
      }

      const menu = await openModelMenu(page, { touch: profile.hasTouch });
      const calls = await page.evaluate(() => window.__brokerCalls);
      logStep(`${name} model menu`, { calls, menu });

      assert.ok(menu.present, `[${name}] the Model pill opened no menu at all`);
      assert.ok(
        menu.rows.length >= CODEX_MODELS.length,
        `[${name}] the model menu must list the relay's catalogue, got ${JSON.stringify(menu)}`
      );
      assert.ok(
        menu.rows.some((row) => row.value === "gpt-5.5" && row.provider === "codex"),
        `[${name}] the selected model must be listed under its provider, got ${JSON.stringify(menu.rows)}`
      );
      assert.ok(
        menu.firstRowReachable,
        `[${name}] the first model row must be hit-testable, got ${JSON.stringify(menu)}`
      );

      await page.keyboard.press("Escape");
      const workspace = await openWorkspacePanel(page, { touch: profile.hasTouch });
      logStep(`${name} workspace panel`, workspace);

      assert.ok(workspace.inputPresent, `[${name}] the workspace search field must still be there`);
      assert.equal(
        workspace.coarsePointer,
        Boolean(profile.isMobile),
        `[${name}] the emulated profile must report the pointer this pass is about`
      );
      assert.equal(
        workspace.inputFocused,
        !profile.isMobile,
        `[${name}] a touch device must not take the caret on open (and a mouse must), got ${JSON.stringify(workspace)}`
      );

      // The workspace panel is still open with its field showing, so this types into it.
      await fillStartSessionDialog(page, {
        dialogId: "remote-start-session-dialog",
        cwd: REFUSED_CWD,
        approvalPolicy: null,
        timeout: TIMEOUT_MS,
      });
      const refusal = await waitForVisibleStartRefusal(page, {
        dialogId: "remote-start-session-dialog",
        text: REFUSAL,
        timeout: TIMEOUT_MS,
      });
      const shot = path.join(os.tmpdir(), `remote-start-refusal-${name}.png`);
      await page.screenshot({ path: shot });
      logStep(`${name} refused start`, { box: refusal.box, shot });

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
      metadata: { desktop: DESKTOP.viewport, phone: PHONE.viewport },
      scenario: "remote-new-session-menus",
    }).catch(() => {});
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[remote-new-session-menus-e2e] FAILED", error);
  process.exitCode = 1;
});
