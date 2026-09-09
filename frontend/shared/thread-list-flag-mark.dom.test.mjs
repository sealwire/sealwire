// Guards the persistent "flagged for follow-up" mark on ThreadGroupItem — the row's
// half of the flag feature (the bell's "Follow up" bucket is the other half).
//
// The mark must be independent of the activity dot: a flagged session that is also
// working/needs-input/reviewing/done keeps showing BOTH, since flagging never
// overrides a live state (see thread-dot.test.mjs).
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
const { ThreadGroupItem } = await import("./thread-list-react.js");

const h = React.createElement;

function renderRow(thread, extra = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(ThreadGroupItem, {
        active: false,
        formatThreadMeta: () => "now",
        group: { cwd: "", key: "g", label: "g" },
        includePreview: false,
        thread,
        ...extra,
      })
    );
  });
  return {
    host,
    mark: host.querySelector(".conversation-flag-mark"),
    row: host.querySelector(".conversation-item"),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("an unflagged thread renders no flag mark", () => {
  const view = renderRow({ id: "t1", name: "Alpha", provider: "codex", updated_at: 1 });
  try {
    assert.equal(view.mark, null);
  } finally {
    view.cleanup();
  }
});

test("a flagged thread renders the mark, labelled for screen readers", () => {
  const view = renderRow({ id: "t1", name: "Alpha", provider: "codex", updated_at: 1, flagged: true });
  try {
    assert.ok(view.mark, "flag mark must be present");
    assert.equal(view.mark.getAttribute("aria-label"), "Flagged for follow-up");
    assert.equal(view.mark.getAttribute("title"), "Flagged for follow-up");
  } finally {
    view.cleanup();
  }
});

// The independence requirement made concrete: flagging never overrides a live state,
// so a flagged+needs_input row must show BOTH the dot and the mark, not one or the
// other.
// `.conversation-item` is a 3-column CSS grid (`grid-template-columns: 14px
// minmax(0, 1fr) auto`) sized for exactly its three positional direct children
// (lead, title-row, meta). A flag mark added as a 4th DIRECT child would shift
// every later child over by one grid column — caught in review before this test
// existed. Nesting the mark inside `.conversation-title-row` (a flex container,
// not a grid track) is what keeps the grid's child count — and therefore its
// column assignment — the same whether or not the row is flagged.
test("the flag mark nests inside the title row, not as a 4th grid-level child", () => {
  const view = renderRow({ id: "t1", name: "Alpha", provider: "codex", updated_at: 1, flagged: true });
  try {
    assert.equal(
      view.mark.parentElement.className,
      "conversation-title-row",
      "the mark must be a flex child of the title row, not a sibling of it"
    );
    assert.equal(
      view.row.children.length,
      3,
      "the grid row must keep exactly its 3 positional children (lead, title-row, meta) when flagged"
    );
  } finally {
    view.cleanup();
  }
});

test("an unflagged row also has exactly the 3 grid-level children", () => {
  const view = renderRow({ id: "t1", name: "Alpha", provider: "codex", updated_at: 1 });
  try {
    assert.equal(view.row.children.length, 3);
  } finally {
    view.cleanup();
  }
});

test("a flagged thread that also needs input shows both the dot and the mark", () => {
  const view = renderRow(
    { id: "t1", name: "Alpha", provider: "codex", updated_at: 1, flagged: true },
    { attentionKind: "needs_input" }
  );
  try {
    assert.ok(view.mark, "flag mark must still show");
    assert.ok(
      view.host.querySelector(".conversation-activity-dot.is-attention-input"),
      "the needs-input dot must still show"
    );
  } finally {
    view.cleanup();
  }
});
