"""Lichess cloud-eval lookups with local caching.

`GET https://lichess.org/api/cloud-eval?fen=...&multiPv=` returns a *cached*
crowd evaluation (often depth 40+), or 404 when nobody has analyzed the position.
It is cache-only upstream and rate-limited (harder for anonymous callers), so we:
  - send the user's configured personal API token as a Bearer header for a higher
    limit (same token the opening explorer uses),
  - cache hits forever (the eval of a fixed position doesn't change),
  - cache misses briefly (so we don't re-hammer for unknown positions),
  - throttle live calls and back off on 429,
returning a normalized shape. On a miss/ratelimit the frontend falls back to our
own Stockfish (/evaluate). See [[chess-data-apis]].
"""
import re
import time
import threading
import logging
from datetime import datetime, timedelta, timezone

import httpx

import database as db

log = logging.getLogger("lichess_cloud")

CLOUD_URL = "https://lichess.org/api/cloud-eval"
USER_AGENT = "ChessOpenings/1.0"
_MIN_INTERVAL = 0.6          # seconds between live calls (be polite)
_MISS_TTL = timedelta(hours=24)
_TIMEOUT = httpx.Timeout(6.0)
_COOLDOWN = 60.0             # fallback backoff after a 429 when no Retry-After is sent
_MAX_COOLDOWN = 300.0        # never sit out longer than this, even if Lichess asks

_throttle_lock = threading.Lock()
_last_call = [0.0]
_cooldown_until = [0.0]      # wall-clock time before which we make no live call


def _throttle():
    with _throttle_lock:
        wait = _MIN_INTERVAL - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()


def _cooldown_remaining():
    """Seconds left in the post-429 backoff window (0 when clear)."""
    with _throttle_lock:
        return max(0.0, _cooldown_until[0] - time.time())


def _begin_cooldown(seconds):
    """Hit a 429 — stop all live calls for `seconds` so the IP recovers."""
    with _throttle_lock:
        _cooldown_until[0] = time.time() + seconds


def _retry_after(headers, default):
    """Honor Lichess's Retry-After (delta-seconds) when present, else `default`.
    Clamped so a stray value can't lock us out forever or retry instantly."""
    raw = headers.get("retry-after")
    if raw:
        try:
            return max(1.0, min(_MAX_COOLDOWN, float(raw)))
        except (TypeError, ValueError):
            pass
    return default


def _pv_eval(pv):
    """White-POV eval for a single PV entry."""
    if pv.get("mate") is not None:
        return {"mate": pv["mate"], "pawns": None}
    cp = pv.get("cp")
    return {"cp": cp, "pawns": round(cp / 100, 2) if cp is not None else None}


def _normalize(data):
    pvs = []
    for pv in data.get("pvs", []):
        moves = pv.get("moves", "")
        pvs.append({
            "moves": moves,
            "cp": pv.get("cp"),
            "mate": pv.get("mate"),
            "eval": _pv_eval(pv),
        })
    best = pvs[0] if pvs else {}
    best_moves = (best.get("moves") or "").split()
    return {
        "source": "lichess",
        "depth": data.get("depth"),
        "knodes": data.get("knodes"),
        "fen": data.get("fen"),
        "pvs": pvs,
        "best_move_uci": best_moves[0] if best_moves else None,
        "eval": best.get("eval"),
    }


def _miss_fresh(fetched_at):
    """A cached 'miss' is still trusted if younger than the TTL."""
    if not fetched_at:
        return False
    try:
        dt = datetime.strptime(fetched_at[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    # SQLite datetime() is naive UTC; utcnow() is deprecated as of Python 3.12.
    return datetime.now(timezone.utc).replace(tzinfo=None) - dt < _MISS_TTL


def get_cloud_eval(fen, multipv=1, allow_network=True, client=None):
    """Return a normalized cloud eval. Sources: lichess | miss | ratelimited | error."""
    multipv = max(1, min(5, int(multipv or 1)))
    cached = db.get_cloud_eval_cached(fen)
    if cached:
        if cached["source"] == "lichess":
            # The row is shared by every move order into this position, and the
            # stored `fen` is Lichess's echo from whichever one filled it. Answer
            # with the FEN the caller asked about.
            return {**cached["payload"], "fen": fen}
        if cached["source"] == "miss" and _miss_fresh(cached["fetched_at"]):
            return {"source": "miss", "fen": fen}

    if not allow_network:
        return {"source": "unknown", "fen": fen}

    # Backing off after a recent 429: don't even try — every extra call while
    # rate-limited keeps the IP flagged. Let the frontend use local Stockfish.
    remaining = _cooldown_remaining()
    if remaining > 0:
        return {"source": "ratelimited", "fen": fen, "retry_after": round(remaining)}

    headers = {"User-Agent": USER_AGENT}
    token = db.get_setting("lichess_token")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    _throttle()
    try:
        request_client = client or httpx
        r = request_client.get(
            CLOUD_URL,
            params={"fen": fen, "multiPv": multipv},
            headers=headers,
            timeout=_TIMEOUT,
        )
    except Exception as exc:
        log.warning("Lichess cloud-eval request failed: %s", exc)
        return {"source": "error", "fen": fen, "detail": str(exc)}

    if r.status_code == 200:
        norm = _normalize(r.json())
        db.put_cloud_eval(fen, norm, "lichess")
        return norm
    if r.status_code == 404:
        db.put_cloud_eval(fen, {"source": "miss"}, "miss")
        return {"source": "miss", "fen": fen}
    if r.status_code == 429:
        wait = _retry_after(r.headers, _COOLDOWN)
        _begin_cooldown(wait)
        log.warning("Lichess cloud-eval rate-limited (429); backing off %.0fs "
                    "(Retry-After=%s)", wait, r.headers.get("retry-after"))
        return {"source": "ratelimited", "fen": fen, "retry_after": round(wait)}
    log.warning("Lichess cloud-eval unexpected HTTP %s for fen=%s", r.status_code, fen)
    return {"source": "error", "fen": fen, "status": r.status_code}
