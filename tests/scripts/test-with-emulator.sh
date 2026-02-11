#!/bin/bash

# Ensure we start from the project root
PROJECT_ROOT=$(pwd)

# Load environment variables from .env file
if [ -f "$PROJECT_ROOT/.env" ]; then
  echo "Loading environment variables from .env file"
  export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
else
  echo "ERROR: No .env file found. Please create one based on .env.example"
  exit 1
fi

# Configuration
HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1}"
PORT="${FIRESTORE_EMULATOR_PORT:-8188}"
PROJECT="${FIREBASE_PROJECT_ID:-demo-firegraph}"

echo "Using configuration:"
echo "  FIREBASE_PROJECT_ID:    $PROJECT"
echo "  FIRESTORE_EMULATOR:     $HOST:$PORT"

# Export for firebase-admin SDK
export FIRESTORE_EMULATOR_HOST="$HOST:$PORT"

# Check if emulator is already running
nc -z $HOST $PORT
EMULATOR_RUNNING=$?

EMULATOR_PID=""
if [[ $EMULATOR_RUNNING -eq 0 ]]; then
  echo "Firebase emulator already running on $HOST:$PORT. Using existing instance."
else
  echo "Starting Firebase emulator..."
  cd "$PROJECT_ROOT/tests/emulator" && firebase emulators:start -P $PROJECT &
  EMULATOR_PID=$!

  # Wait for emulator to be ready
  counter=0
  max_attempts=30

  while [[ $counter -lt $max_attempts ]]; do
    nc -z $HOST $PORT
    result=$?
    if [[ $result -eq 0 ]]; then
      echo "Firebase emulator on $HOST:$PORT is up!"
      break
    fi
    echo "Waiting for emulator... Attempt $((counter+1))/$max_attempts"
    sleep 1
    ((counter++))
  done

  if [[ $counter -eq $max_attempts ]]; then
    echo "ERROR: Emulator did not start within $max_attempts seconds."
    kill $EMULATOR_PID 2>/dev/null
    exit 1
  fi
fi

# Run tests
cd "$PROJECT_ROOT" && pnpm vitest run "$@"
TEST_EXIT=$?

# Cleanup — only kill if we started the emulator
if [[ -n "$EMULATOR_PID" ]]; then
  echo "Shutting down emulator (PID: $EMULATOR_PID)"
  kill $EMULATOR_PID 2>/dev/null
fi

exit $TEST_EXIT
