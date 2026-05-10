#!/bin/sh

set -eu

env_file="${1:-.env.public.local}"

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
  echo "restart-dev-public: missing env file: $env_file" >&2
  exit 1
fi

npm run build

echo "restart-dev-public: starting relay-server at http://${BIND_HOST:-127.0.0.1}:${PORT:-8787}"
echo "restart-dev-public: using public broker ${RELAY_BROKER_CONTROL_URL}"
exec cargo run -p relay-server
