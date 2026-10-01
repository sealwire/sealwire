// Guards the project group header's activity badges ("2 working" / "1 needs input").
//
// The counts are carried on the group as `summary` — one contract shared by both
// surfaces — and are deliberately NOT derived from the rows the header happens to be
// showing: a group can be collapsed, and the list truncates past a limit. On a phone
// both are the common case rather than the exception, so a header that counted only
// visible rows would under-report exactly when the summary matters most.
//
// ONLY actionable states get a badge. A plain "N sessions" count was deliberately
// dropped in 939bb4d: the nested rows already say it, and it crowded the collapse
// chevron off the right edge. The idle cases below pin that, so restoring the count
// has to be a decision rather than an accident.
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

function renderHeader(group, extra = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(ThreadGroupHeader, {
        group,
        isCollapsed: false,
        normalizedCwd: "",
        onRenameProject: () => {},
        onDeleteProject: () => {},
        ...extra,
      })
    );
  });
  return {
    // A dot and a number on screen; the words are the badge's accessible name.
    badges: [...host.querySelectorAll(".thread-group-count")].map((n) => n.getAttribute("aria-label")),
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const projectGroup = (summary, threads = []) => ({
  key: "p1",
  cwd: "",
  projectId: "p1",
  label: "Alpha",
  threads,
  summary,
});

// The exact badge SET for each summary shape: only states worth acting on, never a
// plain session count.

test("an idle project shows no badge, however many sessions it holds", () => {
  const view = renderHeader(projectGroup({ working: 0, needsInput: 0, total: 4 }));
  try {
    assert.deepEqual(view.badges, [], "a plain count restates the rows below it");
  } finally {
    view.cleanup();
  }
});

test("needs-input alone still earns a badge", () => {
  const view = renderHeader(projectGroup({ working: 0, needsInput: 2, total: 9 }));
  try {
    assert.deepEqual(view.badges, ["2 needs input"]);
  } finally {
    view.cleanup();
  }
});

// The whole point of carrying the counts separately: a collapsed or truncated group
// still reports its real totals.
test("counts come from the summary, not from the rows on screen", () => {
  const view = renderHeader(projectGroup({ working: 3, needsInput: 0, total: 12 }, []));
  try {
    assert.deepEqual(view.badges, ["3 working"], "no rows present, counts still reported");
  } finally {
    view.cleanup();
  }
});

test("a group with no summary renders no badges", () => {
  const view = renderHeader({
    key: "p1",
    cwd: "",
    projectId: "p1",
    label: "Alpha",
    threads: [],
  });
  try {
    assert.deepEqual(view.badges, []);
  } finally {
    view.cleanup();
  }
});

// cwd groups are not projects; they never take the project branch, so a summary on one
// must not produce badges.
test("a cwd group never renders project badges", () => {
  const view = renderHeader({
    key: "/work/a",
    cwd: "/work/a",
    label: "a",
    threads: [],
    summary: { working: 9, needsInput: 9, total: 9 },
  });
  try {
    assert.deepEqual(view.badges, []);
  } finally {
    view.cleanup();
  }
});
