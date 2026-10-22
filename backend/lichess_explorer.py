"""Lichess Opening Explorer (all-games DB) with local caching.

`GET https://explorer.lichess.ovh/lichess?fen=...` returns the crowd's move
choices at a position with White/Draw/Black game counts. Like cloud-eval it is
rate-limited for anonymous callers, so we:
  - cache positions that have games forever (their aggregate is stable enough),
  - cache empty positions briefly (so a line that later gains games re-appears),
  - throttle live calls and back off on 429,
returning a normalized shape. Counts stay ABSOLUTE (White wins / draws / Black
wins); the frontend colors them White/Draw/Black. This is the `lichess` (all
players) database — deliberately NOT `/masters`. See [[chess-data-apis]].
"""
import time
import threading
import logging
from datetime import datetime, timedelta, timezone

import httpx

import database as db
from position_key import key_from_fen

log = logging.getLogger("lichess_explorer")

EXPLORER_URL = "https://explorer.lichess.ovh/lichess"
USER_AGENT = "ChessOpenings/1.0"
_MIN_INTERVAL = 0.6          # seconds between live calls (be polite)
_MISS_TTL = timedelta(hours=24)
_TIMEOUT = httpx.Timeout(8.0)
_MOVES_LIMIT = 12            # top N replies — enough for the narrow analysis rail
_COOLDOWN = 60.0            # fallback backoff after a 429 when no Retry-After is sent
_MAX_COOLDOWN = 300.0       # never sit out longer than this, even if Lichess asks

# --- Filters ---
# Lichess narrows the aggregate by time control, rating band and date range. These
# are the *only* values it accepts (see lila-openingexplorer's Speed/RatingGroup and
# lila's own explorerConfig.ts) — `ratings` are band LOWER BOUNDS, not free numbers,
# so 1500 is rejected while 1400 selects the 1400-1600 band.
SPEEDS = ("ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence")
RATING_GROUPS = (400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500)
MIN_YEAR = 1952             # Lichess's earliest indexed month

_throttle_lock = threading.Lock()
_last_call = [0.0]
_cooldown_until = [0.0]      # wall-clock time before which we make no live call

# Process-wide pooled client for callers that don't pass one (tests / direct use).
# httpx.Client is thread-safe to share, and reusing it keeps the connection to
# Lichess warm instead of opening a fresh socket per request (the old `client or
# httpx` fallback used the module's one-shot helpers, which pool nothing).
_fallback_client = None
_fallback_client_lock = threading.Lock()


def _shared_client():
    global _fallback_client
    if _fallback_client is None:
        with _fallback_client_lock:
            if _fallback_client is None:
                _fallback_client = httpx.Client(timeout=_TIMEOUT, follow_redirects=True)
    return _fallback_client


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


def _miss_fresh(fetched_at):
    """A cached empty result is still trusted if younger than the TTL."""
    if not fetched_at:
        return False
    try:
        dt = datetime.strptime(fetched_at[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    # SQLite datetime() is naive UTC; utcnow() is deprecated as of Python 3.12.
    return datetime.now(timezone.utc).replace(tzinfo=None) - dt < _MISS_TTL


def _empty(fen):
    return {"source": "lichess", "fen": fen, "white": 0, "draws": 0,
            "black": 0, "total": 0, "opening": None, "moves": []}


def _clean(filters):
    """Drop empty/absent filter entries so 'no filter' is a single canonical shape."""
    if not filters:
        return {}
    out = {}
    for key in ("speeds", "ratings"):
        values = filters.get(key)
        if values:
            out[key] = sorted(values, key=str)
    for key in ("since", "until"):
        value = (filters.get(key) or "").strip()
        if value:
            out[key] = value
    return out


def _filter_params(filters):
    """Filters → Lichess query params. An unset filter is omitted entirely, so an
    unfiltered request sends exactly what it always did."""
    clean = _clean(filters)
    params = {}
    for key in ("speeds", "ratings"):
        if key in clean:
            params[key] = ",".join(str(v) for v in clean[key])
    for key in ("since", "until"):
        if key in clean:
            params[key] = clean[key]
    return params


def _cache_key(fen, filters):
    """Cache key for a (position, filters) pair.

    The position half is the position key, not the FEN, so the same position
    reached by another move order is one cache row rather than two (the explorer
    aggregate depends only on the position). Filtered requests get a canonical,
    order-independent suffix so a blitz-only aggregate can never be served as the
    overall one, or vice versa.
    """
    epd = key_from_fen(fen)
    clean = _clean(filters)
    if not clean:
        return epd
    sig = "&".join(
        f"{key}={','.join(str(v) for v in clean[key]) if isinstance(clean[key], list) else clean[key]}"
        for key in sorted(clean)
    )
    return f"{epd}|{sig}"


def _normalize(data, fen):
    """Lichess explorer JSON → the shape EnginePanel consumes. Counts absolute."""
    white = data.get("white", 0) or 0
    draws = data.get("draws", 0) or 0
    black = data.get("black", 0) or 0
    total = white + draws + black
    moves = []
    for m in data.get("moves") or []:
        w = m.get("white", 0) or 0
        d = m.get("draws", 0) or 0
        b = m.get("black", 0) or 0
        games = w + d + b
        moves.append({
            "uci": m.get("uci"),
            "san": m.get("san"),
            "games": games,
            "white": w, "draws": d, "black": b,
            "share": round(games / total * 100, 1) if total else 0.0,
            "averageRating": m.get("averageRating"),
        })
    return {
        "source": "lichess",
        "fen": fen,
        "white": white, "draws": draws, "black": black,
        "total": total,
        "opening": data.get("opening"),
        "moves": moves,
    }


def get_opening_explorer(fen, allow_network=True, client=None, filters=None):
    """Return normalized explorer stats, optionally narrowed by `filters`
    ({speeds, ratings, since, until} — see SPEEDS / RATING_GROUPS).

    Sources: lichess | ratelimited | auth_required | error. Lichess locked the
    explorer behind login (anonymous calls 401), so we send the user's configured
    personal API token as a Bearer header; `auth_required` tells the UI to add one.
    """
    key = _cache_key(fen, filters)
    cached = db.get_explorer_cached(key)
    if cached:
        if cached["source"] == "lichess":
            # One cache row now serves every move order into this position, so the
            # stored payload's `fen` is whichever order filled it. Echo the FEN
            # that was actually asked about.
            return {**cached["payload"], "fen": fen}
        if cached["source"] == "miss" and _miss_fresh(cached["fetched_at"]):
            return _empty(fen)

    if not allow_network:
        return {"source": "unknown", "fen": fen}

    # Backing off after a recent 429: don't even try — every extra call while
    # rate-limited keeps the IP flagged. The UI shows the cached/empty state.
    remaining = _cooldown_remaining()
    if remaining > 0:
        return {"source": "ratelimited", "fen": fen, "retry_after": round(remaining)}

    headers = {"User-Agent": USER_AGENT}
    token = db.get_setting("lichess_token")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    _throttle()
    try:
        request_client = client or _shared_client()
        r = request_client.get(
            EXPLORER_URL,
            params={"fen": fen, "moves": _MOVES_LIMIT, "topGames": 0, "recentGames": 0,
                    **_filter_params(filters)},
            headers=headers,
            timeout=_TIMEOUT,
        )
    except Exception as exc:
        log.warning("Lichess explorer request failed: %s", exc)
        return {"source": "error", "fen": fen, "detail": str(exc)}

    if r.status_code in (401, 403):
        # No token, or the supplied one is invalid/expired — don't cache; let the
        # UI prompt for a (better) token and retry once configured.
        return {"source": "auth_required", "fen": fen, "has_token": bool(token)}
    if r.status_code == 200:
        try:
            data = r.json()
        except ValueError:
            return {"source": "error", "fen": fen, "detail": "bad json"}
        norm = _normalize(data, fen)
        if norm["moves"]:
            db.put_explorer(key, norm, "lichess")
        else:
            # Legal position nobody has reached yet (or none matching the filters) —
            # soft-cache so it re-checks.
            db.put_explorer(key, {"source": "miss"}, "miss")
        return norm
    if r.status_code == 404:
        db.put_explorer(key, {"source": "miss"}, "miss")
        return _empty(fen)
    if r.status_code == 429:
        wait = _retry_after(r.headers, _COOLDOWN)
        _begin_cooldown(wait)
        log.warning("Lichess explorer rate-limited (429); backing off %.0fs "
                    "(Retry-After=%s)", wait, r.headers.get("retry-after"))
        return {"source": "ratelimited", "fen": fen, "retry_after": round(wait)}
    log.warning("Lichess explorer unexpected HTTP %s for fen=%s", r.status_code, fen)
    return {"source": "error", "fen": fen, "status": r.status_code}
