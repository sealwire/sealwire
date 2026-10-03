# Security model

Security is a core part of the product, not a later add-on. This page is the
summary. See [`DEPLOYMENT.md`](../DEPLOYMENT.md) for setup and pairing, and
[`.env.example`](../.env.example) for connection and security settings.

## Remote access

- Remote clients connect through SealWire Cloud or a self-hosted broker.
- Remote session content and actions are always end-to-end encrypted. The
  broker routes ciphertext; it does not receive plaintext session content.
- `private` is the only security mode. `RELAY_SECURITY_MODE=managed` is rejected.

## Local access

- `relay-server` only listens on loopback IP addresses and answers to loopback
  hostnames. Direct LAN access and external relay hostnames are unsupported.
- The local interface has no token login or session cookies. Host and browser
  origin checks protect the local API.
- Retired `RELAY_API_TOKEN`, `RELAY_ALLOW_INSECURE_NO_AUTH`, and
  `RELAY_ALLOWED_HOSTS` settings cause startup to fail. Remove them and use a
  broker for remote access.

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
