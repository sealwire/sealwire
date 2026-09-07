// Guards the Shift/Cmd multi-select gesture on ThreadGroupItem.
//
// ThreadGroupItem is shared by local AND remote. Multi-select is gated on an optional
// `onSelectThread`: absent, a modified click must open the session exactly as it always
// did, so remote's rows are untouched.
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

const THREAD = { id: "t1", name: "Alpha session", provider: "codex", updated_at: 1 };

function renderRow(extra = {}) {
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
        thread: THREAD,
        ...extra,
      })
    );
  });
  return {
    host,
    row: host.querySelector(".conversation-item"),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function clickRow(row, init = {}) {
  act(() => {
    row.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...init })
    );
  });
}

// `claims` is the handler's verdict — true means "this click was the gesture, do not
// also open the session". Defaults to undefined so a recorder never claims by accident.
function recorder(claims) {
  const calls = [];
  return {
    calls,
    fn: (...args) => {
      calls.push(args);
      return claims;
    },
  };
}

test("a modified click selects instead of opening the session", () => {
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
    const resume = recorder();
    const select = recorder(true);
    const view = renderRow({ onResumeThread: resume.fn, onSelectThread: select.fn });
    try {
      clickRow(view.row, modifier);
      assert.equal(resume.calls.length, 0, `${JSON.stringify(modifier)} must not open`);
      assert.equal(select.calls.length, 1);
      assert.equal(select.calls[0][0], "t1");
    } finally {
      view.cleanup();
    }
  }
});

// The row hands the raw event over rather than pre-deciding: which modifier means
// what is `threadSelectionIntent`'s call, and it needs the platform to decide ctrl.
test("the selection handler receives the event so the caller can read its modifiers", () => {
  const select = recorder(true);
  const view = renderRow({ onSelectThread: select.fn });
  try {
    clickRow(view.row, { shiftKey: true });
    assert.equal(select.calls[0][1]?.shiftKey, true);
  } finally {
    view.cleanup();
  }
});

// A plain click has to reach the selection layer too — it is what sets the ANCHOR a
// later shift+click ranges from. Skipping it left shift ranging from whatever row was
// cmd+clicked last, which is not the row the user just clicked.
test("an unmodified click reaches the selection layer AND opens the session", () => {
  const resume = recorder();
  const select = recorder();
  const view = renderRow({ onResumeThread: resume.fn, onSelectThread: select.fn });
  try {
    clickRow(view.row);
    assert.equal(select.calls.length, 1, "the anchor must be recorded");
    assert.deepEqual(resume.calls, [["t1", { preview: true }]], "and the session still opens");
  } finally {
    view.cleanup();
  }
});

// The handler owns the verdict because only it knows the platform: ctrl+click on a
// Mac is a right-click, and its contextmenu has already acted — opening the session
// on top of that would be a second, unasked-for action.
test("a click the selection layer claims does not also open the session", () => {
  const resume = recorder();
  const view = renderRow({ onResumeThread: resume.fn, onSelectThread: () => true });
  try {
    clickRow(view.row);
    assert.equal(resume.calls.length, 0);
  } finally {
    view.cleanup();
  }
});

// Remote passes no `onSelectThread`. A cmd+click there must keep opening the
// session rather than doing nothing at all.
test("without a selection handler a modified click opens the session", () => {
  const resume = recorder();
  const view = renderRow({ onResumeThread: resume.fn });
  try {
    clickRow(view.row, { metaKey: true });
    assert.deepEqual(resume.calls, [["t1", { preview: true }]]);
  } finally {
    view.cleanup();
  }
});

test("a selected row is marked, and keeps its other state classes", () => {
  const view = renderRow({ selected: true, active: true, contextMenuThreadId: "t1" });
  try {
    assert.ok(view.row.classList.contains("is-multi-selected"));
    assert.ok(view.row.classList.contains("is-active"));
    assert.ok(view.row.classList.contains("is-context-target"));
  } finally {
    view.cleanup();
  }
});

test("an unselected row carries no selection class", () => {
  const view = renderRow({ selected: false });
  try {
    assert.ok(!view.row.classList.contains("is-multi-selected"));
  } finally {
    view.cleanup();
  }
});

// A screen reader gets nothing from a class name; the row has to say it is selected.
test("a selected row reports its state to assistive tech", () => {
  const selectedView = renderRow({ selected: true, onSelectThread: () => {} });
  try {
    assert.equal(selectedView.row.getAttribute("aria-selected"), "true");
  } finally {
    selectedView.cleanup();
  }

  const plainView = renderRow({ onSelectThread: () => {} });
  try {
    assert.equal(plainView.row.getAttribute("aria-selected"), "false");
  } finally {
    plainView.cleanup();
  }
});

// A modified click is consumed, not passed on — nothing downstream should treat it
// as a plain activation. (The text-selection half of shift+click is a CSS concern:
// it starts on mousedown, which this event is already too late to cancel.)
test("a modified click is marked handled rather than left to default behaviour", () => {
  const view = renderRow({ onSelectThread: () => true });
  try {
    const event = new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
    act(() => view.row.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
  } finally {
    view.cleanup();
  }
});
