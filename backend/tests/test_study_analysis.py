"""New games, deeply analysed, sent to a Lichess study (study_analysis.py)."""
import importlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import chess
import chess.engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# White hangs the queen on move 3, Black takes it, then a few quiet moves.
QUEEN_HANG = ('[Event "x"]\n[White "me"]\n[Black "them"]\n[Result "0-1"]\n\n'
              '1. e4 e5 2. Qh5 Nc6 3. Qxf7+ Kxf7 4. Nf3 Nf6 5. Nc3 Bc5 6. d3 d6 0-1')
FOOLS_MATE = '[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1'


def material(board):
    values = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 300, chess.ROOK: 500, chess.QUEEN: 900}
    return sum(v * (len(board.pieces(t, chess.WHITE)) - len(board.pieces(t, chess.BLACK)))
               for t, v in values.items())


class FakeAnalysis:
    """engine.analysis(): infos one depth at a time until stopped."""

    def __init__(self, board, depths, delay=0.0, cp=None):
        self.board = board
        self.depths = depths
        self.delay = delay
        self.stopped = threading.Event()
        moves = list(board.legal_moves)
        self.best = next((m for m in moves if board.is_capture(m)), moves[0])
        after = board.copy()
        after.push(self.best)
        self.cp = material(after) if cp is None else cp

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()

    def stop(self):
        self.stopped.set()

    def __iter__(self):
        for depth in range(1, self.depths + 1):
            if self.stopped.is_set():
                return
            if self.delay:
                self.stopped.wait(self.delay)
                if self.stopped.is_set():
                    return
            yield {"depth": depth, "nodes": depth * 1000, "pv": [self.best],
                   "score": chess.engine.PovScore(chess.engine.Cp(self.cp), chess.WHITE)}


class FakeEngine:
    def __init__(self, depths=40, delay=0.0):
        self.depths = depths
        self.delay = delay
        self.searched = []
        self.id = {"name": "Stockfish Test"}
        self.closed = False
        self.current = None

    def analysis(self, board, limit):
        self.searched.append(board.fen())
        self.current = FakeAnalysis(board, self.depths, self.delay)
        return self.current

    def quit(self):
        self.closed = True


class Response:
    def __init__(self, status, data=None):
        self.status_code = status
        self._data = data or {}
        self.text = json.dumps(self._data)

    def json(self):
        return self._data


class NoCloud:
    def __init__(self):
        self.asked = 0

    def get(self, url, **kwargs):
        self.asked += 1
        return Response(404)


class DatabaseCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "study.db")
        import database
        import study_analysis
        self.db = importlib.reload(database)
        self.db.init_db()
        self.sa = importlib.reload(study_analysis)
        self.sa.MIN_DEPTH = 5
        self.sa.TARGET_SECONDS = 0
        self.sa.HARD_SECONDS = 5

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def add_game(self, pgn=QUEEN_HANG, end_time="2026-11-25T10:00:00+00:00", color="white"):
        accounts = self.db.list_accounts()
        account = accounts[0] if accounts else self.db.create_account("lichess", "me")
        conn = self.db.get_db()
        with conn:
            n = conn.execute("SELECT COUNT(*) FROM games").fetchone()[0]
            cur = conn.execute(
                "INSERT INTO games (account_id, source, external_id, white, black, pgn, user_color, end_time) "
                "VALUES (?, 'lichess', ?, 'me', 'them', ?, ?, ?)",
                (account["id"], f"g{n}", pgn, color, end_time))
        conn.close()
        return cur.lastrowid

    def state(self, game_id):
        conn = self.db.get_db()
        row = conn.execute("SELECT * FROM study_games WHERE game_id = ?", (game_id,)).fetchone()
        conn.close()
        return dict(row) if row else None


class JudgmentTest(DatabaseCase):
    """Lichess's own thresholds (modules/tree/src/main/Advice.scala)."""

    def test_winning_chance_loss_thresholds_for_white(self):
        j = self.sa.judgment
        self.assertIsNone(j({"cp": 0}, {"cp": -50}, True))
        self.assertEqual(j({"cp": 0}, {"cp": -60}, True), "Inaccuracy")   # 0.11
        self.assertEqual(j({"cp": 0}, {"cp": -120}, True), "Mistake")     # 0.22
        self.assertEqual(j({"cp": 0}, {"cp": -170}, True), "Blunder")     # 0.31

    def test_black_loses_when_the_score_rises(self):
        self.assertEqual(self.sa.judgment({"cp": 0}, {"cp": 170}, False), "Blunder")
        self.assertIsNone(self.sa.judgment({"cp": 0}, {"cp": -170}, False))

    def test_already_lost_positions_lose_little(self):
        # -900 to -1500 barely changes the winning chances.
        self.assertIsNone(self.sa.judgment({"cp": -900}, {"cp": -1500}, True))

    def test_mate_created_and_lost(self):
        j = self.sa.judgment
        self.assertEqual(j({"cp": 0}, {"mate": -3}, True), "Blunder")
        self.assertEqual(j({"cp": -800}, {"mate": -3}, True), "Mistake")
        self.assertEqual(j({"cp": -1200}, {"mate": -3}, True), "Inaccuracy")
        self.assertEqual(j({"mate": 2}, {"cp": 300}, True), "Blunder")
        self.assertEqual(j({"mate": 2}, {"cp": 1200}, True), "Inaccuracy")
        self.assertEqual(j({"mate": -2}, {"cp": -300}, False), "Blunder")  # Black had mate
        self.assertIsNone(j({"mate": 3}, {"mate": 5}, True))  # slower mate: not judged

    def test_giving_checkmate_is_never_judged(self):
        self.assertIsNone(self.sa.judgment({"mate": 1}, {"mate": 0}, True))


class DocumentTest(DatabaseCase):
    def scores_for(self, pgn):
        boards, moves = self.sa.read_game(pgn)
        engine = FakeEngine()
        search = self.sa.DeepSearch(engine)
        scores = self.sa.evaluate_game(boards, search.search)
        return boards, moves, scores, engine

    def test_only_judged_moves_get_a_line(self):
        boards, moves, scores, _ = self.scores_for(QUEEN_HANG)
        doc = self.sa.build_document(boards, moves, scores, "study123", "chap1234", "me", "SF")
        self.assertEqual(doc["id"], "chap1234")
        self.assertEqual(doc["studyId"], "study123")
        self.assertEqual(doc["startPly"], 0)
        self.assertEqual([i["ply"] for i in doc["infos"]], list(range(1, len(moves) + 1)))
        with_line = [i for i in doc["infos"] if i["variation"]]
        judged = [i + 1 for i, move in enumerate(moves)
                  if scores[i]["pv"][0] != move.uci()
                  and self.sa.judgment(scores[i], scores[i + 1], boards[i].turn == chess.WHITE)]
        self.assertEqual([i["ply"] for i in with_line], judged)
        # 3. Qxf7+?? (ply 5) loses the queen; 1. e4 (ply 1) is not judged.
        self.assertIn(5, judged)
        self.assertNotIn(1, judged)
        self.assertTrue(all("best" not in i["eval"] for i in doc["infos"] if not i["variation"]))
        self.assertLessEqual(len(with_line[0]["variation"]), 12)
        self.assertEqual(doc["engine"], {"nodesPerMove": 5000, "id": "external", "userId": "me",
                                         "engineVersion": "SF"})

    def test_nodes_per_move_counts_only_your_engine_and_fits_lichess(self):
        # Lichess refused a real publish: "/nodesPerMove error.expected.int".
        # The cloud's node counts (billions at depth 60-75) were averaged in.
        boards, moves, scores, _ = self.scores_for(QUEEN_HANG)
        scores[0] = {**scores[0], "source": "cloud", "nodes": 90_000_000_000}
        doc = self.sa.build_document(boards, moves, scores, "s", "c", "me", "SF")
        engine_nodes = [s["nodes"] for s in scores if s.get("source") == "stockfish"]
        self.assertEqual(doc["engine"]["nodesPerMove"], round(sum(engine_nodes) / len(engine_nodes)))
        scores = [{**s, "source": "stockfish", "nodes": 5_000_000_000} for s in scores]
        doc = self.sa.build_document(boards, moves, scores, "s", "c", "me", "SF")
        self.assertLessEqual(doc["engine"]["nodesPerMove"], 2**31 - 1)

    def test_scores_are_from_whites_side(self):
        boards, moves, scores, _ = self.scores_for(QUEEN_HANG)
        doc = self.sa.build_document(boards, moves, scores, "s", "c", "me", "SF")
        # After 3...Kxf7 Black is a queen up: negative for White.
        self.assertLess(doc["infos"][5]["eval"]["cp"], -500)

    def test_checkmate_is_mate_zero_and_not_searched(self):
        boards, moves, scores, engine = self.scores_for(FOOLS_MATE)
        doc = self.sa.build_document(boards, moves, scores, "s", "c", "me", "SF")
        self.assertEqual(doc["infos"][-1]["eval"], {"mate": 0, "mateGiven": False})
        self.assertNotIn(boards[-1].fen(), engine.searched)

    def test_a_game_from_a_position_starts_at_its_ply(self):
        pgn = ('[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 30"]\n[SetUp "1"]\n\n'
               '30... Kd7 31. Kd2 Kd6 32. Kd3 Kd5 33. e4+ Ke5 34. Ke3 Ke6 35. Kf4 Kf6 *')
        boards, moves, scores, _ = self.scores_for(pgn)
        doc = self.sa.build_document(boards, moves, scores, "s", "c", "me", "SF")
        self.assertEqual(doc["startPly"], 59)
        self.assertEqual(doc["infos"][0]["ply"], 60)

    def test_variants_are_refused(self):
        with self.assertRaises(self.sa.StudyError):
            self.sa.read_game('[Variant "Chess960"]\n[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1"]\n\n1. e4 *')


class PositionTest(DatabaseCase):
    def test_cloud_until_two_misses_then_engine_only(self):
        boards, _ = self.sa.read_game(QUEEN_HANG)
        asked = []

        def cloud(fen):
            asked.append(fen)
            if len(asked) <= 3:
                return {"cp": 20, "pv": ["e2e4"], "depth": 40, "nodes": 0, "source": "cloud"}
            return None

        engine = FakeEngine()
        scores = self.sa.evaluate_game(boards, self.sa.DeepSearch(engine).search, cloud=cloud)
        self.assertEqual(len(asked), 5)  # 3 hits, then 2 misses
        self.assertEqual([s["source"] for s in scores[:3]], ["cloud"] * 3)
        self.assertEqual(len(engine.searched), len(boards) - 3)

    def test_a_refusing_cloud_is_not_asked_again(self):
        boards, _ = self.sa.read_game(QUEEN_HANG)
        asked = []

        def cloud(fen):
            asked.append(fen)
            raise self.sa.StudyError("cloud: HTTP 429")

        self.sa.evaluate_game(boards, self.sa.DeepSearch(FakeEngine()).search, cloud=cloud)
        self.assertEqual(len(asked), 1)

    def test_shallow_cloud_entries_are_ignored(self):
        class Cloud:
            def get(self, url, **kwargs):
                return Response(200, {"depth": 3, "knodes": 10, "pvs": [{"cp": 10, "moves": "e2e4"}]})
        self.assertIsNone(self.sa.cloud_eval(chess.STARTING_FEN, Cloud()))

    def test_cloud_scores_and_mates(self):
        class Cloud:
            def get(self, url, **kwargs):
                return Response(200, {"depth": 50, "knodes": 7, "pvs": [{"mate": -4, "moves": "e2e4 e7e5"}]})
        got = self.sa.cloud_eval(chess.STARTING_FEN, Cloud())
        self.assertEqual((got["mate"], got["pv"], got["nodes"]), (-4, ["e2e4", "e7e5"], 7000))

    def test_the_tablebase_decides_without_stockfish(self):
        # 1. e5?? throws the win away (the verdicts are invented for the test).
        boards, moves = self.sa.read_game(
            '[FEN "8/8/4k3/8/4P3/4K3/8/8 w - - 0 1"]\n[SetUp "1"]\n\n1. e5 Kd5 2. Kf4 Kd4 *')

        def table(fen):
            board = chess.Board(fen)
            best = "e3d3" if fen == boards[0].fen() else next(iter(board.legal_moves)).uci()
            return {"available": True, "outcome": "win" if fen == boards[0].fen() else "draw",
                    "moves": [{"uci": best}]}

        engine = FakeEngine()
        scores = self.sa.evaluate_game(boards, self.sa.DeepSearch(engine).search, tablebase=table)
        self.assertEqual(engine.searched, [])
        self.assertEqual(scores[0], {"cp": 1000, "pv": ["e3d3"], "source": "tablebase"})
        self.assertTrue(all(s["cp"] == 0 for s in scores[1:]))
        doc = self.sa.build_document(boards, moves, scores, "s", "c", "me", "SF", tablebase=table)
        first = doc["infos"][0]
        self.assertEqual(first["eval"]["best"], "e3d3")
        # The line is the tablebase's best play, not just its first move.
        self.assertEqual(len(first["variation"]), 12)
        self.assertEqual(first["variation"][0], "Kd3")

    def test_tablebase_mate_distances(self):
        white_to_move = chess.Board("8/8/8/4k3/8/8/8/3QK3 w - - 0 1")
        black_to_move = chess.Board("8/8/8/4k3/8/8/8/3QK3 b - - 0 1")
        win = lambda fen: {"available": True, "outcome": "win", "dtm": 13, "moves": [{"uci": "d1d7"}]}
        loss = lambda fen: {"available": True, "outcome": "loss", "dtm": -16, "moves": [{"uci": "e5e4"}]}
        self.assertEqual(self.sa.tablebase_score(white_to_move, win)["mate"], 7)
        self.assertEqual(self.sa.tablebase_score(black_to_move, loss)["mate"], 8)  # White mates
        no_dtm = lambda fen: {"available": True, "outcome": "loss", "moves": []}
        self.assertEqual(self.sa.tablebase_score(black_to_move, no_dtm)["cp"], 1000)
        # A mate just before stays a mate, so Lichess does not call it a lost mate.
        self.assertEqual(self.sa.tablebase_score(black_to_move, no_dtm, {"mate": 9})["mate"], 9)
        self.assertEqual(self.sa.tablebase_score(black_to_move, no_dtm, {"mate": -9})["cp"], 1000)

    def test_no_tablebase_answer_means_stockfish(self):
        board = chess.Board("8/8/8/4k3/8/8/8/3QK3 w - - 0 1")
        self.assertIsNone(self.sa.tablebase_score(board, lambda fen: {"available": False}))
        self.assertIsNone(self.sa.tablebase_score(chess.Board(), lambda fen: {"available": True}))
        self.assertIsNone(self.sa.tablebase_score(board, None))

    def test_resumes_after_the_positions_already_done(self):
        boards, _ = self.sa.read_game(QUEEN_HANG)
        engine = FakeEngine()
        done = [{"cp": 1}] * 4
        scores = self.sa.evaluate_game(boards, self.sa.DeepSearch(engine).search, done=done)
        self.assertEqual(scores[:4], done)
        self.assertEqual(len(engine.searched), len(boards) - 4)


class DefaultsTest(unittest.TestCase):
    def test_the_settings_you_asked_for(self):
        import study_analysis
        saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("OPENINGS_STUDY_")}
        try:
            sa = importlib.reload(study_analysis)
            self.assertEqual((sa.THREADS, sa.HASH_MB, sa.MIN_DEPTH, sa.TARGET_SECONDS),
                             (3, 256, 32, 12))
            self.assertNotIn("setpriority", Path(sa.__file__).read_text())  # normal priority
        finally:
            os.environ.update(saved)


class DeepSearchTest(DatabaseCase):
    def test_goes_past_min_depth_until_the_time_is_up(self):
        self.sa.MIN_DEPTH = 3
        self.sa.TARGET_SECONDS = 0.15
        engine = FakeEngine(depths=1000, delay=0.01)
        got = self.sa.DeepSearch(engine).search(chess.Board())
        self.assertGreater(got["depth"], 3)

    def test_stops_at_min_depth_once_time_is_up(self):
        engine = FakeEngine(depths=50)
        got = self.sa.DeepSearch(engine).search(chess.Board())
        self.assertEqual(got["depth"], 5)

    def test_an_interrupt_stops_the_search(self):
        self.sa.TARGET_SECONDS = 10
        engine = FakeEngine(depths=10_000, delay=0.01)
        search = self.sa.DeepSearch(engine)
        threading.Timer(0.1, search.interrupt).start()
        started = time.monotonic()
        with self.assertRaises(self.sa.Interrupted):
            search.search(chess.Board())
        self.assertLess(time.monotonic() - started, 2)


class FakeStudies:
    def __init__(self):
        self.imported = []

    def user_id(self):
        return "me"

    def import_game(self, pgn, orientation):
        self.imported.append(orientation)
        return "study123", f"chap{len(self.imported):04d}"


class QueueTest(DatabaseCase):
    def analyzer(self, engine=None):
        engine = engine or FakeEngine()
        a = self.sa.StudyAnalyzer(NoCloud(), engine_factory=lambda: engine)
        a._studies = FakeStudies()
        self.db.set_setting(self.sa.USER_KEY, "me")
        return a, engine

    def wait_for(self, predicate, seconds=5):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def test_only_games_after_switching_on_are_queued(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        old = self.add_game(end_time="2026-11-20T10:00:00+00:00")
        new = self.add_game(end_time="2026-11-25T10:00:00+00:00")
        self.assertEqual(self.sa.queue_new_games(), 1)
        self.assertIsNone(self.state(old))
        self.assertEqual(self.state(new)["state"], "queued")
        self.assertEqual(self.sa.queue_new_games(), 0)  # once only

    def test_nothing_is_queued_while_switched_off(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        self.sa.set_enabled(False)
        self.add_game()
        self.assertEqual(self.sa.queue_new_games(), 0)

    def test_first_run_starts_from_now(self):
        self.add_game(end_time="2026-11-20T10:00:00+00:00")
        self.assertEqual(self.sa.queue_new_games(), 0)
        self.assertTrue(self.db.get_setting(self.sa.SINCE_KEY))

    def test_a_game_goes_from_queued_to_ready_to_published(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()
        a, engine = self.analyzer()
        a.start()
        a.hold(False)
        try:
            self.assertTrue(self.wait_for(lambda: (self.state(game) or {}).get("state") == "ready"))
        finally:
            a.shutdown()
        row = self.state(game)
        self.assertEqual((row["study_id"], row["chapter_id"]), ("study123", "chap0001"))
        ready = self.sa.ready_to_publish()
        self.assertEqual(ready[0]["game_id"], game)
        self.assertEqual(ready[0]["user_id"], "me")
        self.assertEqual(ready[0]["document"]["id"], "chap0001")
        self.assertTrue(self.sa.mark_published(game))
        self.assertEqual(self.state(game)["state"], "published")
        self.assertEqual(self.sa.ready_to_publish(), [])
        self.assertTrue(engine.closed)

    def test_nothing_runs_while_held(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()
        a, engine = self.analyzer()
        a.start()  # starts held, like the app (fail-closed)
        a.wake()
        try:
            time.sleep(0.3)
            self.assertEqual(self.state(game) and self.state(game)["state"], None)
            self.assertEqual(engine.searched, [])
        finally:
            a.shutdown()

    def test_a_game_starting_stops_the_search_and_keeps_the_positions_done(self):
        self.sa.TARGET_SECONDS = 0.05
        self.sa.MIN_DEPTH = 1
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()
        engine = FakeEngine(depths=10_000, delay=0.01)
        a, _ = self.analyzer(engine)
        a.start()
        a.hold(False)
        try:
            self.assertTrue(self.wait_for(lambda: len(engine.searched) >= 3))
            a.hold(True)
            time.sleep(0.2)
            searched = len(engine.searched)
            self.assertTrue(engine.current.stopped.is_set())
            time.sleep(0.3)
            self.assertEqual(len(engine.searched), searched)  # quiet while held
            kept = json.loads(self.state(game)["scores"])
            self.assertGreaterEqual(len(kept), 2)
            a.hold(False)
            self.assertTrue(self.wait_for(lambda: self.state(game)["state"] == "ready"))
        finally:
            a.shutdown()
        boards, _ = self.sa.read_game(QUEEN_HANG)
        # The interrupted position was searched again; none of the finished ones.
        self.assertEqual(len(engine.searched), len(boards) + 1)

    def test_a_crashing_engine_counts_against_the_game_not_the_worker(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()

        class Crashing(FakeEngine):
            def analysis(self, board, limit):
                raise chess.engine.EngineTerminatedError("engine process died")
        a, _ = self.analyzer(Crashing())
        a.start()
        a.hold(False)
        try:
            self.assertTrue(self.wait_for(lambda: (self.state(game) or {}).get("attempts") == 1))
            self.assertTrue(a._thread.is_alive())
        finally:
            a.shutdown()
        self.assertIn("died", self.state(game)["error"])

    def test_stockfish_stops_when_there_is_nothing_left(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()
        a, engine = self.analyzer()
        a.start()
        a.hold(False)
        try:
            self.assertTrue(self.wait_for(lambda: (self.state(game) or {}).get("state") == "ready"))
            self.assertTrue(self.wait_for(lambda: engine.closed))
            self.assertTrue(a._thread.is_alive())
        finally:
            a.shutdown()

    def test_short_games_are_skipped(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game(pgn=FOOLS_MATE)
        a, _ = self.analyzer()
        a.start()
        a.hold(False)
        try:
            self.assertTrue(self.wait_for(lambda: (self.state(game) or {}).get("state") == "skipped"))
        finally:
            a.shutdown()

    def test_import_errors_are_retried_later(self):
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()
        a, _ = self.analyzer()

        class Down(FakeStudies):
            def import_game(self, pgn, orientation):
                raise study_error("Lichess could not be reached")
        study_error = self.sa.StudyError
        a._studies = Down()
        a.start()
        a.hold(False)
        try:
            self.assertTrue(self.wait_for(lambda: (self.state(game) or {}).get("attempts") == 1))
        finally:
            a.shutdown()
        row = self.state(game)
        self.assertEqual(row["state"], "queued")
        self.assertIn("reached", row["error"])
        self.assertIsNotNone(row["retry_at"])
        self.assertIsNone(self.sa.next_game())  # not before retry_at

    def test_publish_failures(self):
        game = self.add_game()
        self.sa.queue_game(game)
        self.sa._update(game, state="ready", document={"engine": {"userId": "me"}})
        self.assertTrue(self.sa.publish_failed(game, 423, "server analysis running"))
        self.assertEqual(self.state(game)["state"], "ready")
        self.assertEqual(self.sa.ready_to_publish(), [])  # waits before trying again
        self.assertTrue(self.sa.publish_failed(game, 403, "not a contributor"))
        self.assertEqual(self.state(game)["state"], "failed")
        self.assertFalse(self.sa.publish_failed(game, 403, "again"))

    def test_trying_again_keeps_the_chapter_and_the_positions_done(self):
        # A retry must not add the game to the study a second time.
        game = self.add_game()
        self.sa.queue_game(game)
        self.sa._update(game, state="failed", error="400", study_id="s", chapter_id="c",
                        scores=[{"cp": 1}], document={"x": 1})
        self.assertTrue(self.sa.queue_game(game))
        row = self.state(game)
        self.assertEqual((row["state"], row["study_id"], row["chapter_id"], row["document"]),
                         ("imported", "s", "c", None))
        self.assertEqual(json.loads(row["scores"]), [{"cp": 1}])

    def test_a_deleted_chapter_is_added_again_on_retry(self):
        game = self.add_game()
        self.sa.queue_game(game)
        self.sa._update(game, state="ready", study_id="s", chapter_id="c",
                        document={"engine": {"userId": "me"}})
        self.sa.publish_failed(game, 404, "chapter not found")
        self.assertIsNone(self.state(game)["chapter_id"])
        self.sa.queue_game(game)
        self.assertEqual(self.state(game)["state"], "queued")

    def test_queue_game_starts_over(self):
        game = self.add_game()
        self.sa.queue_game(game)
        self.sa._update(game, state="failed", error="x")  # failed before it had a chapter
        self.assertTrue(self.sa.queue_game(game))
        row = self.state(game)
        self.assertEqual((row["state"], row["error"], row["chapter_id"]), ("queued", "", None))
        self.assertFalse(self.sa.queue_game(999))


class LichessStudiesTest(DatabaseCase):
    class Http:
        def __init__(self, answers):
            self.answers = answers
            self.calls = []

        def request(self, method, url, **kwargs):
            self.calls.append((method, url, kwargs.get("data")))
            return self.answers.pop(0)

    STUDY_PGN = (
        '[Event "My games: Chapter 1"]\n[ChapterURL "https://lichess.org/study/newstudy/emptyCH"]\n\n*\n\n'
        '[Event "My games: me - them"]\n[ChapterURL "https://lichess.org/study/newstudy/chapAAAA"]\n\n1. e4 *\n')

    def test_creates_the_study_then_imports_and_drops_its_empty_chapter(self):
        self.db.set_setting("lichess_token", "lip_x")
        pgn = Response(200)
        pgn.text = self.STUDY_PGN
        http = self.Http([Response(200, {"id": "newstudy"}),
                          Response(200, {"chapters": [{"id": "chapAAAA"}]}),
                          pgn, Response(204)])
        got = self.sa.LichessStudies(http).import_game("1. e4 *", "black")
        self.assertEqual(http.calls[2][:2], ("GET", "https://lichess.org/api/study/newstudy.pgn"))
        self.assertEqual(http.calls[3][:2], ("DELETE", "https://lichess.org/api/study/newstudy/emptyCH"))
        self.assertEqual(len(http.calls), 4)  # the game's own chapter is kept
        self.assertEqual(got, ("newstudy", "chapAAAA"))
        self.assertEqual(http.calls[0][1], "https://lichess.org/api/study")
        self.assertEqual(http.calls[0][2]["visibility"], "private")
        self.assertEqual(http.calls[1][2]["orientation"], "black")
        self.assertEqual(self.db.get_setting(self.sa.STUDY_KEY), "newstudy")

    def test_a_full_study_is_replaced(self):
        self.db.set_setting("lichess_token", "lip_x")
        self.db.set_setting(self.sa.STUDY_KEY, "fullstud")
        http = self.Http([Response(200, {"chapters": [], "error": "too many chapters"}),
                          Response(200, {"id": "second12"}),
                          Response(200, {"chapters": [{"id": "chapBBBB"}]}),
                          Response(500)])
        self.assertEqual(self.sa.LichessStudies(http).import_game("1. e4 *", "white"),
                         ("second12", "chapBBBB"))
        self.assertEqual(http.calls[1][2]["name"], "My games 2")

    def test_an_existing_study_is_never_tidied(self):
        self.db.set_setting("lichess_token", "lip_x")
        self.db.set_setting(self.sa.STUDY_KEY, "mystudy1")
        http = self.Http([Response(200, {"chapters": [{"id": "chapCCCC"}]})])
        self.sa.LichessStudies(http).import_game("1. e4 *", "white")
        self.assertEqual(len(http.calls), 1)

    def test_no_token_or_no_study_scope(self):
        with self.assertRaisesRegex(self.sa.StudyError, "token"):
            self.sa.LichessStudies(self.Http([])).import_game("1. e4 *", "white")
        self.db.set_setting("lichess_token", "lip_x")
        with self.assertRaisesRegex(self.sa.StudyError, "study access"):
            self.sa.LichessStudies(self.Http([Response(403)])).import_game("1. e4 *", "white")


if __name__ == "__main__":
    unittest.main()


class ApiTest(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "api.db")
        self.old_network = os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK")
        os.environ["OPENINGS_DISABLE_EXTERNAL_NETWORK"] = "1"
        import database
        import study_analysis
        import main
        self.db = importlib.reload(database)
        self.sa = importlib.reload(study_analysis)
        self.main = importlib.reload(main)
        self.context = TestClient(self.main.app)
        self.client = self.context.__enter__()

    def tearDown(self):
        self.context.__exit__(None, None, None)
        for key, old in (("CHESS_DB_PATH", self.old_db_path),
                         ("OPENINGS_DISABLE_EXTERNAL_NETWORK", self.old_network)):
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        self.temp_dir.cleanup()

    def test_status_and_switching_off(self):
        res = self.client.get("/api/study-analysis")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["enabled"])
        self.assertTrue(res.json()["now"]["held"])  # fail-closed until the extension says
        res = self.client.put("/api/study-analysis", json={"enabled": False})
        self.assertFalse(res.json()["enabled"])
        self.assertEqual(self.client.post("/api/study-analysis/game-ended").json(), {"queued": 0})

    def test_the_live_game_lock_holds_it(self):
        self.client.put("/api/lichess-engine/paused", json={"paused": False})
        self.assertFalse(self.client.get("/api/study-analysis").json()["now"]["held"])
        self.client.put("/api/lichess-engine/paused", json={"paused": True})
        self.assertTrue(self.client.get("/api/study-analysis").json()["now"]["held"])

    def test_publishing_endpoints(self):
        self.assertEqual(self.client.post("/api/study-analysis/games/5").status_code, 404)
        self.assertEqual(self.client.get("/api/study-analysis/ready").json(), [])
        self.assertEqual(self.client.post("/api/study-analysis/5/published").status_code, 404)
        res = self.client.post("/api/study-analysis/5/publish-failed", json={"status": 423})
        self.assertEqual(res.status_code, 404)
        account = self.db.create_account("lichess", "me")
        conn = self.db.get_db()
        with conn:
            game = conn.execute(
                "INSERT INTO games (account_id, source, external_id, pgn, user_color, end_time) "
                "VALUES (?, 'lichess', 'abcdefgh', ?, 'white', '2026-11-25T10:00:00+00:00')",
                (account["id"], QUEEN_HANG)).lastrowid
        conn.close()
        self.assertEqual(self.client.post(f"/api/study-analysis/games/{game}").status_code, 202)
        self.sa._update(game, state="ready", study_id="s", chapter_id="c",
                        document={"id": "c", "engine": {"userId": "me"}})
        ready = self.client.get("/api/study-analysis/ready").json()
        self.assertEqual([r["game_id"] for r in ready], [game])
        self.assertEqual(self.client.post(f"/api/study-analysis/{game}/published").status_code, 200)
        listed = self.client.get("/api/study-analysis").json()
        self.assertEqual(listed["counts"], {"published": 1})
        self.assertEqual(listed["games"][0]["state"], "published")


class SharedSearchTest(unittest.TestCase):
    """SharedSearch borrows the engine bar's Stockfish (provider.deep_search)
    from the analysis thread."""

    class Provider:
        def __init__(self, answers):
            self.answers = list(answers)
            self.asked = 0
            self.stopped = 0

        async def deep_search(self, fen, min_depth, target, hard, on_depth=None):
            self.asked += 1
            if on_depth:
                on_depth(7)
            return self.answers.pop(0) if self.answers else {"status": "busy"}

        async def stop_background(self):
            self.stopped += 1

        def engine_name(self):
            return "Stockfish 19"

    def setUp(self):
        import study_analysis
        self.sa = importlib.reload(study_analysis)
        self.loop = __import__("asyncio").new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(2)
        self.loop.close()

    def test_waits_while_lichess_uses_the_engine_then_searches(self):
        provider = self.Provider([{"status": "busy"}, {"status": "stopped"},
                                  {"cp": 20, "depth": 33, "pv": ["e2e4"], "nodes": 5}])
        search = self.sa.SharedSearch(provider, self.loop)
        search.RETRY_SECONDS = 0.01
        depths = []
        got = search.search(chess.Board(), on_depth=depths.append)
        self.assertEqual(got, {"cp": 20, "depth": 33, "pv": ["e2e4"], "nodes": 5, "source": "stockfish"})
        self.assertEqual(provider.asked, 3)
        self.assertEqual(depths, [7, 7, 7])
        self.assertEqual(search.name, "Stockfish 19")

    def test_an_interrupt_ends_the_wait_and_stops_the_search(self):
        provider = self.Provider([])  # always busy
        search = self.sa.SharedSearch(provider, self.loop)
        threading.Timer(0.2, search.interrupt).start()
        started = time.monotonic()
        with self.assertRaises(self.sa.Interrupted):
            search.search(chess.Board())
        self.assertLess(time.monotonic() - started, 3)
        time.sleep(0.1)
        self.assertEqual(provider.stopped, 1)


class SavedEvalTest(DatabaseCase):
    def test_the_store_keeps_only_deeper_results(self):
        import evaluation_repository
        store = importlib.reload(evaluation_repository).DeepEvalStore()
        key = "k"
        self.assertTrue(store.put(key, {"cp": 10, "depth": 30, "pv": ["e2e4"], "nodes": 1}))
        self.assertFalse(store.put(key, {"cp": 99, "depth": 25, "pv": ["d2d4"], "nodes": 1}))
        self.assertTrue(store.put(key, {"mate": -3, "depth": 40, "pv": ["d2d4", "e7e5"], "nodes": 9}))
        self.assertEqual(store.get(key), {"mate": -3, "depth": 40, "pv": ["d2d4", "e7e5"], "nodes": 9})
        self.assertIsNone(store.get("other"))

    def test_positions_already_searched_to_32_are_not_searched_again(self):
        self.sa.MIN_DEPTH = 32
        self.db.set_setting(self.sa.SINCE_KEY, "2026-11-25T09:00:00+00:00")
        game = self.add_game()
        boards, _ = self.sa.read_game(QUEEN_HANG)
        from position_key import position_key
        saved = {position_key(boards[3]): {"cp": 12, "depth": 40, "pv": ["d2d4"], "nodes": 7},
                 position_key(boards[4]): {"cp": 12, "depth": 20, "pv": ["d2d4"], "nodes": 7}}

        class Store:
            def get(self, key):
                return saved.get(key)

            def put(self, key, result):
                saved.setdefault(key, result)

        engine = FakeEngine(depths=40)
        a = self.sa.StudyAnalyzer(NoCloud(), engine_factory=lambda: engine, saved_evals=Store())
        a._studies = FakeStudies()
        a.start()
        a.hold(False)
        try:
            end = time.monotonic() + 5
            while time.monotonic() < end and (self.state(game) or {}).get("state") != "ready":
                time.sleep(0.02)
        finally:
            a.shutdown()
        self.assertEqual(self.state(game)["state"], "ready")
        self.assertNotIn(boards[3].fen(), engine.searched)  # depth 40 saved
        self.assertIn(boards[4].fen(), engine.searched)     # only depth 20 saved
        self.assertEqual(json.loads(self.state(game)["scores"])[3]["depth"], 40)
        self.assertIn(position_key(boards[5]), saved)      # new results are saved

    def test_earlier_games_results_are_copied_to_the_store(self):
        game = self.add_game()
        boards, _ = self.sa.read_game(QUEEN_HANG)
        scores = [{"cp": 1, "source": "cloud", "pv": ["e2e4"], "depth": 60}] + [
            {"cp": i, "source": "stockfish", "pv": ["e2e4"], "depth": 32, "nodes": 1}
            for i in range(1, len(boards))]
        self.sa.queue_game(game)
        self.sa._update(game, state="published", scores=scores)
        from position_key import position_key
        saved = {}

        class Store:
            def put(self, key, result):
                saved[key] = result
        a = self.sa.StudyAnalyzer(NoCloud(), saved_evals=Store())
        a._backfill()
        self.assertNotIn(position_key(boards[0]), saved)  # the cloud's: Lichess has it
        self.assertEqual(saved[position_key(boards[2])]["cp"], 2)
        self.assertEqual(len(saved), len(boards) - 1)
