import test from "node:test";
import assert from "node:assert/strict";

import { selectThreadDot, selectThreadState } from "./thread-dot.js";
import {
  EMPTY_THREAD_FILTER,
  buildThreadStateGroups,
  composeListChrome,
  isThreadFilterActive,
  nextRetainedStates,
  selectThreadFilterView,
} from "./thread-filter.js";

// Two cwd groups, the shape the sidebar normally renders.
const GROUPS = [
  {
    key: "/repos/relay",
    cwd: "/repos/relay",
    label: "relay",
    threads: [
      { id: "needs", updated_at: 5 },
      { id: "work", updated_at: 4 },
      { id: "idle", updated_at: 3 },
    ],
  },
  {
    key: "/repos/web",
    cwd: "/repos/web",
    label: "web",
    threads: [
      { id: "review", updated_at: 2 },
      { id: "done", updated_at: 1 },
    ],
  },
];

const STATE_BY_ID = {
  needs: "needs_input",
  work: "working",
  review: "reviewing",
  done: "completed",
  idle: null,
};
const stateOf = (thread) => STATE_BY_ID[thread.id] ?? null;

const ON = { ...EMPTY_THREAD_FILTER, on: true };

test("off → the list passes straight through", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: EMPTY_THREAD_FILTER, stateOf });
  assert.equal(view.filtering, false);
  assert.equal(view.groups, GROUPS);
  assert.equal(isThreadFilterActive(EMPTY_THREAD_FILTER), false);
});

// The bell is "everything that is not idle" — not a four-way choice. This is what keeps
// a thread from vanishing when it moves between states while you watch.
test("on → everything except idle, bucketed by state", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf });
  assert.equal(view.filtering, true);
  assert.deepEqual(
    view.groups.map((g) => g.label),
    ["Needs input", "Working", "Reviewing", "Done"]
  );
  assert.deepEqual(view.groups.flatMap((g) => g.threads.map((t) => t.id)), [
    "needs",
    "work",
    "review",
    "done",
  ]);
  assert.equal(view.countLabel, "4 sessions");
});

// Ladder order IS urgency order. Sorting buckets by recency instead would move the
// first bucket around and the list would stop being scannable at a glance.
test("buckets keep ladder order regardless of recency", () => {
  const reversed = [
    { key: "x", cwd: "x", label: "x", threads: [{ id: "done", updated_at: 999 }, { id: "needs", updated_at: 1 }] },
  ];
  const view = selectThreadFilterView({ groups: reversed, filter: ON, stateOf });
  assert.deepEqual(view.groups.map((g) => g.state), ["needs_input", "completed"]);
});

// follow_up is a fifth bucket, reached only for a flagged-but-otherwise-idle thread.
// It sorts LAST — lowest urgency, since flagging something is "not urgent, don't lose
// it" rather than "look at this now".
test("a flagged thread gets its own bucket, after Done", () => {
  const flaggedGroups = [
    {
      key: "x",
      cwd: "x",
      label: "x",
      threads: [
        { id: "done", updated_at: 2 },
        { id: "flagged", updated_at: 1 },
      ],
    },
  ];
  const flaggedStateOf = (thread) => (thread.id === "flagged" ? "follow_up" : "completed");
  const view = selectThreadFilterView({ groups: flaggedGroups, filter: ON, stateOf: flaggedStateOf });
  assert.deepEqual(view.groups.map((g) => g.state), ["completed", "follow_up"]);
  assert.deepEqual(view.groups.map((g) => g.label), ["Done", "Follow up"]);
});

// The bell is ON or OFF. There is no per-state selection to be in: a pill row above the
// list would only restate the bucket headers under it. A `states` field left on a filter
// by a stale caller must therefore narrow NOTHING — silently honouring it would hide
// sessions with no control on screen saying why.
test("the bell has no per-state selection: a stray `states` field narrows nothing", () => {
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, states: ["needs_input"] },
    stateOf,
  });
  assert.deepEqual(view.groups.map((g) => g.state), [
    "needs_input",
    "working",
    "reviewing",
    "completed",
  ]);
  assert.equal(view.countLabel, "4 sessions");
});

// The pills carried per-state counts; nothing else ever consumed them, so the view stops
// computing a number no surface renders.
test("the view exposes no per-state counts", () => {
  assert.equal(selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf }).counts, undefined);
});

test("an idle thread is never bucketed", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf });
  assert.ok(!view.groups.some((g) => g.threads.some((t) => t.id === "idle")));
});

// State buckets are not directories. `ThreadGroupHeader` only makes a header clickable
// when it carries a real cwd, so an empty cwd is what stops "state:needs_input" being
// written into the workspace input and sent to the relay as a path.
test("state buckets carry no cwd, so their headers stay inert", () => {
  const view = selectThreadFilterView({ groups: GROUPS, filter: ON, stateOf });
  for (const group of view.groups) {
    assert.equal(group.cwd, "");
    assert.match(group.key, /^state:/);
  }
});

// The retention rule: a row must not disappear from under the pointer because the
// agent answered while you were reaching for it.
test("a thread that has matched stays listed after its state moves on", () => {
  const sticky = nextRetainedStates(null, GROUPS, ON, stateOf);
  assert.deepEqual(
    sticky,
    new Map([
      ["needs", "needs_input"],
      ["work", "working"],
      ["review", "reviewing"],
      ["done", "completed"],
    ]),
    "every non-idle row is retained: the bell has no selection to gate admission on"
  );

  // The user answers it: needs_input → working. It must still be on screen.
  const answered = (thread) => (thread.id === "needs" ? "working" : stateOf(thread));
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, retained: sticky },
    stateOf: answered,
  });
  assert.ok(
    view.groups.flatMap((g) => g.threads.map((t) => t.id)).includes("needs"),
    "a row must not vanish because its state changed while the filter was open"
  );
  // ...and it is shown under its NEW state, not frozen in the old bucket.
  assert.equal(view.groups.find((g) => g.threads.some((t) => t.id === "needs")).state, "working");
});

test("new matches join a live filter immediately", () => {
  const first = nextRetainedStates(null, GROUPS, ON, stateOf);
  assert.ok(!first.has("idle"), "an idle row has no state, so it is not retained");
  const promoted = (thread) => (thread.id === "idle" ? "working" : stateOf(thread));
  const second = nextRetainedStates(first, GROUPS, ON, promoted);
  assert.equal(second.get("idle"), "working");
});

test("retention never resurrects a thread that never matched", () => {
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, retained: new Map([["idle", null]]) },
    stateOf,
  });
  assert.ok(!view.groups.some((g) => g.threads.some((t) => t.id === "idle")));
});

// The gap the retention rule left open. A thread that finishes while you are LOOKING
// at it gets no `completed` badge at all (thread-attention.js drops the badge for the
// viewed foreground thread), so it goes working → stateless. Dropping stateless rows
// meant the row still vanished from under the pointer — exactly what retention exists
// to prevent, in the one case the user is most likely to be watching.
test("a retained thread that goes fully idle keeps its last bucket", () => {
  const retained = nextRetainedStates(null, GROUPS, ON, stateOf);
  assert.equal(retained.get("work"), "working");

  const wentIdle = (thread) => (thread.id === "work" ? null : stateOf(thread));
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, retained },
    stateOf: wentIdle,
  });
  const shown = view.groups.flatMap((g) => g.threads.map((t) => t.id));
  assert.ok(shown.includes("work"), "a row must not vanish just because it went idle");
  assert.equal(
    view.groups.find((g) => g.threads.some((t) => t.id === "work")).state,
    "working",
    "with no live state left, it stays in the bucket it was last seen in"
  );
});

// The two steps above pass individually and still hide this: a row that changes bucket
// renders correctly for as long as it has a live state — and then snaps back to a bucket
// it left long ago the moment it goes stateless, unless the memory is refreshed on EVERY
// pass. Answering a thread and letting it finish used to file it back under "Needs
// input" with no dot at all.
test("a retained row remembers where it ACTUALLY was last, not where it joined", () => {
  let retained = nextRetainedStates(null, GROUPS, ON, stateOf);
  assert.equal(retained.get("needs"), "needs_input");

  // 1. It moves to another bucket.
  const working = (thread) => (thread.id === "needs" ? "working" : stateOf(thread));
  retained = nextRetainedStates(retained, GROUPS, ON, working);
  assert.equal(
    retained.get("needs"),
    "working",
    "a retained row refreshes on any live state, so the memory is never stale"
  );
  assert.equal(
    selectThreadFilterView({ groups: GROUPS, filter: { ...ON, retained }, stateOf: working })
      .groups.find((g) => g.threads.some((t) => t.id === "needs")).state,
    "working"
  );

  // 2. Then it loses its state entirely.
  const gone = (thread) => (thread.id === "needs" ? null : stateOf(thread));
  retained = nextRetainedStates(retained, GROUPS, ON, gone);
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, retained },
    stateOf: gone,
  });
  assert.equal(
    view.groups.find((g) => g.threads.some((t) => t.id === "needs")).state,
    "working",
    "a stateless row must rest in the last bucket it was really in"
  );
});

// Thread ids are arbitrary strings on the wire — `ThreadSummaryView.id` is a bare
// `String` and no parser constrains it to a UUID — so the retention store must not be a
// plain object. On one, `map["toString"]` is a function, which hands
// `buildThreadStateGroups` a function where a state key belongs. `"__proto__"` is worse
// still: assigning it is silently dropped, so such a row could never be retained at all.
test("ids that collide with Object.prototype are not special", () => {
  const hostile = [
    {
      key: "/repos/x",
      cwd: "/repos/x",
      label: "x",
      threads: [{ id: "constructor" }, { id: "toString" }, { id: "__proto__" }],
    },
  ];
  const allWorking = () => "working";

  const kept = nextRetainedStates(undefined, hostile, ON, allWorking);
  for (const id of ["constructor", "toString", "__proto__"]) {
    assert.equal(kept.get(id), "working", `${id} must be retained like any other id`);
  }

  // And once retained, they must re-read like any other id when the state goes away.
  const goneIdle = () => null;
  const view = selectThreadFilterView({
    groups: hostile,
    filter: { ...ON, retained: kept },
    stateOf: goneIdle,
  });
  assert.deepEqual(
    view.groups.flatMap((g) => g.threads.map((t) => t.id)).sort(),
    ["__proto__", "constructor", "toString"],
    "a retained row with an awkward id keeps its bucket like any other"
  );
  assert.deepEqual(view.groups.map((g) => g.state), ["working"]);
});

// The identity contract. Remote accumulates retention in an effect, so it needs a cheap
// "did anything change?" test to avoid writing to its store on every render. Comparing
// `size` is NOT that test: a row moving between states changes only a VALUE, so a
// size-guarded write silently drops it and the row snaps back to its old bucket the
// moment it goes stateless. Returning the SAME instance when nothing changed makes `!==`
// the correct guard and keeps that decision here, where it can be tested.
test("an unchanged pass returns the very same Map", () => {
  const first = nextRetainedStates(null, GROUPS, ON, stateOf);
  const second = nextRetainedStates(first, GROUPS, ON, stateOf);
  assert.equal(second, first, "no change must not produce a new instance");
});

test("a VALUE-only change still produces a new Map", () => {
  const first = nextRetainedStates(null, GROUPS, ON, stateOf);
  const moved = (thread) => (thread.id === "needs" ? "working" : stateOf(thread));
  const second = nextRetainedStates(first, GROUPS, ON, moved);
  assert.notEqual(second, first, "a size-preserving change must still be observable");
  assert.equal(second.size, first.size, "precondition: size alone cannot detect this");
  assert.equal(second.get("needs"), "working");
});

test("turning the filter off keeps an already-empty map's identity", () => {
  const empty = nextRetainedStates(null, GROUPS, EMPTY_THREAD_FILTER, stateOf);
  assert.equal(nextRetainedStates(empty, GROUPS, EMPTY_THREAD_FILTER, stateOf), empty);
});

test("a live state always wins over the remembered one", () => {
  const promoted = (thread) => (thread.id === "work" ? "needs_input" : stateOf(thread));
  const view = selectThreadFilterView({
    groups: GROUPS,
    filter: { ...ON, retained: new Map([["work", "working"]]) },
    stateOf: promoted,
  });
  assert.equal(
    view.groups.find((g) => g.threads.some((t) => t.id === "work")).state,
    "needs_input"
  );
});

test("turning the filter off clears retention", () => {
  assert.deepEqual(
    nextRetainedStates(new Map([["needs", "needs_input"]]), GROUPS, EMPTY_THREAD_FILTER, stateOf),
    new Map()
  );
});

// The bell's buckets and the row's dot read the same session; if they could disagree,
// a row with an amber dot could land under "Working".
test("every bucket agrees with the dot the row renders", () => {
  const cases = [
    { activity: null, attentionKind: "needs_input", reviewing: false },
    { activity: { tool: "bash" }, attentionKind: null, reviewing: false },
    { activity: null, attentionKind: null, reviewing: true },
    { activity: null, attentionKind: "completed", reviewing: false },
    { activity: null, attentionKind: null, reviewing: false },
  ];
  for (const input of cases) {
    const state = selectThreadState(input);
    const dot = selectThreadDot(input);
    assert.equal(Boolean(state), Boolean(dot), `dot/bucket disagree for ${JSON.stringify(input)}`);
  }
  // And the ladder's precedence is the dot's precedence.
  assert.equal(
    selectThreadState({ activity: { tool: "bash" }, attentionKind: "needs_input" }),
    "needs_input"
  );
  assert.equal(selectThreadState({ activity: { tool: "bash" }, reviewing: true }), "working");
  assert.equal(selectThreadState({ reviewing: true, attentionKind: "completed" }), "reviewing");
});

// One empty message, because there is one thing the bell can mean. It used to have to
// distinguish "nothing going on" from "nothing in the states you picked"; with the pills
// gone, the second sentence has no situation left to describe.
test("empty copy says nothing is going on", () => {
  const all = selectThreadFilterView({ groups: [], filter: ON, stateOf });
  assert.match(all.emptyMessage, /Nothing is running/);
});

test("buildThreadStateGroups tolerates missing threads arrays", () => {
  assert.deepEqual(buildThreadStateGroups([{ key: "a", cwd: "a" }], { stateOf }), []);
  assert.deepEqual(buildThreadStateGroups(null, { stateOf }), []);
});

// --- the count line, where the search's status and the bell's narrowing meet ---------

const listOk = { status: "ok", countLabel: "3 results", emptyMessage: "No sessions match “x”." };
const listPartial = {
  status: "partial",
  countLabel: "2 results · partial",
  emptyMessage: "Couldn’t search codex. Some sessions may be missing.",
};
const filterOff = { filtering: false };
const filtered = (n) => ({
  filtering: true,
  countLabel: n === 1 ? "1 session" : `${n} sessions`,
  emptyMessage: "Nothing is running or waiting on you.",
});

test("with the bell off, the search speaks for itself", () => {
  assert.deepEqual(composeListChrome(listOk, filterOff), {
    countLabel: "3 results",
    emptyMessage: "No sessions match “x”.",
  });
});

test("with the bell on and nothing wrong, the count describes the filtered rows", () => {
  assert.equal(composeListChrome(listOk, filtered(1)).countLabel, "1 session");
});

// The contradiction this exists to stop: the rendered groups are the BELL's, so a count
// borrowed wholesale from the search claims rows that are not on screen — "2 results ·
// partial" over an empty list. The warning has to survive; the number has to be true.
test("partial + bell: the count follows the visible rows, the warning survives", () => {
  const chrome = composeListChrome(listPartial, filtered(0));
  assert.equal(chrome.countLabel, "0 sessions · partial");
  assert.match(chrome.emptyMessage, /Couldn’t search codex/);

  const some = composeListChrome(listPartial, filtered(1));
  assert.equal(some.countLabel, "1 session · partial");
});

// Loading and error are different: the rows on screen are stale or absent, so a count of
// them would be a count of nothing. The search's own words are the honest ones.
test("loading and error keep the search's own label even with the bell on", () => {
  const loading = { status: "loading", countLabel: "Searching…", emptyMessage: "Searching…" };
  assert.equal(composeListChrome(loading, filtered(0)).countLabel, "Searching…");
  const failed = {
    status: "error",
    countLabel: "Search failed",
    emptyMessage: "Search failed: relay offline",
  };
  assert.equal(composeListChrome(failed, filtered(0)).countLabel, "Search failed");
  assert.match(composeListChrome(failed, filtered(0)).emptyMessage, /relay offline/);
});
