# Testing Matrix

Use this checklist for changes touching remote control, broker sessions, provider
adapters, or transcript handling.

## PR Required

- Run `npm test` for frontend unit/store/render coverage and the Vite build.
- Run `cargo test --workspace` for Rust state, broker, and protocol coverage.
- Add a Rust or frontend unit test for any local state transition change.
- Add a `test-fixtures/protocol/*.jsonl` replay fixture when wire messages,
  snapshots, deltas, or remote action result semantics change.

## Browser E2E Tiers

`test:browser:public-core:fake` is the CI-required high-risk public smoke tier.
It uses the fake provider, so it does not require a seeded Codex or Claude
environment. It covers:

- public broker lifecycle, reconnect, duplicate start-session replay, refresh,
  and revoke behavior
- device broker token expiry, cookie refresh, and post-refresh messaging
- multi-device revoke and revoke-others refresh-token invalidation
- transcript delta streaming through the public remote path

`test:browser:public-core` runs the same core paths with the default local
provider setup. The broader public matrix remains in `test:browser:public` and
should be run before large broker, auth, transcript, or remote UI changes.

On failure, browser e2e writes diagnostics under `artifacts/e2e/<scenario>/`.
CI uploads those files for the fake public core job.

## Transcript Invariants

- Snapshot hydration must not shrink a fuller transcript unless explicitly
  loading a compact profile.
- `transcript_delta` must append to the intended assistant entry.
- Long messages must survive compact snapshot and reconnect replay.
- `remote_action_result` must not overwrite transcript state unless it carries
  an intentional transcript-bearing snapshot.
- Duplicate remote action IDs must replay the cached result instead of starting
  a second session.

## Future CI Split

- PR required: unit/contract/build plus fake-provider browser smoke.
- Optional PR/manual: full browser matrix.
- Nightly: full matrix plus reconnect and broker restart stress cases.
- Live provider: Codex and Claude adapter checks only, gated behind secrets and
  never required for fork PRs.
