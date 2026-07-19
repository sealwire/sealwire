import test from "node:test";
import assert from "node:assert/strict";

import {
  UNKNOWN_WORKSPACE_CWD,
  UNKNOWN_WORKSPACE_LABEL,
  buildNavigationThreadGroups,
  buildThreadGroups,
  isUnknownWorkspace,
} from "./thread-groups.js";

const THREADS = [
  { id: "t-known", cwd: "/repo", updated_at: 2, provider: "codex" },
  // cwd recovery is best-effort: the JSONL may be gone, the session id may not
  // match the scan pattern, or the relay may have restarted with no runtime
  // memory. When it fails the thread must still be reachable.
  { id: "t-empty", cwd: "", updated_at: 3, provider: "claude_code" },
];

// The user-visible failure this guards: a forked session existed on disk and in
// the relay, but vanished from the local sidebar with no error — because
// grouping silently skipped it. Remote already opted into the fallback, so the
// same thread was visible on the phone and gone on the desktop.
test("a thread with no cwd is grouped, never dropped", () => {
  const groups = buildNavigationThreadGroups(THREADS);

  const listed = groups.flatMap((group) => group.threads.map((t) => t.id));
  assert.ok(listed.includes("t-empty"), "an unrecoverable cwd must not hide the thread");
  assert.equal(listed.length, 2);

  const unknown = groups.find((group) => group.cwd === UNKNOWN_WORKSPACE_CWD);
  assert.ok(unknown, "it lands in a dedicated group");
  assert.equal(unknown.label, UNKNOWN_WORKSPACE_LABEL);
});

test("without the fallback the thread disappears — the bug being guarded", () => {
  const groups = buildThreadGroups(THREADS);
  const listed = groups.flatMap((group) => group.threads.map((t) => t.id));
  assert.deepEqual(listed, ["t-known"]);
});

// The local refresh writes the grouped result back to `state.threads`
// (lifecycle.js), so a dropped row is not merely invisible — it also leaves the
// list that resolveForkSourceThread and the context menu read, making the
// thread unforkable and unopenable.
test("the flattened navigation list keeps the unrecoverable thread", () => {
  const groups = buildNavigationThreadGroups(THREADS);
  const flattened = groups.flatMap((group) => group.threads);

  assert.equal(flattened.length, 2);
  assert.ok(flattened.some((thread) => thread.id === "t-empty"));
});

// Every surface must resolve to the same policy — local dropped these rows
// while remote kept them, so one thread was visible on the phone and gone on
// the desktop.
test("the navigation policy is identical for every surface", () => {
  const viaPolicy = buildNavigationThreadGroups(THREADS);
  const viaOption = buildThreadGroups(THREADS, { includeUnknownWorkspace: true });
  assert.deepEqual(viaPolicy, viaOption);
});

// The sentinel is a DISPLAY key, not a directory. It reached real cwd
// operations: clicking the group header ran setSelectedCwd(sentinel), which
// writes straight into the workspace input, so starting a session would have
// sent "__unknown_workspace__" to the relay as a path.
test("the sentinel is identifiable so it never reaches directory operations", () => {
  assert.equal(isUnknownWorkspace(UNKNOWN_WORKSPACE_CWD), true);
  assert.equal(isUnknownWorkspace("/repo"), false);
  assert.equal(isUnknownWorkspace(""), false);
  assert.equal(isUnknownWorkspace(null), false);
});

test("selecting a workspace refuses the sentinel", () => {
  const selected = [];
  const onSelect = (cwd) => {
    if (isUnknownWorkspace(cwd)) return;
    selected.push(cwd);
  };

  onSelect(UNKNOWN_WORKSPACE_CWD);
  onSelect("/repo");

  assert.deepEqual(selected, ["/repo"], "only real directories may be selected");
});

// Static contract over the real call sites. The previous test only compared the
// helper to its own option, which cannot catch the failure that actually
// happened: one surface not calling the helper at all. Local dropped
// unknown-cwd rows while remote kept them, so the same thread was visible on
// the phone and gone on the desktop.
test("every thread-list surface groups through the navigation policy", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");

  const SURFACES = [
    "local/session/lifecycle.js", // main refresh
    "app.js", // post-archive and post-delete regroup
    "remote/view-model.js", // remote nav
  ];

  for (const relative of SURFACES) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.ok(
      source.includes("buildNavigationThreadGroups("),
      `${relative} must group through the shared navigation policy`
    );
    assert.doesNotMatch(
      source,
      /\bbuildThreadGroups\(/,
      `${relative} must not call the raw grouper (it drops unknown-cwd rows)`
    );
  }
});

// The sentinel must not be renderable as a selectable workspace.
test("the unknown group header is not a workspace button", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ThreadGroupHeader } = await import("./thread-list-react.js");

  const render = (cwd, label) =>
    renderToStaticMarkup(
      React.createElement(ThreadGroupHeader, {
        collapsible: false,
        group: { cwd, label },
        isCollapsed: false,
        normalizedCwd: cwd,
        onSelectWorkspace: () => {},
        onToggleGroup: null,
      })
    );

  const unknown = render(UNKNOWN_WORKSPACE_CWD, UNKNOWN_WORKSPACE_LABEL);
  assert.match(unknown, /Unknown workspace/, "the group is still labelled");
  assert.doesNotMatch(unknown, /data-select-workspace/, "but not selectable");
  assert.doesNotMatch(unknown, /<button/, "and not a button at all");
  assert.doesNotMatch(
    unknown,
    /__unknown_workspace__/,
    "and the internal key is never shown to the user"
  );

  // Remote renders collapsible headers; the internal key must not leak there
  // either (it is a tooltip, not a directory operation, but it is still shown
  // to the user).
  const collapsible = renderToStaticMarkup(
    React.createElement(ThreadGroupHeader, {
      collapsible: true,
      group: { cwd: UNKNOWN_WORKSPACE_CWD, label: UNKNOWN_WORKSPACE_LABEL },
      isCollapsed: false,
      normalizedCwd: UNKNOWN_WORKSPACE_CWD,
      onToggleGroup: () => {},
    })
  );
  assert.doesNotMatch(collapsible, /__unknown_workspace__/);
  assert.match(collapsible, /Unknown workspace/);

  const real = render("/repo", "repo");
  assert.match(real, /data-select-workspace="\/repo"/, "real workspaces stay selectable");
});
