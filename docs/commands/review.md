# `/review`

[中文](review.zh-CN.md)

Have a different agent check the work this conversation just did. The reviewer
looks at the actual changes in your project and posts its findings back here,
ending with a verdict: **approve**, **needs changes**, or **unsure**.

```text
/review
/review codex gpt-5.5 high  focus on the error paths
/review claude opus 5 recap  is the migration safe to run twice?
```

**MCP:** no. An agent can't start a review on its own yet; only you can. The
reviewer itself gets no Sealwire tools.

## Use it for

- A second opinion from a different model before you commit — Codex reviews
  Claude's work, Claude reviews Codex's.
- Checking one specific worry: anything after the provider, model and effort
  is passed to the reviewer as what to focus on.

## How it works

1. The reviewer is briefed on what was done. By default it gets your agent's
   last message. Add `recap` and your agent first writes a recap of the work
   for it instead — better when the last message doesn't cover everything.
2. The reviewer runs in its own session, read-only, in the same project.
3. Its findings land in this conversation, and your agent reads them and
   decides what to change.

`/review` runs one round. For several rounds — the agent fixes, the reviewer
looks again, until it approves or the rounds run out — use the **Request
reviewer** button and pick up to 10 rounds.

## Options

- **Provider, model, effort** — who reviews. By default a different provider
  from the one doing the work.
- **`last message` or `recap`** — how the reviewer is briefed (see above).
- **`@`** — pick a reviewer this conversation already used, so it remembers its
  last review. You can still change its effort and briefing.

## How read-only is the reviewer?

It depends on the provider:

| Reviewer | What stops it from writing |
|---|---|
| Codex | A real read-only sandbox |
| Claude Code | Its file-editing tools are taken away, but its shell can still write |
| Cursor | Runs in Cursor's plan mode |
| OpenCode | Its permission rules deny anything not explicitly allowed |
| Pi | Only told not to edit — Pi has no restricted mode |

## When it won't start

The conversation has to be idle and under your control. A review is refused
while a turn is running, while approvals are waiting on you, while another
review of this conversation is running, or while a workflow or task is running
in the same project.

## Compared with the others

- [`/delegate`](delegate.md) also uses another agent, but that agent *does*
  work and can edit files. A reviewer only reads and judges.
- [`/goal`](goal.md) keeps one agent working; it doesn't bring in a second
  opinion.

[All commands](README.md)
