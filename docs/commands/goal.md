# `/goal`

[中文](goal.zh-CN.md)

Give this session a finish line and let it keep working on its own until it
gets there. It stops only to tell you one of three things: it's **done** (and
how it knows), it's **stuck** (and why), or it **needs you to decide**
something.

```text
/goal  get the mobile door working like the desktop one
/goal  make every test in crates/relay-server pass, without skipping any
/goal
```

A bare `/goal` stops the goal that's running.

**MCP:** the agent works the goal through Sealwire's MCP tools, but it can't
set or change the goal itself — only you can. See [below](#mcp).

## Use it for

- Work with a clear finish line that takes many turns: get the tests green,
  port a feature, chase a bug down to its cause.
- Leaving something running while you're away. You come back to *done*,
  *stuck*, or a question — not to an agent that stopped halfway to ask
  "shall I continue?"

It's the wrong tool for a single question or a quick edit: just send a message.

## How it works

1. You set the goal. The same session keeps working on it; no new agent is
   started.
2. The agent lays out a plan (up to 12 steps) and ticks steps off as it goes.
   The plan shows on the goal's card.
3. Each time the agent finishes a turn without ending the goal, Sealwire sends
   it another turn to keep going. Saying "I'm done" in plain text does not end
   it.
4. It ends when the agent reports done, stuck or needs you, when you stop it,
   or after 20 turns.

A *done* report is a claim, not a verdict. It comes with what the agent did and
what's left for you. **Mark done** accepts it; **Not done — keep going** sends
the agent back to work. Replying to
a goal that's stuck or waiting on you starts it up again.

While the agent is waiting on another agent it brought in with `delegate`, the
goal pauses instead of nudging it.

## Tip: have another agent review as it goes

You can write how to work into the goal itself. For example, to have Codex
check each piece:

```text
/goal  finish the mobile settings page. You do the implementation. After each piece, use Sealwire's delegate tool to have the same Codex agent (gpt-6.1-sol, xhigh) review it without editing anything, and fix what it finds until it approves.
```

The agent's first `delegate` call starts that Codex agent; later calls go back
to it, so it remembers what it has already reviewed. The agent can't start
`/review` on its own, so this is how a goal gets a second opinion while you're
away. Each review that comes back uses one of the 20 turns.

## Requirements

- **Full access (YOLO).** A goal runs the session unattended, so the session
  has to be able to act without asking. Otherwise `/goal` is refused with a
  note to switch it.
- An ordinary session of yours — not a task, not the Orchestrator, and not one
  that something else (a review, another driver) is already running.
- The goal fits in 8,000 characters.

## MCP

This is the one command that depends on MCP to run. The agent uses Sealwire's
tools to do its part:

| Tool | What the agent uses it for |
|---|---|
| `goal_status` | Read the goal and the plan so far |
| `goal_plan` | Lay out the steps |
| `goal_step` | Mark a step started or done |
| `goal_complete` | Report it's done, with evidence and what's left for you |
| `goal_blocked` | Report it can't get there, and why |
| `goal_needs_you` | Ask you a question, optionally with choices |

What it *can't* do is write the goal. No tool sets or edits it — an agent that
could change its own goal would change it to one it can finish. These tools
also need Full access; a restricted session that calls one is told to ask you
to switch.

Every provider Sealwire supports — Claude Code, Codex, Cursor, OpenCode, Pi —
gets these tools.

## Compared with the others

- [`/delegate`](delegate.md) and [`/handover`](handover.md) bring in another
  agent. `/goal` keeps the one you're talking to working.
- A goal can use the others: the agent can delegate side jobs with the
  `delegate` tool while it works toward the goal. Their answers count toward
  the 20 turns.

[All commands](README.md)
