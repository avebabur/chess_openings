"""SQLite caches: Lichess tablebase answers, and the deepest result your
Stockfish has reached for each position (shared by the study analysis and
Lichess's engine bar)."""
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


# --- Your Stockfish's deepest result per position ---

from position_key import position_key as deep_eval_key  # noqa: E402  (the FEN's first four fields)


class DeepEvalStore:
    """get(key) -> {"depth", "cp" or "mate", "pv": [uci], "nodes"} or None;
    put(key, result) keeps it only when it is deeper than what is stored."""

    def get(self, key):
        conn = get_db()
        try:
            row = conn.execute("SELECT * FROM deep_evals WHERE position = ?", (key,)).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        score = {"mate": row["mate"]} if row["mate"] is not None else {"cp": row["cp"]}
        return {**score, "depth": row["depth"], "pv": row["pv"].split(), "nodes": row["nodes"]}

    def put(self, key, result):
        if not result.get("pv") or not result.get("depth"):
            return False
        mate = result.get("mate")
        conn = get_db()
        try:
            with conn:
                return conn.execute(
                    """INSERT INTO deep_evals (position, depth, cp, mate, pv, nodes, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                       ON CONFLICT(position) DO UPDATE SET depth = excluded.depth,
                         cp = excluded.cp, mate = excluded.mate, pv = excluded.pv,
                         nodes = excluded.nodes, updated_at = excluded.updated_at
                       WHERE excluded.depth > deep_evals.depth""",
                    (key, int(result["depth"]), None if mate is not None else int(result.get("cp", 0)),
                     mate, " ".join(result["pv"]), int(result.get("nodes") or 0))).rowcount > 0
        finally:
            conn.close()
