// Regression guard for the ACTIVITY BELL on a phone-sized remote surface.
//
// The bell re-buckets the session list by state (Needs input / Working / Reviewing /
// Done) and hides idle sessions. Three things have to hold here that no unit test can
// show:
//
//   1. The bell is REACHABLE at mobile width. `.sidebar-top-bar` is `display: none`
//      under 960px and only re-shown for `.remote-app-shell`; a CSS edit could take the
//      only entry point away without failing anything else.
//   2. The buckets replace the cwd grouping in the drawer, and idle rows drop out.
//   3. Retention: a row that has matched stays listed after its state moves on. On
//      remote this is an EFFECT (the filter lives in a zustand store, so accumulating it
//      during render would be a set() mid-render), and an effect that misfires either
//      loops or never settles — neither shows up in a pure test.
//
// Deliberately lightweight, like browser-remote-mobile-session-actions-e2e.mjs: it
// serves the built web/ bundle over a static server and stubs the relay WebSocket — no
// relay / broker / worker process.

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

import { writeFailureArtifacts } from "./e2e/harness/artifacts.mjs";
import { attachPageDebugLogging, launchBrowser } from "./e2e/harness/browser.mjs";
import { startStaticServer } from "./e2e/harness/static-server.mjs";
import { projectSwitcherOption } from "./e2e/harness/project-switcher.mjs";

const ROOT = process.cwd();
const WEB_ROOT = path.join(ROOT, "web");
const TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 30000);
const RELAY_ID = "relay-e2e";
const THREAD_ID = "thread-bell-needs-input";
const THREAD_ID_2 = "thread-bell-working";
// A third, IDLE row — the bell must drop it, and without one "the bell filtered
// something" is indistinguishable from "the bell rendered everything".
const THREAD_ID_3 = "thread-bell-idle";
// Exists ONLY in a search answer. The render model injects the ACTIVE thread into the
// list when the page does not carry it, so withholding the active row proves nothing —
// this one is never active, and is the only way to exercise `findVisibleThread`'s union.
const THREAD_ID_4 = "thread-bell-search-only";
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
  attachPageDebugLogging(page, "remote", { prefix: "remote-mobile-bell-e2e" });

  try {
    await page.addInitScript(
      ({ relayId, threadId, threadId2, threadId3, threadId4 }) => {
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
        const threadSummary3 = {
          ...threadSummary,
          id: threadId3,
          name: "Resting session",
          updated_at: 3,
        };
        const threadSummary4 = {
          ...threadSummary,
          id: threadId4,
          name: "Quiet archive dig",
          updated_at: 0,
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
          // The IDLE thread is the viewed one on purpose: attention badges are only set
          // for threads you are NOT looking at (thread-attention.js drops the badge for
          // the viewed foreground thread), so parking the approval on the active thread
          // would produce an empty bell and a test that proves nothing.
          active_thread_id: threadId3,
          active_controller_device_id: "device-e2e",
          active_controller_last_seen_at: Math.floor(Date.now() / 1000),
          controller_lease_expires_at: Math.floor(Date.now() / 1000) + 60,
          controller_lease_seconds: 15,
          // No turn in flight — otherwise the fork entry is withheld by design.
          active_turn_id: null,
          current_status: "idle",
          active_flags: [],
          // What the bell reads. `pending_approvals` → needs_input (attributed by
          // thread_id), `thread_activity` → working. The third thread appears in
          // neither, so it is idle and must not be bucketed at all.
          pending_approvals: [
            { request_id: "approval-bell-e2e", thread_id: threadId, action: "run", data: {} },
          ],
          thread_activity: [{ thread_id: threadId2, phase: "tool", tool: "bash" }],
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
        window.__listThreadQueries = [];
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
              // Lets the test move a thread OUT of needs_input the way answering an
              // approval would, by pushing a fresh snapshot — the same channel the real
              // relay uses, so the client path under test is the real one.
              const push = () => {
                this.#emit({
                  type: "message",
                  payload: { protocol_version: RELAY_PROTOCOL_VERSION, kind: "session_snapshot", snapshot },
                });
              };
              // Answering the approval, the way the real relay would: the thread stops
              // needing input and starts WORKING. That intermediate live state is the
              // one a size-only retention guard silently drops.
              window.__answerApproval = () => {
                snapshot.pending_approvals = [];
                snapshot.thread_activity = [
                  { thread_id: threadId, phase: "tool", tool: "bash" },
                  { thread_id: threadId2, phase: "tool", tool: "bash" },
                ];
                push();
              };
              // ...and then it finishes, losing every state it had.
              // Another device deletes the project while this one still has it pinned.
              // Not the same path as deleting it HERE: nothing clears the local
              // selection, so this is the only way to exercise the fail-open branch.
              window.__setProjectsGone = (gone) => {
                window.__projectsGone = gone;
                snapshot.projects_revision = (snapshot.projects_revision || 1) + 1;
                push();
              };
              window.__finishTurn = () => {
                snapshot.thread_activity = [
                  { thread_id: threadId2, phase: "tool", tool: "bash" },
                ];
                push();
              };
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
              const q = request.query?.q;
              window.__listThreadQueries.push(q ?? null);
              // The idle row is withheld from the UNFILTERED answer on purpose: that
              // makes it exist only in the search slice, which is the one situation
              // `findVisibleThread`'s union has to handle and the one a list containing
              // every row can never test.
              const all = q
                ? [threadSummary, threadSummary2, threadSummary3, threadSummary4]
                : [threadSummary, threadSummary2, threadSummary3];
              // Answer a search the way the relay does — matching server-side over the
              // whole set — so the test proves `q` reached the wire and the client
              // rendered the RESPONSE, rather than filtering rows it already had.
              const matched = q
                ? all.filter((t) => (t.name || "").toLowerCase().includes(q.toLowerCase()))
                : all;
              this.#respond(actionId, {
                action: "list_threads",
                ok: true,
                snapshot,
                threads: { threads: matched },
              });
              return;
            }
            if (request.type === "fetch_projects") {
              this.#respond(actionId, {
                action: "fetch_projects",
                ok: true,
                snapshot,
                projects: {
                  projects: window.__projectsGone
                    ? []
                    : [{ id: "project-alpha", name: "Alpha project" }],
                  // The WORKING thread is the member, and the other two stay out. Under
                  // the pin that makes all three visible at once — one lifted into the
                  // project group, two left in their cwd group — which is what lets step
                  // 5 tell "the bell replaced the pinned group" apart from "the list
                  // happened to look the same".
                  //
                  // This map used to be deliberately EMPTY, because Projects mode
                  // dropped the Unassigned bucket and an empty bell was the symptom
                  // worth catching. There is no bucket to drop under a pin, so that
                  // fixture would now prove nothing.
                  thread_project_id: window.__projectsGone
                    ? {}
                    : { [threadId2]: "project-alpha" },
                  projects_revision: 1,
                },
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
      { relayId: RELAY_ID, threadId: THREAD_ID, threadId2: THREAD_ID_2, threadId3: THREAD_ID_3, threadId4: THREAD_ID_4 }
    );

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

    // Until the drawer is open the sidebar is measurable but clipped — visible to
    // Playwright, invisible to a user, and translated off-screen so every rect it
    // reports is negative.
    const openDrawer = async () => {
      await page.waitForSelector("#remote-nav-toggle-button", {
        state: "visible",
        timeout: TIMEOUT_MS,
      });
      const open = await page.evaluate(
        () => document.querySelector(".remote-app-shell")?.dataset.remoteNavState === "open"
      );
      if (!open) {
          await page.tap("#remote-nav-toggle-button");
      }
      // Wait for the GEOMETRY, not the attribute: the attribute flips first and the
      // drawer slides in on a transition, so measuring on the attribute reads the
      // sidebar still parked at translateX(-100%).
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
      await page.waitForSelector("#remote-threads-list .conversation-item", {
        timeout: TIMEOUT_MS,
      });
    };

    const rowIds = () =>
      page.$$eval("#remote-threads-list .conversation-item", (els) =>
        els.map((n) => n.dataset.threadId)
      );
    const groupLabels = () =>
      page.$$eval("#remote-threads-list .thread-group-name", (els) =>
        els.map((n) => n.textContent.trim())
      );
    const countLine = () =>
      page.evaluate(() =>
        document.querySelector("#remote-threads-count")?.textContent?.trim() || ""
      );
    const bellOn = () =>
      page.evaluate(() =>
        Boolean(
          document.querySelector(".sidebar-bell-toggle")?.classList.contains("is-active")
        )
      );
    // Never blind-toggle: read the control, then act. A tap that assumed the wrong
    // starting position turns "switch it off" into "switch it on" and the failure lands
    // several assertions later, pointing at the wrong thing.
    const setBell = async (want) => {
      if ((await bellOn()) !== want) {
        await page.tap(".sidebar-bell-toggle");
        await page.waitForFunction(
          (expected) =>
            Boolean(
              document
                .querySelector(".sidebar-bell-toggle")
                ?.classList.contains("is-active")
            ) === expected,
          want,
          { timeout: TIMEOUT_MS }
        );
      }
      assert.equal(await bellOn(), want, `bell should be ${want ? "on" : "off"}`);
    };

    // The Project switcher sits at the top of the drawer, where the Sessions/Projects
    // toggle used to be. Same read-then-act discipline as `setBell`: a blind tap on an
    // already-open menu closes it, and the option wait below would then hang for the
    // full timeout pointing at the wrong thing.
    const openSwitcherMenu = async () => {
      await page.waitForSelector(".sidebar .project-switcher-trigger", {
        state: "visible",
        timeout: TIMEOUT_MS,
      });
      const alreadyOpen = await page.evaluate(
        () =>
          document.querySelector(".sidebar .project-switcher-trigger")?.getAttribute("aria-expanded")
          === "true"
      );
      if (!alreadyOpen) {
        await page.tap(".sidebar .project-switcher-trigger");
      }
      await page.waitForSelector(".sidebar .project-switcher-menu", { timeout: TIMEOUT_MS });
    };

    const chooseSwitcherOption = async (label) => {
      await openSwitcherMenu();
      await projectSwitcherOption(page, label, { scope: ".sidebar" }).tap({ timeout: TIMEOUT_MS });
      // Settle on the CHIP, not on a timer: the menu closes immediately while the list
      // regroups a render later. The trigger is an icon now and says nothing, so the
      // chip is the only thing that reports which project is pinned.
      await page.waitForFunction(
        (expected) => {
          const chip = document.querySelector("#remote-pinned-project .pinned-project-chip-name");
          return expected === "Default Workspace"
            ? !document.querySelector("#remote-pinned-project")
            : chip?.textContent?.trim() === expected;
        },
        label,
        { timeout: TIMEOUT_MS }
      );
    };

    const selectDefaultWorkspaceInSwitcher = () => chooseSwitcherOption("Default Workspace");

    await openDrawer();
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    );

    // 1. The bell has to be REACHABLE at 390px. `.sidebar-top-bar` is display:none under
    // 960px and only re-shown for `.remote-app-shell` — a CSS edit could remove the only
    // entry point on a phone while every other test still passed.
    const bellBox = await page.evaluate(() => {
      const button = document.querySelector(".sidebar-bell-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        width: rect.width,
        height: rect.height,
        visible: style.display !== "none" && style.visibility !== "hidden",
        insideViewport: rect.right <= window.innerWidth + 1 && rect.left >= -1,
        rect: { left: rect.left, right: rect.right },
        viewport: window.innerWidth,
        navState: document.querySelector(".remote-app-shell")?.dataset.remoteNavState,
        sidebar: (() => {
          const aside = document.querySelector(".remote-app-shell .sidebar");
          const r = aside?.getBoundingClientRect();
          return r ? { left: r.left, right: r.right, width: r.width } : null;
        })(),
      };
    });
    assert.ok(bellBox, "the bell button must exist on the remote surface");
    assert.equal(bellBox.visible, true, "the bell must be visible at mobile width");
    assert.ok(bellBox.width > 0 && bellBox.height > 0, `the bell must be laid out: ${JSON.stringify(bellBox)}`);
    assert.equal(bellBox.insideViewport, true, `the bell must not overflow a 390px drawer: ${JSON.stringify(bellBox)}`);
    assert.equal(await bellOn(), false, "the bell starts off");

    const restingGroups = await groupLabels();
    assert.ok(
      !restingGroups.includes("Needs input"),
      `resting groups should be workspace folders, got ${JSON.stringify(restingGroups)}`
    );

    // 2. Turning it on buckets by state and drops the idle row.
    await setBell(true);
    console.error("after click:", JSON.stringify(await page.evaluate(() => ({
      active: document.querySelector(".sidebar-bell-toggle")?.classList.contains("is-active"),
      groups: [...document.querySelectorAll("#remote-threads-list .thread-group-name")].map((n) => n.textContent.trim()),
      rows: [...document.querySelectorAll("#remote-threads-list .conversation-item")].map((n) => n.dataset.threadId),
    }))));
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .join("|") === "Needs input|Working",
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`bell buckets were ${JSON.stringify(await groupLabels())}`);
    });
    assert.equal(await bellOn(), true);
    const bucketed = await rowIds();
    assert.deepEqual(bucketed, [THREAD_ID, THREAD_ID_2], `bucketed rows: ${JSON.stringify(bucketed)}`);
    assert.ok(!bucketed.includes(THREAD_ID_3), "an idle session has no state and no bucket");

    // 3. No pill row, on either surface. The drawer is 390px wide: a row of four pills
    // above the list restated the bucket headers underneath it and spent the scarcest
    // vertical space on the phone doing it.
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll("#remote-activity-filter, .activity-filter-pill").length
      ),
      0,
      "the bell must not render a pill row"
    );

    // 4. Retention across the FULL chain: one bucket → another live state → stateless.
    // Splitting it (the first draft went straight to stateless) hides the bug where the
    // store-write is guarded on Map size: a row MOVING between states changes only a
    // value, so the write is skipped and the row snaps back to the bucket it started in
    // once it loses its state.
    //
    // This is also the only coverage of the effect that drives retention on remote — if
    // it never settled, the page would spin here instead of asserting.
    await page.evaluate(() => window.__answerApproval?.());
    await page.waitForFunction(
      (id) => {
        const row = document.querySelector(`#remote-threads-list [data-thread-id="${id}"]`);
        const group = row?.closest(".thread-group, [data-thread-list-scroll-root]");
        void group;
        const labels = [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim());
        return Boolean(row) && labels.includes("Working");
      },
      THREAD_ID,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `after answering, groups were ${JSON.stringify(await groupLabels())} rows ${JSON.stringify(await rowIds())}`
      );
    });

    await page.evaluate(() => window.__finishTurn?.());
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim())
          .includes("Done"),
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`after finishing, groups were ${JSON.stringify(await groupLabels())}`);
    });

    // Now make it genuinely STATELESS. A finished background thread still carries a
    // `completed` badge; opening it clears that badge (`threadAttention.clear` in
    // handleResumeThread), so the row loses every state it had at the exact moment the
    // user touches it. That is when the remembered bucket is the only thing keeping it
    // on screen — and where a store-write skipped on "same size" shows up, because the
    // memory would still say `needs_input` from three transitions ago.
    await page.tap(`#remote-threads-list [data-thread-id="${THREAD_ID}"]`);
    await page.waitForTimeout(1200);
    await openDrawer();
    const afterOpen = await rowIds();
    assert.ok(
      afterOpen.includes(THREAD_ID),
      `the row you just opened must not vanish, got ${JSON.stringify(afterOpen)}`
    );
    assert.ok(
      !(await groupLabels()).includes("Needs input"),
      `a stateless row must rest in the bucket it was LAST really in, not the one it joined by; groups: ${JSON.stringify(await groupLabels())}`
    );

    // 5. The bell must STAND THE PIN DOWN, and the pin must come back afterwards.
    //
    // This step used to drive a Sessions/Projects toggle. That toggle is gone: the
    // Project switcher pins a project to the top of the list instead of swapping the
    // grouping axis. The invariant survived the mechanism change but its failure mode
    // did not — the bell no longer risks reading a projects-filtered source, it risks
    // COMPOSING with the pin, which cannot work: `buildThreadStateGroups` replaces the
    // group structure outright rather than narrowing rows inside it. A pinned group
    // that appeared to survive the bell would be a stale render, not a feature.
    await setBell(false);
    await chooseSwitcherOption("Alpha project");

    // Pinned: the project leads the list, and the sessions that are NOT in it are
    // still listed below. Asserting only the first half would pass a pin that had
    // quietly become a filter.
    //
    // The pinned group renders NO header at all — the chip above the list names it — so
    // "is it pinned" is answered by the ROW ORDER plus the chip, never by a header
    // label. Asserting on a label here would be asserting the duplication this design
    // exists to remove.
    assert.equal(
      await page.evaluate(() =>
        document.querySelector("#remote-pinned-project .pinned-project-chip-name")?.textContent?.trim()
      ),
      "Alpha project",
      "the chip names the pinned project"
    );
    assert.equal(
      (await rowIds())[0],
      THREAD_ID_2,
      `the pinned project's session must lead the list, got ${JSON.stringify(await rowIds())}`
    );
    const pinnedRows = await rowIds();
    for (const id of [THREAD_ID, THREAD_ID_2, THREAD_ID_3]) {
      assert.ok(
        pinnedRows.includes(id),
        `a pin hides nothing — ${id} missing from ${JSON.stringify(pinnedRows)}`
      );
    }

    await setBell(true);
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll("#remote-threads-list .conversation-item")];
        const labels = [...document.querySelectorAll("#remote-threads-list .thread-group-name")]
          .map((n) => n.textContent.trim());
        return (
          rows.some((row) => row.dataset.threadId === id)
          && labels.includes("Working")
          // The pin stood down entirely, chip included — the bell replaces the group
          // structure rather than narrowing inside it.
          && !document.querySelector("#remote-pinned-project")
        );
      },
      THREAD_ID_2,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the bell did not stand the pin down: groups ${JSON.stringify(await groupLabels())} rows ${JSON.stringify(await rowIds())}`
      );
    });

    // ...and switching the bell off restores the pin rather than leaving the selection
    // stranded. The selection lives in the store and the pin is derived per render, so
    // a stand-down that mutated the selection would look identical here until you
    // turned the bell off.
    await setBell(false);
    await page.waitForFunction(
      () =>
        document.querySelector("#remote-pinned-project .pinned-project-chip-name")
          ?.textContent?.trim() === "Alpha project",
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the pin did not come back after the bell: ${JSON.stringify(await groupLabels())}`
      );
    });

    // The menu has to LAND inside the drawer, not merely declare a right anchor. It
    // opens from a right-aligned top-bar button, carries a 220px minimum width, and the
    // drawer clips horizontal overflow — so a left-anchored menu put its far edge and
    // its first option somewhere the user could not reach, with nothing failing.
    //
    // Checked at two widths because the drawer is `min(360px, 100vw - 48px)`: at 390px
    // it is 342px and at 320px it is 272px, which is only 52px wider than the menu's
    // own minimum. A single width would not notice an anchor that merely happens to fit.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await openSwitcherMenu();
      const box = await page.evaluate(() => {
        const menu = document.querySelector(".sidebar .project-switcher-menu");
        const drawer = document.querySelector(".remote-app-shell .sidebar");
        const m = menu.getBoundingClientRect();
        const d = drawer.getBoundingClientRect();
        return { left: m.left, right: m.right, dLeft: d.left, dRight: d.right, w: m.width };
      });
      assert.ok(
        box.left >= box.dLeft - 1 && box.right <= box.dRight + 1,
        `at ${width}px the switcher menu escapes the drawer: menu [${Math.round(box.left)}, `
          + `${Math.round(box.right)}] vs drawer [${Math.round(box.dLeft)}, ${Math.round(box.dRight)}]`
      );
      // Escape rather than a blind tap: the trigger may be under the open menu.
      await page.keyboard.press("Escape");
      await page.waitForSelector(".sidebar .project-switcher-menu", { state: "detached", timeout: TIMEOUT_MS });
    }
    await page.setViewportSize(MOBILE_VIEWPORT);

    // Two things only a browser can answer, and both shipped broken while the
    // source-level stylesheet guard stayed green — it resolves declarations, it does
    // not run a cascade or a layout.
    //
    // 1. The chip must read as a sibling of the group headers below it. Its rule and
    //    theirs agreed in the source while a `@media (max-width: 960px)` step-up moved
    //    only theirs, so the chip rendered a size smaller on the one device it exists
    //    for.
    const typography = await page.evaluate(() => {
      const pick = (el) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color };
      };
      return {
        chip: pick(document.querySelector(".pinned-project-chip-name")),
        header: pick(document.querySelector("#remote-threads-list .thread-group-name")),
      };
    });
    assert.ok(typography.chip && typography.header, "both the chip and a cwd header render");
    assert.deepEqual(
      typography.chip,
      typography.header,
      "the chip must be typographically identical to the group headers it stands in for"
    );

    // 2. A long name must clip inside the chip. The chip is a flex ITEM, whose automatic
    //    minimum size overrides `max-width: 100%` — so before this was fixed a long name
    //    grew it past the drawer and pushed its own × off screen.
    const overflow = await page.evaluate(() => {
      const name = document.querySelector(".pinned-project-chip-name");
      const chip = document.querySelector("#remote-pinned-project");
      const clear = document.querySelector(".pinned-project-chip-clear");
      name.textContent = "A ludicrously long project name that no drawer could ever hold";
      const parent = chip.parentElement.getBoundingClientRect();
      return {
        clipped: name.clientWidth < name.scrollWidth,
        clearInside: clear.getBoundingClientRect().right <= parent.right + 1,
      };
    });
    assert.equal(overflow.clipped, true, "a long project name ellipsizes");
    assert.equal(overflow.clearInside, true, "and the × stays inside the drawer");

    // The pin must fail OPEN when its project disappears from under it. The sessions
    // are all still there — blanking a list that has nothing wrong with it is the worse
    // answer once the failure mode is "not yet sorted" rather than "wrong". This is the
    // path a local delete cannot reach: the stored id survives, so every consumer has to
    // agree that it resolves to nothing.
    await page.evaluate(() => window.__setProjectsGone(true));
    await page.waitForFunction(
      () => !document.querySelector("#remote-pinned-project"),
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(() => {
      throw new Error("the chip outlived the project it names");
    });

    const survivors = await rowIds();
    for (const id of [THREAD_ID, THREAD_ID_2, THREAD_ID_3]) {
      assert.ok(
        survivors.includes(id),
        `failing open must keep the WHOLE list — ${id} missing from ${JSON.stringify(survivors)}`
      );
    }
    assert.equal(
      await page.evaluate(() =>
        document.querySelector(".sidebar .project-switcher-trigger")?.classList.contains("is-active")
      ),
      false,
      "and the icon must not stay lit for a project that no longer exists"
    );

    // Reversible: the selection was never destroyed, only unresolvable, so the project
    // coming back re-pins it without the user re-choosing.
    await page.evaluate(() => window.__setProjectsGone(false));
    await page.waitForFunction(
      () =>
        document.querySelector("#remote-pinned-project .pinned-project-chip-name")
          ?.textContent?.trim() === "Alpha project",
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(() => {
      throw new Error("the pin did not recover when its project came back");
    });

    // Back to the default workspace, so the steps below see an unpinned list.
    await selectDefaultWorkspaceInSwitcher();

    // 6. Search. The relay-side filter is what makes this worth having on a phone: the
    // list is truncated before it ever reaches the device, so a client-side filter could
    // only ever search the page already on screen.
    await setBell(false);
    await page.tap(".sidebar-search-toggle");
    await page.waitForSelector(".sidebar-search-input", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    // pressSequentially, NOT fill: `fill` sets the whole value and dispatches one event,
    // which is exactly what hid a controlled input bound to the debounced query — real
    // typing had React restore the old value after every keystroke, so a word ended up
    // searching for its last letter.
    await page.locator(".sidebar-search-input").pressSequentially("Quiet", { delay: 60 });
    await page.waitForFunction(
      () => document.querySelector(".sidebar-search-input")?.value === "Quiet",
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the field lost characters while typing: ${await page.inputValue(".sidebar-search-input")}`
      );
    });
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll("#remote-threads-list .conversation-item")];
        return rows.length === 1 && rows[0].dataset.threadId === id;
      },
      THREAD_ID_4,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`search left ${JSON.stringify(await rowIds())}`);
    });

    // It must be a RELAY query, not a local filter over the loaded rows.
    const sentQueries = await page.evaluate(() => window.__listThreadQueries);
    assert.ok(
      sentQueries.includes("Quiet"),
      `the WHOLE query must reach the wire, saw ${JSON.stringify(sentQueries)}`
    );
    assert.match(await countLine(), /result/, `count line: ${await countLine()}`);

    // Do this FIRST, while the search answer is the most recent thing that happened: the
    // 12s poll would otherwise repair `state.threads` before the assertion looked, and
    // hide a search that had overwritten it. Counting requests pins the mechanism —
    // the list must come back from state, not from a refetch.
    const queriesBeforeClose = (await page.evaluate(() => window.__listThreadQueries)).length;
    await page.tap(".sidebar-search-toggle");
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`closing search left ${JSON.stringify(await rowIds())}`);
    });
    const queriesAfterClose = (await page.evaluate(() => window.__listThreadQueries)).length;
    assert.equal(
      queriesAfterClose,
      queriesBeforeClose,
      "clearing a search must restore the list from state, not need a refetch — a search "
        + "answer must never have replaced the authoritative list in the first place"
    );

    // Reopen for the remaining search assertions.
    await page.tap(".sidebar-search-toggle");
    await page.waitForSelector(".sidebar-search-input", {
      state: "visible",
      timeout: TIMEOUT_MS,
    });
    await page.locator(".sidebar-search-input").pressSequentially("Quiet", { delay: 40 });
    await page.waitForFunction(
      (id) => {
        const rows = [...document.querySelectorAll("#remote-threads-list .conversation-item")];
        return rows.length === 1 && rows[0].dataset.threadId === id;
      },
      THREAD_ID_4,
      { timeout: TIMEOUT_MS }
    );

    // A search result must stay actionable — its "⋯" resolves through the same union
    // local needed, or the sheet reports no actions and does nothing.
    // The "⋯" is a SIBLING of the row button inside `.conversation-item-wrap`, not a
    // child of it — nesting buttons would be invalid HTML.
    await page.tap(
      `.conversation-item-wrap:has([data-thread-id="${THREAD_ID_4}"]) .conversation-more`
    );
    await page.waitForSelector(".remote-sheet, [role=dialog]", { timeout: TIMEOUT_MS }).catch(() => {});
    const sheetVisible = await page.evaluate(() =>
      Boolean([...document.querySelectorAll("button")].some((b) => /Fork session/.test(b.textContent)))
    );
    assert.equal(sheetVisible, true, "a searched row's actions sheet must open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Search and the bell compose: the bell narrows whatever the search produced.
    await setBell(true);
    await page.waitForFunction(
      () => document.querySelectorAll("#remote-threads-list .conversation-item").length === 0,
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(
        `the idle search hit should be filtered out by the bell, got ${JSON.stringify(await rowIds())}`
      );
    });
    await setBell(false);

    await page.tap(".sidebar-search-toggle");
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    );

    // 7. With the bell off, the resting grouping is back.
    await setBell(false);
    await page.waitForFunction((n) =>
      document.querySelectorAll("#remote-threads-list .conversation-item").length === n,
      3,
      { timeout: TIMEOUT_MS }
    ).catch(async () => {
      throw new Error(`turning the bell off left ${JSON.stringify(await rowIds())}`);
    });
    assert.equal(await bellOn(), false);
    assert.ok(
      !(await groupLabels()).some((label) =>
        ["Needs input", "Working", "Reviewing", "Done"].includes(label)
      ),
      `turning the bell off must restore the resting grouping, got ${JSON.stringify(
        await groupLabels()
      )}`
    );

    // Deleting the project you are IN. The store held the id, and nothing cleared it:
    // the chip vanished and cwd grouping came back (the switcher fails open on an id it
    // cannot resolve) while the top-bar icon stayed lit and no menu row was marked — one
    // control giving two answers. Worse, the dead id survived, so the next payload that
    // happened to carry that id would silently re-pin it.
    //
    // The stub keeps returning the project after the delete, which is what makes this
    // test about the STORE rather than about the payload: if the selection were not
    // cleared, the refetch would resolve it again and the chip would come straight back.
    page.on("dialog", (dialog) => void dialog.accept());
    await chooseSwitcherOption("Alpha project");
    await openSwitcherMenu();
    await page
      .locator(".sidebar .project-switcher-option", { hasText: /^Delete project$/ })
      .first()
      .tap({ timeout: TIMEOUT_MS });

    await page.waitForFunction(
      () => !document.querySelector("#remote-pinned-project"),
      undefined,
      { timeout: TIMEOUT_MS }
    ).catch(() => {
      throw new Error("the chip survived deleting its own project");
    });
    assert.equal(
      await page.evaluate(() =>
        document.querySelector(".sidebar .project-switcher-trigger")?.classList.contains("is-active")
      ),
      false,
      "the top-bar icon must not stay lit for a project that no longer exists"
    );
    await openSwitcherMenu();
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector(".sidebar .project-switcher-option.is-active")
          ?.querySelector(".project-switcher-option-label")
          ?.textContent?.trim()
      ),
      "Default Workspace",
      "and the menu marks where you actually are"
    );
    await page.keyboard.press("Escape");

    console.log("REMOTE_MOBILE_BELL_E2E: PASS");
  } catch (error) {
    console.error("REMOTE_MOBILE_BELL_E2E: FAIL");
    console.error(error);
    await writeFailureArtifacts(page, "remote-mobile-bell-e2e").catch(() => {});
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close?.().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
