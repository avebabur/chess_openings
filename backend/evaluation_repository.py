"""SQLite repositories for cached and user-saved position evaluations.

Everything here is keyed by **position**, not by FEN. An evaluation depends on
the position alone, so the halfmove clock and move number a transposition
changes must not split it across two rows. Callers still pass FENs — they are
what Lichess and Stockfish speak — and the normalization happens here, at the
single boundary, so no call site can forget it. See [[position_key]].
"""
import json

from database import get_db
from position_key import key_from_fen

# --- Lichess cloud-eval cache ---

def get_cloud_eval_cached(fen):
    conn = get_db()
    row = conn.execute(
        "SELECT payload, source, fetched_at FROM cloud_eval_cache WHERE epd = ?",
        (key_from_fen(fen),),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"payload": json.loads(row["payload"]), "source": row["source"],
            "fetched_at": row["fetched_at"]}


def put_cloud_eval(fen, payload, source):
    conn = get_db()
    conn.execute(
        """INSERT INTO cloud_eval_cache (epd, payload, source, fetched_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(epd) DO UPDATE SET
             payload = excluded.payload, source = excluded.source,
             fetched_at = datetime('now')""",
        (key_from_fen(fen), json.dumps(payload), source),
    )
    conn.commit()
    conn.close()


# --- Lichess tablebase cache ---
# Keyed by the caller's own key (position + halfmove clock), not key_from_fen:
# the 50-move counter is part of what the tablebase answers. See lichess_tablebase.

def get_tablebase_cached(position):
    conn = get_db()
    row = conn.execute(
        "SELECT payload FROM tablebase_cache WHERE position = ?", (position,),
    ).fetchone()
    conn.close()
    return json.loads(row["payload"]) if row else None


def put_tablebase(position, payload):
    conn = get_db()
    conn.execute(
        """INSERT INTO tablebase_cache (position, payload, fetched_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(position) DO UPDATE SET
             payload = excluded.payload, fetched_at = datetime('now')""",
        (position, json.dumps(payload)),
    )
    conn.commit()
    conn.close()


# --- User-saved deep Stockfish evals ---

def get_saved_eval(fen):
    """The saved deep eval payload for ``fen``'s position (or None)."""
    conn = get_db()
    row = conn.execute(
        "SELECT payload, depth, saved_at FROM saved_eval WHERE epd = ?",
        (key_from_fen(fen),),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"payload": json.loads(row["payload"]), "depth": row["depth"],
            "saved_at": row["saved_at"]}


def put_saved_eval(fen, payload, depth=None):
    conn = get_db()
    conn.execute(
        """INSERT INTO saved_eval (epd, payload, depth, saved_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(epd) DO UPDATE SET
             payload = excluded.payload, depth = excluded.depth,
             saved_at = datetime('now')""",
        (key_from_fen(fen), json.dumps(payload), depth),
    )
    conn.commit()
    conn.close()


def delete_saved_eval(fen):
    conn = get_db()
    conn.execute("DELETE FROM saved_eval WHERE epd = ?", (key_from_fen(fen),))
    conn.commit()
    conn.close()


# --- Lichess opening-explorer cache ---
#
# `cache_key` is an opaque key built by lichess_explorer._cache_key(), NOT a bare
# position key: filtered requests (speeds / ratings / date range) append a
# canonical filter signature so their aggregates can't collide with the
# unfiltered one. That builder does the position normalization; these two just
# store what they're given.

def get_explorer_cached(cache_key):
    conn = get_db()
    row = conn.execute(
        "SELECT payload, source, fetched_at FROM explorer_cache WHERE cache_key = ?",
        (cache_key,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"payload": json.loads(row["payload"]), "source": row["source"],
            "fetched_at": row["fetched_at"]}


def put_explorer(cache_key, payload, source):
    conn = get_db()
    conn.execute(
        """INSERT INTO explorer_cache (cache_key, payload, source, fetched_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(cache_key) DO UPDATE SET
             payload = excluded.payload, source = excluded.source,
             fetched_at = datetime('now')""",
        (cache_key, json.dumps(payload), source),
    )
    conn.commit()
    conn.close()


