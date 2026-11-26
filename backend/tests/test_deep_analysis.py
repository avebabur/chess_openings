"""Deep analysis (deep_analysis.py): study chapters analysed by themselves,
on the same Stockfish as Lichess's engine bar, which always comes first."""
import asyncio
import sqlite3
import stat
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import deep_analysis as da  # noqa: E402
import lichess_engine_provider as lep  # noqa: E402

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Answers "go movetime …" with depths 1..3 (score cp 10*depth from the side
# to move), or, for 99 s, keeps searching until "stop". Logs every command.
FAKE_ENGINE = textwrap.dedent("""
    import sys, threading, time
    log = open(sys.argv[1], "a")
    out = threading.Lock(); stop = threading.Event()
    def say(text):
        with out:
            print(text); sys.stdout.flush()
    def think():
        depth = 0
        while not stop.is_set():
            depth += 1
            say(f"info depth {depth} multipv 1 score cp {depth} nodes {depth * 1000} time {depth} pv e2e4")
            time.sleep(0.02)
        say("bestmove e2e4")
    for line in sys.stdin:
        cmd = line.strip()
        log.write(cmd + "\\n"); log.flush()
        if cmd == "uci":
            say("id name Fake"); say("uciok")
        elif cmd == "isready":
            say("readyok")
        elif cmd == "go movetime 99000":
            stop.clear(); threading.Thread(target=think, daemon=True).start()
        elif cmd.startswith("go movetime"):
            for d in range(1, 4):
                say(f"info depth {d} multipv 1 score cp {10 * d} upperbound nodes {d * 1000}")
                say(f"info depth {d} multipv 1 score cp {10 * d} nodes {d * 1000} time {d} pv e2e4 e7e5")
            say("bestmove e2e4")
        elif cmd.startswith("go"):
            say("info depth 1 score cp 5 nodes 100 pv e2e4"); say("bestmove e2e4")
        elif cmd == "stop":
            stop.set()
        elif cmd == "quit":
            break
""")


def _schema(path):
    import database
    conn = sqlite3.connect(path)
    conn.executescript(database.SCHEMA)
    conn.close()

    def connect():
        c = sqlite3.connect(path)
        c.row_factory = sqlite3.Row
        return c
    return connect


class PositionsTests(unittest.TestCase):
    def test_every_position_of_the_line_with_lichess_plies(self):
        root, positions = da.positions_of("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", ["e7e5"])
        self.assertEqual([p["ply"] for p in positions], [1, 2])
        self.assertEqual(positions[1]["moves"], ["e7e5"])
        self.assertTrue(root.startswith("rnbqkbnr/pppppppp/8/8/4P3"))

    def test_castling_is_sent_as_king_takes_rook(self):
        _, positions = da.positions_of("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ["e1g1"])
        self.assertEqual(positions[1]["moves"], ["e1h1"])

    def test_a_finished_game_is_marked_over(self):
        _, positions = da.positions_of(START, ["f2f3", "e7e5", "g2g4", "d8h4"])
        self.assertEqual([p["over"] for p in positions], [False] * 4 + [True])

    def test_illegal_input_is_refused(self):
        for fen, moves in ((START, ["e2e5"]), ("nonsense", []), (START, "e2e4"), (START, ["e2e4"] * 601)):
            with self.assertRaises(da.InvalidChapter):
                da.positions_of(fen, moves)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = da.DeepEvalStore(_schema(str(Path(self.tmp.name) / "t.db")))

    def tearDown(self):
        self.tmp.cleanup()

    def _result(self, depth, nodes=1000, seconds=1.0, source="engine", cp=10):
        return {"depth": depth, "cp": cp, "mate": None, "pv": ["e2e4", "e7e5"], "nodes": nodes,
                "seconds": seconds, "source": source}

    def test_the_deeper_result_is_kept_and_the_longest_time(self):
        self.store.save("k", self._result(40, source="cloud", seconds=0))
        kept = self.store.save("k", self._result(34, seconds=90, cp=99))
        self.assertEqual((kept["depth"], kept["source"], kept["cp"], kept["seconds"]), (40, "cloud", 10, 90))
        self.store.save("k", self._result(45, cp=7))
        self.assertEqual(self.store.get(["k", "other"]), {"k": {**self._result(45, cp=7), "seconds": 90}})


class RunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        script = tmp / "fake.py"
        script.write_text(FAKE_ENGINE)
        self.log = tmp / "engine.log"
        self.engine_path = tmp / "fake-engine"
        self.engine_path.write_text(f"#!/bin/sh\nexec {sys.executable} {script} {self.log}\n")
        self.engine_path.chmod(self.engine_path.stat().st_mode | stat.S_IEXEC)
        self.store = da.DeepEvalStore(_schema(str(tmp / "t.db")))
        self.cloud_asked = []
        self.quiet = lep.QUIET_SECONDS
        lep.QUIET_SECONDS = 0.2

    def tearDown(self):
        lep.QUIET_SECONDS = self.quiet
        self.tmp.cleanup()

    async def cloud(self, http, fen):
        self.cloud_asked.append(fen)
        if fen == START:
            return {"depth": 50, "cp": 20, "mate": None, "pv": ["e2e4"], "nodes": 10**9, "seconds": 0,
                    "source": "cloud"}
        return None

    def _analysis(self, **options):
        provider = lep.LichessEngineProvider(token_getter=lambda: None, stockfish_path=str(self.engine_path))
        provider.engine_id = "eei_mine"
        options = {"max_seconds": 5, "idle_pause": 0.05, **options}
        return provider, da.DeepAnalysis(provider, store=self.store, cloud=self.cloud, **options)

    @staticmethod
    async def _until(check, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            value = await check()
            if value:
                return value
            await asyncio.sleep(0.05)
        raise AssertionError("timed out")

    def _commands(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_cloud_first_then_stockfish_backwards_then_saved(self):
        async def go():
            provider, deep = self._analysis()
            deep.start()
            try:
                async def finished():
                    status = await deep.request("chap1", START, ["e2e4", "e7e5"])
                    return status if status["state"] == "done" else None
                status = await self._until(finished)
            finally:
                await deep.stop()
                await provider.stop()
            # A new service (the app restarted): the saved results, no search.
            provider2, again = self._analysis()
            try:
                return status, await again.request("chap1", START, ["e2e4", "e7e5"])
            finally:
                await provider2.stop()

        status, again = asyncio.run(go())
        by_ply = {r["ply"]: r for r in status["results"]}
        self.assertEqual((status["done"], status["total"]), (3, 3))
        self.assertEqual(by_ply[0]["source"], "cloud")
        self.assertEqual(len(self.cloud_asked), 2)  # stopped at the first position it lacked
        self.assertEqual((by_ply[1]["source"], by_ply[1]["depth"]), ("engine", 3))
        self.assertEqual(by_ply[1]["cp"], -30)      # Black to move: from White's side
        self.assertEqual(by_ply[2]["cp"], 30)
        searched = [c for c in self._commands() if c.startswith("position")]
        self.assertEqual(searched, [f"position fen {START} moves e2e4 e7e5", f"position fen {START} moves e2e4"])
        self.assertIn("go movetime 5000", self._commands())  # the full time, no depth limit
        self.assertTrue(by_ply[1]["complete"])  # depth 3, below the cloud's 38: done by the time
        self.assertNotIn("ucinewgame", self._commands())  # the memory is kept
        self.assertEqual((again["state"], again["done"]), ("done", 3))

    def test_a_result_stopped_at_depth_38_by_the_old_rule_is_searched_again(self):
        _, positions = da.positions_of(START, ["e2e4"])
        old = {"depth": 40, "cp": 30, "mate": None, "pv": ["e7e5"], "nodes": 10**6, "seconds": 1.2, "source": "engine"}
        self.store.save(positions[1]["key"], old)

        async def go():
            provider, deep = self._analysis()
            deep.start()
            try:
                async def finished():
                    status = await deep.request("chap1", START, ["e2e4"])
                    return status if status["state"] == "done" else None
                return await self._until(finished)
            finally:
                await deep.stop()
                await provider.stop()
        status = asyncio.run(go())
        self.assertIn(f"position fen {START} moves e2e4", self._commands())
        kept = {r["ply"]: r for r in status["results"]}[1]
        self.assertEqual((kept["depth"], kept["seconds"]), (40, 5))  # the deeper result stays, now searched in full

    def test_nothing_is_searched_while_lichess_uses_the_engine(self):
        async def go():
            provider, deep = self._analysis()
            provider._last_live = time.monotonic() + 60  # Lichess asked just now
            deep.start()
            try:
                await deep.request("chap1", START, ["e2e4"])
                await asyncio.sleep(0.6)
                return await deep.request("chap1", START, ["e2e4"])
            finally:
                await deep.stop()
                await provider.stop()
        status = asyncio.run(go())
        self.assertEqual(status["state"], "waiting")
        self.assertFalse(any(c.startswith("go") for c in self._commands()))

    def test_a_lichess_request_stops_the_search_which_is_done_again_later(self):
        async def go():
            provider, deep = self._analysis(max_seconds=99)
            deep.start()
            try:
                await deep.request("chap1", START, ["e2e4"])  # 1.e4 first (backwards): no cloud result
                await self._until(lambda: self._async(any(c == "go movetime 99000" for c in self._commands())))
                work, board = lep.sanitize_work({"sessionId": "s1", "threads": 1, "hash": 16, "multiPv": 1,
                                                 "variant": "chess", "initialFen": START, "moves": [],
                                                 "movetime": 100})
                lines = [line async for line in provider.local_analysis(work, board)]
                saved_after_stop = self.store.get([da.positions_of(START, ["e2e4"])[1][1]["key"]])
                await self._until(lambda: self._async(
                    sum(c == "go movetime 99000" for c in self._commands()) >= 2))
                return lines, saved_after_stop
            finally:
                await deep.stop()
                await provider.stop()
        lines, saved = asyncio.run(go())
        self.assertIn(b'"bestmove":"e2e4"', lines[-1])  # Lichess got its answer
        self.assertEqual(saved, {})                      # the stopped search was not taken as a result

    def test_a_closed_chapter_stops_its_search(self):
        async def go():
            provider, deep = self._analysis(max_seconds=99, expiry=0.5)
            deep.start()
            try:
                await deep.request("chap1", START, ["e2e4"])  # the start is the cloud's: 1.e4 is searched
                await self._until(lambda: self._async(any(c == "go movetime 99000" for c in self._commands())))
                await self._until(lambda: self._async("stop" in self._commands()), timeout=5)
                await asyncio.sleep(0.3)
                return provider._deep_task.done()
            finally:
                await deep.stop()
                await provider.stop()
        self.assertTrue(asyncio.run(go()))

    def test_a_paused_chapter_is_not_searched(self):
        async def go():
            provider, deep = self._analysis()
            deep.start()
            try:
                await deep.request("chap1", START, ["e2e4"], paused=True)
                await asyncio.sleep(0.5)
                return await deep.request("chap1", START, ["e2e4"], paused=True)
            finally:
                await deep.stop()
                await provider.stop()
        status = asyncio.run(go())
        self.assertEqual(status["state"], "paused")
        self.assertFalse(any(c.startswith("go") for c in self._commands()))

    @staticmethod
    async def _async(value):
        return value


if __name__ == "__main__":
    unittest.main()
