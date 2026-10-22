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

    def test_validated_branch_and_idempotent_drill_contract(self):
        invalid = self.client.post("/api/repertoire/tree/branches", json={
            "color": "green", "name": "bad", "moves_san": "e4",
        })
        self.assertEqual(invalid.status_code, 422)

        branch = self.client.post("/api/repertoire/tree/branches", json={
            "color": "white", "name": "line", "moves_san": "e4",
        }).json()
        self.assertEqual(
            self.client.get("/api/repertoire/openings", params={"color": "white"}).status_code,
            200,
        )
        tree = self.client.get("/api/repertoire/tree", params={"color": "white"}).json()
        node_id = tree["root"]["children"][0]["id"]
        payload = {
            "event_key": "api-event-1", "source": "practice", "solved": False,
            "node_id": node_id, "expected_san": "e4", "played_san": "d4",
        }
        first = self.client.post("/api/repertoire/drill-attempts", json=payload)
        second = self.client.post("/api/repertoire/drill-attempts", json=payload)
        self.assertEqual(first.status_code, 200)
        self.assertFalse(first.json()["duplicate"])
        self.assertTrue(second.json()["duplicate"])
        self.assertEqual(
            self.client.post(f"/api/repertoire/tree/nodes/{node_id}/drill", json={"solved": True}).status_code,
            404,
        )

        updated = self.client.patch(
            f"/api/repertoire/tree/branches/{branch['id']}", json={"moves_san": "d4"},
        )
        self.assertTrue(updated.json()["training_reset"])

    def test_backup_download_is_a_valid_database(self):
        response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 200)
        target = Path(self.temp_dir.name) / "download.db"
        target.write_bytes(response.content)
        conn = sqlite3.connect(target)
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        conn.close()

    def test_desktop_spa_blocks_encoded_path_traversal(self):
        # In desktop mode the SPA catch-all serves built static files. Encoded
        # traversal (httpx leaves %2F undecoded, so it bypasses ../ normalization)
        # must never escape frontend/dist to read the DB or backend source.
        dist_index = self.main.DIST_DIR and Path(self.main.DIST_DIR) / "index.html"
        if not (dist_index and dist_index.is_file()):
            self.skipTest("frontend/dist not built; desktop SPA route is not mounted")

        had_flag = "CHESS_OPENINGS_DESKTOP" in os.environ
        prev_flag = os.environ.get("CHESS_OPENINGS_DESKTOP")
        os.environ["CHESS_OPENINGS_DESKTOP"] = "1"
        try:
            desktop_app = self.main.create_app()
            # No `with` (no lifespan): the static SPA route needs no runtime services.
            client = TestClient(desktop_app)
            for attempt in (
                "/..%2F..%2Fchess_review.db",
                "/%2e%2e/%2e%2e/chess_review.db",
                "/..%2f..%2fbackend%2fmain.py",
            ):
                resp = client.get(attempt)
                head = resp.content[:32]
                self.assertFalse(
                    head.startswith(b"SQLite format 3"),
                    f"{attempt} leaked database bytes",
                )
                self.assertNotIn(b"\"\"\"Chess Openings", head, f"{attempt} leaked source")
                # Allowed outcomes: SPA fallback (index.html) or a hard 404.
                self.assertIn(resp.status_code, (200, 404))
                if resp.status_code == 200:
                    self.assertTrue(head.lstrip().startswith(b"<!doctype html>"))
        finally:
            if had_flag:
                os.environ["CHESS_OPENINGS_DESKTOP"] = prev_flag
            else:
                os.environ.pop("CHESS_OPENINGS_DESKTOP", None)

    def test_app_factory_owns_distinct_runtime_services(self):
        second_app = self.main.create_app()
        with TestClient(second_app):
            self.assertIsNot(
                self.main.app.state.opening_tree_cache,
                second_app.state.opening_tree_cache,
            )
            self.assertIsNot(self.main.app.state.live_engine, second_app.state.live_engine)
            self.assertIsNot(self.main.app.state.sync_service, second_app.state.sync_service)
            self.assertIsNot(self.main.app.state.database, second_app.state.database)
            self.assertIsNot(
                self.main.app.state.external_clients,
                second_app.state.external_clients,
            )


if __name__ == "__main__":
    unittest.main()
