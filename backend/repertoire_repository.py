"""SQLite repository for the repertoire: saved lines and the tree of their moves."""
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


def _ensure_repertoire_nodes(conn, color, moves_san):
    """Create the line's move nodes where missing."""
    import chess

    raw_moves = (moves_san or "").split()
    if not raw_moves:
        raise ValueError("moves_san is empty")

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
        fen_before = board.fen()
        board.push(move)
        path.append(san)
        path_san = " ".join(path)

        existing = conn.execute(
            "SELECT id FROM repertoire_nodes WHERE color = ? AND path_san = ?",
            (color, path_san),
        ).fetchone()
        if existing:
            terminal_node_id = existing["id"]
        else:
            terminal_node_id = conn.execute(
                """INSERT INTO repertoire_nodes
                   (color, parent_id, ply, san, uci, fen_before, fen_after, path_san)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (color, parent_id, ply, san, move.uci(), fen_before, board.fen(), path_san),
            ).lastrowid
        parent_id = terminal_node_id

    return " ".join(path), terminal_node_id


def _branch(conn, branch_id):
    row = conn.execute(
        "SELECT * FROM repertoire_branches WHERE id = ?", (branch_id,),
    ).fetchone()
    return dict(row) if row else None


def get_repertoire_branch_moves(branch_id):
    """The saved moves of one line, or None when there is no such line."""
    conn = get_db()
    try:
        branch = _branch(conn, branch_id)
        return branch["moves_san"] if branch else None
    finally:
        conn.close()


def save_repertoire_branch(color, name, moves_san, label="main"):
    """Upsert a branch (one exact line) and its move nodes.

    A line is identified by color + SAN path, so every distinct variation is its
    own branch — saving the Caro-Kann Advance never overwrites the Exchange.
    """
    color = _repertoire_color(color)
    label = _repertoire_label(label, "main")
    conn = get_db()
    try:
        moves, terminal_node_id = _ensure_repertoire_nodes(conn, color, moves_san)
        name = (name or "").strip() or _default_repertoire_branch_name(moves)
        existing = conn.execute(
            "SELECT id FROM repertoire_branches WHERE color = ? AND moves_san = ?",
            (color, moves),
        ).fetchone()
        if existing:
            branch_id = existing["id"]
            conn.execute(
                """UPDATE repertoire_branches
                   SET name = ?, terminal_node_id = ?, label = ?, updated_at = datetime('now')
                   WHERE id = ?""",
                (name, terminal_node_id, label, branch_id),
            )
        else:
            branch_id = conn.execute(
                """INSERT INTO repertoire_branches
                   (color, name, moves_san, terminal_node_id, label)
                   VALUES (?, ?, ?, ?, ?)""",
                (color, name, moves, terminal_node_id, label),
            ).lastrowid
        conn.commit()
        return _branch(conn, branch_id)
    finally:
        conn.close()


def update_repertoire_branch(branch_id, name=None, moves_san=None, label=None):
    """Rename a line, relabel it, or replace its moves. None leaves a field as it is."""
    conn = get_db()
    try:
        branch = _branch(conn, branch_id)
        if not branch:
            return None
        color = branch["color"]
        label = _repertoire_label(label if label is not None else branch["label"], "main")
        moves, terminal_node_id = _ensure_repertoire_nodes(
            conn, color, moves_san if moves_san is not None else branch["moves_san"],
        )
        name = (name if name is not None else branch["name"] or "").strip()
        if not name:
            name = _default_repertoire_branch_name(moves)
        if conn.execute(
            "SELECT 1 FROM repertoire_branches WHERE color = ? AND moves_san = ? AND id != ?",
            (color, moves, branch_id),
        ).fetchone():
            raise ValueError("A branch already exists for this line")
        conn.execute(
            """UPDATE repertoire_branches
               SET name = ?, moves_san = ?, terminal_node_id = ?, label = ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (name, moves, terminal_node_id, label, branch_id),
        )
        if branch["terminal_node_id"] and branch["terminal_node_id"] != terminal_node_id:
            _prune_orphan_repertoire_nodes(conn, branch["terminal_node_id"])
        conn.commit()
        return _branch(conn, branch_id)
    finally:
        conn.close()


def delete_repertoire_branch(branch_id):
    conn = get_db()
    try:
        branch = _branch(conn, branch_id)
        if not branch:
            return False
        conn.execute("DELETE FROM repertoire_branches WHERE id = ?", (branch_id,))
        if branch["terminal_node_id"]:
            _prune_orphan_repertoire_nodes(conn, branch["terminal_node_id"])
        conn.commit()
        return True
    finally:
        conn.close()


def _prune_orphan_repertoire_nodes(conn, node_id):
    """Remove unreferenced leaf nodes after deleting a branch.

    Shared trunks remain: pruning stops as soon as a node still has another
    child or is the terminal node of another branch.
    """
    while node_id:
        row = conn.execute(
            "SELECT parent_id FROM repertoire_nodes WHERE id = ?", (node_id,),
        ).fetchone()
        if not row:
            return
        in_use = conn.execute(
            """SELECT EXISTS(SELECT 1 FROM repertoire_branches WHERE terminal_node_id = ?)
                   OR EXISTS(SELECT 1 FROM repertoire_nodes WHERE parent_id = ?)""",
            (node_id, node_id),
        ).fetchone()[0]
        if in_use:
            return
        conn.execute("DELETE FROM repertoire_nodes WHERE id = ?", (node_id,))
        node_id = row["parent_id"]


def get_repertoire_tree(color):
    """One colour's repertoire: the tree of its moves and the list of its lines."""
    color = _repertoire_color(color)
    conn = get_db()
    try:
        nodes = [dict(row) for row in conn.execute(
            "SELECT * FROM repertoire_nodes WHERE color = ? ORDER BY ply, path_san", (color,),
        ).fetchall()]
        branches = [dict(row) for row in conn.execute(
            "SELECT * FROM repertoire_branches WHERE color = ? ORDER BY name COLLATE NOCASE, id",
            (color,),
        ).fetchall()]
    finally:
        conn.close()

    # A move is "main" when a main line runs through it, so at every fork the
    # main line's move can be told from the sidelines'.
    main_paths = set()
    for branch in branches:
        if branch["label"] == "main":
            moves = branch["moves_san"].split()
            main_paths.update(" ".join(moves[:n]) for n in range(1, len(moves) + 1))

    by_id = {}
    for node in nodes:
        node["label"] = "main" if node["path_san"] in main_paths else "sideline"
        node["children"] = []
        by_id[node["id"]] = node
    root_children = []
    for node in nodes:
        parent = by_id.get(node["parent_id"])
        (parent["children"] if parent else root_children).append(node)

    return {
        "color": color,
        "root": {"children": root_children},
        "branches": branches,
    }
