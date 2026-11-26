import importlib
import os
import sqlite3
import sys
import tempfile
import time
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

    def test_a_health_report_from_a_page_with_a_long_address_is_kept(self):
        # A game opened from My games has all its moves in its address
        # (/analysis/pgn/d4_d5_c4…): 700 characters and more. Such a report
        # was refused, so that page's missing features were never written down.
        report_path = Path(self.temp_dir.name) / "health.json"
        with patch.dict(os.environ, {"OPENINGS_EXTENSION_HEALTH_PATH": str(report_path)}):
            res = self.client.post("/api/extension/health", json={
                "page_kind": "analyse",
                "url": "https://lichess.org/analysis/pgn/" + "_".join(["Nf3"] * 400),
                "extension_version": "test",
                "features": {"repertoire": {"name": "Your repertoire", "status": "missing"}},
            })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"broken": 1})
        self.assertIn('"repertoire"', report_path.read_text())

    def test_settings_only_changes_advance_the_extension_build(self):
        root = Path(self.temp_dir.name) / "extension"
        root.mkdir()
        for name in ("manifest.json", "settings.html", "settings.js", "settings.css"):
            asset = root / name
            asset.touch()
            os.utime(asset, (1000, 1000))
        with patch.object(self.main, "OPENINGS_ROOT", self.temp_dir.name):
            self.assertEqual(self.client.get("/api/extension/build").json(), {"build": 1000})
            for new_build, name in enumerate(("settings.html", "settings.js", "settings.css"), 1001):
                with self.subTest(asset=name):
                    os.utime(root / name, (new_build, new_build))
                    self.assertEqual(self.client.get("/api/extension/build").json(), {"build": new_build})

    def test_the_same_new_line_saved_from_two_tabs_at_once_is_saved_once(self):
        # Both saves found the line's moves missing and both added them; the
        # second failed on the duplicate (a 500, "Couldn't save it").
        from concurrent.futures import ThreadPoolExecutor
        db = self.main.db

        def save(n):
            return db.save_repertoire_branch("white", f"tab {n}", "h4 a5 h5 a4 h6 a3")

        with ThreadPoolExecutor(8) as pool:
            saved = list(pool.map(save, range(8)))
        self.assertEqual(len({branch["id"] for branch in saved}), 1)
        tree = self.client.get("/api/repertoire/tree", params={"color": "white"}).json()
        self.assertEqual([b["moves_san"] for b in tree["branches"]], ["h4 a5 h5 a4 h6 a3"])

    def test_a_number_too_large_to_be_an_id_is_refused_not_an_error(self):
        self.assertEqual(self.client.get("/api/games/9223372036854775808").status_code, 422)

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

    def test_a_sync_queued_before_account_removal_takes_the_write_lock_is_kept(self):
        db = self.main.db
        account_id = db.create_account("lichess", "sync-race")["id"]
        delete = db.delete_account

        def queue_before_delete(target):
            db.create_sync_job(target)
            return delete(target)

        with patch.object(db, "delete_account", side_effect=queue_before_delete):
            response = self.client.delete(f"/api/accounts/{account_id}")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(db.get_account(account_id)["sync_job"]["status"], "queued")

    def test_a_sync_queued_after_account_removal_returns_not_found(self):
        db = self.main.db
        account_id = db.create_account("lichess", "remove-race")["id"]
        service = self.main.app.state.sync_service
        enqueue = service.enqueue

        def remove_before_queue(target):
            self.assertTrue(db.delete_account(target))
            return enqueue(target)

        with patch.object(service, "enqueue", side_effect=remove_before_queue):
            response = self.client.post(f"/api/accounts/{account_id}/sync")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(db.list_queued_sync_jobs(), [])

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

    def test_stale_save_cannot_overwrite_a_created_or_renamed_line(self):
        path = "/api/repertoire/tree/branches"
        line = {"color": "white", "moves_san": "a3 h6 a4"}
        first = self.client.post(path, json={**line, "name": "First tab", "label": "trap", "expected": "new"})
        self.assertEqual(first.status_code, 200)
        before = {key: first.json()[key] for key in ("id", "name", "label")}
        stale = self.client.post(path, json={**line, "expected": "new"})
        self.assertEqual(stale.status_code, 409)

        intentional = self.client.post(path, json={**line, "name": "Updated", "label": "sideline", "expected": before})
        self.assertEqual(intentional.status_code, 200)
        stale_again = self.client.post(path, json={**line, "name": "Old draft", "expected": before})
        self.assertEqual(stale_again.status_code, 409)
        tree = self.client.get("/api/repertoire/tree", params={"color": "white"}).json()
        self.assertEqual([(b["name"], b["label"]) for b in tree["branches"]], [("Updated", "sideline")])

    def test_stale_extend_preserves_the_first_continuation(self):
        path = "/api/repertoire/tree/branches"
        original = "b3 a6 Bb2 h6"
        branch = self.client.post(path, json={"color": "white", "moves_san": original}).json()
        edit = f"{path}/{branch['id']}"
        first = self.client.patch(edit, json={"moves_san": original + " e3", "expected_moves_san": original})
        stale = self.client.patch(edit, json={"moves_san": original + " g3", "expected_moves_san": original})
        self.assertEqual((first.status_code, stale.status_code), (200, 409))
        tree = self.client.get("/api/repertoire/tree").json()
        self.assertEqual([b["moves_san"] for b in tree["branches"]], [original + " e3"])

    def test_stale_rename_and_delete_preserve_a_changed_line(self):
        path = "/api/repertoire/tree/branches"
        branch = self.client.post(path, json={"color": "white", "name": "First", "moves_san": "a3 h6"}).json()
        edit = f"{path}/{branch['id']}"
        before = {key: branch[key] for key in ("name", "label", "moves_san")}
        changed = self.client.patch(edit, json={"name": "Kept", "moves_san": "a3 h6 a4", "expected": before})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(self.client.patch(edit, json={"name": "Stale", "expected": before}).status_code, 409)
        self.assertEqual(self.client.request("DELETE", edit, json=before).status_code, 409)
        tree = self.client.get("/api/repertoire/tree").json()
        self.assertEqual([(b["name"], b["moves_san"]) for b in tree["branches"]], [("Kept", "a3 h6 a4")])
        current = {key: changed.json()[key] for key in before}
        self.assertEqual(self.client.request("DELETE", edit, json=current).status_code, 200)
        # Gone is not "changed": the extension says "deleted in another tab"
        # only when it hears 404, and it always sends what it expects.
        self.assertEqual(self.client.request("DELETE", edit, json=current).status_code, 404)
        self.assertEqual(self.client.patch(edit, json={"name": "Late", "expected": current}).status_code, 404)
        self.assertEqual(self.client.patch(edit, json={"label": "trap", "expected": current}).status_code, 404)

    def test_game_pagination_rejects_a_stale_offset_even_if_the_count_matches(self):
        import chess
        params = {"fen": chess.STARTING_FEN, "limit": 1}
        cache = self.main.app.state.opening_tree_cache
        with patch.object(cache, "games_through", return_value=[({"id": 2}, 0), ({"id": 1}, 0)]) as found, \
                patch.object(self.main.db, "get_game_summaries", side_effect=lambda ids: {i: {"id": i} for i in ids}):
            first = self.client.get("/api/position-games", params=params).json()
            next_page = {**params, "offset": 1, "revision": first["revision"]}
            second = self.client.get("/api/position-games", params=next_page).json()
            self.assertEqual([g["id"] for g in first["games"] + second["games"]], [2, 1])
            found.return_value = [({"id": 3}, 0), ({"id": 2}, 0)]
            self.assertEqual(self.client.get("/api/position-games", params=next_page).status_code, 409)
            fresh = self.client.get("/api/position-games", params=params).json()
            self.assertEqual((fresh["total"], fresh["games"][0]["id"]), (2, 3))

    def test_repertoire_refuses_unplayable_null_moves(self):
        result = self.client.post("/api/repertoire/tree/branches", json={"color": "white", "moves_san": "e4 -- e5"})
        self.assertEqual(result.status_code, 400)
        tree = self.client.get("/api/repertoire/tree").json()
        self.assertEqual(tree["root"]["children"], [])
        self.assertEqual(tree["branches"], [])

    def test_long_repertoire_line_cannot_make_the_whole_tree_unreadable(self):
        path = "/api/repertoire/tree"
        moves = " ".join(["Nf3 Nf6 Ng1 Ng8"] * 100)
        line = {"color": "white", "moves_san": moves}
        self.assertEqual(self.client.post(path + "/branches", json=line).status_code, 200)
        too_long = self.client.post(path + "/branches", json={**line, "moves_san": moves + " Nf3"})
        self.assertEqual(too_long.status_code, 400)
        self.assertEqual([b["moves_san"] for b in self.client.get(path).json()["branches"]], [moves])

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

    def test_lichess_analysis_for_this_computer_streams_what_the_broker_would(self):
        import json
        import stat
        import textwrap
        engine = Path(self.temp_dir.name) / "fake-engine"
        engine.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import sys
            for line in sys.stdin:
                cmd = line.strip()
                if cmd == "uci": print("uciok", flush=True)
                elif cmd == "isready": print("readyok", flush=True)
                elif cmd.startswith("go"):
                    print("info depth 7 score cp 25 nodes 700 time 3 pv e2e4 e7e5", flush=True)
                    print("bestmove e2e4", flush=True)
            """))
        engine.chmod(engine.stat().st_mode | stat.S_IEXEC)
        provider = self.main.app.state.lichess_engine
        provider._stockfish_path = str(engine)
        provider.engine_id = "eei_mine"
        work = {"sessionId": "s", "threads": 1, "hash": 16, "multiPv": 1, "variant": "chess",
                "initialFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "moves": [], "movetime": 500}
        ask = lambda **body: self.client.post("/api/lichess-engine/analyse", json={"engineId": "eei_mine", "work": work, **body})

        # The app starts paused (fail-closed): nothing until the lock says no game is on.
        paused = ask()
        self.assertEqual(paused.status_code, 200)
        self.assertEqual([json.loads(l) for l in paused.text.splitlines()],
                         [{"time": 0, "depth": 0, "nodes": 0, "pvs": [], "bestmove": "(none)"}])
        self.assertIsNone(provider._engine)

        self.client.put("/api/lichess-engine/paused", json={"paused": False})
        res = ask()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.headers["content-type"].startswith("application/x-ndjson"))
        self.assertNotIn("gzip", res.headers.get("content-encoding", ""))
        lines = [json.loads(l) for l in res.text.splitlines()]
        self.assertEqual(lines[0], {"time": 3, "depth": 7, "nodes": 700,
                                    "pvs": [{"moves": ["e2e4", "e7e5"], "cp": 25, "depth": 7}]})
        self.assertEqual(lines[-1]["bestmove"], "e2e4")

        # Not this app's engine (another external engine chosen in Lichess):
        # the extension sends it to Lichess's broker as before.
        self.assertEqual(ask(engineId="eei_other").status_code, 404)
        self.assertEqual(ask(work={**work, "variant": "atomic"}).status_code, 400)
        provider.engine_id = None
        self.assertEqual(ask().status_code, 404)
        provider.engine_id = "eei_mine"
        provider._stockfish_path = str(Path(self.temp_dir.name) / "missing")
        self.assertEqual(ask().status_code, 503)

    def test_websites_cannot_start_lichess_analysis(self):
        # A website may send a plain-text POST without asking first; only JSON
        # (which needs CORS, which this service never grants) is taken.
        res = self.client.post("/api/lichess-engine/analyse", content='{"engineId":"x","work":{}}',
                               headers={"Content-Type": "text/plain", "Origin": "https://example.com"})
        self.assertEqual(res.status_code, 415)

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
