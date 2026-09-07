import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldShowTranscriptLoading } from "./transcript-loading.js";

// P1 regression: render-session.js has ~30 direct `renderer.renderSession(...)`
// call sites in app.js plus several INTERNAL closures of its own (teamsCache.sync's
// resolve/reject, reviewsCache.sync's and workflowsCache.sync's resolves, the
// pairing-expiry timer, orchestratorChat's renderSession pass-through) that call
// the closure-local `renderSession` function directly — never through
// app.js's `renderer.renderSession` wrap, never through ctx.renderSession. A
// scheduler flush left pending when one of those fires would render immediately
// with the stale pre-projection array, then render AGAIN when the scheduler's
// own timer later catches up. This can only be closed from INSIDE renderSession
// itself, so a real DOM-driven test isn't the point here (see boot-tdz-guard.test.mjs
// for why this file avoids that) — the source itself is the artifact under test.
test("renderSession clears the pending transcript flush itself, so every direct call site (internal or external) gets it", () => {
  const source = readFileSync(new URL("./render-session.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderSession(session) {");
  assert.ok(start >= 0, "render-session.js should still define renderSession(session)");
  const bodyEnd = source.indexOf("state.session = session;", start);
  assert.ok(bodyEnd >= 0, "renderSession should still assign state.session near its top");
  const prologue = source.slice(start, bodyEnd);
  assert.match(
    prologue,
    /cancelPendingTranscriptFlush\(\)/,
    "renderSession must call cancelPendingTranscriptFlush() before assigning state.session, " +
      "so internal callbacks that call renderSession directly (not through app.js's wrap) still " +
      "cancel a pending scheduler flush instead of leaving it to double-render"
  );
});

test("renderConversationContent publishes through the LocalShell transcript slot without owning a nested root", () => {
  const source = readFileSync(new URL("./render-session.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderConversationContent(content) {");
  assert.ok(start >= 0, "render-session.js should still define renderConversationContent(content)");
  const end = source.indexOf("\n}\n\nexport function createSessionRenderer", start);
  assert.ok(end > start, "renderConversationContent should stay above createSessionRenderer");
  const body = source.slice(start, end);

  assert.doesNotMatch(
    source,
    /createRoot\s*\(\s*transcript\s*\)/,
    "render-session.js must not create a React root on #transcript"
  );
  assert.doesNotMatch(
    source,
    /\btranscriptRoot(?:Element)?\b/,
    "render-session.js must not retain transcript-specific root handles"
  );
  assert.match(
    body,
    /flushSync\s*\(\s*\(\)\s*=>\s*\{[\s\S]*publishLocalTranscriptSlotContent\s*\(\s*content\s*\)/,
    "renderConversationContent must publish the transcript slot inside flushSync"
  );
});

test("shouldShowTranscriptLoading requires a matching loading hydration state", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    true
  );
});

test("shouldShowTranscriptLoading stays hidden when the transcript is not truncated", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: false },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    false
  );
});

test("shouldShowTranscriptLoading stays hidden when the hydration state is idle", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
        transcriptHydrationStatus: "idle",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    false
  );
});

test("shouldShowTranscriptLoading stays hidden without a matching base snapshot", () => {
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: null,
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-1",
      }
    ),
    false
  );
  assert.equal(
    shouldShowTranscriptLoading(
      { active_thread_id: "thread-1", transcript_truncated: true },
      {
        transcriptHydrationBaseSnapshot: { active_thread_id: "thread-2" },
        transcriptHydrationStatus: "loading",
        transcriptHydrationThreadId: "thread-2",
      }
    ),
    false
  );
});
