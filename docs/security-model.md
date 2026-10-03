# Security model

Security is a core part of the product, not a later add-on. This page is the
summary. See [`DEPLOYMENT.md`](../DEPLOYMENT.md) for setup and pairing, and
[`.env.example`](../.env.example) for connection and security settings.

## The default: `private` mode

- `private` mode is the default. Broker-mediated remote traffic is end-to-end
  encrypted, and the broker is treated as **blind transport** rather than a
  content-reading execution layer.
- Privacy follows from that default: your remote control path stays usable
  without requiring the broker to see session content in plaintext.
- `managed` mode exists for deployments that explicitly want broker or org
  services to be able to read content. It is selectable today
  (`RELAY_SECURITY_MODE=managed`) and flips `e2ee_enabled` /
  `broker_can_read_content`, but **the audit trail it is meant to enable is not
  implemented yet** — `audit_enabled` is surfaced, not consumed. Don't deploy
  `managed` expecting audit records.

## Identity and control

- Pairing and remote claim flows bind device identity before a remote surface
  can take control of a session.
- Remote devices keep signing keys in browser-managed crypto storage when
  `WebCrypto` and `IndexedDB` are available, with a compatibility fallback for
  weaker browser contexts.

## Where execution lives

- `relay-server` remains the execution authority, next to the local workspace.
  The broker moves encrypted control traffic; it does not host the agent.

## Scope

This is a **single-owner** control plane: one operator, many devices. It is not
hardened for multi-user hosted collaboration, untrusted tenants sharing a
control plane, or org policy / enterprise audit workflows.
