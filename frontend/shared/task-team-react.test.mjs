import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TaskDetail,
  TaskSidebarList,
  TaskTeamScreen,
  TaskWelcome,
  TeamDiagram,
} from "./task-team-react.js";

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
    tl_generations: 1,
    sub_tasks: [],
    awaiting: null,
    unresolved: [],
    updated_at: 100,
    ...overrides,
  };
}

function subTask(overrides = {}) {
  return {
    id: "s1",
    title: "Write the parser",
    status: "implementing",
    rounds_used: 0,
    digested: false,
    result_summary: null,
    dev_thread_id: "dev-1",
    reviewer_thread_id: "rev-1",
    ...overrides,
  };
}

test("with no tasks the main area explains what a task IS, not just that there are none", () => {
  // The sidebar already says the list is empty. What this space is for is the one
  // thing a list cannot say, to someone who has never started one.
  const html = renderToStaticMarkup(h(TaskWelcome, { runs: [] }));
  assert.match(html, /Start a task/);
  assert.match(html, /own git worktree/);
  assert.match(html, /Team lead/);
  assert.match(html, /Reviewer/);
  assert.match(html, /New task/);
});

test("with tasks but none selected the centre points at the Orchestrator", () => {
  const html = renderToStaticMarkup(h(TaskWelcome, { runs: [run()] }));
  assert.match(html, /Ask the Orchestrator/);
  // The explainer is for first-timers; someone with tasks does not need it again.
  assert.doesNotMatch(html, /Team lead<\/b>/);
});

test("a first load shows a loading state, but a background refresh never blanks it", () => {
  const loadingFirst = renderToStaticMarkup(h(TaskWelcome, { runs: null, loading: true }));
  assert.match(loadingFirst, /Loading tasks/);

  const refreshing = renderToStaticMarkup(
    h(TaskWelcome, { runs: [run({ title: "Still here" })], loading: true })
  );
  assert.doesNotMatch(refreshing, /Loading tasks/);
});

test("an error only takes the screen before the first successful load", () => {
  const cold = renderToStaticMarkup(h(TaskWelcome, { runs: null, error: "relay went away" }));
  assert.match(cold, /Tasks unavailable/);
  assert.match(cold, /relay went away/);

  const warm = renderToStaticMarkup(
    h(TaskWelcome, { runs: [run()], error: new Error("relay went away") })
  );
  assert.doesNotMatch(warm, /Tasks unavailable/);
});

// ---- the sidebar list ------------------------------------------------------

test("a finished task stays in the sidebar list", () => {
  // Its branch is still on disk; a row that vanished is how a user loses track of
  // the work.
  const html = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run({ status: "cancelled", title: "Abandoned work" })] })
  );
  assert.match(html, /Abandoned work/);
  assert.match(html, /is-terminal/);
});

test("the sidebar marks the open task and only that one", () => {
  const html = renderToStaticMarkup(
    h(TaskSidebarList, {
      runs: [run({ team_run_id: "team-1" }), run({ team_run_id: "team-2" })],
      selectedRunId: "team-2",
    })
  );
  assert.equal((html.match(/is-selected/g) || []).length, 1);
});

test("a sidebar row leads with what the task needs, not with its phase", () => {
  const needs = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run({ status: "escalated" })] })
  );
  assert.match(needs, /Needs you/);
  assert.match(needs, /is-attention/);

  const working = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run({ sub_tasks: [subTask(), subTask({ status: "done" })] })] })
  );
  assert.match(working, /1\/2/);
  assert.doesNotMatch(working, /Needs you/);
});

test("the sidebar groups runs the way mockup 12b does", () => {
  const html = renderToStaticMarkup(
    h(TaskSidebarList, {
      runs: [
        run({ team_run_id: "n", status: "blocked", title: "Needs a person" }),
        run({ team_run_id: "r", status: "running", title: "Still going" }),
        run({ team_run_id: "q", status: "queued", title: "Waiting its turn" }),
        run({ team_run_id: "d", status: "done", title: "Merge me" }),
      ],
    })
  );
  assert.match(html, /Needs you/);
  assert.match(html, /In progress/);
  assert.match(html, /Queued/);
  assert.match(html, /Ready to merge/);
  assert.ok(html.indexOf("Needs a person") < html.indexOf("Still going"));
  assert.ok(html.indexOf("Still going") < html.indexOf("Waiting its turn"));
  assert.ok(html.indexOf("Waiting its turn") < html.indexOf("Merge me"));
});

test("the sidebar always offers New task, even with nothing in it", () => {
  const html = renderToStaticMarkup(h(TaskSidebarList, { runs: [] }));
  assert.match(html, /New task/);
  assert.match(html, /No tasks yet/);
});

test("the sidebar footer opens the Teams library", () => {
  let opened = 0;
  const html = renderToStaticMarkup(
    h(TaskSidebarList, { runs: [run()], onOpenTeams: () => opened++ })
  );
  assert.match(html, /task-sidebar-teams/);
  assert.match(html, /1 team/);
});

test("a finished task offers one destructive delete action in its detail", () => {
  const finished = renderToStaticMarkup(
    h(TaskDetail, { run: run({ status: "done" }), onDelete: () => {} })
  );
  assert.match(finished, /Delete task/);
  assert.match(finished, /task-action is-delete/);

  const live = renderToStaticMarkup(h(TaskDetail, { run: run(), onDelete: () => {} }));
  assert.doesNotMatch(live, /Delete task/);
});

test("embedded detail uses the vertical role flow, not the three-up seats", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({ sub_tasks: [subTask()] }),
      embedded: true,
    })
  );
  assert.match(html, /team-role-flow/);
  assert.doesNotMatch(html, /team-diagram/);
  assert.doesNotMatch(html, /All tasks/);
});

test("role flow does not paint placeholder em-dashes when there is no token estimate", () => {
  // Observed: every seat showed a lone "—" on the far right of the embedded
  // pane — a missing estimate rendered as punctuation, not as absence. Only a
  // real number belongs in that slot.
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({ sub_tasks: [subTask()] }),
      embedded: true,
    })
  );
  assert.doesNotMatch(html, /team-role-estimate/);
  assert.doesNotMatch(
    html,
    /team-role-head[\s\S]*?—/,
    "no em-dash placeholder beside the role name"
  );
});

test("the Orchestrator header carries a sidebar expand control for the tasks view", () => {
  // Sessions put the expand-back control in the chat header when the sidebar is
  // collapsed. The tasks view hides that header entirely (`chat-shell[data-view=
  // "tasks"] > * { display:none }`), so without a twin here a collapsed sidebar
  // on Tasks has no way to reopen — only the icon rail remains.
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {} },
    })
  );
  assert.match(html, /id="tasks-sidebar-toggle"/);
  assert.match(html, /Hide navigation panel|Show navigation panel|navigation panel/);
});

test("a locked Tasks screen still carries the sidebar expand control", () => {
  // Public / non-beta builds return TaskLockedPreview before OrchestratorPane.
  // The reopen control has to live on that preview too, or collapsing the
  // sidebar on locked Tasks leaves no on-screen way back.
  const html = renderToStaticMarkup(h(TaskTeamScreen, { locked: true }));
  assert.match(html, /id="tasks-sidebar-toggle"/);
  assert.match(html, /Tasks is in development/);
});

test("the diagram renders exactly three seats, in team order", () => {
  const html = renderToStaticMarkup(
    h(TeamDiagram, { run: run({ sub_tasks: [subTask()] }) })
  );
  assert.match(html, /Team lead/);
  assert.match(html, /Developer/);
  assert.match(html, /Reviewer/);
  // Anchored on a word boundary: `team-seat-head` and friends share the prefix.
  assert.equal(html.match(/class="team-seat[ "]/g).length, 3);
  assert.ok(html.indexOf("Team lead") < html.indexOf("Developer"));
  assert.ok(html.indexOf("Developer") < html.indexOf("Reviewer"));
});

test("an unseated role renders a disabled node rather than a dead link", () => {
  const html = renderToStaticMarkup(h(TeamDiagram, { run: run({ phase: "intake" }) }));
  assert.match(html, /Not started/);
  assert.match(html, /disabled=""/);
});

test("clicking a seated node asks to open that seat's thread", () => {
  const opened = [];
  const seats = TeamDiagram({
    run: run({ sub_tasks: [subTask()] }),
    onOpenThread: (id) => opened.push(id),
  });
  // Walk the element tree and fire each node's handler, as a click would.
  for (const node of seats.props.children) {
    const seat = node.type(node.props);
    if (!seat.props.disabled) seat.props.onClick();
  }
  assert.deepEqual(opened, ["tl-1", "dev-1", "rev-1"]);
});

test("there is no per-agent stop anywhere on the diagram", () => {
  // The only stop is the run's; a stop on a seat would be refused by the backend.
  const html = renderToStaticMarkup(
    h(TeamDiagram, { run: run({ sub_tasks: [subTask()] }) })
  );
  assert.doesNotMatch(html, /Stop/);
});

test("a parked question is announced with a way to answer it", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({
        status: "awaiting_user",
        awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 1 },
        sub_tasks: [subTask()],
      }),
    })
  );
  assert.match(html, /asked you a question/);
  assert.match(html, /Answer it/);
});

test("the detail offers only the actions the backend would accept", () => {
  // Match on the action classes, not the labels: the hint text on Cancel legitimately
  // contains the words "Stop now", so a label-based assertion reads the wrong thing.
  const classesFor = (status) => {
    const html = renderToStaticMarkup(h(TaskDetail, { run: run({ status }) }));
    return (html.match(/task-action is-([a-z]+)/g) || []).map((match) =>
      match.replace("task-action is-", "")
    );
  };

  assert.deepEqual(classesFor("paused"), ["resume", "cancel"]);
  assert.deepEqual(classesFor("blocked"), ["resolve"]);
  assert.deepEqual(classesFor("pause_pending"), ["stop", "cancel"]);
  assert.deepEqual(classesFor("running"), ["pause", "stop", "cancel"]);
  for (const terminal of ["done", "escalated", "failed", "interrupted", "cancelled"]) {
    assert.deepEqual(classesFor(terminal), [], terminal);
  }
});

test("a paused task says the team lead can be talked to", () => {
  // Mirrors the TlWhilePaused gate — that is where a user redirects the work.
  const paused = renderToStaticMarkup(h(TaskDetail, { run: run({ status: "paused" }) }));
  assert.match(paused, /talk to the team lead/);

  const running = renderToStaticMarkup(h(TaskDetail, { run: run({ status: "running" }) }));
  assert.doesNotMatch(running, /talk to the team lead/);
});

test("a task that no longer exists says so instead of rendering an empty shell", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, { runs: [], selectedRunId: "team-gone" })
  );
  assert.match(html, /That task is gone/);
  assert.match(html, /still on disk/);
  assert.match(html, /task-workspace/);
});

test("a task still loading is not reported as gone", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, { runs: null, selectedRunId: "team-1", loading: true })
  );
  assert.match(html, /Loading task/);
  assert.doesNotMatch(html, /That task is gone/);
});

test("the workspace puts task detail in the middle and Orchestrator on the right", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [
        run({
          status: "awaiting_user",
          awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 1 },
          sub_tasks: [subTask()],
        }),
      ],
      selectedRunId: "team-1",
      waitingCount: 1,
    })
  );
  assert.match(html, /task-workspace-detail/);
  assert.match(html, /task-workspace-orch/);
  assert.match(html, /id="task-workspace-resize"/);
  assert.match(html, /Orchestrator/);
  assert.match(html, /1 waiting on you/);
  assert.match(html, /Paused for a decision/);
  assert.match(html, /Add a parser/);
  // Detail precedes Orchestrator in DOM — middle then right.
  assert.ok(
    html.indexOf("task-workspace-detail") < html.indexOf("task-workspace-orch"),
    "task detail must sit before the Orchestrator column"
  );
  // List is in the app sidebar — embedded detail has no "All tasks" back control.
  assert.doesNotMatch(html, /All tasks/);
});

test("an unread terminal report uses finished wording", () => {
  const escalated = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run({ status: "escalated" })],
      selectedRunId: "team-1",
    })
  );
  assert.match(escalated, /Finished/);
  assert.match(escalated, /Ran out of rounds/);
  assert.doesNotMatch(escalated, /Paused for a decision/);

  for (const status of ["failed", "interrupted"]) {
    const html = renderToStaticMarkup(
      h(TaskTeamScreen, { runs: [run({ status })], selectedRunId: "team-1" })
    );
    assert.match(html, /Finished/, status);
    assert.match(html, /Task stopped/, status);
    assert.doesNotMatch(html, /Paused for a decision/, status);
  }
});

test("a read terminal report no longer renders an attention card", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run({ status: "failed", updated_at: 100 })],
      selectedRunId: "team-1",
      seenAt: { "team-1": 100 },
      orchestrator: { entries: [] },
    })
  );
  assert.doesNotMatch(html, /task-orch-card/);
  assert.doesNotMatch(html, /Task stopped/);
});

test("questions and blocked tasks keep decision wording", () => {
  const states = [
    run({
      status: "awaiting_user",
      awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 1 },
    }),
    run({ status: "blocked" }),
  ];
  for (const state of states) {
    const html = renderToStaticMarkup(
      h(TaskTeamScreen, { runs: [state], selectedRunId: "team-1" })
    );
    assert.match(html, /Needs you/, state.status);
    assert.match(html, /Paused for a decision/, state.status);
  }
});

test("pending Orchestrator proposals render confirm and dismiss", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        proposals: [
          {
            id: "orch_prop_1",
            kind: "start_task",
            title: "Add a parser",
            context: "CLI surface",
            team_name: "Default",
          },
        ],
        onSend: () => {},
        onPropose: () => {},
        onConfirmProposal: () => {},
        onDismissProposal: () => {},
      },
    })
  );
  assert.match(html, /Propose task/);
  assert.match(html, /Add a parser/);
  assert.match(html, /Start task/);
  assert.match(html, /Dismiss/);
  assert.match(html, /Propose as task/);
});

test("TaskTeamScreen forwards the auto-start toggle into the proposal card", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        proposals: [
          {
            id: "orch_prop_1",
            kind: "start_task",
            title: "Add a parser",
            context: "CLI surface",
            team_name: "Default",
            auto_start: false,
            scheduled_start_at: null,
          },
        ],
        onSend: () => {},
        onPropose: () => {},
        onConfirmProposal: () => {},
        onDismissProposal: () => {},
        onToggleProposalAutoStart: () => {},
      },
    })
  );
  const toggleTag = html.match(/<button[^>]*>Start automatically<\/button>/)?.[0] || "";
  assert.match(toggleTag, /Start automatically/);
  assert.doesNotMatch(
    toggleTag,
    /\bdisabled\b/,
    "without the forwarded handler the real app leaves this permanently disabled"
  );
});

test("the Orchestrator composer is live when a send handler is wired", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        loading: false,
        composerDisabled: false,
        onSend: () => {},
      },
    })
  );
  assert.match(html, /task-orch-form/);
  // The composer must not promise that sending starts work — Send is chat.
  assert.match(html, /Message the Orchestrator/);
  assert.doesNotMatch(html, /Describe a task to start/);
  assert.doesNotMatch(html, /next milestone/);
  assert.match(html, />Send</);
});

test("with nothing selected the detail pane stays empty and the Orchestrator welcomes", () => {
  const html = renderToStaticMarkup(h(TaskTeamScreen, { runs: [run()], selectedRunId: null }));
  assert.match(html, /Ask the Orchestrator/);
  assert.match(html, /No task selected/);
});

test("Orchestrator idle copy points at task detail on the left after the column swap", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, { runs: [run()], selectedRunId: "team-1" })
  );
  assert.match(html, /seats and branch are on the left/);
  assert.doesNotMatch(html, /seats and branch are on the right/);
});

test("sub-task rounds and summaries surface, but never the brief", () => {
  // The brief is TL-authored instruction for a developer, not status — it is
  // deliberately absent from the payload, and nothing here should imply otherwise.
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({
        sub_tasks: [
          subTask({ status: "done", rounds_used: 2, result_summary: "Parser landed." }),
        ],
      }),
    })
  );
  assert.match(html, /Parser landed\./);
  assert.match(html, /2 rounds/);
  assert.match(html, /Sub-tasks \(1\/1\)/);
});

test("unresolved notes are listed so the report is not the only place they appear", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({ status: "escalated", unresolved: ["Ran out of review rounds on s2"] }),
    })
  );
  assert.match(html, /Unresolved/);
  assert.match(html, /Ran out of review rounds on s2/);
});

test("an action in flight disables the others rather than allowing a second", () => {
  // Scoped to the action buttons: unseated diagram nodes are disabled too, and
  // counting those instead would pass no matter what the actions did.
  const actionsOf = (html) => html.match(/<button[^>]*class="task-action is-[^>]*>/g) || [];

  const idle = renderToStaticMarkup(h(TaskDetail, { run: run({ status: "running" }) }));
  assert.equal(actionsOf(idle).length, 3);
  assert.equal(actionsOf(idle).filter((button) => button.includes("disabled")).length, 0);

  const busy = renderToStaticMarkup(
    h(TaskDetail, { run: run({ status: "running" }), actionPending: "pause" })
  );
  assert.equal(actionsOf(busy).length, 3);
  assert.equal(actionsOf(busy).filter((button) => button.includes("disabled")).length, 3);
});

test("a refused action shows the relay's reason", () => {
  const html = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({ status: "running" }),
      actionError: "this task is blocked; resolve it first",
    })
  );
  assert.match(html, /resolve it first/);
});

test("only a parked question offers a way to answer it", () => {
  // Every wanting-a-person state shares one bucket, so a banner keyed on the
  // BUCKET grows an "Answer it" button on an escalated task — where there is no
  // question, and the button can only be dead.
  const asking = renderToStaticMarkup(
    h(TaskDetail, {
      run: run({
        status: "awaiting_user",
        awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 1 },
      }),
    })
  );
  assert.match(asking, /Answer it/);

  for (const status of ["escalated", "blocked", "failed", "interrupted"]) {
    const html = renderToStaticMarkup(h(TaskDetail, { run: run({ status }) }));
    assert.doesNotMatch(html, /Answer it/, status);
    assert.match(html, /task-banner is-/, `${status} still explains itself`);
  }
});

test("a banner never promises an action the task cannot offer", () => {
  // Every terminal run has no lifecycle buttons at all. Telling the user to
  // "decide what happens next" or "start it again" with nothing to press is
  // worse than telling them where the work ended up — so this loops the same
  // statuses as its sibling rather than trusting one of them to stand in.
  const forbidden = /\b(Start it again|drop it|Decide what happens next|Try again|Retry)\b/i;
  for (const status of ["escalated", "failed", "interrupted"]) {
    const html = renderToStaticMarkup(h(TaskDetail, { run: run({ status, error: null }) }));
    assert.deepEqual(
      html.match(/task-action is-([a-z]+)/g) || [],
      [],
      `${status} offers no actions`
    );
    assert.doesNotMatch(html, forbidden, `${status} must not name one`);
    assert.match(html, /on disk/, `${status} says where the work went`);
  }
});

test("the Orchestrator restart control reaches the pane when a handler is wired", () => {
  // Regression: the pane grew an `onReset` prop and a button, `render-session`
  // built the handler, and the object between them — which maps `orchestrator.X`
  // onto pane props one field at a time — was never given the new field. Both
  // halves read correctly on their own and the control simply never rendered.
  // That is the whole failure mode an explicit mapping has, so it needs a test
  // that crosses it rather than one per side.
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        onSend: () => {},
        onReset: () => {},
      },
    })
  );
  assert.match(html, /task-orch-refresh/);
  assert.match(html, /Restart the Orchestrator/);
});

test("no restart control when nothing can handle it", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {} },
    })
  );
  assert.doesNotMatch(html, /task-orch-refresh/);
});

test("attached images reach the composer through the workspace", () => {
  // Crosses the same seam as the restart control: the pane props are a
  // hand-maintained field list, so a new field is one forgotten line away from
  // never arriving. Assert from the screen down, not from the composer out.
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        onSend: () => {},
        attachments: [{ id: "img-1", name: "screenshot.png", size: 1234 }],
        onPasteImages: () => true,
        onRemoveAttachment: () => {},
      },
    })
  );
  assert.match(html, /task-orch-attachments/);
  assert.match(html, /screenshot\.png/);
  assert.match(html, /Remove screenshot\.png/);
});

test("an image with no words is still sendable", () => {
  // "Look at this" is the common case for a screenshot. Requiring text beside
  // it would make the ordinary thing the awkward one.
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        onSend: () => {},
        attachments: [{ id: "img-1", name: "screenshot.png", size: 10 }],
      },
    })
  );
  // The submit control is live even though the textarea is empty. Matched on
  // the whole tag, not `id[^>]*disabled`: React emits `disabled` BEFORE `id`,
  // so an id-anchored lookahead passes whether or not the button is disabled.
  const sendTag = html.match(/<button[^>]*id="task-orch-send"[^>]*>/)?.[0];
  assert.ok(sendTag, "the Orchestrator composer must render a send button");
  assert.doesNotMatch(sendTag, /\bdisabled\b/);
});

test("the send button is dead while there is nothing to send", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {}, attachments: [] },
    })
  );
  const sendTag = html.match(/<button[^>]*id="task-orch-send"[^>]*>/)?.[0];
  assert.ok(sendTag);
  assert.match(sendTag, /\bdisabled\b/, "no text and no image is nothing to send");
});

// The Orchestrator's model and approval policy are settled when its thread is
// created; nothing in this pane can change them. A picker or a settings gear
// here would be a control that lies, so the shared composer is asked for
// neither (`models: []`, no `actionsBeforeSend`).
test("the Orchestrator composer offers no model picker and no settings", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {} },
    })
  );
  assert.match(html, /task-orch-form/);
  assert.doesNotMatch(html, /composer-model-picker/);
  assert.doesNotMatch(html, /composer-model-chip/);
  assert.doesNotMatch(html, /composer-settings-mount/);
});

// It draws the session composer, not a lookalike: that is what keeps IME,
// Home/End and the mobile Enter policy from having to be fixed twice.
test("the Orchestrator composer is the shared conversation composer", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {}, composerError: "relay said no" },
    })
  );
  assert.match(html, /class="composer-inner"/);
  assert.match(html, /class="composer-error"[^>]*>relay said no</);
});

// The Orchestrator pane had no liveness signal at all: you sent, and the pane
// sat there until a whole reply appeared. The session conversation has shown a
// pulsing "Bashing…" pill this whole time (AgentWorkingIndicator, driven by
// progressPhaseLabel) — same shared parts, so the Orchestrator reads the same
// way rather than inventing a second vocabulary.
test("the Orchestrator pane shows what the model is doing right now", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        onSend: () => {},
        activity: { phase: "tool", tool: "Bash" },
      },
    })
  );
  assert.match(html, /agent-working-indicator/);
  assert.match(html, /Bashing…/);
});

test("a thinking Orchestrator says so, without a tool name", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {}, activity: { phase: "thinking" } },
    })
  );
  assert.match(html, /Thinking…/);
});

// A stalled turn must not read as steady progress: same pill, alert tone.
test("a stalled Orchestrator turn is flagged rather than pulsing forever", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: {
        entries: [],
        onSend: () => {},
        activity: { phase: "tool", tool: "Bash", stalled: true },
      },
    })
  );
  assert.match(html, /agent-working-indicator-alert/);
  assert.match(html, /Stalled\?/);
});

test("an idle Orchestrator shows no indicator at all", () => {
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: null,
      orchestrator: { entries: [], onSend: () => {}, activity: { phase: null, tool: null } },
    })
  );
  assert.doesNotMatch(html, /agent-working-indicator/);
});

test("the changes slot reaches the task detail", () => {
  // `TaskDetail` reserved "Changes on this branch" long before anything filled
  // it, so the slot had no provider and no test. Same seam as the restart
  // control and the attachments: assert from the screen down.
  const html = renderToStaticMarkup(
    h(TaskTeamScreen, {
      runs: [run()],
      selectedRunId: "team-1",
      changesPanel: h("p", null, "the diff goes here"),
    })
  );
  assert.match(html, /Changes on this branch/);
  assert.match(html, /the diff goes here/);
});
