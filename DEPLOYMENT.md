# Deployment

Run SealWire on the computer that has your projects and coding agents. Use it
locally, connect your phone through SealWire Cloud, or run your own broker for
remote access.

## Run locally

Install Node.js 20+ and sign in to the coding agent you want to use. See the
[README](README.md) for supported agents and setup.

From your project directory, run:

```bash
npx sealwire
```

SealWire opens its web interface at <http://localhost:8787>. It is accessible only
from that computer; non-loopback relay bind addresses are rejected. Remote
access goes through SealWire Cloud or your self-hosted broker. The local
interface does not use a token login or session cookies. Remove retired
`RELAY_API_TOKEN`, `RELAY_ALLOW_INSECURE_NO_AUTH`, and `RELAY_ALLOWED_HOSTS`
settings; the relay refuses to start when they are present.

To explicitly run without a broker connection:

```bash
npx sealwire local
```

## Connect your phone or another computer

```bash
npx sealwire cloud
```

The first time, enter your SealWire Cloud access key when prompted. Open
Settings in the local interface, scan the pairing QR code on your other device,
and approve the pairing on your computer.

Paired devices can follow your sessions, send messages, respond to approvals,
and receive notifications. Add the phone interface to your home screen to use
it like an app. Your computer must stay running for remote access.

All remote connections use end-to-end encryption. The broker cannot read
messages, transcripts, or action results. Plaintext remote connections are not
supported.

You can remove paired devices from Settings. To release this computer's Cloud
access:

```bash
npx sealwire cloud unbind
```

## Use your own broker

A self-hosted broker lets you connect devices through a server you control.
Your projects and coding agents stay on the computer running SealWire.

Set `RELAY_BROKER_TICKET_SECRET` to the same secret on the broker and the
SealWire computer. Generate it once with `openssl rand -base64 48` and keep
it across restarts.

For the included [Docker Compose setup](docker-compose.yml), run
`docker compose up -d --build` on the broker server. On the SealWire computer,
connect with:

```bash
RELAY_BROKER_AUTH_MODE=self_hosted \
RELAY_BROKER_TICKET_SECRET="$RELAY_BROKER_TICKET_SECRET" \
RELAY_BROKER_CHANNEL_ID=my-relay \
npx sealwire --broker https://broker.example.com
```

See the [self-hosted deployment example](examples/self-host-broker/README.md) and
[configuration reference](.env.example) for other deployment options. Use HTTPS for internet access
and keep the broker's settings and data across restarts so paired devices can
reconnect.

## Desktop app

The macOS desktop app is available as a preview. It provides a menu-bar icon and
windows for your local workspace and remote sessions. See the
[README](README.md) for an overview.

## Common options

| Command | Use |
| --- | --- |
| `npx sealwire --port 8788` | Use a different local port. |
| `npx sealwire --no-open` | Start without opening a browser. |
| `npx sealwire --help` | Show all available commands and options. |

## Relay state location

Sessions, projects, paired devices, and connection credentials are saved in one
database, `~/.sealwire/sealwire.db`. Restarting SealWire or launching from
another project keeps that saved state. Back up the whole directory when moving
to another computer.

The database holds this relay's credentials unencrypted, readable only by your
user account. Treat it like a key file: do not share it or attach it to a bug
report.

Run one SealWire instance at a time with the default state location. To run a
separate relay, give it its own database with `RELAY_STATE_DB`.

### Upgrading from a version that saved `session.json`

Earlier versions kept the same state in `~/.agent-relay/`, in `session.json` and
a few key files. The new version will not start until they are moved into the
database:

1. Stop SealWire.
2. Run `npx sealwire@latest migrate-storage`. It moves `~/.agent-relay/` to
   `~/.sealwire/`, copies everything into `sealwire.db`, and leaves the old files
   where they are.
3. Start SealWire and check your sessions and paired devices.
4. Run `npx sealwire@latest migrate-storage --finish` to remove the old files.

## Privacy

Private mode is the default: session content sent between your devices is
end-to-end encrypted. New devices require your approval before they can
connect. See the [security model](docs/security-model.md) for more information.

## Updating

Restart using the latest package in the mode you normally use:

```bash
npx sealwire@latest
# For Cloud access:
npx sealwire@latest cloud
```

Your saved sessions and paired devices are retained. If SealWire reports that
your version is too old to connect, update the package or desktop app before
trying again.

Self-hosted brokers now reject short or placeholder signing secrets such as
`change-me`. Replace weak values with generated secrets. For `self_hosted`
authentication, update the secret on both sides and pair devices again.
