import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadSheetSections,
  selectThreadSheet,
  threadSheetHasActions,
} from "./thread-actions-model.js";

const READY = { projectsLoaded: true, projectsError: null, projectsLoading: false };
const projects = [
  { id: "p2", name: "Beta" },
  { id: "p1", name: "Alpha" },
];

const kinds = (sections) => sections.map((section) => section.kind);
const items = (sections, kind) => sections.find((section) => section.kind === kind)?.items || [];
const labels = (sections, kind) => items(sections, kind).map((item) => item.label);

test("an idle session in a fresh projects payload offers both sections", () => {
  const sections = buildThreadSheetSections({ projects, ...READY });
  assert.deepEqual(kinds(sections), ["session", "projects"]);
  assert.deepEqual(labels(sections, "session"), [
    "Fork session",
    "Rename session\u2026",
    "Flag for follow-up",
  ]);
});

// Rename passes the transport rule that excludes archive/delete: it HAS a broker action
// (`rename_thread`). It is also never disabled — a rename is relay-side metadata that
// takes no session claim, so unlike fork it stays usable while the session is mid-turn.
test("rename is offered, and stays enabled on a running session", () => {
  for (const forkBlocked of [false, true]) {
    const rename = items(buildThreadSheetSections({ forkBlocked, projects, ...READY }), "session")
      .find((item) => item.kind === "rename");
    assert.ok(rename, `rename must be offered (forkBlocked=${forkBlocked})`);
    assert.notEqual(rename.disabled, true, "renaming never waits for a turn to finish");
  }
});

// "Use the agent's name" removes an override. Offering it on a session that never had
// one is a control that provably does nothing — and `name` cannot be used to decide,
// because the agent titles nearly every session.
test("the reset entry appears only for a session that actually carries an override", () => {
  const withOverride = labels(buildThreadSheetSections({ renamed: true, projects, ...READY }), "session");
  assert.deepEqual(withOverride, [
    "Fork session",
    "Rename session\u2026",
    "Flag for follow-up",
    "Use the agent's name",
  ]);

  const withoutOverride = labels(buildThreadSheetSections({ projects, ...READY }), "session");
  assert.ok(!withoutOverride.includes("Use the agent's name"));
});

// Flag passes the same transport rule rename does (`set_thread_flag` has a real broker
// action) and is never disabled, for the same reason rename isn't.
test("flag is offered right after rename, with copy that reflects the current state", () => {
  const unflagged = items(buildThreadSheetSections({ projects, ...READY }), "session").find(
    (item) => item.kind === "flag"
  );
  assert.equal(unflagged.label, "Flag for follow-up");
  assert.notEqual(unflagged.disabled, true);

  const flagged = items(buildThreadSheetSections({ flagged: true, projects, ...READY }), "session").find(
    (item) => item.kind === "flag"
  );
  assert.equal(flagged.label, "Unflag");
});

test("the reset entry is driven by the relay's flag, not the displayed title", () => {
  const agentTitled = selectThreadSheet({
    threadId: "t1",
    threads: [{ id: "t1", status: "completed", name: "Fix the auth bug" }],
    session,
    projects,
    ...READY,
  });
  assert.ok(
    !labels(agentTitled.sections, "session").includes("Use the agent's name"),
    "an agent-supplied name is not an override"
  );

  const userTitled = selectThreadSheet({
    threadId: "t1",
    threads: [{ id: "t1", status: "completed", name: "Auth work", renamed: true }],
    session,
    projects,
    ...READY,
  });
  assert.ok(labels(userTitled.sections, "session").includes("Use the agent's name"));
});

// A running session keeps the entry, DISABLED and saying why — the same thing local's
// menu does. Hiding it would make the row's actions change shape as a turn starts and
// ends, and leave the user wondering where fork went.
test("a busy session still shows fork, disabled, with local's wording", () => {
  const sections = buildThreadSheetSections({ forkBlocked: true, projects, ...READY });
  const fork = items(sections, "session")[0];
  assert.equal(fork.label, "Running session cannot be forked");
  assert.equal(fork.disabled, true);
  assert.equal(fork.kind, "fork");
});

test("an idle session's fork entry is enabled", () => {
  const fork = items(buildThreadSheetSections({ projects, ...READY }), "session")[0];
  assert.equal(fork.disabled, false);
});

// Projects ARE supported on remote — they are just not loaded yet. Saying so beats an
// empty gap where the section will later appear.
// The full state matrix the real store can produce, because getting this wrong shows
// the user "loading…" for something that already failed and will never arrive.
// createProjectsStore leaves `loaded:false` when the FIRST fetch throws (it only
// latches `loaded` on success), so a first-load failure is
// {loaded:false, loading:false, error} — not the {loaded:true, error} of a later
// refresh failure.
for (const [name, state, expected] of [
  ["never fetched", { projectsLoaded: false, projectsLoading: false, projectsError: null }, "Projects are loading…"],
  ["first fetch in flight", { projectsLoaded: false, projectsLoading: true, projectsError: null }, "Projects are loading…"],
  ["first fetch FAILED", { projectsLoaded: false, projectsLoading: false, projectsError: "boom" }, "Projects unavailable"],
  ["retrying after a failure", { projectsLoaded: false, projectsLoading: true, projectsError: "boom" }, "Projects unavailable"],
  ["refresh failed after a success", { projectsLoaded: true, projectsLoading: false, projectsError: "boom" }, "Projects unavailable"],
  ["refreshing after a success", { projectsLoaded: true, projectsLoading: true, projectsError: null }, "Projects are loading…"],
]) {
  test(`projects state — ${name} — reads "${expected}"`, () => {
    const sections = buildThreadSheetSections({ projects, ...state });
    assert.deepEqual(labels(sections, "projects"), [expected]);
    assert.equal(items(sections, "projects")[0].disabled, true);
  });
}

test("an assigned session can be moved, removed, or filed under a new project", () => {
  const sections = buildThreadSheetSections({ projects, currentProjectId: "p1", ...READY });
  assert.deepEqual(labels(sections, "projects"), [
    "Alpha",
    "Beta",
    "Remove from project",
    "New project…",
  ]);
});

test("an unassigned session is offered no 'remove from project'", () => {
  assert.deepEqual(labels(buildThreadSheetSections({ projects, ...READY }), "projects"), [
    "Alpha",
    "Beta",
    "New project…",
  ]);
});

// Archive and delete reach the relay over HTTP routes the broker has no action for.
// Listing them would render buttons that cannot fire.
test("no action is offered for a transport remote does not have", () => {
  const text = JSON.stringify(buildThreadSheetSections({ projects, ...READY }));
  assert.doesNotMatch(text, /archive/i);
  assert.doesNotMatch(text, /delete/i);
});

// --- selectThreadSheet: resolving which session the sheet is for -----------------

const session = { active_thread_id: "live-1", active_turn_id: null };
const threads = [{ id: "t1", status: "completed" }];

test("a session in the list resolves and gets a sheet", () => {
  const view = selectThreadSheet({ threadId: "t1", threads, session, projects, ...READY });
  assert.equal(view.thread.id, "t1");
  assert.equal(view.hasActions, true);
});

// The render model INJECTS the active session as a row when history has not loaded or
// pagination left it out (view-model.js). That row is real and tappable, so resolving
// only from the fetched list left its "⋯" dead while its right-click still worked —
// the fork path already resolved through this fallback.
test("the injected active session resolves even when the thread list omits it", () => {
  const view = selectThreadSheet({
    threadId: "live-1",
    threads: [],
    session: { active_thread_id: "live-1", active_turn_id: null, current_status: "idle" },
    projects,
    ...READY,
  });
  assert.ok(view.thread, "the active session must resolve without a list entry");
  assert.equal(view.thread.id, "live-1");
  assert.equal(view.hasActions, true, "its sheet must open like any other row's");
});

test("a live session mid-turn resolves, and its fork entry is the disabled one", () => {
  const view = selectThreadSheet({
    threadId: "live-1",
    threads: [],
    session: { active_thread_id: "live-1", active_turn_id: "turn-9" },
    projects,
    ...READY,
  });
  assert.equal(items(view.sections, "session")[0].disabled, true);
  assert.equal(view.hasActions, true, "a busy session still has a sheet worth opening");
});

// The invariant that removes the dead-tap and the belated-open at the root: as long as
// the session resolves, there is always something to show.
test("a resolved session always has actions, whatever the projects payload is doing", () => {
  for (const projectsState of [
    READY,
    { projectsLoaded: false, projectsLoading: true, projectsError: null },
    { projectsLoaded: true, projectsLoading: false, projectsError: "boom" },
  ]) {
    for (const busy of [{ active_turn_id: null }, { active_turn_id: "turn-9" }]) {
      const view = selectThreadSheet({
        threadId: "live-1",
        threads: [],
        session: { active_thread_id: "live-1", ...busy },
        projects,
        ...projectsState,
      });
      assert.equal(
        view.hasActions,
        true,
        `expected actions for ${JSON.stringify({ projectsState, busy })}`
      );
    }
  }
});

test("a thread that resolves to nothing yields no sheet", () => {
  const view = selectThreadSheet({ threadId: "ghost", threads, session, projects, ...READY });
  assert.equal(view.thread, null);
  assert.deepEqual(view.sections, []);
  assert.equal(view.hasActions, false);
});

test("no thread id yields no sheet", () => {
  const view = selectThreadSheet({ threadId: "", threads, session, projects, ...READY });
  assert.equal(view.hasActions, false);
});

test("membership is read for the resolved thread", () => {
  const view = selectThreadSheet({
    threadId: "t1",
    threads,
    session,
    projects,
    threadProjectId: { t1: "p2" },
    ...READY,
  });
  const current = items(view.sections, "projects").filter((item) => item.isCurrent);
  assert.deepEqual(current.map((item) => item.label), ["Beta"]);
});

test("threadSheetHasActions is false only when every section is empty", () => {
  assert.equal(threadSheetHasActions([]), false);
  assert.equal(threadSheetHasActions([{ kind: "projects", items: [] }]), false);
  assert.equal(threadSheetHasActions(null), false);
  assert.equal(threadSheetHasActions([{ kind: "session", items: [{ kind: "fork" }] }]), true);
});
