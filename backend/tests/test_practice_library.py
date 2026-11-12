import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# Trimmed to the markup the parser reads, in the order Lichess lists them.
INDEX_HTML = (
    '<section><h2>Checkmates</h2><div class="studies">'
    '<a class="study future" href="/practice/checkmates/practicestnamcheckmatepatternsi/fE4k21MW">'
    '<icon class="fE4k21MW"></icon><span class="text"><h3>Checkmate Patterns I</h3>'
    '<em>Recognize the patterns</em></span></a>'
    '</div></section>'
    '<section><h2>Pawn endgames</h2><div class="studies">'
    '<a class="study future" href="/practice/pawn-endgames/practicestnamopposition/A4ujYOer">'
    '<icon class="A4ujYOer"></icon><span class="text"><h3>Opposition</h3>'
    '<em>Kings &amp; pawns</em></span></a>'
    '</div></section>'
)

MATE_STUDY = """[Event "Lichess Practice: Checkmate Patterns I: Back-Rank Mate #1"]
[Termination "mate in 1"]
[ChapterName "Back-Rank Mate #1"]
[ChapterURL "https://lichess.org/study/fE4k21MW/9rd7XwOw"]
[FEN "6k1/4Rppp/8/8/8/8/5PPP/6K1 w - - 0 1"]
[SetUp "1"]
[Orientation "white"]

 *


[Event "Lichess Practice: Checkmate Patterns I: Back-Rank Mate #2"]
[Termination "-300cp in 2"]
[ChapterName "Black wins material"]
[ChapterURL "https://lichess.org/study/fE4k21MW/i3Z6Yb3p"]
[FEN "4k3/8/8/8/8/8/4q3/4K3 b - - 0 1"]
[SetUp "1"]
[Orientation "black"]

 { [%cal Ge2e1] Take the pawn. } *


[Event "Lichess Practice: Checkmate Patterns I: Queen mate"]
[ChapterName "Queen mate"]
[ChapterURL "https://lichess.org/study/fE4k21MW/Aaaaaaaa"]
[FEN "8/8/8/8/8/5k2/8/5QK1 w - - 0 1"]
[SetUp "1"]
[Orientation "white"]

 *


[Event "Lichess Practice: Checkmate Patterns I: Introduction"]
[ChapterName "Introduction"]
[ChapterURL "https://lichess.org/study/fE4k21MW/Bbbbbbbb"]

1. e4 { A lesson, no position set up. } e5 *
"""

PAWN_STUDY = """[Event "Lichess Practice: Opposition: Direct Opposition #1"]
[Termination "promotion with +100cp"]
[ChapterName "Direct Opposition #1"]
[ChapterURL "https://lichess.org/study/A4ujYOer/eNlmabX1"]
[FEN "8/2k5/8/8/2PK4/8/8/8 w - - 0 1"]
[SetUp "1"]
[Orientation "white"]

 *


[Event "Lichess Practice: Opposition: Direct Opposition #2"]
[Termination "draw in 20"]
[ChapterName "Direct Opposition #2"]
[ChapterURL "https://lichess.org/study/A4ujYOer/TUjQitNN"]
[FEN "7K/8/4Q3/8/8/8/2p5/1k6 w - - 0 1"]
[SetUp "1"]
[Orientation "black"]

 *


[Event "Lichess Practice: Opposition: Exercise: d-pawn = Win"]
[ChapterName "Exercise: d-pawn = Win"]
[ChapterURL "https://lichess.org/study/A4ujYOer/Cccccccc"]
[FEN "8/8/8/3k4/8/3K4/3P4/8 w - - 0 1"]
[SetUp "1"]
[Orientation "white"]

 *
"""


class GoalParsingTests(unittest.TestCase):
    def setUp(self):
        import practice_library
        self.pl = practice_library

    def test_every_termination_shape_lichess_uses(self):
        cases = {
            "mate in 3": ("mate", None, 3),
            "mate": ("mate", None, None),
            "+300cp in 2": ("eval", 300, 2),
            "-1000cp in 1": ("eval", 1000, 1),
            "promotion with +100cp": ("promotion", 100, None),
            "promotion with -500cp": ("promotion", 500, None),
            "equalize in 10": ("equalize", None, 10),
            "draw in 20": ("draw", None, 20),
            "Draw in 10": ("draw", None, 10),
        }
        for text, (kind, cp, moves) in cases.items():
            goal = self.pl.parse_goal(text)
            self.assertEqual((goal["kind"], goal["cp"], goal["moves"]), (kind, cp, moves), text)

    def test_unknown_text_is_not_guessed(self):
        self.assertIsNone(self.pl.parse_goal("win the game"))
        self.assertIsNone(self.pl.parse_goal(""))

    def test_a_goalless_chapter_only_gets_a_goal_when_it_is_certain(self):
        infer = self.pl.infer_goal
        self.assertEqual(infer("checkmates", "Queen and rook mate", False)["kind"], "mate")
        self.assertEqual(infer("checkmates", "Exercise: Checkmate the Engine", False)["kind"], "mate")
        self.assertEqual(infer("checkmates", "Two knights vs pawn", True)["kind"], "study")
        self.assertEqual(infer("checkmates", "Delivering Mate", True)["kind"], "study")
        self.assertEqual(infer("pawn-endgames", "Exercise: d-pawn = Win", False)["kind"], "win")
        self.assertEqual(infer("pawn-endgames", "Exercise: with a line", True)["kind"], "study")
        self.assertEqual(infer("rook-endgames", "Vancura Position", True)["kind"], "study")


class ParsingTests(unittest.TestCase):
    def setUp(self):
        import practice_library
        self.pl = practice_library

    def test_index_keeps_lichess_order_and_titles(self):
        sets = self.pl.parse_index(INDEX_HTML)
        self.assertEqual([s["id"] for s in sets], ["fE4k21MW", "A4ujYOer"])
        self.assertEqual(sets[0]["section"], "checkmates")
        self.assertEqual(sets[0]["section_title"], "Checkmates")
        self.assertEqual(sets[0]["title"], "Checkmate Patterns I")
        self.assertEqual(sets[1]["section_title"], "Pawn endgames")
        self.assertEqual(sets[1]["subtitle"], "Kings & pawns")

    def test_study_chapters_become_positions(self):
        study = {"id": "fE4k21MW", "section": "checkmates"}
        positions = self.pl.parse_study(MATE_STUDY, study)
        self.assertEqual(len(positions), 4)
        first, second, third, lesson = positions
        self.assertEqual((first["chapter_id"], first["goal_kind"], first["goal_moves"]), ("9rd7XwOw", "mate", 1))
        self.assertEqual(first["orientation"], "white")
        self.assertEqual(second["orientation"], "black")
        self.assertEqual((second["goal_kind"], second["goal_cp"], second["goal_moves"]), ("eval", 300, 2))
        # Arrows are drawing instructions, not text for the user.
        self.assertEqual(second["description"], "Take the pawn.")
        self.assertEqual(third["goal_kind"], "mate")  # inferred: "Queen mate"
        self.assertEqual(third["goal_text"], "")
        # No FEN means the standard start; a line with no goal is just a study.
        self.assertEqual(lesson["goal_kind"], "study")
        self.assertTrue(lesson["fen"].startswith("rnbqkbnr/pppppppp"))
        self.assertEqual(lesson["solution_san"], ["e4", "e5"])
        self.assertEqual([p["chapter_order"] for p in positions], [1, 2, 3, 4])


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "practice.db")
        import database
        import practice_library
        importlib.reload(database)
        database.init_db()
        self.pl = importlib.reload(practice_library)
        self.pl.REQUEST_PAUSE = 0
        self.pl.RATE_LIMIT_WAIT = 0
        self.requests = []
        self.rate_limited = {}

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def client(self, missing=()):
        def handler(request):
            path = request.url.path
            self.requests.append(path)
            if path == "/practice":
                return httpx.Response(200, text=INDEX_HTML)
            study_id = path.rsplit("/", 1)[-1].removesuffix(".pgn")
            if self.rate_limited.get(study_id, 0) > 0:
                self.rate_limited[study_id] -= 1
                return httpx.Response(429, json={"error": "Please only run 1 request(s) at a time"})
            if study_id in missing:
                return httpx.Response(404, text="not found")
            return httpx.Response(200, text={"fE4k21MW": MATE_STUDY, "A4ujYOer": PAWN_STUDY}[study_id])
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_imports_every_set_in_order(self):
        with self.client() as client:
            result = self.pl.import_library(client)
        self.assertEqual(result, {"sets": 2, "positions": 7, "failed": []})
        library = self.pl.get_library()
        self.assertTrue(library["imported"])
        self.assertEqual([s["id"] for s in library["sections"]], ["checkmates", "pawn-endgames"])
        patterns = library["sections"][0]["sets"][0]
        self.assertEqual(patterns["title"], "Checkmate Patterns I")
        # The lesson is listed but does not count towards the total.
        self.assertEqual((len(patterns["positions"]), patterns["total"]), (4, 3))
        self.assertEqual(library["total"], 6)

    def test_running_it_again_updates_in_place_and_keeps_progress(self):
        with self.client() as client:
            self.pl.import_library(client)
            position_id = self.pl.get_library()["sections"][0]["sets"][0]["positions"][0]["id"]
            self.pl.record_attempt(position_id, True)
            self.pl.import_library(client)
        library = self.pl.get_library()
        positions = [p for s in library["sections"] for t in s["sets"] for p in t["positions"]]
        self.assertEqual(len(positions), 7)
        first = positions[0]
        self.assertEqual(first["id"], position_id)
        self.assertEqual(first["progress"]["solved"], 1)
        self.assertEqual(library["solved"], 1)

    def test_a_429_is_waited_out_and_retried(self):
        self.rate_limited["A4ujYOer"] = 2
        with self.client() as client:
            result = self.pl.import_library(client)
        self.assertEqual(result["failed"], [])
        self.assertEqual(self.requests.count("/api/study/A4ujYOer.pgn"), 3)

    def test_one_bad_set_does_not_lose_the_others(self):
        with self.client(missing={"A4ujYOer"}) as client:
            result = self.pl.import_library(client)
        self.assertEqual(result["failed"], ["Opposition"])
        self.assertEqual(result["positions"], 4)
        # A later run fills the gap.
        with self.client() as client:
            self.assertEqual(self.pl.import_library(client)["failed"], [])
        self.assertEqual(self.pl.get_library()["total"], 6)

    def test_progress_keeps_the_latest_result_and_the_counts(self):
        with self.client() as client:
            self.pl.import_library(client)
        position_id = self.pl.get_library()["sections"][0]["sets"][0]["positions"][0]["id"]
        self.pl.record_attempt(position_id, False)
        self.pl.record_attempt(position_id, False)
        progress = self.pl.record_attempt(position_id, True)
        self.assertEqual((progress["attempts"], progress["solved"], progress["failed"]), (3, 1, 2))
        self.assertEqual(progress["last_result"], "solved")
        self.assertIsNone(self.pl.record_attempt(99999, True))


class PracticeApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "api.db")
        import database
        import sync_service
        import main
        importlib.reload(database)
        importlib.reload(sync_service)
        self.main = importlib.reload(main)
        self.context = TestClient(self.main.app)
        self.client = self.context.__enter__()

    def tearDown(self):
        self.context.__exit__(None, None, None)
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def test_empty_library_says_it_is_not_imported(self):
        body = self.client.get("/api/practice/library").json()
        self.assertEqual(body, {"imported": False, "sections": [], "total": 0, "solved": 0})
        self.assertFalse(self.client.get("/api/practice/import").json()["running"])

    def test_import_is_refused_when_the_network_is_off(self):
        with patch.dict(os.environ, {"OPENINGS_DISABLE_EXTERNAL_NETWORK": "1"}):
            response = self.client.post("/api/practice/import")
        self.assertEqual(response.status_code, 503)

    def test_import_runs_in_the_background_and_reports_when_done(self):
        import practice_library as pl
        pl.REQUEST_PAUSE = 0

        def handler(request):
            if request.url.path == "/practice":
                return httpx.Response(200, text=INDEX_HTML)
            study_id = request.url.path.rsplit("/", 1)[-1].removesuffix(".pgn")
            return httpx.Response(200, text={"fE4k21MW": MATE_STUDY, "A4ujYOer": PAWN_STUDY}[study_id])

        with httpx.Client(transport=httpx.MockTransport(handler)) as fake:
            with patch.object(self.main.app.state.external_clients, "http", fake):
                response = self.client.post("/api/practice/import")
                self.assertEqual(response.status_code, 202)
                self.main.app.state.practice_importer.join(10)
        status = self.client.get("/api/practice/import").json()
        self.assertFalse(status["running"])
        self.assertIsNone(status["error"])
        self.assertEqual(status["result"]["positions"], 7)
        self.assertEqual(self.client.get("/api/practice/library").json()["total"], 6)

    def test_attempts_are_recorded_and_shown_in_the_library(self):
        import practice_library as pl
        pl.store_set(
            {"id": "fE4k21MW", "section": "checkmates", "section_title": "Checkmates",
             "title": "Checkmate Patterns I", "subtitle": ""},
            1, pl.parse_study(MATE_STUDY, {"id": "fE4k21MW", "section": "checkmates"}))
        position = self.client.get("/api/practice/library").json()["sections"][0]["sets"][0]["positions"][0]
        recorded = self.client.post(
            f"/api/practice/positions/{position['id']}/attempts", json={"solved": True})
        self.assertEqual(recorded.json()["last_result"], "solved")
        library = self.client.get("/api/practice/library").json()
        self.assertEqual(library["solved"], 1)
        self.assertEqual(self.client.post(
            "/api/practice/positions/999/attempts", json={"solved": True}).status_code, 404)

    def test_the_play_reply_carries_what_goals_need_to_judge_the_move(self):
        table = {"available": True, "outcome": "draw",
                 "moves": [{"uci": "e1e2", "san": "Ke2", "outcome": "draw"}]}
        with patch.object(self.main.app.state.external_clients, "tablebase", return_value=table):
            body = self.client.post("/api/play/reply", json={
                "fen": "8/8/8/8/8/4k3/4P3/4K3 b - - 0 1", "seconds": 1}).json()
        self.assertEqual((body["source"], body["outcome"], body["cp"]), ("tablebase", "draw", None))

        with patch.object(self.main.app.state.external_clients, "tablebase", return_value={"available": False}), \
                patch.object(self.main.app.state.live_engine, "best_move",
                             return_value={"uci": "e7e5", "san": "e5", "eval": -1.25, "depth": 20}):
            body = self.client.post("/api/play/reply", json={
                "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "seconds": 1}).json()
        self.assertEqual((body["source"], body["outcome"], body["cp"]), ("stockfish", None, -125))


if __name__ == "__main__":
    unittest.main()
