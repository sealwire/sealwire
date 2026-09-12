// Regression: active Cursor thread reply grows beyond the 1,600-character
// LocalWeb preview cap without a reload.
//
// `93be26b6` wired ACP foreground threads to emit TranscriptDelta broker
// messages so the browser receives live deltas instead of waiting for the
// compacted snapshot.  `94f26e39` fixed the hydration gate to gate repair on
// the raw pre-merge snapshot rather than the merged one, so a cached-full body
// that hides the clip no longer suppresses the authoritative tail fetch.
//
// What this proves:
//   * `applyLocalTranscriptEntryDelta` accepted at least one non-empty
//     active-thread frame and reported item id + text length before/after.
//     SSE arrival alone is not enough: a rejected frame plus hydration can
//     also grow the item.
//   * One of those reducer-applied observations itself crosses PREVIEW_CAP
//     (at-or-below 1,600 → above 1,600) on the tested item.
//   * The same visible DOM node is independently recorded below and above the
//     cap while the relay still reports a live turn on that thread, in the
//     original document.  Crossing after `active_turn_id` clears is post-turn
//     hydration and does not count.
//   * That node's BoundingClientRect intersects the viewport, not merely a
//     nonzero rectangle parked above the fold.
//   * The document identity did not change across the reply (no navigation /
//     reload replaced it while the turn ran).
//   * The relay still identifies the cloned thread as the active thread after
//     the reply is complete.
//
// Hermetic: CURSOR_CONFIG_DIR points at a temp dir holding exactly one
// throwaway clone of a real session, re-targeted at a throwaway cwd.  The
// user's own sessions are never listed or prompted.  It costs one real Cursor
// turn.  With no local sessions to clone it skips cleanly.
//
// Run: npm run test:browser:cursor-active-tail
// Row identity is `row_id`; `item_id` is the relay's compatibility alias carrying
// the same value (see frontend/shared/transcript-row-key.js). Reading the alias
// alone makes these assertions pass whatever the two do, so they guard nothing —
// prefer `row_id` for the same reason client code must.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createArtifactWriter } from "./e2e/harness/artifacts.mjs";
import { launchBrowser } from "./e2e/harness/browser.mjs";
import { startLocalRelay } from "./e2e/harness/local-relay.mjs";
import { getFreePort } from "./e2e/harness/ports.mjs";
import { dumpProcessLogs, stopManagedProcess, waitForHealth } from "./e2e/harness/process.mjs";

const TIMEOUT_MS = Number(process.env.CURSOR_ACTIVE_TAIL_E2E_TIMEOUT_MS || 60_000);
const TURN_TIMEOUT_MS = Number(process.env.CURSOR_ACTIVE_TAIL_TURN_TIMEOUT_MS || 300_000);
const DEVICE_ID = "cursor-active-tail-e2e";
// Fixed so a killed run leaves a findable directory rather than accumulating
// random ones.
const CLONE_ID = "e2eac71v-e000-4000-8000-0000000ac71e";
// The preview cap the LocalWeb snapshot compacts replies to.
export const PREVIEW_CAP = 1600;
// One letter per line × this count produces a deterministic, easily-measured
// reply longer than PREVIEW_CAP.  No tools, no file reads, cheap to generate.
const LINE_COUNT = Math.ceil((PREVIEW_CAP + 400) / 3);
// Deterministic content.  The marker lets the assertion skip accidental
// matches against the user-prompt echo that some models include.
const REPLY_MARKER = "cursor-active-tail-e2e-line-";
const PROMPT =
  `Reply with exactly ${LINE_COUNT} lines.  Each line must be exactly: `
  + `"${REPLY_MARKER}<N>" where <N> is the line number starting from 1.  `
  + "Do not use any tools, do not read or write any files, do not add any "
  + "extra text before or after the lines.";

export function parseSseEventBlock(raw) {
  if (!String(raw ?? "").trim()) {
    return null;
  }
  let eventType = "message";
  const dataLines = [];
  for (const line of String(raw ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!dataLines.length) {
    return null;
  }
  return { type: eventType, data: dataLines.join("\n") };
}

/// Count SSE frames whose event name is `transcript_entry_delta`.
///
/// The relay names the event on the `event:` line.  The JSON body has
/// `delta_kind` / `item_id` and no `kind` field — looking at `obj.kind` is
/// how a first recorded run reported `deltaCount: 0` on a live stream.
export function countTranscriptEntryDeltas(text) {
  const normalized = String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let count = 0;
  let lastItemId = null;
  for (const raw of normalized.split("\n\n")) {
    const frame = parseSseEventBlock(raw);
    if (frame?.type !== "transcript_entry_delta") {
      continue;
    }
    count += 1;
    try {
      const obj = JSON.parse(frame.data);
      if (obj?.row_id ?? obj?.item_id) {
        lastItemId = obj.row_id ?? obj.item_id;
      }
    } catch {
      // A well-formed event name still counts even if the body is damaged.
    }
  }
  return { count, lastItemId };
}

/// One reducer-applied observation that itself crosses the preview cap.
///
/// Cumulative growth across many accepted frames is not enough: the e2e must
/// see a single accepted delta take the item from at-or-below the cap to above.
export function findReducerAppliedCrossing(observations, cap = PREVIEW_CAP) {
  for (const observation of observations || []) {
    const before = Number(observation?.textLengthBefore);
    const after = Number(observation?.textLengthAfter);
    if (
      observation?.itemId
      && Number.isFinite(before)
      && Number.isFinite(after)
      && before <= cap
      && after > cap
    ) {
      return observation;
    }
  }
  return null;
}

function liveSampleMatches(sample, { threadId, turnId = null, documentUid = null }) {
  if (!sample?.itemId || !sample.nodeUid || !sample.inViewport) {
    return false;
  }
  if (documentUid && sample.documentUid !== documentUid) {
    return false;
  }
  if (sample.activeThreadId !== threadId || !sample.activeTurnId) {
    return false;
  }
  if (turnId && sample.activeTurnId !== turnId) {
    return false;
  }
  return true;
}

function postSampleStillLive(sample, { threadId, turnId = null }) {
  if (!("postActiveThreadId" in sample) && !("postActiveTurnId" in sample)) {
    return false;
  }
  if (sample.postActiveThreadId !== threadId || !sample.postActiveTurnId) {
    return false;
  }
  if (turnId && sample.postActiveTurnId !== turnId) {
    return false;
  }
  return true;
}

/// Find proof that one live DOM element, not merely one item id, was visible on
/// both sides of the preview cap.
export function findLiveDomNodeEvidence(
  samples,
  { itemId, threadId, turnId = null, cap = PREVIEW_CAP, documentUid = null, requirePostSampleLive = false } = {}
) {
  if (!itemId || !threadId) {
    return null;
  }
  const byNode = new Map();
  for (const sample of samples || []) {
    if (
      sample?.itemId !== itemId
      || !liveSampleMatches(sample, { threadId, turnId, documentUid })
    ) {
      continue;
    }
    const bucket = byNode.get(sample.nodeUid) || [];
    bucket.push(sample);
    byNode.set(sample.nodeUid, bucket);
  }

  for (const bucket of byNode.values()) {
    bucket.sort((a, b) => (Number(a.sampledAt) || 0) - (Number(b.sampledAt) || 0));
    for (const below of bucket) {
      if (!(Number(below.textLength) <= cap)) {
        continue;
      }
      for (const above of bucket) {
        if (!(Number(above.textLength) > cap)) {
          continue;
        }
        const belowAt = Number(below.sampledAt);
        const aboveAt = Number(above.sampledAt);
        if (Number.isFinite(belowAt) && Number.isFinite(aboveAt) && belowAt > aboveAt) {
          continue;
        }
        if (below.activeTurnId !== above.activeTurnId) {
          continue;
        }
        if (requirePostSampleLive && !postSampleStillLive(above, { threadId, turnId })) {
          continue;
        }
        return { below, above };
      }
    }
  }
  return null;
}

/// Viewport intersection, not "any nonzero rectangle".
///
/// A node at `top: -5208` with height 85 has a real BoundingClientRect and is
/// still entirely off-screen.  `innerText` / a nonzero box is not evidence.
export function rectIntersectsViewport(rect, viewport) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    return false;
  }
  const width = Number(viewport?.width) || 0;
  const height = Number(viewport?.height) || 0;
  const top = Number(rect.top) || 0;
  const left = Number(rect.left) || 0;
  const right = left + rect.width;
  const bottom = top + rect.height;
  return right > 0 && bottom > 0 && left < width && top < height;
}

async function main() {
  const sessionsDir = path.join(realCursorConfigDir(), "acp-sessions");
  const source = await findClonableSession(sessionsDir);
  if (!source) {
    console.log(JSON.stringify({ ok: true, skipped: "no local Cursor ACP session to clone" }));
    return;
  }

  const cursorConfigDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-cursor-active-tail-cfg-")
  );
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-relay-cursor-active-tail-state-")
  );
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-cursor-active-tail-ws-"))
  );
  const cloneDir = path.join(cursorConfigDir, "acp-sessions", CLONE_ID);
  const artifacts = createArtifactWriter("cursor-active-tail-e2e");

  let relay;
  let browser;
  let context;
  let page;

  try {
    // Clone: copy the session store, re-point at a throwaway cwd so the agent
    // runs in an empty directory and never touches the user's checkout.
    await fs.cp(source.dir, cloneDir, { recursive: true });
    await fs.writeFile(
      path.join(cloneDir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        cwd: workspaceDir,
        title: "Relay active-tail e2e",
      })
    );

    const relayPort = await getFreePort();
    relay = startLocalRelay({
      relayPort,
      relayStatePath: path.join(stateDir, "session.json"),
      extraEnv: {
        AGENT_PROVIDERS: "cursor,fake",
        CURSOR_CONFIG_DIR: cursorConfigDir,
        PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH || ""}`,
      },
    });
    await waitForHealth(`http://127.0.0.1:${relayPort}/api/health`, TIMEOUT_MS);

    // Bail if cursor is not available or not connected.
    const providers = await getJson(relayPort, "/api/providers");
    if (!providers.data?.includes("cursor")) {
      console.log(JSON.stringify({ ok: true, skipped: "cursor provider is not available" }));
      return;
    }
    const providerStatus = (await getJson(relayPort, "/api/session")).data?.provider_status || [];
    const cursorStatus = providerStatus.find((row) => row.provider === "cursor");
    if (!cursorStatus?.connected) {
      console.log(
        JSON.stringify({
          ok: true,
          skipped: `cursor is not connected (${cursorStatus?.status}); run \`cursor-agent login\``,
        })
      );
      return;
    }

    // The isolated config must list exactly the clone — proves CURSOR_CONFIG_DIR
    // is honoured and nothing in the user's real sessions will be touched.
    const listed = await listCursorThreadIds(relayPort);
    assert.deepEqual(
      listed,
      [CLONE_ID],
      "isolated CURSOR_CONFIG_DIR must expose exactly the one cloned session"
    );

    ({ browser, context } = await launchBrowser({
      contextOptions: { viewport: { width: 1280, height: 900 } },
    }));
    page = await context.newPage();

    // Inject observers before the page JS loads.
    //
    // `__appliedLocalTranscriptDeltas` must exist before stream.js runs: the
    // reducer only pushes when the sink is already an array.  The local page
    // opens /api/stream via fetch (not EventSource).  We still tee that body
    // for diagnostics, but SSE counts cannot satisfy the assertion.
    await page.addInitScript(({ parserSource, replyMarker, cloneId }) => {
      const parseSseEventBlock = (0, eval)(`(${parserSource})`);
      window.__localDeltaCount = 0;
      window.__lastDeltaItemId = null;
      window.__documentUid = Math.random().toString(36).slice(2);
      window.__streamConnected = false;
      window.__relayObservedSession = {
        activeThreadId: null,
        activeTurnId: null,
        source: null,
        observedAt: 0,
      };
      window.__appliedLocalTranscriptDeltas = [];
      window.__domLiveSamples = [];
      const nodeUids = new WeakMap();
      const sampleKeys = new Map();
      let nextNodeUid = 1;

      function recordRelaySessionSnapshot(snapshot, source) {
        if (!snapshot || typeof snapshot !== "object") {
          return;
        }
        window.__relayObservedSession = {
          activeThreadId: snapshot.active_thread_id || null,
          activeTurnId: snapshot.active_turn_id || null,
          source,
          observedAt: Date.now(),
        };
      }
      window.__recordRelaySessionSnapshot = recordRelaySessionSnapshot;

      function currentObservedSession() {
        const session = window.__relayObservedSession || {};
        return {
          activeThreadId: session.activeThreadId || null,
          activeTurnId: session.activeTurnId || null,
          sessionSource: session.source || null,
          sessionObservedAt: session.observedAt || 0,
        };
      }
      window.__currentObservedRelaySession = currentObservedSession;

      async function refreshObservedSession(source) {
        try {
          const response = await fetch("/api/session", { cache: "no-store" });
          const payload = await response.json();
          recordRelaySessionSnapshot(payload?.data || payload, source);
        } catch (_) {}
        return currentObservedSession();
      }
      window.__refreshObservedRelaySession = refreshObservedSession;

      function nodeUidFor(node) {
        let uid = nodeUids.get(node);
        if (!uid) {
          uid = `node-${nextNodeUid}`;
          nextNodeUid += 1;
          nodeUids.set(node, uid);
        }
        return uid;
      }

      function recordDomSample(sample) {
        const key = [
          sample.itemId,
          sample.nodeUid,
          sample.textLength,
          sample.inViewport,
          sample.activeThreadId,
          sample.activeTurnId,
          sample.documentUid,
        ].join("|");
        if (sampleKeys.get(sample.nodeUid) === key) {
          return;
        }
        sampleKeys.set(sample.nodeUid, key);
        if (window.__domLiveSamples.length < 4000) {
          window.__domLiveSamples.push(sample);
        }
      }

      function sampleVisibleAssistantNodes() {
        const nodes = [
          ...document.querySelectorAll('[data-transcript-entry-kind="agent_text"]'),
          ...document.querySelectorAll('[data-transcript-entry-kind="msg"]'),
        ];
        const observed = currentObservedSession();
        const samples = [];
        for (const node of nodes) {
          const text = node.textContent || "";
          if (!text.includes(replyMarker)) {
            continue;
          }
          const itemId = node.getAttribute("data-transcript-entry-id");
          if (!itemId) {
            continue;
          }
          const rect = node.getBoundingClientRect();
          const inViewport =
            rect.width > 0
            && rect.height > 0
            && rect.right > 0
            && rect.bottom > 0
            && rect.left < window.innerWidth
            && rect.top < window.innerHeight;
          const sample = {
            itemId,
            nodeUid: nodeUidFor(node),
            textLength: text.length,
            inViewport,
            top: Math.round(rect.top),
            height: Math.round(rect.height),
            width: Math.round(rect.width),
            documentUid: window.__documentUid,
            sampledAt: Date.now(),
            activeThreadId: observed.activeThreadId,
            activeTurnId: observed.activeTurnId,
            sessionSource: observed.sessionSource,
            sessionObservedAt: observed.sessionObservedAt,
            liveForClone: observed.activeThreadId === cloneId && Boolean(observed.activeTurnId),
          };
          samples.push(sample);
          recordDomSample(sample);
        }
        return samples;
      }
      window.__sampleVisibleAssistantNodes = sampleVisibleAssistantNodes;

      function sampleOnAnimationFrame() {
        sampleVisibleAssistantNodes();
        requestAnimationFrame(sampleOnAnimationFrame);
      }
      requestAnimationFrame(sampleOnAnimationFrame);

      function observeStreamPart(part) {
        const frame = parseSseEventBlock(part);
        if (!frame) {
          return;
        }
        if (frame.type === "session") {
          try {
            recordRelaySessionSnapshot(JSON.parse(frame.data), "stream");
          } catch (_) {}
          return;
        }
        if (frame.type !== "transcript_entry_delta") {
          return;
        }
        window.__localDeltaCount += 1;
        try {
          const obj = JSON.parse(frame.data);
          if (obj?.row_id ?? obj?.item_id) {
            window.__lastDeltaItemId = obj.row_id ?? obj.item_id;
          }
        } catch (_) {}
      }

      function pathnameForFetchInput(input) {
        const url = typeof input === "string" ? input
          : input instanceof URL ? input.toString()
          : (input?.url ?? "");
        try {
          return new URL(url, window.location.href).pathname;
        } catch (_) {
          return "";
        }
      }

      const _fetch = window.fetch;
      window.fetch = function interceptedFetch(input) {
        const pathname = pathnameForFetchInput(input);
        const promise = _fetch.apply(this, arguments);
        if (pathname === "/api/session") {
          return promise.then((response) => {
            try {
              response.clone().json()
                .then((payload) => recordRelaySessionSnapshot(payload?.data || payload, "session-fetch"))
                .catch(() => {});
            } catch (_) {}
            return response;
          });
        }
        if (pathname !== "/api/stream") {
          return promise;
        }
        return promise.then((response) => {
          window.__streamConnected = true;
          if (!response.body) {
            return response;
          }
          try {
            const [a, b] = response.body.tee();
            (function scan() {
              const reader = b.getReader();
              const dec = new TextDecoder();
              let buf = "";
              function pump() {
                reader.read().then(({ done, value }) => {
                  if (done) {
                    return;
                  }
                  buf += dec.decode(value, { stream: true });
                  const parts = buf.split("\n\n");
                  buf = parts.pop() ?? "";
                  for (const part of parts) {
                    observeStreamPart(part);
                  }
                  pump();
                }).catch(() => {});
              }
              pump();
            }());
            return new Response(a, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch (_) {
            return response;
          }
        });
      };
    }, {
      parserSource: parseSseEventBlock.toString(),
      replyMarker: REPLY_MARKER,
      cloneId: CLONE_ID,
    });

    await page.goto(`http://127.0.0.1:${relayPort}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const log = document.querySelector("#client-log-root")?.textContent || "";
        return log.includes("Relay booted");
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    // Resume the clone — this makes it the active thread.  Do NOT park it on
    // another thread afterwards: the whole point of this test is the
    // active-thread live-tail path.
    const resumed = await postJson(relayPort, "/api/session/resume", {
      thread_id: CLONE_ID,
      device_id: DEVICE_ID,
    });
    assert.equal(resumed.ok, true, `resume failed: ${resumed.error?.message}`);

    await waitFor(
      async () => (await sessionData(relayPort)).active_thread_id === CLONE_ID,
      TIMEOUT_MS,
      "the relay never made the clone the active thread"
    );

    const opened = await page
      .getByText("Open live conversation")
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      await page.goto(
        `http://127.0.0.1:${relayPort}/?thread=${encodeURIComponent(CLONE_ID)}`,
        { waitUntil: "domcontentloaded" }
      );
    }

    await page.waitForFunction(
      () => {
        const t = document.querySelector("#transcript");
        return t && (t.textContent || "").trim().length > 0;
      },
      null,
      { timeout: TIMEOUT_MS }
    );

    const uidBefore = await page.evaluate(() => window.__documentUid);
    assert.ok(uidBefore, "document uid must be set by the init script");

    const sent = await postJson(relayPort, "/api/session/message", {
      text: PROMPT,
      thread_id: CLONE_ID,
      device_id: DEVICE_ID,
    });
    assert.equal(sent.ok, true, `sending the long prompt failed: ${sent.error?.message}`);

    const turnStartedAt = Date.now();
    const liveGrowth = await waitForLiveGrowth(page, {
      timeoutMs: TURN_TIMEOUT_MS,
    });

    await screenshot(page, artifacts, "turn-complete.png");

    await waitFor(
      async () => (await sessionData(relayPort)).active_turn_id == null,
      TURN_TIMEOUT_MS,
      "the relay turn never completed"
    );

    const uidAfter = await page.evaluate(() => window.__documentUid);
    const finalSession = await sessionData(relayPort);

    await artifacts.writeJson("measurements.json", {
      turnMs: Date.now() - turnStartedAt,
      deltaCount: liveGrowth.deltaCount,
      lastDeltaItemId: liveGrowth.lastDeltaItemId,
      streamConnected: liveGrowth.streamConnected,
      appliedDeltaCount: liveGrowth.appliedDeltas.length,
      reducerCrossing: liveGrowth.crossing,
      entryMeasureBelow: liveGrowth.domBelow,
      entryMeasureAbove: liveGrowth.measure,
      activeTurnIdWhileGrowing: liveGrowth.activeTurnId,
      activeTurnIdAfterAboveSample: liveGrowth.measure.postActiveTurnId,
      activeThreadId: finalSession.active_thread_id,
      activeTurnId: finalSession.active_turn_id,
    });

    assert.ok(
      liveGrowth.crossing,
      `no reducer-applied delta crossed PREVIEW_CAP=${PREVIEW_CAP}. `
      + `applied=${liveGrowth.appliedDeltas.length}, `
      + `sseDeltaCount=${liveGrowth.deltaCount}. `
      + "SSE arrival or hydration-only growth must not pass."
    );

    assert.equal(
      liveGrowth.crossing.itemId,
      liveGrowth.measure.itemId,
      `reducer crossing applied to ${liveGrowth.crossing.itemId}, but the node `
      + `that grew past the cap is ${liveGrowth.measure.itemId}`
    );

    assert.ok(
      liveGrowth.crossing.textLengthBefore <= PREVIEW_CAP
      && liveGrowth.crossing.textLengthAfter > PREVIEW_CAP,
      `reducer crossing is ${liveGrowth.crossing.textLengthBefore}→`
      + `${liveGrowth.crossing.textLengthAfter}, not a cap crossing`
    );

    assert.ok(
      liveGrowth.domBelow
      && liveGrowth.domBelow.itemId === liveGrowth.crossing.itemId
      && liveGrowth.domBelow.textLength <= PREVIEW_CAP
      && liveGrowth.domBelow.inViewport,
      `the same visible node was not recorded at or below PREVIEW_CAP during the live turn `
      + `(below=${JSON.stringify(liveGrowth.domBelow)})`
    );

    assert.equal(
      liveGrowth.domBelow.nodeUid,
      liveGrowth.measure.nodeUid,
      `the below-cap sample was node ${liveGrowth.domBelow.nodeUid}, but the above-cap `
      + `sample was node ${liveGrowth.measure.nodeUid}`
    );

    assert.equal(
      liveGrowth.domBelow.activeTurnId,
      liveGrowth.measure.activeTurnId,
      `the below-cap sample was captured during turn ${liveGrowth.domBelow.activeTurnId}, `
      + `but the above-cap sample was captured during turn ${liveGrowth.measure.activeTurnId}`
    );

    assert.ok(
      liveGrowth.measure.textLength > PREVIEW_CAP,
      `the live assistant node is only ${liveGrowth.measure.textLength} characters, `
      + `not past PREVIEW_CAP=${PREVIEW_CAP}`
    );

    assert.ok(
      liveGrowth.activeTurnId,
      "the node crossed the preview cap after the relay's turn had already ended "
      + "— that is post-turn hydration, not foreground deltas"
    );

    assert.equal(
      liveGrowth.crossing.turnId,
      liveGrowth.activeTurnId,
      `the reducer crossing was turn ${liveGrowth.crossing.turnId}, but the above-cap `
      + `DOM sample was captured during ${liveGrowth.activeTurnId}`
    );

    assert.equal(
      liveGrowth.measure.postActiveTurnId,
      liveGrowth.activeTurnId,
      `the relay no longer reported turn ${liveGrowth.activeTurnId} after the above-cap `
      + `DOM sample (post=${liveGrowth.measure.postActiveTurnId || "none"})`
    );

    assert.equal(
      uidAfter,
      uidBefore,
      "the document identity changed — a reload or navigation replaced the original "
      + "document while the active-thread reply was growing"
    );
    assert.equal(
      liveGrowth.domBelow.documentUid,
      uidBefore,
      "the below-cap DOM sample was not taken in the original document"
    );
    assert.equal(
      liveGrowth.measure.documentUid,
      uidBefore,
      "the above-cap DOM sample was not taken in the original document"
    );

    assert.ok(
      liveGrowth.measure.inViewport,
      `the assistant entry that grew past the cap does not intersect the viewport `
      + `(top=${liveGrowth.measure.top}, height=${liveGrowth.measure.height}). `
      + "A nonzero rectangle off-screen is not visible."
    );

    assert.equal(
      finalSession.active_thread_id,
      CLONE_ID,
      `the relay's active thread after the turn is ${finalSession.active_thread_id}, `
      + `not the cloned thread ${CLONE_ID}. `
      + "The thread must stay active throughout; it must not have been parked."
    );

    dumpProcessLogs(relay);
    console.log(
      JSON.stringify(
        {
          ok: true,
          clonedFrom: source.id,
          cloneId: CLONE_ID,
          turnMs: Date.now() - turnStartedAt,
          deltaCount: liveGrowth.deltaCount,
          lastDeltaItemId: liveGrowth.lastDeltaItemId,
          appliedDeltaCount: liveGrowth.appliedDeltas.length,
          reducerCrossing: liveGrowth.crossing,
          entryTextLengthBelow: liveGrowth.domBelow?.textLength ?? null,
          entryTextLength: liveGrowth.measure.textLength,
          entryInViewport: liveGrowth.measure.inViewport,
          entryNodeUid: liveGrowth.measure.nodeUid,
          activeTurnIdWhileGrowing: liveGrowth.activeTurnId,
          activeTurnIdAfterAboveSample: liveGrowth.measure.postActiveTurnId,
          activeThreadId: finalSession.active_thread_id,
          artifacts: artifacts.dir,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (page) {
      await screenshot(page, artifacts, "failure.png").catch(() => {});
    }
    await artifacts.writeProcessLog("relay.log", relay).catch(() => {});
    console.error(`[cursor-active-tail-e2e] artifacts: ${artifacts.dir}`);
    dumpProcessLogs(relay);
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await stopManagedProcess(relay);
    await fs.rm(cursorConfigDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

/// Poll the page and the relay together.  Growth after `active_turn_id`
/// clears is hydration and must not satisfy the assertion.  SSE arrival
/// without a reducer-applied cap crossing also must not satisfy it.
async function waitForLiveGrowth(page, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let sawLiveTurn = false;
  let lastMeasure = { found: false };
  let appliedDeltas = [];

  while (Date.now() < deadline) {
    const currentCrossing = findReducerAppliedCrossing(appliedDeltas);
    const stream = await page.evaluate(
      async (preferredItemId) => {
        const beforeSession = typeof window.__refreshObservedRelaySession === "function"
          ? await window.__refreshObservedRelaySession("driver-before-sample")
          : { activeThreadId: null, activeTurnId: null };
        const samples = typeof window.__sampleVisibleAssistantNodes === "function"
          ? window.__sampleVisibleAssistantNodes()
          : [];
        const measure = (
          preferredItemId
            ? samples.find((sample) => sample.itemId === preferredItemId)
            : null
        ) || samples.reduce((best, sample) => {
          if (!best) {
            return sample;
          }
          return sample.textLength > best.textLength ? sample : best;
        }, null);
        const afterSession = typeof window.__refreshObservedRelaySession === "function"
          ? await window.__refreshObservedRelaySession("driver-after-sample")
          : beforeSession;
        const measured = measure
          ? {
            ...measure,
            found: true,
            postActiveThreadId: afterSession.activeThreadId || null,
            postActiveTurnId: afterSession.activeTurnId || null,
            postSessionSource: afterSession.sessionSource || null,
            postSessionObservedAt: afterSession.sessionObservedAt || 0,
          }
          : {
            found: false,
            itemId: null,
            nodeUid: null,
            textLength: 0,
            inViewport: false,
            activeThreadId: beforeSession.activeThreadId || null,
            activeTurnId: beforeSession.activeTurnId || null,
            postActiveThreadId: afterSession.activeThreadId || null,
            postActiveTurnId: afterSession.activeTurnId || null,
          };
        return {
          deltaCount: window.__localDeltaCount || 0,
          lastDeltaItemId: window.__lastDeltaItemId || null,
          streamConnected: Boolean(window.__streamConnected),
          documentUid: window.__documentUid || null,
          observedSession: afterSession,
          appliedDeltas: Array.isArray(window.__appliedLocalTranscriptDeltas)
            ? window.__appliedLocalTranscriptDeltas.slice()
            : [],
          domSamples: Array.isArray(window.__domLiveSamples)
            ? window.__domLiveSamples.slice()
            : [],
          measure: measured,
        };
      },
      currentCrossing?.itemId || appliedDeltas.at(-1)?.itemId || null
    );
    const liveTurn =
      Boolean(stream.observedSession?.activeTurnId)
      && stream.observedSession?.activeThreadId === CLONE_ID;
    if (liveTurn) {
      sawLiveTurn = true;
    }
    appliedDeltas = stream.appliedDeltas;
    lastMeasure = stream.measure;

    const crossing = findReducerAppliedCrossing(appliedDeltas);
    const samples = lastMeasure.found
      ? [...stream.domSamples, lastMeasure]
      : stream.domSamples;
    const domEvidence = crossing
      ? findLiveDomNodeEvidence(samples, {
        itemId: crossing.itemId,
        threadId: CLONE_ID,
        turnId: crossing.turnId || null,
        documentUid: stream.documentUid,
        requirePostSampleLive: true,
      })
      : null;
    if (
      liveTurn
      && crossing
      && (!crossing.threadId || crossing.threadId === CLONE_ID)
      && domEvidence
    ) {
      return {
        measure: domEvidence.above,
        domBelow: domEvidence.below,
        crossing,
        appliedDeltas,
        deltaCount: stream.deltaCount,
        lastDeltaItemId: stream.lastDeltaItemId,
        streamConnected: stream.streamConnected,
        activeTurnId: domEvidence.above.activeTurnId,
      };
    }

    // The turn started and then ended without live growth past the cap.
    // Stop here so a later hydration fetch cannot satisfy the assertion.
    if (sawLiveTurn && !liveTurn) {
      break;
    }
    await delay(200);
  }

  const crossing = findReducerAppliedCrossing(appliedDeltas);
  throw new Error(
    `the same assistant node did not grow past PREVIEW_CAP=${PREVIEW_CAP} `
    + `via a reducer-applied delta while the relay reported a live turn. `
    + `sawLiveTurn=${sawLiveTurn}, `
    + `applied=${appliedDeltas.length}, `
    + `crossing=${crossing ? `${crossing.itemId} ${crossing.textLengthBefore}→${crossing.textLengthAfter}` : "none"}, `
    + `last item=${lastMeasure.itemId ?? "none"} `
    + `node=${lastMeasure.nodeUid ?? "none"} `
    + `len=${lastMeasure.textLength ?? 0} `
    + `turn=${lastMeasure.activeTurnId ?? "none"} `
    + `postTurn=${lastMeasure.postActiveTurnId ?? "none"}. `
    + "SSE arrival or post-turn hydration must not count."
  );
}

async function sessionData(relayPort) {
  return (await getJson(relayPort, "/api/session")).data || {};
}

async function listCursorThreadIds(relayPort) {
  return ((await getJson(relayPort, "/api/threads")).data?.threads || [])
    .filter((thread) => thread.provider === "cursor")
    .map((thread) => thread.id);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }
  throw new Error(message);
}

async function getJson(relayPort, pathname) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathname}`, {
    headers: { "X-Agent-Relay-CSRF": "1" },
  });
  return response.json();
}

async function postJson(relayPort, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${relayPort}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Relay-CSRF": "1" },
    body: JSON.stringify(body),
  });
  return response.json();
}

function realCursorConfigDir() {
  const explicit = process.env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "cursor") : path.join(os.homedir(), ".cursor");
}

async function findClonableSession(sessionsDir) {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === CLONE_ID) {
      continue;
    }
    const dir = path.join(sessionsDir, entry.name);
    if (!(await pathExists(path.join(dir, "store.db")))) {
      continue;
    }
    const meta = await fs
      .readFile(path.join(dir, "meta.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (meta?.cwd && meta?.title) {
      return { id: entry.name, dir, cwd: meta.cwd };
    }
  }
  return null;
}

async function pathExists(target) {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

async function screenshot(page, artifacts, name) {
  try {
    await fs.mkdir(artifacts.dir, { recursive: true });
    await page.screenshot({ path: path.join(artifacts.dir, name), fullPage: false });
  } catch {}
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
