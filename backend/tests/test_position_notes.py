import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

AFTER_E4_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
# The same position with different move clocks, as another move order gives.
SAME_POSITION = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 9"


class PositionNotesTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "notes.db")
        import database
        import position_notes
        import main
        importlib.reload(database).init_db()
        importlib.reload(position_notes)
        self.main = importlib.reload(main)

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def test_a_note_belongs_to_the_position_whatever_the_move_order(self):
        with TestClient(self.main.app) as client:
            empty = client.get("/api/notes", params={"fen": AFTER_E4_E5_NF3}).json()
            self.assertEqual(empty, {"note": "", "updated_at": None})

            saved = client.put("/api/notes", json={"fen": AFTER_E4_E5_NF3, "note": "  Nc6 is the main move  "})
            self.assertEqual(saved.json()["note"], "Nc6 is the main move")
            again = client.get("/api/notes", params={"fen": SAME_POSITION}).json()
            self.assertEqual(again["note"], "Nc6 is the main move")

            client.put("/api/notes", json={"fen": SAME_POSITION, "note": "Changed"})
            listing = client.get("/api/notes/all").json()["notes"]
            self.assertEqual([n["note"] for n in listing], ["Changed"])
            self.assertTrue(listing[0]["key"])

            client.put("/api/notes", json={"fen": AFTER_E4_E5_NF3, "note": "   "})
            self.assertEqual(client.get("/api/notes/all").json()["notes"], [])
            self.assertEqual(client.put("/api/notes", json={"fen": "nonsense", "note": "x"}).status_code, 400)

    def test_play_reply_accepts_long_thinking_times_up_to_the_limit(self):
        with TestClient(self.main.app) as client:
            too_long = client.post("/api/play/reply", json={"fen": AFTER_E4_E5_NF3, "seconds": 301})
            self.assertEqual(too_long.status_code, 422)


if __name__ == "__main__":
    unittest.main()
