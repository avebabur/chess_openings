import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


PGN = """[White "alpha"]
[Black "beta"]
[Result "1-0"]

1. e4 e5 1-0
"""


class StabilizationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "openings.db"
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(self.db_path)
        import database
        self.db = importlib.reload(database)
        self.db.init_db()

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def test_drill_event_is_idempotent(self):
        self.db.save_repertoire_branch("white", "King pawn", "e4")
        node = self.db.get_repertoire_tree("white")["root"]["children"][0]
        first = self.db.record_repertoire_drill_attempt(
            "event-one", "practice", False, node_id=node["id"],
            expected_san="e4", played_san="d4", path_san="e4",
        )
        second = self.db.record_repertoire_drill_attempt(
            "event-one", "practice", False, node_id=node["id"],
            expected_san="e4", played_san="d4", path_san="e4",
        )
        after = self.db.get_repertoire_node(node["id"])
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual((after["drill_count"], after["drill_missed"]), (1, 1))

    def test_concurrent_drill_retry_updates_counters_once(self):
        self.db.save_repertoire_branch("white", "King pawn", "e4")
        node = self.db.get_repertoire_tree("white")["root"]["children"][0]

        def record():
            return self.db.record_repertoire_drill_attempt(
                "concurrent-event", "practice", False, node_id=node["id"],
                expected_san="e4", played_san="d4", path_san="e4",
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _value: record(), range(2)))
        after = self.db.get_repertoire_node(node["id"])
        self.assertEqual(sorted(result["duplicate"] for result in results), [False, True])
        self.assertEqual((after["drill_count"], after["drill_missed"]), (1, 1))

    def test_schema_migration_backs_up_and_adds_set_null_actions(self):
        branch = self.db.save_repertoire_branch("white", "Line", "e4")
        self.db.record_repertoire_drill_attempt(
            "legacy-attempt", "practice", False,
            branch_id=branch["id"], path_san="e4",
        )

        # Recreate the pre-v2 history shape, then run the real migration.
        conn = self.db.get_db()
        conn.execute("DROP INDEX idx_drill_attempt_event_key")
        conn.execute("ALTER TABLE repertoire_drill_attempts RENAME TO attempts_current")
        conn.execute("""
            CREATE TABLE repertoire_drill_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL DEFAULT 'practice',
                node_id INTEGER REFERENCES repertoire_nodes(id),
                branch_id INTEGER REFERENCES repertoire_branches(id),
                color TEXT NOT NULL,
                path_san TEXT NOT NULL,
                expected_san TEXT DEFAULT '',
                played_san TEXT DEFAULT '',
                solved INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                event_key TEXT
            )
        """)
        conn.execute("INSERT INTO repertoire_drill_attempts SELECT * FROM attempts_current")
        conn.execute("DROP TABLE attempts_current")
        conn.execute(
            "DELETE FROM schema_migrations WHERE version = 'drill_history_foreign_keys_v2'",
        )
        conn.commit()
        conn.close()

        self.db._run_schema_migrations()

        # Match this migration's own snapshot by label. Globbing every backup and
        # taking the alphabetically-last one silently depended on this being the
        # newest-named migration in SCHEMA_MIGRATIONS.
        backups = sorted(
            (self.db_path.parent / "backups")
            .glob("chess-openings-pre-drill_history_foreign_keys_v2-*.db"),
        )
        self.assertTrue(backups)
        backup = sqlite3.connect(backups[-1])
        self.assertEqual(
            backup.execute("SELECT COUNT(*) FROM repertoire_drill_attempts").fetchone()[0],
            1,
        )
        backup.close()

        conn = self.db.get_db()
        actions = {
            row["from"]: row["on_delete"]
            for row in conn.execute("PRAGMA foreign_key_list(repertoire_drill_attempts)")
        }
        self.assertEqual(actions, {"node_id": "SET NULL", "branch_id": "SET NULL"})
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM repertoire_drill_attempts").fetchone()[0],
            1,
        )
        conn.close()

    def test_changed_line_resets_branch_totals_but_keeps_history(self):
        branch = self.db.save_repertoire_branch("white", "Line", "e4")
        self.db.record_repertoire_drill_attempt(
            "branch-one", "practice", True, branch_id=branch["id"], path_san="e4",
        )
        updated = self.db.update_repertoire_branch(branch["id"], moves_san="d4")
        self.assertTrue(updated["training_reset"])
        self.assertEqual((updated["drill_count"], updated["drill_solved"]), (0, 0))
        attempts = self.db.get_repertoire_drill_attempts()
        self.assertEqual(attempts[0]["path_san"], "e4")

    def test_deleting_repertoire_keeps_history_and_foreign_keys_clean(self):
        branch = self.db.save_repertoire_branch("white", "Line", "e4")
        node = self.db.get_repertoire_tree("white")["root"]["children"][0]
        self.db.record_repertoire_drill_attempt(
            "node-delete", "practice", False, node_id=node["id"], path_san="e4",
        )
        self.db.record_repertoire_drill_attempt(
            "branch-delete", "practice", False, branch_id=branch["id"], path_san="e4",
        )
        self.assertTrue(self.db.delete_repertoire_branch(branch["id"]))
        conn = self.db.get_db()
        attempts = conn.execute(
            "SELECT node_id, branch_id FROM repertoire_drill_attempts ORDER BY id",
        ).fetchall()
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        conn.close()
        self.assertEqual([(r["node_id"], r["branch_id"]) for r in attempts], [(None, None), (None, None)])
        self.assertEqual(violations, [])

    def test_same_external_game_can_belong_to_two_accounts(self):
        first = self.db.create_account("chesscom", "Alpha")
        second = self.db.create_account("chesscom", "Beta")
        base = {
            "white": "Alpha", "black": "Beta", "result": "1-0", "pgn": PGN,
            "source": "chesscom", "external_id": "shared-game", "time_class": "rapid",
        }
        result = self.db.save_imported_games([
            {**base, "account_id": first["id"], "user_color": "white"},
            {**base, "account_id": second["id"], "user_color": "black"},
        ])
        self.assertEqual(result, {"imported": 2, "seen": 2})
        self.assertEqual(self.db.count_games(), 2)

    def test_accounts_are_case_insensitive_and_sync_jobs_cancel(self):
        first = self.db.create_account("chesscom", "Player")
        second = self.db.create_account("chesscom", "player")
        self.assertEqual(first["id"], second["id"])
        job, created = self.db.create_sync_job(first["id"])
        self.assertTrue(created)
        cancelled = self.db.request_sync_job_cancel(job["id"])
        self.assertTrue(cancelled["cancel_requested"])

    def test_manual_backup_is_integral(self):
        self.db.save_repertoire_branch("white", "Line", "e4")
        target = Path(self.temp_dir.name) / "manual.db"
        self.db.create_database_backup(target)
        conn = sqlite3.connect(target)
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM repertoire_branches").fetchone()[0], 1)
        conn.close()

    def test_opening_tree_cache_builds_once_until_invalidated(self):
        account = self.db.create_account("chesscom", "Alpha")
        self.db.save_imported_games([{
            "white": "Alpha", "black": "Beta", "result": "1-0", "pgn": PGN,
            "source": "chesscom", "external_id": "cache-game", "time_class": "rapid",
            "account_id": account["id"], "user_color": "white",
        }])
        import opening_tree
        tree = importlib.reload(opening_tree)
        original = self.db.get_games_for_tree
        with patch.object(self.db, "get_games_for_tree", wraps=original) as loader:
            first = tree.node_for_filter("white", [], ["rapid"], account["id"])
            second = tree.node_for_filter("white", ["e4"], ["rapid"], account["id"])
            self.assertEqual(loader.call_count, 1)
            self.assertEqual(first["moves"][0]["san"], "e4")
            self.assertEqual(second["summary"]["games"], 1)
            tree.invalidate_cache()
            tree.node_for_filter("white", [], ["rapid"], account["id"])
            self.assertEqual(loader.call_count, 2)

    def test_missing_stockfish_is_reported_without_crashing(self):
        import live_engine
        with patch.object(live_engine, "STOCKFISH_PATH", "/definitely/missing/stockfish"):
            status = live_engine.availability()
        self.assertFalse(status["available"])
        self.assertIn("Install Stockfish", status["message"])

    def test_live_engine_defaults_to_three_threads_for_all_searches(self):
        import live_engine
        shallow = live_engine._build_limit(live_engine.LIVE_DEPTH, live_engine.LIVE_MAX_SECONDS)
        deep_depth = live_engine._build_limit(live_engine.LIVE_DEPTH + 10, 0)
        time_only = live_engine._build_limit(0, live_engine.LIVE_MAX_SECONDS)
        infinite = live_engine._build_limit(0, 0)

        expected = min(3, os.cpu_count() or 1)
        self.assertEqual(live_engine.DEFAULT_THREADS, expected)
        self.assertEqual(live_engine.LIVE_INTERACTIVE_THREADS, expected)
        self.assertEqual(live_engine.LIVE_DEEP_THREADS, expected)
        for limit in (shallow, deep_depth, time_only, infinite):
            self.assertEqual(live_engine._threads_for_limit(limit), expected)

    def test_default_threads_never_exceeds_cpu_count(self):
        import live_engine
        with patch.object(live_engine.os, "cpu_count", return_value=2):
            self.assertEqual(live_engine._default_threads(), 2)
        with patch.object(live_engine.os, "cpu_count", return_value=None):
            self.assertEqual(live_engine._default_threads(), 1)
        with patch.object(live_engine.os, "cpu_count", return_value=16):
            self.assertEqual(live_engine._default_threads(), 3)

if __name__ == "__main__":
    unittest.main()
