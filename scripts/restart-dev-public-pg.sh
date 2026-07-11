#!/bin/sh
#
# Run the FULL local dev stack (broker + relay-server + frontend) in PUBLIC mode
# against a LOCAL Postgres — a UAT-equivalent local environment with the REAL
# provider (codex/claude). Use this to test the Postgres control-plane + usage
# event storage locally instead of against the remote broker.
#
#   npm run dev:restart:public:pg                # LAN (phones on your WiFi can pair)
#   sh scripts/restart-dev-public-pg.sh --local  # localhost-only
#
# Postgres: by default a local docker container `sealwire-pg` on :5433 is used
# and auto-started. Point at your own Postgres instead by exporting
# RELAY_BROKER_PUBLIC_POSTGRES_URL before running.
#
# Local-public relay state is kept in .agent-relay/public-pg-* so it does not
# collide with the remote-public caches used by restart-dev-public.sh.

set -eu

localhost_only="${RELAY_DEV_LOCALHOST_ONLY:-0}"
if [ "${1:-}" = "--local" ]; then
  localhost_only=1
fi

pkill -f "node scripts/dev-full.mjs" >/dev/null 2>&1 || true
pkill -f "vite --host --port 5173 --strictPort" >/dev/null 2>&1 || true
pkill -f "vite --host" >/dev/null 2>&1 || true
pkill -f "cargo run -p relay-server" >/dev/null 2>&1 || true
pkill -f "target/debug/relay-server" >/dev/null 2>&1 || true
pkill -f "cargo run -p relay-broker" >/dev/null 2>&1 || true
pkill -f "target/debug/relay-broker" >/dev/null 2>&1 || true

PG_URL="${RELAY_BROKER_PUBLIC_POSTGRES_URL:-postgres://sealwire:dev@127.0.0.1:5433/sealwire}"

# Auto-provision the default local docker Postgres when that is what we point at.
case "$PG_URL" in
  *127.0.0.1:5433*|*localhost:5433*)
    if ! command -v docker >/dev/null 2>&1; then
      echo "restart-dev-public-pg: docker not found. Install docker, or export RELAY_BROKER_PUBLIC_POSTGRES_URL to your own Postgres." >&2
      exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
      echo "restart-dev-public-pg: docker daemon not running. Start Docker Desktop first." >&2
      exit 1
    fi
    if docker ps --format '{{.Names}}' | grep -q '^sealwire-pg$'; then
      : # already running
    elif docker ps -a --format '{{.Names}}' | grep -q '^sealwire-pg$'; then
      echo "restart-dev-public-pg: starting existing sealwire-pg container"
      docker start sealwire-pg >/dev/null
    else
      echo "restart-dev-public-pg: creating sealwire-pg container on :5433"
      docker run -d --name sealwire-pg \
        -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=sealwire -e POSTGRES_DB=sealwire \
        -p 5433:5432 postgres:16-alpine >/dev/null
    fi
    printf 'restart-dev-public-pg: waiting for postgres'
    i=0
    while [ "$i" -lt 30 ]; do
      if docker exec sealwire-pg pg_isready -U sealwire -d sealwire >/dev/null 2>&1; then
        echo ' ready'
        break
      fi
      printf '.'
      sleep 1
      i=$((i + 1))
    done
    ;;
esac

# Broker: public control plane + usage events in the same local Postgres.
export RELAY_BROKER_AUTH_MODE=public
export RELAY_BROKER_PUBLIC_ISSUER_SECRET="${RELAY_BROKER_PUBLIC_ISSUER_SECRET:-dev-public-issuer-secret}"
export RELAY_BROKER_PUBLIC_POSTGRES_URL="$PG_URL"
export RELAY_BROKER_USAGE_EVENTS_POSTGRES_URL="${RELAY_BROKER_USAGE_EVENTS_POSTGRES_URL:-$PG_URL}"
export RELAY_BROKER_BANNED_IPS_POSTGRES_URL="${RELAY_BROKER_BANNED_IPS_POSTGRES_URL:-$PG_URL}"

# Relay: enroll against the LOCAL broker; keep local-public caches separate from
# the remote-public ones (.agent-relay/public-broker-*).
#
# RELAY_BROKER_CONTROL_URL is intentionally NOT forced: the relay derives it from
# the broker ws URL (http(s)://<same host:port>), which dev-full.mjs sets to
# 127.0.0.1 in localhost mode and the detected LAN IP in LAN mode — so phone/LAN
# pairing points at the right host. Export it yourself only to override.
export RELAY_BROKER_REGISTRATION_PATH="${RELAY_BROKER_REGISTRATION_PATH:-.agent-relay/public-pg-broker-registration.json}"
export RELAY_BROKER_IDENTITY_PATH="${RELAY_BROKER_IDENTITY_PATH:-.agent-relay/public-pg-broker-identity.json}"
export RELAY_STATE_PATH="${RELAY_STATE_PATH:-.agent-relay/public-pg-session.json}"

# LAN by default so phones on the same network can pair; pass --local (or set
# RELAY_DEV_LOCALHOST_ONLY=1) to bind localhost-only.
export RELAY_DEV_LOCALHOST_ONLY="$localhost_only"

if [ "$localhost_only" = "1" ]; then net="localhost-only"; else net="LAN"; fi
echo "restart-dev-public-pg: PUBLIC mode + Postgres, real provider, network=$net"
echo "restart-dev-public-pg: postgres=$PG_URL"

exec node scripts/dev-full.mjs
