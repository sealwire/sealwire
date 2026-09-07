// LocalTranscriptPanel now owns the stableTranscriptOptions cache itself (see
// .sealwire/PLAN.md): it calls buildTranscriptOptions in its entries branch
// and hands the cached result to TranscriptPane. This proves that wiring
// behaviorally — by capturing the actual object TranscriptPane receives
// across real re-renders — rather than by grepping source text for a ref
// assignment. A module loader stub swaps ../shared/transcript-pane.js for a
// spy that records every props object TranscriptPane is called with and
// renders nothing, so the real LocalTranscriptPanel (and its real
// stableTranscriptOptions caching) runs unmodified.
//
// frontend/remote/transcript-options-identity.test.mjs is the sibling
// precedent this follows for RemoteTranscriptPanel's own transcriptOptions
// ref.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { JSDOM } from "jsdom";

const spySource = [
  "export const transcriptPaneCalls = [];",
  "export function TranscriptPane(props) {",
  "  transcriptPaneCalls.push(props);",
  "  return null;",
  "}",
].join("\n");

register(
  `data:text/javascript,
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("/shared/transcript-pane.js") && !specifier.startsWith("file:")) {
        return { url: "transcript-pane-spy:main", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url === "transcript-pane-spy:main") {
        return {
          format: "module",
          shortCircuit: true,
          source: ${JSON.stringify(spySource)},
        };
      }
      return nextLoad(url, context);
    }
  `,
  import.meta.url
);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalTranscriptPanel } = await import("./local-transcript-panel.js");
const { transcriptPaneCalls } = await import("../shared/transcript-pane.js");

const h = React.createElement;

function entriesFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `item-${index}`,
    kind: index === 0 ? "user_text" : "assistant_text",
    text: `line ${index}`,
  }));
}

function baseProps(overrides = {}) {
  return {
    activeThreadId: "thread-a",
    activeThreadLabel: "",
    approval: null,
    buildTranscriptOptions: () => ({}),
    entries: entriesFor(2),
    entriesCanWrite: true,
    getStandbyEmptyContent: () => null,
    hydrationLoading: false,
    onLoadOlderTranscript: () => {},
    promotion: null,
    readyCopy: "",
    requestedSessionLabel: "",
    resetEpoch: 0,
    scrollElement: null,
    session: { active_thread_id: "thread-a" },
    shortId: (value) => (value ? String(value).slice(0, 8) : "unknown"),
    standbyCanWrite: true,
    viewOnly: false,
    viewOnlyReviewView: false,
    viewedThreadLocked: false,
    viewedThreadWorkflowLocked: false,
    viewingConversation: true,
    viewingDifferentThread: false,
    ...overrides,
  };
}

// Re-renders the SAME root so transcriptOptionsRef persists across renders
// exactly like a real update (a fresh root per render would reset the ref).
function mountHarness(initialProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(LocalTranscriptPanel, initialProps));
  });
  return {
    rerender(nextProps) {
      act(() => {
        root.render(h(LocalTranscriptPanel, nextProps));
      });
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

// Only the entries-branch TranscriptPane call carries a transcriptOptions
// field; the empty-ready branch's call does not.
function entriesBranchCalls() {
  return transcriptPaneCalls.filter((props) => "transcriptOptions" in props);
}

test("the transcriptOptions object handed to TranscriptPane keeps a stable reference across an unrelated re-render", () => {
  const onEnsureFileChangeDetail = () => {};
  const buildTranscriptOptions = () => ({ provider: "claude", onEnsureFileChangeDetail });
  transcriptPaneCalls.length = 0;

  const harness = mountHarness(baseProps({ buildTranscriptOptions }));
  // A fresh-but-equal entries array on the second render mirrors what a real
  // unrelated re-render produces — buildTranscriptOptions returns a fresh
  // object with the same field values both times.
  harness.rerender(baseProps({ buildTranscriptOptions, entries: entriesFor(2) }));

  const calls = entriesBranchCalls();
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].transcriptOptions,
    calls[0].transcriptOptions,
    "an unrelated re-render must not hand TranscriptPane a new transcriptOptions object"
  );

  harness.cleanup();
});

test("the transcriptOptions object handed to TranscriptPane changes identity when a handler reference changes", () => {
  transcriptPaneCalls.length = 0;

  const harness = mountHarness(
    baseProps({
      buildTranscriptOptions: () => ({ provider: "claude", onEnsureFileChangeDetail: () => {} }),
    })
  );
  // provider stays "claude" on both renders — only the handler reference
  // differs, isolating that the reference check (not the value check below)
  // is what invalidates the cache here.
  harness.rerender(
    baseProps({
      buildTranscriptOptions: () => ({ provider: "claude", onEnsureFileChangeDetail: () => {} }),
    })
  );

  const calls = entriesBranchCalls();
  assert.equal(calls.length, 2);
  assert.notEqual(
    calls[1].transcriptOptions,
    calls[0].transcriptOptions,
    "a changed onEnsureFileChangeDetail reference must produce a new transcriptOptions object"
  );

  harness.cleanup();
});

test("the transcriptOptions object handed to TranscriptPane changes identity when a non-handler field changes, even with the same handler reference", () => {
  transcriptPaneCalls.length = 0;
  const onEnsureFileChangeDetail = () => {};

  const harness = mountHarness(
    baseProps({
      buildTranscriptOptions: () => ({ provider: "claude", onEnsureFileChangeDetail }),
    })
  );
  // The handler reference is reused verbatim on the second render — only
  // provider changes — so this isolates the value-equality check on a plain
  // field from the reference check the test above covers.
  harness.rerender(
    baseProps({
      buildTranscriptOptions: () => ({ provider: "codex", onEnsureFileChangeDetail }),
    })
  );

  const calls = entriesBranchCalls();
  assert.equal(calls.length, 2);
  assert.notEqual(
    calls[1].transcriptOptions,
    calls[0].transcriptOptions,
    "a changed provider value must produce a new transcriptOptions object even though the handler reference is unchanged"
  );

  harness.cleanup();
});
