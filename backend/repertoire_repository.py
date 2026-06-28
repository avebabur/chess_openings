"""SQLite repository for repertoire trees and drill history."""
import sqlite3
import uuid

import eco_openings
from database import get_db

REPERTOIRE_LABELS = {"main", "alternative", "trap", "sideline"}


def _repertoire_label(label, default="sideline"):
    value = (label or default or "sideline").strip().lower()
    return value if value in REPERTOIRE_LABELS else default


def _repertoire_color(color):
    value = (color or "").strip().lower()
    if value not in ("white", "black"):
        raise ValueError("color must be 'white' or 'black'")
    return value


def _default_repertoire_branch_name(moves_san):
    return moves_san if len(moves_san) <= 64 else f"{moves_san[:61]}..."


def _normalize_tags(tags):
    """Accept a list or a comma string; return a clean, de-duped comma string.

    Returns None when given None so callers can distinguish "leave unchanged"
    from "clear the tags".
    """
    if tags is None:
        return None
    items = tags.split(",") if isinstance(tags, str) else list(tags)
    out = []
    lowered = set()
    for raw in items:
        tag = str(raw).strip()
        if tag and tag.lower() not in lowered:
            out.append(tag)
            lowered.add(tag.lower())
    return ",".join(out)


def _tags_to_list(value):
    if not value:
        return []
    return [t.strip() for t in str(value).split(",") if t.strip()]


def _row_get(row, key, default=None):
    """Safe column access for sqlite Rows that may predate a migration."""
    if row is None:
        return default
    try:
        val = row[key]
    except (IndexError, KeyError):
        return default
    return val if val is not None else default


def _branch_row_to_dict(row):
    if row is None:
        return None
    out = dict(row)
    out["tags"] = _tags_to_list(out.get("tags"))
    # Opening names have one source of truth. The legacy free-text column stays
    # physically present for non-destructive migration compatibility, but runtime
    # reads never use it.
    out["opening"] = out.pop("resolved_opening", None) or ""
    out["opening_id"] = _row_get(row, "opening_id")
    return out


def _row_to_dict(row):
    return dict(row) if row else None


def _ensure_repertoire_nodes(conn, color, moves_san, label="main", note=""):
    import chess

    color = _repertoire_color(color)
    raw_moves = (moves_san or "").split()
    if not raw_moves:
        raise ValueError("moves_san is empty")

    branch_label = _repertoire_label(label, "main")
    note = (note or "").strip()

    board = chess.Board()
    parent_id = None
    path = []
    terminal_node_id = None

    for ply, raw_san in enumerate(raw_moves, start=1):
        try:
            move = board.parse_san(raw_san)
        except ValueError as exc:
            raise ValueError(f"Illegal move in line: {raw_san}") from exc
        san = board.san(move)
        uci = move.uci()
        fen_before = board.fen()
        board.push(move)
        fen_after = board.fen()
        path.append(san)
        path_san = " ".join(path)

        existing = conn.execute(
            "SELECT id FROM repertoire_nodes WHERE color = ? AND path_san = ?",
            (color, path_san),
        ).fetchone()
        if existing:
            terminal_node_id = existing["id"]
            conn.execute(
                """UPDATE repertoire_nodes
                   SET parent_id = ?, ply = ?, san = ?, uci = ?,
                       fen_before = ?, fen_after = ?, updated_at = datetime('now')
                   WHERE id = ?""",
                (parent_id, ply, san, uci, fen_before, fen_after, terminal_node_id),
            )
        else:
            cur = conn.execute(
                """INSERT INTO repertoire_nodes
                   (color, parent_id, ply, san, uci, fen_before, fen_after, path_san)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (color, parent_id, ply, san, uci, fen_before, fen_after, path_san),
            )
            terminal_node_id = cur.lastrowid
        parent_id = terminal_node_id

    normalized_moves = " ".join(path)
    conn.execute(
        """UPDATE repertoire_nodes
           SET label = ?, note = ?, updated_at = datetime('now')
           WHERE id = ?""",
        (branch_label, note, terminal_node_id),
    )
    return normalized_moves, terminal_node_id


def save_repertoire_branch(color, name, moves_san, label="main", note="",
                           opening="", tags=None, opening_id=None):
    """Upsert a branch (one exact line) and its move nodes.

    A line is identified by color + SAN path, so every distinct variation is its
    own branch — saving the Caro-Kann Advance never overwrites the Exchange.
    Branches sharing an opening (repertoire_openings) are grouped together.
    """
    color = _repertoire_color(color)
    branch_label = _repertoire_label(label, "main")
    name = (name or "").strip()
    note = (note or "").strip()
    opening = (opening or "").strip()
    tags_str = _normalize_tags(tags) or ""

    conn = get_db()
    try:
        normalized_moves, terminal_node_id = _ensure_repertoire_nodes(
            conn, color, moves_san, branch_label, note,
        )
        # Nothing was assigned by hand → recognize the opening from the moves so
        # the line is grouped instead of dumped into "Ungrouped". The user can
        # still override the suggested name in the editor before saving.
        if not opening_id and not opening:
            recognized = eco_openings.classify(normalized_moves)
            if recognized:
                opening = recognized["name"]
        resolved_opening_id, opening = _resolve_opening(conn, color, opening_id, opening)
        default_name = _default_repertoire_branch_name(normalized_moves)
        if not name:
            name = default_name

        existing_branch = conn.execute(
            "SELECT id FROM repertoire_branches WHERE color = ? AND moves_san = ?",
            (color, normalized_moves),
        ).fetchone()
        if existing_branch:
            branch_id = existing_branch["id"]
            conn.execute(
                """UPDATE repertoire_branches
                   SET name = ?, terminal_node_id = ?, label = ?, note = ?,
                       opening = ?, opening_id = ?, tags = ?, updated_at = datetime('now')
                   WHERE id = ?""",
                (name, terminal_node_id, branch_label, note, "",
                 resolved_opening_id, tags_str, branch_id),
            )
        else:
            cur = conn.execute(
                """INSERT INTO repertoire_branches
                   (color, name, moves_san, terminal_node_id, label, note, opening, opening_id, tags)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (color, name, normalized_moves, terminal_node_id, branch_label, note,
                 "", resolved_opening_id, tags_str),
            )
            branch_id = cur.lastrowid
        conn.commit()
        return {
            "id": branch_id,
            "color": color,
            "name": name,
            "moves_san": normalized_moves,
            "terminal_node_id": terminal_node_id,
            "label": branch_label,
            "note": note,
            "opening": opening,
            "opening_id": resolved_opening_id,
            "tags": _tags_to_list(tags_str),
        }
    finally:
        conn.close()


def update_repertoire_branch(branch_id, color=None, name=None, moves_san=None,
                             label=None, note=None, opening=None, tags=None,
                             opening_id=None):
    conn = get_db()
    try:
        branch = conn.execute(
            "SELECT * FROM repertoire_branches WHERE id = ?", (branch_id,),
        ).fetchone()
        if not branch:
            return None

        next_color = _repertoire_color(color if color is not None else branch["color"])
        branch_label = _repertoire_label(
            label if label is not None else branch["label"],
            "main",
        )
        branch_note = (
            note if note is not None else branch["note"] or ""
        ).strip()
        branch_name = (
            name if name is not None else branch["name"] or ""
        ).strip()
        current_opening = conn.execute(
            "SELECT name FROM repertoire_openings WHERE id = ?",
            (_row_get(branch, "opening_id"),),
        ).fetchone()
        branch_opening_text = (
            opening if opening is not None
            else (current_opening["name"] if current_opening else "")
        ).strip()
        if opening_id is not None or opening is not None or next_color != branch["color"]:
            branch_opening_id, branch_opening = _resolve_opening(
                conn, next_color, opening_id, branch_opening_text,
            )
        else:
            branch_opening_id = _row_get(branch, "opening_id")
            branch_opening = branch_opening_text
        branch_tags = (
            _normalize_tags(tags) if tags is not None
            else _row_get(branch, "tags", "")
        ) or ""
        next_moves = moves_san if moves_san is not None else branch["moves_san"]
        normalized_moves, terminal_node_id = _ensure_repertoire_nodes(
            conn, next_color, next_moves, branch_label, branch_note,
        )
        if not branch_name:
            branch_name = _default_repertoire_branch_name(normalized_moves)

        duplicate = conn.execute(
            """SELECT id FROM repertoire_branches
               WHERE color = ? AND moves_san = ? AND id != ?""",
            (next_color, normalized_moves, branch_id),
        ).fetchone()
        if duplicate:
            raise ValueError("A branch already exists for this line")

        old_terminal_node_id = branch["terminal_node_id"]
        training_reset = (
            next_color != branch["color"] or normalized_moves != branch["moves_san"]
        )
        cur = conn.execute(
            """UPDATE repertoire_branches
               SET color = ?, name = ?, moves_san = ?, terminal_node_id = ?,
                   label = ?, note = ?, opening = ?, opening_id = ?, tags = ?,
                   drill_count = CASE WHEN ? THEN 0 ELSE drill_count END,
                   drill_solved = CASE WHEN ? THEN 0 ELSE drill_solved END,
                   last_drilled_at = CASE WHEN ? THEN NULL ELSE last_drilled_at END,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (
                next_color,
                branch_name,
                normalized_moves,
                terminal_node_id,
                branch_label,
                branch_note,
                "",
                branch_opening_id,
                branch_tags,
                1 if training_reset else 0,
                1 if training_reset else 0,
                1 if training_reset else 0,
                branch_id,
            ),
        )
        if old_terminal_node_id and old_terminal_node_id != terminal_node_id:
            _prune_orphan_repertoire_nodes(conn, old_terminal_node_id)
        conn.commit()
        if cur.rowcount == 0:
            return None
        result = _branch_row_to_dict(conn.execute(
            """SELECT b.*, o.name AS resolved_opening
               FROM repertoire_branches b
               LEFT JOIN repertoire_openings o ON o.id = b.opening_id
               WHERE b.id = ?""", (branch_id,),
        ).fetchone())
        result["training_reset"] = training_reset
        return result
    finally:
        conn.close()


def migrate_repertoire_lines_to_tree():
    """One-way compatibility migration from the original flat line table.

    Existing tree branches are never updated here: startup compatibility work must
    not overwrite names, tags, notes, or opening assignments edited in the new UI.
    """
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT l.color, l.name, l.moves_san
               FROM repertoire_lines l
               WHERE NOT EXISTS (
                 SELECT 1 FROM repertoire_branches b
                 WHERE b.color = l.color AND b.moves_san = l.moves_san
               )""",
        ).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            save_repertoire_branch(row["color"], row["name"], row["moves_san"], label="main")
        except Exception:
            # A corrupt legacy line should not block app startup.
            pass


def migrate_branch_openings_to_entities():
    """Promote each distinct free-text branch.opening into a real opening row.

    Idempotent: re-running only links branches that don't yet have an
    opening_id. The legacy `opening` text column stays populated (kept in sync
    on save/rename) so any UI that groups by name keeps working.
    """
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT DISTINCT color, opening FROM repertoire_branches
               WHERE COALESCE(opening, '') != '' AND opening_id IS NULL""",
        ).fetchall()
        for row in rows:
            color = _repertoire_color(row["color"])
            name = (row["opening"] or "").strip()
            if not name:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO repertoire_openings (color, name) VALUES (?, ?)",
                (color, name),
            )
            opening = conn.execute(
                "SELECT id FROM repertoire_openings WHERE color = ? AND name = ?",
                (color, name),
            ).fetchone()
            if opening:
                conn.execute(
                    "UPDATE repertoire_branches SET opening_id = ?, opening = '' WHERE color = ? AND opening = ? AND opening_id IS NULL",
                    (opening["id"], color, name),
                )
        # Once links exist, erase the duplicate value. Names are always derived
        # through opening_id from this point onward.
        conn.execute("UPDATE repertoire_branches SET opening = '' WHERE opening_id IS NOT NULL")
        conn.commit()
    except sqlite3.OperationalError:
        # Pre-migration databases without the columns yet: skip silently.
        pass
    finally:
        conn.close()


def _resolve_opening(conn, color, opening_id=None, opening_name=None):
    """Return (opening_id, name) for a branch, creating the opening if needed.

    Prefers an explicit opening_id; otherwise resolves the typed name to an
    existing opening (case-insensitive) or creates a new one. Empty name → no
    opening (Ungrouped).
    """
    if opening_id:
        row = conn.execute(
            "SELECT id, name FROM repertoire_openings WHERE id = ? AND color = ?",
            (opening_id, color),
        ).fetchone()
        if row:
            return row["id"], row["name"]
    name = (opening_name or "").strip()
    if not name:
        return None, ""
    existing = conn.execute(
        "SELECT id, name FROM repertoire_openings WHERE color = ? AND name = ? COLLATE NOCASE",
        (color, name),
    ).fetchone()
    if existing:
        return existing["id"], existing["name"]
    cur = conn.execute(
        "INSERT INTO repertoire_openings (color, name) VALUES (?, ?)",
        (color, name),
    )
    return cur.lastrowid, name


def list_repertoire_openings(color):
    """Openings for a color with per-opening drill stats for the trainer.

    `lines`/`trained`/`clean` mirror the branch buckets computed in the UI
    (trainedBranches / cleanBranches).
    """
    color = _repertoire_color(color)
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT o.id, o.color, o.name, o.note,
                      COUNT(b.id) AS lines,
                      COALESCE(SUM(CASE WHEN b.drill_count > 0 THEN 1 ELSE 0 END), 0) AS trained,
                      COALESCE(SUM(CASE WHEN b.drill_count > 0 AND b.drill_solved = b.drill_count THEN 1 ELSE 0 END), 0) AS clean
               FROM repertoire_openings o
               LEFT JOIN repertoire_branches b ON b.opening_id = o.id
               WHERE o.color = ?
               GROUP BY o.id
               ORDER BY o.name COLLATE NOCASE""",
            (color,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def create_repertoire_opening(color, name, note=""):
    color = _repertoire_color(color)
    name = (name or "").strip()
    if not name:
        raise ValueError("Opening name is required")
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM repertoire_openings WHERE color = ? AND name = ? COLLATE NOCASE",
            (color, name),
        ).fetchone()
        if existing:
            raise ValueError("An opening with this name already exists")
        cur = conn.execute(
            "INSERT INTO repertoire_openings (color, name, note) VALUES (?, ?, ?)",
            (color, name, (note or "").strip()),
        )
        conn.commit()
        return {"id": cur.lastrowid, "color": color, "name": name,
                "note": (note or "").strip(), "lines": 0, "trained": 0, "clean": 0}
    finally:
        conn.close()


def update_repertoire_opening(opening_id, name=None, note=None):
    conn = get_db()
    try:
        opening = conn.execute(
            "SELECT * FROM repertoire_openings WHERE id = ?", (opening_id,),
        ).fetchone()
        if not opening:
            return None
        next_name = (name if name is not None else opening["name"]).strip()
        if not next_name:
            raise ValueError("Opening name is required")
        next_note = (note if note is not None else opening["note"] or "").strip()
        if next_name.lower() != (opening["name"] or "").lower():
            clash = conn.execute(
                "SELECT id FROM repertoire_openings WHERE color = ? AND name = ? COLLATE NOCASE AND id != ?",
                (opening["color"], next_name, opening_id),
            ).fetchone()
            if clash:
                raise ValueError("An opening with this name already exists")
        conn.execute(
            "UPDATE repertoire_openings SET name = ?, note = ?, updated_at = datetime('now') WHERE id = ?",
            (next_name, next_note, opening_id),
        )
        conn.execute(
            "UPDATE repertoire_branches SET updated_at = datetime('now') WHERE opening_id = ?",
            (opening_id,),
        )
        conn.commit()
        return {"id": opening_id, "color": opening["color"], "name": next_name, "note": next_note}
    finally:
        conn.close()


def delete_repertoire_opening(opening_id):
    """Delete an opening; its branches survive but become Ungrouped."""
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT id FROM repertoire_openings WHERE id = ?", (opening_id,),
        ).fetchone()
        if not exists:
            return False
        conn.execute(
            "UPDATE repertoire_branches SET opening_id = NULL, opening = '', updated_at = datetime('now') WHERE opening_id = ?",
            (opening_id,),
        )
        cur = conn.execute("DELETE FROM repertoire_openings WHERE id = ?", (opening_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def get_repertoire_branches(color=None):
    conn = get_db()
    try:
        params = []
        where = ""
        if color in ("white", "black"):
            where = "WHERE b.color = ?"
            params.append(color)
        rows = conn.execute(
            f"""SELECT b.*, o.name AS resolved_opening
                FROM repertoire_branches b
                LEFT JOIN repertoire_openings o ON o.id = b.opening_id {where}
                ORDER BY
                  CASE WHEN COALESCE(o.name, '') = '' THEN 1 ELSE 0 END,
                  o.name COLLATE NOCASE,
                  b.name COLLATE NOCASE,
                  b.id""",
            params,
        ).fetchall()
        return [_branch_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_repertoire_branch(branch_id):
    conn = get_db()
    try:
        return _branch_row_to_dict(conn.execute(
            """SELECT b.*, o.name AS resolved_opening
               FROM repertoire_branches b
               LEFT JOIN repertoire_openings o ON o.id = b.opening_id
               WHERE b.id = ?""", (branch_id,),
        ).fetchone())
    finally:
        conn.close()


def delete_repertoire_branch(branch_id):
    conn = get_db()
    try:
        branch = conn.execute(
            "SELECT terminal_node_id FROM repertoire_branches WHERE id = ?", (branch_id,),
        ).fetchone()
        conn.execute(
            "UPDATE repertoire_drill_attempts SET branch_id = NULL WHERE branch_id = ?",
            (branch_id,),
        )
        cur = conn.execute("DELETE FROM repertoire_branches WHERE id = ?", (branch_id,))
        if branch and branch["terminal_node_id"]:
            _prune_orphan_repertoire_nodes(conn, branch["terminal_node_id"])
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def _prune_orphan_repertoire_nodes(conn, node_id):
    """Remove unreferenced leaf nodes after deleting a branch.

    Shared trunks remain: pruning stops as soon as a node still has another
    child or is the terminal node of another branch.
    """
    while node_id:
        row = conn.execute(
            "SELECT id, parent_id FROM repertoire_nodes WHERE id = ?", (node_id,),
        ).fetchone()
        if not row:
            return
        branch_refs = conn.execute(
            "SELECT COUNT(*) AS n FROM repertoire_branches WHERE terminal_node_id = ?",
            (node_id,),
        ).fetchone()["n"]
        child_refs = conn.execute(
            "SELECT COUNT(*) AS n FROM repertoire_nodes WHERE parent_id = ?",
            (node_id,),
        ).fetchone()["n"]
        if branch_refs or child_refs:
            return
        conn.execute(
            "UPDATE repertoire_drill_attempts SET node_id = NULL WHERE node_id = ?",
            (node_id,),
        )
        conn.execute("DELETE FROM repertoire_nodes WHERE id = ?", (node_id,))
        node_id = row["parent_id"]


def update_repertoire_node(node_id, label=None, note=None):
    fields = []
    params = []
    if label is not None:
        fields.append("label = ?")
        params.append(_repertoire_label(label, "sideline"))
    if note is not None:
        fields.append("note = ?")
        params.append((note or "").strip())
    if not fields:
        return get_repertoire_node(node_id)
    fields.append("updated_at = datetime('now')")
    params.append(node_id)
    conn = get_db()
    try:
        cur = conn.execute(
            f"UPDATE repertoire_nodes SET {', '.join(fields)} WHERE id = ?",
            params,
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        return get_repertoire_node(node_id)
    finally:
        conn.close()


def get_repertoire_node(node_id):
    conn = get_db()
    try:
        return _row_to_dict(conn.execute(
            "SELECT * FROM repertoire_nodes WHERE id = ?", (node_id,),
        ).fetchone())
    finally:
        conn.close()


def _next_review_offset(solved, interval_days):
    """Return (interval_days, sqlite datetime modifier) for the next review.

    A solved position moves further out (1→2→4… capped at 30 days). A missed
    one comes straight back into the queue so you can re-drill it the same
    session instead of waiting a day.
    """
    if solved:
        next_interval = min(30, max(1, int(interval_days or 1) * 2))
        return next_interval, f"+{next_interval} days"
    return 1, "+0 minutes"


def _drill_source(value):
    source = (value or "practice").strip().lower()
    return source if source in ("practice", "review") else "practice"


def _insert_repertoire_drill_attempt(
    conn,
    *,
    source="practice",
    node_id=None,
    branch_id=None,
    color,
    path_san,
    expected_san="",
    played_san="",
    solved=False,
    event_key=None,
):
    conn.execute(
        """INSERT INTO repertoire_drill_attempts
           (source, node_id, branch_id, color, path_san, expected_san, played_san, solved, event_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            _drill_source(source),
            node_id,
            branch_id,
            color,
            path_san or "",
            expected_san or "",
            played_san or "",
            1 if solved else 0,
            event_key,
        ),
    )


def record_repertoire_node_drill(node_id, solved, attempt=None, event_key=None):
    conn = get_db()
    try:
        event_key = event_key or str(uuid.uuid4())
        conn.execute("BEGIN IMMEDIATE")
        duplicate = conn.execute(
            "SELECT id FROM repertoire_drill_attempts WHERE event_key = ?", (event_key,),
        ).fetchone()
        if duplicate:
            row = conn.execute(
                "SELECT * FROM repertoire_nodes WHERE id = ?", (node_id,),
            ).fetchone()
            result = _row_to_dict(row)
            conn.rollback()
            return {**result, "duplicate": True} if result else None
        row = conn.execute(
            "SELECT interval_days, color, path_san, san FROM repertoire_nodes WHERE id = ?", (node_id,),
        ).fetchone()
        if not row:
            conn.rollback()
            return None
        attempt = attempt or {}
        interval, offset = _next_review_offset(bool(solved), row["interval_days"])
        cur = conn.execute(
            """UPDATE repertoire_nodes
               SET drill_count = drill_count + 1,
                   drill_solved = drill_solved + ?,
                   drill_missed = drill_missed + ?,
                   interval_days = ?,
                   next_review_at = datetime('now', ?),
                   last_drilled_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE id = ?""",
            (1 if solved else 0, 0 if solved else 1, interval, offset, node_id),
        )
        _insert_repertoire_drill_attempt(
            conn,
            source=attempt.get("source", "practice"),
            node_id=node_id,
            branch_id=attempt.get("branch_id"),
            color=row["color"],
            path_san=attempt.get("path_san") or row["path_san"],
            expected_san=attempt.get("expected_san") or row["san"],
            played_san=attempt.get("played_san") or "",
            solved=solved,
            event_key=event_key,
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        result = get_repertoire_node(node_id)
        return {**result, "duplicate": False} if result else None
    finally:
        conn.close()


def record_repertoire_branch_drill(branch_id, solved, attempt=None, event_key=None):
    conn = get_db()
    try:
        event_key = event_key or str(uuid.uuid4())
        conn.execute("BEGIN IMMEDIATE")
        duplicate = conn.execute(
            "SELECT id FROM repertoire_drill_attempts WHERE event_key = ?", (event_key,),
        ).fetchone()
        if duplicate:
            row = conn.execute(
                """SELECT b.*, o.name AS resolved_opening
                   FROM repertoire_branches b
                   LEFT JOIN repertoire_openings o ON o.id = b.opening_id
                   WHERE b.id = ?""",
                (branch_id,),
            ).fetchone()
            result = _branch_row_to_dict(row)
            conn.rollback()
            return {**result, "duplicate": True} if result else None
        branch = conn.execute(
            "SELECT id, color, moves_san FROM repertoire_branches WHERE id = ?",
            (branch_id,),
        ).fetchone()
        if not branch:
            conn.rollback()
            return None
        attempt = attempt or {}
        cur = conn.execute(
            """UPDATE repertoire_branches
               SET drill_count = drill_count + 1,
                   drill_solved = drill_solved + ?,
                   last_drilled_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE id = ?""",
            (1 if solved else 0, branch_id),
        )
        _insert_repertoire_drill_attempt(
            conn,
            source=attempt.get("source", "practice"),
            branch_id=branch_id,
            color=branch["color"],
            path_san=attempt.get("path_san") or branch["moves_san"],
            expected_san=attempt.get("expected_san") or "",
            played_san=attempt.get("played_san") or "",
            solved=solved,
            event_key=event_key,
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        result = get_repertoire_branch(branch_id)
        return {**result, "duplicate": False} if result else None
    finally:
        conn.close()


def record_repertoire_drill_attempt(event_key, source, solved, *, node_id=None,
                                    branch_id=None, expected_san="", played_san="",
                                    path_san=""):
    """Idempotently record exactly one node or branch result."""
    if bool(node_id) == bool(branch_id):
        raise ValueError("exactly one of node_id or branch_id is required")
    attempt = {
        "source": source,
        "expected_san": expected_san,
        "played_san": played_san,
        "path_san": path_san,
        "branch_id": branch_id,
    }
    if node_id:
        return record_repertoire_node_drill(node_id, solved, attempt, event_key=event_key)
    return record_repertoire_branch_drill(branch_id, solved, attempt, event_key=event_key)


def get_repertoire_drill_attempts(limit=100):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT * FROM repertoire_drill_attempts
               ORDER BY id DESC LIMIT ?""",
            (int(limit or 100),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_repertoire_tree(color):
    color = (color or "white").lower()
    if color not in ("white", "black"):
        color = "white"
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT * FROM repertoire_nodes
               WHERE color = ?
               ORDER BY ply, path_san""",
            (color,),
        ).fetchall()
        # Only positions you've actually drilled at least once can fall "due".
        # New nodes seed next_review_at = now, so without the drill_count guard
        # every freshly-saved move would flood the Review queue.
        due_rows = conn.execute(
            """SELECT * FROM repertoire_nodes
               WHERE color = ? AND drill_count > 0
                 AND next_review_at <= datetime('now')
               ORDER BY next_review_at ASC, drill_missed DESC, ply, path_san
               LIMIT 200""",
            (color,),
        ).fetchall()
        # True backlog size, independent of the capped `due` preview list below —
        # the Review badge must show the real total, not min(real, 50).
        due_total = conn.execute(
            """SELECT COUNT(*) FROM repertoire_nodes
               WHERE color = ? AND drill_count > 0
                 AND next_review_at <= datetime('now')""",
            (color,),
        ).fetchone()[0]
    finally:
        conn.close()

    branches = get_repertoire_branches(color)
    nodes = []
    by_id = {}
    for row in rows:
        node = dict(row)
        node["children"] = []
        by_id[node["id"]] = node
        nodes.append(node)

    root_children = []
    for node in nodes:
        parent = by_id.get(node["parent_id"])
        if parent:
            parent["children"].append(node)
        else:
            root_children.append(node)

    due = [dict(row) for row in due_rows[:50]]
    return {
        "color": color,
        "root": {
            "id": None,
            "color": color,
            "ply": 0,
            "path_san": "",
            "fen_after": "start",
            "children": root_children,
        },
        "branches": branches,
        "due": due,
        "stats": {
            "nodes": len(nodes),
            "branches": len(branches),
            "due": due_total,
        },
    }
