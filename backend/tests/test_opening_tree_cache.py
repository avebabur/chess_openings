import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import opening_tree


# e2-e4 then a couple of replies; enough to build a non-trivial trie.
def _game(gid, account_id, pgn, color="white", result="1-0"):
    return {
        "id": gid, "account_id": account_id, "user_color": color,
        "result": result, "opp_rating": 1500, "end_time": "2024-01-01",
        "opening": "Test Opening", "pgn": pgn,
    }


GAMES = {
    1: _game(1, 1, "1. e4 e5 2. Nf3 *"),
    2: _game(2, 2, "1. e4 c5 *"),
}


def _loader(color, time_classes=None, account_id=None):
    if account_id is None:
        games = list(GAMES.values())
    else:
        games = [g for g in GAMES.values() if g["account_id"] == account_id]
    return [g for g in games if g["user_color"] == color]


class OpeningTreeCacheTests(unittest.TestCase):
    def _cache(self):
        return opening_tree.OpeningTreeCache(game_loader=_loader)

    def test_scoped_invalidate_keeps_other_accounts_and_moves_memo(self):
        cache = self._cache()
        # Build trees for account 1, account 2, and the combined ("all") view.
        cache.node_for_filter("white", [], account_id=1)
        cache.node_for_filter("white", [], account_id=2)
        cache.node_for_filter("white", [], account_id=None)
        self.assertEqual(len(cache._moves), 2)        # both PGNs parsed + memoized
        b_tree = cache._trees[("white", (), 2)]       # identity to compare after invalidate

        cache.invalidate(account_id=1)

        # Account 1's tree and the combined key are dropped; account 2's is untouched.
        self.assertNotIn(("white", (), 1), cache._trees)
        self.assertNotIn(("white", (), None), cache._trees)
        self.assertIs(cache._trees[("white", (), 2)], b_tree)
        # The per-game parse memo (keyed by immutable game id) survives.
        self.assertEqual(len(cache._moves), 2)

    def test_full_invalidate_clears_trees_but_keeps_moves(self):
        cache = self._cache()
        cache.node_for_filter("white", [], account_id=1)
        cache.node_for_filter("white", [], account_id=2)
        self.assertTrue(cache._trees)
        self.assertEqual(len(cache._moves), 2)

        cache.invalidate()

        self.assertEqual(cache._trees, {})
        self.assertEqual(len(cache._moves), 2)        # parse memo preserved

    def test_tree_output_identical_after_scoped_invalidate(self):
        cache = self._cache()
        before = cache.node_for_filter("white", [], account_id=1)
        cache.invalidate(account_id=1)
        after = cache.node_for_filter("white", [], account_id=1)
        self.assertEqual(before, after)

    def test_build_overtaken_by_invalidation_is_not_cached(self):
        # A sync can land while a graph is being built from the pre-sync games.
        # That graph may answer the request in flight, but caching it would hide
        # the new games until some later invalidation.
        cache = None

        def racing_loader(color, time_classes=None, account_id=None):
            games = _loader(color, time_classes, account_id)
            cache.invalidate(account_id=account_id)   # the sync finishes mid-build
            return games

        cache = opening_tree.OpeningTreeCache(game_loader=racing_loader)
        node = cache.node_for_filter("white", [], account_id=1)
        self.assertEqual(node["total_games"], 1)
        self.assertNotIn(("white", (), 1), cache._trees)

    def test_graph_key_identifies_positions_exactly_like_position_key(self):
        import chess
        from position_key import position_key

        lines = [
            "", "e4", "e4 e5", "d4 Nf6 c4 e6", "c4 e6 d4 Nf6",          # transposition
            "e4 d5 e5 f5",                                              # legal en passant
            "e4 Nf6 e5 d5", "e4 Nf6 e5 Nd5 c4 Nb6",                     # ep legal / none
            "Nf3 Nf6 Ng1 Ng8", "Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1 Ng8",       # repetition, clocks differ
            "e4 e5 Ke2 Ke7", "e4 e5 Ke2 Ke7 Ke1 Ke8",                    # castling rights lost
            "e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6",
        ]
        boards = []
        for line in lines:
            board = chess.Board()
            for san in line.split():
                board.push_san(san)
            boards.append(board)
        for a in boards:
            for b in boards:
                self.assertEqual(
                    opening_tree._graph_key(a) == opening_tree._graph_key(b),
                    position_key(a) == position_key(b),
                    (a.fen(), b.fen()),
                )


if __name__ == "__main__":
    unittest.main()
