#!/bin/bash
# All-in-one startup: reads config, cleans port, starts server, verifies health.
# Outputs JSON with abriUrl and port on success.
# Run this with run_in_background: true — the server stays alive as a child process.

CONFIG="firegraph.config.ts"

# Extract abri URL and editor port from config
URL=""
EDITOR_PORT=""
if [ -f "$CONFIG" ]; then
  URL=$(grep -oE "abri:\s*['\"]([^'\"]+)['\"]" "$CONFIG" | head -1 | sed "s/abri:[[:space:]]*['\"]//;s/['\"]//")
  EDITOR_PORT=$(grep -A5 'editor\s*:' "$CONFIG" | grep -oE 'port\s*:\s*[0-9]+' | head -1 | grep -oE '[0-9]+')
fi
URL="${URL:-http://localhost:3885}"
PORT=$(echo "$URL" | grep -oE ':[0-9]+$' | tr -d ':')
PORT="${PORT:-3885}"
EDITOR_PORT="${EDITOR_PORT:-3884}"

# Clean up any existing server on this port
lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
sleep 0.3

# Start server in background
npx abri serve --port "$PORT" &
SERVER_PID=$!
sleep 1

# Verify health
if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "{\"abriUrl\":\"$URL\",\"port\":\"$PORT\",\"editorPort\":\"$EDITOR_PORT\",\"pid\":$SERVER_PID}"
else
  echo "{\"error\":\"Server failed to start on port $PORT\"}" >&2
  exit 1
fi

# Keep this script alive so the background server process isn't orphaned
wait $SERVER_PID
