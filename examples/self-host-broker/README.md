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
