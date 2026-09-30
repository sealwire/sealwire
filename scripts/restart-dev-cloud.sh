#!/bin/sh

set -eu

# Default env file: prefer the current `.env.cloud.local` name, but fall back to
# the legacy `.env.public.local` so existing local setups keep working. Both are
# gitignored; the wire value inside is still RELAY_BROKER_AUTH_MODE=public.
if [ "$#" -ge 1 ]; then
  env_file="$1"
elif [ -f ".env.cloud.local" ]; then
  env_file=".env.cloud.local"
else
  env_file=".env.public.local"
fi

pkill -f "node scripts/dev-full.mjs" >/dev/null 2>&1 || true
pkill -f "vite --host --port 5173 --strictPort" >/dev/null 2>&1 || true
pkill -f "vite --host" >/dev/null 2>&1 || true
pkill -f "cargo run -p relay-server" >/dev/null 2>&1 || true
pkill -f "target/debug/relay-server" >/dev/null 2>&1 || true
pkill -f "cargo run -p relay-broker" >/dev/null 2>&1 || true
pkill -f "target/debug/relay-broker" >/dev/null 2>&1 || true

if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
else
  echo "restart-dev-cloud: missing env file: $env_file" >&2
  exit 1
fi

# Unlocked like every other `npm run dev:*`; this script execs cargo itself so it
# repeats what dev-full.mjs does. After the source, so an explicit 0 still wins.
export SEALWIRE_BETA="${SEALWIRE_BETA:-1}"

npm run build

# Drop the stale cargo generations left by previous runs before the build below
# adds another. cargo never garbage-collects target/: each changed metadata hash
# writes a fresh `<crate>-<hash>.*` set and leaves every earlier one in place,
# which is how target/debug reached 94G here. See scripts/prune-cargo-target.mjs.
# Runs BEFORE cargo so the generation it is about to reuse is the newest one —
# exactly what the prune keeps — and no rebuild is forced.
#
# `|| true` is load-bearing: this sits on the startup path of a dev relay and
# must never be what stops one from coming up. It also keeps the smoke test
# green, which runs this script with a stubbed PATH that has no node on it.
node "$(dirname "$0")/prune-cargo-target.mjs" || true

echo "restart-dev-cloud: starting relay-server at http://${BIND_HOST:-127.0.0.1}:${PORT:-8787}"
if [ "$SEALWIRE_BETA" = "1" ]; then
  echo "restart-dev-cloud: beta features ON (Tasks unlocked)"
else
  echo "restart-dev-cloud: beta features OFF (SEALWIRE_BETA=$SEALWIRE_BETA)"
fi
# The control URL is optional: the two-variable quickstart env sets only
# RELAY_BROKER_URL and the relay derives the control URL from it. Guard the
# expansion so `set -u` does not abort before the relay even starts.
echo "restart-dev-cloud: using broker ${RELAY_BROKER_CONTROL_URL:-${RELAY_BROKER_URL:-<derived by relay-server>}}"

# Build with the private crate when this checkout has it, and say which of the two
# it got. A cloud relay is where long task lists actually get started, so starting
# one that answers every request with "not available in this build" is the worst
# place to discover the feature was compiled out.
#
# The tell is the stub's own marker file, not a module name the private crate
# happens to have today: anything else that goes private later lands in the same
# crate and this keeps working untouched.
if [ ! -f "$(dirname "$0")/../crates/sealwire-private/STUB" ]; then
  echo "restart-dev-cloud: private crate present — building with it"
  exec cargo run -p relay-server --features private
fi
echo "restart-dev-cloud: stub private crate — task list and task team are off"
exec cargo run -p relay-server
