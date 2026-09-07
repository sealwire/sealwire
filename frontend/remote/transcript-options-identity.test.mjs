// RemoteTranscriptPanel lives in its own module (remote-transcript-panel.js)
// specifically so it can be imported here without react-app.js's own
// dependency graph, which transitively reaches shared/build-badge.js and
// its Vite-only import.meta.env.BASE_URL read — unavailable under
// `node --test`. This wraps ../shared/transcript-options-identity.js with a
// spy that records every `next` object handed to stableTranscriptOptions,
// forwarding to the real implementation — so the tests below assert on the
// ACTUAL handler references RemoteTranscriptPanel produces across real
// re-renders, instead of grepping source text for `useCallback`.
//
// P1 regression this guards: stableTranscriptOptions only reuses the
// previous transcriptOptions object when every field is equal, which
// requires the ask-user-answers handler RemoteTranscriptPanel builds
// (handleSubmitAskUserAnswers) to keep the same reference across an
// unrelated re-render. It used to be an inline method recreated every
// render, silently defeating stableTranscriptOptions. (RemoteApp's own
// ensureFileChangeDetail useCallback — the other half of that regression —
// lives in the unexported top-level RemoteApp component, which would need a
// full broker/session render harness to exercise; out of reach here.)

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { JSDOM } from "jsdom";

const realHelperUrl = new URL("../shared/transcript-options-identity.js", import.meta.url).href;
const spySource = [
  `import { transcriptOptionValueEqual as realValueEqual, stableTranscriptOptions as realStable } from ${JSON.stringify(realHelperUrl)};`,
  "export const transcriptOptionValueEqual = realValueEqual;",
  "export const stableTranscriptOptionsCalls = [];",
  "export function stableTranscriptOptions(previous, next) {",
  "  stableTranscriptOptionsCalls.push(next);",
  "  return realStable(previous, next);",
  "}",
].join("\n");

register(
  `data:text/javascript,
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("/shared/transcript-options-identity.js") && !specifier.startsWith("file:")) {
        return { url: "transcript-options-identity-spy:main", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url === "transcript-options-identity-spy:main") {
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
const { RemoteTranscriptPanel } = await import("./remote-transcript-panel.js");
const { stableTranscriptOptionsCalls } = await import("../shared/transcript-options-identity.js");

const h = React.createElement;

function baseProps(overrides = {}) {
  return {
    currentState: {},
    emptyStateModel: { showRelayHome: false, showServerDisconnected: false },
    onApplyFileChange: () => {},
    onForkFromMessage: () => {},
    onSelectRelay: () => {},
    onToggleExpandableBlock: () => {},
    onSubmitDecision: () => {},
    onSubmitAskUserAnswers: () => {},
    onToggleTranscriptItem: () => {},
    onEnsureFileChangeDetail: () => {},
    pendingAskUserQuestions: [],
    session: null,
    sessionView: null,
    transcriptDetailEntries: new Map(),
    askUserDetailErrors: new Map(),
    askUserDetailLoadingRequestIds: new Set(),
    uiState: {
      transcriptExpandedItemIds: new Set(),
      transcriptLoadingItemIds: new Set(),
      askUserSubmittingRequestId: "",
      askUserErrors: new Map(),
    },
    ...overrides,
  };
}

// Re-renders the SAME root (unlike remote-transcript-panel-empty-states.test.mjs's
// per-scenario `mount`), so transcriptOptionsRef and the useCallback closures
// inside RemoteTranscriptPanel persist across renders exactly like a real update.
function mountHarness(initialProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(RemoteTranscriptPanel, initialProps));
  });
  return {
    rerender(nextProps) {
      act(() => {
        root.render(h(RemoteTranscriptPanel, nextProps));
      });
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("the ask-user-answers handler RemoteTranscriptPanel builds keeps a stable reference across an unrelated re-render", () => {
  const onSubmitAskUserAnswers = () => {};
  const onEnsureFileChangeDetail = () => {};
  stableTranscriptOptionsCalls.length = 0;

  const harness = mountHarness(baseProps({ onSubmitAskUserAnswers, onEnsureFileChangeDetail }));
  // Fresh (but equal) collection instances on the second render, mirroring what
  // every real re-render produces — only an unrelated field changes here.
  harness.rerender(
    baseProps({
      onSubmitAskUserAnswers,
      onEnsureFileChangeDetail,
      transcriptDetailEntries: new Map(),
      askUserDetailErrors: new Map(),
      askUserDetailLoadingRequestIds: new Set(),
    })
  );

  assert.equal(stableTranscriptOptionsCalls.length, 2);
  const [firstCall, secondCall] = stableTranscriptOptionsCalls;
  assert.equal(
    secondCall.onSubmitAskUserAnswers,
    firstCall.onSubmitAskUserAnswers,
    "handleSubmitAskUserAnswers must not be recreated when its onSubmitAskUserAnswers prop is unchanged"
  );

  harness.cleanup();
});

test("the ask-user-answers handler RemoteTranscriptPanel builds changes when its onSubmitAskUserAnswers prop changes", () => {
  stableTranscriptOptionsCalls.length = 0;

  const harness = mountHarness(baseProps({ onSubmitAskUserAnswers: () => {} }));
  harness.rerender(baseProps({ onSubmitAskUserAnswers: () => {} }));

  assert.equal(stableTranscriptOptionsCalls.length, 2);
  const [firstCall, secondCall] = stableTranscriptOptionsCalls;
  assert.notEqual(
    secondCall.onSubmitAskUserAnswers,
    firstCall.onSubmitAskUserAnswers,
    "a changed onSubmitAskUserAnswers prop must produce a new handler — proves the useCallback " +
      "dependency array isn't stale/empty"
  );

  harness.cleanup();
});
