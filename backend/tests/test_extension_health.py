import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import chess  # noqa: E402
import extension_health  # noqa: E402
import opening_tree  # noqa: E402


def _feature(status, missing=()):
    return {"name": status.title(), "status": status, "detail": "",
            "missing_anchors": [{"name": n, "selector": "." + n} for n in missing]}


class ExtensionHealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "extension" / "health-report.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_feature_is_listed_as_broken_with_its_selector(self):
        merged = extension_health.record({
            "page_kind": "analyse", "url": "https://lichess.org/analysis",
            "features": {"engine": _feature("ok"),
                         "notes": _feature("missing", ["underboard"])},
        }, self.path)
        self.assertEqual([b["feature"] for b in merged["broken"]], ["notes"])
        self.assertEqual(merged["broken"][0]["missing_anchors"][0]["selector"], ".underboard")
        on_disk = json.loads(Path(self.path).read_text())
        self.assertEqual(on_disk["broken"], merged["broken"])

    def test_a_page_kind_that_no_longer_exists_is_dropped(self):
        Path(self.path).parent.mkdir(parents=True)
        Path(self.path).write_text(json.dumps({"pages": {
            "puzzle": {"url": "https://lichess.org/training", "features": {
                "puzzles": _feature("missing", ["puzzleSide"])}},
            "other": {"url": "https://lichess.org/", "features": {"engine": _feature("n/a")}},
        }}))
        merged = extension_health.record({
            "page_kind": "analyse", "url": "https://lichess.org/analysis",
            "features": {"engine": _feature("ok")},
        }, self.path)
        self.assertEqual(sorted(merged["pages"]), ["analyse", "other"])
        self.assertEqual(merged["broken"], [])

    def test_each_page_kind_keeps_its_own_latest_report(self):
        extension_health.record({"page_kind": "other", "features": {
            "nav": _feature("missing", ["topnav"])}}, self.path)
        merged = extension_health.record({"page_kind": "analyse", "features": {
            "engine": _feature("ok")}}, self.path)
        self.assertEqual(sorted(merged["pages"]), ["analyse", "other"])
        self.assertEqual([b["feature"] for b in merged["broken"]], ["nav"])
        # A later good report for that page kind clears it.
        merged = extension_health.record({"page_kind": "other", "features": {
            "nav": _feature("ok")}}, self.path)
        self.assertEqual(merged["broken"], [])

    def test_unknown_page_kind_is_refused(self):
        with self.assertRaises(ValueError):
            extension_health.record({"page_kind": "nope", "features": {}}, self.path)


class OpeningTreeByFenTests(unittest.TestCase):
    GAMES = [
        {"id": 1, "user_color": "white", "result": "1-0", "opp_rating": 1000,
         "pgn": "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"},
        {"id": 2, "user_color": "white", "result": "0-1", "opp_rating": 1100,
         "pgn": "1. Nf3 Nc6 2. e4 e5 3. Bb5 *"},
    ]

    def test_fen_lookup_counts_games_from_every_move_order(self):
        board = chess.Board()
        for san in ["e4", "e5", "Nf3", "Nc6"]:
            board.push_san(san)
        cache = opening_tree.OpeningTreeCache(game_loader=lambda **_: self.GAMES)
        node = cache.node_for_filter("white", [], fen=board.fen())
        self.assertEqual(node["total_games"], 2)
        self.assertEqual(sorted(m["san"] for m in node["moves"]), ["Bb5", "Bc4"])


class GamesThroughTests(unittest.TestCase):
    GAMES = [
        {"id": 1, "user_color": "white", "result": "1-0", "end_time": "2026-01-01",
         "pgn": "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"},
        {"id": 2, "user_color": "white", "result": "0-1", "end_time": "2026-02-01",
         "pgn": "1. Nf3 Nc6 2. e4 e5 3. Bb5 *"},
        {"id": 3, "user_color": "white", "result": "0-1", "end_time": "2026-03-01",
         "pgn": "1. d4 d5 *"},
    ]

    def test_games_reaching_a_position_by_any_order_newest_first_with_the_ply(self):
        board = chess.Board()
        for san in ["e4", "e5", "Nf3", "Nc6"]:
            board.push_san(san)
        cache = opening_tree.OpeningTreeCache(game_loader=lambda **_: self.GAMES)
        found = cache.games_through(board.fen())
        self.assertEqual([(g["id"], ply) for g, ply in found], [(2, 4), (1, 4)])

    def test_the_start_position_lists_every_game(self):
        cache = opening_tree.OpeningTreeCache(game_loader=lambda **_: self.GAMES)
        found = cache.games_through(chess.Board().fen())
        self.assertEqual([g["id"] for g, _ in found], [3, 2, 1])


if __name__ == "__main__":
    unittest.main()
