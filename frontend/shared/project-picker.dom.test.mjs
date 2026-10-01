// What differs from the top-bar switcher is Escape: inside showModal() the first
// Escape must close only the menu, or a typed prompt is thrown away.
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
const { ProjectPicker } = await import("./project-picker.js");
const { NO_PROJECT_LABEL } = await import("./project-labels.js");

const PROJECTS = [
  { id: "proj_pay", name: "Payments rework" },
  { id: "proj_docs", name: "Docs" },
];

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(ProjectPicker, { projects: PROJECTS, ...props }));
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const trigger = (host) => host.querySelector(".project-picker-trigger");
const menu = (host) => host.querySelector(".project-switcher-menu");
const optionLabel = (node) =>
  node.querySelector(".project-switcher-option-label")?.textContent ?? node.textContent;

function open(host) {
  act(() => {
    trigger(host).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

function pressEscape() {
  const event = new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

test("the chip names the active project", () => {
  const view = mount({ activeProjectId: "proj_pay" });
  assert.match(trigger(view.host).textContent, /Payments rework/);
  view.cleanup();
});

test("with no project chosen the chip says so", () => {
  const view = mount({ activeProjectId: null });
  assert.match(trigger(view.host).textContent, new RegExp(NO_PROJECT_LABEL));
  view.cleanup();
});

test("choosing a project reports its id and closes the menu", () => {
  const chosen = [];
  const view = mount({ activeProjectId: null, onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  const row = [...view.host.querySelectorAll(".project-switcher-option")].find(
    (candidate) => optionLabel(candidate) === "Docs"
  );
  act(() => {
    row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(chosen, ["proj_docs"]);
  assert.equal(menu(view.host), null);
  view.cleanup();
});

test("Escape closes the menu and is prevented, so the dialog behind it stays open", () => {
  // preventDefault is the mechanism: only a cancelled event spares the dialog.
  const view = mount({ activeProjectId: null });
  open(view.host);
  assert.ok(menu(view.host), "precondition: the menu is open");

  const event = pressEscape();

  assert.equal(menu(view.host), null, "the menu closes");
  assert.equal(event.defaultPrevented, true, "and the key is consumed, not passed to the dialog");
  view.cleanup();
});

test("Escape with the menu shut is left alone, so it still closes the dialog", () => {
  // Swallowing Escape unconditionally would trap the user in the dialog.
  const view = mount({ activeProjectId: null });

  const event = pressEscape();

  assert.equal(event.defaultPrevented, false, "a closed picker must not consume Escape");
  view.cleanup();
});

test("clicking outside closes the menu", () => {
  const view = mount({ activeProjectId: null });
  open(view.host);
  act(() => {
    document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  });
  assert.equal(menu(view.host), null);
  view.cleanup();
});

test("rows count their sessions, and no-project is named for what it means here", () => {
  const view = mount({
    activeProjectId: null,
    threadProjectId: { t1: "proj_pay", t2: "proj_pay" },
    threads: [
      { id: "t1", updated_at: 1_700_000_000 },
      { id: "t2", updated_at: 1_700_000_000 },
    ],
  });
  open(view.host);
  const row = [...view.host.querySelectorAll(".project-switcher-option")].find(
    (candidate) => optionLabel(candidate) === "Payments rework"
  );
  assert.equal(row.querySelector(".project-switcher-option-count").textContent, "2");
  assert.equal(
    optionLabel(view.host.querySelector(".project-switcher-option")),
    "No project",
    "a new session joins no project; it does not join 'All sessions'"
  );
  view.cleanup();
});

test("creating a project is offered when the surface supports it", () => {
  const created = [];
  const view = mount({ activeProjectId: null, onCreateProject: () => created.push(true) });
  open(view.host);
  const create = view.host.querySelector(".project-switcher-create");
  act(() => {
    create.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(created, [true]);
  assert.equal(menu(view.host), null, "and the menu closes behind it");
  view.cleanup();
});
