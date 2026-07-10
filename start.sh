#!/bin/bash
# Starts the Momentum server locally and exposes it via a Cloudflare quick
# tunnel. No cloud hosting, no account needed for the tunnel — just a random
# public trycloudflare.com URL pointing at your local port.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

node server.js &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "Stopping server..."
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
echo "Starting Cloudflare quick tunnel for http://localhost:$PORT ..."
cloudflared tunnel --url "http://localhost:$PORT"
