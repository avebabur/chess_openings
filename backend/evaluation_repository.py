"""SQLite repositories for cached and user-saved position evaluations."""
import json

from database import get_db

# --- Lichess cloud-eval cache ---

def get_cloud_eval_cached(fen):
    conn = get_db()
    row = conn.execute(
        "SELECT payload, source, fetched_at FROM cloud_eval_cache WHERE fen = ?", (fen,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"payload": json.loads(row["payload"]), "source": row["source"],
            "fetched_at": row["fetched_at"]}


def put_cloud_eval(fen, payload, source):
    conn = get_db()
    conn.execute(
        """INSERT INTO cloud_eval_cache (fen, payload, source, fetched_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(fen) DO UPDATE SET
             payload = excluded.payload, source = excluded.source,
             fetched_at = datetime('now')""",
        (fen, json.dumps(payload), source),
    )
    conn.commit()
    conn.close()


# --- User-saved deep Stockfish evals ---

def get_saved_eval(fen):
    """The saved deep eval payload for ``fen`` (or None)."""
    conn = get_db()
    row = conn.execute(
        "SELECT payload, depth, saved_at FROM saved_eval WHERE fen = ?", (fen,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"payload": json.loads(row["payload"]), "depth": row["depth"],
            "saved_at": row["saved_at"]}


def put_saved_eval(fen, payload, depth=None):
    conn = get_db()
    conn.execute(
        """INSERT INTO saved_eval (fen, payload, depth, saved_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(fen) DO UPDATE SET
             payload = excluded.payload, depth = excluded.depth,
             saved_at = datetime('now')""",
        (fen, json.dumps(payload), depth),
    )
    conn.commit()
    conn.close()


def delete_saved_eval(fen):
    conn = get_db()
    conn.execute("DELETE FROM saved_eval WHERE fen = ?", (fen,))
    conn.commit()
    conn.close()


# --- Lichess opening-explorer cache ---

def get_explorer_cached(fen):
    conn = get_db()
    row = conn.execute(
        "SELECT payload, source, fetched_at FROM explorer_cache WHERE fen = ?", (fen,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"payload": json.loads(row["payload"]), "source": row["source"],
            "fetched_at": row["fetched_at"]}


def put_explorer(fen, payload, source):
    conn = get_db()
    conn.execute(
        """INSERT INTO explorer_cache (fen, payload, source, fetched_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(fen) DO UPDATE SET
             payload = excluded.payload, source = excluded.source,
             fetched_at = datetime('now')""",
        (fen, json.dumps(payload), source),
    )
    conn.commit()
    conn.close()


