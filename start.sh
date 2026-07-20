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

# Don't open a tunnel to a dead or foreign server: wait until this node
# process actually answers on the port (EADDRINUSE etc. fail fast instead).
READY=""
for _ in $(seq 1 20); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server failed to start (see the error above)." >&2
    exit 1
  fi
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ -z "$READY" ]; then
  echo "Server did not become ready on port $PORT — is something else using it?" >&2
  exit 1
fi

echo "Starting Cloudflare quick tunnel for http://localhost:$PORT ..."
cloudflared tunnel --url "http://localhost:$PORT"
