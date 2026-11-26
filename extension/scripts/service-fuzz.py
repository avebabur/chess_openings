#!/usr/bin/env python3
"""Attacks the local service with bad and simultaneous requests.

    venv/bin/python extension/scripts/service-fuzz.py

Safe to run at any time: it copies chess_review.db to a temporary folder,
starts its OWN service on that copy (port 8011, no Lichess engine, no network)
and stops it at the end. Your real service on :8001 and your real database are
never touched.

It fails (exit code 1) when the service answers anything with a 500, stops
answering, writes a traceback to its log, or leaves the repertoire in a state
it should not be in. See extension/TESTING.md.
"""
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("OX_FUZZ_PORT", "8011"))
BASE = f"http://127.0.0.1:{PORT}/api"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
quote = urllib.parse.quote
problems = []


def call(method, path, body=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        return error.code, error.read()[:200].decode("utf8", "replace")
    except Exception as error:  # the service stopped answering
        return "no answer", repr(error)[:200]


def check(ok, text):
    print(("  ok   " if ok else "  FAIL ") + text)
    if not ok:
        problems.append(text)


def bad_input():
    """Every answer must be a refusal or a result, never a 500."""
    f = quote(START)
    cases = [
        ("GET", "/opening-tree?fen=garbage"),
        ("GET", "/opening-tree?fen=" + quote("8/8/8/8/8/8/8/8 w - - 0 1")),
        ("GET", "/opening-tree?fen=" + quote("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -")),
        ("GET", "/opening-tree?fen=" + quote(START + " extra junk")),
        ("GET", f"/opening-tree?fen={f}&color=purple"),
        ("GET", f"/opening-tree?fen={f}&moves_san=" + quote("e4 e5 Zz9 !!")),
        ("GET", f"/opening-tree?fen={f}&moves_san=" + quote("e4 " * 3000)),
        ("GET", "/opening-tree"),
        ("GET", f"/position-games?fen={f}&limit=0"),
        ("GET", f"/position-games?fen={f}&limit=101"),
        ("GET", f"/position-games?fen={f}&offset=-1"),
        ("GET", f"/position-games?fen={f}&offset=999999"),
        ("GET", f"/position-games?fen={f}&revision=bogus"),
        ("GET", "/position-games?fen=" + quote("9/8/8/8/8/8/8/8 w - - 0 1")),
        ("GET", "/games/0"), ("GET", "/games/-5"), ("GET", "/games/abc"),
        ("GET", "/games/99999999"), ("GET", "/games/9223372036854775808"),
        ("GET", "/openings/classify?moves_san=" + quote("e4 e5 Qh9")),
        ("GET", "/openings/classify?moves_san=" + quote("<script>")),
        ("GET", "/openings/classify?moves_san="),
        ("GET", "/repertoire/tree?color=green"),
        ("GET", "/sync-jobs/not-a-uuid"),
        ("GET", "/sync-jobs/00000000-0000-4000-8000-000000000000"),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": "e4 e5 Ke3"}),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": "   "}),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": ""}),
        ("POST", "/repertoire/tree/branches", {"color": "red", "moves_san": "e4"}),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": "e4", "label": "zzz"}),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": "e4", "name": "x" * 121}),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": "e4", "expected": {"id": -1}}),
        ("POST", "/repertoire/tree/branches", {"color": "white", "moves_san": "1. e4 e5 2. Nf3 Nc6"}),
        ("POST", "/repertoire/tree/branches", [1, 2, 3]),
        ("PATCH", "/repertoire/tree/branches/0", {"name": "x"}),
        ("PATCH", "/repertoire/tree/branches/999999", {"name": "x"}),
        ("PATCH", "/repertoire/tree/branches/999999", {"expected": {"name": "x", "label": "bad", "moves_san": "e4"}}),
        ("PATCH", "/repertoire/tree/branches/9223372036854775808", {"name": "x"}),
        ("DELETE", "/repertoire/tree/branches/999999"),
        ("DELETE", "/repertoire/tree/branches/999999", {"name": "x", "label": "main", "moves_san": ""}),
        ("DELETE", "/repertoire/tree/branches/abc"),
        ("PUT", "/settings/lichess-token", {"token": "x" * 513}),
        ("POST", "/accounts", {"platform": "chesscom", "username": "a b"}),
        ("POST", "/accounts", {"platform": "myspace", "username": "a"}),
        ("POST", "/accounts", {"platform": "lichess", "username": ""}),
        ("POST", "/accounts/999999/sync"),
        ("DELETE", "/accounts/999999"),
        ("POST", "/extension/health", {"page_kind": "puzzle"}),
        ("POST", "/extension/health", {"page_kind": "analyse", "features": [1]}),
        ("POST", "/extension/health", {"page_kind": "analyse", "url": "https://lichess.org/" + "a" * 3000,
                                       "features": {"a": "not a dict", "b": {"status": "missing", "missing_anchors": "x"}}}),
        ("GET", "/nope"),
    ]
    failed = []
    for case in cases:
        status, _ = call(*case)
        if status in (500, "no answer"):
            failed.append(f"{status} {case[0]} {urllib.parse.unquote(case[1])[:70]}")
    status, _ = call("POST", "/repertoire/tree/branches", raw=b"{not json")
    if status in (500, "no answer"):
        failed.append(f"{status} POST broken JSON")
    check(not failed, f"{len(cases) + 1} bad requests are refused, none breaks the service"
          + (": " + "; ".join(failed) if failed else ""))
    # What IS accepted must be stored in one spelling.
    status, saved = call("POST", "/repertoire/tree/branches", {"color": "black", "moves_san": "e2e4 e7e5 Nf3+ Nc6#"})
    check(status == 200 and saved["moves_san"] == "e4 e5 Nf3 Nc6",
          "a line written with squares, + and # is stored in plain notation")
    if status == 200:
        call("DELETE", f"/repertoire/tree/branches/{saved['id']}")


def positions(db_path):
    import chess.pgn
    fens = []
    for (pgn,) in sqlite3.connect(db_path).execute("SELECT pgn FROM games ORDER BY id DESC LIMIT 12"):
        game = chess.pgn.read_game(io.StringIO(pgn))
        if not game:
            continue
        board = game.board()
        for ply, move in enumerate(game.mainline_moves()):
            board.push(move)
            if ply < 44:
                fens.append(board.fen())
    return fens


def many_at_once(db_path):
    """What stepping quickly through games with My games open asks for."""
    fens = positions(db_path)
    if not fens:
        print("  (no games in the database: skipping the reads)")
        return

    def one(fen):
        f = quote(fen)
        return (call("GET", f"/opening-tree?color=white&fen={f}"),
                call("GET", f"/position-games?fen={f}&color=white&limit=15"))

    started = time.time()
    with ThreadPoolExecutor(24) as pool:
        answers = list(pool.map(one, fens))
    seconds = time.time() - started
    check(all(tree[0] == 200 and games[0] == 200 for tree, games in answers),
          f"{len(fens) * 2} requests, 24 at a time, all answered ({seconds:.1f} s)")
    check(all(tree[1]["total_games"] == games[1]["total"] for tree, games in answers if tree[0] == games[0] == 200),
          "the number of games at a position is the same in both answers")


def simultaneous_changes(db_path):
    """Two Lichess tabs changing the repertoire in the same instant."""
    line = "h4 a5 h5 a4 h6"
    path = "/repertoire/tree/branches"

    def guarded_save(n):
        return call("POST", path, {"color": "white", "name": f"tab {n}", "moves_san": line, "expected": "new"})

    with ThreadPoolExecutor(12) as pool:
        guarded = list(pool.map(guarded_save, range(12)))
    winners = [branch for status, branch in guarded if status == 200]
    check(sorted(status for status, _ in guarded if isinstance(status, int)) == [200] + [409] * 11,
          "12 competing new-line drafts produce one save and 11 conflicts")
    with sqlite3.connect(db_path) as conn:
        names = conn.execute("SELECT name FROM repertoire_branches WHERE color = 'white' AND moves_san = ?", (line,)).fetchall()
    check(len(winners) == 1 and names == [(winners[0]["name"],)], "the winning name survives all the stale drafts")
    for branch in winners:
        call("DELETE", f"{path}/{branch['id']}")

    def save(n):
        return call("POST", path, {"color": "white", "name": f"tab {n}", "moves_san": line})

    with ThreadPoolExecutor(12) as pool:
        saved = list(pool.map(save, range(12)))
    check(all(status == 200 for status, _ in saved), "12 saves of the same new line at once all succeed")
    rows = sqlite3.connect(db_path).execute(
        "SELECT id FROM repertoire_branches WHERE color = 'white' AND moves_san = ?", (line,)).fetchall()
    check(len(rows) == 1, f"…and it is saved once ({len(rows)} rows)")
    if not rows:
        return
    branch = rows[0][0]

    def mixed(n):
        path = f"/repertoire/tree/branches/{branch}"
        if n % 3 == 0:
            return call("PATCH", path, {"moves_san": line + " a3"})[0]
        if n % 3 == 1:
            return call("PATCH", path, {"label": "sideline"})[0]
        return call("DELETE", path)[0]

    with ThreadPoolExecutor(9) as pool:
        statuses = list(pool.map(mixed, range(9)))
    check(all(status in (200, 404) for status in statuses),
          f"extend, relabel and delete of one line at once: each succeeds or finds it gone ({statuses})")
    # Every move in the tree must lead to a saved line.
    orphans = sqlite3.connect(db_path).execute(
        """WITH RECURSIVE used(id) AS (
               SELECT terminal_node_id FROM repertoire_branches
               UNION SELECT n.parent_id FROM repertoire_nodes n JOIN used u ON n.id = u.id
               WHERE n.parent_id IS NOT NULL)
           SELECT COUNT(*) FROM repertoire_nodes
           WHERE id NOT IN (SELECT id FROM used WHERE id IS NOT NULL)""").fetchone()[0]
    check(orphans == 0, f"no move is left in the repertoire without a line ({orphans})")


def main():
    source = Path(os.environ.get("CHESS_DB_PATH") or ROOT / "chess_review.db")
    with tempfile.TemporaryDirectory(prefix="ox-fuzz-") as folder:
        db_path = os.path.join(folder, "copy.db")
        if source.exists():
            original = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
            copy = sqlite3.connect(db_path)
            original.backup(copy)
            # The copy must never talk to Lichess as you.
            copy.execute("UPDATE settings SET value = '' WHERE key = 'lichess_token'")
            copy.commit()
            copy.close()
            original.close()
        log_path = os.path.join(folder, "service.log")
        env = {**os.environ, "CHESS_DB_PATH": db_path, "OPENINGS_LICHESS_ENGINE": "0",
               "OPENINGS_DISABLE_EXTERNAL_NETWORK": "1",
               "OPENINGS_EXTENSION_HEALTH_PATH": os.path.join(folder, "health.json")}
        env.pop("OPENINGS_IDLE_EXIT_SECONDS", None)
        with open(log_path, "w") as log:
            service = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT)],
                cwd=ROOT / "backend", env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(60):
                if call("GET", "/health")[0] == 200:
                    break
                time.sleep(0.25)
            else:
                print(open(log_path).read()[-2000:])
                sys.exit(f"The test service did not start on port {PORT}.")
            print(f"Test service on :{PORT}, on a copy of {source.name}\n")
            bad_input()
            many_at_once(db_path)
            simultaneous_changes(db_path)
            check(call("GET", "/health")[0] == 200, "the service still answers afterwards")
        finally:
            service.terminate()
            service.wait(timeout=20)
        log_text = open(log_path).read()
        tracebacks = log_text.count("Traceback (most recent call last)")
        check(tracebacks == 0, f"nothing crashed inside the service ({tracebacks} tracebacks in its log)")
        if tracebacks:
            errors = [line for line in log_text.splitlines() if line and not line.startswith((" ", "INFO", "Traceback"))]
            print("        " + "\n        ".join(sorted(set(errors))[:8]))
    print("\n" + ("Service fuzz passed." if not problems else f"{len(problems)} problem(s) found."))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
