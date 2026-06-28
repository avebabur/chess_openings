import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import game_import


class GameImportTests(unittest.TestCase):
    def test_safety_cap_iteration_starts_with_newest_data(self):
        module = importlib.reload(game_import)
        self.assertEqual(list(module._newest_first(["old", "middle", "new"])), ["new", "middle", "old"])

    def test_network_errors_are_normalized(self):
        module = importlib.reload(game_import)
        account = {"id": 1, "platform": "chesscom", "username": "player"}
        request = httpx.Request("GET", "https://api.chess.com")
        with patch.object(
            module,
            "import_chesscom",
            side_effect=httpx.ConnectError("offline", request=request),
        ):
            with self.assertRaisesRegex(module.ImportError_, "could not be reached"):
                module.sync_account(account)


if __name__ == "__main__":
    unittest.main()
