// Live-render proof that a prepend of older history does not re-render
// existing entries. transcript-react.test.mjs only exercises
// TranscriptContent through renderToStaticMarkup, which has no concept of
// "did this component's render function actually run again" across an
// update; that requires a real mount + a second render into the same root.
// Kept in its own file so the jsdom globals below don't leak into the
// static-render suite.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  TranscriptContent,
  __readJustPrependedComputeCount,
  __resetJustPrependedComputeCount,
  __setTranscriptEntryImplRenderObserver,
} = await import("./shared/transcript-react.js");

const h = React.createElement;

// The render-count bookkeeping lives here, test-scoped, rather than as
// permanent production state (see __setTranscriptEntryImplRenderObserver's
// own doc: a per-item Map in the module would grow unboundedly over the
// app's lifetime and never shrink).
function installRenderCounter() {
  const counts = new Map();
  __setTranscriptEntryImplRenderObserver((itemId) => {
    counts.set(itemId, (counts.get(itemId) || 0) + 1);
  });
  return {
    read: (itemId) => counts.get(itemId) || 0,
    uninstall: () => __setTranscriptEntryImplRenderObserver(null),
  };
}

test("prepending older history does not re-render existing User/Agent entries", () => {
  const renderCounts = installRenderCounter();

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  // Reused by reference across both renders — exactly how a real prepend
  // arrives (older history is spliced onto the front; the entries already on
  // screen keep their own object identity untouched).
  const userEntry = { item_id: "u-1", kind: "user_text", text: "hello", status: "completed" };
  const agentEntry = { item_id: "a-1", kind: "agent_text", text: "hi there", status: "completed" };
  const options = { canFork: false };

  act(() => {
    root.render(h(TranscriptContent, { entries: [userEntry, agentEntry], options }));
  });

  assert.equal(renderCounts.read("u-1"), 1, "the user entry must render on first mount");
  assert.equal(renderCounts.read("a-1"), 1, "the agent entry must render on first mount");

  const olderEntry = { item_id: "u-0", kind: "user_text", text: "older", status: "completed" };
  act(() => {
    root.render(
      h(TranscriptContent, { entries: [olderEntry, userEntry, agentEntry], options })
    );
  });

  assert.equal(renderCounts.read("u-0"), 1, "the newly prepended entry must render");
  assert.equal(
    renderCounts.read("u-1"),
    1,
    "React.memo must have skipped the existing user entry — its render count must not have incremented"
  );
  assert.equal(
    renderCounts.read("a-1"),
    1,
    "React.memo must have skipped the existing agent entry — its render count must not have incremented"
  );

  act(() => root.unmount());
  renderCounts.uninstall();
  host.remove();
});

test("useJustPrependedItemIds skips its O(n) rebuild on a render that leaves entries untouched", () => {
  __resetJustPrependedComputeCount();

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  const entries = [
    { item_id: "u-1", kind: "user_text", text: "hello", status: "completed" },
    { item_id: "a-1", kind: "agent_text", text: "hi there", status: "completed" },
  ];
  const options = { canFork: false };

  act(() => {
    root.render(h(TranscriptContent, { approval: null, entries, options }));
  });
  assert.equal(__readJustPrependedComputeCount(), 1, "first mount must compute once");

  // Re-render with the SAME `entries` reference but a changed unrelated
  // prop (approval) — a render this component genuinely has to do, but one
  // that must not re-scan the whole prior entry list for nothing.
  act(() => {
    root.render(
      h(TranscriptContent, {
        approval: { request_id: "approval-1", summary: "do a thing" },
        entries,
        options,
      })
    );
  });
  assert.equal(
    __readJustPrependedComputeCount(),
    1,
    "a render with the same entries reference must not recompute the prepended-id scan"
  );

  // A genuinely new entries array (a real prepend/delta) must still recompute.
  act(() => {
    root.render(h(TranscriptContent, { approval: null, entries: [...entries], options }));
  });
  assert.equal(
    __readJustPrependedComputeCount(),
    2,
    "a render with a new entries reference must recompute"
  );

  act(() => root.unmount());
  host.remove();
});
