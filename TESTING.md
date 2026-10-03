# Testing

## Core checks

```bash
npm install
npm test
cargo test --workspace
```

`npm test` runs the frontend unit tests plus the production Vite build.

CI currently runs:

- `npm test`
- `cargo fmt --all --check`
- `cargo check --workspace`
- `cargo test --workspace`

## Opt-in slow tests

Some tests are too slow or too timing-dependent for every run, so they are gated behind
an environment variable and skip silently without it. They are not run by CI.

```bash
# Broker session end-to-end: drives the real relay broker session loop against an
# in-process fake broker over a real websocket. One surface requests a chunked reply
# (a >64KB workspace diff), leaves mid-reply, and a second surface asks a question.
# Asserts the second surface is answered promptly and the abandoned reply stops.
# ~3s, and needs `git` on PATH.
AGENT_RELAY_BROKER_SESSION_E2E=1 cargo test -p relay-server a_departing_surface

# Live Claude provider checks (needs a logged-in Claude CLI).
AGENT_RELAY_LIVE_CLAUDE_E2E=1 cargo test -p relay-server
```

## Browser E2E

Useful browser E2E commands:

- `npm run test:browser:pairing`
- `npm run test:browser:local-delete`
- `npm run test:browser:local-allowed-roots`
- `npm run test:browser:local-session`
- `npm run test:browser:public`
- `npm run test:browser:public-enrollment`
- `npm run test:browser:public-broker`
- `npm run test:browser:public-refresh`
- `npm run test:browser:public-persistence`
- `npm run test:browser:public-revoke`
- `npm run test:browser:public-reclaim`

## Smoke checks

Remote broker smoke test:

```bash
npm run smoke:pairing
```
