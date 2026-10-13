# `/delegate`

[中文](delegate.zh-CN.md)

Pass a side job to another agent and get the answer back here. This
conversation carries on; the other agent works in its own session, which you
can open, read along in, or step into.

```text
/delegate  find out why the transcript test is flaky
/delegate codex gpt-5.5 high  check whether the old config format is still read anywhere
/delegate @parser-cleanup  also cover the empty-file case
```

**MCP:** yes. An agent can do the same thing on its own with the `delegate`
tool, and the other agent answers with `report_back`. See [below](#mcp).

## Use it for

- A job that can run alongside this one: chase a flaky test, look something up
  in another part of the code, try an approach in parallel.
- A different model's strengths: have Codex dig into something while Claude
  keeps going, or the other way round.
- Following up with an agent you already delegated to — pick it with `@` and
  it keeps everything it learned last time.

## How it works

1. **Your agent writes the brief.** The other agent can't see this
   conversation, so what you type is an instruction to *your* agent about what
   to hand off. It writes a self-contained brief from what it knows.
2. **The other agent does the work** in its own session. A new one appears in
   your sidebar, or the `@` session you picked gets the brief.
3. **The answer comes back here.** When the other agent is done, its answer is
   delivered to this conversation and your agent picks it up. If it finishes
   without reporting, Sealwire reminds it once, then passes on its last reply.

Your agent doesn't stop to wait: it can keep working while the other agent
does.

## Options

- **Provider, model, effort** — who to hand it to. By default a different
  provider from this one, because a second model is worth more than a second
  copy of the same one.
- **`@`** — hand it to a session that's already open instead of starting a new
  one.
- The instruction is required. An agent starting from nothing can't guess what
  you want.

## Limits

- A new agent is never given more access than this session has. An `@` session
  that's allowed to do more than this one is refused.
- One session can bring in up to 5 other agents.
- An `@` session is refused if it's busy, waiting on an approval, waiting for
  an answer from this session, or belongs to a task, the Orchestrator or a
  review.

## MCP

Every ordinary session gets Sealwire's MCP tools, so delegation works in both
directions without you typing anything:

| Tool | Who uses it | What it does |
|---|---|---|
| `delegate` | The agent asking for help | Starts another agent with a task, or sends one to an agent it already started |
| `report_back` | The agent doing the work | Sends its answer back to whoever asked |

When an agent calls `delegate` itself, a few things are different from when
you type `/delegate`:

- It needs **Full access (YOLO)**. A restricted session is refused, with a note
  telling it to suggest `/delegate` to you instead.
- Its message is sent as the brief — there's no separate brief-writing step.
- It has to name a model for a new agent (or ask for the default). If it picks
  a flagship model, nothing starts until you approve it.

`report_back` is given to every ordinary session, even a restricted one: it
only answers whoever asked, so it can't reach further than they could.

All providers — Claude Code, Codex, Cursor, OpenCode, Pi — get both tools, and
any of them can be on either end. The one catch is Pi: it always runs with Full
access, so only a Full access session can bring it in.

## Compared with the others

- [`/handover`](handover.md) also brings in another agent, but nothing comes
  back: the other agent takes the job over. With `/delegate`, this agent stays
  in charge and gets the answer.
- [`/review`](review.md) brings in another agent to *read and judge*. A
  delegated agent *does work* and can edit files.

[All commands](README.md)
