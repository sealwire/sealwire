// The sidebar row's in-place rename editor, mounted under jsdom. Targets
// ThreadGroupItem directly: the list is virtualized and renders nothing under jsdom.
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

function mount(extra = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const render = (props) =>
    act(() => {
      root.render(
        h(ThreadGroupItem, {
          active: false,
          formatThreadMeta: () => "now",
          group: { cwd: "", key: "g", label: "g" },
          includePreview: false,
          thread: THREAD,
          ...props,
        })
      );
    });
  render(extra);
  return {
    host,
    rerender: render,
    input: () => host.querySelector(".conversation-title-input"),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function editing(extra = {}) {
  const commits = [];
  const cancels = [];
  const view = mount({
    renaming: true,
    onCommitRename: (threadId, value) => commits.push([threadId, value]),
    onCancelRename: (threadId) => cancels.push(threadId),
    ...extra,
  });
  return { ...view, commits, cancels };
}

function keyDown(element, key) {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

// React's onBlur listens to the bubbling `focusout`; dispatching only `blur` tests nothing.
function blur(element) {
  act(() => {
    element.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
}

function type(input, value) {
  act(() => {
    input.value = value;
  });
}

test("a row being renamed swaps its title for a focused, pre-selected editor", () => {
  const view = editing();
  try {
    const input = view.input();
    assert.ok(input, "the editor must be on the row");
    assert.equal(input.value, "Alpha session", "seeded from what the row shows");
    assert.equal(dom.window.document.activeElement, input, "typing must land in it at once");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "Alpha session".length);
    assert.equal(view.host.querySelector(".conversation-title"), null, "no second title");
  } finally {
    view.cleanup();
  }
});

// The row is a <button>; an <input> inside one is invalid HTML, and the button would eat
// the clicks that place a caret.
test("the editor is never inside a button", () => {
  const view = editing();
  try {
    assert.equal(view.input().closest("button"), null);
  } finally {
    view.cleanup();
  }
});

test("a row that is not being renamed has no editor", () => {
  const view = mount({ onCommitRename: () => {}, onCancelRename: () => {} });
  try {
    assert.equal(view.input(), null);
    assert.ok(view.host.querySelector("button.conversation-item"));
  } finally {
    view.cleanup();
  }
});

test("Enter commits the raw text against the row's thread id", () => {
  const view = editing();
  try {
    type(view.input(), "  Auth work  ");
    keyDown(view.input(), "Enter");
    assert.deepEqual(view.commits, [["t1", "  Auth work  "]]);
    assert.deepEqual(view.cancels, []);
  } finally {
    view.cleanup();
  }
});

// Blank is how the user asks for the agent's own title back.
test("an emptied box still commits, so a reset can be expressed", () => {
  const view = editing();
  try {
    type(view.input(), "");
    keyDown(view.input(), "Enter");
    assert.deepEqual(view.commits, [["t1", ""]]);
  } finally {
    view.cleanup();
  }
});

test("Escape cancels without committing", () => {
  const view = editing();
  try {
    type(view.input(), "Discarded");
    keyDown(view.input(), "Escape");
    assert.deepEqual(view.commits, []);
    assert.deepEqual(view.cancels, ["t1"]);
  } finally {
    view.cleanup();
  }
});

test("clicking away commits, and Enter followed by blur commits only once", () => {
  const away = editing();
  try {
    type(away.input(), "Blurred");
    blur(away.input());
    assert.deepEqual(away.commits, [["t1", "Blurred"]]);
  } finally {
    away.cleanup();
  }

  const view = editing();
  try {
    type(view.input(), "Once");
    keyDown(view.input(), "Enter");
    blur(view.input());
    assert.deepEqual(view.commits, [["t1", "Once"]]);
  } finally {
    view.cleanup();
  }
});

// The list re-renders on every activity tick and poll; a re-render must not wipe what
// the user has typed so far.
test("a re-render mid-edit keeps the typed text", () => {
  const view = editing();
  try {
    type(view.input(), "Half typ");
    view.rerender({
      renaming: true,
      onCommitRename: () => {},
      onCancelRename: () => {},
      thread: { ...THREAD, name: "Agent retitled it", updated_at: 2 },
    });
    assert.equal(view.input().value, "Half typ");
  } finally {
    view.cleanup();
  }
});

// The window-level Escape handler closes menus and drops the multi-selection; a
// keystroke meant for the editor must not also reach it.
test("keystrokes in the editor do not reach document-level shortcuts", () => {
  const view = editing();
  const seen = [];
  const spy = (event) => seen.push(event.key);
  dom.window.document.addEventListener("keydown", spy);
  try {
    keyDown(view.input(), "ArrowLeft");
    keyDown(view.input(), "Escape");
    assert.deepEqual(seen, []);
  } finally {
    dom.window.document.removeEventListener("keydown", spy);
    view.cleanup();
  }
});

test("clicks inside the editor neither open nor select the session", () => {
  const opens = [];
  const selects = [];
  const contexts = [];
  const view = editing({
    onResumeThread: (...args) => opens.push(args),
    onSelectThread: (...args) => {
      selects.push(args);
      return false;
    },
    onContextThread: (...args) => contexts.push(args),
  });
  try {
    const input = view.input();
    for (const type of ["click", "dblclick"]) {
      act(() => {
        input.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
      });
    }
    const menu = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(menu);
    });
    assert.deepEqual(opens, []);
    assert.deepEqual(selects, []);
    assert.deepEqual(contexts, [], "the session menu must not open over the editor");
    assert.equal(menu.defaultPrevented, false, "cut/copy/paste must stay reachable");
  } finally {
    view.cleanup();
  }
});

// The host can drop the row outright (newer search results, a failed refresh); the
// typed name is then kept, as a click-away would keep it.
test("an editor removed before it settled commits what was typed", async () => {
  const view = editing();
  type(view.input(), "Half typed");
  view.cleanup();
  await Promise.resolve();
  assert.deepEqual(view.commits, [["t1", "Half typed"]]);
  assert.deepEqual(view.cancels, []);
});

test("an editor that already settled reports nothing more when removed", async () => {
  const saved = editing();
  type(saved.input(), "Once");
  keyDown(saved.input(), "Enter");
  saved.cleanup();
  await Promise.resolve();
  assert.deepEqual(saved.commits, [["t1", "Once"]]);

  const cancelled = editing();
  type(cancelled.input(), "Discarded");
  keyDown(cancelled.input(), "Escape");
  cancelled.cleanup();
  await Promise.resolve();
  assert.deepEqual(cancelled.commits, []);
  assert.deepEqual(cancelled.cancels, ["t1"]);
});

// Saving an untouched box would pin the agent's current title as the user's choice,
// so later automatic titles stop showing. Only Enter is taken as "keep this name".
test("an untouched editor saves nothing when it is clicked away or removed", async () => {
  const clickedAway = editing();
  try {
    blur(clickedAway.input());
    assert.deepEqual(clickedAway.commits, []);
    assert.deepEqual(clickedAway.cancels, ["t1"]);
  } finally {
    clickedAway.cleanup();
  }

  const removed = editing();
  removed.cleanup();
  await Promise.resolve();
  assert.deepEqual(removed.commits, []);
  assert.deepEqual(removed.cancels, ["t1"], "the rename state is still closed");

  const confirmed = editing();
  try {
    keyDown(confirmed.input(), "Enter");
    assert.deepEqual(confirmed.commits, [["t1", "Alpha session"]]);
  } finally {
    confirmed.cleanup();
  }
});
