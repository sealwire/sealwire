#!/bin/sh

set -eu

localhost_only=0
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

if [ "$localhost_only" -eq 1 ]; then
  exec env RELAY_DEV_LOCALHOST_ONLY=1 node scripts/dev-full.mjs
fi

exec node scripts/dev-full.mjs
