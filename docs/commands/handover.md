# `/handover`

[中文](handover.zh-CN.md)

The current agent writes up where the work stands, and another agent takes the
whole job over from there. It's one-way: the new agent carries on by itself,
and nothing comes back to this conversation.

```text
/handover
/handover codex gpt-5.5 high  focus on what is left in the parser
/handover @release-prep  it still needs the changelog
```

**MCP:** no. There's no handover tool — handing the whole job over is always
your call. The new agent isn't asked to report back either.

## Use it for

- You've run out of quota on one provider and want another to finish the job.
- A long conversation has piled up too much history, and a fresh session with
  just the write-up will think more clearly.
- You want a different model to take over from here.

## How it works

1. **This agent writes the handover.** It always uses the same headings, so
   nothing important is left out: Goal, Current state, Completed work,
   Remaining work (with the very next step), Key decisions and constraints,
   Files changed, Tests, and Blockers and risks. Anything you type after the
   command steers what it goes into detail about.
2. **The new agent gets the write-up** and is told the work is now its own:
   carry on from the next step, and make its own calls where something is
   unclear.
3. **The two sessions part ways.** The old one is left as it is; nothing from
   the new one comes back to it.

## Options

- **Provider, model, effort** — who takes over. By default the same provider as
  now, since it's the same work carrying on. Name another one to switch.
- **`@`** — hand it to a session that's already open instead of starting a new
  one.
- The note after the command is optional. A bare `/handover` writes the full
  handover with no extra steer.

## Limits

- The agent has to be idle: a handover is refused in the middle of a turn.
- The new agent works in the same project and is never given more access than
  this session has. Pi always runs with Full access, so only a Full access
  session can hand over to it.
- An `@` session has to be free to take the work, under the same rules as
  [`/delegate`](delegate.md#limits).
- Only one handover to the same agent can be on its way at a time.

## Compared with the others

- [`/delegate`](delegate.md) is a question: the other agent does a piece of the
  work and the answer comes back here, while this agent stays in charge.
  `/handover` is a hand-off: the other agent owns the job from now on.
- [`/goal`](goal.md) keeps the current agent working. `/handover` replaces it.

[All commands](README.md)
