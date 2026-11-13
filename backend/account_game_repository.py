"""SQLite repositories for settings, tracked accounts, sync jobs, and games."""
import json
import sqlite3
import uuid

from database import get_db

# --- Player profile (single-user key/value settings) ---

def get_setting(key, default=None):
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row and row["value"] is not None else default


def set_setting(key, value):
    conn = get_db()
    conn.execute(
        """INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
        (key, value),
    )
    conn.commit()
    conn.close()


# --- Tracked accounts (multi-account) ---

PLATFORMS = ("chesscom", "lichess")


def _account_row(conn, row):
    """An accounts row + how many of its games are imported + its latest sync."""
    games = conn.execute(
        "SELECT COUNT(*) FROM games WHERE account_id = ?", (row["id"],),
    ).fetchone()[0]
    job = conn.execute(
        """SELECT * FROM account_sync_jobs WHERE account_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1""",
        (row["id"],),
    ).fetchone()
    return {
        "id": row["id"],
        "platform": row["platform"],
        "username": row["username"],
        "label": row["label"] or "",
        "created_at": row["created_at"],
        "last_synced_at": row["last_synced_at"],
        "games": games,
        "sync_job": _sync_job_row(job),
    }


def _sync_job_row(row):
    if not row:
        return None
    out = dict(row)
    try:
        out["warnings"] = json.loads(out.get("warnings") or "[]")
    except (TypeError, ValueError):
        out["warnings"] = []
    out["cancel_requested"] = bool(out.get("cancel_requested"))
    return out


def list_accounts():
    conn = get_db()
    rows = conn.execute("SELECT * FROM accounts ORDER BY created_at ASC, id ASC").fetchall()
    out = [_account_row(conn, r) for r in rows]
    conn.close()
    return out


def get_account(account_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    out = _account_row(conn, row) if row else None
    conn.close()
    return out


def create_account(platform, username, label=""):
    platform = (platform or "").strip().lower()
    username = (username or "").strip()
    if platform not in PLATFORMS:
        raise ValueError("platform must be 'chesscom' or 'lichess'")
    if not username:
        raise ValueError("username is required")
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM accounts WHERE platform = ? AND lower(username) = lower(?)",
            (platform, username),
        ).fetchone()
        if existing:
            return _account_row(conn, existing)
        cur = conn.execute(
            "INSERT INTO accounts (platform, username, label) VALUES (?, ?, ?)",
            (platform, username, label or ""),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM accounts WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _account_row(conn, row)
    finally:
        conn.close()


def newest_game_end(account_id):
    """When the account's newest imported game ended (ISO-8601), or None."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT MAX(end_time) AS newest FROM games WHERE account_id = ?", (account_id,),
        ).fetchone()
    finally:
        conn.close()
    return row["newest"] if row else None


def mark_account_synced(account_id, complete=True):
    """Records a finished sync. `complete=False` (part of the history could not
    be fetched) clears the mark instead, so the next sync fetches everything."""
    conn = get_db()
    conn.execute(
        "UPDATE accounts SET last_synced_at = CASE WHEN ? THEN datetime('now') END WHERE id = ?",
        (1 if complete else 0, account_id),
    )
    conn.commit()
    conn.close()


def create_sync_job(account_id):
    conn = get_db()
    try:
        active = conn.execute(
            """SELECT * FROM account_sync_jobs
               WHERE account_id = ? AND status IN ('queued', 'running')
               ORDER BY created_at DESC LIMIT 1""",
            (account_id,),
        ).fetchone()
        if active:
            return _sync_job_row(active), False
        job_id = str(uuid.uuid4())
        try:
            conn.execute(
                "INSERT INTO account_sync_jobs (id, account_id) VALUES (?, ?)",
                (job_id, account_id),
            )
        except sqlite3.IntegrityError:
            active = conn.execute(
                """SELECT * FROM account_sync_jobs
                   WHERE account_id = ? AND status IN ('queued', 'running')
                   ORDER BY created_at DESC LIMIT 1""",
                (account_id,),
            ).fetchone()
            if active:
                return _sync_job_row(active), False
            raise
        conn.commit()
        return get_sync_job(job_id), True
    finally:
        conn.close()


def get_sync_job(job_id):
    conn = get_db()
    try:
        return _sync_job_row(conn.execute(
            "SELECT * FROM account_sync_jobs WHERE id = ?", (job_id,),
        ).fetchone())
    finally:
        conn.close()


def list_queued_sync_jobs():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM account_sync_jobs WHERE status = 'queued' ORDER BY created_at, rowid",
        ).fetchall()
        return [_sync_job_row(row) for row in rows]
    finally:
        conn.close()


def update_sync_job(job_id, *, status=None, seen=None, imported=None, total=None,
                    warnings=None, error=None):
    fields = ["updated_at = datetime('now')"]
    params = []
    for column, value in (("status", status), ("seen", seen), ("imported", imported),
                          ("total", total), ("error", error)):
        if value is not None:
            fields.append(f"{column} = ?")
            params.append(value)
    if warnings is not None:
        fields.append("warnings = ?")
        params.append(json.dumps(warnings))
    if status == "running":
        fields.append("started_at = COALESCE(started_at, datetime('now'))")
    if status in ("completed", "warning", "failed", "cancelled"):
        fields.append("finished_at = datetime('now')")
    params.append(job_id)
    conn = get_db()
    try:
        conn.execute(f"UPDATE account_sync_jobs SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
        return get_sync_job(job_id)
    finally:
        conn.close()


def request_sync_job_cancel(job_id):
    conn = get_db()
    try:
        job = conn.execute(
            "SELECT status FROM account_sync_jobs WHERE id = ?", (job_id,),
        ).fetchone()
        if not job or job["status"] not in ("queued", "running"):
            return None
        if job["status"] == "queued":
            conn.execute(
                """UPDATE account_sync_jobs
                   SET status = 'cancelled', cancel_requested = 1,
                       finished_at = datetime('now'), updated_at = datetime('now')
                   WHERE id = ?""",
                (job_id,),
            )
        else:
            conn.execute(
            """UPDATE account_sync_jobs
               SET cancel_requested = 1, updated_at = datetime('now')
               WHERE id = ?""",
                (job_id,),
            )
        conn.commit()
        return get_sync_job(job_id)
    finally:
        conn.close()


def sync_job_cancel_requested(job_id):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT cancel_requested FROM account_sync_jobs WHERE id = ?", (job_id,),
        ).fetchone()
        return bool(row and row["cancel_requested"])
    finally:
        conn.close()


def recover_sync_jobs():
    """Mark interrupted work failed and return jobs that were safely queued."""
    conn = get_db()
    try:
        conn.execute(
            """UPDATE account_sync_jobs
               SET status = 'failed', error = 'Sync interrupted by app restart',
                   finished_at = datetime('now'), updated_at = datetime('now')
               WHERE status = 'running'""",
        )
        conn.commit()
    finally:
        conn.close()
    return list_queued_sync_jobs()


def delete_account(account_id):
    """Remove an account; its imported games and their mistakes go with it."""
    conn = get_db()
    try:
        cur = conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# --- Imported games ---

def save_imported_games(items):
    """Batch imported games in one transaction; return inserted and seen counts."""
    rows = [item for item in (items or []) if item.get("external_id") and item.get("account_id")]
    if not rows:
        return {"imported": 0, "seen": 0}
    conn = get_db()
    imported = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        for meta in rows:
            existed = conn.execute(
                "SELECT 1 FROM games WHERE account_id = ? AND source = ? AND external_id = ?",
                (meta.get("account_id"), meta.get("source", "chesscom"), meta.get("external_id")),
            ).fetchone()
            conn.execute(
                """INSERT INTO games
                   (white, black, result, date, pgn, source, external_id, user_color,
                    user_rating, opp_rating, time_class, time_control, end_time, eco,
                    opening, account_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(account_id, source, external_id) DO UPDATE SET
                     white=excluded.white, black=excluded.black, result=excluded.result,
                     date=excluded.date, pgn=excluded.pgn, user_color=excluded.user_color,
                     user_rating=excluded.user_rating, opp_rating=excluded.opp_rating,
                     time_class=excluded.time_class, time_control=excluded.time_control,
                     end_time=excluded.end_time, eco=excluded.eco, opening=excluded.opening""",
                (meta.get("white", ""), meta.get("black", ""), meta.get("result", ""),
                 meta.get("date", ""), meta["pgn"], meta.get("source", "chesscom"),
                 meta.get("external_id"), meta.get("user_color"), meta.get("user_rating"),
                 meta.get("opp_rating"), meta.get("time_class"), meta.get("time_control"),
                 meta.get("end_time"), meta.get("eco"), meta.get("opening"),
                 meta.get("account_id")),
            )
            if not existed:
                imported += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"imported": imported, "seen": len(rows)}


def get_games_for_tree(color=None, time_classes=None, account_id=None):
    """Lightweight rows for opening-tree aggregation — only games where we know
    which side the user played. account_id None ⇒ all accounts combined."""
    conn = get_db()
    q = ("SELECT id, pgn, result, user_color, opp_rating, end_time, opening, eco, "
         "time_class FROM games WHERE user_color IS NOT NULL")
    params = []
    if account_id:
        q += " AND account_id = ?"
        params.append(account_id)
    if color in ("white", "black"):
        q += " AND user_color = ?"
        params.append(color)
    if time_classes:
        q += f" AND time_class IN ({','.join('?' * len(time_classes))})"
        params.extend(time_classes)
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_game_summaries(game_ids):
    """{id: metadata (no PGN)} for the given games."""
    if not game_ids:
        return {}
    conn = get_db()
    rows = conn.execute(
        "SELECT id, white, black, result, date, end_time, user_color, user_rating, "
        "opp_rating, time_class, time_control, eco, opening, source "
        f"FROM games WHERE id IN ({','.join('?' * len(game_ids))})", list(game_ids)).fetchall()
    conn.close()
    return {r["id"]: dict(r) for r in rows}


def get_game(game_id):
    """Full game row including the PGN, or None if it doesn't exist."""
    conn = get_db()
    row = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def find_game_by_external_id(source, external_id):
    """`{id, ...metadata}` of an imported game by its site id (Lichess: the
    8-character game id), or None."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, white, black, result, date, end_time, user_color, user_rating, "
            "opp_rating, time_class, time_control, eco, opening, source "
            "FROM games WHERE source = ? AND external_id = ? LIMIT 1",
            (source, external_id)).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None
