# Slash commands

[中文](README.zh-CN.md)

Type `/` in the message box and Sealwire offers four commands of its own, next
to your agents' own commands and skills:

- [`/review`](review.md) — have a different agent check the work so far.
- [`/goal`](goal.md) — give this session a finish line and let it keep going.
- [`/delegate`](delegate.md) — pass a side job to another agent and get the answer back.
- [`/handover`](handover.md) — hand the whole job to another agent to finish.

## Which one do I want?

- You want a **second opinion** on what was just done → `/review`.
- You want **this agent to keep working on its own** until something is done → `/goal`.
- You want **another agent to do a piece of the work** while this one carries
  on, and the answer back here → `/delegate`.
- You want **another agent to take over** and this one to stop → `/handover`.

## How they differ

| | `/review` | `/goal` | `/delegate` | `/handover` |
|---|---|---|---|---|
| Who does the work | another agent, read-only | this session | another agent | another agent |
| What comes back here | findings and a verdict | done, stuck, or a question for you | the other agent's answer | nothing — it's one-way |
| Default agent | a different provider | — | a different provider | the same provider |
| Pick provider, model, effort | yes | no | yes | yes |
| `@` an existing session | yes, an earlier reviewer of this conversation | no | yes | yes |
| Needs Full access (YOLO) | no | yes | no | no |
| An agent can start it itself (MCP) | not yet | no | yes | no |

Words for who and how are read from plain text: `codex`, `claude`, `gpt-5.5`,
`opus 5`, `high` — a model is named the way the model menu shows it. Whatever you write after them is the instruction. A word that doesn't
clearly name a provider, model or effort is left as part of the instruction —
Sealwire won't guess.

## MCP: what an agent can do on its own

Every ordinary session — Claude Code, Codex, Cursor, OpenCode, Pi — is given a
small set of Sealwire tools over MCP. The server shows up as `sealwire-…` in
the agent's tool list. Those tools are how an agent takes part in these
commands without you typing anything:

| Tool | What it does | Who gets it |
|---|---|---|
| `delegate` | Starts another agent with a task, like `/delegate` | Full access (YOLO) sessions |
| `report_back` | Answers the agent or person that delegated to it | Every ordinary session, even restricted ones |
| `goal_status`, `goal_plan`, `goal_step` | Read the goal, lay out a plan, tick off steps | Full access (YOLO) sessions |
| `goal_complete`, `goal_blocked`, `goal_needs_you` | The only three ways a goal ends: done, stuck, or asking you | Full access (YOLO) sessions |

What is deliberately missing:

- **No tool sets or edits a goal.** Only you can, with `/goal`. An agent that
  could rewrite its own goal would rewrite it to one it can finish.
- **No review tool yet.** An agent can't ask for a review on its own; you start
  one with `/review` or the **Request reviewer** button.
- **No handover tool.** Handing the whole job over is always your call.

A restricted session (not Full access) that tries `delegate` or a `goal_*` tool
gets a refusal telling it to ask you instead. Reviewer sessions get no Sealwire
tools at all.
