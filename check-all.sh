#!/bin/bash
# Runs every automated check and prints one line per check. Only failures
# show details, so an agent reads a few lines instead of thousands.
#
#   ./check-all.sh          fast checks (~10 s): backend tests + the extension's
#                           unit tests. Need nothing running and no network.
#                           The git pre-commit hook runs these.
#   ./check-all.sh --full   also the service fuzzer, the real extension in a
#                           headless Chrome, and check.mjs against real lichess.org
#                           (~3 min; check.mjs is skipped if the app is not on :8001).
#
# Exit code 0: everything ran passed. 1: something failed (details above the summary).
# Full logs: .runtime/check-all/<name>.log
# Every bug found gets a test here first: see BUGS.md.

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
LOGS="$ROOT/.runtime/check-all"
mkdir -p "$LOGS"
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

failed=()
skipped=()

run() {
  local name="$1"; shift
  local log="$LOGS/$name.log" start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf '  ok    %-22s %3ss\n' "$name" $((SECONDS - start))
  else
    printf '  FAIL  %-22s %3ss   (log: .runtime/check-all/%s.log)\n' "$name" $((SECONDS - start)) "$name"
    # The scripts mark failed checks with FAIL; pytest with FAILED/ERROR. Show
    # those with a little context, or the end of the log when nothing is marked.
    if grep -qE 'FAIL|ERROR' "$log"; then
      grep -E -A3 'FAIL|ERROR' "$log" | head -40 | sed 's/^/        /'
    else
      tail -20 "$log" | sed 's/^/        /'
    fi
    failed+=("$name")
  fi
}

skip() { printf '  skip  %-22s       %s\n' "$1" "$2"; skipped+=("$1"); }

echo "Fast checks"
run backend-pytest      bash -c 'cd backend && ../venv/bin/python -m pytest -q --tb=short -p no:cacheprovider'
run live-lock-test      node extension/scripts/live-lock-test.mjs
run sync-test           node extension/scripts/sync-test.mjs
run repertoire-test     node extension/scripts/repertoire-test.mjs
run engine-pacing-test  node extension/scripts/engine-pacing-test.mjs
run annotate-test       node extension/scripts/annotate-test.mjs

if [ "$FULL" = 1 ]; then
  echo "Full checks"
  if [ -f chess_review.db ]; then
    run service-fuzz    venv/bin/python extension/scripts/service-fuzz.py
  else
    skip service-fuzz   "no chess_review.db to copy"
  fi
  if [ -d extension/scripts/node_modules/playwright ]; then
    run real-extension  node extension/scripts/real-extension.mjs
    if curl -s -m 2 -o /dev/null http://127.0.0.1:8001/api/health; then
      run lichess-check node extension/scripts/check.mjs
    else
      skip lichess-check "app not running on :8001 (./start.sh)"
    fi
  else
    skip real-extension "run: npm install --prefix extension/scripts"
    skip lichess-check  "run: npm install --prefix extension/scripts"
  fi
fi

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "PASS${skipped[*]:+ (skipped: ${skipped[*]})}"
  exit 0
fi
echo "FAIL: ${failed[*]}"
exit 1
