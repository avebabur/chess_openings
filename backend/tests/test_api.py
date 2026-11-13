import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from unittest.mock import patch

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(Path(self.temp_dir.name) / "api.db")
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
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def test_websites_cannot_read_or_change_anything(self):
        # No CORS headers at all: a browser refuses to hand the answer to a page,
        # and refuses to send anything that needs a preflight.
        res = self.client.get("/api/accounts", headers={"Origin": "https://example.com"})
        self.assertNotIn("access-control-allow-origin", res.headers)
        res = self.client.options("/api/accounts", headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type"})
        self.assertNotIn("access-control-allow-origin", res.headers)
        self.assertGreaterEqual(res.status_code, 400)

    def test_only_the_local_address_is_answered(self):
        # A website whose own domain name points at 127.0.0.1 (DNS rebinding).
        res = self.client.get("/api/backup", headers={"Host": "evil.example"})
        self.assertEqual(res.status_code, 400)
        res = self.client.get("/api/health", headers={"Host": "127.0.0.1:8001"})
        self.assertEqual(res.status_code, 200)

    def test_an_address_that_is_not_a_lichess_game_is_refused(self):
        res = self.client.get("/api/games/by-link", params={"url": "https://www.chess.com/game/live/123456"})
        self.assertEqual(res.status_code, 400)

    def test_a_lichess_game_page_finds_the_imported_game(self):
        res = self.client.get("/api/games/by-link", params={"url": "https://lichess.org/game/NxSwb2Nq#18"})
        self.assertEqual(res.status_code, 404)
        self.assertIn("Lichess", res.json()["detail"])

    def test_adding_an_account_that_does_not_exist_creates_nothing(self):
        # A typo used to become a dead "0 games · never synced" account.
        with patch.object(self.main.game_import, "account_exists", return_value=False), \
                patch.object(self.main.app.state.sync_service, "enqueue") as enqueue:
            response = self.client.post("/api/accounts", json={
                "platform": "chesscom", "username": "no-such-player",
            })
        self.assertEqual(response.status_code, 400)
        self.assertIn("no-such-player", response.json()["detail"])
        enqueue.assert_not_called()
        self.assertEqual(self.client.get("/api/accounts").json(), [])

    def test_branches_are_validated_and_a_changed_line_replaces_its_moves(self):
        invalid = self.client.post("/api/repertoire/tree/branches", json={
            "color": "green", "name": "bad", "moves_san": "e4",
        })
        self.assertEqual(invalid.status_code, 422)

        branch = self.client.post("/api/repertoire/tree/branches", json={
            "color": "white", "name": "line", "moves_san": "e4",
        }).json()
        updated = self.client.patch(
            f"/api/repertoire/tree/branches/{branch['id']}", json={"moves_san": "d4"},
        )
        self.assertEqual(updated.json()["moves_san"], "d4")
        tree = self.client.get("/api/repertoire/tree", params={"color": "white"}).json()
        self.assertEqual([node["san"] for node in tree["root"]["children"]], ["d4"])


    def test_backup_download_is_a_valid_database(self):
        response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 200)
        target = Path(self.temp_dir.name) / "download.db"
        target.write_bytes(response.content)
        conn = sqlite3.connect(target)
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        conn.close()

    def test_app_factory_owns_distinct_runtime_services(self):
        second_app = self.main.create_app()
        with TestClient(second_app):
            self.assertIsNot(
                self.main.app.state.opening_tree_cache,
                second_app.state.opening_tree_cache,
            )
            self.assertIsNot(self.main.app.state.sync_service, second_app.state.sync_service)
            self.assertIsNot(self.main.app.state.sync_service, second_app.state.sync_service)
            self.assertIsNot(self.main.app.state.database, second_app.state.database)
            self.assertIsNot(
                self.main.app.state.external_clients,
                second_app.state.external_clients,
            )


if __name__ == "__main__":
    unittest.main()
