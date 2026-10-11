# Security model

Security is a core part of the product, not a later add-on. This page is the
summary. See [`DEPLOYMENT.md`](../DEPLOYMENT.md) for setup,
[`remote-access.md`](remote-access.md) for pairing, and
[`.env.example`](../.env.example) for connection and security settings.

## Remote access

- Remote clients connect through SealWire Cloud or a self-hosted broker.
- Remote session content and actions are always end-to-end encrypted. The
  broker routes ciphertext; it does not receive plaintext session content.
- `private` is the only security mode.

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
- Signed remote requests must pass permission and freshness checks at admission.
  Once accepted, preparation does not recheck request freshness or session validity;
  retries use the same operation record to avoid executing a write twice.
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

The standard `public` broker permits open relay enrollment. Registrations have
no total cap or automatic expiry, so this mode is intended for trusted users;
request rate limits only slow registration growth. Hosted deployments must
provide an access strategy that requires enrollment credentials and bounds
registrations per credential before they are persisted.
