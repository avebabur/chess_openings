#!/bin/bash
# Start Chess Openings (standalone from Game Review).
#
#   ./start.sh          production on http://localhost:8001
#   ./start.sh --dev    backend :8001 + Vite HMR on :5174
#   ./stop.sh           stop only this app's backend and dev frontend
#
# Self-contained: creates its own venv and uses its own chess_review.db.

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

frontend_hash="$(shasum -a 256 frontend/package-lock.json | awk '{print $1}')"
installed_frontend_hash="$(cat "$RUNTIME_DIR/frontend.sha256" 2>/dev/null || true)"
if [ ! -d "frontend/node_modules" ] || [ "$frontend_hash" != "$installed_frontend_hash" ]; then
  echo "Installing openings frontend deps…"
  # `npm ci` is strict — it aborts if package-lock.json has drifted from
  # package.json. Rather than leave the app unstartable, fall back to `npm install`
  # to repair the lockfile in place, then record the (possibly updated) hash.
  if ! (cd frontend && npm ci); then
    echo "npm ci failed (package-lock drift) — repairing with npm install…"
    (cd frontend && npm install)
  fi
  shasum -a 256 frontend/package-lock.json | awk '{print $1}' > "$RUNTIME_DIR/frontend.sha256"
fi

source "$OPENINGS_ROOT/venv/bin/activate"
export CHESS_DB_PATH="$OPENINGS_ROOT/chess_review.db"

if [ -z "${STOCKFISH_PATH:-}" ]; then
  if command -v stockfish >/dev/null 2>&1; then
    STOCKFISH_PATH="$(command -v stockfish)"
  elif [ -x /opt/homebrew/bin/stockfish ]; then
    STOCKFISH_PATH=/opt/homebrew/bin/stockfish
  elif [ -x /usr/local/bin/stockfish ]; then
    STOCKFISH_PATH=/usr/local/bin/stockfish
  else
    echo "Warning: Stockfish was not found. Explorer and training still work; engine analysis will be unavailable."
  fi
  export STOCKFISH_PATH
fi

# Kill a process and all its descendants (children first). This reaps npm's vite
# child and the backend's Stockfish child, which a bare `kill` would orphan.
kill_tree() {
  pid="$1"
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  # Tear down ONLY our own process subtrees — never a blanket port sweep, so a
  # restart (a newer start.sh that superseded us) is left untouched.
  for pid in ${BACKEND_PID:-} ${FRONTEND_PID:-}; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  for pid in ${BACKEND_PID:-} ${FRONTEND_PID:-}; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  rm -f "$RUNTIME_DIR/backend.pid" "$RUNTIME_DIR/frontend.pid"
}
trap cleanup EXIT INT TERM

# Never stack instances: stop any already-running copy first so backends/engines
# from another terminal or agent don't pile up and eat memory.
echo "Stopping any already-running instance first…"
"$OPENINGS_ROOT/stop.sh" >/dev/null 2>&1 || true

if [ "${1:-}" = "--dev" ]; then
  echo "Starting backend  → http://localhost:8001"
  uvicorn backend.main:app --host 127.0.0.1 --port 8001 &
  BACKEND_PID=$!
  echo "$BACKEND_PID" > "$RUNTIME_DIR/backend.pid"

  sleep 1

  echo "Starting frontend → http://localhost:5174 (dev mode, HMR)"
  (cd frontend && npm run dev -- --host 127.0.0.1) &
  FRONTEND_PID=$!
  echo "$FRONTEND_PID" > "$RUNTIME_DIR/frontend.pid"

  echo ""
  echo "Chess Openings is running in DEV mode."
  echo "  Open: http://localhost:5174"
  echo "  Stop: Ctrl+C"
  echo ""

  wait
  exit 0
fi

needs_build=0
if [ ! -f "frontend/dist/index.html" ]; then
  needs_build=1
elif [ -n "$(find frontend/src frontend/index.html frontend/vite.config.js -type f -newer frontend/dist/index.html -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi

if [ "$needs_build" = "1" ]; then
  echo "Building openings frontend…"
  (cd frontend && npm run build)
fi

echo ""
echo "Chess Openings is running."
echo "  Open: http://localhost:8001"
echo "  Stop: Ctrl+C"
echo ""

CHESS_OPENINGS_DESKTOP=1 uvicorn backend.main:app --host 127.0.0.1 --port 8001 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$RUNTIME_DIR/backend.pid"
wait "$BACKEND_PID"
