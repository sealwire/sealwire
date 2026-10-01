import test from "node:test";
import assert from "node:assert/strict";

import { buildProjectPickerRows, filterProjectRows } from "./project-picker-model.js";
import { formatRelativeTime } from "../remote/utils.js";

const NOW = 1_700_000_000;
const minutesAgo = (n) => NOW - n * 60;
const daysAgo = (n) => NOW - n * 86_400;

function thread(id, updatedAt) {
  return { id, updated_at: updatedAt };
}

test("each project row counts its sessions, and the default row counts what it is given", () => {
  const { defaultRow, projectRows } = buildProjectPickerRows({
    projects: [
      { id: "p1", name: "Small improvement" },
      { id: "p2", name: "UI Redesign" },
    ],
    threads: [thread("t1", NOW), thread("t2", NOW), thread("t3", NOW), thread("t4", NOW)],
    threadProjectId: { t1: "p1", t2: "p1", t3: "p2" },
    activeProjectId: "p1",
    defaultCount: 4,
  });

  assert.deepEqual(defaultRow, { id: null, label: "All sessions", count: 4, active: false });
  assert.deepEqual(
    projectRows.map((row) => [row.id, row.label, row.count, row.active]),
    [
      ["p1", "Small improvement", 2, true],
      ["p2", "UI Redesign", 1, false],
    ]
  );
});

test("projects are ordered by their newest session, and empty ones follow by name", () => {
  const { projectRows } = buildProjectPickerRows({
    projects: [
      { id: "a", name: "Alpha" },
      { id: "z", name: "Zulu" },
      { id: "m", name: "Mike" },
      { id: "e", name: "Echo" },
    ],
    threads: [thread("t1", daysAgo(3)), thread("t2", minutesAgo(5)), thread("t3", daysAgo(1))],
    threadProjectId: { t1: "a", t2: "z", t3: "a" },
  });

  assert.deepEqual(
    projectRows.map((row) => row.label),
    ["Zulu", "Alpha", "Echo", "Mike"]
  );
});

test("the default row is active when no project is selected", () => {
  const { defaultRow } = buildProjectPickerRows({ projects: [], activeProjectId: null });
  assert.equal(defaultRow.active, true);
  assert.equal(defaultRow.count, null, "no count unless the caller supplies one");
});

test("an active id whose project is gone falls back to the default row", () => {
  // Fail-open like the switcher: a project deleted elsewhere must not leave every
  // row unmarked.
  const { defaultRow, projectRows } = buildProjectPickerRows({
    projects: [{ id: "p1", name: "Small improvement" }],
    activeProjectId: "p-deleted",
  });

  assert.equal(defaultRow.active, true, "the default row takes the mark");
  assert.equal(projectRows[0].active, false);
});

test("a picker names the default row for what it means there", () => {
  const { defaultRow } = buildProjectPickerRows({ defaultLabel: "No project" });
  assert.equal(defaultRow.label, "No project");
});

test("a nameless project falls back to its id rather than rendering blank", () => {
  const { projectRows } = buildProjectPickerRows({ projects: [{ id: "proj_00ff", name: "" }] });
  assert.equal(projectRows[0].label, "proj_00ff");
});

test("the filter matches anywhere in the name, ignoring case", () => {
  const rows = [{ label: "UI Redesign" }, { label: "Operation" }, { label: "RN" }, { label: "poker" }];
  assert.deepEqual(
    filterProjectRows(rows, "re").map((row) => row.label),
    ["UI Redesign"]
  );
  assert.deepEqual(
    filterProjectRows(rows, "R").map((row) => row.label),
    ["UI Redesign", "Operation", "RN", "poker"]
  );
  assert.equal(filterProjectRows(rows, "  "), rows, "a blank query filters nothing");
});

test("the relative-time formatter still uses the real clock when no clock is injected", () => {
  // Number(null) is 0, so a finiteness check made "no clock" mean the epoch and
  // every remote timestamp read as "now".
  const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(formatRelativeTime(anHourAgo), "1h");
  assert.equal(formatRelativeTime(anHourAgo, null), "1h");
  assert.equal(formatRelativeTime(1_000_000, 1_000_000 + 7200), "2h");
});
