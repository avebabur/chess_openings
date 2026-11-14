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


    def test_a_line_saved_without_a_name_is_named_after_its_opening(self):
        saved = self.client.post("/api/repertoire/tree/branches", json={
            "color": "black", "name": "", "moves_san": "e4 c6 d4 d5",
        }).json()
        self.assertEqual(saved["name"], "Caro-Kann Defense")
        # Emptying the name later does the same, not "e4 c6 d4 d5".
        self.client.patch(f"/api/repertoire/tree/branches/{saved['id']}", json={"name": "mine"})
        again = self.client.patch(f"/api/repertoire/tree/branches/{saved['id']}", json={"name": ""}).json()
        self.assertEqual(again["name"], "Caro-Kann Defense")

    def test_an_opening_name_is_stored_in_the_eco_spelling(self):
        saved = self.client.post("/api/repertoire/tree/branches", json={
            "color": "black", "name": "caro kann defense classical variation",
            "moves_san": "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5",
        }).json()
        self.assertEqual(saved["name"], "Caro-Kann Defense: Classical Variation")
        other = self.client.post("/api/repertoire/tree/branches", json={
            "color": "white", "name": "My pet line", "moves_san": "e4 e5",
        }).json()
        self.assertEqual(other["name"], "My pet line")

    def test_my_games_names_the_position_on_the_board(self):
        # Not the opening most of the games through it ended up in.
        one_d4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1"
        node = self.client.get("/api/opening-tree", params={"color": "white", "fen": one_d4}).json()
        self.assertEqual(node["opening_name"], "Queen's Pawn Game")
        # Deeper than any named position: the name of the last one on the way.
        moves = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 a4"
        import chess
        board = chess.Board()
        for san in moves.split():
            board.push_san(san)
        node = self.client.get("/api/opening-tree", params={
            "color": "white", "fen": board.fen(), "moves_san": moves}).json()
        self.assertIn("Ruy Lopez", node["opening_name"])
        # Moves that do not lead to the position are not believed.
        node = self.client.get("/api/opening-tree", params={
            "color": "white", "fen": one_d4, "moves_san": "e4 e5"}).json()
        self.assertEqual(node["opening_name"], "Queen's Pawn Game")
        start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        self.assertIsNone(self.client.get("/api/opening-tree", params={
            "color": "white", "fen": start}).json()["opening_name"])

    def test_checking_a_game_that_does_not_exist_is_refused(self):
        self.assertEqual(self.client.post("/api/analysis", json={"game_id": 987654}).status_code, 404)
        self.assertEqual(self.client.post("/api/analysis", json={}).status_code, 422)
        self.assertEqual(self.client.post("/api/analysis", json={"game_id": 1, "all": True}).status_code, 422)
        status = self.client.get("/api/analysis").json()
        self.assertEqual((status["running"], status["unchecked"]), (False, 0))

    def test_keepalive_answers(self):
        res = self.client.post("/api/keepalive")
        self.assertEqual(res.status_code, 200)
        # Not started by the extension's helper: the service never stops itself.
        self.assertIsNone(res.json()["stops_after_idle_seconds"])

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
