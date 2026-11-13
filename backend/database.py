"""The SQLite file behind the service: connections, the schema, backups."""
import os
import sqlite3

DB_PATH = os.environ.get(
    "CHESS_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "chess_review.db"),
)

SCHEMA = """
    -- The chess.com and Lichess accounts whose games are imported.
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        username TEXT NOT NULL,
        label TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        last_synced_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_platform_username_nocase
        ON accounts(platform, username COLLATE NOCASE);

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
    );
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_account_created
        ON account_sync_jobs(account_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_one_active
        ON account_sync_jobs(account_id) WHERE status IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        white TEXT,
        black TEXT,
        result TEXT,
        date TEXT,
        pgn TEXT NOT NULL,
        user_color TEXT,
        user_rating INTEGER,
        opp_rating INTEGER,
        time_class TEXT,
        time_control TEXT,
        end_time TEXT,
        eco TEXT,
        opening TEXT,
        -- When game_analysis.py last searched this game for mistakes.
        mistakes_analyzed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(account_id, source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_games_tree_filter
        ON games(account_id, user_color, time_class);
    CREATE INDEX IF NOT EXISTS idx_games_end_time ON games(end_time DESC, id DESC);

    -- Moves of the user's that Stockfish (or the tablebase) rates as a
    -- mistake, found by game_analysis.py.
    CREATE TABLE IF NOT EXISTS game_mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        ply INTEGER NOT NULL,
        fen TEXT NOT NULL,
        user_color TEXT NOT NULL,
        played_san TEXT NOT NULL,
        played_uci TEXT NOT NULL,
        best_san TEXT NOT NULL,
        best_uci TEXT NOT NULL,
        cp_before INTEGER NOT NULL,
        cp_after INTEGER NOT NULL,
        loss REAL NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(game_id, ply)
    );

    -- The repertoire. A branch is one saved line; nodes are its moves, shared
    -- between the lines that start the same way.
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
        UNIQUE(color, path_san)
    );
    CREATE INDEX IF NOT EXISTS idx_repertoire_nodes_parent
        ON repertoire_nodes(color, parent_id);
    CREATE TABLE IF NOT EXISTS repertoire_branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        color TEXT NOT NULL,
        name TEXT NOT NULL,
        moves_san TEXT NOT NULL,
        terminal_node_id INTEGER REFERENCES repertoire_nodes(id),
        label TEXT DEFAULT 'main',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(color, moves_san)
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    -- Exact endgame results from the Lichess tablebase. `position` is the
    -- FEN without its fullmove number (the halfmove clock stays: the 50-move
    -- rule can change the result). Rows never go stale.
    CREATE TABLE IF NOT EXISTS tablebase_cache (
        position TEXT PRIMARY KEY,
        payload JSON NOT NULL,
        fetched_at TEXT DEFAULT (datetime('now'))
    );
"""


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    # WAL lets the background sync writer and the request readers run
    # concurrently instead of blocking on a whole-file lock. journal_mode is
    # persistent on the file; synchronous=NORMAL is per-connection and remains
    # crash-safe under WAL.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    conn = get_db()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


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


# The repositories live in their own modules; callers reach them as `db.<name>`.
from account_game_repository import (  # noqa: E402,F401
    create_account,
    create_sync_job,
    delete_account,
    find_game_by_external_id,
    get_account,
    get_game,
    get_game_summaries,
    get_games_for_tree,
    get_setting,
    get_sync_job,
    list_accounts,
    list_queued_sync_jobs,
    mark_account_synced,
    newest_game_end,
    recover_sync_jobs,
    request_sync_job_cancel,
    save_imported_games,
    set_setting,
    sync_job_cancel_requested,
    update_sync_job,
)

from evaluation_repository import (  # noqa: E402,F401
    get_tablebase_cached,
    put_tablebase,
)

from repertoire_repository import (  # noqa: E402,F401
    delete_repertoire_branch,
    get_repertoire_tree,
    save_repertoire_branch,
    update_repertoire_branch,
)
