import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeSessionViewContext } from "./session-view-state.js";
import { openTicketDestination } from "./nav-destinations.js";
import { TaskTeamScreen } from "./task-team-react.js";

const h = React.createElement;

function run(overrides = {}) {
  return {
    team_run_id: "team-1",
    title: "Add a parser",
    status: "running",
    phase: "sub_tasks",
    branch: "task/add-a-parser",
    tl_thread_id: "tl-1",
    sub_tasks: [],
    awaiting: null,
    unresolved: [],
    updated_at: 1000,
    ...overrides,
  };
}

test("a ticket context survives normalisation and keeps its run", () => {
  assert.deepEqual(
    normalizeSessionViewContext({ kind: "ticket", teamRunId: "team-9" }),
    { kind: "ticket", teamRunId: "team-9" }
  );
});

// Same rule the review screen has: this screen is about ONE run, so an id-less
// entry from a truncated history must not land on a blank page.
test("a ticket context with no run falls back to the task list", () => {
  assert.deepEqual(
    normalizeSessionViewContext({ kind: "ticket", teamRunId: null }),
    { kind: "tasks", teamRunId: null }
  );
});

test("the destination asks the controller for the ticket context", () => {
  const calls = [];
  openTicketDestination({ showOverview: (context) => calls.push(context) }, "team-3");
  assert.deepEqual(calls, [{ kind: "ticket", teamRunId: "team-3" }]);
});

// Board mode has no detail pane. Before the ticket route existed, a card click
// could only drop back to List; now it must open the run's own page instead.
test("a board card opens the ticket page when that route exists", () => {
  const opened = [];
  const modes = [];
  const props = {
    runs: [run()],
    seenAt: {},
    viewMode: "board",
    onChangeViewMode: (mode) => modes.push(mode),
    onOpenTask: (id) => opened.push(["task", id]),
    onOpenTicket: (id) => opened.push(["ticket", id]),
  };
  const board = captureBoardProps(props);
  board.onOpenTask("team-1");
  assert.deepEqual(opened, [["ticket", "team-1"]]);
  assert.deepEqual(modes, []);
});

test("without a ticket route the card still lands somewhere that renders", () => {
  const opened = [];
  const modes = [];
  const board = captureBoardProps({
    runs: [run()],
    seenAt: {},
    viewMode: "board",
    onChangeViewMode: (mode) => modes.push(mode),
    onOpenTask: (id) => opened.push(["task", id]),
    onOpenTicket: null,
  });
  board.onOpenTask("team-1");
  assert.deepEqual(opened, [["task", "team-1"]]);
  assert.deepEqual(modes, ["list"]);
});

/**
 * Call the screen and find the props it hands the board.
 *
 * Walks the returned element tree rather than intercepting `createElement`:
 * `task-team-react.js` binds `const h = React.createElement` at module load, so
 * a later patch of that export is never seen.
 *
 * The board is a private module stubbed to an empty Fragment in this checkout,
 * so its markup proves nothing. What is public — and what these tests are about
 * — is the wiring handed across the seam.
 */
function captureBoardProps(props) {
  const seen = [];
  walk(TaskTeamScreen(props), seen);
  const board = seen.find(
    (node) => typeof node.type === "function" && node.props && "onOpenTask" in node.props
  );
  assert.ok(board, "the screen never rendered a board");
  return board.props;
}

function walk(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (!node || typeof node !== "object" || !("type" in node)) {
    return;
  }
  out.push(node);
  walk(node.props?.children, out);
}
