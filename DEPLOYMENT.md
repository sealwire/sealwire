# Deployment

## Hosted Cloud vs self-host OpenAccess

Two different products share related code; do not confuse them:

| | SealWire Cloud (hosted) | Public self-host broker |
|--|-------------------------|-------------------------|
| How users attach | `npx sealwire cloud` (or `RELAY_BROKER_URL` to the hosted origin) | You run your own broker |
| Binary | **`sealwire-broker-private`** (private repo, commercial license policy) | Public **`relay-broker`** (`docker/broker.Dockerfile`) |
| Deploy config | Private repository only | Explicit example: `examples/self-host-broker/` |
| Default in this repo | **No** root Railway config / **no** auto-deploy workflow | Docker Compose / example Railway.toml you opt into |

The public repository must **not** automatically deploy OpenAccess `relay-broker`
onto the hosted Cloud service. There is intentionally **no** root `railway.toml`
and **no** GitHub Action that runs `railway up` for the broker.

## Recommended shape

The recommended deployment model today is:

- run `relay-server` on the workstation, VM, or jump host that already has the
  real workspace and logged-in `codex` CLI
- deploy `relay-broker` separately when you want phones or remote browsers to
  attach over LAN or the public internet

The broker is the easiest piece to deploy first because it does not run Codex
or touch your workspace directly.

## Local development

For local development, `npm run dev:full` launches:

- Vite on `5173`
- `relay-server` on `8787`
- `relay-broker` on `8788`

When a private LAN IP is available, pairing links default to that LAN address.
Use `npm run dev:full:local` if you want localhost-only pairing links and a
localhost-only broker.

### Run from source

Running from source is the path for contributors, or for any platform without a
prebuilt binary. You will need:

- **Rust toolchain** (`cargo`) — to build `relay-server`
- **Node.js 18+** and `npm` — to build the web UI and run the Claude Code
  worker
- **Agent auth** for whichever provider you use:
  - Codex: the [`codex`](https://github.com/openai/codex) CLI installed and
    logged in
  - Claude Code: an `ANTHROPIC_API_KEY`, or an existing
    [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) login
    (no separate `claude` CLI required)

Then:

```bash
git clone https://github.com/sealwire/sealwire.git
cd sealwire

npm install                            # vite + frontend tooling
(cd claude-worker && npm install)      # only needed for Claude Code sessions

# Config for attaching to the hosted public broker. This file is gitignored.
cat > .env.cloud.local <<'EOF'
RELAY_BROKER_URL=wss://agent-relay.up.railway.app
RELAY_BROKER_AUTH_MODE=public
EOF

npm run dev:restart:cloud
```

`npm run dev:restart:cloud` sources `.env.cloud.local` (falling back to the
legacy `.env.public.local`), rebuilds the web UI, and starts `relay-server`.
Re-run it anytime to pick up code or config changes — it kills the previous
process first.

Open <http://localhost:8787> and pair a phone or remote browser from the
Settings panel. If you only want a localhost-only setup with no remote pairing,
use `npm run dev:restart:local` (no broker config needed) instead.

The product overview — what sealwire is, the security model, and what is and is
not built yet — is in [`README.md`](README.md); testing and CI in
[`TESTING.md`](TESTING.md).

### Desktop app (preview)

The macOS desktop shell is a Tauri app that supervises the existing
`relay-server` binary as a sidecar. It keeps the local and remote web surfaces
as separate native webview windows and adds a small control window for workspace
selection, broker mode, restart/stop, and relay logs.

```bash
npm run desktop:dev
npm run desktop:check
npm run desktop:build
```

The desktop scripts build the Vite web assets, compile `relay-server`, download
and verify a fixed Node.js LTS runtime, stage `claude-worker` with production
dependencies, and copy the sidecars into `src-tauri/binaries/` with Tauri's
target-triple sidecar names. Generated sidecars, runtime caches, staged
resources, and bundles are ignored by git.

## `npx sealwire`

`sealwire` is published on npm, so on macOS you can skip the Rust toolchain
entirely:

```bash
npx sealwire
```

The `npm Release` GitHub Actions workflow builds a prebuilt `relay-server`
binary (with the web UI embedded), stages it under `bin/<platform>-<arch>/`,
and publishes when `NPM_TOKEN` is configured. **Only macOS binaries
(`darwin-arm64`, `darwin-x64`) ship today** — the Linux and Windows targets are
temporarily commented out in the workflow while they're untested. On those
platforms `npx sealwire` still runs, but it falls back to building
`relay-server` from source via Cargo.

By default `npx sealwire` starts a **localhost-only** relay; it does not attach
to a broker unless you tell it to. Commands and flags:

```bash
# pair remote devices through the hosted licensed Cloud broker
sealwire cloud                          # attach to hosted Cloud (default
                                        # wss://agent-relay.up.railway.app)
                                        # — commercial policy runs server-side;
                                        # this public package never ships it
sealwire --broker wss://agent-relay.up.railway.app  # or point at your own self-host broker

sealwire local                          # no broker (alias for --no-broker)
sealwire --no-broker                    # same: run without a broker
sealwire --host 127.0.0.1 --port 8787   # bind address / port
sealwire --no-open                      # do not open the browser automatically
```

You can also set `AGENT_RELAY_PUBLIC_BROKER_URL` instead of passing `--broker`.
By default the launcher waits for the newly started relay to identify itself
through its health check, then opens its local web UI in your default browser.
It skips browser opening in CI; pass `--no-open` to disable it explicitly in
any environment.

The `local` command (and `--no-broker`) is an explicit "stay offline" request:
it ignores any configured broker origin **and** strips every `RELAY_BROKER_*`
variable from the environment — case-insensitively, so a stray `relay_broker_url`
on Windows can't sneak back in — before starting the relay. It does not change
the bind host; pass `--host` if you need to control network exposure.

## Relay env vars

To attach to the hosted public broker, only two variables are required:

```ini
# .env.cloud.local — gitignored; read by `npm run dev:restart:cloud`
RELAY_BROKER_URL=wss://agent-relay.up.railway.app
RELAY_BROKER_AUTH_MODE=public
```

`scripts/restart-dev-cloud.sh` (run via `npm run dev:restart:cloud`) sources
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
  the relay's state directory, alongside `session.json`
- `RELAY_SECURITY_MODE` already defaults to `private`
- `BIND_HOST` and `PORT` already default to `127.0.0.1` and `8787`

`RELAY_BROKER_AUTH_MODE` (how the relay authenticates to the broker) and
`RELAY_SECURITY_MODE` (whether the broker can see session content) are
independent: `auth_mode=public` + `security=private` is the recommended
combination — use the hosted broker for transport, keep payloads end-to-end
encrypted so the broker stays blind to content.

Relay state (sessions, projects, paired devices, broker identity) lives in one
place per machine — `~/.agent-relay/` — so it does not fork when you launch
from a different folder. Leave `RELAY_STATE_PATH` unset unless you want an
isolated throwaway relay; see
[`DEPLOYMENT.md`](DEPLOYMENT.md#relay-state-location) for the details.

Notes:

- the server binds to `127.0.0.1` by default
- `web/` is generated and gitignored, so build the frontend before running the Rust web servers
- set `BIND_HOST=0.0.0.0` only when you intentionally want network reachability
- set `RELAY_API_TOKEN` to protect `/api` routes
- when `BIND_HOST` is non-loopback, `RELAY_API_TOKEN` is now required by default
- `RELAY_ALLOW_INSECURE_NO_AUTH=1` only exists as an explicit insecure development escape hatch for non-loopback binds
- **`RELAY_ALLOWED_HOSTS` — read this if you run the relay behind a reverse proxy.** The relay now refuses any request whose `Host` header is not one it recognises, answering `421 Misdirected Request`. This is the DNS-rebinding defence: after a rebind the browser still sends the attacker's hostname, so an `Origin` check cannot catch it (the expected origin is *derived* from `Host`, and the two agree) — only pinning the hostname does.
  - always accepted: `localhost`, anything in `127.0.0.0/8`, `::1`, and a non-loopback `BIND_HOST`'s own address
  - enforced when `BIND_HOST` is loopback (the default) **or** when `RELAY_ALLOWED_HOSTS` is set
  - not enforced when `BIND_HOST` is non-loopback and `RELAY_ALLOWED_HOSTS` is unset, since the external hostname cannot be guessed and those binds already require a token
  - **migration:** if nginx/Caddy proxies to a loopback-bound relay while preserving the external `Host` (`proxy_set_header Host $host`, which is Caddy's default), every request starts returning 421 after upgrading. Set `RELAY_ALLOWED_HOSTS=relay.example.com` (comma-separated for several names, port optional). The alternative is to have the proxy send the relay's own name instead (`proxy_set_header Host $proxy_host`).
  - a refused request is logged with the `Host` it carried, so a hosts-file alias that stops working is diagnosable rather than mysterious
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

## Relay state location

`relay-server` keeps its durable state in **one directory per machine**:
`~/.agent-relay/`. The directory you launch from is the default *workspace* for
new sessions (each session stores its own `cwd`, and the UI groups sessions by
folder) — it does not select which state you get. Launching from a second
folder therefore continues the same sessions, projects, and paired devices
rather than starting a blank relay.

Four files make up that state, and they are **one identity set**:

| File | What it holds |
|---|---|
| `session.json` | sessions, projects, paired devices, per-thread settings |
| `public-broker-registration.json` | relay id + refresh token for the public broker |
| `public-broker-identity.json` | the relay's long-lived signing seed |
| `vapid.key` | Web Push key; losing it invalidates every phone subscription |

`RELAY_STATE_PATH` moves `session.json`, and the other three follow it into the
same directory. Use it for an isolated, throwaway relay:

```ini
RELAY_STATE_PATH=/tmp/sealwire-scratch/session.json
```

The per-file overrides (`RELAY_BROKER_REGISTRATION_PATH`,
`RELAY_BROKER_IDENTITY_PATH`, `RELAY_VAPID_KEY_PATH`) exist for split setups,
but pointing one **outside** the state directory splits the identity set: the
relay can then fail to find its registration, enroll as a brand-new relay, and
orphan already-paired devices. It is honoured, with a warning at startup naming
the variable and where the file landed. A wholly relative configuration (a
relative `RELAY_STATE_PATH` *and* relative sibling paths, as
`scripts/restart-dev-cloud-pg.sh` uses) moves as one unit and is not a split.

There is no migration from older per-directory state: if the shared location
has no `session.json`, the relay starts a fresh one.

Only one relay may run against a given state file — a second start refuses with
a message pointing at the running one instead of corrupting the file. With
shared state that means one relay per machine by default; give a second relay
its own `RELAY_STATE_PATH` to run it alongside.

## Self-hosted broker (OpenAccess)

Build and run the **public** `relay-broker` image (not SealWire Cloud):

```bash
docker compose up --build relay-broker
```

Or directly with Docker:

```bash
docker build -f docker/broker.Dockerfile -t agent-relay-broker .
docker run --rm -p 8788:8788 -e BIND_HOST=0.0.0.0 agent-relay-broker
```

For an explicit Railway self-host layout (volume, VAPID path, single replica),
see [`examples/self-host-broker/`](examples/self-host-broker/). That example is
opt-in; copying it is a conscious choice and never the hosted Cloud deploy path.

Then point your local relay-server at that broker:

```bash
RELAY_BROKER_URL=ws://127.0.0.1:8788 \
RELAY_BROKER_PUBLIC_URL=ws://192.168.1.105:8788 \
RELAY_BROKER_CHANNEL_ID=dev-room \
RELAY_BROKER_PEER_ID=local-relay \
RELAY_BROKER_TICKET_SECRET=change-me \
cargo run -p relay-server
```

Notes:

- `RELAY_BROKER_AUTH_MODE` defaults to `self_hosted`
- `relay-server` still expects local Codex access and a real workspace, so it
  is usually better to run it on the machine that already owns the repo and CLI
  session
- when the broker is only locally reachable from the relay host, set
  `RELAY_BROKER_PUBLIC_URL` to the LAN or public `ws://` / `wss://` address that
  remote phones and browsers should use for pairing
- `RELAY_BROKER_URL` and `RELAY_BROKER_PUBLIC_URL` should still point at the
  same broker instance; they only differ in how the relay host versus remote
  devices reach that broker
- `RELAY_BROKER_TICKET_SECRET` must match on both the broker and relay-server
  in `self_hosted` mode
- `RELAY_BROKER_DEVICE_JOIN_TTL_SECS` is optional in `self_hosted` mode. If it
  is unset, paired-device broker join tickets stay valid until revoke; if it is
  set, saved remote access expires after that many seconds and requires
  re-pairing

## Public broker mode

`public` broker auth runs as a hosted auth plane inside the broker service
itself. In that mode, the broker issues short-lived websocket access tokens
over HTTP and verifies them itself; the relay no longer signs broker join
tickets directly.

`public` mode uses a hosted control-plane API on the broker itself.

Broker env:

- `RELAY_BROKER_AUTH_MODE=public`
- `RELAY_BROKER_PUBLIC_ISSUER_SECRET`
- `RELAY_BROKER_PUBLIC_STATE_PATH` in production or any non-loopback bind
- optional `RELAY_BROKER_PUBLIC_STATE_PATH` for localhost-only development
- optional `RELAY_BROKER_PUBLIC_POSTGRES_URL` — durable control-plane state in
  Postgres instead of the JSON file (set exactly one of state path or Postgres URL)
- optional `RELAY_BROKER_PUBLIC_POSTGRES_RELOAD_BEFORE_USE=1` — **cross-instance
  revocation visibility** (NOT full HA). With a single broker process the
  in-memory control plane is authoritative and the broker skips reloading from
  Postgres before every operation (much lower QR / approval / login latency). Set
  this to `1` if more than one broker process can run against the same database at
  once — including brief blue/green or rolling-deploy overlap — so each instance
  re-reads committed state before every op; otherwise a revoke or credential
  rotation on one instance is not observed by another until it restarts. NOTE:
  this only bounds how stale a *read* can be. It does NOT serialize cross-instance
  invariants — operations are still read-modify-write outside the SQL transaction,
  so e.g. two instances can each pass the same device-limit check and both insert
  a grant. True multi-broker HA needs database-level locking, which this flag does
  not provide. A single-replica self-host deployment (`examples/self-host-broker/railway.toml`
  `numReplicas = 1`, no deploy overlap) does not need it.
- optional `RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS`
- optional `RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS`

Optional hardening env:

- `RELAY_BROKER_PUBLIC_API_RATE_LIMIT_PER_MINUTE`
- `RELAY_BROKER_JOIN_RATE_LIMIT_PER_MINUTE`
- `RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE` — surface peers (default 240)
- `RELAY_BROKER_RELAY_PUBLISH_RATE_LIMIT_PER_MINUTE` — relay peers (default 36000).
  Relays are first-party and an order of magnitude busier than a surface: transcript
  deltas alone batch into a 100ms window and publish one frame each. Going over makes
  the broker **drop that frame**, which the relay treats as fatal: it ends the session
  and reconnects to resync rather than carry on with a hole in what the surface
  received. Setting this below real traffic therefore causes repeated reconnects, not
  just slowdown — and the broker's window is keyed by peer, so it does not reset when
  the relay reconnects. It bounds frames, not bytes — see the byte budgets below for that.
  Leaving it unset while the generic limit above **is** set keeps the generic limit
  governing relays, so an already-tightened deployment is not widened by upgrading.
- `RELAY_BROKER_PUBLISH_BYTES_PER_MINUTE` — surface peers (default 8MiB)
- `RELAY_BROKER_RELAY_PUBLISH_BYTES_PER_MINUTE` — relay peers (default 512MiB).
  The bandwidth counterpart to the frame allowances: a frame count is a poor proxy for
  size, and 36000 frames at the 64KiB cap is ~2.2GiB/min from one peer. The relay default
  is ~6.8x the chunked-reply ceiling of **75MiB/min**, leaving room for transcript deltas
  and snapshots running alongside it.
  **Do not re-derive that ceiling from the 32KiB chunk target.** That is a *payload* size,
  and the frame carrying it is bigger. The 75MiB/min figure is instead
  `RELAY_BROKER_MAX_TEXT_FRAME_BYTES` x the 50ms publish cadence — an upper bound, because
  the relay's chunk builders shrink a chunk until its frame fits that cap, and the writer
  paces chunks that far apart *including across consecutive replies*.
  **The same fatal-on-refusal caveat applies as for the frame limit, and matters more
  here**: a refused relay publish ends the session, and the resync sends a full snapshot —
  so a budget set near real traffic reconnects in a loop and spends more bandwidth than it
  saves. Set to `0` to disable the byte budget entirely. Follows the same migration rule: an
  explicitly set generic byte budget governs relays until the relay-specific one is set.
- `RELAY_BROKER_PUBLISH_BURST_BYTES` / `RELAY_BROKER_RELAY_PUBLISH_BURST_BYTES` —
  burst is a **separate quota** from the rate: how much a peer may publish back-to-back
  after idling (defaults 2MiB / 16MiB). Without it the first large reply after a quiet
  period is refused, which is exactly when one is most likely. A burst below
  `RELAY_BROKER_MAX_TEXT_FRAME_BYTES` is raised to it, since a smaller one could never
  afford a single frame the broker itself accepts.
- Global egress (measured **after** fan-out, so a broadcast counts once per recipient) is
  **observed, not enforced**. Refusing on a global condition would punish a peer for its
  neighbours' traffic, and for a relay that means a teardown whose resync adds egress —
  the control would amplify the overload it fired on. It is counted, and a minute above
  2GiB logs a warning. Watch `publish_limits.peak_egress_bytes_per_minute` on
  `/api/admin/stats` before deciding whether enforcement is ever warranted.
  Its scope is **`ServerMessage` bytes written to client sockets** — welcomes, presence,
  messages and errors, including the error sent to a rejected join. Within that scope it is
  exact rather than modelled: counted where each frame is serialized on its way out, so
  fan-out is included by construction and a frame that failed to send is not counted. It
  deliberately excludes WebSocket **control** frames (ping/pong), which carry no
  application payload, so this is what the broker was asked to deliver rather than raw
  socket throughput.
- Both allowances are keyed on the **authenticated ticket identity** (`device_id` /
  `pairing_id`), not on the broker-assigned `peer_id`. A surface gets a fresh `peer_id`
  on every join, so keying on that would let any surface reset its budget by reconnecting.
  A consequence worth knowing: two tabs on the same device share one budget.
- `RELAY_BROKER_MAX_CONNECTIONS_PER_IP`
- `RELAY_BROKER_MAX_TEXT_FRAME_BYTES` — **has a 64KiB floor**, and values below it are
  raised with a warning rather than honoured. relay-server fits every chunk against a fixed
  64KiB limit compiled into its binary and never learns this setting, so a smaller cap does
  not make relay frames smaller — it rejects them, and the broker closes the socket on
  `frame_too_large`, so the reconnect replays the same reply and fails identically. Raising
  the value above 64KiB works normally.
- `RELAY_BROKER_IDLE_TIMEOUT_SECS`
- `RELAY_BROKER_CSP_CONNECT_SRC` when you want production `connect-src` tighter
  than the default dev/LAN-friendly policy
- `RELAY_BROKER_ENABLE_HSTS=1` only behind HTTPS with
  `X-Forwarded-Proto: https`
- `RELAY_BROKER_HSTS_VALUE` if you need a custom HSTS policy instead of
  `max-age=31536000; includeSubDomains`

Relay-server env:

- `RELAY_BROKER_AUTH_MODE=public`
- optional `RELAY_BROKER_CONTROL_URL`
- optional `RELAY_BROKER_REGISTRATION_PATH`
- optional `RELAY_BROKER_IDENTITY_PATH`

A relay without a cached registration now generates a local Ed25519 identity,
requests a short-lived enrollment challenge from the broker, signs it locally,
and caches the resulting `relay_id`, `broker_room_id`, and
`relay_refresh_token` in `RELAY_BROKER_REGISTRATION_PATH` automatically.

In `public` mode, approved devices now receive:

- a short-lived broker websocket token
- a long-lived `device_refresh_token`
- the remote web surface immediately exchanges that refresh token for an
  `HttpOnly` broker cookie and then uses the cookie to rotate broker access
  instead of forcing re-pairing on every websocket token expiry
- when the browser supports `WebCrypto` + `IndexedDB`, the remote surface keeps
  its device signing key in browser-managed crypto storage instead of a
  `localStorage` string; legacy or non-secure contexts still fall back to the
  older storage path
- browser `localStorage` keeps only durable device metadata plus the current
  `device_token`; it no longer persists the refresh token, broker websocket
  token, or `session_claim`

Public-mode device refresh grants are persisted via
`RELAY_BROKER_PUBLIC_STATE_PATH`; when the broker binds to a non-loopback host,
startup now requires that path so refresh survives restart and revoke remains
effective.

The broker remote surface is installable as a PWA. Open the broker root, then
use your browser's install action to pin it on a phone or desktop.

Pairing and encrypted broker traffic work on plain LAN `http://` pages, but
service worker registration still only works on `https://` origins or
`localhost`.

Public mode example:

```bash
RELAY_BROKER_AUTH_MODE=public \
RELAY_BROKER_PUBLIC_ISSUER_SECRET=change-me \
RELAY_BROKER_PUBLIC_STATE_PATH=/var/lib/agent-relay/public-control.json \
docker compose up --build relay-broker
```

```bash
RELAY_BROKER_URL=wss://broker.example.com \
RELAY_BROKER_PUBLIC_URL=wss://broker.example.com \
RELAY_BROKER_CONTROL_URL=https://broker.example.com \
RELAY_BROKER_AUTH_MODE=public \
RELAY_BROKER_PEER_ID=local-relay \
cargo run -p relay-server
```

On first startup without a cached registration, the relay creates a local
broker identity, requests an enrollment challenge from the broker, signs it,
and caches the returned registration automatically. No shared broker admin
token is required for the default public-mode bootstrap path.

An authenticated relay can call `POST /api/public/relay/access/release` to
tear down its access binding. After the injected access strategy accepts the
release, the broker attempts public registration/grant cleanup, then always
force-closes live room sockets, and returns the cleanup result. Strategy denial
leaves registration and sockets intact. A typed unavailable cleanup failure
still closes sockets; clients may retry with the same bearer when it remains
valid. If an earlier authenticated release returned 503 and a later retry gets
Unauthorized, the binding may already be gone (ambiguous durable outcome — treat
as released).
