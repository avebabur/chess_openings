#!/bin/bash
# Stop Chess Openings — thoroughly, leaving nothing dangling.
#
#   ./stop.sh        stop this extension’s local backend and its Stockfish child.
#
# Scoped to THIS checkout so it is safe to run with other projects (or other
# Stockfish) alive: it only stops uvicorn whose working dir is this repo
# (or that hold this app's ports), plus Stockfish children of those backends and
# orphaned Stockfish for this repo's engine binary. It does NOT touch unrelated
# servers or a Stockfish you launched yourself.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT/.runtime"
BACKEND_PORT="${OPENINGS_BACKEND_PORT:-8001}"

resolve_stockfish() {
  if [ -n "${STOCKFISH_PATH:-}" ]; then echo "$STOCKFISH_PATH"; return; fi
  if command -v stockfish >/dev/null 2>&1; then command -v stockfish; return; fi
  for p in /opt/homebrew/bin/stockfish /usr/local/bin/stockfish; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  echo stockfish
}
SF_BIN="$(resolve_stockfish)"

cmd_of()  { ps -p "$1" -o command= 2>/dev/null; }
cwd_of()  { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
ppid_of() { ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '; }
under_root() { case "$1" in "$ROOT"|"$ROOT"/*) return 0;; *) return 1;; esac; }

TARGETS=""
add_target() { case " $TARGETS " in *" $1 "*) ;; *) TARGETS="$TARGETS $1";; esac; }

# 1) A server holding our port, only when it runs from this checkout.
for port in "$BACKEND_PORT"; do
  for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
    case "$(cmd_of "$pid")" in
      *uvicorn*|*python*|*Python*) under_root "$(cwd_of "$pid")" && add_target "$pid" ;;
    esac
  done
done

# 2) This repo's uvicorn backend — a real server process in this repo, not a shell
#    or grep that merely mentions the pattern on its command line.
for pid in $(pgrep -f 'backend\.main:app' 2>/dev/null); do
  cmd="$(cmd_of "$pid")"
  case "$cmd" in *uvicorn*) ;; *) continue ;; esac        # must look like the server
  case "$cmd" in *zsh*|*bash*|*grep*|*pgrep*) continue ;; esac  # not a shell/grep
  under_root "$(cwd_of "$pid")" && add_target "$pid"
done

# 3) Stockfish engines that are children of any backend we're about to stop
#    (captured now, before we orphan them).
for bpid in $TARGETS; do
  for child in $(pgrep -P "$bpid" 2>/dev/null); do
    case "$(cmd_of "$child")" in *stockfish*) add_target "$child" ;; esac
  done
done

# 4) Honour our pidfile when it still points at this checkout's server.
for pf in "$RUNTIME_DIR/backend.pid"; do
  [ -f "$pf" ] || continue
  pid="$(cat "$pf" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *) case "$(cmd_of "$pid")" in
         *uvicorn*) under_root "$(cwd_of "$pid")" && add_target "$pid" ;;
       esac ;;
  esac
done

# Trim leading space.
TARGETS="${TARGETS# }"

if [ -z "$TARGETS" ]; then
  echo "No running Chess Openings processes found."
else
  # Graceful first: SIGTERM lets the backend quit Stockfish via its shutdown hook.
  for pid in $TARGETS; do kill -TERM "$pid" 2>/dev/null || true; done
  # Wait up to ~3s for clean exit.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    alive=0
    for pid in $TARGETS; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" -eq 0 ] && break
    sleep 0.3
  done
  # Force-kill any survivors.
  for pid in $TARGETS; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
  echo "Stopped:$TARGETS"
fi

# 5) Last resort — Stockfish orphaned (reparented to init) for THIS engine binary,
#    leaked by a crashed backend. Scoped to our binary so your own Stockfish is safe.
case "$SF_BIN" in
  /*) for pid in $(pgrep -x stockfish 2>/dev/null); do
        [ "$(ppid_of "$pid")" = "1" ] || continue
        case "$(cmd_of "$pid")" in
          "$SF_BIN"|"$SF_BIN "*) kill -KILL "$pid" 2>/dev/null && echo "Killed orphaned Stockfish (PID $pid)" ;;
        esac
      done ;;
esac

rm -f "$RUNTIME_DIR/backend.pid"
echo "Done."
