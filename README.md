# sealwire

**TL;DR** — Run a long-lived **Codex** or **Claude Code** session on your own
machine, control it from any browser or phone (over LAN or the public
internet), and let one operator move between devices without losing the
session.

- The local machine stays the source of truth; the relay is just the
  control layer around it
- Remote devices can pair through the **hosted public broker** at
  `wss://agent-relay.up.railway.app` — no broker infrastructure to deploy
- Default `private` mode keeps the broker as blind transport: it relays
  encrypted traffic, it doesn't read your prompts, approvals, or code
- **Rust** backend (`relay-server` + `relay-broker`), Node-based Claude Code
  worker, Vite web UI — self-hosted, single-owner, run from source today
  ([Quick start ↓](#quick-start))

---

`sealwire` is a local-first, privacy-first control plane for coding
agents.

The goal is to keep one agent session controllable, resumable, and
trustworthy across browser, phone, and later other surfaces without turning a
broker into the place where your workspace, prompts, and approvals have to
live in plaintext.

The product supports both Codex and Claude Code today. The local machine
remains the execution authority. The relay is the control layer around that
execution:

- start and resume a coding session against Codex or Claude Code
- see whether it is running, blocked, or waiting
- handle approvals away from the terminal
- move control between devices without losing the session

## Quick start

Today `sealwire` runs from source. A published `npx sealwire` package
is planned but not on npm yet, so the steps below are the supported path.

You will need:

- **Rust toolchain** (`cargo`) — to build `relay-server`
- **Node.js 18+** and `npm` — to build the web UI and run the Claude Code
  worker
- **At least one agent CLI**, already installed and logged in:
  - [`codex`](https://github.com/openai/codex) for Codex sessions, and/or
  - [`claude`](https://docs.claude.com/en/docs/claude-code/overview)
    for Claude Code sessions

Then:

```bash
git clone https://github.com/sealwire/sealwire.git
cd sealwire

npm install                            # vite + frontend tooling
(cd claude-worker && npm install)      # only needed for Claude Code sessions

# Config for attaching to the hosted public broker. This file is gitignored.
cat > .env.public.local <<'EOF'
RELAY_BROKER_URL=wss://agent-relay.up.railway.app
RELAY_BROKER_AUTH_MODE=public
EOF

npm run dev:restart:public
```

`npm run dev:restart:public` sources `.env.public.local`, rebuilds the web UI,
and starts `relay-server`. Re-run it anytime to pick up code or config
changes — it kills the previous process first.

Open <http://localhost:8787> and pair a phone or remote browser from the
Settings panel. If you only want a localhost-only setup with no remote pairing,
use `npm run dev:restart:local` (no broker config needed) instead.

The relay treats whatever directory you launched it from as your workspace
root, and stores its state in `.agent-relay/` there.

More detail on each piece — security model, what is and is not built, the full
list of env vars, and the self-hosted broker option — is in the rest of this
README and in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Current status

`sealwire` is now usable as a single-owner self-hosted MVP with a
privacy-first default.

The recommended deployment shape today is:

- keep `relay-server` on the workstation, VM, or jump host that already has the
  local workspace and a logged-in `codex` and/or `claude` CLI
- use the hosted public broker at <https://agent-relay.up.railway.app/> to pair
  phones and remote browsers without running broker infrastructure yourself, or
  self-host `relay-broker` if you prefer to keep that hop under your control
- treat the current product as a trustworthy control plane for one operator and
  multiple devices, not as a multi-tenant hosted service

## Use cases

`sealwire` is built for cases where one coding session already exists
and the problem is control, continuity, and trust rather than raw execution.

Good fits today:

- you want to start or resume a Codex or Claude Code session from a browser
  without moving the workspace off the machine that already owns it
- you want to review approval requests or take over a session from your phone
  while away from the terminal
- you want one long-lived agent session to survive device switches instead of
  creating a fresh session on every surface
- you want to self-host the control plane and keep the execution authority near
  your repo, secrets, and logged-in CLI, while still reaching it remotely
  through a hosted public broker
- you care about privacy and want the default model to treat the broker as
  transport, not as the place that gets to read everything

Not the current target:

- multi-user hosted collaboration
- untrusted tenants sharing the same control plane
- cloud-first remote execution where the local workstation is optional

## Design principles

The design is intentionally opinionated:

- local-first authority: the machine with the local workspace and the Codex or
  Claude Code session remains the source of truth
- privacy-first defaults: the safe path should be the obvious path for people
  who do not want their code, prompts, and approvals copied into a hosted
  middle layer by default
- one operator, many surfaces: browser, phone, and future native clients are
  control surfaces for the same session, not separate runtimes
- approval-first remote UX: remote control must make blocked state, ownership,
  and approval flow obvious instead of pretending the session is stateless
- explicit trust boundaries: broker transport, device identity, and session
  claims are separate concerns; the broker does not become the execution host
- gradual hardening: start with single-owner self-hosting, then add stronger
  replay, audit, and policy guarantees without changing the core model

## Security model

Security is a core part of the product, not a later add-on.

- `private` mode is the default security model: broker-mediated remote traffic
  is end-to-end encrypted and the broker is treated as blind transport rather
  than a content-reading execution layer
- privacy follows from that default: your remote control path can stay usable
  without requiring the broker to see session content in plaintext
- `managed` mode exists for deployments that explicitly want broker or org
  services to read content for audit and policy workflows
- pairing and remote claim flows bind device identity before a remote surface
  can take control of a session
- remote devices keep signing keys in browser-managed crypto storage when
  `WebCrypto` and `IndexedDB` are available, with a compatibility fallback for
  weaker browser contexts
- the relay-server remains the execution authority near the local workspace; the
  broker moves encrypted control traffic rather than hosting the agent itself

## Current focus

- Codex via the official `codex app-server` JSON-RPC protocol
- Claude Code via the official `@anthropic-ai/claude-agent-sdk`
- single owner, multiple devices
- approval-first remote workflow
- web first, native mobile later
- local-first runtime with the hosted public broker at
  <https://agent-relay.up.railway.app/> as the default remote transport, and a
  self-hosted broker as an option

## What exists today

The repository currently includes:

- `crates/relay-server`: Rust API server, provider bridges, session state, and static web hosting
- `crates/relay-broker`: Rust broker service for remote transport, pairing, and
  public-mode auth/control
- `claude-worker/`: Node worker that bridges `@anthropic-ai/claude-agent-sdk`
  into the relay's session protocol
- `frontend/`: Vite-based web client source

The current implementation supports:

- starting a Codex or Claude Code session from the browser
- picking the provider per session from the launch panel
- listing saved threads scoped by workspace
- resuming a saved thread on the provider that owns it
- sending the next user turn from the active device
- streaming session updates over SSE
- handling approval requests from the web UI
- single-owner multi-device control with explicit `take over`
- approval decisions from any owner device
- controller lease and heartbeat handling
- configurable allowed workspace roots with enforced path restrictions
- surfacing locally available Codex and Claude Code models in the web UI
- optional API token auth with `RELAY_API_TOKEN`
- same-site relay auth cookies with CSRF protection for browser flows
- local session persistence for refresh and resume
- security mode plumbing for `private` and `managed`
- broker-backed remote pairing with signed device claims
- public broker enrollment, refresh, revoke, and revoke-others flows
- persisted public broker device grants for restart-safe remote access
- broker message compaction so large session snapshots fit websocket frame limits
- browser-managed remote device keys with `WebCrypto` + `IndexedDB` when available,
  with a compatibility fallback for weaker browser contexts
- broker-served remote shell with installable manifest; the live control surface avoids service worker caching

The current web UI is intentionally simple:

- chat-style thread view
- workspace-scoped history in the sidebar
- launch settings behind a details panel
- session details behind a collapsible drawer

## What is not done yet

The project is usable, but it is still early. It does not yet provide:

- a formal event log with replay, cursor, and idempotency guarantees
- push notifications or native mobile apps
- team roles, org policy, or enterprise audit workflows
- cloud runners or multi-agent orchestration
- providers beyond Codex and Claude Code
- a hardened multi-user product surface for untrusted tenants

## Roadmap direction

Near-term work is focused on making the control plane trustworthy:

- formalize the session and event model
- define replay, cursor, and idempotency behavior
- make mobile web approval and resume fast and honest
- strengthen device identity, pairing, and remote broker transport
- clarify `private` versus `managed` security modes

Longer-term, the plan is to grow from local-first control into:

- hosted relay and remote access
- stronger audit and policy controls
- native mobile only where the web hits real limits
- cloud execution targets and team workflows later

## Run

Requirements:

- Rust toolchain (`cargo`)
- Node.js 18+ and `npm`
- at least one agent CLI, installed and logged in:
  - `codex` CLI (for Codex sessions)
  - `claude` CLI (for Claude Code sessions)

The end-to-end build and run steps live in [Quick start](#quick-start) above.

Testing and CI coverage live in [`TESTING.md`](TESTING.md).
Deployment guidance, including the self-hosted broker option, lives in
[`DEPLOYMENT.md`](DEPLOYMENT.md).

### Planned: `npx sealwire`

A single-command npm release is on the roadmap but **not yet published**. The
wrapper script and `npm Release` GitHub Actions workflow already exist in the
repo — the workflow builds prebuilt `relay-server` binaries for macOS, Linux,
and Windows (with the web UI embedded), stages them under
`bin/<platform>-<arch>/`, and publishes when `NPM_TOKEN` is configured.

Once published, users will be able to skip the Rust toolchain entirely:

```bash
npx sealwire
```

…with the CLI defaulting to the hosted public broker at
<https://agent-relay.up.railway.app/>. Override flags will look like:

```bash
sealwire --broker https://agent-relay.up.railway.app/
sealwire --no-broker
sealwire --host 127.0.0.1 --port 8787
```

Until that release lands, use the from-source steps in
[Quick start](#quick-start).

### Minimal env vars (public broker)

To attach to the hosted public broker, only two variables are required:

```ini
# .env.public.local — gitignored; read by `npm run dev:restart:public`
RELAY_BROKER_URL=wss://agent-relay.up.railway.app
RELAY_BROKER_AUTH_MODE=public
```

`scripts/restart-dev-public.sh` (run via `npm run dev:restart:public`) sources
this file before launching `relay-server`. The `relay-server` binary itself
reads from the process environment and does not auto-load `.env` files, so if
you launch it without the script you will need to `export` the vars or feed
them in some other way (e.g. `direnv`, `dotenv-cli`).

Everything else has a sensible default:

- `RELAY_BROKER_CONTROL_URL` is derived from `RELAY_BROKER_URL`
  (`wss://` becomes `https://`)
- `RELAY_BROKER_PUBLIC_URL` falls back to `RELAY_BROKER_URL`; only set it
  separately when the relay reaches the broker through a different hostname
  than remote devices do (e.g. a Docker network)
- `RELAY_BROKER_PEER_ID` defaults to `local-relay`
- `RELAY_BROKER_REGISTRATION_PATH` and `RELAY_BROKER_IDENTITY_PATH` default to
  `.agent-relay/public-broker-registration.json` and
  `.agent-relay/public-broker-identity.json` under the working directory
- `RELAY_SECURITY_MODE` already defaults to `private`
- `BIND_HOST` and `PORT` already default to `127.0.0.1` and `8787`

`RELAY_BROKER_AUTH_MODE` (how the relay authenticates to the broker) and
`RELAY_SECURITY_MODE` (whether the broker can see session content) are
independent: `auth_mode=public` + `security=private` is the recommended
combination — use the hosted broker for transport, keep payloads end-to-end
encrypted so the broker stays blind to content.

Optional, but useful in practice:

```ini
RELAY_STATE_PATH=.agent-relay/public-session.json
```

This isolates state from any other localhost-only relay you may already run in
the same workspace.

Notes:

- the server binds to `127.0.0.1` by default
- `web/` is generated and gitignored, so build the frontend before running the Rust web servers
- set `BIND_HOST=0.0.0.0` only when you intentionally want network reachability
- set `RELAY_API_TOKEN` to protect `/api` routes
- when `BIND_HOST` is non-loopback, `RELAY_API_TOKEN` is now required by default
- `RELAY_ALLOW_INSECURE_NO_AUTH=1` only exists as an explicit insecure development escape hatch for non-loopback binds
- the local web UI now exchanges `RELAY_API_TOKEN` for an `HttpOnly` same-site session cookie, so normal browser use no longer needs to keep sending the raw token on every request
- direct `Authorization: Bearer ...` API access still works for scripts and manual clients
- relay HTTP responses now send CSP, `Permissions-Policy`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`
- relay CSP keeps `connect-src` wide by default for local/LAN development; set `RELAY_CSP_CONNECT_SRC` only when you want to tighten production origins
- set `RELAY_ENABLE_HSTS=1` only when the relay is actually behind HTTPS and forwards `X-Forwarded-Proto: https`
- set `RELAY_HSTS_VALUE` if you need a narrower HSTS policy than the default `max-age=31536000; includeSubDomains`
- set `RELAY_SECURITY_MODE=private` or `RELAY_SECURITY_MODE=managed` to switch visibility mode
- use `npm run dev` when iterating on the web UI, then `npm run build` to refresh the
  Rust-served assets under `web/`
- use `npm run dev:full` to build the Rust-served frontend once, keep `web/`
  rebuilding on change, and launch relay-server on `8787` plus relay-broker on
  `8788`; when a private LAN IP is available, pairing links default to that LAN address
- use `npm run dev:full:local` if you want localhost-only pairing links and a
  localhost-only broker
- override `RELAY_DEV_SERVER_PORT` or `RELAY_DEV_BROKER_PORT` if those defaults
  are already in use
- if you want to override the detected LAN address, set
  `RELAY_BROKER_PUBLIC_URL=ws://<your-lan-ip>:8788`

## License

This project is source-available under the Elastic License 2.0. See
[`LICENSE`](LICENSE).

## Contributions

By submitting a contribution, you agree to the contribution terms in
[`CONTRIBUTING.md`](CONTRIBUTING.md), including a broad license that allows the
maintainer to relicense contributions in the future.
