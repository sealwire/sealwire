# Deployment

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

## Self-hosted broker

Build and run it with Docker Compose:

```bash
docker compose up --build relay-broker
```

Or directly with Docker:

```bash
docker build -f docker/broker.Dockerfile -t agent-relay-broker .
docker run --rm -p 8788:8788 -e BIND_HOST=0.0.0.0 agent-relay-broker
```

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
- optional `RELAY_BROKER_PUBLIC_RELAY_WS_TTL_SECS`
- optional `RELAY_BROKER_PUBLIC_DEVICE_WS_TTL_SECS`

Optional hardening env:

- `RELAY_BROKER_PUBLIC_API_RATE_LIMIT_PER_MINUTE`
- `RELAY_BROKER_JOIN_RATE_LIMIT_PER_MINUTE`
- `RELAY_BROKER_PUBLISH_RATE_LIMIT_PER_MINUTE`
- `RELAY_BROKER_MAX_CONNECTIONS_PER_IP`
- `RELAY_BROKER_MAX_TEXT_FRAME_BYTES`
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
RELAY_BROKER_REGISTRATION_PATH=.agent-relay/public-broker-registration.json \
RELAY_BROKER_IDENTITY_PATH=.agent-relay/public-broker-identity.json \
cargo run -p relay-server
```

On first startup without a cached registration, the relay creates a local
broker identity, requests an enrollment challenge from the broker, signs it,
and caches the returned registration automatically. No shared broker admin
token is required for the default public-mode bootstrap path.
