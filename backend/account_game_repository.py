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
    """An accounts row + its imported/analyzed game counts."""
    counts = conn.execute(
        """SELECT COUNT(*) AS total, COALESCE(SUM(analyzed), 0) AS analyzed
           FROM games WHERE account_id = ? AND merged_into_game_id IS NULL""",
        (row["id"],),
    ).fetchone()
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
        "games": counts["total"],
        "analyzed": counts["analyzed"],
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


def mark_account_synced(account_id):
    conn = get_db()
    conn.execute(
        "UPDATE accounts SET last_synced_at = datetime('now') WHERE id = ?", (account_id,),
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


def delete_account(account_id, delete_games=True):
    """Remove an account. By default its imported games go too (they're only
    useful in the context of that account); pass delete_games=False to orphan
    them instead (account_id → NULL, so they drop out of the per-account tree)."""
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM accounts WHERE id = ?", (account_id,)).fetchone():
            return False
        if delete_games:
            game_ids = [
                row["id"] for row in conn.execute(
                    "SELECT id FROM games WHERE account_id = ?", (account_id,),
                ).fetchall()
            ]
            if game_ids:
                placeholders = ",".join("?" * len(game_ids))
                conn.execute(
                    f"DELETE FROM puzzles WHERE game_id IN ({placeholders})", game_ids,
                )
                conn.execute(
                    f"DELETE FROM reanalyze_jobs WHERE game_id IN ({placeholders})", game_ids,
                )
                conn.execute(
                    f"DELETE FROM games WHERE merged_into_game_id IN ({placeholders})", game_ids,
                )
            conn.execute("DELETE FROM games WHERE account_id = ?", (account_id,))
        else:
            conn.execute("UPDATE games SET account_id = NULL WHERE account_id = ?", (account_id,))
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def migrate_games_to_accounts():
    """Back-fill accounts + games.account_id from existing imported games.

    Each game records who the user was (user_color → white/black name) and its
    source, so we derive one account per (source, owner-username) and tag every
    game with it. Historical single-account imports become the first account with
    no re-import. Idempotent: only touches games whose account_id is still NULL."""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, white, black, user_color, COALESCE(source, 'manual') AS source
               FROM games
               WHERE account_id IS NULL AND merged_into_game_id IS NULL
                 AND user_color IN ('white', 'black')""",
        ).fetchall()
        if not rows:
            return
        cache = {}  # (platform, lower-username) -> account_id
        for r in rows:
            owner = ((r["white"] if r["user_color"] == "white" else r["black"]) or "").strip()
            if not owner:
                continue
            platform = r["source"] if r["source"] in PLATFORMS else "chesscom"
            key = (platform, owner.lower())
            account_id = cache.get(key)
            if account_id is None:
                existing = conn.execute(
                    "SELECT id FROM accounts WHERE platform = ? AND lower(username) = lower(?)",
                    (platform, owner),
                ).fetchone()
                if existing:
                    account_id = existing["id"]
                else:
                    cur = conn.execute(
                        "INSERT INTO accounts (platform, username) VALUES (?, ?)",
                        (platform, owner),
                    )
                    account_id = cur.lastrowid
                cache[key] = account_id
            conn.execute("UPDATE games SET account_id = ? WHERE id = ?", (account_id, r["id"]))
        conn.commit()
    finally:
        conn.close()


# --- Imported games (chess.com) ---

def save_imported_game(meta):
    """Insert one imported game; dedups on (source, external_id).

    Returns (game_id, inserted_bool)."""
    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO games
               (white, black, result, date, pgn, source, external_id, user_color,
                user_rating, opp_rating, time_class, time_control, end_time, eco,
                opening, account_id, analyzed, analysis)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)
               ON CONFLICT(account_id, source, external_id) DO NOTHING""",
            (meta.get("white", ""), meta.get("black", ""), meta.get("result", ""),
             meta.get("date", ""), meta["pgn"], meta.get("source", "chesscom"),
             meta.get("external_id"), meta.get("user_color"), meta.get("user_rating"),
             meta.get("opp_rating"), meta.get("time_class"), meta.get("time_control"),
             meta.get("end_time"), meta.get("eco"), meta.get("opening"),
             meta.get("account_id")),
        )
        conn.commit()
        if cur.rowcount:
            return cur.lastrowid, True
        row = conn.execute(
            "SELECT id FROM games WHERE account_id = ? AND source = ? AND external_id = ?",
            (meta.get("account_id"), meta.get("source", "chesscom"), meta.get("external_id")),
        ).fetchone()
        return (row["id"] if row else None), False
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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
                    opening, account_id, analyzed, analysis)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)
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


def count_games_by_source():
    conn = get_db()
    rows = conn.execute(
        """SELECT COALESCE(source, 'manual') AS source,
                  COUNT(*) AS total,
                  COALESCE(SUM(analyzed), 0) AS analyzed
           FROM games WHERE merged_into_game_id IS NULL
           GROUP BY COALESCE(source, 'manual')""",
    ).fetchall()
    conn.close()
    out = {"total": 0, "analyzed": 0, "by_source": {}}
    for r in rows:
        out["by_source"][r["source"]] = {"total": r["total"], "analyzed": r["analyzed"]}
        out["total"] += r["total"]
        out["analyzed"] += r["analyzed"]
    return out


def get_games_for_tree(color=None, time_classes=None, account_id=None):
    """Lightweight rows for opening-tree aggregation — only games where we know
    which side the user played. account_id None ⇒ all accounts combined."""
    conn = get_db()
    q = ("SELECT id, pgn, result, user_color, opp_rating, end_time, opening, eco, "
         "time_class, analyzed FROM games WHERE user_color IS NOT NULL "
         "AND merged_into_game_id IS NULL")
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


def _games_filter(account_id, color, time_classes):
    """Shared WHERE clause + params for the games browser (list + count)."""
    q = " AND merged_into_game_id IS NULL"
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
    return q, params


def list_games(account_id=None, color=None, time_classes=None, limit=50, offset=0):
    """Game metadata (no PGN) for the games browser, newest first.

    `end_time` is ISO-8601 so it sorts lexicographically; NULLs (rare manual
    games) sort last in DESC order, which is fine. account_id None ⇒ all accounts."""
    conn = get_db()
    where, params = _games_filter(account_id, color, time_classes)
    q = ("SELECT id, white, black, result, date, end_time, user_color, "
         "user_rating, opp_rating, time_class, time_control, eco, opening, "
         "source, analyzed FROM games WHERE 1=1" + where +
         " ORDER BY end_time DESC, id DESC LIMIT ? OFFSET ?")
    rows = conn.execute(q, [*params, limit, offset]).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def count_games(account_id=None, color=None, time_classes=None):
    """Total games matching the browser filter (for the header + paging end)."""
    conn = get_db()
    where, params = _games_filter(account_id, color, time_classes)
    row = conn.execute("SELECT COUNT(*) AS n FROM games WHERE 1=1" + where, params).fetchone()
    conn.close()
    return row["n"] if row else 0


def get_game(game_id):
    """Full game row including the PGN, or None if it doesn't exist."""
    conn = get_db()
    row = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    if row and row["merged_into_game_id"]:
        row = conn.execute(
            "SELECT * FROM games WHERE id = ?", (row["merged_into_game_id"],),
        ).fetchone()
    conn.close()
    if not row:
        return None
    result = dict(row)
    result["analysis"] = json.loads(result["analysis"]) if result["analysis"] else None
    return result

