import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# A real answer from /api/puzzle/next, trimmed to what is read.
ANSWER = {
    "game": {"id": "4bsK75kr"},
    "puzzle": {
        "id": "r162L", "rating": 1190, "plays": 1376,
        "solution": ["a7h7", "h4g4", "d2g2", "g4f5", "g2g8"],
        "themes": ["endgame", "advantage", "long", "rookEndgame", "skewer"],
        "fen": "6r1/R6p/p4p2/4p3/1P5k/P4r2/2PR3K/8 w - - 0 1",
        "lastMove": "g4h4", "initialPly": 65,
    },
}
CHESSCOM_PGN = '[Link "https://www.chess.com/game/live/186950467864"]\n\n1. d4 d5 1-0'


class PuzzleCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "puzzles.db")
        import database
        import lichess_puzzles
        self.db = importlib.reload(database)
        self.db.init_db()
        self.lp = importlib.reload(lichess_puzzles)
        self.requests = []

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def client(self, status=200, body=ANSWER):
        def handler(request):
            self.requests.append(request)
            return httpx.Response(status, json=body)
        return httpx.Client(transport=httpx.MockTransport(handler))


class ParseTest(PuzzleCase):
    def test_reads_position_side_and_solution(self):
        puzzle = self.lp.parse_puzzle(ANSWER, "rookEndgame")
        self.assertEqual(puzzle["id"], "r162L")
        self.assertEqual(puzzle["user_color"], "white")
        self.assertEqual(puzzle["last_move"], "g4h4")
        self.assertEqual(puzzle["solution_san"], ["Rxh7+", "Kg4", "Rg2+", "Kf5", "Rxg8"])

    def test_rejects_a_solution_that_does_not_play(self):
        broken = {"puzzle": {**ANSWER["puzzle"], "solution": ["a1a8"]}}
        with self.assertRaises(self.lp.PuzzleError):
            self.lp.parse_puzzle(broken, "mix")
        with self.assertRaises(self.lp.PuzzleError):
            self.lp.parse_puzzle({}, "mix")

    def test_every_theme_has_one_label(self):
        keys = [key for _, items in self.lp.THEME_GROUPS for key, _ in items]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertIn("rookEndgame", self.lp.THEMES)


class FetchAndRecordTest(PuzzleCase):
    def test_fetch_asks_for_the_theme_without_a_token_and_keeps_the_puzzle(self):
        puzzle = self.lp.fetch_next(self.client(), "rookEndgame", "easier")
        request = self.requests[0]
        self.assertEqual(request.url.params["angle"], "rookEndgame")
        self.assertEqual(request.url.params["difficulty"], "easier")
        self.assertNotIn("authorization", request.headers)
        self.assertEqual(puzzle["url"], "https://lichess.org/training/r162L")
        self.assertEqual(puzzle["progress"]["attempts"], 0)

    def test_errors_are_reported_in_words(self):
        with self.assertRaisesRegex(self.lp.PuzzleError, "slow down"):
            self.lp.fetch_next(self.client(status=429), "mix", "normal")
        with self.assertRaisesRegex(self.lp.PuzzleError, "Unknown puzzle theme"):
            self.lp.fetch_next(self.client(), "nope", "normal")
        self.assertEqual(len(self.requests), 1)

    def test_the_first_try_is_what_counts_and_refetching_keeps_the_record(self):
        self.lp.fetch_next(self.client(), "rookEndgame", "normal")
        self.assertEqual(self.lp.record_attempt("r162L", False)["last_result"], "failed")
        self.assertEqual([p["id"] for p in self.lp.summary()["missed"]], ["r162L"])

        self.lp.record_attempt("r162L", True)
        self.lp.fetch_next(self.client(), "rookEndgame", "normal")
        result = self.lp.summary()
        self.assertEqual(result["missed"], [])
        self.assertEqual((result["played"], result["solved"]), (1, 0))
        rook = next(t for g in result["groups"] for t in g["themes"] if t["key"] == "rookEndgame")
        self.assertEqual((rook["played"], rook["solved"]), (1, 0))
        self.assertEqual(self.lp.get("r162L")["progress"]["attempts"], 2)

        # Served again under another theme, it stays where it was first played.
        self.lp.fetch_next(self.client(), "mix", "normal")
        self.assertEqual(self.lp.get("r162L")["theme"], "rookEndgame")
        self.assertIsNone(self.lp.record_attempt("zzzzz", True))


class ApiTest(PuzzleCase):
    def setUp(self):
        super().setUp()
        import main
        self.main = importlib.reload(main)
        self.lp = sys.modules["lichess_puzzles"]

    def test_puzzle_endpoints(self):
        with TestClient(self.main.app) as client:
            client.app.state.external_clients.http = self.client()
            self.assertEqual(client.get("/api/puzzles/next?theme=nope").status_code, 400)
            puzzle = client.get("/api/puzzles/next?theme=rookEndgame&difficulty=easier").json()
            self.assertEqual(puzzle["id"], "r162L")
            done = client.post("/api/puzzles/r162L/attempts", json={"solved": True})
            self.assertEqual(done.json()["solved"], 1)
            self.assertEqual(
                client.post("/api/puzzles/nope1/attempts", json={"solved": True}).status_code, 404)
            listing = client.get("/api/puzzles").json()
            self.assertEqual(listing["played"], 1)
            self.assertIn("easier", listing["difficulties"])

    def test_a_chesscom_address_finds_the_imported_game(self):
        conn = self.db.get_db()
        with conn:
            game_id = conn.execute(
                "INSERT INTO games (white, black, result, pgn, source, user_color) "
                "VALUES ('me', 'them', '1-0', ?, 'chesscom', 'white')", (CHESSCOM_PGN,),
            ).lastrowid
        conn.close()
        with TestClient(self.main.app) as client:
            for url in (
                "https://www.chess.com/game/live/186950467864",
                "https://www.chess.com/analysis/game/live/186950467864?tab=review",
                "https://www.chess.com/game/186950467864",
            ):
                self.assertEqual(client.get("/api/games/by-link", params={"url": url}).json()["id"], game_id)
            missing = client.get("/api/games/by-link", params={"url": "https://www.chess.com/game/live/18695046786"})
            self.assertEqual(missing.status_code, 404)
            other = client.get("/api/games/by-link", params={"url": "https://example.com/game/1234567"})
            self.assertEqual(other.status_code, 400)


if __name__ == "__main__":
    unittest.main()
