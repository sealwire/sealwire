import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskTeamScreen } from "./task-team-react.js";

const h = React.createElement;

function run(overrides = {}) {
  return {
    team_run_id: "team-1",
    title: "Add a parser",
    status: "running",
    phase: "sub_tasks",
    cwd: "/tmp/wt",
    branch: "task/add-a-parser",
    target_ref: "refs/heads/main",
    tl_thread_id: "tl-1",
    sub_tasks: [],
    awaiting: null,
    unresolved: [],
    updated_at: 1000,
    ...overrides,
  };
}

function screen(props = {}) {
  return renderToStaticMarkup(
    h(TaskTeamScreen, { runs: [run()], seenAt: {}, viewMode: "board", ...props })
  );
}

/**
 * What the toolbar READS AS. Asserting on markup hides exactly the defect this
 * file is about: `Today <strong>Today 42%</strong>` has no "Today Today"
 * substring, but that is what is on the screen.
 */
function toolbarText(props = {}) {
  const markup = screen(props);
  const header = markup.slice(markup.indexOf("<header"), markup.indexOf("</header>"));
  return header
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// `teamListGroupId` files everything non-terminal and non-queued under
// `in_progress`, which includes the two statuses that hold the worktree with no
// driver. Counting the bucket therefore reports stopped work as running.
test("the running count excludes tasks that have no driver", () => {
  const text = toolbarText({
    runs: [
      run({ team_run_id: "a", status: "running" }),
      run({ team_run_id: "b", status: "paused", pause_reason: "Daily budget spent" }),
      run({ team_run_id: "c", status: "resolving" }),
    ],
  });
  assert.match(text, /1 running/);
  assert.doesNotMatch(text, /3 running/);
});

test("a task finishing its current step before pausing still counts as running", () => {
  assert.match(toolbarText({ runs: [run({ status: "pause_pending" })] }), /1 running/);
});

// `todayLabel` is a COMPLETE label everywhere else it is consumed (TaskDetail
// renders it as ` · ${todayLabel}`), so prefixing it here doubles the word.
test("a supplied daily-spend label is rendered whole, not prefixed again", () => {
  const text = toolbarText({ capacity: { todayLabel: "Today 42%" } });
  assert.match(text, /Today 42%/);
  assert.doesNotMatch(text, /Today Today/);
});

test("with no capacity the daily spend is a labelled empty slot", () => {
  assert.match(screen(), /title="Today&#x27;s spend is not reported yet"/);
  assert.match(toolbarText(), /Today —/);
});

test("both modes draw the toolbar; only board mode draws the board", () => {
  const asBoard = screen();
  assert.match(asBoard, /task-surface-toolbar/);
  assert.doesNotMatch(asBoard, /task-workspace-orch/);

  const asList = screen({ viewMode: "list" });
  assert.match(asList, /task-surface-toolbar/);
  assert.match(asList, /task-workspace-orch/);
});

test("the mode buttons report which one is current", () => {
  const markup = screen({ viewMode: "board" });
  assert.match(markup, /aria-selected="true"[^>]*>Board</);
  assert.match(markup, /aria-selected="false"[^>]*>List</);
});

// `teamRunIsWorking` is true for a parked question — its turn is still open —
// but that run is in Needs you, not In progress, and nothing is advancing.
test("a task parked on a question is not counted as running", () => {
  const text = toolbarText({
    runs: [
      run({ team_run_id: "a", status: "running" }),
      run({
        team_run_id: "b",
        status: "awaiting_user",
        awaiting: { role: "tl", thread_id: "t", asked_at: 900 },
      }),
    ],
  });
  assert.match(text, /1 running/);
});
