import { addEncryptedBrokerInitScript } from "./e2e/harness/encrypted-broker-mock.mjs";
// Switching between two streaming sessions on a phone, against a stubbed relay socket that
// holds a reply while the old session ends — the timing a real broker almost never shows.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 15000);
const RELAY_ID = "relay-e2e";
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const THREADS = {
  "thread-a": "Alpha session",
  "thread-b": "Beta session",
  "thread-c": "Gamma session",
};
const bodyOf = (threadId) => `${THREADS[threadId]} transcript body`;

function installFakeRelay({ relayId, threads }) {
  const REMOTE_STATE_STORAGE_KEY = "agent-relay.remote-state";
  const REMOTE_SECRET_DB_NAME = "agent-relay-secrets";
  const REMOTE_SECRET_STORE_NAME = "payload-secrets";
  const REMOTE_SECRET_KEY_STORE_NAME = "secret-keys";
  const cwd = "/tmp/e2e-stream-switch";
  const threadSummaries = Object.entries(threads).map(([id, name], index) => ({
    id,
    name,
    preview: `${name} preview`,
    cwd,
    updated_at: index + 1,
    source: "codex",
    provider: "codex",
    status: "active",
    model_provider: "openai",
  }));
  let revision = 1;
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
    active_thread_id: "thread-a",
    active_controller_device_id: "device-e2e",
    active_controller_last_seen_at: Math.floor(Date.now() / 1000),
    controller_lease_expires_at: Math.floor(Date.now() / 1000) + 60,
    controller_lease_seconds: 15,
    active_turn_id: null,
    current_status: "idle",
    active_flags: [],
    current_cwd: cwd,
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
    projects_revision: 1,
    provider_status: [{ provider: "codex", status: "connected", connected: true, display_name: "Codex" }],
    thread_activity: [
      { thread_id: "thread-b", phase: "streaming", tool: null },
      { thread_id: "thread-c", phase: "streaming", tool: null },
    ],
    transcript_revision: revision,
    transcript_truncated: false,
    transcript: [
      { item_id: "thread-a-1", kind: "agent_text", text: `${threads["thread-a"]} transcript body`, turn_id: "turn-a" },
    ],
    logs: [],
  };

  window.localStorage.setItem(
    REMOTE_STATE_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      activeRelayId: relayId,
      clientAuth: null,
      remoteProfiles: {
        [relayId]: {
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
        },
      },
    })
  );
  window.__agentRelaySecretReady = false;
  const openRequest = indexedDB.open(REMOTE_SECRET_DB_NAME, 1);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    for (const name of [REMOTE_SECRET_STORE_NAME, REMOTE_SECRET_KEY_STORE_NAME]) {
      if (!database.objectStoreNames.contains(name)) {
        database.createObjectStore(name, { keyPath: "id" });
      }
    }
  };
  openRequest.onsuccess = () => {
    const tx = openRequest.result.transaction(REMOTE_SECRET_STORE_NAME, "readwrite");
    tx.objectStore(REMOTE_SECRET_STORE_NAME).put({ id: relayId, kind: "software", payloadSecret: "payload-secret-e2e" });
    tx.oncomplete = () => {
      window.__agentRelaySecretReady = true;
    };
  };

  // Per-thread transcript fetch mode: "hold" parks the reply, "fail" refuses it. Seeded
  // from storage so a reload can hold the fetch the page makes on its way up.
  window.__transcriptMode = JSON.parse(window.localStorage.getItem("e2e-transcript-mode") || "{}");
  window.localStorage.removeItem("e2e-transcript-mode");
  window.__heldTranscripts = [];
  window.__transcriptFetches = [];

  const BROKER_PROTOCOL_VERSION = 1;
  const RELAY_PROTOCOL_VERSION = 3;

  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      window.__setActivity = (threadIds) => {
        revision += 1;
        snapshot.thread_activity = threadIds.map((thread_id) => ({ thread_id, phase: "streaming", tool: null }));
        snapshot.transcript_revision = revision;
        this.#emitSnapshot();
      };
      window.__releaseHeldTranscripts = () => {
        for (const release of window.__heldTranscripts.splice(0)) release();
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
        this.#emit({ type: "presence", kind: "joined", peer: { peer_id: "relay-peer-e2e", role: "relay" } });
        this.#emitSnapshot();
      });
    }
    send(raw) {
      const payload = JSON.parse(raw).payload;
      const request = payload?.request || {};
      const actionId = payload?.action_id;
      const ok = (action, extra = {}) => this.#respond(actionId, { action, ok: true, snapshot, ...extra });
      switch (request.type) {
        case "heartbeat":
          return ok("heartbeat");
        case "list_threads":
          return ok("list_threads", { threads: { threads: threadSummaries } });
        case "fetch_projects":
          return ok("fetch_projects", {
            projects: {
              projects_revision: 1,
              projects: [
                { id: "project-beta", name: "Beta project" },
                { id: "project-empty", name: "Empty project" },
              ],
              thread_project_id: { "thread-b": "project-beta" },
            },
          });
        case "fetch_reviews":
          return ok("fetch_reviews", { reviews: { reviews: [] } });
        case "fetch_workflows":
          return ok("fetch_workflows", { workflows: { workflows: [] } });
        case "fetch_thread_transcript": {
          const threadId = request.input?.thread_id;
          window.__transcriptFetches.push(threadId);
          const reply = () =>
            ok("fetch_thread_transcript", {
              thread_transcript: {
                thread_id: threadId,
                entries: [
                  {
                    item_id: `${threadId}-1`,
                    kind: "agent_text",
                    text: `${threads[threadId]} transcript body`,
                    status: "running",
                    turn_id: `turn-${threadId}`,
                  },
                ],
                prev_cursor: null,
                revision,
              },
            });
          const mode = window.__transcriptMode[threadId];
          if (mode === "hold") {
            window.__heldTranscripts.push(reply);
          } else if (mode === "fail") {
            this.#respond(actionId, { action: "fetch_thread_transcript", ok: false, error: "transient broker hiccup" });
          } else {
            reply();
          }
          return undefined;
        }
        default:
          return undefined;
      }
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }));
    }
    #emitSnapshot() {
      this.#emit({
        type: "message",
        payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot },
      });
    }
    #respond(actionId, result) {
      this.#emit({
        type: "message",
        payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "remote_action_result", action_id: actionId, ...result },
      });
    }
    #emit(rawFrame) {
      const frame =
        rawFrame.type === "message" ? { from_role: "relay", from_peer_id: "relay-peer-e2e", ...rawFrame } : rawFrame;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }
  window.WebSocket = window.__sealwireEncryptedMock(FakeWebSocket);
}

async function openPage(context, origin) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`[stream-switch-e2e:pageerror] ${error.stack || error.message}`));
  if (process.env.E2E_DEBUG) page.on("console", (message) => console.log(`[page] ${message.text()}`));
  await addEncryptedBrokerInitScript(page, installFakeRelay, { relayId: RELAY_ID, threads: THREADS });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, { timeout: TIMEOUT_MS });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectOnScreen(page, "thread-a");
  return page;
}

async function tapSession(page, threadId) {
  await page.tap("#remote-nav-toggle-button");
  // Playwright's tap waits for the drawer's slide-in to settle before it lands.
  await page.locator(`button.conversation-item[data-thread-id="${threadId}"]`).tap({ timeout: TIMEOUT_MS });
}

async function chooseProject(page, label) {
  if ((await page.getAttribute(".remote-app-shell", "data-remote-nav-state")) !== "open") {
    await page.tap("#remote-nav-toggle-button");
  }
  if ((await page.getAttribute(".sidebar .project-switcher-trigger", "aria-expanded")) !== "true") {
    await page.locator(".sidebar .project-switcher-trigger").tap({ timeout: TIMEOUT_MS });
  }
  await projectSwitcherOption(page, label, { scope: ".sidebar" }).tap({ timeout: TIMEOUT_MS });
  await page.waitForFunction(
    (expected) =>
      document.querySelector("#remote-pinned-project .pinned-project-chip-name")?.textContent?.trim() === expected,
    label,
    { timeout: TIMEOUT_MS }
  );
}

async function expectOnScreen(page, threadId, message = `${THREADS[threadId]} should be on screen`) {
  await page
    .getByText(bodyOf(threadId), { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT_MS })
    .catch(() => {
      throw new assert.AssertionError({ message });
    });
}

// Sampled rather than checked once: a surface flipping between sessions passes a single look.
async function expectStaysOnScreen(page, threadId, message, durationMs = 1000) {
  const samples = await page.evaluate(
    async ({ expected, others, durationMs }) => {
      const seen = [];
      const deadline = performance.now() + durationMs;
      while (performance.now() < deadline) {
        const text = document.body.innerText;
        seen.push(text.includes(expected) && !others.some((body) => text.includes(body)));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return seen;
    },
    {
      expected: bodyOf(threadId),
      others: Object.keys(THREADS).filter((id) => id !== threadId).map(bodyOf),
      durationMs,
    }
  );
  const off = samples.filter((onScreen) => !onScreen).length;
  assert.equal(off, 0, `${message} (${off} of ${samples.length} samples showed something else)`);
}

const fetchesOf = (page, threadId) =>
  page.evaluate((id) => window.__transcriptFetches.filter((entry) => entry === id).length, threadId);

const SCENARIOS = {
  // The old session ends while the new one's transcript is in flight. Its refresh used
  // to supersede the switch, leaving the phone on the old session.
  async "old session ending mid-switch does not cancel it"(page) {
    await tapSession(page, "thread-b");
    await expectOnScreen(page, "thread-b");

    await page.evaluate(() => {
      window.__transcriptMode["thread-c"] = "hold";
    });
    await tapSession(page, "thread-c");
    await page.waitForFunction(() => window.__heldTranscripts.length === 1, null, { timeout: TIMEOUT_MS });
    await page.evaluate(() => window.__setActivity(["thread-c"]));
    // Let a competing refresh of the old session, if one starts, answer first.
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__releaseHeldTranscripts());

    await expectOnScreen(page, "thread-c", "the tap on Gamma must win over Beta's end-of-turn refresh");
  },

  // A view that failed leaves the session selected but not shown; tapping it again must
  // fetch it, not commit a no-op.
  async "re-tapping a session whose view failed opens it"(page) {
    await page.evaluate(() => {
      window.__transcriptMode["thread-b"] = "fail";
    });
    await tapSession(page, "thread-b");
    await page.waitForFunction(() => window.__transcriptFetches.includes("thread-b"), null, { timeout: TIMEOUT_MS });
    await expectOnScreen(page, "thread-a");

    await page.evaluate(() => {
      delete window.__transcriptMode["thread-b"];
    });
    const before = await fetchesOf(page, "thread-b");
    await tapSession(page, "thread-b");
    await expectOnScreen(page, "thread-b", "the second tap on Beta must open it");
    assert.equal(await fetchesOf(page, "thread-b"), before + 1);
  },

  // A reload brings back the last session; tapping it again while that is still loading
  // must not let the reload's fallback drop the user on the relay's live session.
  async "re-tapping the restored session while it loads keeps it"(page) {
    await tapSession(page, "thread-b");
    await expectOnScreen(page, "thread-b");

    await page.evaluate(() => {
      window.localStorage.setItem("e2e-transcript-mode", JSON.stringify({ "thread-b": "hold" }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__heldTranscripts.length >= 1, null, { timeout: TIMEOUT_MS });
    await expectOnScreen(page, "thread-a", "the live session shows while the restored one loads");

    await tapSession(page, "thread-b");
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      delete window.__transcriptMode["thread-b"];
      window.__releaseHeldTranscripts();
    });
    await expectOnScreen(page, "thread-b");
    await expectStaysOnScreen(page, "thread-b", "the tapped session must stay on screen");
  },

  // Leaving the restored session's project and coming back views it again, which replaces
  // the reload's view; that must not count as the reload failing.
  async "returning to the restored session's project while it loads keeps it"(page) {
    await tapSession(page, "thread-b");
    await expectOnScreen(page, "thread-b");

    await page.evaluate(() => {
      window.localStorage.setItem("e2e-transcript-mode", JSON.stringify({ "thread-b": "hold" }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__heldTranscripts.length >= 1, null, { timeout: TIMEOUT_MS });
    await expectOnScreen(page, "thread-a", "the live session shows while the restored one loads");

    await chooseProject(page, "Empty project");
    await chooseProject(page, "Beta project");
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      delete window.__transcriptMode["thread-b"];
      window.__releaseHeldTranscripts();
    });
    await expectOnScreen(page, "thread-b");
    await expectStaysOnScreen(page, "thread-b", "the restored session must stay on screen");
  },
};

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
  const contextOptions = { viewport: MOBILE_VIEWPORT, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
  const { browser, context: firstContext } = await launchBrowser({ contextOptions });
  await firstContext.close();
  const failures = [];
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      // Fresh storage each time: the app restores the last viewed session on boot.
      const context = await browser.newContext(contextOptions);
      const page = await openPage(context, origin);
      try {
        await run(page);
        console.log(`ok - ${name}`);
      } catch (error) {
        console.log(`not ok - ${name}: ${error.message}`);
        failures.push(name);
        await writeFailureArtifacts({
          scenario: "remote-mobile-stream-switch-e2e",
          remotePage: page,
          metadata: { scenario: name, error: error.message },
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (failures.length) {
    throw new Error(`${failures.length} scenario(s) failed: ${failures.join("; ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
