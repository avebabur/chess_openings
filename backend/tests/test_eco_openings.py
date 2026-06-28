import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import eco_openings as eco


class EcoOpeningsTests(unittest.TestCase):
    def test_caro_kann_base_and_advance(self):
        self.assertEqual(eco.classify("e4 c6 d4 d5")["family"], "Caro-Kann Defense")
        deeper = eco.classify("e4 c6 d4 d5 e5")
        self.assertEqual(deeper["name"], "Caro-Kann Defense: Advance Variation")
        self.assertEqual(deeper["family"], "Caro-Kann Defense")
        self.assertEqual(deeper["eco"], "B12")

    def test_ruy_lopez_morphy(self):
        hit = eco.classify("e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O")
        self.assertEqual(hit["family"], "Ruy Lopez")
        self.assertIn("Morphy", hit["name"])

    def test_sicilian_najdorf(self):
        hit = eco.classify("e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6")
        self.assertEqual(hit["name"], "Sicilian Defense: Najdorf Variation")

    def test_deepest_match_wins(self):
        # A line passes through several named positions; the most specific wins.
        base = eco.classify("e4 c6")["name"]
        deep = eco.classify("e4 c6 d4 d5 e5")["name"]
        self.assertNotEqual(base, deep)
        self.assertTrue(deep.startswith("Caro-Kann"))

    def test_transposition_same_opening(self):
        # 1.d4 Nf6 2.c4 g6 and 1.c4 g6 2.d4 Nf6 reach the same position.
        a = eco.classify("d4 Nf6 c4 g6")
        b = eco.classify("c4 g6 d4 Nf6")
        self.assertIsNotNone(a)
        self.assertEqual(a["name"], b["name"])

    def test_empty_and_unknown(self):
        self.assertIsNone(eco.classify(""))
        self.assertIsNone(eco.classify(None))
        # Illegal move mid-line: best match up to the break (here, nothing named).
        self.assertIsNone(eco.classify("Qh5 zzzz"))


if __name__ == "__main__":
    unittest.main()
