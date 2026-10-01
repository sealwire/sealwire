// Live interaction tests for a sidebar group header, mounted under jsdom. Targets
// ThreadGroupHeader directly rather than ThreadGroupList: the list is virtualized, and
// the virtualizer measures zero-height rows under jsdom, so nothing would render.
//
// THE CONTRACT:
//
//   * the whole row folds the group — there is no separate +/− to find
//   * a project's rename and delete live behind "⋯" or a right-click, never on the row
//   * rename edits the name in place; delete confirms in place, unless there is nothing
//     to lose
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

const h = React.createElement;

const CWD_GROUP = { cwd: "/tmp/work", label: "work" };
const PROJECT_GROUP = {
  key: "proj-1",
  cwd: "",
  projectId: "proj-1",
  label: "Alpha",
  threads: [{ id: "t1" }, { id: "t2" }],
  summary: { working: 0, needsInput: 0, total: 2 },
};

function mount(props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const render = (next) =>
    act(() => {
      root.render(h(ThreadGroupHeader, next));
    });
  render(props);
  return {
    host,
    render,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function click(element) {
  assert.ok(element, "expected the element under test to exist");
  act(() => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function rightClick(element) {
  const event = new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 20,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function keyDown(element, key) {
  act(() => {
    element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function menu() {
  return document.querySelector(".context-menu");
}

function menuLabels() {
  return [...document.querySelectorAll(".context-menu .context-menu-label")].map((n) => n.textContent);
}

function chooseMenuRow(label) {
  const row = [...document.querySelectorAll(".context-menu .context-menu-button")].find(
    (candidate) => candidate.querySelector(".context-menu-label")?.textContent === label
  );
  assert.ok(row, `no menu row "${label}"`);
  click(row);
}

function cwdProps(extra = {}) {
  return {
    collapsible: true,
    group: CWD_GROUP,
    isCollapsed: false,
    normalizedCwd: "/tmp/work",
    ...extra,
  };
}

function projectProps(extra = {}) {
  return {
    collapsible: true,
    group: PROJECT_GROUP,
    isCollapsed: false,
    normalizedCwd: "proj-1",
    onDeleteProject: () => {},
    onRenameProject: () => {},
    ...extra,
  };
}

// --- folding ------------------------------------------------------------------

test("clicking anywhere on a header folds it, for a folder and for a project alike", () => {
  for (const props of [cwdProps(), projectProps()]) {
    const toggled = [];
    const { host, cleanup } = mount({ ...props, onToggleGroup: (key) => toggled.push(key) });
    click(host.querySelector(".thread-group-name"));
    click(host.querySelector(".thread-group-toggle"));
    assert.deepEqual(toggled, [props.normalizedCwd, props.normalizedCwd]);
    assert.equal(host.querySelector(".thread-group-disclosure"), null, "no separate +/− control");
    cleanup();
  }
});

test("the row says whether it is open, and its chevron points the right way", () => {
  const open = mount(cwdProps({ onToggleGroup() {} }));
  assert.equal(open.host.querySelector(".thread-group-toggle").getAttribute("aria-expanded"), "true");
  assert.match(open.host.querySelector(".thread-group-chevron").innerHTML, /6 9 12 15 18 9/, "⌄");
  open.cleanup();

  const shut = mount(cwdProps({ isCollapsed: true, onToggleGroup() {} }));
  assert.equal(shut.host.querySelector(".thread-group-toggle").getAttribute("aria-expanded"), "false");
  assert.match(shut.host.querySelector(".thread-group-chevron").innerHTML, /9 18 15 12 9 6/, "›");
  shut.cleanup();
});

// Nested <button> is invalid HTML, so the fold button and "⋯" are siblings.
test("the fold button and the actions button are never nested", () => {
  const { host, cleanup } = mount(projectProps({ onToggleGroup() {} }));
  assert.equal(host.querySelector(".thread-group-header").tagName, "DIV");
  assert.equal(host.querySelectorAll("button button").length, 0);
  cleanup();
});

test("a header with nothing to fold is not a button at all", () => {
  const { host, cleanup } = mount(cwdProps({ collapsible: false }));
  assert.equal(host.querySelector("button"), null);
  assert.equal(host.querySelector(".thread-group-chevron"), null);
  cleanup();
});

// The Unknown-workspace key is a display sentinel, never a real directory.
test("the unknown-workspace header folds by its key and never shows it", () => {
  const toggled = [];
  const { host, cleanup } = mount(
    cwdProps({
      group: { cwd: "__unknown_workspace__", label: "Unknown workspace" },
      normalizedCwd: "__unknown_workspace__",
      onToggleGroup: (cwd) => toggled.push(cwd),
    })
  );
  click(host.querySelector(".thread-group-toggle"));
  assert.deepEqual(toggled, ["__unknown_workspace__"]);
  assert.doesNotMatch(host.innerHTML, /__unknown_workspace__/);
  cleanup();
});

// --- project actions ----------------------------------------------------------

test("a project's actions sit behind ⋯ and a right-click, never on the row", () => {
  const toggled = [];
  const { host, cleanup } = mount(projectProps({ onToggleGroup: (key) => toggled.push(key) }));
  assert.equal(host.querySelector(".thread-group-action"), null, "no pencil, no trash");

  click(host.querySelector(".thread-group-more"));
  assert.deepEqual(menuLabels(), ["Rename…", "Delete project…"]);
  assert.deepEqual(toggled, [], "opening the menu does not fold");
  click(host.querySelector(".thread-group-more"));
  assert.equal(menu(), null, "⋯ toggles the menu shut again");

  const event = rightClick(host.querySelector(".thread-group-toggle"));
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(menuLabels(), ["Rename…", "Delete project…"]);
  cleanup();
  assert.equal(menu(), null, "the menu goes with its header");
});

test("a folder has no actions to offer", () => {
  const { host, cleanup } = mount(cwdProps({ onToggleGroup() {} }));
  assert.equal(host.querySelector(".thread-group-more"), null);
  const event = rightClick(host.querySelector(".thread-group-toggle"));
  assert.equal(event.defaultPrevented, false, "the browser keeps its own menu");
  assert.equal(menu(), null);
  cleanup();
});

test("Rename… edits the name in place and reports only a real change", () => {
  const renamed = [];
  const { host, cleanup } = mount(
    projectProps({ onRenameProject: (id, name) => renamed.push([id, name]), onToggleGroup() {} })
  );
  click(host.querySelector(".thread-group-more"));
  chooseMenuRow("Rename…");

  const input = host.querySelector(".thread-group-name-input");
  assert.ok(input, "the name becomes the edit box");
  assert.equal(input.value, "Alpha");
  assert.equal(input.closest("button"), null, "an input inside a button would eat its clicks");

  act(() => {
    input.value = "  Beta  ";
  });
  keyDown(input, "Enter");
  assert.deepEqual(renamed, [["proj-1", "Beta"]]);
  assert.equal(host.querySelector(".thread-group-name-input"), null);
  cleanup();
});

test("a blank or unchanged name is not a rename", () => {
  const renamed = [];
  const { host, cleanup } = mount(
    projectProps({ onRenameProject: (id, name) => renamed.push([id, name]), onToggleGroup() {} })
  );
  for (const value of ["", "Alpha"]) {
    keyDown(host.querySelector(".thread-group-toggle"), "F2");
    const input = host.querySelector(".thread-group-name-input");
    assert.ok(input, "F2 on the focused row opens the box too");
    act(() => {
      input.value = value;
    });
    keyDown(input, "Enter");
  }
  assert.deepEqual(renamed, []);
  cleanup();
});

test("deleting a project with sessions confirms in place, saying where they go", () => {
  const deleted = [];
  const { host, cleanup } = mount(
    projectProps({ onDeleteProject: (...args) => deleted.push(args), onToggleGroup() {} })
  );
  click(host.querySelector(".thread-group-more"));
  chooseMenuRow("Delete project…");

  assert.deepEqual(deleted, [], "nothing goes before the confirm");
  const confirm = document.querySelector(".context-menu .context-menu-confirm");
  assert.match(confirm.textContent, /Delete project “Alpha”\?/);
  assert.match(confirm.textContent, /Its 2 sessions leave the project\. No sessions are deleted\./);
  assert.equal(document.activeElement?.textContent, "Cancel", "Cancel holds focus");

  click(confirm.querySelector(".context-menu-confirm-danger"));
  assert.deepEqual(deleted, [["proj-1", "Alpha", { sessionCount: 2 }]]);
  assert.equal(menu(), null);
  cleanup();
});

test("Cancel and Escape both leave the project alone", () => {
  const deleted = [];
  const { host, cleanup } = mount(projectProps({ onDeleteProject: (...args) => deleted.push(args) }));
  click(host.querySelector(".thread-group-more"));
  chooseMenuRow("Delete project…");
  click(document.querySelector(".context-menu-confirm-cancel"));
  assert.equal(menu(), null);

  click(host.querySelector(".thread-group-more"));
  chooseMenuRow("Delete project…");
  keyDown(document, "Escape");
  assert.equal(menu(), null);
  assert.deepEqual(deleted, []);
  cleanup();
});

test("an empty project is deleted at once, for the host to offer an Undo", () => {
  const deleted = [];
  const { host, cleanup } = mount(
    projectProps({
      group: { ...PROJECT_GROUP, threads: [] },
      onDeleteProject: (...args) => deleted.push(args),
    })
  );
  click(host.querySelector(".thread-group-more"));
  chooseMenuRow("Delete project…");
  assert.deepEqual(deleted, [["proj-1", "Alpha", { sessionCount: 0 }]]);
  assert.equal(menu(), null);
  cleanup();
});

// --- activity -----------------------------------------------------------------

// The nested session rows ARE the count — restating it is noise.
test("a project header shows no raw session count, only states worth acting on", () => {
  const idle = mount(projectProps({ onToggleGroup() {} }));
  assert.equal(idle.host.querySelector(".thread-group-count"), null);
  idle.cleanup();

  const busy = mount(
    projectProps({
      group: { ...PROJECT_GROUP, summary: { working: 2, needsInput: 1, total: 5 } },
      onToggleGroup() {},
    })
  );
  const counts = [...busy.host.querySelectorAll(".thread-group-count")].map((n) => [
    n.getAttribute("aria-label"),
    n.textContent,
  ]);
  assert.deepEqual(counts, [
    ["1 needs input", "1"],
    ["2 working", "2"],
  ]);
  busy.cleanup();
});

test("a project whose members are all past the loaded list still asks before deleting", () => {
  const deleted = [];
  const { host, cleanup } = mount(
    projectProps({
      group: { ...PROJECT_GROUP, threads: [], memberCount: 3 },
      onDeleteProject: (...args) => deleted.push(args),
    })
  );
  click(host.querySelector(".thread-group-more"));
  chooseMenuRow("Delete project…");
  assert.deepEqual(deleted, [], "no confirm skipped on the strength of an empty screen");
  assert.match(
    document.querySelector(".context-menu-confirm").textContent,
    /Its 3 sessions leave the project/
  );
  click(document.querySelector(".context-menu-confirm-danger"));
  assert.deepEqual(deleted, [["proj-1", "Alpha", { sessionCount: 3 }]]);
  cleanup();
});
