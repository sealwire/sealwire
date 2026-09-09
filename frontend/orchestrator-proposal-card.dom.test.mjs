// What the confirm button actually authorises.
//
// The backend resolves a provider/model/effort per seat, stores it on the
// proposal, and starts exactly that on confirm. The card showed only the team
// name, title and why — so a proposal could put every seat on `max` effort, or
// move one to another provider, and the user clicking "Start task" had nothing
// on screen to object to. These pin that the choice is visible before the click.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { OrchestratorPane } = await import("./shared/task-team-react.js");
const { formatTimestamp } = await import("./remote/utils.js");

// A fixed instant, so the card's own clock never decides whether a test passes.
const NOW = 1_800_000_000;
const IN_TWO_HOURS = NOW + 2 * 3600;

function renderPane(proposals, extra = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      React.createElement(OrchestratorPane, {
        runs: [],
        proposals,
        onStartTask: () => {},
        onOpenThread: () => {},
        nowSeconds: NOW,
        ...extra,
      }),
    );
  });
  return host;
}

function scheduleNote(host) {
  const node = host.querySelector(".task-orch-card-schedule");
  return node ? node.textContent : null;
}

function autoStartToggle(host) {
  return host.querySelector(".task-orch-card-autostart");
}

const PROPOSAL = {
  id: "orch_prop_1",
  kind: "start_task",
  title: "Add a parser",
  team_name: "Default",
  agents: {
    tl: { provider: "codex", model: "gpt-5.6-codex" },
    dev: { provider: "codex", model: "gpt-5.6-codex" },
    reviewer: { provider: "claude_code", model: "claude-opus-5", effort: "max" },
  },
};

test("the card names the agent each seat will run on", () => {
  const host = renderPane([PROPOSAL]);
  const text = host.textContent;
  assert.match(text, /claude-opus-5/, "the reviewer's model must be visible before Start");
  assert.match(text, /max/, "an expensive effort must be visible before Start");
  assert.match(text, /gpt-5\.6-codex/, "the other seats' model too");
  assert.match(text, /Reviewer/, "each choice must say which seat it belongs to");
});

test("a Pair proposal names only the two roles that will run", () => {
  const host = renderPane([
    {
      ...PROPOSAL,
      team_id: "pair",
      team_name: "Pair",
      agents: {
        tl: { provider: "claude_code", model: "opus[1m]", effort: "xhigh" },
        dev: { provider: "claude_code", model: "sonnet[1m]", effort: "high" },
        reviewer: { provider: "codex", model: "gpt-5.5", effort: "high" },
      },
      agent_rows: [
        {
          role_id: "pair",
          label: "Pair programmer",
          agent: { provider: "claude_code", model: "sonnet[1m]", effort: "high" },
        },
        {
          role_id: "reviewer",
          label: "Reviewer",
          agent: { provider: "codex", model: "gpt-5.5", effort: "high" },
        },
      ],
    },
  ]);
  const rows = [...host.querySelectorAll(".task-orch-proposal-agent")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Pair programmer: claude_code/);
  assert.match(rows[1].textContent, /Reviewer: codex/);
  assert.doesNotMatch(host.textContent, /Planner/);
  assert.doesNotMatch(host.textContent, /opus\[1m\]/);
});

test("an old Pair proposal payload still hides the unused planner slot", () => {
  const host = renderPane([
    {
      ...PROPOSAL,
      team_id: "pair",
      team_name: "Pair",
      agents: {
        tl: { provider: "claude_code", model: "opus[1m]", effort: "xhigh" },
        dev: { provider: "claude_code", model: "sonnet[1m]", effort: "high" },
        reviewer: { provider: "codex", model: "gpt-5.5", effort: "high" },
      },
    },
  ]);
  const rows = [...host.querySelectorAll(".task-orch-proposal-agent")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Pair programmer: claude_code/);
  assert.match(rows[1].textContent, /Reviewer: codex/);
  assert.doesNotMatch(host.textContent, /Planner/);
  assert.doesNotMatch(host.textContent, /opus\[1m\]/);
});

test("a proposal that pins nothing adds no agent row", () => {
  // Absent must not render as "default": the relay's default can move, and the
  // card would be claiming a guarantee the proposal does not carry.
  const host = renderPane([{ ...PROPOSAL, agents: {} }]);
  assert.equal(host.querySelectorAll(".task-orch-proposal-agent").length, 0);
});

test("a seat that pins only an effort shows just that", () => {
  const host = renderPane([
    { ...PROPOSAL, agents: { reviewer: { effort: "max" } } },
  ]);
  const rows = [...host.querySelectorAll(".task-orch-proposal-agent")];
  assert.equal(rows.length, 1, "only the seat that named something");
  assert.match(rows[0].textContent, /Reviewer/);
  assert.match(rows[0].textContent, /max/);
});

test("a reopen card does not read as a new task", () => {
  // Confirming is the user's only gate. A reopen card that says "Propose task"
  // for team "Default" describes a choice nobody made.
  const host = renderPane([
    { ...PROPOSAL, kind: "reopen_task", team_name: "", agents: {} },
  ]);
  const text = host.textContent;
  assert.match(text, /Reopen task/);
  assert.doesNotMatch(text, /Propose task/);
  assert.doesNotMatch(text, /Default/, "a reopen picks no team");
});

// Reopening a task can now rewrite its definition — an investigation whose
// criteria say "no code was changed" becomes one that requires code. Confirm is
// the only gate on that, so the card has to say which fields it rewrites.
// Approving a change you cannot see is not approval.
test("a reopen card names the definition fields it rewrites", () => {
  const host = renderPane([
    {
      id: "orch_prop_2",
      kind: "reopen_task",
      title: "Fix the truncated project name",
      context: "Now actually fix it.",
      spec_updates: {
        title: "Fix the truncated project name",
        acceptance_criteria: "A failing test pins a 4-character name, then passes.",
        agreed_scope: "Product code under frontend/ may change.",
      },
      agents: {},
    },
  ]);
  const text = host.textContent;
  assert.match(text, /Reopen task/);
  assert.match(text, /acceptance criteria/i, `no mention of the changed bar: ${text}`);
  assert.match(text, /agreed scope/i, text);
  assert.doesNotMatch(
    text,
    /quality rules/i,
    "a field nobody rewrote must not be listed as changed",
  );
});

test("a plain reopen card claims no definition change", () => {
  const host = renderPane([
    {
      id: "orch_prop_3",
      kind: "reopen_task",
      title: "Investigate the loader",
      context: "Keep going on that one.",
      agents: {},
    },
  ]);
  assert.doesNotMatch(host.textContent, /rewrites/i, host.textContent);
});

// A schedule is part of what Start authorises — and, once auto-start is on, part
// of what happens WITHOUT anyone pressing Start. Both belong on the card.

test("a proposal with no schedule shows no time and an unpressed toggle", () => {
  // Acceptance criterion 3, at the layer the user judges it by: off by default.
  const host = renderPane([PROPOSAL]);
  assert.equal(scheduleNote(host), null, "no schedule means no time on the card");
  const toggle = autoStartToggle(host);
  assert.ok(toggle, "the toggle is offered even before a time is set");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
});

test("a scheduled card that starts itself says so, with the time", () => {
  const host = renderPane([
    { ...PROPOSAL, scheduled_start_at: IN_TWO_HOURS, auto_start: true },
  ]);
  assert.equal(
    scheduleNote(host),
    `Starts on its own in 2h, on ${formatTimestamp(IN_TWO_HOURS)}.`,
  );
  const toggle = autoStartToggle(host);
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.match(
    toggle.textContent,
    /✓/,
    "armed state must be visible, not only announced to a screen reader",
  );
});

test("a scheduled card that does NOT start itself says it is waiting for you", () => {
  // The same timestamp makes two different promises depending on `auto_start`.
  // Reading one as the other is the whole risk this card carries.
  const host = renderPane([
    { ...PROPOSAL, scheduled_start_at: IN_TWO_HOURS, auto_start: false },
  ]);
  assert.equal(
    scheduleNote(host),
    `Planned for ${formatTimestamp(IN_TWO_HOURS)}, in 2h. Waiting for you to press Start task.`,
  );
  const toggle = autoStartToggle(host);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.doesNotMatch(toggle.textContent, /✓/, "unarmed must not look armed");
});

test("the two schedule promises are not the same sentence", () => {
  const auto = renderPane([
    { ...PROPOSAL, scheduled_start_at: IN_TWO_HOURS, auto_start: true },
  ]);
  const manual = renderPane([
    { ...PROPOSAL, scheduled_start_at: IN_TWO_HOURS, auto_start: false },
  ]);
  assert.notEqual(scheduleNote(auto), scheduleNote(manual));
  assert.doesNotMatch(
    scheduleNote(auto),
    /Waiting for you/,
    "a card that starts itself must never say someone is expected to press Start",
  );
  assert.doesNotMatch(
    scheduleNote(manual),
    /on its own/,
    "a card nobody armed must not claim it will run by itself",
  );
});

test("a start time already past does not read as a countdown", () => {
  const host = renderPane([
    { ...PROPOSAL, scheduled_start_at: NOW - 600, auto_start: false },
  ]);
  assert.equal(
    scheduleNote(host),
    `Planned for ${formatTimestamp(NOW - 600)}. Waiting for you to press Start task.`,
  );
});

test("auto-start with no time set does not promise a start", () => {
  // Reachable: the tool may stage `auto_start` without `start_in_minutes`, and
  // the toggle can be pressed on a card that never had a time. Nothing fires
  // without one, so the card must not imply otherwise.
  const host = renderPane([{ ...PROPOSAL, auto_start: true }]);
  assert.equal(scheduleNote(host), "No start time, so it will not start on its own.");
});

test("clicking the toggle asks to flip auto-start on this proposal", () => {
  const calls = [];
  const host = renderPane([PROPOSAL], {
    onToggleProposalAutoStart: (id, next) => calls.push([id, next]),
  });
  act(() => {
    autoStartToggle(host).dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  assert.deepEqual(calls, [["orch_prop_1", true]]);
});

test("clicking an armed toggle asks to turn it back off", () => {
  const calls = [];
  const host = renderPane(
    [{ ...PROPOSAL, scheduled_start_at: IN_TWO_HOURS, auto_start: true }],
    { onToggleProposalAutoStart: (id, next) => calls.push([id, next]) },
  );
  act(() => {
    autoStartToggle(host).dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  assert.deepEqual(calls, [["orch_prop_1", false]]);
});

// `formatRelativeTime`'s floor is "now" — it was built to say how long ago
// something was, where "now" is right. Measured forward it lands mid-sentence,
// so anything under a minute away read as "in now". A one-minute schedule hits
// this on the very next render.

test("a start under a minute away still reads as a sentence, armed", () => {
  const host = renderPane([
    { ...PROPOSAL, scheduled_start_at: NOW + 30, auto_start: true },
  ]);
  assert.equal(
    scheduleNote(host),
    `Starts on its own in under a minute, on ${formatTimestamp(NOW + 30)}.`,
  );
});

test("a start under a minute away still reads as a sentence, unarmed", () => {
  const host = renderPane([
    { ...PROPOSAL, scheduled_start_at: NOW + 30, auto_start: false },
  ]);
  assert.equal(
    scheduleNote(host),
    `Planned for ${formatTimestamp(NOW + 30)}, in under a minute. ` +
      `Waiting for you to press Start task.`,
  );
});

test("the sub-minute wording stops exactly where the minute count starts", () => {
  // The two formats have to meet with no gap and no overlap: 59s is the last
  // "under a minute", 60s is the first "1m".
  const at59 = renderPane([{ ...PROPOSAL, scheduled_start_at: NOW + 59, auto_start: true }]);
  const at60 = renderPane([{ ...PROPOSAL, scheduled_start_at: NOW + 60, auto_start: true }]);
  assert.equal(
    scheduleNote(at59),
    `Starts on its own in under a minute, on ${formatTimestamp(NOW + 59)}.`,
  );
  assert.equal(
    scheduleNote(at60),
    `Starts on its own in 1m, on ${formatTimestamp(NOW + 60)}.`,
  );
});

test("no offset renders the phrase \"in now\"", () => {
  // The class of defect, not just the one instance of it.
  for (const offset of [1, 30, 59, 60, 61, 3599, 3600, 86_400, 604_800]) {
    for (const auto_start of [true, false]) {
      const host = renderPane([
        { ...PROPOSAL, scheduled_start_at: NOW + offset, auto_start },
      ]);
      assert.doesNotMatch(
        scheduleNote(host),
        /\bin now\b/,
        `offset ${offset}s, auto_start ${auto_start}: ${scheduleNote(host)}`,
      );
    }
  }
});
