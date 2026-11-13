#!/bin/bash
# Start the local API used by the Lichess extension.
#   ./start.sh starts the service on 127.0.0.1:8001.
#   ./stop.sh stops it.

set -eu
OPENINGS_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$OPENINGS_ROOT"
RUNTIME_DIR="$OPENINGS_ROOT/.runtime"
mkdir -p "$RUNTIME_DIR"

requirements_hash="$(shasum -a 256 requirements.txt | awk '{print $1}')"
installed_requirements_hash="$(cat "$RUNTIME_DIR/requirements.sha256" 2>/dev/null || true)"
if [ ! -d "venv" ]; then
  echo "Creating Python venv and installing deps…"
  python3 -m venv venv
fi
if [ "$requirements_hash" != "$installed_requirements_hash" ]; then
  echo "Installing Python dependencies…"
  ./venv/bin/pip install -q -r requirements.txt
  echo "$requirements_hash" > "$RUNTIME_DIR/requirements.sha256"
fi

source "$OPENINGS_ROOT/venv/bin/activate"
export CHESS_DB_PATH="$OPENINGS_ROOT/chess_review.db"
# Fetch new chess.com games on start and every 30 minutes (backend/main.py).
export OPENINGS_AUTO_SYNC=1

if [ -z "${STOCKFISH_PATH:-}" ]; then
  if command -v stockfish >/dev/null 2>&1; then
    STOCKFISH_PATH="$(command -v stockfish)"
  elif [ -x /opt/homebrew/bin/stockfish ]; then
    STOCKFISH_PATH=/opt/homebrew/bin/stockfish
  elif [ -x /usr/local/bin/stockfish ]; then
    STOCKFISH_PATH=/usr/local/bin/stockfish
  else
    echo "Warning: Stockfish was not found. Your games and repertoire still work; the engine in Lichess will not."
  fi
  export STOCKFISH_PATH
fi

# Kill a process and all its descendants (children first). This reaps the
# backend's Stockfish child, which a bare `kill` would orphan.
kill_tree() {
  pid="$1"
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  # Tear down ONLY our own process subtrees — never a blanket port sweep, so a
  # restart (a newer start.sh that superseded us) is left untouched.
  for pid in ${BACKEND_PID:-}; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  for pid in ${BACKEND_PID:-}; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  if [ "$(cat "$RUNTIME_DIR/backend.pid" 2>/dev/null || true)" = "${BACKEND_PID:-}" ]; then
    rm -f "$RUNTIME_DIR/backend.pid"
  fi
}
trap cleanup EXIT INT TERM

# Never stack instances: stop any already-running copy first so backends/engines
# from another terminal or agent don't pile up and eat memory.
echo "Stopping any already-running instance first…"
"$OPENINGS_ROOT/stop.sh" >/dev/null 2>&1 || true

echo "Starting local extension service at http://127.0.0.1:8001"
uvicorn backend.main:app --host 127.0.0.1 --port 8001 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$RUNTIME_DIR/backend.pid"
wait "$BACKEND_PID"
