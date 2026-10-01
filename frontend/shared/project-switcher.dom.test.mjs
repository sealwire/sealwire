// The Project switcher's behaviour contract.
//
// The switcher is navigation, not filtering: every selection leaves the session
// list complete, so "All sessions" is a real destination rather than a way
// out of a narrowed state. These tests pin the parts that are easy to get subtly wrong —
// a stale selection, and Escape.
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
const { ProjectSwitcher } = await import("./project-switcher.js");
const { ALL_SESSIONS_LABEL } = await import("./project-labels.js");

const PROJECTS = [
  { id: "proj_pay", name: "Payments rework" },
  { id: "proj_docs", name: "Docs" },
];

function mount(props = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(ProjectSwitcher, { projects: PROJECTS, ...props }));
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
    rerender(next) {
      act(() => {
        root.render(
          React.createElement(ProjectSwitcher, { projects: PROJECTS, ...props, ...next })
        );
      });
    },
  };
}

function trigger(host) {
  return host.querySelector(".project-switcher-trigger");
}

// A row's textContent also carries its count, so read the label span.
function optionLabel(node) {
  return node.querySelector(".context-menu-label")?.textContent ?? node.textContent;
}

function rows(host) {
  return [...host.querySelectorAll(".project-switcher-menu .context-menu-button")];
}

function options(host) {
  return rows(host).map(optionLabel);
}

function clickOption(host, label) {
  const node = rows(host).find((candidate) => optionLabel(candidate) === label);
  assert.ok(node, `no option labelled "${label}"`);
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

function open(host) {
  act(() => {
    trigger(host).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

test("with nothing selected it reads as All sessions", () => {
  const view = mount({ activeProjectId: null });
  assert.equal(trigger(view.host).textContent, ALL_SESSIONS_LABEL);
  view.cleanup();
});

test("with a project selected it names the project", () => {
  const view = mount({ activeProjectId: "proj_pay" });
  assert.equal(trigger(view.host).textContent, "Payments rework");
  view.cleanup();
});

// A project can be deleted from another device while it is the selected one. The
// grouper independently falls back to plain cwd grouping for an id it cannot
// resolve, so the control has to reach the same answer or the header would name a
// project the list is no longer showing.
test("a selection whose project is gone falls back to All sessions, not a dangling name", () => {
  const view = mount({ activeProjectId: "proj_deleted" });
  assert.equal(trigger(view.host).textContent, ALL_SESSIONS_LABEL);
  view.cleanup();
});

test("the menu lists All sessions, every project, and the create action", () => {
  const view = mount({ activeProjectId: null, onCreateProject() {} });
  open(view.host);
  assert.deepEqual(options(view.host), [
    ALL_SESSIONS_LABEL,
    "Docs",
    "Payments rework",
    "New project…",
  ]);
  view.cleanup();
});

test("without a create handler the create action is absent rather than inert", () => {
  const view = mount({ activeProjectId: null });
  open(view.host);
  assert.equal(options(view.host).includes("New project…"), false);
  view.cleanup();
});

test("choosing a project reports its id and closes the menu", () => {
  const chosen = [];
  const view = mount({ activeProjectId: null, onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  clickOption(view.host, "Docs");

  assert.deepEqual(chosen, ["proj_docs"]);
  assert.equal(view.host.querySelector(".project-switcher-menu"), null);
  view.cleanup();
});

// Null, not the string "sessions" or an empty string: the caller maps it to the
// sessions context, and a falsy-but-not-null id would read as "some project" to a
// truthiness check downstream.
test("choosing All sessions reports null", () => {
  const chosen = [];
  const view = mount({ activeProjectId: "proj_pay", onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  clickOption(view.host, ALL_SESSIONS_LABEL);

  assert.deepEqual(chosen, [null]);
  view.cleanup();
});

test("the current selection is marked so the menu says where you already are", () => {
  const view = mount({ activeProjectId: "proj_docs" });
  open(view.host);
  const active = view.host.querySelector(".project-switcher-option.is-active");
  assert.equal(optionLabel(active), "Docs");
  assert.equal(active.getAttribute("aria-checked"), "true", "and says so to a screen reader");
  view.cleanup();
});

test("clicking outside closes the menu", () => {
  const view = mount({ activeProjectId: null });
  open(view.host);
  assert.ok(view.host.querySelector(".project-switcher-menu"));

  act(() => {
    document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  });
  assert.equal(view.host.querySelector(".project-switcher-menu"), null);
  view.cleanup();
});

// The sidebar search reads a bare Escape as "close AND clear the query". If this
// menu let Escape through, dismissing it would silently wipe a search the user
// never touched — the exact trap that wrecked two verification runs on the search
// work.
test("Escape closes the menu without letting the key reach the surface behind it", () => {
  const seenByDocument = [];
  const listener = (event) => seenByDocument.push(event.key);
  document.addEventListener("keydown", listener);

  const view = mount({ activeProjectId: null });
  open(view.host);
  act(() => {
    document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });

  assert.equal(view.host.querySelector(".project-switcher-menu"), null, "menu should close");
  assert.deepEqual(seenByDocument, [], "Escape must not reach a bubble-phase listener");

  document.removeEventListener("keydown", listener);
  view.cleanup();
});

// Remote also hosts this control as a compact SIDEBAR icon. That placement already has
// surrounding chrome, so it opts out of the heading wrapper while keeping the same menu
// behavior as the full header switcher.
test("renderHeading:false drops the heading element and keeps the control whole", () => {
  const view = mount({ activeProjectId: "proj_pay", onCreateProject() {}, renderHeading: false });

  assert.equal(view.host.querySelector("h1"), null, "no heading element at all");
  assert.equal(trigger(view.host)?.textContent, "Payments rework", "trigger still names the project");

  open(view.host);
  assert.deepEqual(options(view.host), [
    ALL_SESSIONS_LABEL,
    "Docs",
    "Payments rework",
    "New project…",
  ]);
  view.cleanup();
});

// The default has to stay the heading, because on local this control IS the page
// title. A prop that silently flipped that would demote local's <h1> to a <div> and
// nothing in the local suite asks for the element name.
test("the heading is rendered by default, so local's header title keeps its h1", () => {
  const view = mount({ activeProjectId: null });
  const heading = view.host.querySelector("h1.project-switcher-heading");

  assert.ok(heading, "default renders the h1");
  assert.ok(heading.contains(trigger(view.host)), "and the trigger lives inside it");
  view.cleanup();
});

// On a phone, switching projects is a LOW-FREQUENCY act — the list defaults to
// sessions and search/filter are the fast paths — so remote puts this control behind
// one icon beside search and the bell rather than giving it a row above the list.
// The trigger becomes the icon; the label survives as its tooltip, which is the only
// thing left saying where you are when the menu is shut.
test("triggerIcon renders an icon trigger that still carries the label as its title", () => {
  const view = mount({ activeProjectId: "proj_pay", triggerIcon: React.createElement("i", { className: "glyph" }) });
  const button = trigger(view.host);

  assert.equal(button.querySelector("i.glyph") !== null, true, "the icon is rendered");
  assert.equal(view.host.querySelector(".project-switcher-label"), null, "and the text label is not");
  assert.equal(button.getAttribute("title"), "Payments rework", "the name survives as the tooltip");
  view.cleanup();
});

// Marked the way the search and bell toggles are, so a pinned project is legible from
// the top bar without opening anything.
test("the icon trigger is marked active only while a project is pinned", () => {
  const pinned = mount({ activeProjectId: "proj_pay", triggerIcon: React.createElement("i", null) });
  assert.equal(trigger(pinned.host).classList.contains("is-active"), true);
  pinned.cleanup();

  const none = mount({ activeProjectId: null, triggerIcon: React.createElement("i", null) });
  assert.equal(trigger(none.host).classList.contains("is-active"), false);
  none.cleanup();
});

// Remote's drawer has no group header to carry these, so the switcher does — for the
// active project only, behind a divider.
test("the menu offers rename/delete for the ACTIVE project only", () => {
  const view = mount({ activeProjectId: "proj_pay", onRenameProject() {}, onDeleteProject() {} });
  open(view.host);

  assert.deepEqual(options(view.host), [
    ALL_SESSIONS_LABEL,
    "Docs",
    "Payments rework",
    "Rename project…",
    "Delete project…",
  ]);
  view.cleanup();
});

// PRODUCTION passes all three handlers, and none of the tests above did — so the order
// they actually render in was never asserted. It was wrong: rename/delete came out
// ABOVE "New project…", i.e. destructive actions sitting in the middle of the list of
// places you can navigate to, which is the arrangement the whole "put them behind a
// divider" argument exists to avoid.
test("with create AND management enabled, the destructive pair is last", () => {
  const view = mount({
    activeProjectId: "proj_pay",
    onCreateProject() {},
    onRenameProject() {},
    onDeleteProject() {},
  });
  open(view.host);

  assert.deepEqual(options(view.host), [
    ALL_SESSIONS_LABEL,
    "Docs",
    "Payments rework",
    "New project…",
    "Rename project…",
    "Delete project…",
  ]);
  view.cleanup();
});

test("choosing delete reports the active project's id and name, and closes", () => {
  const deleted = [];
  const view = mount({
    activeProjectId: "proj_docs",
    onCreateProject() {},
    onRenameProject() {},
    onDeleteProject: (id, name) => deleted.push([id, name]),
  });
  open(view.host);
  clickOption(view.host, "Delete project…");

  assert.deepEqual(deleted, [["proj_docs", "Docs"]]);
  assert.equal(view.host.querySelector(".project-switcher-menu"), null, "menu closes");
  view.cleanup();
});

// A selection whose project is gone must read as the default EVERYWHERE, not just in
// the label. The trigger already fell back for its text while `data-active-project-id`,
// the `is-active` highlight and the menu's tick all still used the raw id — so after
// deleting the selected project the icon stayed lit and no menu row was marked, while
// the list had already gone back to plain cwd grouping. Three surfaces, two answers.
test("a stale selection reads as All sessions in the marking too, not just the label", () => {
  const view = mount({
    activeProjectId: "proj_deleted",
    triggerIcon: React.createElement("i", null),
    onCreateProject() {},
  });

  const button = trigger(view.host);
  assert.equal(button.classList.contains("is-active"), false, "the icon must not stay lit");
  assert.equal(button.getAttribute("data-active-project-id"), "", "and must not advertise a dead id");

  open(view.host);
  const active = view.host.querySelector(".project-switcher-option.is-active");
  assert.equal(optionLabel(active), ALL_SESSIONS_LABEL, "the default is the marked row");
  view.cleanup();
});

test("with no project selected there is nothing to rename or delete", () => {
  // Positive control first. "Rename project is absent" is equally true of a switcher
  // that never learned to offer it, so without this the test is green against the
  // feature being missing entirely — which is exactly how it first ran.
  const pinned = mount({ activeProjectId: "proj_pay", onRenameProject() {}, onDeleteProject() {} });
  open(pinned.host);
  assert.equal(
    options(pinned.host).includes("Rename project…"),
    true,
    "precondition: the menu can offer rename at all"
  );
  pinned.cleanup();

  const view = mount({ activeProjectId: null, onRenameProject() {}, onDeleteProject() {} });
  open(view.host);

  assert.equal(options(view.host).includes("Rename project…"), false);
  assert.equal(options(view.host).includes("Delete project…"), false);
  view.cleanup();
});

test("choosing rename reports the active project's id and name, and closes", () => {
  const renamed = [];
  const view = mount({
    activeProjectId: "proj_docs",
    onRenameProject: (id, name) => renamed.push([id, name]),
    onDeleteProject() {},
  });
  open(view.host);
  clickOption(view.host, "Rename project…");

  assert.deepEqual(renamed, [["proj_docs", "Docs"]]);
  assert.equal(view.host.querySelector(".project-switcher-menu"), null, "menu closes");
  view.cleanup();
});

test("an empty project list still offers All sessions and creating one", () => {
  const view = mount({ activeProjectId: null, onCreateProject() {}, projects: [] });
  open(view.host);
  assert.deepEqual(options(view.host), [ALL_SESSIONS_LABEL, "New project…"]);
  view.cleanup();
});

function typeFilter(host, value) {
  const input = host.querySelector(".project-switcher-menu .context-menu-filter input");
  assert.ok(input, "the menu opens with a filter");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  return input;
}

function press(target, key, init = {}) {
  act(() => {
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

test("rows count sessions, and the most recently used project comes first", () => {
  const view = mount({
    activeProjectId: null,
    threadProjectId: { t1: "proj_pay", t2: "proj_pay" },
    threads: [
      { id: "t1", updated_at: 200 },
      { id: "t2", updated_at: 100 },
      { id: "t3", updated_at: 50 },
    ],
  });
  open(view.host);
  const counts = rows(view.host).map((row) => [
    optionLabel(row),
    row.querySelector(".context-menu-hint")?.textContent ?? null,
  ]);
  assert.deepEqual(counts, [
    [ALL_SESSIONS_LABEL, "3"],
    ["Payments rework", "2"],
    ["Docs", "0"],
  ]);
  view.cleanup();
});

test("the filter takes focus on open and narrows to matching projects", () => {
  const view = mount({ activeProjectId: null, onCreateProject() {} });
  open(view.host);
  const input = view.host.querySelector(".context-menu-filter input");
  assert.equal(document.activeElement, input, "typing works without a click first");

  typeFilter(view.host, "pay");
  assert.deepEqual(options(view.host), ["Payments rework", "Create “pay”"]);
  assert.equal(view.host.querySelector(".context-menu-heading"), null, "the heading steps aside");
  view.cleanup();
});

test("with nothing matching, the typed name is offered as a new project", () => {
  const created = [];
  const view = mount({ activeProjectId: null, onCreateProject: (name) => created.push(name) });
  open(view.host);
  typeFilter(view.host, "Ops");
  assert.deepEqual(options(view.host), ["Create “Ops”"]);
  clickOption(view.host, "Create “Ops”");
  assert.deepEqual(created, ["Ops"]);
  view.cleanup();
});

test("New project without a typed name asks the host for one", () => {
  const created = [];
  const view = mount({ activeProjectId: null, onCreateProject: (name) => created.push(name) });
  open(view.host);
  clickOption(view.host, "New project…");
  assert.deepEqual(created, [null]);
  view.cleanup();
});

test("arrow keys move through the rows and Enter chooses", () => {
  const chosen = [];
  const view = mount({ activeProjectId: null, onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  const input = view.host.querySelector(".context-menu-filter input");
  // Opens on the current row (All sessions); one step down is the first project.
  press(input, "ArrowDown");
  press(input, "Enter");
  assert.deepEqual(chosen, ["proj_docs"]);
  view.cleanup();
});

test("a typed filter puts Enter on the first match", () => {
  const chosen = [];
  const view = mount({ activeProjectId: null, onSelectProject: (id) => chosen.push(id) });
  open(view.host);
  const input = typeFilter(view.host, "pay");
  press(input, "Enter");
  assert.deepEqual(chosen, ["proj_pay"]);
  view.cleanup();
});

test("the shortcut opens the menu from anywhere, and only with a modifier", () => {
  const view = mount({ activeProjectId: null, shortcut: { key: "p", hint: "⌘P" } });
  press(document.body, "p");
  assert.equal(view.host.querySelector(".project-switcher-menu"), null, "a bare P is typing");
  press(document.body, "p", { metaKey: true });
  assert.ok(view.host.querySelector(".project-switcher-menu"));
  assert.equal(view.host.querySelector(".context-menu-filter .context-menu-hint").textContent, "⌘P");
  view.cleanup();
});

test("deleting a project with sessions asks in place first", () => {
  const deleted = [];
  const view = mount({
    activeProjectId: "proj_pay",
    onDeleteProject: (id, name) => deleted.push([id, name]),
    threadProjectId: { t1: "proj_pay" },
    threads: [{ id: "t1", updated_at: 1 }],
  });
  open(view.host);
  clickOption(view.host, "Delete project…");
  assert.deepEqual(deleted, [], "nothing goes before the confirm");
  const confirm = view.host.querySelector(".project-switcher-menu .context-menu-confirm");
  assert.match(confirm.textContent, /Delete project “Payments rework”\?/);
  assert.match(confirm.textContent, /Its 1 session leaves the project\. No sessions are deleted\./);
  assert.equal(document.activeElement?.textContent, "Cancel", "Cancel holds focus");

  act(() => {
    confirm
      .querySelector(".context-menu-confirm-danger")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(deleted, [["proj_pay", "Payments rework"]]);
  assert.equal(view.host.querySelector(".project-switcher-menu"), null);
  view.cleanup();
});

// The current row is said by its check alone; a highlight on it at rest would also
// stop it reacting to the cursor.
test("nothing is highlighted when the menu opens", () => {
  const view = mount({ activeProjectId: "proj_docs" });
  open(view.host);
  assert.equal(view.host.querySelector(".project-switcher-menu .is-highlighted"), null);
  view.cleanup();
});

test("a project with members outside the loaded list still asks before deleting", () => {
  const deleted = [];
  const view = mount({
    activeProjectId: "proj_pay",
    onDeleteProject: (...args) => deleted.push(args),
    threadProjectId: { old_1: "proj_pay", old_2: "proj_pay" },
    threads: [],
  });
  open(view.host);
  clickOption(view.host, "Delete project…");
  assert.deepEqual(deleted, [], "an empty screen is not an empty project");
  assert.match(
    view.host.querySelector(".context-menu-confirm").textContent,
    /Its 2 sessions leave the project/
  );
  view.cleanup();
});

test("an empty project goes at once and says so, for the host to offer an Undo", () => {
  const deleted = [];
  const view = mount({ activeProjectId: "proj_pay", onDeleteProject: (...args) => deleted.push(args) });
  open(view.host);
  clickOption(view.host, "Delete project…");
  assert.deepEqual(deleted, [["proj_pay", "Payments rework", { sessionCount: 0 }]]);
  view.cleanup();
});

// Confirming a pinyin candidate is an Enter too; it must pick the characters, not the row.
test("keys pressed while an input method is composing never act on the menu", () => {
  const chosen = [];
  const created = [];
  const view = mount({
    activeProjectId: null,
    onCreateProject: (name) => created.push(name),
    onSelectProject: (id) => chosen.push(id),
  });
  open(view.host);
  const input = typeFilter(view.host, "pay");
  press(input, "ArrowDown", { isComposing: true });
  press(input, "Enter", { isComposing: true });
  press(input, "Enter", { keyCode: 229 });
  assert.deepEqual(chosen, []);
  assert.deepEqual(created, []);
  assert.ok(view.host.querySelector(".project-switcher-menu"), "the menu stays open");
  assert.equal(
    optionLabel(view.host.querySelector(".project-switcher-menu .is-highlighted")),
    "Payments rework",
    "and the highlight did not move"
  );
  view.cleanup();
});
