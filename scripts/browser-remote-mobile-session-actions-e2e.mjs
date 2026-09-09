// Regression guard for reaching SESSION ACTIONS from a phone on the remote surface.
//
// Remote used to bind the row's actions to `contextmenu`, which a touch long-press
// never dispatches — so on a real phone the binding was dead and forking was reachable
// only from a transcript message. Each row now carries a "⋯" button that opens a bottom
// sheet. Three things have to hold and none are provable by a unit test:
//
//   1. The "⋯" is actually VISIBLE at mobile width. It is hover-revealed on desktop, so
//      only the `@media (hover: none)` rule keeps it reachable here — a CSS edit could
//      silently take the only mobile entry point away.
//   2. It does not obscure the row's own content in a narrow drawer.
//   3. The sheet offers only actions whose transport EXISTS. Archive and delete live on
//      HTTP routes the broker has no action for; listing them would render dead buttons.
//
// It also pins the sidebar's Providers panel showing each agent's MARK rather than its
// name.
//
// Deliberately lightweight, like browser-remote-mobile-header-e2e.mjs: it serves the
// built web/ bundle over a static server and stubs the relay WebSocket — no relay /
// broker / worker process.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createArtifactWriter, writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-mobile-actions-e2e";
// A SECOND, adjacent row. The enlarged touch target is taller than a row, so without
// a neighbour there is nothing for it to bleed into and the overlap is invisible.
const THREAD_ID_2 = "thread-mobile-actions-e2e-2";
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
  const { browser, context } = await launchBrowser({
    contextOptions: {
      viewport: MOBILE_VIEWPORT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    },
  });
  const page = await context.newPage();
  attachPageDebugLogging(page, "remote", { prefix: "remote-mobile-session-actions-e2e" });

  try {
    await page.addInitScript(
      ({ relayId, threadId, threadId2 }) => {
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
          name: "Alpha session",
          preview: "a preview",
          cwd: "/tmp/e2e-mobile-actions",
          updated_at: 1,
          source: "codex",
          provider: "codex",
          // Idle: a working thread would (correctly) have fork withheld, and this test
          // wants to see the fork entry.
          status: "completed",
          model_provider: "openai",
        };
        const threadSummary2 = {
          ...threadSummary,
          id: threadId2,
          name: "Beta session",
          updated_at: 2,
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
          // No turn in flight — otherwise the fork entry is withheld by design.
          active_turn_id: null,
          current_status: "idle",
          active_flags: [],
          current_cwd: "/tmp/e2e-mobile-actions",
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
          // Drives the sidebar Providers panel: codex ships a mark, `fake` does not, so
          // one row must show a glyph and the other must keep its name.
          provider_status: [
            { provider: "codex", status: "connected", connected: true, display_name: "Codex" },
            { provider: "fake", status: "connected", connected: true, display_name: "Fake" },
          ],
          transcript_truncated: false,
          transcript: [],
          logs: [],
        };
        const projectsPayload = {
          projects_revision: 1,
          projects: [
            { id: "p1", name: "Alpha project" },
            { id: "p2", name: "Beta project" },
          ],
          thread_project_id: { [threadId]: "p1" },
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

        window.__projectActions = [];
        window.__setThreadFlagActions = [];
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
                threads: { threads: [threadSummary, threadSummary2] },
              });
              return;
            }
            if (request.type === "project_action") {
              // Record what the sheet actually put on the wire, so the test can assert
              // the action fired and carried the right thread/project — not merely
              // that a button existed.
              window.__projectActions.push(request.input || null);
              this.#respond(actionId, { action: "project_action", ok: true, snapshot });
              return;
            }
            if (request.type === "set_thread_flag") {
              // Same recording purpose as __projectActions above, for the ack-only
              // `set_thread_flag` action the flag toggle dispatches.
              window.__setThreadFlagActions.push({
                thread_id: request.thread_id,
                input: request.input || null,
              });
              const target = [threadSummary, threadSummary2].find(
                (t) => t.id === request.thread_id
              );
              if (target) {
                target.flagged = Boolean(request.input?.flagged);
              }
              this.#respond(actionId, { action: "set_thread_flag", ok: true, snapshot });
              return;
            }
            if (request.type === "fetch_projects") {
              // `fetchRemoteProjects` reads result.projects, and that value IS the
              // payload object — the broker nests it under the same key.
              this.#respond(actionId, {
                action: "fetch_projects",
                ok: true,
                snapshot,
                projects: projectsPayload,
              });
              return;
            }
            if (request.type === "fetch_reviews") {
              this.#respond(actionId, { action: "fetch_reviews", ok: true, snapshot, reviews: { reviews: [] } });
              return;
            }
            if (request.type === "fetch_workflows") {
              this.#respond(actionId, { action: "fetch_workflows", ok: true, snapshot, workflows: { workflows: [] } });
              return;
            }
            if (request.type === "fetch_thread_transcript") {
              this.#respond(actionId, {
                action: "fetch_thread_transcript",
                ok: true,
                snapshot,
                thread_transcript: { thread_id: threadId, entries: [], prev_cursor: null },
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
      { relayId: RELAY_ID, threadId: THREAD_ID, threadId2: THREAD_ID_2 }
    );

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__agentRelaySecretReady === true, null, { timeout: TIMEOUT_MS });
    await page.reload({ waitUntil: "domcontentloaded" });

    // Open the drawer. Until it is open the sidebar is measurable but clipped — visible
    // to Playwright, invisible to a user — so every assertion below would be a lie.
    await page.waitForSelector("#remote-nav-toggle-button", { state: "visible", timeout: TIMEOUT_MS });
    await page.click("#remote-nav-toggle-button");

    const rowSelector = `.conversation-item-wrap:has([data-thread-id="${THREAD_ID}"])`;
    await page.waitForSelector(rowSelector, { state: "visible", timeout: TIMEOUT_MS });

    // The drawer SLIDES in, and Playwright calls the row "visible" from the first frame
    // — while it is still off-screen left (measured at x=-36 mid-animation). Every
    // geometry assertion below would be measuring a position the user never sees, so
    // wait for the transform to settle: on screen, and unchanged across two frames.
    // A single frame's comparison is not enough — an eased transition barely moves near
    // its end, so two samples can match while the drawer is still travelling. Require
    // the same position several polls running.
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const left = Math.round(el.getBoundingClientRect().left);
        const state = window.__drawerSettle;
        window.__drawerSettle =
          state && state.left === left ? { left, count: state.count + 1 } : { left, count: 0 };
        return left >= 0 && window.__drawerSettle.count >= 5;
      },
      rowSelector,
      { timeout: TIMEOUT_MS }
    );

    // --- 1. the "⋯" is reachable on touch ------------------------------------
    const moreButton = page.locator(`${rowSelector} .conversation-more`);
    await moreButton.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    const moreOpacity = await moreButton.evaluate((el) => getComputedStyle(el).opacity);
    assert.equal(
      moreOpacity,
      "1",
      "the actions button must not be hover-gated at mobile width — it is the only entry point there"
    );

    // --- 1b. and its TOUCH TARGET meets the 44px floor -----------------------
    //
    // The glyph is 26px; the target is widened by an invisible overlay. Measuring the
    // button's own box would miss that, so probe what actually receives a tap at the
    // corners of the 44px square — the thing a finger cares about.
    const hitArea = await page.evaluate((selector) => {
      const more = document.querySelector(`${selector} .conversation-more`);
      const r = more.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const reach = 44 / 2 - 1; // just inside the intended square
      const probe = (dx, dy) => {
        const el = document.elementFromPoint(cx + dx, cy + dy);
        const hit = Boolean(el && (el === more || more.contains(el)));
        // Name what intercepted the tap — a bare false gives nothing to debug from.
        return hit || `blocked by ${el ? el.tagName + "." + (el.className || "?") : "nothing"}`;
      };
      return {
        probes: {
          centre: probe(0, 0),
          left: probe(-reach, 0),
          right: probe(reach, 0),
          top: probe(0, -reach),
          bottom: probe(0, reach),
        },
        glyphWidth: Math.round(r.width),
        targetWidth: getComputedStyle(more, "::after").width,
      };
    }, rowSelector);
    for (const [edge, hit] of Object.entries(hitArea.probes)) {
      assert.equal(
        hit,
        true,
        `a tap ${edge} of the glyph must still reach the actions button (44px floor), got ${JSON.stringify(hitArea)}`
      );
    }

    // --- 1c. and it does not bleed into the NEIGHBOURING session -------------
    //
    // The enlarged target is centred on a 26px glyph, so if it is taller than the row
    // it overhangs the rows above and below. Those are separately positioned, so the
    // next row paints over the overhang: the effective target shrinks AND a tap near
    // the edge can open the wrong session. Probe just inside the top and bottom of
    // each row's target and assert the hit belongs to THAT row.
    const neighbour = await page.evaluate(
      ({ idA, idB }) => {
        const wrapFor = (id) =>
          document.querySelector(`.conversation-item-wrap:has([data-thread-id="${id}"])`);
        const check = (id) => {
          const wrap = wrapFor(id);
          if (!wrap) return `no row for ${id}`;
          const more = wrap.querySelector(".conversation-more");
          const r = more.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const reach = 44 / 2 - 1;
          const owner = (dy) => {
            const el = document.elementFromPoint(cx, cy + dy);
            const ownWrap = el && el.closest(".conversation-item-wrap");
            if (!ownWrap) return "none";
            return ownWrap === wrap ? "self" : "OTHER ROW";
          };
          return { top: owner(-reach), bottom: owner(reach) };
        };
        const wrapA = wrapFor(idA);
        const wrapB = wrapFor(idB);
        return {
          a: check(idA),
          b: check(idB),
          rowHeight: wrapA ? Math.round(wrapA.getBoundingClientRect().height) : null,
          adjacent:
            wrapA && wrapB
              ? Math.round(
                  Math.abs(
                    wrapB.getBoundingClientRect().top - wrapA.getBoundingClientRect().bottom
                  )
                )
              : null,
        };
      },
      { idA: THREAD_ID, idB: THREAD_ID_2 }
    );
    assert.ok(neighbour.rowHeight, `expected two rendered rows, got ${JSON.stringify(neighbour)}`);
    for (const [row, edges] of [["first", neighbour.a], ["second", neighbour.b]]) {
      for (const [edge, owner] of Object.entries(edges)) {
        assert.equal(
          owner,
          "self",
          `the ${edge} of the ${row} row's touch target must belong to its own session — a tap there must not open a neighbour. Got ${JSON.stringify(neighbour)}`
        );
      }
    }

    // --- 2. it does not obscure the row --------------------------------------
    const geometry = await page.evaluate((selector) => {
      const wrap = document.querySelector(selector);
      const title = wrap.querySelector(".conversation-title");
      const more = wrap.querySelector(".conversation-more");
      const t = title.getBoundingClientRect();
      const m = more.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return {
        titleRight: Math.round(t.right),
        moreLeft: Math.round(m.left),
        moreRight: Math.round(m.right),
        wrapRight: Math.round(w.right),
        viewportWidth: window.innerWidth,
      };
    }, rowSelector);
    assert.ok(
      geometry.titleRight <= geometry.moreLeft,
      `the actions button must not overlap the session title, got ${JSON.stringify(geometry)}`
    );
    assert.ok(
      geometry.moreRight <= geometry.viewportWidth,
      `the actions button must stay inside the viewport, got ${JSON.stringify(geometry)}`
    );

    // --- 3. the Providers panel shows marks, not names -----------------------
    const providerPanel = await page.evaluate(() => {
      const rowFor = (key) =>
        document.querySelector(`#remote-provider-status-list .provider-status-row[data-provider="${key}"]`);
      const codex = rowFor("codex");
      const fake = rowFor("fake");
      return {
        codexHasMark: Boolean(codex?.querySelector(".provider-mark")),
        codexText: codex?.querySelector(".provider-status-name")?.textContent?.trim() ?? null,
        fakeHasMark: Boolean(fake?.querySelector(".provider-mark")),
        fakeText: fake?.querySelector(".provider-status-name")?.textContent?.trim() ?? null,
      };
    });
    assert.equal(providerPanel.codexHasMark, true, "codex ships a mark and must use it");
    assert.equal(
      providerPanel.fakeHasMark,
      false,
      "a provider with no icon must never borrow another vendor's logo"
    );
    assert.equal(providerPanel.fakeText, "Fake", "it keeps its name instead");

    // --- 4. tapping opens the sheet with the right actions -------------------
    await moreButton.tap();
    await page.waitForSelector("#remote-thread-actions-sheet[open]", { state: "visible", timeout: TIMEOUT_MS });

    const sheet = await page.evaluate(() => {
      const el = document.querySelector("#remote-thread-actions-sheet");
      const rect = el.getBoundingClientRect();
      return {
        items: [...el.querySelectorAll(".thread-actions-item")].map((b) => b.textContent.trim()),
        current: [...el.querySelectorAll(".thread-actions-item.is-current")].map((b) =>
          b.querySelector(".thread-actions-item-label").textContent.trim()
        ),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });

    const itemText = sheet.items.join(" | ");
    for (const expected of ["Fork session", "Alpha project", "Beta project", "Remove from project", "New project"]) {
      assert.ok(itemText.includes(expected), `expected "${expected}" in the sheet, got: ${itemText}`);
    }
    // The session lives in Alpha, and the sheet must say so rather than just listing it.
    assert.deepEqual(sheet.current, ["Alpha project"], `expected Alpha marked current, got ${itemText}`);

    // The Session section's fixed order: Fork, Rename, then the flag toggle (unflagged
    // here, so it reads "Flag for follow-up") — before the Projects section starts.
    assert.deepEqual(
      sheet.items.slice(0, 3),
      ["Fork session", "Rename session…", "Flag for follow-up"],
      `expected Session section order, got: ${itemText}`
    );

    // The point of the model's allow-list: these have NO broker transport on remote, so
    // showing them would render buttons that cannot fire.
    for (const forbidden of ["Archive", "Delete"]) {
      assert.ok(
        !itemText.includes(forbidden),
        `"${forbidden}" has no remote transport and must not appear, got: ${itemText}`
      );
    }

    // --- 5. it really is a bottom sheet, fully on screen ---------------------
    assert.ok(
      sheet.left >= 0 && sheet.right <= sheet.viewportWidth,
      `the sheet must fit the viewport horizontally, got ${JSON.stringify(sheet)}`
    );
    assert.ok(
      Math.abs(sheet.bottom - sheet.viewportHeight) <= 2,
      `the sheet must dock to the bottom edge on a phone, got ${JSON.stringify(sheet)}`
    );

    // --- 6. an action actually reaches the wire ------------------------------
    //
    // Listing the right labels proves nothing about whether tapping one does anything.
    // Move the session to the project it is NOT in, and assert the frame the relay
    // would have received.
    await page
      .locator("#remote-thread-actions-sheet .thread-actions-item", { hasText: "Beta project" })
      .tap();
    await page.waitForFunction(() => window.__projectActions.length > 0, null, { timeout: TIMEOUT_MS });
    const [assignFrame] = await page.evaluate(() => window.__projectActions);
    assert.equal(assignFrame.action, "assign", `expected an assign, got ${JSON.stringify(assignFrame)}`);
    assert.equal(assignFrame.thread_id, THREAD_ID);
    assert.equal(assignFrame.project_id, "p2", "must carry the project that was tapped");

    // Acting closes the sheet — leaving it up over the result would strand a modal.
    await page.waitForSelector("#remote-thread-actions-sheet[open]", {
      state: "hidden",
      timeout: TIMEOUT_MS,
    });

    // --- 7. flag for follow-up: dispatches, marks the row, and flips its own label ---
    const artifacts = createArtifactWriter("remote-mobile-session-actions-flag-verify");
    await fs.mkdir(artifacts.dir, { recursive: true });

    await moreButton.tap();
    await page.waitForSelector("#remote-thread-actions-sheet[open]", { state: "visible", timeout: TIMEOUT_MS });
    await page.screenshot({ path: path.join(artifacts.dir, "01-sheet-before-flag.png") });

    await page
      .locator("#remote-thread-actions-sheet .thread-actions-item", { hasText: "Flag for follow-up" })
      .tap();
    await page.waitForFunction(() => window.__setThreadFlagActions.length > 0, null, { timeout: TIMEOUT_MS });
    const [flagFrame] = await page.evaluate(() => window.__setThreadFlagActions);
    assert.equal(flagFrame.thread_id, THREAD_ID, `expected the flag action on ${THREAD_ID}, got ${JSON.stringify(flagFrame)}`);
    assert.deepEqual(flagFrame.input, { flagged: true }, `expected {flagged: true}, got ${JSON.stringify(flagFrame)}`);

    // Ack-only: the sheet closes immediately (same as the assign case above)...
    await page.waitForSelector("#remote-thread-actions-sheet[open]", { state: "hidden", timeout: TIMEOUT_MS });
    // ...and the row picks up the flag once the post-action refreshThreads() lands.
    await page.waitForSelector(`${rowSelector} .conversation-flag-mark`, {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    await page.screenshot({ path: path.join(artifacts.dir, "02-row-after-flag.png") });

    // Re-opening must show the toggle flipped to "Unflag" — selectThreadSheet reads
    // `flagged` straight off the refreshed row, not off any state local to the sheet.
    await moreButton.tap();
    await page.waitForSelector("#remote-thread-actions-sheet[open]", { state: "visible", timeout: TIMEOUT_MS });
    const reopenedItems = await page.$$eval("#remote-thread-actions-sheet .thread-actions-item", (els) =>
      els.map((b) => b.textContent.trim())
    );
    assert.deepEqual(
      reopenedItems.slice(0, 3),
      ["Fork session", "Rename session…", "Unflag"],
      `expected the toggle to read "Unflag" after flagging, got: ${reopenedItems.join(" | ")}`
    );
    await page.screenshot({ path: path.join(artifacts.dir, "03-sheet-shows-unflag.png") });
    console.log(`[remote-mobile-session-actions-e2e] flag verification screenshots: ${artifacts.dir}`);

    await page.keyboard.press("Escape");
    await page.waitForSelector("#remote-thread-actions-sheet[open]", { state: "hidden", timeout: TIMEOUT_MS });

    console.log(
      JSON.stringify(
        {
          threadId: THREAD_ID,
          items: sheet.items,
          providerPanel,
          hitArea,
          neighbour,
          assignFrame,
          flagFrame,
          reopenedItems,
          viewport: MOBILE_VIEWPORT,
          ok: true,
        },
        null,
        2
      )
    );
  } catch (error) {
    await writeFailureArtifacts({
      page,
      name: "remote-mobile-session-actions-e2e",
      error,
      metadata: { origin, relayId: RELAY_ID, threadId: THREAD_ID, viewport: MOBILE_VIEWPORT },
    });
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
