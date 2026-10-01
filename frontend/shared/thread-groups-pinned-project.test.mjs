// The Project switcher's grouping contract.
//
// Selecting a project does NOT filter the list. It lifts that project's sessions
// out of their cwd groups into a single group pinned to the top — and leaves
// everything else exactly where it was. The list therefore stays FULL in every
// mode, which is what makes the switcher safe: you can never lose a session by
// picking the wrong project.
//
// The load-bearing invariant is `assertEveryThreadAppearsExactlyOnce`. Grouping
// bugs here are silent — a duplicated row looks like a refresh glitch and a
// dropped row looks like the session was deleted — so the count is asserted
// directly rather than inferred from the shape of any one group.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadGroups,
  selectPinnedProjectId,
  summarizeThreadGroups,
  UNKNOWN_WORKSPACE_CWD,
} from "./thread-groups.js";

const PROJECTS = [
  { id: "proj_pay", name: "Payments rework" },
  { id: "proj_docs", name: "Docs" },
];

// Deliberately spread across three cwds, two projects and one unassigned bucket:
// every combination the switcher has to keep straight at once.
const THREADS = [
  { id: "t_hook", cwd: "/srv/payments", updated_at: 50 },
  { id: "t_form", cwd: "/srv/web", updated_at: 40 },
  { id: "t_e2e", cwd: "/srv/payments", updated_at: 30 },
  { id: "t_readme", cwd: "/srv/docs", updated_at: 90 },
  { id: "t_scroll", cwd: "/srv/relay", updated_at: 80 },
  { id: "t_stray", cwd: "/srv/payments", updated_at: 20 },
];

const MEMBERSHIP = {
  t_hook: "proj_pay",
  t_form: "proj_pay",
  t_e2e: "proj_pay",
  t_readme: "proj_docs",
  // t_scroll and t_stray belong to no project.
};

function pinned(pinnedProjectId, overrides = {}) {
  return buildThreadGroups(THREADS, {
    includeUnknownWorkspace: true,
    projects: PROJECTS,
    threadProjectId: MEMBERSHIP,
    pinnedProjectId,
    ...overrides,
  });
}

function idsIn(groups, key) {
  const group = groups.find((candidate) => candidate.key === key);
  return group ? group.threads.map((thread) => thread.id) : null;
}

// Pinning is the only mode that mixes project ids with cwd keys in one list, and
// `key` reaches React and the virtualizer's getItemKey. A duplicate would corrupt
// the list, not just mislabel a header — so uniqueness is asserted rather than
// left to the (currently airtight) disjointness of the two id spaces.
function assertGroupKeysAreUnique(groups) {
  const keys = groups.map((group) => group.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    `group keys must be unique across project and cwd groups, got: ${keys.join(", ")}`,
  );
}

function assertEveryThreadAppearsExactlyOnce(groups, expectedThreads) {
  const seen = groups.flatMap((group) => group.threads.map((thread) => thread.id));
  assert.equal(
    seen.length,
    expectedThreads.length,
    `expected ${expectedThreads.length} rows across all groups, saw ${seen.length}`,
  );
  assert.deepEqual(
    [...seen].sort(),
    expectedThreads.map((thread) => thread.id).sort(),
    "the grouped rows must be exactly the input threads — no drops, no duplicates",
  );
}

test("a pinned project merges its sessions across cwds into one group at the top", () => {
  const groups = pinned("proj_pay");

  assert.equal(groups[0].key, "proj_pay");
  assert.equal(groups[0].projectId, "proj_pay");
  assert.equal(groups[0].label, "Payments rework");
  // /srv/payments and /srv/web collapse into the one project group.
  assert.deepEqual(groups[0].threads.map((thread) => thread.id), ["t_hook", "t_form", "t_e2e"]);
});

test("a pinned project's sessions leave their cwd groups instead of appearing twice", () => {
  const groups = pinned("proj_pay");

  // t_stray is the only /srv/payments session left once the project takes its three.
  assert.deepEqual(idsIn(groups, "/srv/payments"), ["t_stray"]);
  // /srv/web held only t_form, so the group disappears rather than rendering empty.
  assert.equal(idsIn(groups, "/srv/web"), null);
});

test("every session appears exactly once, pinned or not", () => {
  assertEveryThreadAppearsExactlyOnce(pinned("proj_pay"), THREADS);
  assertEveryThreadAppearsExactlyOnce(pinned("proj_docs"), THREADS);
  assertEveryThreadAppearsExactlyOnce(pinned(null), THREADS);
});

test("sessions in OTHER projects stay in their cwd groups", () => {
  const groups = pinned("proj_pay");

  // t_readme is in proj_docs; pinning proj_pay must not lift it out of /srv/docs.
  assert.deepEqual(idsIn(groups, "/srv/docs"), ["t_readme"]);
  assert.equal(groups.some((group) => group.key === "proj_docs"), false);
});

test("sessions with no project stay in their cwd groups", () => {
  const groups = pinned("proj_pay");

  assert.deepEqual(idsIn(groups, "/srv/relay"), ["t_scroll"]);
  assert.deepEqual(idsIn(groups, "/srv/payments"), ["t_stray"]);
});

test("the pinned group leads even when a cwd group is more recent", () => {
  // /srv/docs (90) and /srv/relay (80) both beat the pinned project's newest (50).
  const groups = pinned("proj_pay");

  assert.equal(groups[0].key, "proj_pay");
  assert.deepEqual(
    groups.slice(1).map((group) => group.key),
    ["/srv/docs", "/srv/relay", "/srv/payments"],
    "the remaining cwd groups keep their normal recency order",
  );
});

test("an empty pinned project still renders its group, so the switcher never looks broken", () => {
  const groups = buildThreadGroups(THREADS, {
    includeUnknownWorkspace: true,
    projects: [...PROJECTS, { id: "proj_new", name: "Brand new" }],
    threadProjectId: MEMBERSHIP,
    pinnedProjectId: "proj_new",
  });

  assert.equal(groups[0].key, "proj_new");
  assert.deepEqual(groups[0].threads, []);
  assertEveryThreadAppearsExactlyOnce(groups, THREADS);
});

test("an unknown or deleted pinned project degrades to plain cwd grouping without losing a row", () => {
  // A project can be deleted from another device while it is the selected one.
  // Failing closed here would blank the list; it must fail OPEN to plain cwd.
  const groups = pinned("proj_deleted");

  assert.equal(groups.some((group) => group.projectId), false);
  assertEveryThreadAppearsExactlyOnce(groups, THREADS);
  assert.deepEqual(idsIn(groups, "/srv/payments"), ["t_hook", "t_e2e", "t_stray"]);
});

test("removing a session from the pinned project drops it back into its cwd group", () => {
  const { t_form: _removed, ...withoutForm } = MEMBERSHIP;
  const groups = pinned("proj_pay", { threadProjectId: withoutForm });

  assert.deepEqual(groups[0].threads.map((thread) => thread.id), ["t_hook", "t_e2e"]);
  assert.deepEqual(idsIn(groups, "/srv/web"), ["t_form"]);
  assertEveryThreadAppearsExactlyOnce(groups, THREADS);
});

test("a pinned session with no cwd joins the project group, not Unknown workspace", () => {
  const threads = [...THREADS, { id: "t_cwdless", cwd: "", updated_at: 60 }];
  const groups = buildThreadGroups(threads, {
    includeUnknownWorkspace: true,
    projects: PROJECTS,
    threadProjectId: { ...MEMBERSHIP, t_cwdless: "proj_pay" },
    pinnedProjectId: "proj_pay",
  });

  assert.ok(groups[0].threads.some((thread) => thread.id === "t_cwdless"));
  assert.equal(idsIn(groups, UNKNOWN_WORKSPACE_CWD), null);
  assertEveryThreadAppearsExactlyOnce(groups, threads);
});

test("an unpinned cwdless session still reaches Unknown workspace while a project is pinned", () => {
  const threads = [...THREADS, { id: "t_cwdless", cwd: "", updated_at: 60 }];
  const groups = buildThreadGroups(threads, {
    includeUnknownWorkspace: true,
    projects: PROJECTS,
    threadProjectId: MEMBERSHIP,
    pinnedProjectId: "proj_pay",
  });

  assert.deepEqual(idsIn(groups, UNKNOWN_WORKSPACE_CWD), ["t_cwdless"]);
  assertEveryThreadAppearsExactlyOnce(groups, threads);
});

test("threads inside the pinned group keep recency order", () => {
  const groups = pinned("proj_pay");

  const timestamps = groups[0].threads.map((thread) => thread.updated_at);
  assert.deepEqual(timestamps, [...timestamps].sort((left, right) => right - left));
});

// The count line sits directly under the list and is the only place that claims a
// total. A pinned project group is not a folder, so counting it as one would make
// the line disagree with what is on screen — the same class of "the summary lies
// about the list" bug the bell's pill counts already had to be careful about.
test("the count line does not call the pinned project a folder", () => {
  const groups = pinned("proj_pay");

  // /srv/docs, /srv/relay, /srv/payments — the project group is not among them.
  assert.equal(summarizeThreadGroups(groups), "3 folders · 6 sessions");
});

test("the count line still counts every session, including the pinned ones", () => {
  const groups = pinned("proj_pay");
  const rendered = groups.reduce((count, group) => count + group.threads.length, 0);

  assert.equal(rendered, THREADS.length);
  assert.ok(summarizeThreadGroups(groups).endsWith(`${THREADS.length} sessions`));
});

test("a lone folder beside a pinned project stays singular", () => {
  const groups = buildThreadGroups(
    [
      { id: "a", cwd: "/srv/payments", updated_at: 50 },
      { id: "b", cwd: "/srv/web", updated_at: 40 },
      { id: "c", cwd: "/srv/relay", updated_at: 30 },
    ],
    {
      includeUnknownWorkspace: true,
      projects: PROJECTS,
      threadProjectId: { a: "proj_pay", b: "proj_pay" },
      pinnedProjectId: "proj_pay",
    },
  );

  assert.equal(summarizeThreadGroups(groups), "1 folder · 3 sessions");
});

// `selectPinnedProjectId` is the "when to pin" policy. It is extracted from the
// renderer precisely because the tempting answer is wrong: the bell LOOKS like it
// narrows rows within groups (in which case a pin would compose with it) but it
// re-buckets the list by state, which destroys group structure outright.
test("the pin stands down while the bell is filtering", () => {
  assert.equal(selectPinnedProjectId({ activeProjectId: "proj_pay", filtering: true }), null);
});

test("the pin stands down while a search is open", () => {
  assert.equal(selectPinnedProjectId({ activeProjectId: "proj_pay", searching: true }), null);
});

test("the pin applies at rest", () => {
  assert.equal(selectPinnedProjectId({ activeProjectId: "proj_pay" }), "proj_pay");
});

test("no selection means no pin, and no arguments does not throw", () => {
  assert.equal(selectPinnedProjectId({ activeProjectId: null }), null);
  assert.equal(selectPinnedProjectId({}), null);
  assert.equal(selectPinnedProjectId(), null);
});

test("group keys stay unique when a project is pinned", () => {
  assertGroupKeysAreUnique(pinned("proj_pay"));
  assertGroupKeysAreUnique(pinned("proj_docs"));
  assertGroupKeysAreUnique(pinned("proj_deleted"));
  assertGroupKeysAreUnique(pinned(null));
});

// The honest limit of the assertion above: it cannot fail while project ids are
// server-generated `proj_<hex>`, because no such id can equal a path. This test
// exercises the case that DOES break it, so the failure mode is written down and
// reproducible rather than discovered as a corrupted list. If caller-chosen
// project ids are ever introduced, delete the `throws`-style expectation here and
// namespace the pinned group's key — do not simply relax the assertion.
test("a project id shaped like a cwd is the one input that would collide", () => {
  const collidingId = "/srv/payments";
  const groups = buildThreadGroups(THREADS, {
    includeUnknownWorkspace: true,
    projects: [{ id: collidingId, name: "Impostor" }],
    threadProjectId: { t_hook: collidingId },
    pinnedProjectId: collidingId,
  });

  const keys = groups.map((group) => group.key);
  assert.equal(
    new Set(keys).size,
    keys.length - 1,
    "documents the collision: two groups share the key '/srv/payments'. " +
      "Reachable only if project ids stop being server-generated proj_<hex>.",
  );
  // The rows themselves survive it — only the key space is corrupted.
  assertEveryThreadAppearsExactlyOnce(groups, THREADS);
});

test("pinnedProjectId is inert without it, so today's callers are unaffected", () => {
  const withoutPin = buildThreadGroups(THREADS, {
    includeUnknownWorkspace: true,
    projects: PROJECTS,
    threadProjectId: MEMBERSHIP,
  });

  assert.equal(withoutPin.some((group) => group.projectId), false);
  assert.deepEqual(idsIn(withoutPin, "/srv/payments"), ["t_hook", "t_e2e", "t_stray"]);
  assertEveryThreadAppearsExactlyOnce(withoutPin, THREADS);
});

// The list holds only the most recent sessions, so the rows can say "empty" about a
// project that still has members. Deleting it on that word would drop them for good.
test("a pinned project counts its members from the full membership, not the loaded rows", () => {
  const groups = pinned("proj_docs", {
    threadProjectId: { ...MEMBERSHIP, t_old_1: "proj_docs", t_old_2: "proj_docs" },
  });
  const group = groups.find((candidate) => candidate.key === "proj_docs");
  assert.equal(group.threads.length, 1, "one member is loaded");
  assert.equal(group.memberCount, 3, "three are members");

  const unloaded = pinned("proj_docs", {
    threadProjectId: { t_old_1: "proj_docs" },
  });
  const empty = unloaded.find((candidate) => candidate.key === "proj_docs");
  assert.equal(empty.threads.length, 0);
  assert.equal(empty.memberCount, 1, "no row on screen is not the same as no member");
});
