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

// The relay, stubbed in the page: a paired profile, and a socket that answers like one.
// Serialised by Playwright into each page, so it must close over nothing.
function installFakeRelay({ relayId, threadId, projectId, projectName, fullText }) {
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
              // Real plugin skills: one long shared prefix, and only the tail differs.
              ...[
                "analytics-dashboard",
                "design-report",
                "weekly-status-update",
                "quarterly-planning-deck",
              ].map((tail) => ({
                name: `openai-templates:artifact-template-${tail}`,
                description: "Build a polished artifact from the template",
                scope: "plugin",
                origin: "openai-templates@openai-curated-remote",
                path: `/home/.codex/plugins/openai-templates/skills/artifact-template-${tail}/SKILL.md`,
              })),
              // Far more than the menu shows before "show all".
              ...Array.from({ length: 120 }, (_, index) => {
                const name = `batch-skill-${String(index).padStart(3, "0")}`;
                return {
                  name,
                  description: `Batch skill ${index}, with a description long enough to be cut short`,
                  scope: "repo",
                  path: `/tmp/e2e-mobile-header/.agents/skills/${name}/SKILL.md`,
                };
              }),
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
}

const FIXTURE = {
  relayId: RELAY_ID,
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  projectName: PROJECT_NAME,
  fullText: FULL_TEXT,
};

async function openComposer(page, origin) {
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
}

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
    await page.addInitScript(installFakeRelay, FIXTURE);
    await openComposer(page, origin);

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

    await expandOnPhone(page);
    await expandOnDesktop(browser, origin);

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

// Geometry of the open menu, its expand control and the composer it floats over.
async function readExpandedMenu(page) {
  return page.evaluate(() => {
    const menu = document.querySelector(".composer-command-menu");
    const control = document.querySelector(".composer-command-expand");
    const composer = document.querySelector(".composer-inner");
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    return {
      providerRows: document.querySelectorAll(".composer-command-row.is-provider").length,
      expanded: control?.getAttribute("aria-expanded") === "true",
      controlText: control?.textContent || "",
      menu: rect(menu),
      control: rect(control),
      composer: rect(composer),
      scrollTop: menu?.scrollTop ?? 0,
      scrollHeight: menu?.scrollHeight ?? 0,
      clientHeight: menu?.clientHeight ?? 0,
      viewportHeight: window.innerHeight,
      focused: document.activeElement?.id || "",
      draft: document.querySelector("#remote-message-input")?.value ?? null,
      pills: [...document.querySelectorAll(".composer-command-pill-label")].map((n) => n.textContent),
    };
  });
}

function assertFitsAboveComposer(state, label) {
  assert.ok(state.menu && state.composer, `${label}: the menu and composer render — ${JSON.stringify(state)}`);
  assert.ok(state.menu.top >= 0, `${label}: the menu starts on screen — ${JSON.stringify(state)}`);
  assert.ok(
    state.menu.bottom <= state.composer.top,
    `${label}: the menu must not cover the composer — ${JSON.stringify(state)}`
  );
  assert.ok(
    state.menu.height <= state.viewportHeight * 0.45,
    `${label}: however many rows, the list keeps to a slice of the screen — ${JSON.stringify(state)}`
  );
}

// Where the control sits in the list, and what it is drawn with. Alignment is measured
// between first glyphs, the only thing that says the text starts where a name does.
async function readControlLayout(page) {
  return page.evaluate(() => {
    const firstGlyph = (el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.search(/\S/);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        return range.getBoundingClientRect();
      }
      return null;
    };
    const menu = document.querySelector(".composer-command-menu");
    const footer = document.querySelector(".composer-command-footer");
    const control = document.querySelector(".composer-command-expand");
    const name = document.querySelector(".composer-command-row.is-provider .composer-command-name");
    const menuBox = menu.getBoundingClientRect();
    const controlBox = control.getBoundingClientRect();
    const footerStyle = getComputedStyle(footer);
    const controlStyle = getComputedStyle(control);
    const edges = (style) =>
      ["Top", "Right", "Bottom", "Left"].map((side) => parseFloat(style[`border${side}Width`]) || 0);
    return {
      nameX: firstGlyph(name).left,
      controlX: firstGlyph(control).left,
      footerPosition: footerStyle.position,
      footerBorders: edges(footerStyle),
      controlBorders: edges(controlStyle),
      footerShadow: footerStyle.boxShadow,
      controlShadow: controlStyle.boxShadow,
      rules: menu.querySelectorAll("hr, [role='separator']").length,
      // The control's end within the scrolled content, against where that content ends.
      controlEnd: control.offsetTop + control.offsetHeight,
      contentEnd: menu.scrollHeight - parseFloat(getComputedStyle(menu).paddingBottom),
      scrollTop: menu.scrollTop,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      controlVisible: controlBox.top >= menuBox.top - 1 && controlBox.bottom <= menuBox.bottom + 1,
      controlBelow: controlBox.top >= menuBox.bottom - 1,
    };
  });
}

// The control is a plain last item: text aligned with the names, no divider, not pinned.
function assertControlReadsAsPartOfList(layout, label) {
  assert.ok(
    Math.abs(layout.controlX - layout.nameX) <= 1,
    `${label}: the control's text starts where a skill name does — ${JSON.stringify(layout)}`
  );
  assert.equal(layout.footerPosition, "static", `${label}: nothing pins the control — ${JSON.stringify(layout)}`);
  assert.deepEqual(
    [...layout.footerBorders, ...layout.controlBorders],
    [0, 0, 0, 0, 0, 0, 0, 0],
    `${label}: no divider or outline sets it apart — ${JSON.stringify(layout)}`
  );
  assert.equal(layout.footerShadow, "none");
  assert.equal(layout.controlShadow, "none");
  assert.equal(layout.rules, 0, `${label}: no rule element either`);
  assert.ok(
    layout.contentEnd - layout.controlEnd <= 1,
    `${label}: it is the list's last item — ${JSON.stringify(layout)}`
  );
}

// Scrolled to the top of an overflowing list the control is out of sight below; scrolled
// to the real bottom, it is the last thing there.
async function assertControlAtListEnd(page, label) {
  await page.evaluate(() => {
    document.querySelector(".composer-command-menu").scrollTop = 0;
  });
  const top = await readControlLayout(page);
  assert.ok(top.scrollHeight > top.clientHeight, `${label}: the list overflows — ${JSON.stringify(top)}`);
  assert.ok(top.controlBelow, `${label}: at the top, the control is below, not frozen in view — ${JSON.stringify(top)}`);
  await page.evaluate(() => {
    const menu = document.querySelector(".composer-command-menu");
    menu.scrollTop = menu.scrollHeight;
  });
  const bottom = await readControlLayout(page);
  assert.ok(bottom.controlVisible, `${label}: at the bottom, the control is in view — ${JSON.stringify(bottom)}`);
  assertControlReadsAsPartOfList(bottom, label);
  return bottom;
}

// A finger drag through the list, through the browser's own touch pipeline, so the
// drag either scrolls (pointercancel) or would have picked (a click).
async function dragList(page, fromY, toY) {
  const box = await page.locator(".composer-command-menu").boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    const y = Math.round(fromY + ((toY - fromY) * step) / steps);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(300);
}

const LONG_NAME_TAILS = ["analytics-dashboard", "design-report", "weekly-status-update", "quarterly-planning-deck"];

// Each long-named row as laid out: whether its last character is inside the box the
// person can see, how many lines it took, and whether anything overflows sideways.
// `innerText` would report the whole name even when an ellipsis hides its end.
async function readLongNames(page) {
  return page.evaluate((tails) => {
    const menu = document.querySelector(".composer-command-menu");
    const menuBox = menu.getBoundingClientRect();
    return [...document.querySelectorAll(".composer-command-row.is-provider")]
      .filter((row) => row.querySelector(".composer-command-name")?.textContent.includes("artifact-template-"))
      .map((row) => {
        const name = row.querySelector(".composer-command-name");
        const origin = row.querySelector(".composer-command-origin");
        const text = [...name.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).at(-1);
        const range = document.createRange();
        range.setStart(text, text.length - 1);
        range.setEnd(text, text.length);
        const last = range.getBoundingClientRect();
        const nameBox = name.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const originBox = origin.getBoundingClientRect();
        // Lines as laid out: distinct tops among the text's own boxes.
        const whole = document.createRange();
        whole.selectNodeContents(name);
        // Only boxes with width: a <wbr> reports an empty box of its own.
        const tops = new Set(
          [...whole.getClientRects()].filter((box) => box.width > 1).map((box) => Math.round(box.top))
        );
        return {
          tail: tails.find((tail) => name.textContent.endsWith(tail)) || name.textContent,
          lines: tops.size,
          clipped: name.scrollWidth > name.clientWidth + 1,
          lastCharInside: last.right <= nameBox.right + 1 && last.left >= nameBox.left - 1 && last.right <= menuBox.right,
          rowOverflows: row.scrollWidth > row.clientWidth + 1,
          menuOverflows: menu.scrollWidth > menu.clientWidth + 1,
          // Inside the row and clear of the name: beside it, or on the line below.
          originInside:
            originBox.width > 0 &&
            originBox.left >= rowBox.left - 1 &&
            originBox.right <= rowBox.right + 1 &&
            originBox.bottom <= rowBox.bottom + 1 &&
            (originBox.left >= nameBox.right - 1 || originBox.top >= nameBox.bottom - 1),
          nameRight: Math.round(nameBox.right),
          originLeft: Math.round(originBox.left),
        };
      });
  }, LONG_NAME_TAILS);
}

// In a full list the four names read whole: every tail is on screen, nothing spills
// sideways, and the badge keeps its own column.
async function assertLongNamesReadable(page, label) {
  // Brought to the top of the list, clear of the pinned footer, as a reader would scroll.
  await page.evaluate(() => {
    const menu = document.querySelector(".composer-command-menu");
    const first = [...menu.querySelectorAll(".composer-command-row.is-provider")].find((row) =>
      row.textContent.includes("artifact-template-")
    );
    menu.scrollTop = first.offsetTop - 8;
  });
  const rows = await readLongNames(page);
  assert.deepEqual(rows.map((row) => row.tail), LONG_NAME_TAILS, `${label}: all four long names listed`);
  for (const row of rows) {
    assert.ok(row.lastCharInside && !row.clipped, `${label}: "${row.tail}" is read to its end — ${JSON.stringify(row)}`);
    assert.ok(!row.rowOverflows && !row.menuOverflows, `${label}: nothing overflows sideways — ${JSON.stringify(row)}`);
    assert.ok(row.originInside, `${label}: the origin badge stays in its own column — ${JSON.stringify(row)}`);
    assert.ok(row.lines >= 2, `${label}: the name wraps rather than hides — ${JSON.stringify(row)}`);
    assert.ok(row.lines <= 3, `${label}: and gets the width to do it in a few lines — ${JSON.stringify(row)}`);
  }
  return rows;
}

async function waitExpanded(page, expanded) {
  await page.waitForFunction(
    (want) => document.querySelector(".composer-command-expand")?.getAttribute("aria-expanded") === String(want),
    expanded,
    { timeout: TIMEOUT_MS }
  );
}

// What assistive tech is handed: a listbox of named groups of options, with the
// expand button beside it rather than inside it.
async function assertMenuAccessibility(page, label) {
  const tree = await page.locator(".composer-command-menu").ariaSnapshot();
  const lines = tree.split("\n");
  assert.match(lines[0], /^- listbox "Commands"/, `${label}: the rows are one listbox — ${tree.slice(0, 400)}`);
  assert.ok(lines.some((line) => /^ {2}- group "Sealwire"/.test(line)), `${label}: Sealwire's group is named — ${tree.slice(0, 400)}`);
  assert.ok(lines.some((line) => /^ {2}- group "Codex skills"/.test(line)), `${label}: so is the provider's`);
  assert.ok(
    lines.some((line) => /^- button "(Show fewer|\+\d+ more — show all)"/.test(line)),
    `${label}: the control is a button at the listbox's level, not inside it — ${lines.filter((l) => l.includes("button")).join(" | ")}`
  );
  assert.ok(
    !lines.some((line) => /^\s+- button/.test(line)),
    `${label}: no button is nested in the listbox`
  );
}

async function expandOnPhone(page) {
  await page.click("#remote-message-input");
  await page.type("#remote-message-input", "/", { delay: 30 });
  await page.waitForSelector(".composer-command-expand", { timeout: TIMEOUT_MS });
  const collapsed = await readExpandedMenu(page);
  assert.equal(collapsed.providerRows, 8, `eight provider rows before expanding — ${JSON.stringify(collapsed)}`);
  assert.equal(collapsed.controlText, "+118 more — show all");
  // The capped preview stays compact: a long name there is one line, cut short.
  const preview = await readLongNames(page);
  assert.equal(preview.length, 4, `the long names are in the first eight — ${JSON.stringify(preview)}`);
  assert.ok(
    preview.every((row) => row.lines === 1 && row.clipped),
    `capped rows keep to one line — ${JSON.stringify(preview)}`
  );
  await assertControlAtListEnd(page, "phone, collapsed");

  await page.tap(".composer-command-expand");
  await page.waitForFunction(
    () => document.querySelector(".composer-command-expand")?.getAttribute("aria-expanded") === "true",
    null,
    { timeout: TIMEOUT_MS }
  );
  const expanded = await readExpandedMenu(page);
  assert.equal(expanded.providerRows, 126, `every match once expanded — ${JSON.stringify(expanded)}`);
  assertFitsAboveComposer(expanded, "phone");
  assert.ok(
    expanded.scrollHeight > expanded.clientHeight * 3,
    `the rows scroll inside the list, not down the page — ${JSON.stringify(expanded)}`
  );
  assert.equal(expanded.focused, "remote-message-input", "the tap keeps the composer focused");
  assert.equal(expanded.draft, "/", "and the draft untouched");
  await assertMenuAccessibility(page, "phone");
  // What a screen reader's activation sends after those taps: a click with no press.
  await page.locator(".composer-command-expand").dispatchEvent("click");
  await waitExpanded(page, false);
  await page.locator(".composer-command-expand").dispatchEvent("click");
  await waitExpanded(page, true);
  await assertControlAtListEnd(page, "phone, expanded");
  if (process.env.SKILLS_SCREENSHOT) {
    await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-phone-list-end.png") });
  }
  await page.evaluate(() => {
    document.querySelector(".composer-command-menu").scrollTop = 0;
  });
  if (process.env.SKILLS_SCREENSHOT) {
    await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-phone-expanded.png") });
  }

  // A drag that starts on a row scrolls the list and picks nothing.
  const start = expanded.menu.top + Math.round(expanded.menu.height * 0.7);
  const beforeDrag = await readExpandedMenu(page);
  await dragList(page, start, start - 180);
  const dragged = await readExpandedMenu(page);
  assert.ok(dragged.scrollTop > beforeDrag.scrollTop + 60, `the drag scrolled the list — ${JSON.stringify(dragged)}`);
  assert.deepEqual(dragged.pills, [], `a drag is not a pick — ${JSON.stringify(dragged)}`);
  assertFitsAboveComposer(dragged, "phone, scrolled");
  if (process.env.SKILLS_SCREENSHOT) {
    await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-phone-scrolled.png") });
  }

  // "Show fewer" is reached by scrolling to the list's real end, and collapses it back.
  await page.evaluate(() => {
    const menu = document.querySelector(".composer-command-menu");
    menu.scrollTop = menu.scrollHeight;
  });
  assert.ok((await readControlLayout(page)).controlVisible, "the end of the list shows the control");
  await page.tap(".composer-command-expand");
  await page.waitForFunction(
    () => document.querySelector(".composer-command-expand")?.getAttribute("aria-expanded") === "false",
    null,
    { timeout: TIMEOUT_MS }
  );
  assert.equal((await readExpandedMenu(page)).providerRows, 8);

  // A row far below the first eight is one tap away once expanded.
  await page.tap(".composer-command-expand");
  const target = ".composer-command-row.is-provider >> text=$batch-skill-060";
  await page.locator(target).scrollIntoViewIfNeeded();
  await page.tap(target);
  await page.waitForFunction(
    () => [...document.querySelectorAll(".composer-command-pill-label")].some((n) => n.textContent === "$batch-skill-060"),
    null,
    { timeout: TIMEOUT_MS }
  );
  const picked = await readExpandedMenu(page);
  assert.equal(picked.focused, "remote-message-input", "picking keeps the composer focused");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !document.querySelector(".composer-command-pill"), null, { timeout: TIMEOUT_MS });

  // Long names sharing one prefix, expanded: each is readable to the tail that differs.
  await page.type("#remote-message-input", "/", { delay: 20 });
  await page.waitForSelector(".composer-command-expand", { timeout: TIMEOUT_MS });
  await page.tap(".composer-command-expand");
  await waitExpanded(page, true);
  await assertLongNamesReadable(page, "phone, expanded");
  if (process.env.SKILLS_SCREENSHOT) {
    await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-phone-long-names.png") });
  }
  // A query that already fits shows every match too, with no control to reach for.
  await page.fill("#remote-message-input", "");
  await page.type("#remote-message-input", "/artifact", { delay: 20 });
  await page.waitForFunction(
    () => document.querySelectorAll(".composer-command-row.is-provider").length === 4,
    null,
    { timeout: TIMEOUT_MS }
  );
  await assertLongNamesReadable(page, "phone, filtered");
  await page.fill("#remote-message-input", "");
}

async function expandOnDesktop(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(installFakeRelay, FIXTURE);
    await openComposer(page, origin);
    await page.click("#remote-message-input");
    await page.type("#remote-message-input", "/", { delay: 20 });
    await page.waitForSelector(".composer-command-expand", { timeout: TIMEOUT_MS });
    await page.click(".composer-command-expand");
    await page.waitForFunction(
      () => document.querySelector(".composer-command-expand")?.getAttribute("aria-expanded") === "true",
      null,
      { timeout: TIMEOUT_MS }
    );
    const expanded = await readExpandedMenu(page);
    assert.equal(expanded.providerRows, 126);
    assertFitsAboveComposer(expanded, "desktop");
    assert.equal(expanded.focused, "remote-message-input", "a click keeps the composer focused");
    await assertMenuAccessibility(page, "desktop");

    // After that mouse click, the same button still answers the keyboard once focused.
    await page.locator(".composer-command-expand").focus();
    await page.keyboard.press("Enter");
    await waitExpanded(page, false);
    await page.locator(".composer-command-expand").focus();
    await page.keyboard.press("Space");
    await waitExpanded(page, true);
    // And a mouse click after that toggles exactly once: its own click does not undo it.
    await page.click(".composer-command-expand");
    await waitExpanded(page, false);
    await page.waitForTimeout(200);
    assert.equal((await readExpandedMenu(page)).expanded, false, "one click, one toggle");
    await page.click(".composer-command-expand");
    await waitExpanded(page, true);
    await assertControlAtListEnd(page, "desktop, expanded");

    // The keyboard reaches it at the real end too: from the first row, ArrowUp wraps to
    // the control, and the list scrolls down to show it.
    await page.evaluate(() => {
      document.querySelector(".composer-command-menu").scrollTop = 0;
    });
    await page.focus("#remote-message-input");
    while (!(await page.$(".composer-command-row.is-active"))) await page.keyboard.press("ArrowDown");
    const firstActive = await page.$eval(".composer-command-row.is-active", (row) => [...row.parentElement.parentElement.querySelectorAll(".composer-command-row")].indexOf(row));
    for (let step = 0; step <= firstActive; step += 1) await page.keyboard.press("ArrowUp");
    const reached = await readControlLayout(page);
    assert.ok(
      await page.$(".composer-command-expand.is-active"),
      "ArrowUp from the first row lands on the control"
    );
    assert.ok(reached.controlVisible, `and the list scrolled to show it — ${JSON.stringify(reached)}`);
    await page.keyboard.press("ArrowDown");
    await page.evaluate(() => {
      document.querySelector(".composer-command-menu").scrollTop = 0;
    });

    // Walk the keyboard well past what fits: the active row scrolls into view each time,
    // clear of the pinned footer.
    for (let step = 0; step < 40; step += 1) await page.keyboard.press("ArrowDown");
    // Buttons fade their background in; measure the highlight once it has landed.
    await page.waitForTimeout(400);
    const walked = await page.evaluate(() => {
      const menu = document.querySelector(".composer-command-menu").getBoundingClientRect();
      const active = document.querySelector(".composer-command-row.is-active");
      const row = active.getBoundingClientRect();
      const neighbour = active.previousElementSibling;
      return {
        name: active.querySelector(".composer-command-name").textContent,
        activeBackground: getComputedStyle(active).backgroundColor,
        neighbourBackground: neighbour ? getComputedStyle(neighbour).backgroundColor : "",
        rowTop: row.top,
        rowBottom: row.bottom,
        menuTop: menu.top,
        menuBottom: menu.bottom,
      };
    });
    assert.ok(
      walked.rowTop >= walked.menuTop - 1 && walked.rowBottom <= walked.menuBottom + 1,
      `the active row is scrolled into view — ${JSON.stringify(walked)}`
    );
    assert.notEqual(
      walked.activeBackground,
      walked.neighbourBackground,
      `the walked-to row is visibly the active one — ${JSON.stringify(walked)}`
    );
    if (process.env.SKILLS_SCREENSHOT) {
      await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-desktop-walked.png") });
    }
    await page.keyboard.press("Enter");
    await page.waitForSelector(".composer-command-pill", { timeout: TIMEOUT_MS });
    const pills = await page.$$eval(".composer-command-pill-label", (nodes) => nodes.map((n) => n.textContent));
    assert.deepEqual(pills, [walked.name], "Enter picks the row the keyboard walked to");

    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => !document.querySelector(".composer-command-pill"), null, { timeout: TIMEOUT_MS });
    await page.type("#remote-message-input", "/", { delay: 20 });
    await page.waitForSelector(".composer-command-expand", { timeout: TIMEOUT_MS });
    const preview = await readLongNames(page);
    assert.ok(preview.every((row) => row.lines === 1), `capped rows keep to one line — ${JSON.stringify(preview)}`);
    await assertControlAtListEnd(page, "desktop, collapsed");
    if (process.env.SKILLS_SCREENSHOT) {
      await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-desktop-collapsed-end.png") });
    }
    await page.click(".composer-command-expand");
    await waitExpanded(page, true);
    await assertLongNamesReadable(page, "desktop, expanded");
    if (process.env.SKILLS_SCREENSHOT) {
      await page.screenshot({ path: process.env.SKILLS_SCREENSHOT.replace(/\.png$/, "-desktop-long-names.png") });
    }
  } finally {
    await context.close().catch(() => {});
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
