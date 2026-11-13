"""End-to-end check of "Your Stockfish in Lichess", without a browser.

Asks Lichess's engine broker for an analysis exactly the way Lichess's
analysis page does (ui/lib/src/ceval/engines/externalEngine.ts), and prints
what comes back. If the app's engine link works, Stockfish lines arrive.

    venv/bin/python extension/scripts/engine_check.py            # normal analysis, 3 s
    venv/bin/python extension/scripts/engine_check.py --practice # Practice's request

Needs the app running and its saved Lichess token (engine:read).
"""
import json
import os
import sys
import time
import uuid

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "backend"))
os.environ.setdefault("CHESS_DB_PATH", os.path.join(ROOT, "chess_review.db"))
import database as db  # noqa: E402

status = httpx.get("http://127.0.0.1:8001/api/lichess-engine", timeout=5).json()
print("app says:", status["state"], status.get("error") or "")
if status["state"] != "ready":
    sys.exit(1)
token = db.get_setting("lichess_token")
engine = httpx.get(f"https://lichess.org/api/external-engine/{status['engine_id']}",
                   headers={"Authorization": f"Bearer {token}"}, timeout=10).json()
practice = "--practice" in sys.argv
search = {"nodes": 600000} if practice else {"movetime": 3000}
work = {"sessionId": uuid.uuid4().hex[:8], "threads": 2, "hash": 64, "multiPv": 1,
        "variant": "chess", "initialFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "moves": ["e2e4", "e7e5", "g1f3"], **search}
started = time.monotonic()
last = None
with httpx.stream("POST", f"{engine['endpoint'] if 'endpoint' in engine else 'https://engine.lichess.ovh'}"
                  f"/api/external-engine/{engine['id']}/analyse",
                  json={"clientSecret": engine["clientSecret"], "work": work}, timeout=60) as res:
    print("broker answered", res.status_code)
    for line in res.iter_lines():
        if not line:
            continue
        last = json.loads(line)
        if "keepalive" in last:
            continue
        pv = (last.get("pvs") or [{}])[0]
        print(f"{time.monotonic() - started:5.1f}s  depth {last.get('depth')}  "
              f"score {pv.get('cp', pv.get('mate'))}  {' '.join(pv.get('moves', [])[:6])}")
        if time.monotonic() - started > 15:
            break
print("OK" if last and "depth" in last else "NO ANALYSIS RECEIVED")
