import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

import chess
import chess.engine
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# White hangs the queen on move 3; Black takes it.
QUEEN_HANG = '[Result "0-1"]\n\n1. e4 e5 2. Qh5 Nc6 3. Qxf7+ Kxf7 0-1'
# K+P ending: 1. Kd5 keeps the win, 1. e5 gives it away (invented verdicts).
PAWN_ENDING = (
    '[FEN "8/8/4k3/8/4P3/4K3/8/8 w - - 0 1"]\n[SetUp "1"]\n\n1. e5 Kd5 1/2-1/2'
)


class FakeEngine:
    """Rates a position by material, from the side to move; best move is the
    first capture, else the first legal move."""

    VALUES = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 300,
              chess.ROOK: 500, chess.QUEEN: 900}

    def __init__(self):
        self.searches = 0
        self.closed = False

    def analyse(self, board, limit):
        self.searches += 1
        cp = 0
        for piece_type, value in self.VALUES.items():
            cp += value * len(board.pieces(piece_type, board.turn))
            cp -= value * len(board.pieces(piece_type, not board.turn))
        moves = list(board.legal_moves)
        best = next((m for m in moves if board.is_capture(m)), moves[0])
        # Material after the best capture, so a hanging piece shows up at once.
        if board.is_capture(best):
            victim = board.piece_type_at(best.to_square) or chess.PAWN
            cp += self.VALUES.get(victim, 0)
        return {"score": chess.engine.PovScore(chess.engine.Cp(cp), board.turn), "pv": [best]}

    def quit(self):
        self.closed = True


class DatabaseCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "analysis.db")
        import database
        import game_analysis
        self.db = importlib.reload(database)
        self.db.init_db()
        self.ga = importlib.reload(game_analysis)

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def add_game(self, pgn, user_color="white", end_time="2026-11-01T10:00:00"):
        conn = self.db.get_db()
        with conn:
            cur = conn.execute(
                "INSERT INTO games (white, black, result, pgn, user_color, end_time) "
                "VALUES ('me', 'them', '0-1', ?, ?, ?)", (pgn, user_color, end_time))
        conn.close()
        return cur.lastrowid


class ScaleTest(unittest.TestCase):
    def setUp(self):
        import game_analysis
        self.ga = game_analysis

    def test_win_chance_is_symmetric_and_bounded(self):
        self.assertAlmostEqual(self.ga.win_chance(0), 50.0)
        self.assertAlmostEqual(self.ga.win_chance(300) + self.ga.win_chance(-300), 100.0)
        self.assertGreater(self.ga.win_chance(self.ga.MATE_CP), 99.9)

    def test_target_allows_a_small_loss_and_is_capped(self):
        self.assertLess(self.ga.target_cp(100), 100)
        self.assertGreater(self.ga.target_cp(100), 0)
        self.assertEqual(self.ga.target_cp(self.ga.MATE_CP), self.ga.MAX_TARGET_CP)

    def test_thresholds(self):
        self.assertIsNone(self.ga.classify(9.9))
        self.assertEqual(self.ga.classify(10), "mistake")
        self.assertEqual(self.ga.classify(15), "blunder")


class FindMistakesTest(unittest.TestCase):
    def setUp(self):
        import game_analysis
        self.ga = game_analysis

    def test_a_hung_queen_is_a_blunder_for_the_side_that_hung_it(self):
        found = self.ga.find_mistakes(QUEEN_HANG, "white", FakeEngine())
        self.assertEqual([m["played_san"] for m in found], ["Qxf7+"])
        mistake = found[0]
        self.assertEqual(mistake["ply"], 4)
        self.assertEqual(mistake["kind"], "blunder")
        self.assertEqual(mistake["source"], "stockfish")
        self.assertEqual(chess.Board(mistake["fen"]).turn, chess.WHITE)
        self.assertGreater(mistake["cp_before"], mistake["cp_after"])
        self.assertLessEqual(mistake["target_cp"], mistake["cp_before"])

    def test_the_opponents_moves_are_not_reported(self):
        self.assertEqual(self.ga.find_mistakes(QUEEN_HANG, "black", FakeEngine()), [])

    def test_the_tablebase_overrules_the_engine(self):
        def table(fen):
            return {"available": True, "outcome": "win", "moves": [
                {"uci": "e3d4", "san": "Kd4", "outcome": "win"},
                {"uci": "e4e5", "san": "e5", "outcome": "draw"},
            ]}
        engine = FakeEngine()
        found = self.ga.find_mistakes(PAWN_ENDING, "white", engine, tablebase=table)
        self.assertEqual(engine.searches, 0)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["source"], "tablebase")
        self.assertEqual(found[0]["best_san"], "Kd4")
        self.assertEqual(found[0]["cp_before"], self.ga.MATE_CP)
        self.assertEqual(found[0]["cp_after"], 0)

    def test_an_unreachable_tablebase_falls_back_to_the_engine(self):
        engine = FakeEngine()
        found = self.ga.find_mistakes(
            PAWN_ENDING, "white", engine, tablebase=lambda fen: {"available": False})
        self.assertEqual(found, [])
        self.assertGreater(engine.searches, 0)

    def test_stopping_returns_none(self):
        self.assertIsNone(self.ga.find_mistakes(
            QUEEN_HANG, "white", FakeEngine(), should_stop=lambda: True))

    def test_a_pgn_without_moves_is_an_error(self):
        with self.assertRaises(ValueError):
            self.ga.find_mistakes("", "white", FakeEngine())


class NoisyEngine(FakeEngine):
    """Sees a mistake everywhere on a short search and none on a long one."""

    def __init__(self):
        super().__init__()
        self.long_searches = 0

    def analyse(self, board, limit):
        info = super().analyse(board, limit)
        if limit.time >= 1:
            self.long_searches += 1
            return info
        # Short search: claim the side to move is far better than it is.
        info["score"] = chess.engine.PovScore(chess.engine.Cp(400), board.turn)
        return info


class VerifyAndTagTest(unittest.TestCase):
    def setUp(self):
        import game_analysis
        self.ga = game_analysis

    def test_a_suspected_mistake_must_survive_the_deeper_search(self):
        quiet = '[Result "*"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 *'
        engine = NoisyEngine()
        found = self.ga.find_mistakes(quiet, "white", engine, seconds=0.3, verify_seconds=1.0)
        self.assertEqual(found, [])
        self.assertGreater(engine.long_searches, 0)

    def test_the_stored_numbers_come_from_the_deeper_search(self):
        engine = NoisyEngine()
        found = self.ga.find_mistakes(QUEEN_HANG, "white", engine, seconds=0.3, verify_seconds=1.0)
        self.assertEqual([m["played_san"] for m in found], ["Qxf7+"])
        self.assertNotEqual(found[0]["cp_before"], 400)

    def test_tags(self):
        hung = self.ga.find_mistakes(QUEEN_HANG, "white", FakeEngine())[0]
        self.assertEqual(hung["tag"], "lost_material")

        board = chess.Board("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1")
        quiet_move = chess.Move.from_uci("h2h3")
        mate_line = [chess.Move.from_uci("d1d8")]
        self.assertEqual(
            self.ga.mistake_tag(board, quiet_move, mate_line, [], self.ga.MATE_CP - 1, 50),
            "missed_mate")

        board = chess.Board("6k1/5ppp/8/3q4/8/8/5PPP/3R2K1 w - - 0 1")
        win_queen = [chess.Move.from_uci("d1d5")]
        self.assertEqual(
            self.ga.mistake_tag(board, quiet_move, win_queen, [], 500, -300), "missed_material")
        self.assertEqual(self.ga.mistake_tag(board, quiet_move, [], [], 50, -80), "quiet")

    def test_phase_and_situation(self):
        self.assertEqual(self.ga.phase_of(chess.STARTING_FEN), "opening")
        self.assertEqual(self.ga.phase_of(
            "r1bq1rk1/pp2bppp/2n1pn2/3p4/3P4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 14"), "middlegame")
        self.assertEqual(self.ga.phase_of("8/5pk1/8/8/8/8/R4PK1/3r4 w - - 0 40"), "rook_endgame")
        self.assertEqual(self.ga.phase_of("8/5pk1/8/8/8/8/5PK1/8 w - - 0 40"), "pawn_endgame")
        self.assertEqual(self.ga.phase_of("8/5pk1/8/3b4/8/2N5/5PK1/8 w - - 0 40"), "minor_endgame")
        self.assertEqual(self.ga.phase_of("8/5pk1/8/3q4/8/2Q5/5PK1/8 w - - 0 40"), "queen_endgame")
        self.assertEqual(self.ga.phase_of("8/5pk1/8/3r4/8/2N5/5PK1/8 w - - 0 40"), "other_endgame")
        self.assertEqual(
            [self.ga.situation_of(cp) for cp in (300, 299, 100, 99, -99, -100)],
            ["winning", "better", "better", "level", "level", "worse"])


class StorageTest(DatabaseCase):
    def test_report_weighs_mistakes_by_what_they_cost(self):
        game_id = self.add_game(QUEEN_HANG)
        base = {"user_color": "white", "played_san": "a3", "played_uci": "a2a3",
                "best_san": "Nf3", "best_uci": "g1f3", "target_cp": 0, "source": "stockfish"}
        self.ga.store_mistakes(game_id, [
            {**base, "ply": 0, "fen": chess.STARTING_FEN, "cp_before": 20, "cp_after": -120,
             "loss": 10.0, "kind": "mistake", "tag": "quiet"},
            {**base, "ply": 80, "fen": "8/5pk1/8/8/8/8/R4PK1/3r4 w - - 0 41", "cp_before": 400,
             "cp_after": 0, "loss": 30.0, "kind": "blunder", "tag": "lost_material"},
        ])
        result = self.ga.list_mistakes()["report"]
        self.assertEqual((result["mistakes"], result["games"]), (2, 1))
        phase, situation, tag = result["sections"]
        self.assertEqual([(r["key"], r["count"], r["share"]) for r in phase["rows"]],
                         [("rook_endgame", 1, 75), ("opening", 1, 25)])
        self.assertEqual(phase["rows"][0]["theme"], "rookEndgame")
        self.assertEqual([r["key"] for r in situation["rows"]], ["winning", "level"])
        self.assertEqual([r["key"] for r in tag["rows"]], ["lost_material", "quiet"])
        self.assertIsNone(tag["rows"][1]["theme"])

    def test_an_empty_report(self):
        result = self.ga.report()
        self.assertEqual(result["mistakes"], 0)
        self.assertEqual([s["rows"] for s in result["sections"]], [[], [], []])


    def test_reanalysis_keeps_the_practice_record(self):
        game_id = self.add_game(QUEEN_HANG)
        found = self.ga.find_mistakes(QUEEN_HANG, "white", FakeEngine())
        self.ga.store_mistakes(game_id, found)
        mistake_id = self.ga.mistakes_for_game(game_id)[0]["id"]
        self.assertEqual(self.ga.record_attempt(mistake_id, True)["last_result"], "solved")

        self.ga.store_mistakes(game_id, found)
        again = self.ga.mistakes_for_game(game_id)
        self.assertEqual([m["id"] for m in again], [mistake_id])
        self.assertEqual(again[0]["progress"]["solved"], 1)

        self.ga.store_mistakes(game_id, [])
        self.assertEqual(self.ga.mistakes_for_game(game_id), [])

    def test_unknown_mistake(self):
        self.assertIsNone(self.ga.record_attempt(999, True))

    def test_pending_games_are_newest_first_and_skip_analysed_ones(self):
        old = self.add_game(QUEEN_HANG, end_time="2026-01-01T00:00:00")
        new = self.add_game(QUEEN_HANG, end_time="2026-06-01T00:00:00")
        self.add_game(QUEEN_HANG, user_color=None)
        self.assertEqual([g["id"] for g in self.ga.pending_games(limit=5)], [new, old])
        self.ga.store_mistakes(new, [])
        self.assertEqual([g["id"] for g in self.ga.pending_games(limit=5)], [old])

    def test_analyzer_runs_through_the_pending_games(self):
        first = self.add_game(QUEEN_HANG, end_time="2026-06-01T00:00:00")
        self.add_game("", end_time="2026-05-01T00:00:00")  # unreadable
        engine = FakeEngine()
        analyzer = self.ga.GameAnalyzer(engine_factory=lambda: engine)
        started = analyzer.start(count=4)
        self.assertTrue(started["running"])
        self.assertEqual(started["total"], 2)
        analyzer.join(10)
        status = analyzer.status()
        self.assertFalse(status["running"])
        self.assertIsNone(status["error"])
        self.assertEqual((status["done"], status["mistakes"]), (2, 1))
        self.assertTrue(engine.closed)

        listing = self.ga.list_mistakes()
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["games_analysed"], 2)
        self.assertEqual(listing["games"][0]["id"], first)
        self.assertFalse(analyzer.start(count=4)["running"])  # nothing left

    def test_a_request_made_during_a_run_is_served_after_it(self):
        import threading
        first = self.add_game(QUEEN_HANG, end_time="2026-06-01T00:00:00")
        gate = threading.Event()

        class SlowEngine(FakeEngine):
            def analyse(self, board, limit):
                gate.wait(5)
                return super().analyse(board, limit)

        analyzer = self.ga.GameAnalyzer(engine_factory=SlowEngine)
        self.assertEqual(analyzer.start(count=1)["total"], 1)
        # A sync brings in another game while the first is being analysed.
        second = self.add_game(QUEEN_HANG, end_time="2026-07-01T00:00:00")
        self.assertTrue(analyzer.start(count=1)["running"])           # ignored
        self.assertTrue(analyzer.start(count=1, queue=True)["running"])  # kept
        gate.set()
        analyzer.join(10)
        status = analyzer.status()
        self.assertEqual((status["running"], status["done"], status["total"]), (False, 2, 2))
        self.assertEqual(self.ga.pending_games(limit=5), [])
        self.assertEqual(len(self.ga.mistakes_for_game(first)), 1)
        self.assertEqual(len(self.ga.mistakes_for_game(second)), 1)


class ApiTest(DatabaseCase):
    def setUp(self):
        super().setUp()
        import main
        self.main = importlib.reload(main)

    def test_mistakes_endpoints(self):
        game_id = self.add_game(QUEEN_HANG)
        self.ga = sys.modules["game_analysis"]
        self.ga.store_mistakes(
            game_id, self.ga.find_mistakes(QUEEN_HANG, "white", FakeEngine()))
        with TestClient(self.main.app) as client:
            listing = client.get("/api/mistakes").json()
            self.assertEqual(listing["total"], 1)
            mistake = listing["games"][0]["mistakes"][0]
            self.assertEqual(mistake["played_san"], "Qxf7+")

            game = client.get(f"/api/games/{game_id}").json()
            self.assertEqual([m["ply"] for m in game["mistakes"]], [4])

            done = client.post(f"/api/mistakes/{mistake['id']}/attempts", json={"solved": False})
            self.assertEqual(done.json()["last_result"], "failed")
            self.assertEqual(
                client.post("/api/mistakes/999/attempts", json={"solved": True}).status_code, 404)
            self.assertFalse(client.get("/api/analysis").json()["running"])


if __name__ == "__main__":
    unittest.main()


class AutoAnalysisTest(DatabaseCase):
    def setUp(self):
        super().setUp()
        import main
        self.main = importlib.reload(main)
        self.ga = sys.modules["game_analysis"]

    def test_a_sync_with_new_games_starts_a_capped_analysis(self):
        from unittest.mock import patch
        with TestClient(self.main.app) as client:
            analyzer = client.app.state.game_analyzer
            follow_up = client.app.state.sync_service._on_imported
            with patch.object(analyzer, "start") as start:
                follow_up(3, 250)
                self.assertEqual(start.call_args.kwargs["account_id"], 3)
                self.assertEqual(start.call_args.kwargs["count"], self.main.AUTO_ANALYSE_MAX_GAMES)
                follow_up(3, 2)
                self.assertEqual(start.call_args.kwargs["count"], 2)
                with patch.dict(os.environ, {"OPENINGS_AUTO_ANALYSE": "0"}):
                    follow_up(3, 2)
                self.assertEqual(start.call_count, 2)
