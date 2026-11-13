import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


PGN_OLD_NAME = """[Date "2026.05.25"]
[White "opponent"]
[Black "makesadifference"]
[Result "0-1"]

1. e4 c6 2. d4 d5 0-1
"""

PGN_NEW_NAME = """[Date "2026.05.24"]
[White "opponent"]
[Black "currentname"]
[Result "0-1"]

1. e4 c6 2. d4 d5 0-1
"""


class IntegrityMigrationTests(unittest.TestCase):
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


    def test_legacy_duplicate_merge_preserves_analysis_and_references(self):
        conn = self.db.get_db()
        account_id = conn.execute(
            "INSERT INTO accounts (platform, username) VALUES ('chesscom', 'currentname')",
        ).lastrowid
        canonical_id = conn.execute(
            """INSERT INTO games
               (white, black, result, date, pgn, source, external_id, user_color,
                account_id, analyzed)
               VALUES (?, ?, '0-1', '2026.05.24', ?, 'chesscom', 'game-1',
                       'black', ?, 0)""",
            ("opponent", "currentname", PGN_NEW_NAME, account_id),
        ).lastrowid
        analysis = {"opening": "Caro-Kann", "white_accuracy": 71.2}
        legacy_id = conn.execute(
            """INSERT INTO games
               (white, black, result, date, pgn, source, analysis, analyzed,
                analysis_updated_at)
               VALUES (?, ?, '0-1', '2026.05.25', ?, 'manual', ?, 1,
                       '2026-06-20T12:00:00Z')""",
            ("opponent", "makesadifference", PGN_OLD_NAME, json.dumps(analysis)),
        ).lastrowid
        conn.execute(
            """INSERT INTO puzzles
               (game_id, fen, user_move, best_move)
               VALUES (?, 'start', 'e4', 'd4')""",
            (canonical_id,),
        )
        puzzle_id = conn.execute(
            """INSERT INTO puzzles
               (game_id, fen, user_move, best_move)
               VALUES (?, 'start', 'e4', 'd4')""",
            (legacy_id,),
        ).lastrowid
        conn.execute(
            """INSERT INTO reanalyze_jobs (status_id, game_id, payload)
               VALUES (1, ?, '{}')""",
            (legacy_id,),
        )
        conn.execute(
            "DELETE FROM schema_migrations WHERE version = ?",
            (self.db.INTEGRITY_MIGRATIONS[1],),
        )
        conn.commit()
        conn.close()

        self.db._run_integrity_migrations()
        self.db._run_integrity_migrations()

        conn = self.db.get_db()
        legacy = conn.execute("SELECT * FROM games WHERE id = ?", (legacy_id,)).fetchone()
        canonical = conn.execute("SELECT * FROM games WHERE id = ?", (canonical_id,)).fetchone()
        puzzle_row = conn.execute("SELECT game_id FROM puzzles WHERE id = ?", (puzzle_id,)).fetchone()
        canonical_puzzles = conn.execute(
            "SELECT COUNT(*) FROM puzzles WHERE game_id = ?", (canonical_id,),
        ).fetchone()[0]
        job_game = conn.execute("SELECT game_id FROM reanalyze_jobs WHERE status_id = 1").fetchone()[0]
        conn.close()

        self.assertEqual(legacy["merged_into_game_id"], canonical_id)
        self.assertEqual(json.loads(canonical["analysis"]), analysis)
        self.assertEqual(canonical["analyzed"], 1)
        self.assertIsNone(puzzle_row)
        self.assertEqual(canonical_puzzles, 1)
        self.assertEqual(job_game, canonical_id)
        self.assertEqual(self.db.count_games(), 1)
        self.assertEqual(self.db.get_game(legacy_id)["id"], canonical_id)
        self.assertTrue(Path(f"{self.db_path}.bak-pre-integrity-v1").exists())


if __name__ == "__main__":
    unittest.main()
