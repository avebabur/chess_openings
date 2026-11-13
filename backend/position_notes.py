"""Comments the user writes on a position.

A note belongs to the position, not to the moves that led there, so it shows
up again in any game or line that reaches the same position by another move
order (the key ignores the move clocks, like the repertoire's).
"""
from database import get_db
from position_key import key_from_fen

MAX_NOTE_CHARS = 4000


def get_note(fen):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT note, updated_at FROM position_notes WHERE position_key = ?",
            (key_from_fen(fen),),
        ).fetchone()
    finally:
        conn.close()
    return {"note": row["note"] if row else "", "updated_at": row["updated_at"] if row else None}


def save_note(fen, note):
    """Store the note for `fen`'s position; an empty note removes it."""
    text = (note or "").strip()[:MAX_NOTE_CHARS]
    key = key_from_fen(fen)
    conn = get_db()
    try:
        with conn:
            if text:
                conn.execute(
                    """INSERT INTO position_notes (position_key, fen, note)
                       VALUES (?, ?, ?)
                       ON CONFLICT(position_key) DO UPDATE SET
                         note = excluded.note, updated_at = datetime('now')""",
                    (key, fen, text),
                )
            else:
                conn.execute("DELETE FROM position_notes WHERE position_key = ?", (key,))
    finally:
        conn.close()
    return get_note(fen)


def list_notes():
    """Every note, newest first, with the position key the frontend compares
    against to mark commented moves."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT position_key, fen, note, updated_at FROM position_notes "
            "ORDER BY updated_at DESC, position_key"
        ).fetchall()
    finally:
        conn.close()
    return [{"key": r["position_key"], "fen": r["fen"], "note": r["note"],
             "updated_at": r["updated_at"]} for r in rows]
