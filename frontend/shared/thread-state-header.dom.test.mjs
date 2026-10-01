// Guards how the bell's state buckets render as group headers.
//
// A state bucket reuses the workspace-group header, but it is NOT a directory. Two
// things follow, and both have bitten this component before:
//
//   1. Its label must be inert. `data-select-workspace` writes its value straight into
//      the workspace input, which is then sent to the relay as a PATH — the same reason
//      the "Unknown workspace" sentinel is rendered as a static span. "state:working"
//      must never be able to leave the display layer.
//   2. Its folder glyph must be gone. It is meaningful for a workspace or project and
//      actively misleading on "Needs input".
//
// Kept in its own file so the DOM globals below don't leak into the static suite.
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
const { ThreadGroupHeader } = await import("./thread-list-react.js");
const { buildThreadStateGroups } = await import("./thread-filter.js");

const h = React.createElement;

function renderHeader(group, extra = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(ThreadGroupHeader, {
        group,
        collapsible: true,
        isCollapsed: false,
        normalizedCwd: group.key,
        ...extra,
      })
    );
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

// Built through the real factory, so this cannot pass against a hand-made shape that
// has drifted from what the bell actually produces.
const [workingBucket] = buildThreadStateGroups(
  [{ key: "/repos/relay", cwd: "/repos/relay", threads: [{ id: "a", updated_at: 1 }] }],
  { stateOf: () => "working" }
);

test("a state bucket names its state and offers no project actions", () => {
  const view = renderHeader(workingBucket, { onToggleGroup() {} });
  try {
    assert.equal(view.host.querySelector("[data-select-workspace]"), null);
    assert.equal(view.host.querySelector(".thread-group-name")?.textContent, "Working");
    assert.equal(view.host.querySelector(".thread-group-more"), null);
  } finally {
    view.cleanup();
  }
});

test("a state bucket is tagged so its folder glyph can be dropped", () => {
  const view = renderHeader(workingBucket);
  try {
    assert.equal(
      view.host.querySelector(".thread-group-header")?.dataset.groupKind,
      "state"
    );
  } finally {
    view.cleanup();
  }
});

// The tag is opt-in: an ordinary workspace group keeps its glyph.
test("a workspace group is untouched by the state tag", () => {
  const view = renderHeader({ key: "/repos/relay", cwd: "/repos/relay", label: "relay", threads: [] });
  try {
    const header = view.host.querySelector(".thread-group-header");
    assert.equal(header?.dataset.groupKind, undefined);
    assert.ok(view.host.querySelector(".thread-group-icon .thread-group-kind svg"));
  } finally {
    view.cleanup();
  }
});
