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


# Lucena position, White to move and winning. The upstream reply below is a
# trimmed copy of what tablebase.lichess.ovh returned for it on 2026-11-12.
LUCENA = "6K1/4k1P1/8/8/8/7r/8/5R2 w - - 0 1"
LUCENA_UPSTREAM = {
    "category": "win", "dtz": 15, "dtm": 41,
    "moves": [
        {"uci": "f1e1", "san": "Re1+", "category": "loss", "dtz": -14, "dtm": -40, "zeroing": False},
        {"uci": "f1h1", "san": "Rh1", "category": "draw", "dtz": 0, "dtm": 0, "zeroing": False},
        {"uci": "f1f3", "san": "Rf3", "category": "win", "dtz": 1, "dtm": 35, "zeroing": False},
    ],
}
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
KR_K_WITH_CASTLING = "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1"


class TablebaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "tb.db")
        import database
        import lichess_tablebase
        importlib.reload(database)
        database.init_db()
        self.tb = importlib.reload(lichess_tablebase)
        self.calls = []

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def client(self, payload=None, status=200, error=None):
        def handler(request):
            self.calls.append(str(request.url))
            if error:
                raise error
            return httpx.Response(status, json=payload)
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_move_results_are_reported_from_the_movers_side(self):
        with self.client(LUCENA_UPSTREAM) as client:
            result = self.tb.get_tablebase(LUCENA, client=client)

        self.assertTrue(result["available"])
        self.assertEqual(result["outcome"], "win")
        by_san = {move["san"]: move for move in result["moves"]}
        # Upstream says "loss" for Re1+ because Black, to move next, is lost.
        self.assertEqual(by_san["Re1+"]["outcome"], "win")
        self.assertEqual(by_san["Re1+"]["dtm"], 40)
        self.assertEqual(by_san["Rh1"]["outcome"], "draw")
        self.assertEqual(by_san["Rf3"]["outcome"], "loss")
        # Best-first order is preserved: perfect play is moves[0].
        self.assertEqual(result["moves"][0]["san"], "Re1+")

    def test_a_hit_is_cached_and_never_fetched_twice(self):
        with self.client(LUCENA_UPSTREAM) as client:
            first = self.tb.get_tablebase(LUCENA, client=client)
            second = self.tb.get_tablebase(LUCENA, client=client)
            offline = self.tb.get_tablebase(LUCENA, allow_network=False, client=client)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(first, second)
        self.assertEqual(first, offline)

    def test_the_halfmove_clock_is_part_of_the_cache_key(self):
        # The 50-move rule can turn a win into a draw as the clock runs.
        later = LUCENA.replace(" 0 1", " 40 21")
        self.assertNotEqual(self.tb.cache_key(LUCENA), self.tb.cache_key(later))
        self.assertEqual(self.tb.cache_key(LUCENA), self.tb.cache_key(LUCENA.replace(" 0 1", " 0 9")))

    def test_positions_the_tablebase_cannot_judge_make_no_request(self):
        with self.client(LUCENA_UPSTREAM) as client:
            too_many = self.tb.get_tablebase(START, client=client)
            castling = self.tb.get_tablebase(KR_K_WITH_CASTLING, client=client)
        self.assertEqual(too_many, {"available": False, "reason": "pieces"})
        self.assertEqual(castling, {"available": False, "reason": "castling"})
        self.assertEqual(self.calls, [])

    def test_unknown_and_failed_lookups_are_not_cached(self):
        with self.client({"category": "unknown", "moves": []}) as client:
            unknown = self.tb.get_tablebase(LUCENA, client=client)
        self.assertEqual(unknown, {"available": False, "reason": "unknown"})

        request = httpx.Request("GET", self.tb.TABLEBASE_URL)
        with self.client(error=httpx.ConnectError("offline", request=request)) as client:
            failed = self.tb.get_tablebase(LUCENA, client=client)
        self.assertEqual(failed, {"available": False, "reason": "error"})

        with self.client(status=500, payload={}) as client:
            self.assertEqual(self.tb.get_tablebase(LUCENA, client=client)["reason"], "error")

        # Nothing above poisoned the cache: a later good answer still lands.
        with self.client(LUCENA_UPSTREAM) as client:
            self.assertTrue(self.tb.get_tablebase(LUCENA, client=client)["available"])

    def test_not_cached_and_offline_is_reported_as_offline(self):
        self.assertEqual(
            self.tb.get_tablebase(LUCENA, allow_network=False),
            {"available": False, "reason": "offline"},
        )

    def test_fifty_move_draws_are_draws_with_a_flag(self):
        upstream = {
            "category": "cursed-win", "dtz": 120, "dtm": None,
            "moves": [{"uci": "f1e1", "san": "Re1+", "category": "blessed-loss", "dtz": -119, "dtm": None}],
        }
        with self.client(upstream) as client:
            result = self.tb.get_tablebase(LUCENA, client=client)
        self.assertEqual(result["outcome"], "draw")
        self.assertTrue(result["fifty_move"])
        self.assertEqual(result["moves"][0]["outcome"], "draw")
        self.assertTrue(result["moves"][0]["fifty_move"])


class PlayReplyApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "play.db")
        import database
        import sync_service
        import main
        importlib.reload(database)
        importlib.reload(sync_service)
        self.main = importlib.reload(main)
        self.client_context = TestClient(self.main.app)
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def test_with_seven_or_fewer_pieces_the_tablebase_move_is_played(self):
        table = {"available": True, "outcome": "win", "moves": [
            {"uci": "f1e1", "san": "Re1+", "outcome": "win"},
            {"uci": "f1h1", "san": "Rh1", "outcome": "draw"},
        ]}
        clients = self.main.app.state.external_clients
        engine = self.main.app.state.live_engine
        with patch.object(clients, "tablebase", return_value=table), \
                patch.object(engine, "best_move") as best_move:
            response = self.client.post("/api/play/reply", json={"fen": LUCENA})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "uci": "f1e1", "san": "Re1+", "source": "tablebase", "outcome": "win", "cp": None,
        })
        best_move.assert_not_called()

    def test_otherwise_stockfish_chooses_within_the_requested_time(self):
        clients = self.main.app.state.external_clients
        engine = self.main.app.state.live_engine
        reply = {"uci": "e2e4", "san": "e4", "eval": 0.3, "depth": 20}
        with patch.object(clients, "tablebase", return_value={"available": False, "reason": "pieces"}), \
                patch.object(engine, "best_move", return_value=reply) as best_move:
            response = self.client.post("/api/play/reply", json={"fen": START, "seconds": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {**reply, "source": "stockfish", "outcome": None, "cp": 30})
        best_move.assert_called_once_with(START, 2.0)

    def test_a_finished_game_and_a_silent_engine_are_errors(self):
        mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
        self.assertEqual(self.client.post("/api/play/reply", json={"fen": mated}).status_code, 400)
        self.assertEqual(self.client.post("/api/play/reply", json={"fen": "nonsense"}).status_code, 400)

        clients = self.main.app.state.external_clients
        engine = self.main.app.state.live_engine
        with patch.object(clients, "tablebase", return_value={"available": False, "reason": "pieces"}), \
                patch.object(engine, "best_move", return_value=None):
            response = self.client.post("/api/play/reply", json={"fen": START})
        self.assertEqual(response.status_code, 503)

    def test_a_position_no_game_can_reach_never_gets_to_the_engine(self):
        # python-chess parses this (Black in check, White to move); Stockfish 19
        # would exit on it.
        impossible = "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1"
        engine = self.main.app.state.live_engine
        with patch.object(engine, "best_move") as best_move:
            response = self.client.post("/api/play/reply", json={"fen": impossible})
        self.assertEqual(response.status_code, 400)
        best_move.assert_not_called()

    def test_tablebase_route_validates_the_fen(self):
        self.assertEqual(self.client.get("/api/tablebase", params={"fen": "nonsense"}).status_code, 400)
        clients = self.main.app.state.external_clients
        with patch.object(clients, "tablebase", return_value={"available": False, "reason": "pieces"}) as lookup:
            response = self.client.get("/api/tablebase", params={"fen": START})
        self.assertEqual(response.json(), {"available": False, "reason": "pieces"})
        lookup.assert_called_once()


if __name__ == "__main__":
    unittest.main()
