import importlib
import json
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

    def test_lichess_import_skips_games_that_were_never_played(self):
        module = importlib.reload(game_import)

        def game(gid, status, winner=None):
            return {
                "id": gid, "variant": "standard", "speed": "blitz", "status": status,
                "winner": winner, "createdAt": 1_700_000_000_000, "pgn": "1. e4 e5 *",
                "players": {"white": {"user": {"name": "me"}}, "black": {"user": {"name": "opp"}}},
            }

        lines = [json.dumps(g) for g in (
            game("played", "draw"),
            game("aborted", "aborted"),
            game("nostart-loss", "noStart", winner="black"),
            game("nostart-void", "noStart"),
        )]
        transport = httpx.MockTransport(
            lambda request: httpx.Response(200, text="\n".join(lines)),
        )
        saved = []
        with httpx.Client(transport=transport) as client, \
                patch.object(module.db, "get_setting", return_value=None), \
                patch.object(module.db, "save_imported_games",
                             side_effect=lambda batch: saved.extend(batch) or {"imported": len(batch)}):
            result = module.import_lichess("me", 1, client=client)

        # An aborted game has no winner; filing it as a draw skewed every tree stat.
        self.assertEqual([g["external_id"] for g in saved], ["played", "nostart-loss"])
        self.assertEqual([g["result"] for g in saved], ["1/2-1/2", "0-1"])
        self.assertEqual(result["seen"], 2)

    def test_account_exists_distinguishes_missing_from_unreachable(self):
        module = importlib.reload(game_import)

        def client_for(status=None, error=None):
            def handler(request):
                if error:
                    raise error
                return httpx.Response(status)
            return httpx.Client(transport=httpx.MockTransport(handler))

        with client_for(200) as client:
            self.assertIs(module.account_exists("chesscom", "real", client), True)
        with client_for(404) as client:
            self.assertIs(module.account_exists("lichess", "typo", client), False)
        # Rate limits and outages are "couldn't check", never "doesn't exist".
        with client_for(429) as client:
            self.assertIsNone(module.account_exists("lichess", "someone", client))
        request = httpx.Request("GET", "https://lichess.org")
        with client_for(error=httpx.ConnectError("offline", request=request)) as client:
            self.assertIsNone(module.account_exists("chesscom", "someone", client))


if __name__ == "__main__":
    unittest.main()
