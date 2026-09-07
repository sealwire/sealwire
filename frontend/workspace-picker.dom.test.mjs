// jsdom rather than SSR: the panel does not exist until opened, and everything worth
// pinning here is a click or a keystroke.
import test, { afterEach } from "node:test";
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
const { HIDDEN_CHECK_INTERVAL_MS, ThreadWorkspaceField, WorkspacePicker } = await import(
  "./shared/workspace-picker.js"
);

const SESSION_CWD = "/repo/main";
const OTHER_CWD = "/repo/wt";

const ROOTS = [
  { path: SESSION_CWD, branch: "main", is_main: true, changed_files: 0 },
  { path: OTHER_CWD, branch: "feat/thing", is_main: false, changed_files: 2 },
  { path: "/repo/wt-2", branch: "fix/other", is_main: false, changed_files: 1 },
];

const WORKSPACE = {
  cwd: SESSION_CWD,
  origin: { kind: "proven" },
  git: { cwd: SESSION_CWD, is_repo: true, branch: "main", detached: false, dirty: false },
  roots: ROOTS,
  birth_cwd: SESSION_CWD,
  birth_cwd_exists: true,
};

// Centralised because an OPEN picker holds an interval: a test whose assertion throws
// before its own cleanup would otherwise leak a mounted component into the next one.
const mounted = [];

afterEach(() => {
  while (mounted.length) {
    mounted.pop().cleanup();
  }
});

function mount(Component, props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(Component, props)));
  let done = false;
  const view = {
    host,
    cleanup() {
      // Idempotent: tests still call this explicitly where the ordering matters.
      if (done) return;
      done = true;
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.push(view);
  return view;
}

const click = (element) => act(() => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

function type(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

const key = (element, k) =>
  act(() => element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true })));

const open = (host) => click(host.querySelector(".workspace-picker-trigger"));
const rows = (host) => [...host.querySelectorAll(".workspace-picker-row")];
const rowText = (host) => rows(host).map((row) => row.textContent);

// jsdom answers every feature query with `matches: false`, which would read as a
// touch device and quietly disarm the desktop half of these two tests.
function setPrimaryPointer(kind) {
  dom.window.matchMedia = (query) => ({
    addEventListener() {},
    addListener() {},
    matches: query.includes("pointer: fine") && kind === "fine",
    media: query,
    removeEventListener() {},
    removeListener() {},
  });
}

function recordingFocus(run) {
  const focus = dom.window.HTMLInputElement.prototype.focus;
  const calls = [];
  dom.window.HTMLInputElement.prototype.focus = function recordFocus(options) {
    calls.push(options ?? null);
    return focus.call(this, options);
  };
  try {
    return run(calls);
  } finally {
    dom.window.HTMLInputElement.prototype.focus = focus;
    delete dom.window.matchMedia;
  }
}

test("opening focuses the portalled search without scrolling its dialog", () => {
  setPrimaryPointer("fine");
  recordingFocus((calls) => {
    const view = mount(WorkspacePicker, { suggestions: [], value: SESSION_CWD });
    open(view.host);

    assert.deepEqual(
      calls,
      [{ preventScroll: true }],
      "a mobile browser must not move the trigger away from its fixed menu while focusing"
    );
    view.cleanup();
  });
});

test("a touch device opens the panel without summoning the keyboard", () => {
  // On a phone the focus opened the software keyboard at the same moment as the
  // panel: half the rows went behind it, and the list moved as it animated in.
  // The field is still there to tap — it just no longer takes the caret uninvited.
  setPrimaryPointer("coarse");
  recordingFocus((calls) => {
    const view = mount(WorkspacePicker, { roots: ROOTS, value: SESSION_CWD });
    open(view.host);

    const input = view.host.querySelector(".workspace-picker-input");
    assert.ok(input, "the search field is still offered");
    assert.deepEqual(calls, [], "opening must not focus the field on a touch device");
    assert.notEqual(document.activeElement, input);
    assert.ok(rows(view.host).length > 0, "the rows are what the user came for");
    view.cleanup();
  });
});

test("the panel groups worktrees under the repo, branch first", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: SESSION_CWD });
  open(view.host);

  assert.equal(view.host.querySelector(".workspace-picker-group-name").textContent, "main");
  assert.equal(view.host.querySelector(".workspace-picker-group-count").textContent, "3 worktrees");
  assert.deepEqual(
    rows(view.host).map((row) => row.querySelector(".workspace-picker-row-primary").textContent),
    ["main", "feat/thing", "fix/other"]
  );
  view.cleanup();
});

test("each row carries its directory and change count", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: SESSION_CWD });
  open(view.host);

  const subs = [...view.host.querySelectorAll(".workspace-picker-row-sub")].map((s) => s.textContent);
  assert.match(subs[0], /main.*clean/);
  assert.match(subs[1], /wt.*2 files changed/);
  assert.match(subs[2], /wt-2.*1 file changed/);
  view.cleanup();
});

// An unmeasured tree must render no subtitle at all rather than claiming "clean".
test("a root with no measured count shows no status", () => {
  const view = mount(WorkspacePicker, {
    roots: [{ path: SESSION_CWD, branch: "main", is_main: true }],
    value: SESSION_CWD,
  });
  open(view.host);

  assert.equal(view.host.querySelector(".workspace-picker-row-status"), null);
  view.cleanup();
});

test("the selected row is the only one marked", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: OTHER_CWD });
  open(view.host);

  assert.deepEqual(
    rows(view.host).map((row) => row.getAttribute("aria-selected")),
    ["false", "true", "false"]
  );
  assert.equal(view.host.querySelectorAll(".workspace-picker-row-check").length, 1);
  view.cleanup();
});

test("typing filters the list and the count reports the narrowing", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: SESSION_CWD });
  open(view.host);
  assert.equal(view.host.querySelector(".workspace-picker-count").textContent, "3");

  type(view.host.querySelector(".workspace-picker-input"), "fix");

  assert.equal(rowText(view.host).length, 1);
  assert.equal(view.host.querySelector(".workspace-picker-count").textContent, "1/3");
  view.cleanup();
});

// The launch dialogs' only way to name a directory the relay has never seen. An e2e
// harness drives exactly this, so it cannot regress into a filter-only field.
test("a path typed into the filter is committed on Enter", () => {
  const picked = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onChange: (next) => picked.push(next),
  });
  open(view.host);

  const input = view.host.querySelector(".workspace-picker-input");
  type(input, "/tmp/brand-new");
  key(input, "Enter");

  assert.deepEqual(picked, ["/tmp/brand-new"]);
  assert.equal(view.host.querySelector(".workspace-picker-panel"), null, "committing closes the panel");
  view.cleanup();
});

// A branch name contains a slash but does not START with one; treating it as a path
// would send `fix/other` to the relay as a directory.
test("a branch-shaped filter is not mistaken for a path", () => {
  const picked = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onChange: (next) => picked.push(next),
  });
  open(view.host);

  const input = view.host.querySelector(".workspace-picker-input");
  type(input, "fix/other");
  key(input, "Enter");

  assert.deepEqual(picked, ["/repo/wt-2"], "Enter picks the matching row, not the typed text");
  view.cleanup();
});

// With fifteen worktrees, parking the cursor on row 0 both answers "which one am I
// on?" wrongly and puts ArrowDown a screen away from the tree in view.
test("the keyboard cursor opens on the tree in view, not on the first row", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: "/repo/wt-2" });
  open(view.host);

  const active = rows(view.host).map((row) => row.classList.contains("is-active"));
  assert.deepEqual(active, [false, false, true]);
  view.cleanup();
});

test("with nothing selected the cursor falls back to the first row", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: "" });
  open(view.host);

  assert.equal(rows(view.host)[0].classList.contains("is-active"), true);
  view.cleanup();
});

// The cursor seeds once per opening. If it re-seeded on every render it would snap
// back to the selected row mid-filter, undoing each ArrowDown as you typed.
test("filtering does not drag the cursor back to the selected row", () => {
  const view = mount(WorkspacePicker, { roots: ROOTS, value: SESSION_CWD });
  open(view.host);

  type(view.host.querySelector(".workspace-picker-input"), "f");
  const active = rows(view.host).map((row) => row.classList.contains("is-active"));
  assert.deepEqual(active, [true, false], "the cursor resets to the top of the new list");
  view.cleanup();
});

// The old picker committed ANY non-empty text, and the relay resolves a bare `repo`.
// Shape cannot tell it from a filter word; outcome can.
test("text that matches no tree is offered as a path", () => {
  const picked = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onChange: (next) => picked.push(next),
  });
  open(view.host);

  const input = view.host.querySelector(".workspace-picker-input");
  type(input, "some-sibling-repo");
  assert.match(
    view.host.querySelector(".workspace-picker-footer-action").textContent,
    /Use some-sibling-repo/,
    "the footer must offer it, or the text looks simply rejected"
  );

  key(input, "Enter");
  assert.deepEqual(picked, ["some-sibling-repo"]);
  view.cleanup();
});

// …but while rows still match, the text is a filter and Enter belongs to the list.
test("text that still matches a tree stays a filter", () => {
  const picked = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onChange: (next) => picked.push(next),
  });
  open(view.host);

  const input = view.host.querySelector(".workspace-picker-input");
  type(input, "feat");
  assert.doesNotMatch(
    view.host.querySelector(".workspace-picker-footer-action").textContent,
    /Use /,
    "offering to create a path while its rows are on screen is just noise"
  );

  key(input, "Enter");
  assert.deepEqual(picked, [OTHER_CWD], "Enter takes the matching row");
  view.cleanup();
});

test("arrow keys move the selection and Enter takes it", () => {
  const picked = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onChange: (next) => picked.push(next),
  });
  open(view.host);

  const input = view.host.querySelector(".workspace-picker-input");
  key(input, "ArrowDown");
  key(input, "Enter");

  assert.deepEqual(picked, [OTHER_CWD]);
  view.cleanup();
});

test("the panel measures root status only when it opens", () => {
  let opens = 0;
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onOpen: () => {
      opens += 1;
    },
  });
  assert.equal(opens, 0, "a closed picker costs the relay nothing");

  open(view.host);
  assert.equal(opens, 1);
  view.cleanup();
});

// An unreported close leaves the relay running a `git status` per worktree on every
// turn, forever.
test("closing the panel reports it, so measuring can stop", () => {
  const events = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
  });

  open(view.host);
  open(view.host); // the trigger toggles
  assert.deepEqual(events, ["open", "close"]);
  view.cleanup();
});

test("committing a row closes the panel and reports it", () => {
  const events = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onChange: () => {},
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
  });

  open(view.host);
  click(rows(view.host)[1]);
  assert.deepEqual(events, ["open", "close"]);
  view.cleanup();
});

// A thread switch or tab change unmounts the picker outright — it never runs a close
// handler, and the caller would keep paying for measurements nobody can see.
test("unmounting while open reports the close", () => {
  const events = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
  });

  open(view.host);
  view.cleanup();
  assert.deepEqual(events, ["open", "close"]);
});

// Hiding the container is not closing the picker: sheet, modal and rail all keep it
// MOUNTED and open. Only a pointer close happens to dismiss it. jsdom has no
// `checkVisibility`, so the browser's answer is stubbed here.

// The visibility check runs on a timer, so the assertion has to let one tick land.
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HIDDEN_CHECK_INTERVAL_MS + 60));
  });
}

async function withVisibility(fn) {
  const proto = dom.window.Element.prototype;
  const had = Object.prototype.hasOwnProperty.call(proto, "checkVisibility");
  const previous = proto.checkVisibility;
  let visible = true;
  proto.checkVisibility = () => visible;
  try {
    return await fn({
      hide() {
        visible = false;
      },
      show() {
        visible = true;
      },
    });
  } finally {
    if (had) proto.checkVisibility = previous;
    else delete proto.checkVisibility;
  }
}

test("a picker hidden by its container closes, so measuring stops", async () => {
  await withVisibility(async ({ hide }) => {
    const events = [];
    const view = mount(WorkspacePicker, {
      roots: ROOTS,
      value: SESSION_CWD,
      onOpen: () => events.push("open"),
      onClose: () => events.push("close"),
    });
    open(view.host);
    assert.deepEqual(events, ["open"]);

    // However it happened — dialog.close(), a collapsed rail, a hidden view — all the
    // picker can observe is that it is no longer visible.
    hide();
    await tick();

    assert.deepEqual(events, ["open", "close"], "a hidden picker must report itself shut");
    assert.equal(view.host.querySelector(".workspace-picker-panel"), null);
    document.body.classList.remove("rail-collapsed");
    view.cleanup();
  });
});

// The reverse mismatch: stopping measurement while staying open would reopen to visible
// rows that never fire `onOpen` again, so nothing refreshes them.
test("a picker hidden and shown again opens cleanly and measures again", async () => {
  await withVisibility(async ({ hide, show }) => {
    const events = [];
    const view = mount(WorkspacePicker, {
      roots: ROOTS,
      value: SESSION_CWD,
      onOpen: () => events.push("open"),
      onClose: () => events.push("close"),
    });
    open(view.host);
    hide();
    await tick();

    // The container comes back, and so must the picker's ability to open.
    show();
    open(view.host);
    assert.deepEqual(events, ["open", "close", "open"]);
    view.cleanup();
  });
});

// Closing on an undeterminable answer would shut the panel under the user's cursor, in
// every environment without `checkVisibility`.
test("a visible picker is never closed by the check", async () => {
  const events = [];
  const view = mount(WorkspacePicker, {
    roots: ROOTS,
    value: SESSION_CWD,
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
  });
  open(view.host);
  // No `checkVisibility` in jsdom: "cannot tell" must mean visible, or every panel in
  // an environment without the API would slam shut under the user's cursor.
  await tick();

  assert.deepEqual(events, ["open"]);
  assert.ok(view.host.querySelector(".workspace-picker-panel"));
  view.cleanup();
});

// The store tracks WHICH pickers are open, so each has to identify itself — otherwise
// the rail and the sheet look like the same owner and one closing releases the other.
test("each picker identifies itself when it opens and closes", () => {
  const opened = [];
  const closed = [];
  const props = {
    roots: ROOTS,
    value: SESSION_CWD,
    onOpen: (owner) => opened.push(owner),
    onClose: (owner) => closed.push(owner),
  };
  const rail = mount(WorkspacePicker, props);
  const sheet = mount(WorkspacePicker, props);

  // An OPEN picker holds an interval, so a failed assertion here would keep the test
  // runner's event loop alive and hang instead of failing. Unmount either way.
  try {
    open(rail.host);
    open(sheet.host);
    assert.equal(opened.length, 2);
    assert.ok(opened[0], "an owner id must actually be passed");
    assert.notEqual(opened[0], opened[1], "two pickers are two owners");

    open(rail.host); // toggles the rail shut
    assert.deepEqual(closed, [opened[0]], "the one that closed names itself, not the other");
  } finally {
    rail.cleanup();
    sheet.cleanup();
  }
});

test("the dialogs' plain path list still renders and commits", () => {
  const picked = [];
  const view = mount(WorkspacePicker, {
    suggestions: [
      { cwd: "/Users/dev/git/project", label: "Current session" },
      { cwd: "/tmp/scratch", label: "Allowed root" },
    ],
    value: "/tmp/scratch",
    onChange: (next) => picked.push(next),
  });
  open(view.host);

  assert.equal(view.host.querySelector(".workspace-picker-group-head"), null, "no repo header");
  click(rows(view.host)[0]);
  assert.deepEqual(picked, ["/Users/dev/git/project"], "the raw path, not the ~ form");
  view.cleanup();
});

// --- following the session (what replaced the "Follow session" button) -------------

test("a Diff preview offers no Follow session button", () => {
  const view = mount(ThreadWorkspaceField, {
    workspace: { ...WORKSPACE, cwd: OTHER_CWD },
    sessionCwd: SESSION_CWD,
    previewing: true,
    onView: () => {},
  });

  assert.doesNotMatch(view.host.textContent, /Follow session/);
  view.cleanup();
});

// The button is gone, so this row IS the way back. If it stopped clearing the preview,
// a preview would be a one-way door.
test("picking the session's own tree clears the preview instead of pinning to it", () => {
  const viewed = [];
  const view = mount(ThreadWorkspaceField, {
    workspace: { ...WORKSPACE, cwd: OTHER_CWD },
    sessionCwd: SESSION_CWD,
    previewing: true,
    onView: (path) => viewed.push(path),
  });
  open(view.host);

  const sessionRow = rows(view.host).find((row) => row.textContent.includes("main"));
  click(sessionRow);

  assert.deepEqual(viewed, [null], "null means follow the session, not view that path");
  view.cleanup();
});

test("picking any other tree previews that path", () => {
  const viewed = [];
  const view = mount(ThreadWorkspaceField, {
    workspace: { ...WORKSPACE, cwd: SESSION_CWD },
    sessionCwd: SESSION_CWD,
    onView: (path) => viewed.push(path),
  });
  open(view.host);

  click(rows(view.host)[1]);

  assert.deepEqual(viewed, [OTHER_CWD]);
  view.cleanup();
});

test("the session's tree is badged so it can be found in a long list", () => {
  const view = mount(ThreadWorkspaceField, {
    workspace: { ...WORKSPACE, cwd: OTHER_CWD },
    sessionCwd: SESSION_CWD,
    previewing: true,
    onView: () => {},
  });
  open(view.host);

  const badges = [...view.host.querySelectorAll(".workspace-picker-badge")].map((b) => b.textContent);
  assert.ok(badges.includes("session"), `expected a session badge, got ${badges.join(", ")}`);
  assert.ok(badges.includes("checkout"), "the repo's main checkout is still marked");
  view.cleanup();
});

// Pinning is the review panel's job and must keep its own escape hatch, which is a
// different control with different consequences.
test("the pin surface keeps its Unpin button", () => {
  const pinned = [];
  const view = mount(ThreadWorkspaceField, {
    workspace: { ...WORKSPACE, origin: { kind: "pinned" } },
    onPin: (path) => pinned.push(path),
  });

  const unpin = view.host.querySelector(".thread-workspace-unpin");
  assert.ok(unpin, "a pinned workspace must still be unpinnable");
  click(unpin);
  assert.deepEqual(pinned, [null]);
  view.cleanup();
});

// Ungranted: Trust prompt only on Diff/Review (surfaces the user opened on purpose).
const RESTRICTED_WORKSPACE = {
  ...WORKSPACE,
  git: {
    cwd: SESSION_CWD,
    is_repo: true,
    branch: "main",
    detached: false,
    dirty: false,
    dirty_known: false, restricted: true,
  },
  roots: [],
};

test("a workspace that failed to resolve still says so instead of rendering nothing", () => {
  const view = mount(ThreadWorkspaceField, {
    workspace: null,
    error: "relay busy",
    sessionCwd: SESSION_CWD,
    onView: () => {},
  });

  assert.notEqual(view.host.innerHTML, "", "a silent disappearance is indistinguishable from a bug");
  assert.match(view.host.textContent, /relay busy/, "the reason it is missing must be on screen");
  view.cleanup();
});

test("an ungranted tree offers the grant where the diff was asked for", () => {
  const granted = [];
  const view = mount(ThreadWorkspaceField, {
    workspace: RESTRICTED_WORKSPACE,
    sessionCwd: SESSION_CWD,
    onView: () => {},
    onTrustWorkspace: (cwd) => granted.push(cwd),
  });

  const row = view.host.querySelector(".thread-workspace-trust");
  const button = view.host.querySelector(".thread-workspace-trust-button");
  assert.ok(button, "asking for a diff is the moment a trust prompt is meaningful");
  assert.ok(row, "the grant sits in one dedicated row under the tree bar");
  assert.equal(
    button.classList.contains("link-button"),
    false,
    "a link-styled control reads as body text; the grant needs a button"
  );
  assert.match(row.textContent, /Trust this folder/);
  assert.match(
    row.textContent,
    /run git|hooks/i,
    "trust is a security decision; the row must say what granting enables"
  );
  click(button);
  assert.deepEqual(granted, [SESSION_CWD], "the grant names the tree being looked at");
  view.cleanup();
});

test("a granted tree is never asked about", () => {
  const view = mount(ThreadWorkspaceField, {
    workspace: { ...WORKSPACE, git: { ...WORKSPACE.git, dirty_known: true } },
    sessionCwd: SESSION_CWD,
    onView: () => {},
    onTrustWorkspace: () => {},
  });

  assert.equal(
    view.host.querySelector(".thread-workspace-trust"),
    null,
    "a prompt that appears when nothing is needed is the one people click through"
  );
  view.cleanup();
});

test("a paired device cannot grant, and is told where the grant lives", () => {
  const view = mount(ThreadWorkspaceField, {
    workspace: RESTRICTED_WORKSPACE,
    sessionCwd: SESSION_CWD,
    onView: () => {},
    // No handler ⇒ remote: explanation only, no grant control.
    onTrustWorkspace: null,
  });

  assert.equal(
    view.host.querySelector(".thread-workspace-trust-button"),
    null,
    "a button that cannot possibly work is worse than no button"
  );
  const note = view.host.querySelector(".thread-workspace-trust");
  assert.ok(note, "the state is still explained, it is just read-only here");
  assert.match(note.textContent, /computer running the relay/i);
  view.cleanup();
});
