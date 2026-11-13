"""SQLite cache of Lichess tablebase answers (used when checking endgame mistakes)."""
import json

from database import get_db

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
