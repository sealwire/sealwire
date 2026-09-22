<p align="center">
  <img src="docs/images/logo.png" width="64" height="64" alt="sealwire logo">
</p>

<h1 align="center">Sealwire</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/sealwire">
    <img src="https://img.shields.io/npm/v/sealwire?style=flat&logo=npm" alt="npm version">
  </a>
  <a href="https://github.com/sealwire/sealwire/stargazers">
    <img src="https://img.shields.io/github/stars/sealwire/sealwire?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Elastic--2.0-555" alt="License">
  </a>
</p>

<p align="center">A software agent team on your own machine. Building and managing from anywhere.</p>

<p align="center">
  <img src="docs/images/desktop-session.png" alt="sealwire desktop: session list, live transcript, workspace diff" width="100%">
</p>

- **Cross-agent review:** ask a *different* agent to review the current changes
  in its own session. Claude Code reviews Codex, Codex reviews Claude. Findings
  and a verdict land back in your thread — optionally looping reviewer ↔ author
  until it approves.
- **No registration required:** you don't need an account, and everything still
  stays safe and private.
- **Follows you across devices:** one session, many surfaces. Move between
  laptop, browser, and phone without losing the flow. Web push tells you when it needs a decision.
- **Privacy-first:** your code never leaves your machine. `private` mode is the
  default and treats the broker as blind transport — it relays encrypted
  traffic, and nobody can read your session or your code.
- **Two providers, one interface:** Codex via the official `codex app-server`
  protocol, Claude Code via the official `@anthropic-ai/claude-agent-sdk`.
- **Self-hosted broker:** if you're extra tech-savvy, you can deploy your own
  broker — as long as it's for your own use.

## Getting started

sealwire runs a local **relay-server** next to your workspace. The web UI, your
phone, and any other browser are clients that connect to it.

### Prerequisites

At least one agent CLI, authenticated:

- **[Codex](https://github.com/openai/codex)** — the `codex` CLI installed and
  logged in.
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — Claude auth
  only: an `ANTHROPIC_API_KEY` or an existing Claude Code login. The worker (and
  its bundled Claude Code CLI) ships inside the package, so `claude` does **not**
  need to be on your PATH.

### npx (recommended)

```bash
npx sealwire
```

That starts a **localhost-only** relay on <http://localhost:8787> and opens the
web UI as soon as it's ready.

sealwire treats the directory you launched it from as the default workspace for
new sessions. Its own state, including sessions, projects and paired devices, lives in
`~/.agent-relay/`, one set per machine.

Run that same command on whatever machine is already always-on — a desktop, a
home server, the VM that holds the repo — and long work keeps going with your
laptop shut, reachable from anywhere you've paired. There is nothing to deploy:
the relay wants to sit next to the workspace and the logged-in CLI, so a box you
already own beats a container.

### Pair a phone

```bash
sealwire cloud
```

Attaches to the hosted SealWire Cloud broker (`wss://app.sealwire.dev`) so
remote devices can pair — no infrastructure to deploy. You can point `--broker`
at a self-hosted `relay-broker` instead, or use `sealwire local` to guarantee the
relay never dials out.

## Cross-agent review

A single model marking its own homework is weak. sealwire makes review a
first-class action: pick the reviewer's provider and model, brief it, and let it
run in its own session against the current workspace diff.

<p align="center">
  <img src="docs/images/desktop-request-review.png" alt="The Request review dialog: reviewer provider, model, effort, reuse an existing reviewer session, instructions, briefing mode, and maximum rounds" width="100%">
</p>

It posts its findings — and a machine-readable `VERDICT:` — straight back into
the thread you were working in. Set **maximum rounds** above 1 and the reviewer
and author keep iterating until the reviewer approves or the rounds run out.

<p align="center">
  <img src="docs/images/desktop-review.png" alt="A reviewer agent's findings posted back into the author's thread, ending with VERDICT: NEEDS_CHANGES" width="100%">
</p>

## Control from anywhere

Blocked work shouldn't wait for you to walk back to the terminal. Pair a phone
and the same session shows up there — the approval in full, and a **Take over**
button that moves control to the device in your hand.

<p align="center">
  <img src="docs/images/phone-approval.png" alt="The remote surface on a phone: an approval request with the full command and inline Approve and Deny, after claiming control of the session from this device" width="400">
</p>

The remote surface is an installable PWA, so it can live on your home screen and
get **web push** — a notification when a session needs input, finishes, or
errors. The relay is the control layer around your agent team, and the broker
just moves encrypted traffic.

## Also in the box

- **Projects and workspaces** — group sessions by repo, with a per-workspace
  diff panel and one-click apply for individual file changes.
- **Session tabs, pinning, and rename** — several live sessions side by side.
- **Fork a thread** from any message to explore an alternative without losing
  the original.
- **Server-side search and an activity bell** across sessions, so a backgrounded
  agent that needs you doesn't get lost.
- **Code Flow** — chain execute → review → revise across two agents, looped up to
  a round limit.
- **Takeover** — claim a session from another device mid-flight, with the
  handover made explicit rather than silent.
- **Permission modes** per session, from bypass to approve-everything.

## CLI

```bash
sealwire                    # localhost-only relay, opens the web UI
sealwire local              # never attach to a broker; remote pairing disabled
sealwire cloud              # attach to the hosted SealWire Cloud broker so a phone can pair
sealwire --broker https://broker.example.com   # use your own broker
sealwire --port 8788 --host 127.0.0.1          # bind address / port
sealwire --no-open          # don't open a browser
sealwire --beta             # unlock in-development features (currently: Tasks)
```

`sealwire --help` has the full list, including binary resolution and env vars.

Unfinished features are off by default and show a blurred *in development*
preview rather than being hidden; `--beta` (or `SEALWIRE_BETA=1`) turns them on
and combines with any other flag.

## Development

| Package | What it is |
|---|---|
| `crates/relay-server` | The core. Relay state machine and provider bridges (`codex.rs`, `claude.rs`, `fake_provider.rs`). |
| `crates/relay-broker` | The public broker: blind transport for remote pairing. |
| `crates/relay-http`, `crates/relay-util` | Shared HTTP and utilities. |
| `claude-worker/` | Node worker wrapping `@anthropic-ai/claude-agent-sdk`, speaking NDJSON with Rust. |
| `frontend/`, `web/` | Vite web UI — local and remote surfaces. |
| `src-tauri/` | macOS desktop app (preview). |

```bash
cargo fmt --check && cargo check -p relay-server && cargo test -p relay-server
node --check claude-worker/worker.mjs && node --test claude-worker/*.test.mjs
npm test                       # frontend unit tests + vite build
npm run test:browser:install   # chromium, once
```

[`AGENTS.md`](AGENTS.md) has the code map and the commands to run after a
change; [`docs/testing-matrix.md`](docs/testing-matrix.md) covers what each
suite actually exercises. The task-team orchestration privacy boundary is
documented in
[`docs/content-blind-orchestration.md`](docs/content-blind-orchestration.md).

## Current focus

**Long, persistent task lists.** Give the agent an ordered list of tasks and let
it work through them autonomously over hours: each task is one Code Flow (author
executes, reviewer reviews, author revises), git-committed on approval so the
next task starts from a clean tree. The data model and the serial driver are in;
persistence and restart recovery, the git checkpoint after each approved task,
the HTTP/broker surface, and the UI are the work in progress.

Also in focus:

- cross-agent review: single-shot and multi-round reviewer ↔ author loops
- single owner, many devices; approval-first remote control that follows you
- web first: the remote surface is an installable PWA with push; the macOS
  desktop app is a preview and there is no native mobile app
- local-first runtime, with the hosted SealWire Cloud broker as the default remote
  transport and a self-hosted broker as an option

## Roadmap

- a formal append-only event log with replay cursors. Today there are
  duplicate-safe remote actions and self-healing transcript deltas, which is
  weaker than real delivery guarantees
- audit logging for `managed` mode — the mode is selectable, the audit trail
  behind it is not written yet
- providers beyond Codex and Claude Code
- native mobile, only where the web hits real limits
- later: team workflows

Not on the roadmap today: multi-user hosted collaboration, untrusted tenants
sharing one control plane, or org policy controls.

## Security

`private` mode is the default: broker-mediated traffic is end-to-end encrypted
and the broker is treated as blind transport. `managed` mode exists for
deployments that explicitly want broker or org services to read content. Details
in [`docs/security-model.md`](docs/security-model.md).

## License

Source-available under the Elastic License 2.0. See [`LICENSE`](LICENSE).

## Contributions

By submitting a contribution you agree to the terms in
[`CONTRIBUTING.md`](CONTRIBUTING.md), including a broad license that allows the
maintainer to relicense contributions in the future.
