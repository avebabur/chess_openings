import asyncio
import json
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import httpx

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import lichess_engine_provider as lep  # noqa: E402

FAKE_ENGINE = textwrap.dedent("""
    import sys, threading, time
    # Positions ending in "moves e2e4" are answered with e7e5, others with e2e4.
    # "go infinite" keeps printing until "stop", like a real engine.
    out = threading.Lock(); stop = threading.Event(); best = ["e2e4"]
    def say(text):
        with out:
            print(text); sys.stdout.flush()
    def think():
        depth = 0
        while not stop.is_set():
            depth += 1
            say(f"info depth {depth} score cp {depth} nodes {depth * 100} pv {best[0]}")
            time.sleep(0.02)
        say(f"bestmove {best[0]}")
    for line in sys.stdin:
        cmd = line.strip()
        if cmd == "uci":
            say("id name Fake"); say("uciok")
        elif cmd == "isready":
            say("readyok")
        elif cmd.startswith("position"):
            best[0] = "e7e5" if cmd.endswith("moves e2e4") else "e2e4"
        elif cmd == "go infinite":
            stop.clear(); threading.Thread(target=think, daemon=True).start()
        elif cmd.startswith("go"):
            for depth in (1, 2, 3):
                say(f"info depth {depth} score cp {depth * 10} nodes {depth * 100} pv {best[0]}")
            say("info depth 4 score cp 40 upperbound nodes 400")  # stopped mid-depth: no pv
            say(f"info depth 4 score cp 41 lowerbound nodes 410 pv {best[0]}")  # a bound report
            say(f"bestmove {best[0]}")
        elif cmd == "stop":
            stop.set()
        elif cmd == "quit":
            break
""")


def _job(**search):
    work = {"sessionId": "s1", "threads": 1, "hash": 16, "multiPv": 1,
            "variant": "chess", "initialFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "moves": [], **search}
    return {"id": "job1", "work": work}


class SearchCommandTests(unittest.TestCase):
    def test_practice_is_served_as_lichess_asks_by_default(self):
        self.assertEqual(lep.search_command({"nodes": 600000}, 0), ("go nodes 600000", False))

    def test_a_practice_time_turns_the_node_limit_into_a_timed_search_sent_at_the_end(self):
        self.assertEqual(lep.search_command({"nodes": 600000}, 8), ("go movetime 8000", True))
        self.assertEqual(lep.search_command({"by": {"nodes": 600000}}, 8), ("go movetime 8000", True))

    def test_analysis_limits_pass_through(self):
        self.assertEqual(lep.search_command({"movetime": 8000}), ("go movetime 8000", False))
        self.assertEqual(lep.search_command({"depth": 30}), ("go depth 30", False))
        self.assertEqual(lep.search_command({}), ("go infinite", False))


class CompleteReportTests(unittest.TestCase):
    def test_an_early_finish_reports_the_full_limit_that_was_asked(self):
        info = "depth 245 seldepth 9 multipv 1 score mate 3 nodes 4412 nps 1000 time 3 pv h5h4 b3b2"
        self.assertIn("nodes 600000", lep.complete_report(info, {"nodes": 600000}))
        self.assertIn("time 8000", lep.complete_report(info, {"movetime": 8000}))

    def test_a_search_that_used_its_limit_is_left_alone(self):
        info = "depth 20 multipv 1 score cp 30 nodes 700000 time 900 pv e2e4"
        self.assertEqual(lep.complete_report(info, {"nodes": 600000}), info)


class RegistrationTests(unittest.TestCase):
    def _provider(self, handler, token="tok"):
        stored = {}
        return lep.LichessEngineProvider(
            token_getter=lambda: token,
            secret_store=lambda value=None: stored.__setitem__("s", value) if value else stored.get("s"),
            stockfish_path=sys.executable,
            transport=httpx.MockTransport(handler),
        ), stored

    def _register(self, provider):
        async def go():
            async with httpx.AsyncClient(transport=provider._transport) as http:
                return await provider._register(http)
        return asyncio.run(go())

    def test_without_a_token_nothing_is_sent(self):
        provider, _ = self._provider(lambda request: self.fail("no request expected"), token=None)
        self.assertIsNone(self._register(provider))
        self.assertEqual(provider.state, "no_token")

    def test_a_token_without_engine_access_is_reported(self):
        provider, _ = self._provider(lambda request: httpx.Response(403))
        self.assertIsNone(self._register(provider))
        self.assertEqual(provider.state, "missing_scope")

    def test_first_registration_creates_the_engine_with_a_kept_secret(self):
        seen = []

        def handler(request):
            seen.append((request.method, request.url.path))
            if request.method == "GET":
                return httpx.Response(200, json=[{"id": "other", "name": "Something else"}])
            body = json.loads(request.content)
            self.assertEqual(body["name"], lep.ENGINE_NAME)
            return httpx.Response(200, json={"id": "eei_new", **body})

        provider, stored = self._provider(handler)
        secret = self._register(provider)
        self.assertEqual(provider.state, "ready")
        self.assertEqual(provider.engine_id, "eei_new")
        self.assertEqual(stored["s"], secret)
        self.assertEqual(seen, [("GET", "/api/external-engine"), ("POST", "/api/external-engine")])

    def test_an_existing_registration_is_updated_not_duplicated(self):
        seen = []

        def handler(request):
            seen.append(request.method)
            if request.method == "GET":
                return httpx.Response(200, json=[{"id": "eei_old", "name": lep.ENGINE_NAME}])
            return httpx.Response(200, json={})

        provider, _ = self._provider(handler)
        self._register(provider)
        self.assertEqual(seen, ["GET", "PUT"])
        self.assertEqual(provider.engine_id, "eei_old")


class AnalyseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        script = Path(self.tmp.name) / "fake.py"
        script.write_text(FAKE_ENGINE)
        self.engine_path = Path(self.tmp.name) / "fake-engine"
        self.engine_path.write_text(f"#!/bin/sh\nexec {sys.executable} {script}\n")
        self.engine_path.chmod(self.engine_path.stat().st_mode | stat.S_IEXEC)

    def tearDown(self):
        self.tmp.cleanup()

    def _lines(self, job):
        async def go():
            engine = await lep.UciProcess.create(str(self.engine_path))
            try:
                return [chunk.decode().strip() async for chunk in engine.analyse(job, asyncio.Event(), 0.01)]
            finally:
                await engine.terminate()
        return asyncio.run(go())

    def test_a_search_ending_early_restates_its_last_report_as_complete(self):
        lines = self._lines(_job(nodes=600000))
        self.assertTrue(lines[-2].startswith("info") and "nodes 600000" in lines[-2], lines[-2])
        self.assertEqual(lines[-1], "bestmove e2e4")

    def test_analysis_streams_every_line_with_a_move_line(self):
        # The last, pv-less report must not reach Lichess: it crashed Practice.
        lines = self._lines(_job(movetime=100))
        self.assertEqual(len([l for l in lines if l.startswith("info")]), 3)
        self.assertTrue(all(" pv " in l for l in lines if l.startswith("info")))
        self.assertEqual(lines[-1], "bestmove e2e4")

    def test_an_abandoned_search_never_answers_the_next_job(self):
        # Lichess cancels a search (you moved), the upload breaks, and the
        # generator is dropped without being closed. The next job must get
        # its own answer, not the old search's bestmove.
        async def go():
            engine = await lep.UciProcess.create(str(self.engine_path))
            try:
                first = engine.analyse(_job(), asyncio.Event(), 0)
                await first.__anext__()          # it is searching ("go infinite")
                # ...and is abandoned here, never closed.
                second = _job(movetime=100)
                second["work"]["moves"] = ["e2e4"]
                return [c.decode().strip() async for c in engine.analyse(second, asyncio.Event(), 0)]
            finally:
                await engine.terminate()
        lines = asyncio.run(go())
        self.assertEqual(lines[-1], "bestmove e7e5")
        self.assertTrue(any(l.startswith("info") for l in lines))

    def test_practice_sends_only_the_final_line_and_the_move(self):
        lines = self._lines(_job(nodes=600000))
        self.assertEqual(lines, ["info depth 3 score cp 30 nodes 600000 pv e2e4", "bestmove e2e4"])


if __name__ == "__main__":
    unittest.main()
