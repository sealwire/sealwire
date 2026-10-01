// The row being renamed must survive the virtualizer: the wheel scrolls without
// blurring, so an unmounted editor would drop the typed draft with nothing committed.
//
// Kept in its own file: it stubs layout on HTMLElement.prototype, which jsdom lacks.
// DOM nodes are compared with `assert.ok(a === b)`: a failing `assert.equal` on one
// deep-inspects the jsdom tree and stalls for minutes.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_HEIGHT = 300;
// The virtualizer sizes its window from the scroll root and each row from offsetHeight.
// Rows report the list's own estimates: any mismatch makes it correct the scroll
// position, which jsdom cannot do, and it retries forever.
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    if (this.hasAttribute("data-thread-list-scroll-root")) return VIEWPORT_HEIGHT;
    if (this.classList.contains("thread-list-virtual-row")) {
      return this.dataset.rowType === "group" ? 34 : 38;
    }
    return 0;
  },
});
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 260;
  },
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ThreadGroupList } = await import("./thread-list-react.js");

const h = React.createElement;

function makeGroups(order = [0, 1, 2, 3, 4, 5]) {
  return order.map((g) => ({
    cwd: `/work/g${g}`,
    key: `/work/g${g}`,
    label: `g${g}`,
    threads: Array.from({ length: 10 }, (_, t) => ({
      id: `g${g}-t${t}`,
      name: `Session ${g}.${t}`,
      provider: "codex",
      updated_at: 1,
    })),
  }));
}

function mount(props) {
  const scrollRoot = dom.window.document.createElement("div");
  scrollRoot.setAttribute("data-thread-list-scroll-root", "");
  let scrollTop = 0;
  Object.defineProperty(scrollRoot, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value;
    },
  });
  const host = dom.window.document.createElement("div");
  // The list derives its offset inside the scroller from this; jsdom reports 0, which
  // would read as the list moving down with every scroll.
  host.getBoundingClientRect = () => ({ top: -scrollTop, bottom: 0, left: 0, right: 0, width: 260, height: 0 });
  scrollRoot.append(host);
  dom.window.document.body.append(scrollRoot);
  const root = createRoot(host);
  const render = (next) =>
    act(() => {
      root.render(
        h(ThreadGroupList, {
          formatThreadMeta: () => "now",
          onCommitRename: () => {},
          onCancelRename: () => {},
          ...next,
        })
      );
    });
  render(props);
  return {
    host,
    render,
    scrollTo(value) {
      act(() => {
        scrollTop = value;
        scrollRoot.dispatchEvent(new dom.window.Event("scroll"));
      });
    },
    row: (id) => host.querySelector(`[data-thread-id="${id}"]`),
    editor: (id) => host.querySelector(`[data-thread-id="${id}"] .conversation-title-input`),
    cleanup() {
      act(() => root.unmount());
      scrollRoot.remove();
    },
  };
}

test("scrolling the row being renamed out of view keeps its editor and draft", () => {
  const commits = [];
  const view = mount({
    groups: makeGroups(),
    renamingThreadId: "g0-t1",
    onCommitRename: (id, value) => commits.push([id, value]),
  });
  try {
    const input = view.editor("g0-t1");
    assert.ok(input !== null, "the editor opens on the row");
    act(() => {
      input.value = "Half typed";
    });

    view.scrollTo(1800);
    assert.ok(view.row("g0-t2") === null, "its neighbours really were virtualized away");
    assert.ok(view.editor("g0-t1") === input, "the editor stays mounted, not remounted");
    assert.equal(input.value, "Half typed");
    assert.deepEqual(commits, [], "nothing is saved behind the user's back");

    view.scrollTo(0);
    assert.ok(view.editor("g0-t1") === input);
    assert.equal(input.value, "Half typed");
  } finally {
    view.cleanup();
  }
});

// A poll can re-sort the list mid-edit; the row moving out of the window is the same
// unmount by another route.
test("a refresh that moves the row out of view keeps its editor and draft", () => {
  const view = mount({ groups: makeGroups(), renamingThreadId: "g0-t1" });
  try {
    const input = view.editor("g0-t1");
    act(() => {
      input.value = "Half typed";
    });

    view.render({ groups: makeGroups([1, 2, 3, 4, 5, 0]), renamingThreadId: "g0-t1" });
    assert.ok(view.row("g0-t2") === null, "its neighbours left the window with it");
    assert.ok(view.editor("g0-t1") === input);
    assert.equal(input.value, "Half typed");
  } finally {
    view.cleanup();
  }
});

// A group lists its first ten sessions. A session from below the cut moving to the top
// pushes the tenth past it, which drops the row just as a scroll would.
test("a re-sort that pushes the row past a group's first ten keeps its editor and draft", () => {
  const threads = Array.from({ length: 12 }, (_, t) => ({
    id: `s${t}`,
    name: `Session ${t}`,
    provider: "codex",
    updated_at: 1,
  }));
  const group = (list) => [{ cwd: "/work/a", key: "/work/a", label: "a", threads: list }];
  const view = mount({ groups: group(threads), renamingThreadId: "s9" });
  try {
    const input = view.editor("s9");
    assert.ok(input !== null, "the editor opens on the tenth row");
    act(() => {
      input.value = "Half typed";
    });

    view.render({ groups: group([threads[11], ...threads.slice(0, 11)]), renamingThreadId: "s9" });
    assert.ok(view.editor("s9") === input, "the editor stays mounted");
    assert.equal(input.value, "Half typed");
    assert.ok(view.row("s10") === null, "rows past the cut are still hidden");
    assert.match(view.host.textContent, /Show 1 more/);
  } finally {
    view.cleanup();
  }
});

// Results replaced by a newer search can leave the row out entirely; there is nowhere
// left to finish the edit, so what was typed is saved rather than dropped.
test("a list that drops the row being renamed saves its draft", async () => {
  const commits = [];
  const onCommitRename = (id, value) => commits.push([id, value]);
  const view = mount({ groups: makeGroups(), renamingThreadId: "g0-t1", onCommitRename });
  try {
    act(() => {
      view.editor("g0-t1").value = "Half typed";
    });
    const withoutRow = makeGroups().map((group) => ({
      ...group,
      threads: group.threads.filter((thread) => thread.id !== "g0-t1"),
    }));
    view.render({ groups: withoutRow, renamingThreadId: "g0-t1", onCommitRename });
    await Promise.resolve();
    assert.deepEqual(commits, [["g0-t1", "Half typed"]]);
  } finally {
    view.cleanup();
  }
});

test("with no rename in progress, off-screen rows are not kept", () => {
  const view = mount({ groups: makeGroups() });
  try {
    view.scrollTo(1800);
    assert.ok(view.row("g0-t1") === null);
  } finally {
    view.cleanup();
  }
});
