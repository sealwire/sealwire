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

## Browser E2E

Useful browser E2E commands:

- `npm run test:browser:pairing`
- `npm run test:browser:local-delete`
- `npm run test:browser:local-allowed-roots`
- `npm run test:browser:local-auth`
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
