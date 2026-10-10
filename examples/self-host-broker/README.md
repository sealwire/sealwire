# Self-host OpenAccess broker (example)

This directory is an **explicit** Railway / Docker example for operators who
want to run the **public** `relay-broker` binary themselves (OpenAccess /
self-hosted auth).

It is **not** SealWire Cloud.

| Path | What it is |
|------|------------|
| `npx sealwire cloud` | Attaches a local relay to the **hosted licensed** Cloud broker |
| `docker/broker.Dockerfile` + this example | Builds/runs the **public** OpenAccess `relay-broker` image |

To deploy self-host on Railway you must consciously point a service at
`examples/self-host-broker/railway.toml` (or copy its contents). The public
repository has **no** root `railway.toml` and **no** GitHub Action that runs
`railway up` against the hosted Cloud service.

## Public API admission

Anonymous requests share a limit of 5/minute per IPv4 address or IPv6 /64 across
routes. Enrollment and client identities with no remaining relay grants also
share a 600/minute ceiling. Each relay has two independent 120/minute allowances:
one for its own refresh credential, and one shared by its phones and client
identities. Phones cannot consume the relay allowance needed to revoke them or
reconnect. Credential type is checked before selecting either allowance; changing
the requested route cannot move a phone into the relay group. Client directory and
identity operations charge the earliest still-linked relay (grant time, then
relay ID); scoped recovery charges its target relay. Cloud also aggregates these
requests per license, with the same two independent groups. Rejected signed
recovery requests with an invalid scope spend the caller's own allowance, never
the named target's allowance. See `.env.example` for overrides.

A valid HMAC alone cannot spend a relay's allowance: the token must still exist
in the current credential state, including an unexpired rotation grace entry.
Issued tokens missing from memory use a separate 5/minute allowance per source
network before database rechecks. Fabricated tokens never enter that lookup
allowance. A stale instance can rate-limit new credentials while this lookup allowance is
exhausted; already cached live credentials bypass both source limits. The browser
can attempt same-origin signed recovery after either a 401 or a 429, so a missing
cookie does not leave a paired phone stuck in the anonymous source allowance.

Each relay can retain 64 client identities; re-pairing an existing identity does
not consume another slot, and revoking its device frees its grants. Recovery
holds at most four challenges per client and 64 per relay/license quota. Relay
control and WebSocket ticket proofs each hold at most 64 challenges per relay.
Authenticated counters have no shared identity-count ceiling and expire idle
entries, so one caller cannot reserve every counter slot.

New refresh tokens and client identifiers carry HMAC-SHA256 authentication,
using a purpose-specific key derived from `RELAY_BROKER_PUBLIC_ISSUER_SECRET`.
Fabricated credentials are rejected before any persistence lookup; client-key
recovery verifies the request signature before looking up the client. A valid
mark only proves issuance: normal credential, scope and revocation checks remain.
WebSocket tickets still default to five minutes; refresh-token lifetimes do not
change.

The first upgraded startup records existing credential fingerprints and client
verification keys. JSON persistence keeps this migration record in the state
file; Postgres keeps it in `public_legacy_credentials`. Back up this record with
the rest of the control-plane state. Old devices retain their tokens and IDs,
including tokens inside their existing rotation grace period. The migration
record cannot authorize a revoked credential.

Stop old broker writers before the first upgraded startup and keep the issuer
secret stable. Brokers sharing a database must share this secret. Database
rechecks on recognized cache misses remain enabled for shared persistence.
This change does not provide full multi-broker operation: rate counters and
pending pairing/proof state are still local to each broker.
