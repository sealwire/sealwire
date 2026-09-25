// Regression guard: a short CJK project name must not collapse to one glyph in
// the mobile chat header.
//
// A project named 「长任务」 is ~46px wide at the header's font size; the header
// itself is 390px. There is room, but the label was clipping anyway (down to
// ~40px pre-fix — see the diagnosis comments below for why the severity here is
// smaller than the one-glyph collapse originally reported: this fixture's header
// carries less competing content than the real bug report's).
//
// The plan's working theory was that CJK's per-glyph break opportunities make some
// ancestor size itself by min-content. Measurement disproved that: with
// `white-space: nowrap`, min-content EQUALS max-content for text regardless of
// script (nowrap forbids soft wrapping, so there is no smaller "min" to fall
// back to) — a same-width Latin control clips by the same mechanism (see the
// "latin ancestor chain" dump below). The real defect was `.project-switcher-
// trigger { max-width: 100% }` creating a cyclic percentage against the <h1>
// ancestor it also sizes; it happens to look CJK-specific in the wild only
// because each Han glyph is much wider, so the same fixed pixel shortfall costs
// more visible characters. A long Latin name truncating at this width is still
// CORRECT and stays covered by browser-remote-mobile-header-e2e.mjs.
//
// `innerText`/`textContent` is not evidence here: Chromium returns the full
// string through a CSS ellipsis. Only `scrollWidth` vs `clientWidth`,
// `getBoundingClientRect()`, and an independently measured intrinsic text width
// (a detached probe span, not the label's own possibly-clipped box) prove
// whether the glyphs actually got the room.
//
// Deliberately lightweight: serves the built web/ bundle over a static server
// and stubs the relay WebSocket — no relay / broker / worker process.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { createArtifactWriter, writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-cjk-project-name-e2e";
const PROJECT_ID = "project-cjk-project-name-e2e";
const PROJECT_NAME = "长任务";
// A same-pixel-width-class Latin control, per the plan's diagnosis step: short
// enough that it should never need to truncate at this viewport either, so any
// clip here proves the defect is NOT specific to CJK line-breaking.
const LATIN_PROJECT_ID = "project-latin-control-e2e";
const LATIN_PROJECT_NAME = "Arena";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Ancestor chain the plan asks us to dump before touching any CSS: the label's
// own box, then each wrapper up to the header, in case some ancestor (not the
// label) is the one collapsing to min-content. Named so assertNoClip can look
// entries back up by selector instead of by array position.
const LABEL_SELECTOR = ".remote-chat-shell .project-switcher-label";
const TRIGGER_SELECTOR = ".remote-chat-shell .project-switcher-trigger";
const HEADING_SELECTOR = ".remote-chat-shell h1.project-switcher-heading";
const TITLE_ROW_SELECTOR = ".remote-chat-shell .chat-heading-title-row";
const CHAT_HEADING_SELECTOR = ".remote-chat-shell .chat-heading";
const CHAT_HEADER_SELECTOR = ".remote-chat-shell .chat-header";

const ANCESTOR_SELECTORS = [
  LABEL_SELECTOR,
  TRIGGER_SELECTOR,
  HEADING_SELECTOR,
  TITLE_ROW_SELECTOR,
  CHAT_HEADING_SELECTOR,
  CHAT_HEADER_SELECTOR,
];

async function dumpAncestorChain(page) {
  return page.evaluate((selectors) => {
    return selectors.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { selector: sel, found: false };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      // getBoundingClientRect().right is the BORDER-box edge. .chat-header has
      // 16px of right padding at this breakpoint, so that edge sits 16px past
      // where content is actually allowed to reach — a trigger could overflow
      // into the padding and a check against the border-box edge would still
      // pass. contentRight strips padding/border to get the edge that matters.
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const borderRightWidth = parseFloat(style.borderRightWidth) || 0;
      return {
        selector: sel,
        found: true,
        width: Math.round(rect.width * 100) / 100,
        // left/right (not just width) so assertNoClip can check the trigger's
        // right edge against a CONTAINER's right edge, not just compare sizes —
        // two boxes can be the same width while one has drifted past the other.
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        contentRight: Math.round((rect.right - paddingRight - borderRightWidth) * 100) / 100,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        whiteSpace: style.whiteSpace,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        flex: style.flex,
        overflow: style.overflow,
      };
    });
  }, ANCESTOR_SELECTORS);
}

function findAncestor(ancestorChain, selector) {
  const entry = ancestorChain.find((candidate) => candidate.selector === selector);
  assert.ok(entry && entry.found, `expected an ancestor chain entry for ${selector}`);
  return entry;
}

async function readLabelMetrics(page) {
  return page.evaluate(() => {
    const label = document.querySelector(".remote-chat-shell .project-switcher-label");
    if (!label) return null;
    const rect = label.getBoundingClientRect();
    return {
      text: label.textContent || "",
      width: rect.width,
      scrollWidth: label.scrollWidth,
      clientWidth: label.clientWidth,
    };
  });
}

// Ground truth independent of the label's own (possibly-clipped) box: render the
// same text, in the label's own computed font, into a detached probe element with
// no width constraint, and measure THAT. Comparing the label against this — rather
// than against a hardcoded pixel guess — proves the box is wide enough for every
// glyph, not just "wide enough that a magic number happens to pass".
async function measureIntrinsicTextWidth(page, selector, text) {
  return page.evaluate(
    ({ selector, text }) => {
      const reference = document.querySelector(selector);
      const probe = document.createElement("span");
      probe.textContent = text;
      probe.style.position = "fixed";
      probe.style.left = "-9999px";
      probe.style.top = "0";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "nowrap";
      if (reference) {
        // The `font` SHORTHAND often serializes to "" (this stylesheet's
        // system-ui stack does, in this Chromium) — copy the longhands
        // instead, including letter-spacing, which the shorthand omits
        // entirely and this stylesheet sets to -0.01em on headings.
        const cs = getComputedStyle(reference);
        probe.style.fontFamily = cs.fontFamily;
        probe.style.fontSize = cs.fontSize;
        probe.style.fontWeight = cs.fontWeight;
        probe.style.fontStyle = cs.fontStyle;
        probe.style.letterSpacing = cs.letterSpacing;
      }
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    },
    { selector, text }
  );
}

function buildInitScript({ relayId, threadId, projectId, projectName, latinProjectId, latinProjectName }) {
  return ({ relayId, threadId, projectId, projectName, latinProjectId, latinProjectName }) => {
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
    const threadText = "Say hello for the CJK project name header e2e.";
    const threadSummary = {
      id: threadId,
      name: "CJK Project Name E2E",
      preview: threadText,
      cwd: "/tmp/e2e-cjk-project-name",
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
      active_turn_id: "turn-e2e",
      current_status: "completed",
      active_flags: [],
      current_cwd: "/tmp/e2e-cjk-project-name",
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
      transcript: [
        {
          item_id: "item-cjk-1",
          kind: "user_text",
          text: threadText,
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
              // Both fixtures live in one payload so the switcher can move between
              // them without a second round trip: CJK first (the reported bug),
              // then the same-width-class Latin control the plan's diagnosis calls for.
              projects: [
                { id: projectId, name: projectName },
                { id: latinProjectId, name: latinProjectName },
              ],
              thread_project_id: { [threadId]: projectId },
            },
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
              entries: [
                {
                  item_id: "item-cjk-1",
                  kind: "user_text",
                  text: threadText,
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
  };
}

async function openConversation(page, origin, initArgs) {
  await page.addInitScript(buildInitScript(initArgs), initArgs);

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, { timeout: TIMEOUT_MS });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".remote-chat-shell .project-switcher-trigger", { timeout: TIMEOUT_MS });
}

async function switchToProject(page, projectName) {
  await page.click(".remote-chat-shell .project-switcher-trigger");
  await page
    .locator(".remote-chat-shell .project-switcher-option", { hasText: projectName })
    .first()
    .click({ timeout: TIMEOUT_MS });
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".remote-chat-shell .project-switcher-trigger")?.textContent?.includes(expected),
    projectName,
    { timeout: TIMEOUT_MS }
  );
  await page.waitForTimeout(250);
}

// One project's worth of measurement, with no assertions. Used for both the CJK
// name under test and the Latin control, so the two dumps are produced the same
// way and are directly comparable — and so a red run still gathers both before
// anything can throw (see assertNoClip below).
async function collectMeasurements(page, label, projectName) {
  const ancestorChain = await dumpAncestorChain(page);
  console.log(`${label} ancestor chain:`, JSON.stringify(ancestorChain, null, 2));

  const metrics = await readLabelMetrics(page);
  console.log(`${label} label metrics:`, JSON.stringify(metrics));

  const intrinsicWidth = await measureIntrinsicTextWidth(
    page,
    ".remote-chat-shell .project-switcher-label",
    projectName
  );
  console.log(`${label} independently measured intrinsic text width:`, intrinsicWidth);

  return { ancestorChain, metrics, intrinsicWidth };
}

// The "does it actually fit" assertions, split out so callers can collect and
// save measurements for every project before the first assertion can abort
// the run.
function assertNoClip(label, projectName, { metrics, intrinsicWidth, ancestorChain }) {
  assert.ok(metrics, `expected the project switcher label to be present (${label})`);
  assert.equal(
    metrics.text,
    projectName,
    `expected the label text to be the full project name (${label}), got ${JSON.stringify(metrics)}`
  );

  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `expected ${label} to fit without clipping (390px header, ~${Math.round(intrinsicWidth)}px label), got ${JSON.stringify(metrics)}`
  );
  // The real proof the plan asked for: the rendered box must be at least as wide
  // as the text's OWN unconstrained width, measured independently of the label's
  // possibly-clipped box — not just "wide enough for some number of glyphs".
  assert.ok(
    metrics.width >= intrinsicWidth - 1,
    `expected the ${label} label box (${metrics.width}px) to hold the full intrinsic text width `
      + `(${intrinsicWidth}px measured independently), not collapse to fewer glyphs — got ${JSON.stringify(metrics)}`
  );

  // Upper bounds. Everything above only checks "did not shrink" — the fix this
  // test guards removed a max-width, and the regression THAT could plausibly
  // cause is the opposite direction: a trigger that stretches past its own text
  // or grows past its container instead of shrinking to fit it.
  assert.ok(
    metrics.width <= intrinsicWidth + 2,
    `expected the ${label} label box (${metrics.width}px) to not stretch past its own intrinsic text width `
      + `(${intrinsicWidth}px measured independently) — got ${JSON.stringify(metrics)}`
  );

  // Compared against contentRight, not the raw border-box `right` — .chat-header
  // carries real right padding at this breakpoint, and a check against its
  // border-box edge would let the trigger overflow straight into that padding
  // without ever tripping.
  const trigger = findAncestor(ancestorChain, TRIGGER_SELECTOR);
  const chatHeading = findAncestor(ancestorChain, CHAT_HEADING_SELECTOR);
  const chatHeader = findAncestor(ancestorChain, CHAT_HEADER_SELECTOR);
  assert.ok(
    trigger.right <= chatHeading.contentRight + 1,
    `expected the ${label} trigger's right edge (${trigger.right}px) to stay within .chat-heading's `
      + `content box (contentRight=${chatHeading.contentRight}px) — a regression here means the trigger `
      + `grew past its container instead of shrinking to fit it, got ${JSON.stringify({ trigger, chatHeading })}`
  );
  assert.ok(
    trigger.right <= chatHeader.contentRight + 1,
    `expected the ${label} trigger's right edge (${trigger.right}px) to stay within .chat-header's `
      + `content box (contentRight=${chatHeader.contentRight}px), got ${JSON.stringify({ trigger, chatHeader })}`
  );
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
  attachPageDebugLogging(page, "remote", { prefix: "remote-cjk-project-name-e2e" });

  try {
    await openConversation(page, origin, {
      relayId: RELAY_ID,
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      latinProjectId: LATIN_PROJECT_ID,
      latinProjectName: LATIN_PROJECT_NAME,
    });

    // Collect both dumps — and write them to disk — before asserting anything.
    // A red run needs the CJK-versus-Latin comparison that pinned this bug in
    // the first place; asserting mid-collection would abort with only half of
    // it (see the plan's follow-up note).
    const artifacts = createArtifactWriter("remote-cjk-project-name-e2e-success");

    await switchToProject(page, PROJECT_NAME);
    const cjkResult = await collectMeasurements(page, "cjk", PROJECT_NAME);
    await page.screenshot({ path: `${artifacts.dir}/cjk-screenshot.png` }).catch(() => {});

    // The plan's diagnosis step: repeat the exact same dump with a Latin name of
    // similar pixel width. If this ALSO fails to clip after the fix (as it does),
    // that confirms the defect was never CJK-specific line-breaking — see the
    // header comment for what it actually was.
    await switchToProject(page, LATIN_PROJECT_NAME);
    const latinResult = await collectMeasurements(page, "latin", LATIN_PROJECT_NAME);
    await page.screenshot({ path: `${artifacts.dir}/latin-screenshot.png` }).catch(() => {});

    await artifacts.writeJson("measurements.json", {
      cjk: cjkResult,
      latin: latinResult,
    });
    console.log(`[e2e-artifacts] wrote success artifacts to ${artifacts.dir}`);

    assertNoClip("cjk", PROJECT_NAME, cjkResult);
    assertNoClip("latin", LATIN_PROJECT_NAME, latinResult);

    console.log(`remote-cjk-project-name-e2e OK cjk=${JSON.stringify(cjkResult.metrics)} latin=${JSON.stringify(latinResult.metrics)}`);
  } catch (error) {
    await writeFailureArtifacts({
      scenario: "remote-cjk-project-name-e2e",
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
