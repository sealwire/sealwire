# AGENTS.md

sealwire: a relay that bridges coding-agent providers (codex / claude_code /
fake) to web/mobile frontends. Rust workspace + Node worker + Vite frontend.

## Code map
- `crates/relay-server/` — core. Relay state machine and provider bridges:
  `codex.rs` (native multi-session), `claude.rs` (via the Node worker),
  `fake_provider.rs` (for tests). State/routing live in `src/state/`
  (`relay.rs`, `relay/background.rs`).
- `claude-worker/` — Node worker wrapping `@anthropic-ai/claude-agent-sdk`,
  speaking an NDJSON protocol with Rust over stdin/stdout. `worker.mjs` is the
  main loop.
- `crates/relay-broker | relay-http | relay-util` — public broker / HTTP / utils.
- `frontend/`, `web/` — UI.
- Architecture docs live in `markdown/`: `SESSION_MODEL.md`,
  `PROTOCOL_AND_STORAGE_OVERVIEW.md`, `thread-switch-background-buffer.md`,
  `streaming-delta-plan.md`. Read these before touching the core.
  **`markdown/` is gitignored on purpose** — it is the maintainer's working
  notes, not shipped with the repo. If you cloned this and the directory is
  missing, that is expected: nothing in it is required to build, test, or
  contribute. Do **not** add links into `markdown/` from `README.md` or any
  other tracked doc — they render as dead links on GitHub.

## Code comments

- Write one only when it is really needed, and only to add what the code can't
  say: why this choice, what was ruled out, what breaks if someone changes it.
  Never restate what the code does.
- Usually two lines at most.
- Never point at a document (`markdown/`, `.sealwire/PLAN.md`, tracked docs).
  Put the reason in the comment itself; the code has to make sense on its own.

## Commands (run after changes)
- Rust: `cargo fmt --check` · `cargo check -p relay-server` · `cargo test -p relay-server`
- Worker: `node --check claude-worker/worker.mjs` · `node --test claude-worker/*.test.mjs`
- Frontend / full: `npm test` (includes vite build, heavier)
- Browser e2e (`npm run test:browser:*`) is slow and needs playwright — **don't
  run by default, only when needed**.

## Backward compatibility: not wanted unless asked

Do not add code to keep older formats working — old response shapes, old
protocol fields, old stored state — unless the user explicitly asks for it. When
a change breaks an old shape, change it; do not write a shim or a fallback. A
review finding that only bites an old shape is not a bug to fix. Existing
compatibility code is not a reason to add more of it.

## Rare failures: log them, don't engineer around them

When a failure case is very unlikely (a crash inside a millisecond window, a
disk-full write, a race nobody has seen), do not add recovery machinery for it.
Log it where you can, so it is visible if it ever happens, and let it fail. Extra
state, retries and fallbacks for such cases cost more than the failure does. A
review finding that only bites such a case is not a bug to fix. This does not
cover cases that lose or corrupt data, or break security.

## Driving the relay from a script

**Do not stop, kill, or restart the user's relay** (`relay-server` on port 8787
or whatever `npm run dev:full` is using) unless they explicitly ask you to. A
running relay holds live team drivers, provider sessions, and in-memory state
that a restart disrupts; editing `~/.sealwire/sealwire.db` underneath it puts
rows on disk that its in-memory state no longer matches. Prefer the HTTP
API (`revise`, `confirm`, `dismiss`, orchestrator tools) against the live
instance. To test changes in isolation, spin up a **separate** relay on another
port with its own `RELAY_STATE_DB` (see below) — never touch the one the user
is working through.

The relay is a plain JSON HTTP API on `127.0.0.1:8787` (`npm run dev:full`), so
an agent can drive it without a browser. The relay only listens on loopback;
remote clients connect through a broker. Send `X-Agent-Relay-CSRF: 1` on
mutating requests. The local API has no token login or cookies. Every mutating call needs a
non-empty `device_id` — any string; pairing is for remote clients.

- `GET /api/health`, `GET /api/session` — the snapshot everything else reads back
  from (`beta_features_enabled`, `orchestrator_thread_id`). Pending proposal cards
  are `GET /api/orchestrator/proposals`; the snapshot carries only their revision.
- `POST /api/session/message` `{text, thread_id, device_id}` — send a turn.
- `POST /api/session/start`, `GET /api/threads`, `GET /api/providers/:p/models`.

`scripts/verify-orchestrator-mcp.mjs` is the worked example: it boots a relay on
a free port with its own `RELAY_STATE_DB` and drives it end to end. Copy that
rather than re-deriving it, and give your relay its own port and state path so it
cannot disturb one already running.

## Turning Tasks and Task Teams on

Both are **beta-gated and need two things at once**: a build with
`--features private` AND `SEALWIRE_BETA=1`. Either alone leaves
`beta_features_enabled: false` and every task route refuses with a message that
reads like a product limit rather than a missing build.

```sh
scripts/with-private.sh cargo build -p relay-server --features private
SEALWIRE_BETA=1 target/debug/relay-server
```

`npm run dev:full` already does both when the private crate is present. The
workspace must also be trusted before a team run may start — `POST
/api/workspace/trust {cwd, trusted: true}`, plus `POST /api/allowed-roots`.

Then, driving it:

- `POST /api/orchestrator/ensure {device_id}` → the Orchestrator thread id.
  Message that thread and it decides what to do; it only ever stages a **card**.
- `GET /api/orchestrator/tools`, `POST /api/orchestrator/tools/:name/call`
  `{arguments, device_id}` — the same tools, callable directly. Refusals come
  back as `200` with `isError: true` and a readable reason.
- `POST /api/orchestrator/proposals/:id/confirm {device_id}` — **the only thing
  that starts work.** No tool starts a run; confirming is the user's.
- `GET /api/session/teams` — every run, with phase and per-sub-task status.

The task-team engine itself — the driver loop and the role prompts — lives in the
`sealwire-private` crate, swapped into `crates/sealwire-private/` by
`scripts/with-private.sh`. Its public seams are `orchestrator_tools.rs` (the tool
registry), `state/app/orchestrator_dispatch.rs` (handlers) and `state/app/team.rs`
(run lifecycle); a public checkout has the stub and everything above degrades to
a clear refusal. See `PRIVATE_CRATE.md`.

## Verifying in a real browser

For anything about layout, width, or what is actually on screen, drive a real
browser — do not reason from the cascade, and do not add a source-level CSS
guard, which stays green through real bugs.

- `scripts/live-browser.mjs` — opens the **real system Chrome** and screenshots.
- `scripts/e2e/harness/browser.mjs` — headless Chromium for CI-shaped tests;
  `scripts/e2e/harness/project-switcher.mjs` and
  `scripts/browser-remote-mobile-header-e2e.mjs` are the header/phone references.
- `npm run test:browser:android` — the Android-web viewport suite.

**`innerText` is not evidence.** Chromium returns the full string even when CSS
has clipped it to an ellipsis, so a DOM assertion can pass on text nobody can
read. Prove it with a screenshot, or with `scrollWidth` vs `clientWidth` /
`getBoundingClientRect`.

## Committing

**Use `scripts/commit.sh` instead of `git commit`.** It takes the same
arguments (`scripts/commit.sh -m "…"`) and forwards them.

Why: while `npm run dev:full` is running, `crates/sealwire-private/` holds the
real private sources, and the commit hook refuses every commit — correctly, and
often at a moment when stopping the relay is not an option. `scripts/commit.sh`
puts the public stub back for the length of one commit, runs `git commit` with
the hook **active and unmodified**, and restores the private sources from a
snapshot afterwards. Its only lasting effect is the commit. On an unswapped tree
it is a straight pass-through, so it is always the right thing to reach for.

**Never `git commit --no-verify`.** It commits the index with no check at all,
and committing the private sources is the one mistake here that a revert does
not undo.

Two things that are easy to get wrong even when being careful:

- **Edits inside `crates/sealwire-private/` are destroyed** when the dev server
  stops — the swap is a one-way copy in, and it restores the stub on exit. That
  crate's source of truth is the separate private checkout; edit there.
- **The commit hook only inspects the working tree**, so it cannot see a private
  source that was `git add`ed. `scripts/commit.sh` covers that gap by comparing
  each staged blob under the crate against the private checkout; a byte-identical
  match is refused. A public placeholder at the same path is allowed, because
  every new public seam needs one committed.
