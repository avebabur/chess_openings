import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
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
        import stockfish
        with patch.object(stockfish, "STOCKFISH_PATH", "/definitely/missing/stockfish"):
            status = stockfish.availability()
        self.assertFalse(status["available"])
        self.assertIn("Install Stockfish", status["message"])


if __name__ == "__main__":
    unittest.main()
