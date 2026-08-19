"""SQLite repository for repertoire trees and drill history."""
import sqlite3
import uuid

import eco_openings
from database import get_db
from position_key import position_key

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


# A branch plus the opening name it resolves to and the position its last move
# reaches. `terminal_epd` is what lets the UI recognize "you already have this
# line, saved under a different move order" instead of offering a duplicate save.
_BRANCH_COLUMNS = """
    b.*, o.name AS resolved_opening, t.epd_after AS terminal_epd
"""
_BRANCH_JOINS = """
    FROM repertoire_branches b
    LEFT JOIN repertoire_openings o ON o.id = b.opening_id
    LEFT JOIN repertoire_nodes t ON t.id = b.terminal_node_id
"""


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
        epd_before = position_key(board)
        board.push(move)
        fen_after = board.fen()
        epd_after = position_key(board)
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
                       fen_before = ?, fen_after = ?, epd_before = ?, epd_after = ?,
                       updated_at = datetime('now')
                   WHERE id = ?""",
                (parent_id, ply, san, uci, fen_before, fen_after,
                 epd_before, epd_after, terminal_node_id),
            )
        else:
            cur = conn.execute(
                """INSERT INTO repertoire_nodes
                   (color, parent_id, ply, san, uci, fen_before, fen_after,
                    epd_before, epd_after, path_san)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (color, parent_id, ply, san, uci, fen_before, fen_after,
                 epd_before, epd_after, path_san),
            )
            terminal_node_id = cur.lastrowid
        # The card this node drills. Opponent plies get a row too — harmless,
        # since the due query filters on drill_count — and it keeps every read a
        # plain join instead of a pile of COALESCEs.
        conn.execute(
            "INSERT OR IGNORE INTO repertoire_positions (color, epd, san) VALUES (?, ?, ?)",
            (color, epd_before, san),
        )
        parent_id = terminal_node_id

    normalized_moves = " ".join(path)
    conn.execute(
        """UPDATE repertoire_nodes
           SET label = ?, note = ?, updated_at = datetime('now')
           WHERE id = ?""",
        (branch_label, note, terminal_node_id),
    )
    return normalized_moves, terminal_node_id


def _transposition_warnings(conn, color, moves_san):
    """Where this line meets others already in the repertoire.

    Two saved lines can pass through the same position by different move orders.
    That is either harmless (both prescribe the same move — they now share one
    review card) or a genuine problem (they prescribe *different* moves, so the
    repertoire says two things about one position). Both are worth telling the
    user; only the second is a conflict.
    """
    prefixes = []
    moves = moves_san.split()
    for i in range(len(moves)):
        prefixes.append(" ".join(moves[:i + 1]))
    if not prefixes:
        return []

    placeholders = ",".join("?" * len(prefixes))
    rows = conn.execute(
        f"""SELECT mine.path_san AS my_path, mine.san AS my_san,
                   mine.epd_before AS epd,
                   other.path_san AS other_path, other.san AS other_san,
                   other.label AS other_label,
                   {_main_line_expr("bo")} AS other_main_line,
                   {_main_line_expr("bm")} AS my_main_line
            FROM repertoire_nodes mine
            JOIN repertoire_nodes other
              ON other.color = mine.color
             AND other.epd_before = mine.epd_before
             AND other.id != mine.id
            {_main_line_join("other", "bo")}
            {_main_line_join("mine", "bm")}
            WHERE mine.color = ? AND mine.path_san IN ({placeholders})
            GROUP BY mine.id, other.id
            ORDER BY mine.ply, other.path_san""",
        (color, *prefixes),
    ).fetchall()

    warnings = []
    for row in rows:
        # Reached the same position a different way (benign — they now share one
        # review card), or genuinely prescribe different moves there. The latter
        # only counts on your own turn: several saved answers to an *opponent*
        # move is coverage, not a contradiction.
        if _prior_path(row["other_path"]) == _prior_path(row["my_path"]):
            continue  # sibling replies from the same line, not a transposition
        same_move = row["other_san"] == row["my_san"]
        # A line the user filed as an alternative/trap/sideline is a second
        # answer they chose on purpose, so it is coverage rather than a
        # contradiction even when it disagrees with the main line.
        contradicts = (
            not same_move
            and bool(row["my_main_line"]) and bool(row["other_main_line"])
            and _is_user_turn(color, row["epd"])
        )
        warnings.append({
            "kind": "transposition" if same_move else (
                "conflict" if contradicts else "coverage"
            ),
            "path_san": row["my_path"],
            "san": row["my_san"],
            "other_path_san": row["other_path"],
            "other_san": row["other_san"],
            "other_label": row["other_label"],
        })
    # Conflicts first: they need a decision, transpositions are just information.
    warnings.sort(key=lambda w: (w["kind"] != "conflict", w["path_san"]))
    return warnings


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
        warnings = _transposition_warnings(conn, color, normalized_moves)
        terminal_epd = conn.execute(
            "SELECT epd_after FROM repertoire_nodes WHERE id = ?", (terminal_node_id,),
        ).fetchone()
        conn.commit()
        return {
            "id": branch_id,
            "color": color,
            "name": name,
            "moves_san": normalized_moves,
            "terminal_node_id": terminal_node_id,
            "terminal_epd": terminal_epd["epd_after"] if terminal_epd else None,
            "label": branch_label,
            "note": note,
            "opening": opening,
            "opening_id": resolved_opening_id,
            "tags": _tags_to_list(tags_str),
            "warnings": warnings,
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
        warnings = _transposition_warnings(conn, next_color, normalized_moves)
        conn.commit()
        if cur.rowcount == 0:
            return None
        result = _branch_row_to_dict(conn.execute(
            f"""SELECT {_BRANCH_COLUMNS} {_BRANCH_JOINS} WHERE b.id = ?""", (branch_id,),
        ).fetchone())
        result["training_reset"] = training_reset
        result["warnings"] = warnings
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
            f"""SELECT {_BRANCH_COLUMNS}
                {_BRANCH_JOINS} {where}
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
            f"""SELECT {_BRANCH_COLUMNS} {_BRANCH_JOINS} WHERE b.id = ?""", (branch_id,),
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


def _node_with_position(conn, node_id):
    """A node plus its live spaced-repetition counters, on an open connection."""
    return _row_to_dict(conn.execute(
        f"""SELECT {_NODE_COLUMNS}
            FROM repertoire_nodes n
            LEFT JOIN repertoire_positions p
                   ON p.color = n.color AND p.epd = n.epd_before AND p.san = n.san
            WHERE n.id = ?""",
        (node_id,),
    ).fetchone())


def get_repertoire_node(node_id):
    conn = get_db()
    try:
        return _node_with_position(conn, node_id)
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


def _position_interval(conn, color, epd, played_id):
    """The interval the *position* is on: the shortest among its live cards.

    Several saved replies to one position share one review schedule, so the one
    you know least well sets the pace for all of them.
    """
    row = conn.execute(
        """SELECT MIN(interval_days) AS interval_days FROM repertoire_positions
           WHERE color = ? AND epd = ? AND (drill_count > 0 OR id = ?)""",
        (color, epd, played_id),
    ).fetchone()
    return (row and row["interval_days"]) or 1


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
    """Record one drill result against the node's *position card*.

    Callers still identify the node (that is what the UI has), but the schedule
    lives on the ``(color, position, move)`` card, so answering a line one way
    also advances the transposed spelling of the same line.
    """
    conn = get_db()
    try:
        event_key = event_key or str(uuid.uuid4())
        conn.execute("BEGIN IMMEDIATE")
        duplicate = conn.execute(
            "SELECT id FROM repertoire_drill_attempts WHERE event_key = ?", (event_key,),
        ).fetchone()
        if duplicate:
            # Must return the same shape as the success path below. Reading the
            # node alone would hand back the frozen legacy columns, so a retried
            # POST would report drill_count 0.
            result = _node_with_position(conn, node_id)
            conn.rollback()
            return {**result, "duplicate": True} if result else None
        row = conn.execute(
            "SELECT color, path_san, san, epd_before FROM repertoire_nodes WHERE id = ?",
            (node_id,),
        ).fetchone()
        if not row or not row["epd_before"]:
            conn.rollback()
            return None
        attempt = attempt or {}
        card = (row["color"], row["epd_before"], row["san"])
        conn.execute(
            "INSERT OR IGNORE INTO repertoire_positions (color, epd, san) VALUES (?, ?, ?)",
            card,
        )
        position = conn.execute(
            "SELECT id, interval_days FROM repertoire_positions "
            "WHERE color = ? AND epd = ? AND san = ?",
            card,
        ).fetchone()
        # Counters are per move: which reply you gave is real information.
        cur = conn.execute(
            """UPDATE repertoire_positions
               SET drill_count = drill_count + 1,
                   drill_solved = drill_solved + ?,
                   drill_missed = drill_missed + ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (1 if solved else 0, 0 if solved else 1, position["id"]),
        )
        # The *schedule*, though, belongs to the position, not the move. The due
        # queue asks one question per position and accepts any saved reply, so
        # advancing only the reply that was played left every other card due
        # forever and the position never drained. Pace it off the weakest
        # answer, so a move you missed keeps the whole position on a short
        # leash even when you answer with one you know.
        interval, offset = _next_review_offset(
            bool(solved), _position_interval(conn, card[0], card[1], position["id"]),
        )
        conn.execute(
            """UPDATE repertoire_positions
               SET interval_days = ?,
                   next_review_at = datetime('now', ?),
                   last_drilled_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE color = ? AND epd = ? AND (drill_count > 0 OR id = ?)""",
            (interval, offset, card[0], card[1], position["id"]),
        )
        _insert_repertoire_drill_attempt(
            conn,
            source=attempt.get("source", "practice"),
            node_id=node_id,
            branch_id=attempt.get("branch_id"),
            color=row["color"],
            # History stays per-path: which move order you were drilling is real
            # information even though the schedule no longer forks on it.
            path_san=attempt.get("path_san") or row["path_san"],
            expected_san=attempt.get("expected_san") or row["san"],
            played_san=attempt.get("played_san") or "",
            solved=solved,
            event_key=event_key,
        )
        if cur.rowcount == 0:
            conn.rollback()
            return None
        result = _node_with_position(conn, node_id)
        conn.commit()
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
                f"""SELECT {_BRANCH_COLUMNS} {_BRANCH_JOINS} WHERE b.id = ?""",
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


# Every node column, then the live spaced-repetition counters from the position
# card. Enumerated on purpose: with `SELECT n.*, ... AS drill_count`, sqlite3.Row
# returns the FIRST column of a duplicated name, so the join would silently keep
# serving the frozen legacy node columns — and every test would still pass.
_NODE_COLUMNS = """
    n.id, n.color, n.parent_id, n.ply, n.san, n.uci,
    n.fen_before, n.fen_after, n.epd_before, n.epd_after,
    n.path_san, n.label, n.note, n.created_at, n.updated_at,
    p.id AS position_id,
    COALESCE(p.drill_count, 0)   AS drill_count,
    COALESCE(p.drill_solved, 0)  AS drill_solved,
    COALESCE(p.drill_missed, 0)  AS drill_missed,
    COALESCE(p.interval_days, 1) AS interval_days,
    p.next_review_at, p.last_drilled_at
"""

# One row per due *position*, not per node: a position saved under several move
# orders must not be queued twice. ROW_NUMBER picks the representative node, and
# the inner JOIN keeps orphaned cards (whose line was deleted) out of the queue.
#
# Only positions actually drilled at least once can fall due — new cards seed
# next_review_at = now, so without the drill_count guard every freshly-saved move
# would flood the queue.
_DUE_QUERY = f"""
    SELECT * FROM (
        SELECT {_NODE_COLUMNS},
               ROW_NUMBER() OVER (
                 PARTITION BY n.color, n.epd_before
                 ORDER BY p.next_review_at ASC, p.drill_missed DESC,
                          n.ply ASC, n.path_san ASC
               ) AS queue_rank
        FROM repertoire_positions p
        JOIN repertoire_nodes n
          ON n.color = p.color AND n.epd_before = p.epd AND n.san = p.san
        WHERE p.color = ? AND p.drill_count > 0
          AND p.next_review_at <= datetime('now')
    )
    WHERE queue_rank = 1
    ORDER BY next_review_at ASC, drill_missed DESC, ply, path_san
    LIMIT 200
"""


def _is_user_turn(color, epd):
    """Is it the repertoire owner's move in this position?

    The EPD's second field is the side to move. This is the difference between a
    real conflict and ordinary coverage: several saved replies to *your* move is
    the repertoire contradicting itself, but several saved replies to the
    *opponent's* move is exactly what a repertoire is for.
    """
    fields = (epd or "").split()
    if len(fields) < 2:
        return False
    return ("white" if fields[1] == "w" else "black") == color


# A node's own `label` is not the answer: repertoire_nodes.label defaults to
# 'sideline' and only a branch's terminal move ever gets the real one. What the
# user actually declared lives on the branches running through the node, so a
# move counts as a main-line prescription when at least one `main` branch passes
# through it. Anything the user explicitly filed as alternative/trap/sideline is
# a deliberate second answer, not a contradiction.
def _main_line_join(node, branch):
    return (f"LEFT JOIN repertoire_branches {branch}"
            f"       ON {branch}.color = {node}.color"
            f"      AND ({branch}.moves_san = {node}.path_san"
            f"           OR {branch}.moves_san LIKE {node}.path_san || ' %')")


def _main_line_expr(branch):
    return f"MAX(CASE WHEN COALESCE({branch}.label, 'main') = 'main' THEN 1 ELSE 0 END)"


def _prior_path(path_san):
    """The move order that led up to this node's own move."""
    return " ".join(path_san.split()[:-1])


def _transposition_report(conn, color):
    """Positions this repertoire reaches by more than one move order.

    A position is a transposition when several *different prior move orders*
    arrive at it — not merely when several nodes share it, since every branching
    point does that. ``conflict`` narrows it further to the cases that need a
    decision: your own turn, with the orders prescribing different moves.
    """
    rows = conn.execute(
        f"""SELECT n.epd_before AS epd_before, n.san AS san,
                   n.path_san AS path_san, n.label AS label,
                   {_main_line_expr("b")} AS main_line
            FROM repertoire_nodes n
            {_main_line_join("n", "b")}
            WHERE n.color = ? AND n.epd_before IS NOT NULL
            GROUP BY n.id
            ORDER BY n.ply, n.path_san""",
        (color,),
    ).fetchall()

    grouped = {}
    for row in rows:
        grouped.setdefault(row["epd_before"], []).append({
            "san": row["san"],
            "path_san": row["path_san"],
            "prior_path_san": _prior_path(row["path_san"]),
            "label": row["label"],
            "main_line": bool(row["main_line"]),
        })

    report = []
    for epd, entries in grouped.items():
        if len({entry["prior_path_san"] for entry in entries}) < 2:
            continue  # one way in: a plain branching point, not a transposition
        report.append({
            "epd": epd,
            "orders": sorted({entry["prior_path_san"] for entry in entries}),
            "conflict": (
                _is_user_turn(color, epd)
                and len({e["san"] for e in entries if e["main_line"]}) > 1
            ),
            "moves": entries,
        })
    # Conflicts first — they are the ones asking the user to decide something.
    report.sort(key=lambda item: (not item["conflict"], item["moves"][0]["path_san"]))
    return report


def get_repertoire_tree(color):
    color = (color or "white").lower()
    if color not in ("white", "black"):
        color = "white"
    conn = get_db()
    try:
        rows = conn.execute(
            f"""SELECT {_NODE_COLUMNS}
                FROM repertoire_nodes n
                LEFT JOIN repertoire_positions p
                       ON p.color = n.color AND p.epd = n.epd_before AND p.san = n.san
                WHERE n.color = ?
                ORDER BY n.ply, n.path_san""",
            (color,),
        ).fetchall()
        due_rows = conn.execute(_DUE_QUERY, (color,)).fetchall()
        # True backlog size, independent of the capped `due` preview list below —
        # the Review badge must show the real total, not min(real, 50). Counts
        # positions, not nodes, so a position saved under two move orders is one
        # item, and only positions that still have a node are counted (a card
        # outlives the line that created it so re-saving restores its schedule).
        due_total = conn.execute(
            """SELECT COUNT(DISTINCT p.epd) FROM repertoire_positions p
               WHERE p.color = ? AND p.drill_count > 0
                 AND p.next_review_at <= datetime('now')
                 AND EXISTS (SELECT 1 FROM repertoire_nodes n
                             WHERE n.color = p.color AND n.epd_before = p.epd
                               AND n.san = p.san)""",
            (color,),
        ).fetchone()[0]
        transpositions = _transposition_report(conn, color)
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

    # Collapsing transpositions into one queue item would grade a legitimate
    # alternative reply wrong, so each item carries every saved reply at its
    # position and the review UI accepts any of them.
    replies = {}
    for node in nodes:
        replies.setdefault((node["color"], node["epd_before"]), {}).setdefault(
            node["san"],
            {"node_id": node["id"], "san": node["san"], "label": node["label"],
             "fen_after": node["fen_after"], "epd_after": node["epd_after"],
             "path_san": node["path_san"]},
        )

    due = []
    for row in due_rows[:50]:
        item = dict(row)
        item.pop("queue_rank", None)
        item["accepted"] = list(
            replies.get((item["color"], item["epd_before"]), {}).values(),
        )
        due.append(item)

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
        "transpositions": transpositions,
        "stats": {
            "nodes": len(nodes),
            "branches": len(branches),
            "due": due_total,
            "transpositions": len(transpositions),
            "conflicts": sum(1 for t in transpositions if t["conflict"]),
        },
    }
