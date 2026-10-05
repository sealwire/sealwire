# The private crate

The relay in this repository is complete and buildable on its own. What it does
**not** contain is `sealwire-private` — today that is the orchestration engines
and the task merge-review surface: the task workflow driver, its phase
transitions, prompts/parsers, persistent comment relocation, and proprietary
task-diff UI. It lives in a separate private repository and is linked or bundled
only for full release builds.

Everything else is here: the transport, the end-to-end encryption, the broker
(which is a blind relay and never sees a decrypted payload), the current shared
run records, the HTTP surface, and the auditable thread/worktree/persistence
mechanisms exposed to the private driver through a narrow capability trait.
The workflow scenarios and the HTTP E2E suite live beside that driver as well, so
the public test entry points hold the mechanism tests and a conditional loader
for the private ones — which is why the team suites here look thinner than the
feature is.

```
crates/relay-api             the seam — shared records and capability traits, no logic
crates/sealwire-private      a STUB in this repo; the real crate is private
crates/relay-server          the relay: records, runtime, routes, persistence
```

The crate is named for **what it is** — closed — not for what is currently in it.
Anything else that has to stay closed later arrives as another module inside it
rather than as a second hidden crate, so the swap script, the commit guard, the
ignore rules and the feature flag stay at one each and never need to learn a new
name. The domain names live one level down, in its modules (`task_list`, `team`).

## What a public checkout gets

| | |
|---|---|
| `cargo build` / `cargo test --workspace` | works, nothing private registered |
| `cargo build --features private` | **fails on purpose** — this checkout has no private crate, and a stub that silently satisfied the feature would ship a relay whose task teams quietly do nothing |
| `npm run test:task-team` | skips itself, with a message saying why |
| Task list / task team at runtime | `start_team` refuses with a clear error |

Everything else — sessions, threads, review, workflow, pairing, the broker
protocol, and the crypto — runs and is tested normally. "Review" here means the
ordinary session review flow; the task merge-review surface is part of the
private task product.

## Running without it

You do not need the private crate to develop on this repository, but you do have
to say so. The dev loops (`npm run dev:full`, `dev:restart`) route through
`scripts/with-private.sh`, which **refuses** when no private checkout is present
rather than starting quietly without it: those are the scripts that launch long
running task work, and a relay that came up looking perfectly healthy while
refusing every start is the worse failure. Opt out explicitly:

```bash
RELAY_PUBLIC_ONLY=1 npm run dev:full
```

## How the two halves are told apart

`crates/sealwire-private/STUB` is a marker file the stub carries and the private
crate does not. Present means stub; absent means the private sources are in the
tree. The commit guard, both dev loops and the task-team suite all key off exactly
that, rather than probing for a module name today's private crate happens to have —
a probe like that fails open and silently the day the private side is renamed or
grows something new.

## What this protects, honestly

Not secrecy. A user can open any agent's transcript from the team card, and the
provider CLIs write their own session files to disk, so the prompts a run uses are
visible to anyone who runs one. The relay ships as a binary to user machines, and
the PolyForm Internal Use licence with Sealwire's additional permissions — not
obscurity — limits redistribution and providing it to customers. The same terms
cover the shipped private components.

What a private repository does protect is the **history**: which prompts changed,
when, why, and what was tried and abandoned. That is the part worth having, it only
exists in git, and it is the part that is genuinely hard to reconstruct.
