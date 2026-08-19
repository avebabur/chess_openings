import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import lichess_explorer
from position_key import START_KEY, key_from_san_path


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# The same position by two move orders. Their FENs differ (halfmove clock 2 vs 0)
# but the explorer aggregate for them is by definition identical.
TRANSPOSITION_A = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
TRANSPOSITION_B = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3"


class ExplorerFilterShapeTests(unittest.TestCase):
    """_cache_key / _filter_params are the whole reason filtered and unfiltered
    aggregates for one position don't contaminate each other."""

    def test_unfiltered_key_is_the_bare_position_key(self):
        for empty in (None, {}, {"speeds": [], "ratings": [], "since": "", "until": ""}):
            self.assertEqual(lichess_explorer._cache_key(START_FEN, empty), START_KEY)

    def test_move_order_does_not_fork_the_cache(self):
        # The whole point: one position, one cached aggregate, however you got here.
        self.assertNotEqual(TRANSPOSITION_A, TRANSPOSITION_B)
        self.assertEqual(
            lichess_explorer._cache_key(TRANSPOSITION_A, None),
            lichess_explorer._cache_key(TRANSPOSITION_B, None),
        )
        self.assertEqual(
            lichess_explorer._cache_key(TRANSPOSITION_A, {"speeds": ["blitz"]}),
            lichess_explorer._cache_key(TRANSPOSITION_B, {"speeds": ["blitz"]}),
        )
        self.assertEqual(
            lichess_explorer._cache_key(TRANSPOSITION_A, None),
            key_from_san_path("e4 e5 Nf3 Nc6"),
        )

    def test_different_positions_still_key_apart(self):
        self.assertNotEqual(
            lichess_explorer._cache_key(START_FEN, None),
            lichess_explorer._cache_key(TRANSPOSITION_A, None),
        )

    def test_filters_key_apart_from_each_other_and_from_unfiltered(self):
        keys = {
            lichess_explorer._cache_key(START_FEN, f)
            for f in (
                None,
                {"speeds": ["blitz"]},
                {"speeds": ["rapid"]},
                {"ratings": [2500]},
                {"since": "2024-01"},
                {"until": "2024-01"},
                {"speeds": ["blitz"], "ratings": [2500]},
            )
        }
        self.assertEqual(len(keys), 7)
        self.assertTrue(all(k.startswith(START_KEY) for k in keys))

    def test_key_is_order_independent(self):
        # Chip-toggle order must not fork the cache (or the fetch — filterKey on the
        # frontend sorts for the same reason).
        self.assertEqual(
            lichess_explorer._cache_key(START_FEN, {"speeds": ["rapid", "blitz"]}),
            lichess_explorer._cache_key(START_FEN, {"speeds": ["blitz", "rapid"]}),
        )
        self.assertEqual(
            lichess_explorer._cache_key(START_FEN, {"ratings": [2500, 1600]}),
            lichess_explorer._cache_key(START_FEN, {"ratings": [1600, 2500]}),
        )

    def test_filter_params_omit_defaults_and_join_lists(self):
        self.assertEqual(lichess_explorer._filter_params(None), {})
        self.assertEqual(
            lichess_explorer._filter_params(
                {"speeds": [], "ratings": [], "since": "", "until": ""},
            ),
            {},
        )
        self.assertEqual(
            lichess_explorer._filter_params(
                {"speeds": ["rapid", "blitz"], "ratings": [2500, 1600],
                 "since": "2024-01", "until": "2024-12"},
            ),
            {"speeds": "blitz,rapid", "ratings": "1600,2500",
             "since": "2024-01", "until": "2024-12"},
        )


class ExplorerRouteValidationTests(unittest.TestCase):
    """Lichess rejects values outside its enums; we reject them first so a typo
    surfaces as a 400 here rather than an opaque upstream failure."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        self.old_no_network = os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "explorer.db")
        # Never call Lichess from a test: the route short-circuits to source
        # "unknown", which is enough to prove valid filters got through.
        os.environ["OPENINGS_DISABLE_EXTERNAL_NETWORK"] = "1"
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
        for key, old in (("CHESS_DB_PATH", self.old_db_path),
                         ("OPENINGS_DISABLE_EXTERNAL_NETWORK", self.old_no_network)):
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        self.temp_dir.cleanup()

    def _get(self, **params):
        return self.client.get("/api/opening-explorer", params={"fen": START_FEN, **params})

    def test_rejects_values_outside_lichess_enums(self):
        cases = [
            ({"speeds": "bogus"}, "unknown speed"),
            ({"speeds": "blitz,bogus"}, "one bad speed among good ones"),
            ({"ratings": "1500"}, "off-grid rating (bands only)"),
            ({"ratings": "abc"}, "non-numeric rating"),
            ({"since": "2020-13"}, "month 13"),
            ({"since": "2020"}, "year without month"),
            ({"until": "1900-05"}, "before Lichess's earliest month"),
            ({"since": "2022-05", "until": "2021-05"}, "inverted range"),
        ]
        for params, why in cases:
            with self.subTest(why=why):
                self.assertEqual(self._get(**params).status_code, 400)

    def test_accepts_every_documented_value(self):
        self.assertEqual(
            self._get(speeds=",".join(lichess_explorer.SPEEDS)).status_code, 200,
        )
        self.assertEqual(
            self._get(ratings=",".join(str(r) for r in lichess_explorer.RATING_GROUPS))
            .status_code,
            200,
        )
        self.assertEqual(self._get(since="1952-01", until="2026-12").status_code, 200)
        self.assertEqual(self._get().status_code, 200)


if __name__ == "__main__":
    unittest.main()
