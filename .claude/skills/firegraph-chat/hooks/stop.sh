#!/bin/bash
# Stop hook for /firegraph-chat skill
# First invocation blocks exit, second allows it and cleans up abri

INPUT=$(cat)

STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  # Read port from firegraph.config.ts (same logic as startup.sh)
  CONFIG="firegraph.config.ts"
  PORT=""
  if [ -f "$CONFIG" ]; then
    URL=$(grep -oE "abri:\s*['\"]([^'\"]+)['\"]" "$CONFIG" | head -1 | sed "s/abri:[[:space:]]*['\"]//;s/['\"]//")
    PORT=$(echo "$URL" | grep -oE ':[0-9]+$' | tr -d ':')
  fi
  PORT="${PORT:-3885}"
  lsof -ti :"$PORT" | xargs kill 2>/dev/null
  exit 0
fi

# Block the stop — instruct Claude to continue listening
echo '{"decision": "block", "reason": "You are in the firegraph-chat listen loop. Do NOT stop. Go back to Step 1 and listen for the next message."}'
