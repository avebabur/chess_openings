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
    # "go infinite" (and a day's movetime) keeps printing until "stop", like a real engine.
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
        elif cmd in ("go infinite", "go movetime 86400000"):  # Lichess's infinite: a day
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
            self.assertEqual(body["maxThreads"], 3)
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


class PauseTests(unittest.TestCase):
    def _run(self, provider, seconds):
        async def run_for():
            async with httpx.AsyncClient(transport=provider._transport) as http:
                try:
                    await asyncio.wait_for(provider._serve(http, "s"), seconds)
                except asyncio.TimeoutError:
                    pass
        asyncio.run(run_for())

    def test_during_a_game_every_request_is_answered_with_nothing(self):
        answers = []

        def handler(request):
            if request.url.path == "/api/external-engine/work":
                return httpx.Response(200, json={"id": "job1", "work": {"moves": ["e2e4"], "movetime": 1000}})
            answers.append((request.url.path, request.content))
            return httpx.Response(200)

        provider = lep.LichessEngineProvider(
            token_getter=lambda: "tok", secret_store=lambda value=None: "s",
            stockfish_path=sys.executable, transport=httpx.MockTransport(handler),
            poll_pause=0.01, paused=True)
        provider._token_in_use = "tok"
        self.assertTrue(provider.status()["paused"])  # fail-closed until told
        self._run(provider, 0.3)
        # Answered (so Lichess's engine bar shows no error), but with nothing,
        # and Stockfish was never started.
        self.assertTrue(answers)
        self.assertEqual(set(answers), {("/api/external-engine/work/job1", b"bestmove (none)\n")})
        self.assertIsNone(provider._engine)
        self.assertEqual(provider.jobs, 0)
        self.assertEqual(provider.status()["recent"][-1]["ended"], "paused: answered with nothing")

    def test_work_is_taken_again_once_the_game_ends(self):
        polls = []

        def handler(request):
            polls.append(request.url.path)
            return httpx.Response(204)

        provider = lep.LichessEngineProvider(
            token_getter=lambda: "tok", secret_store=lambda value=None: "s",
            stockfish_path=sys.executable, transport=httpx.MockTransport(handler),
            poll_pause=0.01, paused=True)
        provider._token_in_use = "tok"
        asyncio.run(provider.set_paused(False))
        self.assertFalse(provider.status()["paused"])
        self._run(provider, 0.3)
        self.assertIn("/api/external-engine/work", polls)


    def test_a_refusal_is_forgotten_once_the_service_answers_again(self):
        answers = iter([503, 204])

        def handler(request):
            return httpx.Response(next(answers, 204))

        provider = lep.LichessEngineProvider(
            token_getter=lambda: "tok", secret_store=lambda value=None: "s",
            stockfish_path=sys.executable, transport=httpx.MockTransport(handler),
            poll_pause=0.01, paused=False)
        provider._token_in_use = "tok"
        self._run(provider, 0.3)
        # It said "Lichess's engine service answered 503" for as long as no
        # analysis was asked for, with the service long since back.
        self.assertEqual(provider.status()["error"], "")


START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _emit(moves=(), fen=START, lines=()):
    """Feeds UCI lines to BrokerEmit; returns the ndjson objects it sends."""
    work, board = lep.sanitize_work({**_job(moves=list(moves))["work"], "initialFen": fen, "movetime": 100})
    emit = lep.BrokerEmit(board)
    out = []
    for line in lines:
        out += [json.loads(chunk) for chunk in emit.feed(line.encode() + b"\n")]
    return out


class BrokerEmitTests(unittest.TestCase):
    """The page on this computer gets what Lichess's engine broker would have
    sent it (lila-engine src/emit.rs), read by lila's externalEngine.ts."""

    def test_a_report_becomes_one_result_with_its_line(self):
        out = _emit(lines=["info depth 12 seldepth 15 multipv 1 score cp 31 nodes 5000 nps 1 time 40 pv e2e4 e7e5"])
        self.assertEqual(out, [{"time": 40, "depth": 12, "nodes": 5000,
                                "pvs": [{"moves": ["e2e4", "e7e5"], "cp": 31, "depth": 12}]}])

    def test_scores_are_from_whites_side(self):
        out = _emit(moves=["e2e4"], lines=["info depth 5 score cp 20 nodes 9 time 1 pv e7e5",
                                           "info depth 6 score mate 3 nodes 10 time 2 pv e7e5"])
        self.assertEqual(out[0]["pvs"][0]["cp"], -20)
        self.assertEqual(out[1]["pvs"][0]["mate"], -3)
        self.assertNotIn("cp", out[1]["pvs"][0])

    def test_the_end_of_the_search_carries_the_best_move(self):
        out = _emit(lines=["info depth 1 score cp 5 nodes 20 time 1 pv d2d4", "bestmove d2d4 ponder d7d5"])
        self.assertEqual(out[-1], {"time": 1, "depth": 1, "nodes": 20, "bestmove": "d2d4", "ponder": "d7d5",
                                   "pvs": [{"moves": ["d2d4"], "cp": 5, "depth": 1}]})

    def test_the_empty_answer_during_a_game(self):
        self.assertEqual(_emit(lines=["bestmove (none)"]),
                         [{"time": 0, "depth": 0, "nodes": 0, "pvs": [], "bestmove": "(none)"}])

    def test_several_lines_are_sent_once_all_of_them_are_in(self):
        out = _emit(lines=[
            "info depth 8 multipv 1 score cp 30 nodes 100 time 5 pv e2e4",
            "info depth 8 multipv 2 score cp 20 nodes 110 time 6 pv d2d4",
            "info depth 9 multipv 1 score cp 33 nodes 200 time 9 pv e2e4",  # line 2 not yet at depth 9
            "info depth 9 multipv 2 score cp 21 nodes 210 time 10 pv d2d4",
        ])
        self.assertEqual([len(o["pvs"]) for o in out], [1, 2, 2])
        self.assertEqual(out[-1]["depth"], 9)
        self.assertEqual(out[-1]["nodes"], 200)  # as the broker: counts come from line 1
        self.assertEqual([pv["cp"] for pv in out[-1]["pvs"]], [33, 21])

    def test_lines_are_cut_at_thirty_moves_and_at_a_move_that_is_not_legal(self):
        knights = " ".join(["g1f3 g8f6 f3g1 f6g8"] * 10)
        out = _emit(lines=[f"info depth 40 score cp 0 nodes 1 time 1 pv {knights}",
                           "info depth 41 score cp 0 nodes 1 time 1 pv e2e4 e2e4 e7e5"])
        self.assertEqual(len(out[0]["pvs"][0]["moves"]), 30)
        self.assertEqual(out[1]["pvs"][0]["moves"], ["e2e4"])

    def test_castling_is_written_as_the_engine_reads_it(self):
        fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
        out = _emit(fen=fen, lines=["info depth 3 score cp 0 nodes 1 time 1 pv e1g1 e8c8"])
        self.assertEqual(out[0]["pvs"][0]["moves"], ["e1h1", "e8a8"])

    def test_keepalives_pass_through(self):
        self.assertEqual(_emit(lines=['{"keepalive":true}']), [{"keepalive": True}])


class SanitizeWorkTests(unittest.TestCase):
    def test_moves_and_limits_as_the_broker_hands_them_on(self):
        fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
        work, board = lep.sanitize_work({**_job(movetime=8000)["work"], "initialFen": fen,
                                         "moves": ["e1g1"], "hash": 4096, "threads": 64, "multiPv": 0})
        self.assertEqual(work["moves"], ["e1h1"])
        self.assertEqual((work["hash"], work["threads"], work["multiPv"]), (lep.MAX_HASH_MB, lep.ENGINE_THREADS, 1))
        self.assertEqual(work["movetime"], 8000)
        self.assertEqual(board.turn, False)

    def test_what_the_broker_refuses(self):
        base = _job(movetime=100)["work"]
        for bad in ({**base, "variant": "atomic"}, {**base, "multiPv": 6}, {**base, "moves": ["e2e5"]},
                    {**base, "initialFen": "8/8/8/8/8/8/8/8 w - - 0 1"}, {**base, "moves": ["g1f3", "g8f6", "f3g1", "f6g8"] * 151},
                    {k: v for k, v in base.items() if k != "movetime"}, {**base, "hash": 0}, None, {**base, "moves": "e2e4"}):
            with self.assertRaises(lep.InvalidWork, msg=repr(bad)[:80]):
                lep.sanitize_work(bad)

    def test_a_search_nested_under_by_is_read_too(self):
        work, _ = lep.sanitize_work({**_job()["work"], "by": {"nodes": 600000}})
        self.assertEqual(work["nodes"], 600000)


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

    def test_analysis_and_practice_use_three_threads(self):
        async def go():
            engine = await lep.UciProcess.create(str(self.engine_path))
            try:
                for job in (_job(threads=2, movetime=100), _job(threads=8, nodes=600000)):
                    record = {}
                    lines = [line async for line in engine.analyse(job, asyncio.Event(), record=record)]
                    self.assertEqual(lines[-1], b"bestmove e2e4\n")
                    self.assertEqual(engine.options["Threads"], 3)
                    self.assertEqual(record["threads"], 3)
            finally:
                await engine.terminate()

        asyncio.run(go())

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

    def test_search_paused_before_go_sends_no_analysis(self):
        async def go():
            engine = await lep.UciProcess.create(str(self.engine_path))
            try:
                started = asyncio.Event()
                lines = [line async for line in engine.analyse(_job(), started, interrupted=lambda: True)]
                self.assertEqual(lines, [lep.EMPTY_SEARCH])
                self.assertTrue(started.is_set())
                self.assertFalse(engine.searching)
            finally:
                await engine.terminate()

        asyncio.run(go())

    def test_pausing_active_search_discards_remaining_lines_and_move(self):
        async def go():
            engine = await lep.UciProcess.create(str(self.engine_path))
            paused = False
            try:
                lines = engine.analyse(_job(), asyncio.Event(), interrupted=lambda: paused)
                self.assertTrue((await anext(lines)).startswith(b"info"))
                paused = True
                await engine.stop()
                self.assertEqual([line async for line in lines], [lep.EMPTY_SEARCH])
                self.assertFalse(engine.searching)
            finally:
                await engine.terminate()

        asyncio.run(go())


class LocalAnalysisTests(unittest.TestCase):
    """POST /api/lichess-engine/analyse: the page on this computer is answered
    directly, with no trip through Lichess's engine broker."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        script = Path(self.tmp.name) / "fake.py"
        script.write_text(FAKE_ENGINE)
        self.engine_path = Path(self.tmp.name) / "fake-engine"
        self.engine_path.write_text(f"#!/bin/sh\nexec {sys.executable} {script}\n")
        self.engine_path.chmod(self.engine_path.stat().st_mode | stat.S_IEXEC)

    def tearDown(self):
        self.tmp.cleanup()

    def _provider(self, paused=False):
        provider = lep.LichessEngineProvider(token_getter=lambda: None, stockfish_path=str(self.engine_path), paused=paused)
        provider.engine_id = "eei_mine"
        return provider

    @staticmethod
    def _work(**search):
        return lep.sanitize_work(_job(**search)["work"])

    def test_a_search_streams_results_and_ends_with_the_move(self):
        async def go():
            provider = self._provider()
            try:
                return [json.loads(c) async for c in provider.local_analysis(*self._work(movetime=100))], provider
            finally:
                await provider.stop()
        out, provider = asyncio.run(go())
        self.assertEqual([o["depth"] for o in out[:-1]], [1, 2, 3])
        self.assertEqual(out[-1]["bestmove"], "e2e4")
        self.assertTrue(all(o["pvs"] and o["pvs"][0]["moves"] == ["e2e4"] for o in out))
        status = provider.status()
        self.assertEqual((status["jobs"], status["local_jobs"]), (1, 1))
        self.assertEqual(status["recent"][-1]["via"], "local")

    def test_during_a_game_it_answers_with_nothing_and_never_starts_stockfish(self):
        async def go():
            provider = self._provider(paused=True)
            out = [json.loads(c) async for c in provider.local_analysis(*self._work(movetime=100))]
            return out, provider
        out, provider = asyncio.run(go())
        self.assertEqual(out, [{"time": 0, "depth": 0, "nodes": 0, "pvs": [], "bestmove": "(none)"}])
        self.assertIsNone(provider._engine)
        self.assertEqual(provider.jobs, 0)

    def test_a_game_starting_mid_search_stops_it(self):
        async def go():
            provider = self._provider()
            try:
                stream = provider.local_analysis(*self._work(movetime=86400000))  # infinite
                first = json.loads(await anext(stream))
                await provider.set_paused(True)
                rest = [json.loads(c) async for c in stream]
                return first, rest, provider._engine.searching
            finally:
                await provider.stop()
        first, rest, searching = asyncio.run(go())
        self.assertTrue(first["pvs"])
        self.assertEqual(rest[-1]["bestmove"], "(none)")
        self.assertFalse(searching)

    def test_a_new_request_stops_the_search_in_progress(self):
        async def go():
            provider = self._provider()
            try:
                first = provider.local_analysis(*self._work(movetime=86400000))  # infinite
                await anext(first)
                work, board = self._work(movetime=100)
                work["moves"] = ["e2e4"]
                second = asyncio.ensure_future(self._collect(provider.local_analysis(*lep.sanitize_work(work))))
                rest = [json.loads(c) async for c in first]
                return rest, await asyncio.wait_for(second, 5)
            finally:
                await provider.stop()
        rest, second = asyncio.run(go())
        self.assertIn("bestmove", rest[-1])            # the old search ended
        self.assertEqual(second[-1]["bestmove"], "e7e5")  # the new one got its own answer
        self.assertTrue(all(o["pvs"][0]["moves"] == ["e7e5"] for o in second))

    @staticmethod
    async def _collect(stream):
        return [json.loads(c) async for c in stream]

    def test_closing_the_stream_stops_stockfish(self):
        async def go():
            provider = self._provider()
            try:
                stream = provider.local_analysis(*self._work(movetime=86400000))  # infinite
                await anext(stream)
                task = provider._job_task
                await stream.aclose()                   # Lichess cancelled (you moved on)
                await asyncio.wait_for(asyncio.shield(task), 5)
                return provider._engine.searching, provider.status()["recent"][-1]["ended"]
            finally:
                await provider.stop()
        searching, ended = asyncio.run(go())
        self.assertFalse(searching)
        self.assertEqual(ended, "cancelled")

    def test_broker_jobs_wait_for_a_local_search_to_stop(self):
        # One Stockfish for both paths: a job from the broker stops the local
        # search first, as it would stop another broker job.
        answers = []

        def handler(request):
            if request.url.path == "/api/external-engine/work":
                if answers:
                    return httpx.Response(204)
                answers.append("taken")
                return httpx.Response(200, json=_job(movetime=100))
            answers.append(request.content)
            return httpx.Response(200)

        async def go():
            provider = self._provider()
            provider._transport = httpx.MockTransport(handler)
            provider._token_getter = lambda: "tok"
            provider._token_in_use = "tok"
            try:
                stream = provider.local_analysis(*self._work(movetime=86400000))  # infinite
                await anext(stream)
                async with httpx.AsyncClient(transport=provider._transport) as http:
                    serve = asyncio.ensure_future(provider._serve(http, "s"))
                    rest = [json.loads(c) async for c in stream]
                    await asyncio.sleep(0.5)
                    serve.cancel()
                return rest, provider.status()
            finally:
                await provider.stop()
        rest, status = asyncio.run(go())
        self.assertIn("bestmove", rest[-1])
        self.assertTrue(any(isinstance(a, bytes) and a.endswith(b"bestmove e2e4\n") for a in answers), answers)
        self.assertEqual(status["local_jobs"], 1)
        self.assertEqual(status["jobs"], 2)


if __name__ == "__main__":
    unittest.main()
