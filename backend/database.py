import sqlite3
import os
import json
import io
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "CHESS_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "chess_review.db"),
)

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    # WAL lets the background sync writer and the request readers (opening tree,
    # games browser) run concurrently instead of blocking on a whole-file lock.
    # journal_mode is persistent on the file; synchronous=NORMAL is per-connection
    # and remains crash-safe under WAL.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


INTEGRITY_MIGRATIONS = (
    "normalize_terminal_drill_counts_v1",
    "merge_legacy_duplicate_games_v1",
)

SCHEMA_MIGRATIONS = (
    "drill_event_keys_v1",
    "account_scoped_game_identity_v1",
    "account_sync_jobs_v1",
    "active_query_indexes_v1",
    "drill_history_foreign_keys_v2",
)


def _column_names(conn, table):
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _backup_before_schema_migrations(label):
    """Create a consistent, timestamped backup and retain the five newest."""
    if not os.path.isfile(DB_PATH) or os.path.getsize(DB_PATH) == 0:
        return None
    backup_dir = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "backups")
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    safe_label = "".join(c if c.isalnum() or c in "-_" else "-" for c in label)
    backup_path = os.path.join(backup_dir, f"chess-openings-pre-{safe_label}-{stamp}.db")
    source = sqlite3.connect(DB_PATH, timeout=5.0)
    target = sqlite3.connect(backup_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    try:
        os.chmod(backup_path, 0o600)
    except OSError:
        pass
    backups = sorted(
        (os.path.join(backup_dir, name) for name in os.listdir(backup_dir)
         if name.startswith("chess-openings-pre-") and name.endswith(".db")),
        key=os.path.getmtime,
        reverse=True,
    )
    for old in backups[5:]:
        try:
            os.remove(old)
        except OSError:
            pass
    return backup_path


def create_database_backup(target_path):
    """Write a transactionally consistent SQLite backup to ``target_path``."""
    source = sqlite3.connect(DB_PATH, timeout=5.0)
    target = sqlite3.connect(target_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    try:
        os.chmod(target_path, 0o600)
    except OSError:
        pass
    return target_path


def _backup_before_integrity_migrations():
    """Create one recoverable snapshot before the first data-normalizing migration."""
    if not os.path.isfile(DB_PATH) or os.path.getsize(DB_PATH) == 0:
        return
    backup_path = f"{DB_PATH}.bak-pre-integrity-v1"
    if os.path.exists(backup_path):
        return
    source = sqlite3.connect(DB_PATH)
    target = None
    try:
        has_data = source.execute(
            "SELECT EXISTS(SELECT 1 FROM games) OR EXISTS(SELECT 1 FROM repertoire_branches)",
        ).fetchone()[0]
        if not has_data:
            return
        target = sqlite3.connect(backup_path)
        source.backup(target)
    finally:
        if target is not None:
            target.close()
        source.close()


def _migration_applied(conn, version):
    return conn.execute(
        "SELECT 1 FROM schema_migrations WHERE version = ?", (version,),
    ).fetchone() is not None


def _mark_migration_applied(conn, version):
    conn.execute(
        "INSERT INTO schema_migrations (version) VALUES (?)", (version,),
    )


def _normalize_terminal_drill_counts(conn):
    """Remove historical branch-total duplication without losing direct attempts.

    Older builds also folded whole-line results into the terminal node. Newer builds
    record a real terminal move and the line result separately, so subtracting branch
    totals at read time erased genuine misses. Normalize once, then keep node counters
    authoritative going forward.
    """
    rows = conn.execute(
        """SELECT n.id, n.drill_count, n.drill_solved, n.drill_missed,
                  COALESCE(SUM(b.drill_count), 0) AS branch_count,
                  COALESCE(SUM(b.drill_solved), 0) AS branch_solved
           FROM repertoire_nodes n
           JOIN repertoire_branches b ON b.terminal_node_id = n.id
           GROUP BY n.id""",
    ).fetchall()
    for row in rows:
        direct = conn.execute(
            """SELECT COUNT(*) AS count,
                      COALESCE(SUM(CASE WHEN solved = 1 THEN 1 ELSE 0 END), 0) AS solved,
                      COALESCE(SUM(CASE WHEN solved = 0 THEN 1 ELSE 0 END), 0) AS missed
               FROM repertoire_drill_attempts WHERE node_id = ?""",
            (row["id"],),
        ).fetchone()
        branch_missed = max(0, row["branch_count"] - row["branch_solved"])
        solved = max(0, row["drill_solved"] - row["branch_solved"], direct["solved"])
        missed = max(0, row["drill_missed"] - branch_missed, direct["missed"])
        count = max(
            0,
            row["drill_count"] - row["branch_count"],
            direct["count"],
            solved + missed,
        )
        conn.execute(
            """UPDATE repertoire_nodes
               SET drill_count = ?, drill_solved = ?, drill_missed = ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (count, solved, missed, row["id"]),
        )


def _game_move_signature(pgn):
    """A header/name-independent fingerprint for matching re-imported games."""
    import chess.pgn

    try:
        game = chess.pgn.read_game(io.StringIO(pgn or ""))
    except (ValueError, UnicodeError):
        return None
    if game is None:
        return None
    moves = [move.uci() for move in game.mainline_moves()]
    return " ".join(moves) if moves else None


def _merge_legacy_duplicate_games(conn):
    """Attach analyzed legacy copies to their canonical tracked-account games."""
    canonical_rows = conn.execute(
        """SELECT * FROM games
           WHERE account_id IS NOT NULL AND merged_into_game_id IS NULL""",
    ).fetchall()
    by_signature = {}
    for row in canonical_rows:
        signature = _game_move_signature(row["pgn"])
        if signature:
            by_signature.setdefault(signature, []).append(row)

    legacy_rows = conn.execute(
        """SELECT * FROM games
           WHERE account_id IS NULL
             AND COALESCE(source, 'manual') = 'manual'
             AND merged_into_game_id IS NULL""",
    ).fetchall()
    for legacy in legacy_rows:
        signature = _game_move_signature(legacy["pgn"])
        if not signature:
            continue
        legacy_players = {
            (legacy["white"] or "").strip().lower(),
            (legacy["black"] or "").strip().lower(),
        } - {""}
        matches = []
        for candidate in by_signature.get(signature, []):
            candidate_players = {
                (candidate["white"] or "").strip().lower(),
                (candidate["black"] or "").strip().lower(),
            } - {""}
            if legacy["result"] != candidate["result"]:
                continue
            if legacy_players and candidate_players and not (legacy_players & candidate_players):
                continue
            matches.append(candidate)
        if len(matches) != 1:
            continue

        canonical = matches[0]
        legacy_updated = legacy["analysis_updated_at"] or ""
        canonical_updated = canonical["analysis_updated_at"] or ""
        copy_analysis = bool(legacy["analysis"]) and (
            not canonical["analysis"] or legacy_updated > canonical_updated
        )
        if copy_analysis:
            conn.execute(
                """UPDATE games
                   SET analysis = ?, analyzed = 1, analysis_updated_at = ?
                   WHERE id = ?""",
                (legacy["analysis"], legacy["analysis_updated_at"], canonical["id"]),
            )
        elif legacy["analyzed"] and not canonical["analyzed"]:
            conn.execute("UPDATE games SET analyzed = 1 WHERE id = ?", (canonical["id"],))

        conn.execute(
            """DELETE FROM puzzles
               WHERE game_id = ?
                 AND EXISTS (
                   SELECT 1 FROM puzzles canonical_puzzle
                   WHERE canonical_puzzle.game_id = ?
                     AND canonical_puzzle.fen = puzzles.fen
                     AND canonical_puzzle.user_move = puzzles.user_move
                     AND canonical_puzzle.best_move = puzzles.best_move
                 )""",
            (legacy["id"], canonical["id"]),
        )
        conn.execute(
            "UPDATE puzzles SET game_id = ? WHERE game_id = ?",
            (canonical["id"], legacy["id"]),
        )
        conn.execute(
            "UPDATE reanalyze_jobs SET game_id = ? WHERE game_id = ?",
            (canonical["id"], legacy["id"]),
        )
        conn.execute(
            "UPDATE games SET merged_into_game_id = ? WHERE id = ?",
            (canonical["id"], legacy["id"]),
        )


def _run_integrity_migrations():
    conn = get_db()
    try:
        pending = [v for v in INTEGRITY_MIGRATIONS if not _migration_applied(conn, v)]
    finally:
        conn.close()
    if not pending:
        return

    _backup_before_integrity_migrations()
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not _migration_applied(conn, INTEGRITY_MIGRATIONS[0]):
            _normalize_terminal_drill_counts(conn)
            _mark_migration_applied(conn, INTEGRITY_MIGRATIONS[0])
        if not _migration_applied(conn, INTEGRITY_MIGRATIONS[1]):
            _merge_legacy_duplicate_games(conn)
            _mark_migration_applied(conn, INTEGRITY_MIGRATIONS[1])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _run_schema_migrations():
    conn = get_db()
    try:
        pending = [v for v in SCHEMA_MIGRATIONS if not _migration_applied(conn, v)]
    finally:
        conn.close()
    if not pending:
        return

    _backup_before_schema_migrations(pending[-1])
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not _migration_applied(conn, "drill_event_keys_v1"):
            if "event_key" not in _column_names(conn, "repertoire_drill_attempts"):
                conn.execute("ALTER TABLE repertoire_drill_attempts ADD COLUMN event_key TEXT")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_drill_attempt_event_key "
                "ON repertoire_drill_attempts(event_key) WHERE event_key IS NOT NULL",
            )
            _mark_migration_applied(conn, "drill_event_keys_v1")

        if not _migration_applied(conn, "account_scoped_game_identity_v1"):
            conn.execute("DROP INDEX IF EXISTS idx_games_source_extid")
            duplicate_accounts = conn.execute(
                """SELECT platform, lower(username) AS normalized, group_concat(id) AS ids
                   FROM accounts GROUP BY platform, lower(username) HAVING COUNT(*) > 1""",
            ).fetchall()
            for group in duplicate_accounts:
                ids = sorted(int(value) for value in group["ids"].split(","))
                keeper, duplicates = ids[0], ids[1:]
                for duplicate in duplicates:
                    conn.execute("UPDATE games SET account_id = ? WHERE account_id = ?", (keeper, duplicate))
                    conn.execute("DELETE FROM accounts WHERE id = ?", (duplicate,))
            duplicate_openings = conn.execute(
                """SELECT color, lower(name) AS normalized, group_concat(id) AS ids
                   FROM repertoire_openings GROUP BY color, lower(name) HAVING COUNT(*) > 1""",
            ).fetchall()
            for group in duplicate_openings:
                ids = sorted(int(value) for value in group["ids"].split(","))
                keeper, duplicates = ids[0], ids[1:]
                for duplicate in duplicates:
                    conn.execute(
                        "UPDATE repertoire_branches SET opening_id = ? WHERE opening_id = ?",
                        (keeper, duplicate),
                    )
                    conn.execute("DELETE FROM repertoire_openings WHERE id = ?", (duplicate,))
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_games_account_source_extid "
                "ON games(account_id, source, external_id)",
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_platform_username_nocase "
                "ON accounts(platform, username COLLATE NOCASE)",
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_openings_color_name_nocase "
                "ON repertoire_openings(color, name COLLATE NOCASE)",
            )
            _mark_migration_applied(conn, "account_scoped_game_identity_v1")

        if not _migration_applied(conn, "account_sync_jobs_v1"):
            conn.execute("""
                CREATE TABLE IF NOT EXISTS account_sync_jobs (
                    id TEXT PRIMARY KEY,
                    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'queued',
                    seen INTEGER NOT NULL DEFAULT 0,
                    imported INTEGER NOT NULL DEFAULT 0,
                    total INTEGER,
                    warnings JSON NOT NULL DEFAULT '[]',
                    error TEXT DEFAULT '',
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now')),
                    started_at TEXT,
                    finished_at TEXT,
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            """)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sync_jobs_account_created "
                "ON account_sync_jobs(account_id, created_at DESC)",
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_one_active "
                "ON account_sync_jobs(account_id) "
                "WHERE status IN ('queued', 'running')",
            )
            _mark_migration_applied(conn, "account_sync_jobs_v1")

        if not _migration_applied(conn, "active_query_indexes_v1"):
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_games_tree_filter "
                "ON games(account_id, user_color, time_class, merged_into_game_id)",
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_games_end_time ON games(end_time DESC, id DESC)",
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_repertoire_nodes_parent "
                "ON repertoire_nodes(color, parent_id)",
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_repertoire_nodes_due "
                "ON repertoire_nodes(color, next_review_at) WHERE drill_count > 0",
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_repertoire_branches_opening "
                "ON repertoire_branches(opening_id)",
            )
            _mark_migration_applied(conn, "active_query_indexes_v1")

        if not _migration_applied(conn, "drill_history_foreign_keys_v2"):
            # SQLite cannot alter a foreign-key action in place. Rebuild only the
            # history table, preserving every row and nulling any already-orphaned
            # references. Future repertoire deletion is then enforced by SQLite,
            # not by repository call ordering.
            conn.execute("""
                CREATE TABLE repertoire_drill_attempts_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL DEFAULT 'practice',
                    node_id INTEGER REFERENCES repertoire_nodes(id) ON DELETE SET NULL,
                    branch_id INTEGER REFERENCES repertoire_branches(id) ON DELETE SET NULL,
                    color TEXT NOT NULL,
                    path_san TEXT NOT NULL,
                    expected_san TEXT DEFAULT '',
                    played_san TEXT DEFAULT '',
                    solved INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now')),
                    event_key TEXT
                )
            """)
            conn.execute("""
                INSERT INTO repertoire_drill_attempts_v2
                    (id, source, node_id, branch_id, color, path_san,
                     expected_san, played_san, solved, created_at, event_key)
                SELECT a.id, a.source,
                       CASE WHEN n.id IS NULL THEN NULL ELSE a.node_id END,
                       CASE WHEN b.id IS NULL THEN NULL ELSE a.branch_id END,
                       a.color, a.path_san, a.expected_san, a.played_san,
                       a.solved, a.created_at, a.event_key
                FROM repertoire_drill_attempts a
                LEFT JOIN repertoire_nodes n ON n.id = a.node_id
                LEFT JOIN repertoire_branches b ON b.id = a.branch_id
            """)
            conn.execute("DROP TABLE repertoire_drill_attempts")
            conn.execute(
                "ALTER TABLE repertoire_drill_attempts_v2 RENAME TO repertoire_drill_attempts",
            )
            conn.execute(
                "CREATE UNIQUE INDEX idx_drill_attempt_event_key "
                "ON repertoire_drill_attempts(event_key) WHERE event_key IS NOT NULL",
            )
            conn.execute(
                "CREATE INDEX idx_drill_attempt_node_created "
                "ON repertoire_drill_attempts(node_id, created_at DESC)",
            )
            conn.execute(
                "CREATE INDEX idx_drill_attempt_branch_created "
                "ON repertoire_drill_attempts(branch_id, created_at DESC)",
            )
            _mark_migration_applied(conn, "drill_history_foreign_keys_v2")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            white TEXT,
            black TEXT,
            result TEXT,
            date TEXT,
            pgn TEXT NOT NULL,
            analysis JSON,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS puzzles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER REFERENCES games(id),
            fen TEXT NOT NULL,
            user_move TEXT NOT NULL,
            best_move TEXT NOT NULL,
            explanation TEXT,
            theme_tags JSON,
            follow_up_line JSON,
            side_to_move TEXT,
            move_number INTEGER,
            times_shown INTEGER DEFAULT 0,
            times_solved INTEGER DEFAULT 0,
            interval_days INTEGER DEFAULT 1,
            next_review_date TEXT DEFAULT (datetime('now')),
            created_at TEXT DEFAULT (datetime('now'))
        );
    """)
    try:
        conn.execute("ALTER TABLE puzzles ADD COLUMN explanation_blocks JSON")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE games ADD COLUMN analysis_updated_at TEXT")
    except sqlite3.OperationalError:
        pass
    # Player-centric columns: who *you* were in the game, and import bookkeeping.
    # Additive migrations — safe to run every startup.
    for ddl in (
        "ALTER TABLE games ADD COLUMN source TEXT DEFAULT 'manual'",
        "ALTER TABLE games ADD COLUMN external_id TEXT",
        "ALTER TABLE games ADD COLUMN user_color TEXT",
        "ALTER TABLE games ADD COLUMN user_rating INTEGER",
        "ALTER TABLE games ADD COLUMN opp_rating INTEGER",
        "ALTER TABLE games ADD COLUMN time_class TEXT",
        "ALTER TABLE games ADD COLUMN time_control TEXT",
        "ALTER TABLE games ADD COLUMN end_time TEXT",
        "ALTER TABLE games ADD COLUMN eco TEXT",
        "ALTER TABLE games ADD COLUMN opening TEXT",
        "ALTER TABLE games ADD COLUMN analyzed INTEGER DEFAULT 0",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass
    # Existing manually-analyzed games already carry their analysis JSON.
    conn.execute("UPDATE games SET analyzed = 1 WHERE analysis IS NOT NULL AND analyzed = 0")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS reanalyze_jobs (
            status_id INTEGER PRIMARY KEY,
            scope TEXT,
            game_id INTEGER,
            analysis_marker TEXT,
            payload JSON NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS analysis_jobs (
            status_id INTEGER PRIMARY KEY,
            payload JSON NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS concept_reviews (
            concept_key TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT DEFAULT 'theme',
            times_shown INTEGER DEFAULT 0,
            times_solved INTEGER DEFAULT 0,
            consecutive_correct INTEGER DEFAULT 0,
            interval_days INTEGER DEFAULT 1,
            next_review_date TEXT DEFAULT (datetime('now')),
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS repertoire_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            color TEXT NOT NULL,
            name TEXT NOT NULL,
            moves_san TEXT NOT NULL,
            drill_count INTEGER DEFAULT 0,
            drill_solved INTEGER DEFAULT 0,
            last_drilled_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS repertoire_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            color TEXT NOT NULL,
            parent_id INTEGER REFERENCES repertoire_nodes(id),
            ply INTEGER NOT NULL,
            san TEXT NOT NULL,
            uci TEXT NOT NULL,
            fen_before TEXT NOT NULL,
            fen_after TEXT NOT NULL,
            path_san TEXT NOT NULL,
            label TEXT DEFAULT 'sideline',
            note TEXT DEFAULT '',
            drill_count INTEGER DEFAULT 0,
            drill_solved INTEGER DEFAULT 0,
            drill_missed INTEGER DEFAULT 0,
            interval_days INTEGER DEFAULT 1,
            next_review_at TEXT DEFAULT (datetime('now')),
            last_drilled_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(color, path_san)
        );
        CREATE TABLE IF NOT EXISTS repertoire_openings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            color TEXT NOT NULL,
            name TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(color, name)
        );
        CREATE TABLE IF NOT EXISTS repertoire_branches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            color TEXT NOT NULL,
            name TEXT NOT NULL,
            moves_san TEXT NOT NULL,
            terminal_node_id INTEGER REFERENCES repertoire_nodes(id),
            label TEXT DEFAULT 'main',
            note TEXT DEFAULT '',
            drill_count INTEGER DEFAULT 0,
            drill_solved INTEGER DEFAULT 0,
            last_drilled_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(color, moves_san)
        );
        CREATE TABLE IF NOT EXISTS repertoire_drill_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL DEFAULT 'practice',
            node_id INTEGER REFERENCES repertoire_nodes(id),
            branch_id INTEGER REFERENCES repertoire_branches(id),
            color TEXT NOT NULL,
            path_san TEXT NOT NULL,
            expected_san TEXT DEFAULT '',
            played_san TEXT DEFAULT '',
            solved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        -- Tracked player accounts. Several chess.com/lichess accounts can be
        -- followed at once; each imported game is tagged with its account_id so
        -- the opening tree can be viewed per-account or combined ("All accounts").
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            username TEXT NOT NULL,
            label TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            last_synced_at TEXT,
            UNIQUE(platform, username)
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS cloud_eval_cache (
            fen TEXT PRIMARY KEY,
            payload JSON NOT NULL,
            source TEXT,
            fetched_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS saved_eval (
            fen TEXT PRIMARY KEY,
            payload JSON NOT NULL,
            depth INTEGER,
            saved_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS explorer_cache (
            fen TEXT PRIMARY KEY,
            payload JSON NOT NULL,
            source TEXT,
            fetched_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        );
        -- Dedup imported games. NULLs are distinct in SQLite UNIQUE, so manual
        -- games (external_id NULL) are unaffected; chess.com uuids can't double.
    """)
    # Repertoire branch metadata added after the initial release. An "opening"
    # groups several variations under one family (e.g. all your Caro-Kann
    # lines), and free-form "tags" replace the old fixed line-type field.
    for ddl in (
        "ALTER TABLE repertoire_branches ADD COLUMN opening TEXT DEFAULT ''",
        "ALTER TABLE repertoire_branches ADD COLUMN tags TEXT DEFAULT ''",
        # An "opening" is now a first-class, nameable entity (repertoire_openings)
        # so it can be renamed/created/emptied independently of its branches.
        "ALTER TABLE repertoire_branches ADD COLUMN opening_id INTEGER REFERENCES repertoire_openings(id)",
        # Which tracked account a game belongs to (multi-account). Backfilled from
        # white/black + user_color by migrate_games_to_accounts().
        "ALTER TABLE games ADD COLUMN account_id INTEGER",
        "ALTER TABLE games ADD COLUMN merged_into_game_id INTEGER REFERENCES games(id)",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()
    _run_schema_migrations()
    migrate_repertoire_lines_to_tree()
    migrate_branch_openings_to_entities()
    migrate_games_to_accounts()
    _run_integrity_migrations()


# Active account/game repositories are split out; these names remain available
# here as a compatibility facade for existing imports.
from account_game_repository import (  # noqa: E402,F401
    count_games,
    count_games_by_source,
    create_account,
    create_sync_job,
    delete_account,
    get_account,
    get_game,
    get_games_for_tree,
    get_setting,
    get_sync_job,
    list_accounts,
    list_games,
    list_queued_sync_jobs,
    mark_account_synced,
    migrate_games_to_accounts,
    recover_sync_jobs,
    request_sync_job_cancel,
    save_imported_game,
    save_imported_games,
    set_setting,
    sync_job_cancel_requested,
    update_sync_job,
)

from evaluation_repository import (  # noqa: E402,F401
    delete_saved_eval,
    get_cloud_eval_cached,
    get_explorer_cached,
    get_saved_eval,
    put_cloud_eval,
    put_explorer,
    put_saved_eval,
)

# Re-export the active repertoire repository for compatibility with existing
# callers while keeping the runtime implementation out of this module.
from repertoire_repository import (  # noqa: E402,F401
    create_repertoire_opening,
    delete_repertoire_branch,
    delete_repertoire_opening,
    get_repertoire_branch,
    get_repertoire_branches,
    get_repertoire_drill_attempts,
    get_repertoire_node,
    get_repertoire_tree,
    list_repertoire_openings,
    migrate_branch_openings_to_entities,
    migrate_repertoire_lines_to_tree,
    record_repertoire_branch_drill,
    record_repertoire_drill_attempt,
    record_repertoire_node_drill,
    save_repertoire_branch,
    update_repertoire_branch,
    update_repertoire_node,
    update_repertoire_opening,
)
