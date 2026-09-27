#!/usr/bin/env bash
# Jev Brain Desk launcher (macOS / Linux)
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required: https://nodejs.org/" >&2; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required (found $(node -v))." >&2; exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --omit=dev
fi
exec node src/server.js "$@"
