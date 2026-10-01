import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectMenuItems,
  currentProjectLabel,
  pickNewProjectId,
  normalizeProjectName,
  placeProjectSubmenu,
  projectsMenuReady,
  projectMenuActionAllowed,
} from "./project-menu.js";

// Geometry for the second-level flyout. Pure math on purpose: the browser e2e can only
// ever exercise the open-right branch (the sidebar — and so the menu — is anchored to the
// left edge), so flipping and edge clamping are only testable here.
const MENU = { left: 100, right: 360, top: 300, bottom: 450 };
const TRIGGER = { left: 104, right: 356, top: 410, bottom: 442 };
const place = (overrides = {}) =>
  placeProjectSubmenu({
    menuRect: MENU,
    triggerRect: TRIGGER,
    submenuWidth: 260,
    submenuHeight: 200,
    viewportWidth: 1400,
    viewportHeight: 900,
    ...overrides,
  });

test("placeProjectSubmenu: opens beside the menu, first row aligned with its trigger", () => {
  const { left, top, opensLeft } = place();
  assert.equal(left, MENU.right + 4, "sits just outside the menu's right edge, clear of its padding");
  assert.equal(top, TRIGGER.top - 4, "lifted by the panel's own padding so row 1 lines up with the trigger");
  assert.equal(opensLeft, false);
});

test("placeProjectSubmenu: flips to the menu's left when the right side has no room", () => {
  // A menu opened far right: nothing fits beyond it, but there is room before it.
  const menuRect = { left: 400, right: 660, top: 300, bottom: 450 };
  const { left, opensLeft } = place({ menuRect, viewportWidth: 700 }); // 660+4+260 > 692
  assert.equal(left, 400 - 4 - 260, "mirrored to the far side of the menu");
  assert.equal(opensLeft, true);
});

test("placeProjectSubmenu: when NEITHER side fits, clamp rather than hang off-screen", () => {
  // Narrow viewport with the menu near the left: flipping would land at -164.
  const { left, opensLeft } = place({ viewportWidth: 600 });
  assert.equal(left, 8, "pinned to the left margin");
  assert.equal(opensLeft, true, "still reports the flip it attempted");
});

test("placeProjectSubmenu: a long list near the bottom is lifted, not left hanging off", () => {
  // Trigger sits low and the panel is tall: anchoring at the trigger would overflow.
  const { top } = place({ submenuHeight: 400, viewportHeight: 700 });
  assert.equal(top, 700 - 8 - 400, "bottom edge parked on the margin");
  assert.ok(top < TRIGGER.top, "so it opens upward relative to its row");
});

test("placeProjectSubmenu: a panel taller/wider than the viewport pins to the top-left margin", () => {
  // The min must win over the max, or clamping sends it off-screen negative.
  const { left, top } = place({ submenuWidth: 2000, submenuHeight: 2000 });
  assert.equal(top, 8, "top margin wins");
  assert.equal(left, 8, "left margin wins");
});

test("placeProjectSubmenu: tolerates a missing/degenerate anchor instead of throwing", () => {
  const { left, top } = placeProjectSubmenu();
  assert.ok(Number.isFinite(left) && Number.isFinite(top), `finite fallback: ${left},${top}`);
});

test("buildProjectMenuItems: unassigned thread → assign options + create, no unassign", () => {
  const items = buildProjectMenuItems({
    projects: [
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
    ],
    currentProjectId: null,
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.label, i.isCurrent ?? null]),
    [
      ["assign", "Alpha", false], // sorted by name
      ["assign", "Beta", false],
      ["create", "New project…", null],
    ]
  );
});

test("buildProjectMenuItems: assigned thread → current project leads, unassign comes last", () => {
  const items = buildProjectMenuItems({
    projects: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
      { id: "c", name: "Gamma" },
    ],
    currentProjectId: "b",
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.label, i.isCurrent ?? null]),
    [
      // The thread's own project sits at the top, checked — the submenu opens with
      // "where am I" already visible, and moving elsewhere is one click below.
      ["assign", "Beta", true],
      ["assign", "Alpha", false],
      ["assign", "Gamma", false],
      ["create", "New project…", null],
      ["unassign", "Remove from project", null],
    ]
  );
});

test("currentProjectLabel: the submenu trigger's value text", () => {
  const projects = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "" },
  ];
  assert.equal(currentProjectLabel({ projects, currentProjectId: "a" }), "Alpha");
  assert.equal(currentProjectLabel({ projects, currentProjectId: "b" }), "b", "falls back to the id when unnamed");
  assert.equal(currentProjectLabel({ projects, currentProjectId: null }), null, "unassigned → no value");
  assert.equal(
    currentProjectLabel({ projects, currentProjectId: "gone" }),
    null,
    "membership pointing at a project we no longer hold → no value (never invent a name)"
  );
  assert.equal(currentProjectLabel(), null, "missing state → no value");
});

test("buildProjectMenuItems: tolerates missing/empty inputs", () => {
  assert.deepEqual(
    buildProjectMenuItems().map((i) => i.kind),
    ["create"],
    "no projects → just the create action"
  );
  const items = buildProjectMenuItems({ projects: [{ name: "no-id" }, null, { id: "x", name: "X" }] });
  assert.deepEqual(items.filter((i) => i.kind === "assign").map((i) => i.projectId), ["x"], "id-less/null entries are dropped");
});

test("pickNewProjectId: returns the single new id after a create (set-diff, not by name)", () => {
  const before = [{ id: "a", name: "Dup" }];
  const after = [
    { id: "a", name: "Dup" },
    { id: "b", name: "Dup" }, // same name, different id — find-by-name would be ambiguous
  ];
  assert.equal(pickNewProjectId(before, after), "b");
});

test("pickNewProjectId: null when zero or more-than-one new ids", () => {
  assert.equal(pickNewProjectId([{ id: "a" }], [{ id: "a" }]), null, "nothing new");
  assert.equal(
    pickNewProjectId([{ id: "a" }], [{ id: "a" }, { id: "b" }, { id: "c" }]),
    null,
    "ambiguous — more than one new id"
  );
  assert.equal(pickNewProjectId(null, [{ id: "b" }]), "b", "empty before → the one new id");
});

test("normalizeProjectName: trims, rejects blank/null", () => {
  assert.equal(normalizeProjectName("  Sealwire  "), "Sealwire");
  assert.equal(normalizeProjectName("   "), null);
  assert.equal(normalizeProjectName(""), null);
  assert.equal(normalizeProjectName(null), null);
  assert.equal(normalizeProjectName(undefined), null);
});

test("projectsMenuReady: only fresh Projects state enables mutation controls (fail closed)", () => {
  assert.equal(
    projectsMenuReady({ projectsLoaded: true, projectsError: null, projectsLoading: false }),
    true,
    "loaded, no error, settled → controls enabled"
  );
  assert.equal(
    projectsMenuReady({ projectsLoaded: false, projectsError: null, projectsLoading: false }),
    false,
    "before the first successful load"
  );
  assert.equal(
    projectsMenuReady({ projectsLoaded: true, projectsError: "boom", projectsLoading: false }),
    false,
    "after an error (even if previously loaded)"
  );
  assert.equal(
    projectsMenuReady({ projectsLoaded: true, projectsError: null, projectsLoading: true }),
    false,
    "while a newer-revision refresh is pending"
  );
  assert.equal(projectsMenuReady(), false, "missing state → fail closed");
});

test("projectMenuActionAllowed: a button built from stale Project state cannot execute", () => {
  const fresh = { projectsLoaded: true, projectsError: null, projectsLoading: false };
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 5, ...fresh }),
    true,
    "same seq + fresh → allowed"
  );
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 6, ...fresh }),
    false,
    "the state changed since the button was built (newer revision) → refused"
  );
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 5, projectsLoaded: true, projectsError: "boom", projectsLoading: false }),
    false,
    "same seq but state no longer trustworthy → refused"
  );
  assert.equal(
    projectMenuActionAllowed({ builtSeq: 5, currentSeq: 5, projectsLoaded: true, projectsError: null, projectsLoading: true }),
    false,
    "same seq but a refresh is pending → refused"
  );
});
