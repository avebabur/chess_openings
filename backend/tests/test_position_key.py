import json
import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import chess

from position_key import (
    START_KEY,
    key_from_fen,
    key_from_san_path,
    keys_along_san_path,
    position_key,
)

FIXTURES_PATH = Path(__file__).parent / "data" / "position_key_fixtures.json"


def _board_for(fixture):
    board = chess.Board(fixture["fen"]) if fixture.get("fen") else chess.Board()
    for san in fixture["line"].split():
        board.push_san(san)
    return board


class PositionKeyTests(unittest.TestCase):
    def test_transpositions_share_a_key(self):
        a = key_from_san_path("e4 e5 Nf3 Nc6")
        b = key_from_san_path("Nf3 Nc6 e4 e5")
        self.assertEqual(a, b)

    def test_move_clocks_are_not_part_of_identity(self):
        # The two orders above differ only in the halfmove clock, which is
        # exactly the field the key drops.
        a, b = chess.Board(), chess.Board()
        for san in "e4 e5 Nf3 Nc6".split():
            a.push_san(san)
        for san in "Nf3 Nc6 e4 e5".split():
            b.push_san(san)
        self.assertNotEqual(a.fen(), b.fen())
        self.assertEqual(position_key(a), position_key(b))

    def test_side_to_move_is_part_of_identity(self):
        # Same pieces, other player to move: a different position.
        white_to_move = chess.Board()
        black_to_move = chess.Board()
        black_to_move.turn = chess.BLACK
        self.assertEqual(
            white_to_move.board_fen(), black_to_move.board_fen(),
        )
        self.assertNotEqual(position_key(white_to_move), position_key(black_to_move))

    def test_castling_rights_are_part_of_identity(self):
        with_rights = key_from_san_path("e4 e5 Nf3 Nc6 Bc4 Bc5")
        # A king round trip reaches the same placement having lost every right.
        without = key_from_san_path("e4 e5 Nf3 Nc6 Bc4 Bc5 Ke2 Ke7 Ke1 Ke8")
        self.assertEqual(with_rights.split()[0], without.split()[0])
        self.assertEqual(with_rights.split()[2], "KQkq")
        self.assertEqual(without.split()[2], "-")
        self.assertNotEqual(with_rights, without)

    def test_en_passant_recorded_only_when_the_capture_is_legal(self):
        # No pawn can take: the double push leaves no en-passant square.
        self.assertEqual(key_from_san_path("e4 d5").split()[3], "-")
        # A pawn on e5 can take: the square is part of the position.
        self.assertEqual(key_from_san_path("e4 Nf6 e5 d5").split()[3], "d6")

    def test_en_passant_ignored_when_the_capture_would_expose_the_king(self):
        # Same push in both; only the white king's square differs. On b4 the
        # capture is legal, on a5 it would uncover the rook on h5.
        legal = chess.Board("8/2p5/8/1P5r/1K6/8/8/7k b - - 0 1")
        legal.push_san("c5")
        pinned = chess.Board("8/2p5/8/KP5r/8/8/8/7k b - - 0 1")
        pinned.push_san("c5")
        self.assertEqual(position_key(legal).split()[3], "c6")
        self.assertEqual(position_key(pinned).split()[3], "-")

    def test_key_from_fen_normalizes_an_unplayable_en_passant_square(self):
        # A FEN from outside the app can claim an en-passant square that no pawn
        # can actually use; it must key to the same position as one without.
        claimed = key_from_fen("8/8/8/KPp4r/8/8/8/7k w - c6 0 2")
        plain = key_from_fen("8/8/8/KPp4r/8/8/8/7k w - - 0 2")
        self.assertEqual(claimed, plain)

    def test_key_from_fen_is_idempotent_on_a_key(self):
        self.assertEqual(key_from_fen(START_KEY), START_KEY)

    def test_key_from_fen_rejects_junk(self):
        with self.assertRaises(ValueError):
            key_from_fen("not a fen")

    def test_start_key_matches_an_empty_path(self):
        self.assertEqual(key_from_san_path(""), START_KEY)
        self.assertEqual(key_from_san_path([]), START_KEY)
        self.assertEqual(key_from_san_path(None), START_KEY)

    def test_key_from_san_path_returns_none_for_an_illegal_line(self):
        self.assertIsNone(key_from_san_path("e4 e5 Qxf7"))
        self.assertIsNone(key_from_san_path("zzzz"))

    def test_keys_along_san_path_chains_before_to_after(self):
        steps = keys_along_san_path("e4 e5 Nf3")
        self.assertEqual([san for san, _, _ in steps], ["e4", "e5", "Nf3"])
        self.assertEqual(steps[0][1], START_KEY)
        for earlier, later in zip(steps, steps[1:]):
            self.assertEqual(earlier[2], later[1])

    def test_keys_along_san_path_stops_at_the_first_illegal_move(self):
        steps = keys_along_san_path("e4 e5 Qxf7 Nf3")
        self.assertEqual([san for san, _, _ in steps], ["e4", "e5"])

    def test_keys_along_san_path_canonicalizes_san(self):
        steps = keys_along_san_path("e4 d5 exd5 c6 dxc6 Nf6 cxb7 Ng4 bxa8Q")
        self.assertEqual(steps[-1][0], "bxa8=Q")


class ChessJsAgreementTests(unittest.TestCase):
    """The frontend derives the same key by slicing four fields off a chess.js
    FEN. These fixtures are the contract: `chessLine.test.js` asserts the very
    same file, so the two runtimes drifting fails loudly on one side."""

    def setUp(self):
        self.fixtures = json.loads(FIXTURES_PATH.read_text())

    def test_every_fixture_key_is_what_python_chess_produces(self):
        for fixture in self.fixtures:
            with self.subTest(fixture["name"]):
                self.assertEqual(position_key(_board_for(fixture)), fixture["key"])

    def test_fixtures_cover_the_cases_that_could_diverge(self):
        # A fixture file that quietly lost its interesting rows would still pass
        # the test above. Pin the properties that make it worth having.
        keys = [f["key"] for f in self.fixtures]
        self.assertGreater(len(self.fixtures), 10)
        self.assertTrue(any(k.split()[3] != "-" for k in keys), "no en-passant case")
        self.assertTrue(any(k.split()[2] == "-" for k in keys), "no lost-castling case")
        self.assertTrue(any(k.split()[1] == "b" for k in keys), "no black-to-move case")
        self.assertTrue(any(f.get("fen") for f in self.fixtures), "no from-FEN case")
        # At least one pair of distinct lines reaching one position.
        self.assertLess(len(set(keys)), len(keys), "no transposition pair")


if __name__ == "__main__":
    unittest.main()
