import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import opening_tree


def _game(gid, pgn, color="white", result="1-0"):
    return {
        "id": gid, "user_color": color, "result": result,
        "opp_rating": 1500, "end_time": "2024-01-01",
        "opening": "Test Opening", "pgn": pgn,
    }


# The same position (a King's Indian / Grünfeld starting shape) by two orders.
VIA_D4 = _game(1, "1. d4 Nf6 2. c4 g6 *")
VIA_C4 = _game(2, "1. c4 g6 2. d4 Nf6 *", result="0-1")


class TranspositionAggregationTests(unittest.TestCase):
    def _node(self, games, path, color="white"):
        return opening_tree.node(games, color, path)

    def test_both_move_orders_report_the_same_position(self):
        games = [VIA_D4, VIA_C4]
        by_d4 = self._node(games, ["d4", "Nf6", "c4", "g6"])
        by_c4 = self._node(games, ["c4", "g6", "d4", "Nf6"])

        self.assertEqual(by_d4["epd"], by_c4["epd"])
        for view in (by_d4, by_c4):
            self.assertEqual(view["summary"]["games"], 2)
            self.assertEqual(view["total_games"], 2)
            # One game arrived by this order, one by the other.
            self.assertEqual(view["direct_games"], 1)
            self.assertEqual(view["transposition_count"], 1)
            self.assertEqual(len(view["transpositions"]), 1)

    def test_the_transposition_list_names_the_other_order(self):
        node = self._node([VIA_D4, VIA_C4], ["d4", "Nf6", "c4", "g6"])
        other = node["transpositions"][0]

        self.assertEqual(other["path"], ["c4", "g6", "d4", "Nf6"])
        self.assertEqual(other["path_san"], "c4 g6 d4 Nf6")
        self.assertEqual(other["games"], 1)

    def test_results_from_both_orders_are_pooled(self):
        node = self._node([VIA_D4, VIA_C4], ["d4", "Nf6", "c4", "g6"])

        self.assertEqual(node["summary"]["win"], 1)   # VIA_D4 was 1-0
        self.assertEqual(node["summary"]["loss"], 1)  # VIA_C4 was 0-1
        self.assertEqual(node["summary"]["score"], 50.0)

    def test_a_never_played_order_still_finds_the_position(self):
        # 1.d4 g6 2.c4 Nf6 reaches the same place and was never played.
        node = self._node([VIA_D4, VIA_C4], ["d4", "g6", "c4", "Nf6"])

        self.assertEqual(node["total_games"], 2)
        self.assertEqual(node["direct_games"], 0)
        self.assertEqual(node["transposition_count"], 2)

    def test_a_move_reports_direct_and_transposed_counts(self):
        # Only one game ever stood at 1.d4 Nf6 2.c4 and played 2...g6 — but the
        # position that move leads to was reached twice, the other by 1.c4.
        node = self._node([VIA_D4, VIA_C4], ["d4", "Nf6", "c4"])
        g6 = next(m for m in node["moves"] if m["san"] == "g6")

        self.assertEqual(g6["games"], 1)
        self.assertEqual(g6["total_games"], 2)
        self.assertEqual(g6["transposed_games"], 1)

    def test_move_counts_never_exceed_their_position_counts(self):
        games = [VIA_D4, VIA_C4]
        for path in ([], ["d4"], ["d4", "Nf6"], ["c4"], ["c4", "g6"]):
            node = self._node(games, path)
            for move in node["moves"]:
                with self.subTest(path=path, san=move["san"]):
                    self.assertLessEqual(move["games"], move["total_games"])

    def test_examples_are_pooled_across_orders(self):
        node = self._node([VIA_D4, VIA_C4], ["d4", "Nf6", "c4", "g6"])

        self.assertEqual(sorted(e["id"] for e in node["examples"]), [1, 2])


class RepetitionTests(unittest.TestCase):
    """A graph can revisit a position; a game must still count once."""

    SHUFFLE = _game(3, "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 *")

    def test_a_repeated_position_counts_the_game_once(self):
        root = opening_tree.node([self.SHUFFLE], "white", [])
        repeated = opening_tree.node([self.SHUFFLE], "white", ["Nf3", "Nf6"])

        # The root position occurs twice in this game (start, and after 2...Ng8).
        self.assertEqual(root["summary"]["games"], 1)
        self.assertEqual(repeated["summary"]["games"], 1)

    def test_a_repeated_edge_counts_the_game_once(self):
        root = opening_tree.node([self.SHUFFLE], "white", [])
        nf3 = next(m for m in root["moves"] if m["san"] == "Nf3")

        # 1.Nf3 and 3.Nf3 are the same edge out of the same position.
        self.assertEqual(nf3["games"], 1)

    def test_paths_add_up_to_the_game_count(self):
        node = opening_tree.node([self.SHUFFLE, VIA_D4, VIA_C4], "white", [])

        # The invariant the direct/transposed split relies on.
        self.assertEqual(node["direct_games"] + sum(
            t["games"] for t in node["transpositions"]
        ), node["total_games"])


class GraphShapeTests(unittest.TestCase):
    def test_an_illegal_path_reports_itself_as_illegal(self):
        node = opening_tree.node([VIA_D4], "white", ["d4", "d4"])

        self.assertFalse(node["legal"])
        self.assertIsNone(node["fen"])
        self.assertIsNone(node["epd"])

    def test_a_legal_but_unplayed_position_is_empty_not_missing(self):
        node = opening_tree.node([VIA_D4], "white", ["h4", "h5", "Rh3"])

        self.assertTrue(node["legal"])
        self.assertEqual(node["total_games"], 0)
        self.assertEqual(node["moves"], [])
        self.assertEqual(node["transpositions"], [])

    def test_output_is_deterministic_across_builds(self):
        games = [VIA_D4, VIA_C4, RepetitionTests.SHUFFLE]
        first = opening_tree.node(games, "white", ["d4", "Nf6"])
        second = opening_tree.node(games, "white", ["d4", "Nf6"])

        self.assertEqual(first, second)


class CacheBoundTests(unittest.TestCase):
    def test_trees_are_evicted_least_recently_used_first(self):
        loader = lambda color, time_classes=None, account_id=None: [VIA_D4]  # noqa: E731
        cache = opening_tree.OpeningTreeCache(game_loader=loader, max_trees=2)

        cache.node_for_filter("white", [], account_id=1)
        cache.node_for_filter("white", [], account_id=2)
        cache.node_for_filter("white", [], account_id=1)  # refreshes 1
        cache.node_for_filter("white", [], account_id=3)  # evicts 2

        self.assertEqual(len(cache._trees), 2)
        self.assertIn(("white", (), 1), cache._trees)
        self.assertIn(("white", (), 3), cache._trees)
        self.assertNotIn(("white", (), 2), cache._trees)

    def test_eviction_does_not_change_results(self):
        loader = lambda color, time_classes=None, account_id=None: [VIA_D4, VIA_C4]  # noqa: E731
        cache = opening_tree.OpeningTreeCache(game_loader=loader, max_trees=1)

        before = cache.node_for_filter("white", ["d4", "Nf6"], account_id=1)
        cache.node_for_filter("white", [], account_id=2)  # evicts account 1
        after = cache.node_for_filter("white", ["d4", "Nf6"], account_id=1)

        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
