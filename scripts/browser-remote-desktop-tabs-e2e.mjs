// The session tab strip on the REMOTE surface, and the device gate that decides whether
// it exists at all.
//
// Three things here cannot be shown by a unit test:
//
//   1. The gate is a live media query. `(hover: hover) and (pointer: fine)` is resolved
//      by the browser against the emulated device, so only a real context can prove that
//      a mouse-driven window gets the strip and a touch one does not.
//   2. The BIG-SCREEN touch case. The rule the maintainer asked for is about input, not
//      width: a 1280x800 tablet must keep the plain single-session view. A viewport-based
//      gate would pass every desktop assertion below and still get this one wrong, so it
//      is the assertion that actually pins the rule.
//   3. The strip and the transcript agreeing. Opening a tab commits through the
//      controller and the VIEW happens in a subscriber; a wiring mistake there leaves a
//      strip that highlights one session while another is on screen — which renders fine
//      and passes every pure test.
//
// Lightweight like the other remote-* scenarios: it serves the built web/ bundle over a
// static server and stubs the relay WebSocket — no relay / broker / worker process.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const SHOT_DIR = process.env.BROWSER_E2E_SHOT_DIR || "";
const RELAY_ID = "relay-e2e";
const THREAD_ACTIVE = "thread-tabs-active";
const THREAD_B = "thread-tabs-beta";
const THREAD_C = "thread-tabs-gamma";   // the only one in a project
const THREAD_D = "thread-tabs-delta";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
// Deliberately WIDE. This is the iPad shape: plenty of room for a strip, but a finger
// is the primary pointer.
const TABLET_VIEWPORT = { width: 1280, height: 800 };
const PHONE_VIEWPORT = { width: 390, height: 844 };

function installFakeRelay({ relayId, threadActive, threadB, threadC, threadD, tallTranscript }) {
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

  const thread = (id, name, updatedAt) => ({
    id,
    name,
    preview: "a preview",
    cwd: "/tmp/e2e-remote-tabs",
    updated_at: updatedAt,
    source: "codex",
    provider: "codex",
    status: "completed",
    model_provider: "openai",
  });
  const threads = [
    thread(threadActive, "Active session", 3),
    thread(threadB, "Beta session", 2),
    thread(threadC, "Gamma session", 1),
    thread(threadD, "Delta session", 0),
  ];

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
    active_thread_id: threadActive,
    active_controller_device_id: "device-e2e",
    active_controller_last_seen_at: Math.floor(Date.now() / 1000),
    controller_lease_expires_at: Math.floor(Date.now() / 1000) + 60,
    controller_lease_seconds: 15,
    active_turn_id: null,
    current_status: "idle",
    active_flags: [],
    pending_approvals: [],
    thread_activity: [],
    current_cwd: "/tmp/e2e-remote-tabs",
    model: "gpt-5.4",
    available_models: [],
    approval_policy: "never",
    sandbox: "workspace-write",
    reasoning_effort: "medium",
    allowed_roots: [],
    device_records: [],
    paired_devices: [],
    pending_pairing_requests: [],
    projects_revision: 1,
    provider_status: [
      { provider: "codex", status: "connected", connected: true, display_name: "Codex" },
    ],
    transcript_truncated: false,
    // Long enough to make the remote column over-full, which is the precondition step
    // 15 needs: with slack in the column the strip keeps its height regardless.
    transcript: tallTranscript
      ? Array.from({ length: 40 }, (_, index) => ({
          item_id: `item-tall-${index}`,
          kind: index % 2 === 0 ? "user_text" : "agent_text",
          text: `Message ${index}. ${"a conversation long enough to overflow. ".repeat(6)}`,
          status: "completed",
          turn_id: "turn-e2e",
          tool: null,
        }))
      : [],
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

  // Keep in step with broker-client.js. It drops a payload whose relay version it does
  // not know via `renderLog`, so a stale fixture reaches no console: the page connects,
  // sends its requests, and silently ignores every answer.
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
      const actionId = payload?.action_id;
      if (request.type === "heartbeat") {
        this.#respond(actionId, { action: "heartbeat", ok: true, snapshot });
        return;
      }
      if (request.type === "list_threads") {
        this.#respond(actionId, {
          action: "list_threads",
          ok: true,
          snapshot,
          threads: { threads },
        });
        return;
      }
      if (request.type === "fetch_projects") {
        this.#respond(actionId, {
          action: "fetch_projects",
          ok: true,
          snapshot,
          projects: {
            // THREAD_C belongs to project P; the other two belong to nothing. That gap
            // between "owns" and "is pinned" is where the filing bug lives.
            projects: [{ id: "P", name: "Alpha project" }],
            thread_project_id: { [threadC]: "P" },
            projects_revision: 1,
          },
        });
        return;
      }
      if (request.type === "fetch_reviews") {
        this.#respond(actionId, {
          action: "fetch_reviews",
          ok: true,
          snapshot,
          reviews: { reviews: [] },
        });
        return;
      }
      if (request.type === "fetch_workflows") {
        this.#respond(actionId, {
          action: "fetch_workflows",
          ok: true,
          snapshot,
          workflows: { workflows: [] },
        });
        return;
      }
      if (request.type === "fetch_thread_transcript") {
        // Answer for the thread that was ASKED for. A hardcoded id would let a
        // mis-wired view change still land on a plausible-looking transcript.
        this.#respond(actionId, {
          action: "fetch_thread_transcript",
          ok: true,
          snapshot,
          thread_transcript: {
            thread_id: request.thread_id || request.input?.thread_id || threadActive,
            entries: [],
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
}

async function openSurface(browserContext, origin, label, { tallTranscript = false } = {}) {
  const page = await browserContext.newPage();
  attachPageDebugLogging(page, "remote", { prefix: `remote-desktop-tabs-e2e:${label}` });
  await page.addInitScript(installFakeRelay, {
    relayId: RELAY_ID,
    threadActive: THREAD_ACTIVE,
    threadB: THREAD_B,
    threadC: THREAD_C,
    threadD: THREAD_D,
    tallTranscript,
  });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`#remote-threads-list [data-thread-id="${THREAD_B}"]`, {
    timeout: TIMEOUT_MS,
  });
  return page;
}

// The strip's own invariant, borrowed from the local scenario: what it highlights must
// be the session on screen. Polled, because the commit is async and the view follows it.
async function waitForFocusedTab(page, threadId) {
  try {
    await page.waitForFunction(
      (expected) => {
        const focused = document.querySelector(".session-tab.is-focused");
        return focused?.dataset.threadId === expected;
      },
      threadId,
      { timeout: TIMEOUT_MS }
    );
  } catch (error) {
    // A bare "Timeout 30000ms exceeded" here reads as a rendering problem and sends you
    // looking in the wrong place. Report what the strip ACTUALLY holds instead.
    const actual = await page
      .evaluate(() => ({
        focused: document.querySelector(".session-tab.is-focused")?.dataset.threadId ?? null,
        tabs: [...document.querySelectorAll(".session-tab[data-thread-id]")].map(
          (node) => node.dataset.threadId
        ),
      }))
      .catch(() => null);
    throw new Error(
      `expected the strip to focus ${threadId}; it held ${JSON.stringify(actual)}`
    );
  }
}

// Never assert on an ElementHandle. `assert.equal(handle, null)` makes node serialize
// the handle to build its message, which exhausts memory and kills the process — so the
// test fails as a bare SIGKILL with no assertion text. Count nodes instead.
async function shoot(page, name) {
  if (!SHOT_DIR) return;
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
}

async function stripCount(page) {
  return page.$$eval(".session-tab-strip", (nodes) => nodes.length);
}

async function tabThreadIds(page) {
  return page.$$eval(".session-tab[data-thread-id]", (nodes) =>
    nodes.map((node) => node.dataset.threadId)
  );
}

async function drawerProjectTagCount(page) {
  return page.$$eval(".sidebar .project-switcher-top", (nodes) => nodes.length);
}

async function stripMetrics(page) {
  return page.$eval(".session-tab-strip", (node) => {
    const tab = node.querySelector(".session-tab");
    return {
      height: Math.round(node.getBoundingClientRect().height),
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      tabHeight: tab ? Math.round(tab.getBoundingClientRect().height) : 0,
    };
  });
}

async function main() {
  const server = await startStaticServer({
    rootDir: WEB_ROOT,
    indexFile: "remote.html",
    pathAliases: {
      "/manifest.webmanifest": "remote-manifest.webmanifest",
      "/sw.js": "remote-sw.js",
      "/static/remote-sw.js": "remote-sw.js",
    },
    stripStaticPrefix: true,
  });
  const origin = `http://127.0.0.1:${server.port}`;

  const { browser, context: desktopContext } = await launchBrowser({
    contextOptions: { viewport: DESKTOP_VIEWPORT },
  });
  let page = null;

  try {
    page = await openSurface(desktopContext, origin, "desktop");

    // ---- 1. A mouse-driven window gets the strip, describing what is on screen. ----
    await page.waitForSelector(".session-tab-strip", { timeout: TIMEOUT_MS });
    await waitForFocusedTab(page, THREAD_ACTIVE);
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_ACTIVE],
      "boot must open exactly one tab, for the session actually being shown"
    );

    // ---- 1b. The drawer's compact project tag is DRAWER-only. ----
    // Remote renders the project switcher twice: the chat header's title, and a tag icon
    // in the sidebar's top bar. The tag was written for the phone, where the drawer
    // covers the header; on a desktop window both are on screen at once.
    assert.equal(
      await page.$$eval(".remote-chat-shell .project-switcher-trigger", (nodes) => nodes.length),
      1,
      "fixture check: the desktop header must carry the full project switcher"
    );
    assert.equal(
      await drawerProjectTagCount(page),
      0,
      "a desktop window shows the header switcher, so the drawer must not repeat it as a tag"
    );

    // ---- 2. Opening sessions from the sidebar fills the strip. ----
    // Double-click, because a single click PEEKS: it reuses the one preview slot, so
    // two single clicks would leave one tab and prove nothing about accumulation.
    await page.dblclick(`#remote-threads-list [data-thread-id="${THREAD_B}"]`);
    await waitForFocusedTab(page, THREAD_B);
    await page.dblclick(`#remote-threads-list [data-thread-id="${THREAD_D}"]`);
    await waitForFocusedTab(page, THREAD_D);
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_ACTIVE, THREAD_B, THREAD_D],
      "each kept session takes its own tab, in the order they were opened"
    );

    await shoot(page, "remote-desktop-tabs-strip");

    // ---- 3. A single click PEEKS rather than stacking. ----
    // Reopening an already-open session must focus it, not duplicate it — the rule a
    // browser applies to "switch to tab".
    await page.click(`#remote-threads-list [data-thread-id="${THREAD_B}"]`);
    await waitForFocusedTab(page, THREAD_B);
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_ACTIVE, THREAD_B, THREAD_D],
      "a session that is already open must be focused, never duplicated"
    );

    // ---- 4. Clicking a tab moves the view. ----
    await page.click(`.session-tab[data-thread-id="${THREAD_ACTIVE}"] .session-tab-main`);
    await waitForFocusedTab(page, THREAD_ACTIVE);

    // ---- 5. Pinning floats a tab to the front. ----
    await page.click(`.session-tab[data-thread-id="${THREAD_D}"] .session-tab-pin`);
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".session-tab[data-thread-id]")?.dataset.threadId === expected,
      THREAD_D,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      (await tabThreadIds(page))[0],
      THREAD_D,
      "a pinned tab holds the zone at the front of the strip"
    );

    // ---- 6. Closing a tab closes the VIEW, not the session. ----
    await page.click(`.session-tab[data-thread-id="${THREAD_B}"] .session-tab-close`);
    await page.waitForFunction(
      (gone) => !document.querySelector(`.session-tab[data-thread-id="${gone}"]`),
      THREAD_B,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await page.$$eval(
        `#remote-threads-list [data-thread-id="${THREAD_B}"]`,
        (nodes) => nodes.length
      ),
      1,
      "closing a tab must not remove the session from the sidebar"
    );

    // ---- 7. A session is filed under ITS project, not the one it was opened from. ----
    // THREAD_C belongs to project P; everything else is unassigned. Opening it moves the
    // location into P's workspace, which must hold C alone.
    await page.click(`.session-tab[data-thread-id="${THREAD_ACTIVE}"] .session-tab-main`);
    await waitForFocusedTab(page, THREAD_ACTIVE);
    await page.dblclick(`#remote-threads-list [data-thread-id="${THREAD_C}"]`);
    await waitForFocusedTab(page, THREAD_C);
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_C],
      "a session in a project gets that project's tab set, not the one it was opened from"
    );

    // ---- 8. Closing the LAST tab in a workspace must move the view, not orphan it. ----
    // Remote always renders a conversation, so emptying a workspace falls back to the
    // relay's live thread — which also lands us back in the unassigned workspace, proving
    // the strip followed rather than being left describing an empty set.
    //
    // Waits on the CLOSED tab disappearing. Waiting for "something is focused" is
    // satisfied by the pre-close frame, and then reads a stale highlight.
    await page.click(`.session-tab[data-thread-id="${THREAD_C}"] .session-tab-close`);
    await page.waitForFunction(
      (gone) => !document.querySelector(`.session-tab[data-thread-id="${gone}"]`),
      THREAD_C,
      { timeout: TIMEOUT_MS }
    );
    await waitForFocusedTab(page, THREAD_ACTIVE);
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_D, THREAD_ACTIVE],
      "emptying a workspace returns to the live thread's workspace, intact"
    );

    // ---- 9. Selecting an EMPTY project must stick. ----
    // P's only session was closed in step 8, so this switches into a workspace with no
    // tabs — the case where the close-fallback and the context switch collide. If the
    // fallback is not scoped to a close, the live thread is re-filed into ITS context and
    // yanks the selection straight back out, which reads as "the switcher does nothing".
    await page.click(".remote-chat-shell .project-switcher-trigger");
    await projectSwitcherOption(page, "Alpha project", { scope: ".remote-chat-shell" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".session-tab[data-thread-id]").length === 0,
      undefined,
      { timeout: TIMEOUT_MS }
    );
    // Hold it: a yank-back arrives a tick later, so sampling once would pass either way.
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(document.querySelectorAll(".session-tab[data-thread-id]").length === 0),
            250
          );
        }),
      undefined,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await page.$eval("#remote-pinned-project .pinned-project-chip-name", (n) =>
        n.textContent.trim()
      ),
      "Alpha project",
      "the sidebar pin must follow the committed context"
    );
    // Back to the unassigned workspace for the reload assertion below.
    await page.click(`#remote-threads-list [data-thread-id="${THREAD_ACTIVE}"]`);
    await waitForFocusedTab(page, THREAD_ACTIVE);

    // ---- 10. Closing the LIVE thread's only tab re-creates it, on purpose. ----
    // Documented rather than "fixed": that conversation is still on screen and remote has
    // no home screen to close it in favour of, so the strip re-describes it rather than
    // lying. Pinned here so the behaviour is a decision and not an accident.
    await page.click(`.session-tab[data-thread-id="${THREAD_D}"] .session-tab-pin`);
    await page.click(`.session-tab[data-thread-id="${THREAD_D}"] .session-tab-close`);
    await page.waitForFunction(
      (gone) => !document.querySelector(`.session-tab[data-thread-id="${gone}"]`),
      THREAD_D,
      { timeout: TIMEOUT_MS }
    );
    await waitForFocusedTab(page, THREAD_ACTIVE);
    // Tag the tab before closing it, and wait for one that is NOT tagged.
    //
    // Every cheaper wait is satisfied by the frame before the close: the thread
    // id is the same on both sides of the round trip, and so is the focus, so
    // `waitForFocusedTab` returns while the strip is still holding the tab we
    // just asked it to close. The assertion then samples an unsynchronised DOM
    // and reads whichever of the three states it lands on — the old tab, the
    // beat where the strip is empty, or the re-created tab. Locally it lands on
    // the first and passes WITHOUT EVER OBSERVING THE RE-CREATION this step
    // exists to pin; on a loaded runner it lands on the empty beat (~2ms here,
    // wider under load) and fails with `[]`, which is what CI saw.
    //
    // The re-creation unmounts the tab and mounts a new element, so an untagged
    // tab is the one signal that means the round trip actually completed.
    await page.$eval(`.session-tab[data-thread-id="${THREAD_ACTIVE}"]`, (node) => {
      node.dataset.e2eClosedTab = "1";
    });
    await page.click(`.session-tab[data-thread-id="${THREAD_ACTIVE}"] .session-tab-close`);
    await page.waitForFunction(
      (id) => {
        const tab = document.querySelector(`.session-tab[data-thread-id="${id}"]`);
        return Boolean(tab) && tab.dataset.e2eClosedTab !== "1";
      },
      THREAD_ACTIVE,
      { timeout: TIMEOUT_MS }
    );
    await waitForFocusedTab(page, THREAD_ACTIVE);
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_ACTIVE],
      "the live thread's tab comes back, because its conversation never left the screen"
    );

    // ---- 11. A reload returns to the tab you left open, not to the relay's. ----
    // Remote has no URL routing, so this is the ONLY thing proving both storage round
    // trips at once: the tab set comes back from IndexedDB, and the surface re-enters
    // the session it was on from the location memo. Neither is recoverable from
    // anything on the page — which is exactly what local gets for free from
    // `history.state` + `?thread=`.
    //
    // Focused on THREAD_B specifically, because a session the relay is NOT running is
    // the only case with an answer to get wrong. The relay's first snapshot names its
    // own live thread, and adopting that snapshot is what would otherwise claim the
    // surface a few hundred milliseconds after load — reproducing the old behaviour
    // while looking, for that moment, exactly like a correct restore.
    //
    // And note what `waitForFocusedTab` proves here. The strip's focus is derived from
    // the RENDERED thread with no fallback to the workspace's remembered focus (see the
    // SessionTabStrip call site), so this asserts the transcript on screen is B's — not
    // merely that the location says so.
    //
    // Done from inside a PROJECT workspace, which is what makes the context half of the
    // memo observable at all. Reloading in the sessions context would restore correctly
    // even if the context were never stored, because sessions is also the cold-start
    // default — the assertion would hold for the wrong reason. THREAD_C is the fixture's
    // only project member, so its workspace holds exactly one tab.
    //
    // Which assertion catches what, precisely: a wrongly adopted live thread moves the
    // CONTEXT (THREAD_ACTIVE is unassigned, so the sessions workspace owns it), which is
    // what `waitForFocusedTab` fails on. The tab list then pins the restored workspace's
    // shape — one tab, the project's — a claim that in the sessions context could not be
    // told apart from the THREAD_ACTIVE tab already sitting there.
    await page.click(".remote-chat-shell .project-switcher-trigger");
    await projectSwitcherOption(page, "Alpha project", { scope: ".remote-chat-shell" }).click();
    await page.dblclick(`#remote-threads-list [data-thread-id="${THREAD_C}"]`);
    await waitForFocusedTab(page, THREAD_C);

    // Boot a fresh document in the SAME context. This is the persistence
    // boundary the feature relies on (localStorage + IndexedDB survive; page
    // memory does not), and avoids Chromium occasionally closing a reloaded
    // target under CI while Playwright is attaching the next locator.
    await page.close();
    page = null;
    page = await openSurface(desktopContext, origin, "desktop-restored");
    await waitForFocusedTab(page, THREAD_C);
    // Re-check at +250ms rather than sampling the instant the focus is right: the adoption
    // that would clobber the restore arrives a tick LATER, which is the whole shape of the
    // bug, so an immediate sample passes either way. Note what this is and is not — an
    // async predicate makes `waitForFunction` "sample once at +250ms, retry until true",
    // not "must stay true for 250ms". That is enough here because the clobber is permanent
    // rather than a flicker, and it matches the idiom step 9 established.
    await page.waitForFunction(
      (expected) =>
        new Promise((resolve) => {
          setTimeout(() => {
            const tabs = [...document.querySelectorAll(".session-tab[data-thread-id]")].map(
              (node) => node.dataset.threadId
            );
            const focused = document.querySelector(".session-tab.is-focused");
            resolve(
              tabs.length === 1 && tabs[0] === expected && focused?.dataset.threadId === expected
            );
          }, 250);
        }),
      THREAD_C,
      { timeout: TIMEOUT_MS }
    );
    assert.deepEqual(
      await tabThreadIds(page),
      [THREAD_C],
      "the restored workspace is the project's, and the relay's live thread is not filed into it"
    );
    assert.equal(
      await page.$eval("#remote-pinned-project .pinned-project-chip-name", (n) =>
        n.textContent.trim()
      ),
      "Alpha project",
      "and the sidebar pin follows the restored context, as a projection of it"
    );
    await shoot(page, "remote-desktop-tabs-reload-restored");

    await page.close();
    page = null;

    // ---- 12. A BIG-SCREEN touch device keeps today's single-session view. ----
    // The case the whole gate exists for: same width class as the desktop run above,
    // but a finger is the primary pointer.
    const tabletContext = await browser.newContext({
      viewport: TABLET_VIEWPORT,
      hasTouch: true,
    });
    const tabletPage = await openSurface(tabletContext, origin, "tablet");
    assert.equal(
      await tabletPage.evaluate(() =>
        matchMedia("(hover: hover) and (pointer: fine)").matches
      ),
      false,
      "fixture check: a touch context must not report a desktop pointer"
    );
    await shoot(tabletPage, "remote-tablet-no-strip");
    assert.equal(
      await stripCount(tabletPage),
      0,
      "a wide TOUCH surface must keep the plain single-session view — width is not the rule"
    );
    // ...and switching sessions still works there, exactly as before.
    await tabletPage.tap(`#remote-threads-list [data-thread-id="${THREAD_B}"]`);
    await tabletPage.waitForFunction(
      (expected) =>
        document.querySelector("#remote-threads-list .conversation-item.is-active")
          ?.dataset.threadId === expected,
      THREAD_B,
      { timeout: TIMEOUT_MS }
    );
    assert.equal(
      await stripCount(tabletPage),
      0,
      "switching sessions on a touch surface must not conjure a strip"
    );
    await tabletContext.close();

    // ---- 13. A NARROW window with a mouse still gets the strip. ----
    // pointer-mode.js draws this distinction explicitly ("a narrow desktop window is
    // drawer-shaped but still mouse-driven"), and it is the other half of the rule step
    // 12 proves: the gate is about input, never about width. Without this, a viewport
    // condition could creep into the gate and only step 12 would notice — and it would
    // pass, because a touch tablet is wide.
    const narrowContext = await browser.newContext({ viewport: { width: 500, height: 900 } });
    const narrowPage = await openSurface(narrowContext, origin, "narrow");
    assert.equal(
      await stripCount(narrowPage),
      1,
      "a narrow but mouse-driven window keeps the strip — the gate is input, not width"
    );
    // The other half of 1b: mouse-driven but drawer-shaped, so the drawer covers the
    // header exactly as it does on a phone and the tag is the only switcher in reach.
    assert.equal(
      await drawerProjectTagCount(narrowPage),
      1,
      "a drawer-shaped window keeps the tag — the drawer covers the header's switcher"
    );
    await narrowContext.close();

    // ---- 14. A phone, for completeness. ----
    const phoneContext = await browser.newContext({
      viewport: PHONE_VIEWPORT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const phonePage = await phoneContext.newPage();
    attachPageDebugLogging(phonePage, "remote", { prefix: "remote-desktop-tabs-e2e:phone" });
    await phonePage.addInitScript(installFakeRelay, {
      relayId: RELAY_ID,
      threadActive: THREAD_ACTIVE,
      threadB: THREAD_B,
      threadC: THREAD_C,
    });
    await phonePage.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await phonePage.waitForSelector("#remote-nav-toggle-button", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    assert.equal(
      await stripCount(phonePage),
      0,
      "a phone must keep the plain single-session view"
    );
    assert.equal(
      await drawerProjectTagCount(phonePage),
      1,
      "a phone keeps the drawer's project tag — it is the surface the tag was written for"
    );
    await phoneContext.close();

    // ---- 15. The strip is CHROME: an over-full column must not eat its height. ----
    // `.remote-chat-shell` is a flex COLUMN (local's `.chat-shell` is a grid, whose
    // `auto` row gives the strip its height unconditionally — which is why this only
    // showed on remote), and `.session-tab-strip`'s own `overflow-y: hidden` zeroes its
    // automatic minimum size. So as a default `flex: 0 1 auto` child it was the one item
    // in the column free to be crushed, and a long conversation crushed it.
    const slackContext = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const slackPage = await openSurface(slackContext, origin, "slack-column");
    await slackPage.waitForSelector(".session-tab-strip .session-tab", { timeout: TIMEOUT_MS });
    const natural = await stripMetrics(slackPage);
    await slackContext.close();

    const overfullContext = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const overfullPage = await openSurface(overfullContext, origin, "overfull-column", {
      tallTranscript: true,
    });
    await overfullPage.waitForSelector(".session-tab-strip .session-tab", { timeout: TIMEOUT_MS });
    // Without a transcript that actually overflows there is no squeeze to observe, and
    // every assertion below passes for the wrong reason.
    await overfullPage.waitForFunction(
      () => {
        const thread = document.querySelector(".remote-chat-shell .chat-thread");
        return Boolean(thread) && thread.scrollHeight > thread.clientHeight + 200;
      },
      undefined,
      { timeout: TIMEOUT_MS }
    );
    const overfull = await stripMetrics(overfullPage);
    await shoot(overfullPage, "remote-desktop-tabs-overfull-column");
    await overfullContext.close();

    assert.ok(
      natural.tabHeight > 0 && natural.height >= natural.tabHeight,
      `fixture check: the slack column must lay the strip out normally, got ${JSON.stringify(natural)}`
    );
    assert.deepEqual(
      { height: overfull.height, tabHeight: overfull.tabHeight },
      { height: natural.height, tabHeight: natural.tabHeight },
      "the strip must be the same height whether or not the column below it overflows"
    );
    assert.equal(
      overfull.clientHeight,
      overfull.scrollHeight,
      `an over-full column must not clip the strip's own content, got ${JSON.stringify(overfull)}`
    );

    console.log("remote-desktop-tabs e2e: OK");
  } catch (error) {
    if (page) {
      await writeFailureArtifacts({
        remotePage: page,
        scenario: "remote-desktop-tabs",
      }).catch(() => {});
    }
    throw error;
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

await main();
