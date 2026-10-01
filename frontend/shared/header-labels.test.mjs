import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { ALL_SESSIONS_LABEL, selectHeaderLabels } from "./header-labels.js";

// THE RULE THIS FILE ENCODES
//
// The header title used to be the THREAD you were viewing. That duplicated the
// session tab strip sitting directly beneath it — the same string twice, one
// above the other. The header now names the CONTAINER instead, so the two lines
// answer different questions: the header says "where am I", the tab says "which
// session".
//
// The title is now also the Project switcher's TRIGGER, which tightened the rule.
// It has to name something the switcher can switch to:
//   a project is selected -> that project, plus a New agent button, since that
//                            is the action belonging to a project
//   otherwise             -> "All sessions", no project pinned
//
// The working directory lost the title and kept the tooltip. It used to be the
// title in Sessions mode, but the switcher cannot select a directory, so a folder
// name there would have left the trigger's text disagreeing with the option marked
// active in its own menu.
//
// Neither collapses to empty — a blank title bar would just trade the
// duplication for a layout jump.

const CONVERSATION = {
  hasWorkspace: true,
  activeThreadId: "t-1",
  viewingConversation: true,
  threadLabel: "Dry run git rewrite",
  workspaceName: "agent-relay",
  workspacePath: "/Users/luchi/git/agent-relay",
};

// --- with a project selected ------------------------------------------------

test("a selected project names the title", () => {
  const { title } = selectHeaderLabels({
    ...CONVERSATION,
    projectId: "proj-1",
    projectName: "Alpha",
  });
  assert.equal(title, "Alpha");
});

test("no project selected is the default workspace", () => {
  const { title } = selectHeaderLabels({
    ...CONVERSATION,
    projectId: null,
    projectName: "",
  });
  assert.equal(title, ALL_SESSIONS_LABEL);
});

// --- with none selected -----------------------------------------------------

test("the default workspace keeps the folder as the tooltip", () => {
  const { title, titleTooltip } = selectHeaderLabels({
    ...CONVERSATION,
  });
  assert.equal(title, ALL_SESSIONS_LABEL);
  // The folder is not lost, it is demoted: the title has to name what the
  // switcher selects, and the full path was never readable at title size anyway.
  assert.equal(titleTooltip, "/Users/luchi/git/agent-relay");
});

// This used to assert the OPPOSITE — that a selected project must not leak into
// Sessions mode, because there sessions were grouped by folder and a project name would
// name the wrong container. Both modes are gone: a project is selected or it is not, and
// when it is, it is what the title names. Reading the old assertion as still-true would
// reintroduce a mode nothing can enter.
test("a project name with no id still titles the container it names", () => {
  const { title } = selectHeaderLabels({ ...CONVERSATION, projectId: null, projectName: "Alpha" });
  assert.equal(title, "Alpha", "the NAME is what the header shows");
});

// --- the thread label is gone from the title --------------------------------

test("the thread label never becomes the title (that is the tab's job)", () => {
  for (const projectName of ["", "Alpha"]) {
    const { title } = selectHeaderLabels({ ...CONVERSATION, projectName });
    assert.notEqual(title, "Dry run git rewrite");
  }
});

// --- fallbacks --------------------------------------------------------------

// "Relay console" is gone from the title. A product name is not a place, and this
// element is now a control you click to go somewhere — so it names a destination
// in every state, including the empty one.
test("with nothing selected the title is the default workspace, never a product name", () => {
  for (const args of [
    { hasWorkspace: true, activeThreadId: null },
    { ...CONVERSATION, viewingConversation: false, workspaceName: "" },
    {},
  ]) {
    assert.equal(selectHeaderLabels(args).title, ALL_SESSIONS_LABEL);
  }
});

// The trigger's text must match the option marked active in its own menu. That is
// only true if "no project selected" produces exactly one string, whatever else
// is going on.
test("every project-less state produces the SAME title", () => {
  const titles = new Set(
    [
      { hasWorkspace: true, activeThreadId: null },
      { ...CONVERSATION },
      { ...CONVERSATION, projectName: "" },
      { ...CONVERSATION, projectId: "p", projectName: "" },
    ].map((args) => selectHeaderLabels(args).title)
  );
  assert.deepEqual([...titles], [ALL_SESSIONS_LABEL]);
});

// --- subtitle rules (unchanged) ---------------------------------------------

test("read-only stays a warning, and does not repeat the title", () => {
  const { title, subtitle } = selectHeaderLabels({
    ...CONVERSATION,
    viewOnly: true,
  });
  assert.equal(title, ALL_SESSIONS_LABEL);
  assert.equal(subtitle, "", "a plain read-only session needs no header subtitle");
});

test("read-only + review in progress keeps its distinct wording", () => {
  const { subtitle } = selectHeaderLabels({
    ...CONVERSATION,
    viewOnly: true,
    reviewInProgress: true,
  });
  assert.equal(subtitle, "read-only · review in progress");
});

test("a live conversation has no subtitle", () => {
  assert.equal(selectHeaderLabels({ ...CONVERSATION }).subtitle, "");
});

test("console home names the running session in the subtitle, without 'live'", () => {
  const { title, subtitle } = selectHeaderLabels({
    hasWorkspace: true,
    activeThreadId: "t-9",
    viewingConversation: false,
    threadLabel: "background job",
  });
  assert.equal(title, ALL_SESSIONS_LABEL);
  assert.equal(subtitle, "session · background job");
  assert.ok(!subtitle.includes("live"));
});

test("standby / no-workspace subtitles are unchanged", () => {
  assert.equal(selectHeaderLabels({ hasWorkspace: true }).subtitle, "standby");
  assert.equal(selectHeaderLabels({ hasWorkspace: false }).subtitle, "no workspace selected");
});

// The header trigger and the option marked active in its own menu are the SAME
// claim rendered twice. They were briefly two constants holding equal strings
// under a comment asserting they could not drift — nothing compared them, so they
// could. This pins the single definition instead of re-checking equality.
test("the all-sessions label has exactly one definition in the tree", async () => {
  const { ALL_SESSIONS_LABEL: fromLabels } = await import("../shared/project-labels.js");
  assert.equal(ALL_SESSIONS_LABEL, fromLabels);

  // Walk the whole tree, not a hand-listed set of directories. The first version
  // listed frontend/shared, frontend/local and frontend — and NOT frontend/remote,
  // which is exactly where the next surface gets built. A guard that stops
  // covering the place the next copy will appear is worse than none, because it
  // reads as coverage.
  async function jsFilesUnder(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await jsFilesUnder(full)));
      } else if (/\.m?js$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  const seen = [];
  for (const file of await jsFilesUnder("frontend")) {
    const source = await readFile(file, "utf8");
    // An ASSIGNMENT of the string is a copy, whatever it is called and whichever
    // quote style it uses. Comparisons against it (tests, assertions) are fine.
    if (/=\s*(["'`])All sessions\1/.test(source)) {
      seen.push(file);
    }
  }
  assert.deepEqual(
    seen,
    ["frontend/shared/project-labels.js"],
    `the string is assigned in more than one module: ${seen.join(", ")}`
  );
});
