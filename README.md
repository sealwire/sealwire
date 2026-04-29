# agent-relay

`agent-relay` is a local-first, privacy-first control plane for coding
agents.

The goal is to keep one agent session controllable, resumable, and
trustworthy across browser, phone, and later other surfaces without turning a
broker into the place where your workspace, prompts, and approvals have to
live in plaintext.

The product is currently Codex-first. The local machine remains the execution
authority. The relay is the control layer around that execution:

- start and resume a coding session
- see whether it is running, blocked, or waiting
- handle approvals away from the terminal
- move control between devices without losing the session

## Current status

`agent-relay` is now usable as a single-owner self-hosted MVP with a
privacy-first default.

The recommended deployment shape today is:

- keep `relay-server` on the workstation, VM, or jump host that already has the
  local workspace and logged-in `codex` CLI
- deploy `relay-broker` separately when you want phones or remote browsers to
  attach over LAN or the public internet
- treat the current product as a trustworthy control plane for one operator and
  multiple devices, not as a multi-tenant hosted service

## Use cases

`agent-relay` is built for cases where one coding session already exists
and the problem is control, continuity, and trust rather than raw execution.

Good fits today:

- you want to start or resume a Codex session from a browser without
  moving the workspace off the machine that already owns it
- you want to review approval requests or take over a session from your phone
  while away from the terminal
- you want one long-lived agent session to survive device switches instead of
  creating a fresh session on every surface
- you want to self-host the control plane and keep the execution authority near
  your repo, secrets, and logged-in CLI
- you care about privacy and want the default model to treat the broker as
  transport, not as the place that gets to read everything

Not the current target:

- multi-user hosted collaboration
- untrusted tenants sharing the same control plane
- cloud-first remote execution where the local workstation is optional

## Design principles

The design is intentionally opinionated:

- local-first authority: the machine with the local workspace and Codex session
  remains the source of truth
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

- Codex first, via the official `codex app-server` JSON-RPC protocol
- single owner, multiple devices
- approval-first remote workflow
- web first, native mobile later
- local-first runtime with optional self-hosted or public broker transport

## What exists today

The repository currently includes:

- `crates/relay-server`: Rust API server, Codex bridge, session state, and static web hosting
- `crates/relay-broker`: Rust broker service for remote transport, pairing, and
  public-mode auth/control
- `frontend/`: Vite-based web client source

The current implementation supports:

- starting a Codex session from the browser
- listing saved threads scoped by workspace
- resuming a saved thread
- sending the next user turn from the active device
- streaming session updates over SSE
- handling approval requests from the web UI
- single-owner multi-device control with explicit `take over`
- approval decisions from any owner device
- controller lease and heartbeat handling
- configurable allowed workspace roots with enforced path restrictions
- surfacing locally available Codex models in the web UI via `codex app-server`
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

- a polished hosted deployment story or managed ops for the public broker path
- a formal event log with replay, cursor, and idempotency guarantees
- push notifications or native mobile apps
- team roles, org policy, or enterprise audit workflows
- cloud runners or multi-agent orchestration
- multi-provider support beyond the Codex-first path
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

- Rust toolchain
- `codex` CLI installed and logged in

Testing and CI coverage live in [`TESTING.md`](TESTING.md).
Deployment guidance lives in [`DEPLOYMENT.md`](DEPLOYMENT.md).

### npm package

The repository can be published as an npm CLI package. The published package
contains a small JavaScript wrapper plus platform-specific prebuilt
`relay-server` binaries with the web UI embedded:

```bash
npx agent-relay
```

If a public broker URL is configured by the package publisher, the CLI connects
to it by default. Until then, or for overrides:

```bash
AGENT_RELAY_PUBLIC_BROKER_URL=https://broker.example.com npx agent-relay
```

The npm CLI still requires local Rust/Cargo and a logged-in `codex` CLI. It
stores relay state under the directory where the command is run.

Useful options:

```bash
agent-relay --broker https://broker.example.com
agent-relay --no-broker
agent-relay --host 127.0.0.1 --port 8787
```

With a prebuilt binary package installed, users do not need Rust, Cargo, Vite,
or a local checkout of this repository. The only external runtime dependency is
the local `codex` CLI, which must already be installed and logged in.

During development, if no prebuilt binary is installed, the CLI falls back to
`cargo run --release -p relay-server`. Release builds embed the generated
`web/` assets, so run `npm run build` before compiling a distributable binary.
The `npm Release` GitHub Actions workflow builds binaries for macOS, Linux, and
Windows, stages them under `bin/<platform>-<arch>/`, verifies `npm pack`, then
publishes the package when `NPM_TOKEN` is configured.

Then run:

```bash
cargo run -p relay-server
```

Open `http://localhost:8787`.

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
