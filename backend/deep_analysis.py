"""Deep analysis of a study chapter, by itself, on your one Stockfish.

While a study chapter is open, the extension sends its main line
(POST /api/deep-analysis) every second or two and gets back what is done.
Every position Stockfish analyses gets the full SEARCH_SECONDS (90 s, the
user's choice, 2026-11-26), with no depth limit: an easy position (few pieces,
a forced line) goes as deep as Stockfish can, up to its own maximum (depth
245), where it stops by itself; a middlegame reaches about depth 28-36 on an
M2. (At first it stopped at depth 38, which cut endgames off after a second.)

  1. Lichess's cloud evaluation first, from the start of the chapter forward
     until the first position it doesn't have (the opening). A cloud result
     of depth CLOUD_DEPTH (38) or more counts as done.
  2. Then Stockfish, from the last move backwards, keeping its memory between
     positions: the moves after a position are already in it, which makes
     each search deeper in the same time.

Results are saved (table deep_evals, one per position), so a chapter opened
again, or a position met again in another game, costs nothing.

Lichess always comes first: a search here starts only once the engine bar
has been quiet for a few seconds (LichessEngineProvider.deep_search), and any
request from Lichess stops it; that position is searched again later.

Several chapters open at once: the one opened last is analysed first. A
chapter nobody has asked about for JOB_EXPIRY_SECONDS (its tab was closed) is
dropped, and the search for it stops.
"""
import asyncio
import logging
import os
import re
import time

import chess
import httpx

from position_key import position_key

log = logging.getLogger(__name__)

CLOUD_DEPTH = 38      # a cloud result this deep needs no search of ours
SEARCH_SECONDS = 90
JOB_EXPIRY_SECONDS = 150  # Chrome may slow a hidden tab's timers to once a minute
MAX_MOVES = 600
CLOUD_URL = "https://lichess.org/api/cloud-eval"
PAGE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class InvalidChapter(ValueError):
    """The request names no position this service can analyse (400)."""


def positions_of(initial_fen, moves):
    """Every position of a main line: dicts with ply (Lichess's numbering),
    fen, key, the moves from the initial position (UCI, castling as
    king-takes-rook as Stockfish reads them here) and whether play is over."""
    if not isinstance(initial_fen, str) or not isinstance(moves, list) or len(moves) > MAX_MOVES:
        raise InvalidChapter("bad position")
    try:
        board = chess.Board(initial_fen)
    except ValueError as exc:
        raise InvalidChapter("illegal initial position") from exc
    if not board.is_valid():
        raise InvalidChapter("illegal initial position")
    first_ply = 2 * (board.fullmove_number - 1) + (board.turn == chess.BLACK)
    root = board.fen()
    played = []
    out = []

    def add():
        out.append({"ply": first_ply + len(played), "fen": board.fen(), "key": position_key(board),
                    "moves": list(played), "over": board.is_game_over()})

    add()
    for uci in moves:
        try:
            move = board.parse_uci(uci) if isinstance(uci, str) else None
        except ValueError:
            move = None
        if move is None:
            raise InvalidChapter(f"illegal move: {uci!r}"[:80])
        played.append(board.uci(move, chess960=True))
        board.push(move)
        add()
    return root, out


class DeepEvalStore:
    """deep_evals: the deepest result found for each position."""

    def __init__(self, connect=None):
        if connect is None:
            import database as db  # late: database imports half the app
            connect = db.get_db
        self._connect = connect

    def get(self, keys):
        if not keys:
            return {}
        conn = self._connect()
        try:
            found = {}
            keys = list(keys)
            for i in range(0, len(keys), 500):  # SQLite's limit on "?"s
                chunk = keys[i:i + 500]
                rows = conn.execute(
                    f"SELECT * FROM deep_evals WHERE position_key IN ({','.join('?' * len(chunk))})", chunk)
                for row in rows:
                    found[row["position_key"]] = _row(row)
            return found
        finally:
            conn.close()

    def save(self, key, result):
        """Keeps the deeper of the saved result and `result` (depth, then
        nodes), and the most seconds spent. Returns what is saved now."""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            old = conn.execute("SELECT * FROM deep_evals WHERE position_key = ?", (key,)).fetchone()
            old = _row(old) if old else None
            seconds = max(result["seconds"], old["seconds"] if old else 0)
            keep = old if old and (old["depth"], old["nodes"]) >= (result["depth"], result["nodes"]) else result
            keep = {**keep, "seconds": seconds}
            conn.execute(
                "INSERT INTO deep_evals (position_key, depth, cp, mate, pv, nodes, seconds, source, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) "
                "ON CONFLICT(position_key) DO UPDATE SET depth = excluded.depth, cp = excluded.cp, "
                "mate = excluded.mate, pv = excluded.pv, nodes = excluded.nodes, seconds = excluded.seconds, "
                "source = excluded.source, updated_at = excluded.updated_at",
                (key, keep["depth"], keep["cp"], keep["mate"], " ".join(keep["pv"]), keep["nodes"],
                 keep["seconds"], keep["source"]))
            conn.commit()
            return keep
        finally:
            conn.close()


def _row(row):
    return {"depth": row["depth"], "cp": row["cp"], "mate": row["mate"], "pv": row["pv"].split(),
            "nodes": row["nodes"], "seconds": row["seconds"], "source": row["source"]}


async def lichess_cloud(http, fen):
    """Lichess's cloud evaluation of `fen` as a result, None if it has none.
    Raises on anything else (no network, refused): the cloud is then not
    asked again for this chapter."""
    res = await http.get(CLOUD_URL, params={"fen": fen, "multiPv": 1}, timeout=5)
    if res.status_code == 404:
        return None
    res.raise_for_status()
    data = res.json()
    pv = (data.get("pvs") or [{}])[0]
    moves = str(pv.get("moves") or "").split()
    if not moves or not isinstance(data.get("depth"), int) or not ("cp" in pv or "mate" in pv):
        return None
    return {"depth": data["depth"], "cp": pv.get("cp"), "mate": pv.get("mate"), "pv": moves,
            "nodes": int(data.get("knodes") or 0) * 1000, "seconds": 0, "source": "cloud"}


class Job:
    def __init__(self, page_id, root, positions):
        self.page_id = page_id
        self.created = self.seen = time.monotonic()
        self.paused = False
        self.update(root, positions)

    def update(self, root, positions):
        self.root = root
        self.positions = positions
        self.signature = [p["key"] for p in positions]
        self.cloud_from = 0      # where the cloud pass goes on; None once it is over
        self.current = None      # {"ply", "depth", "seconds"} of the search running


class DeepAnalysis:
    def __init__(self, provider, store=None, cloud=lichess_cloud, cloud_depth=CLOUD_DEPTH,
                 max_seconds=SEARCH_SECONDS, expiry=JOB_EXPIRY_SECONDS, idle_pause=0.5):
        self._provider = provider
        self._store = store or DeepEvalStore()
        self._cloud = None if os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK") == "1" else cloud
        self.cloud_depth = cloud_depth
        self.max_seconds = max_seconds
        self._expiry = expiry
        self._idle_pause = idle_pause
        self._jobs = {}
        self._results = {}       # position key -> saved result, for every job's positions
        self._active = None      # the job being worked on
        self._waiting = False    # Lichess is using the engine
        self._wake = asyncio.Event()
        self._task = None
        self._http = None

    # --- what the extension asks ------------------------------------------------
    async def request(self, page_id, initial_fen, moves, paused=False):
        if not isinstance(page_id, str) or not PAGE_ID.match(page_id):
            raise InvalidChapter("bad pageId")
        root, positions = positions_of(initial_fen, moves)
        job = self._jobs.get(page_id)
        if job is None:
            job = self._jobs[page_id] = Job(page_id, root, positions)
        elif job.signature != [p["key"] for p in positions] or job.root != root:
            job.update(root, positions)
            if self._active is job:
                await self._provider.stop_deep()  # the position searched may be gone
        job.seen = time.monotonic()
        if paused != job.paused:
            job.paused = bool(paused)
            if job.paused and self._active is job:
                await self._provider.stop_deep()
        missing = [p["key"] for p in positions if p["key"] not in self._results]
        if missing:
            self._results.update(await asyncio.to_thread(self._store.get, missing))
        self._wake.set()
        return self.status(job)

    def complete(self, result):
        """Done: Stockfish searched it to the end of its time (or its own
        maximum depth), or the cloud has it at CLOUD_DEPTH or deeper. A saved
        result from before the full-time rule (stopped at depth 38 after a
        second) is searched again."""
        if not result:
            return False
        if result["source"] == "cloud" and result["depth"] >= self.cloud_depth:
            return True
        return result["seconds"] >= self.max_seconds * 0.98

    def status(self, job):
        results = []
        done = total = 0
        for p in job.positions:
            if p["over"]:
                continue
            total += 1
            result = self._results.get(p["key"])
            complete = self.complete(result)
            done += complete
            if result:
                results.append({"ply": p["ply"], "fen": p["fen"], **result, "complete": complete})
        if not self._provider.stockfish_found():
            state = "no_engine"
        elif job.paused:
            state = "paused"
        elif done == total:
            state = "done"
        elif self._active is not job:
            state = "queued"
        elif self._waiting:
            state = "waiting"
        else:
            state = "running"
        return {"state": state, "target": {"cloudDepth": self.cloud_depth, "seconds": self.max_seconds},
                "total": total, "done": done, "current": job.current if self._active is job else None,
                "results": results}

    # --- the work ---------------------------------------------------------------
    def start(self):
        self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._http:
            await self._http.aclose()

    def _pick(self):
        """The job to work on (opened last, not paused, not finished) and its
        next step: ("cloud", position), ("search", position) or None."""
        now = time.monotonic()
        for page_id, job in list(self._jobs.items()):
            if now - job.seen > self._expiry:
                del self._jobs[page_id]
        for job in sorted(self._jobs.values(), key=lambda j: j.created, reverse=True):
            if job.paused:
                continue
            step = self._next_step(job)
            if step:
                return job, step
        return None, None

    def _should_stop(self, job):
        """The search for `job` is no longer wanted: its tab closed or it was
        paused, or another chapter was opened since (that one goes first)."""
        if job.paused or job.page_id not in self._jobs or time.monotonic() - job.seen > self._expiry:
            return True
        now = time.monotonic()
        return any(other.created > job.created and not other.paused and now - other.seen <= self._expiry
                   and self._next_step(other) for other in self._jobs.values())

    def _next_step(self, job):
        if job.cloud_from is not None and self._cloud:
            for i in range(job.cloud_from, len(job.positions)):
                p = job.positions[i]
                if not p["over"] and not self.complete(self._results.get(p["key"])):
                    job.cloud_from = i
                    return ("cloud", p)
            job.cloud_from = None
        for p in reversed(job.positions):
            if not p["over"] and not self.complete(self._results.get(p["key"])):
                return ("search", p)
        return None

    async def _run(self):
        while True:
            try:
                job, step = self._pick()
                if self._active is not None and self._active is not job:
                    self._active.current = None
                self._active = job
                if step is None:
                    self._waiting = False
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(self._wake.wait(), 1.0)
                    except asyncio.TimeoutError:
                        pass
                elif step[0] == "cloud":
                    await self._from_cloud(job, step[1])
                else:
                    await self._search(job, step[1])
            except asyncio.CancelledError:
                raise
            except Exception:  # never let one position stop the analysis
                log.exception("Deep analysis")
                await asyncio.sleep(5)

    async def _from_cloud(self, job, position):
        if self._http is None:
            self._http = httpx.AsyncClient()
        try:
            result = await self._cloud(self._http, position["fen"])
        except Exception as exc:  # no network, Lichess refused: Stockfish does the rest
            log.info("Deep analysis: no cloud evaluation (%s)", exc.__class__.__name__)
            result = None
        if result is None:
            job.cloud_from = None
            return
        await self._save(position, result)
        if job.cloud_from is not None:
            job.cloud_from += 1

    async def _search(self, job, position):
        if self._provider.lichess_busy():
            self._waiting = True
            await asyncio.sleep(self._idle_pause)
            return
        job.current = {"ply": position["ply"], "depth": 0, "seconds": 0}

        def progress(depth, seconds):
            job.current = {"ply": position["ply"], "depth": depth, "seconds": round(seconds)}

        self._waiting = False
        search = asyncio.ensure_future(self._provider.deep_search(
            job.root, position["moves"], self.max_seconds * 1000, progress))
        try:
            while not search.done():
                await asyncio.wait([search], timeout=0.5)
                if not search.done() and self._should_stop(job):
                    await self._provider.stop_deep()
            result = search.result()
        finally:
            job.current = None
            if not search.done():  # the service is stopping
                search.cancel()
        if result is None:  # Lichess took the engine: this position again later
            self._waiting = True
            await asyncio.sleep(self._idle_pause)
            return
        white = position["fen"].split()[1] == "w"
        flip = 1 if white else -1
        await self._save(position, {
            "depth": result["depth"],
            "cp": None if result["cp"] is None else result["cp"] * flip,
            "mate": None if result["mate"] is None else result["mate"] * flip,
            "pv": result["pv"], "nodes": result["nodes"], "source": "engine",
            # Stockfish ended the search itself (not interrupted), so it is
            # done: its time used up, or its maximum depth reached sooner.
            # Counted as the full time, or such a position would be searched
            # for ever.
            "seconds": max(result["seconds"], self.max_seconds)})

    async def _save(self, position, result):
        self._results[position["key"]] = await asyncio.to_thread(self._store.save, position["key"], result)
