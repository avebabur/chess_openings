"""Your Stockfish inside Lichess, through Lichess's official "external engine".

The app registers this Mac's Stockfish with the user's Lichess account, then
answers Lichess's analysis requests. Lichess's own engine bar, eval bar and
"Practice with computer" then run on this Mac instead of in the browser, so
only one Stockfish ever runs. Requests travel through Lichess's engine broker:
the browser never talks to this app for engine work.

Protocol as in lichess-org/external-engine's example-provider.py (Sept 2026):
  * register:  GET/POST/PUT https://lichess.org/api/external-engine (OAuth token
    with engine:read + engine:write; Lichess accepts nothing else for creating)
  * get work:  POST https://engine.lichess.ovh/api/external-engine/work
               {"providerSecret"} -> 200 job | 204 nothing yet (long poll)
  * answer:    POST .../work/{job id} with the engine's UCI "info"/"bestmove"
               lines, streamed as they come.

"Practice with computer" is served exactly as Lichess asks (a quick
node-limited search; Mastery mode uses your search time) unless
OPENINGS_PRACTICE_SECONDS is set.

The Lichess page on this computer skips the broker: the extension sends its
analysis request to POST /api/lichess-engine/analyse (local_analysis below),
answered with exactly what the broker would have streamed. Through the broker
every position cost three requests against its per-address limit, and
stepping through a game ran into it ("Loading engine" at every other move).
The broker registration stays: Lichess lists the engine only because of it.

Every job first makes sure no earlier search is still running (see
UciProcess.settle): an abandoned search used to hand its stale bestmove to the
next job, which left Practice stuck.
"""
import asyncio
import collections
import json
import logging
import os
import secrets
import subprocess
import time

import chess
import httpx

import stockfish

log = logging.getLogger(__name__)

LICHESS = "https://lichess.org"
BROKER = "https://engine.lichess.ovh"
# Short on purpose: Lichess's engine bar shows the name next to its own
# "EXTERNAL" tag in a narrow space, and a longer name cut that tag off.
ENGINE_NAME = "Your Stockfish"
# What earlier versions registered it as. Found under one of these, the same
# registration (and so the engine id Lichess pages have chosen) is renamed.
FORMER_ENGINE_NAMES = ("Your Stockfish (openings app)",)
TOKEN_URL = (
    "https://lichess.org/account/oauth/token/create"
    "?scopes[]=engine:read&scopes[]=engine:write&description=Openings+app"
)


def _sysctl(name):
    return subprocess.run(["/usr/sbin/sysctl", "-n", name], capture_output=True,
                          text=True, check=True, timeout=2).stdout


def engine_threads(sysctl=_sysctl, cpu_count=os.cpu_count):
    """One Stockfish thread per performance core. On an Apple chip the
    efficiency cores are several times slower; a thread there adds few nodes
    and leaves the Mac nothing to run anything else on (an M2: 4 + 4 cores,
    4 threads 1.6M nodes/s, 3 threads 1.24M). Elsewhere: every physical core."""
    for name in ("hw.perflevel0.physicalcpu", "hw.physicalcpu"):
        try:
            count = int(sysctl(name))
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
        if count > 0:
            return count
    return cpu_count() or 3


ENGINE_THREADS = engine_threads()
MAX_HASH_MB = 1024
KEEP_ALIVE_SECONDS = 300  # an idle Stockfish is closed after this
# 0 = do what Lichess asks (its normal Practice searches ~600k nodes, under a
# second here; its Mastery mode uses your search time, 8 s by default). A number
# makes every normal-Practice search that many seconds, sent at the end.
PRACTICE_SECONDS = float(os.environ.get("OPENINGS_PRACTICE_SECONDS", "0"))
SECRET_SETTING = "lichess_engine_secret"
DEEP_HASH_MB = 256  # a background search before Lichess asked for any size
# A background search starts only once Lichess has asked nothing for this long.
QUIET_SECONDS = 3.0
EMPTY_SEARCH = b"bestmove (none)\n"


def search_command(work, practice_seconds=PRACTICE_SECONDS):
    """The UCI ``go`` for a Lichess work request, and whether to hold back the
    intermediate lines (Practice) instead of streaming them."""
    # Lichess spreads its search spec into the work; custom searches (Practice)
    # may still carry it nested as {"by": {"nodes": …}}.
    if isinstance(work.get("by"), dict):
        work = {**work, **work["by"]}
    if "nodes" in work:
        if practice_seconds:
            return f"go movetime {int(practice_seconds * 1000)}", True
        return f"go nodes {int(work['nodes'])}", False
    if "movetime" in work:
        return f"go movetime {int(work['movetime'])}", False
    if "depth" in work:
        return f"go depth {int(work['depth'])}", False
    return "go infinite", False


def complete_report(info, work):
    """The last report of a search that ended early, claiming the full limit.

    Lichess's Practice moves for the computer only once a result shows the
    search is complete: enough nodes (600k), or its time used up. In a forced
    mate Stockfish stops after a few thousand nodes and milliseconds, and the
    "bestmove" signal doesn't reach Practice, so it waited forever on
    "Computer thinking" (Lichess's in-browser engine hung the same way). The
    search really is complete there, so report the limit that was asked for.
    """
    words = info.split()
    def bump(key, floor):
        if floor and key in words:
            i = words.index(key) + 1
            if i < len(words) and words[i].isdigit() and int(words[i]) < floor:
                words[i] = str(int(floor))
    bump("nodes", work.get("nodes"))
    bump("time", work.get("movetime"))
    return " ".join(words)


def registration(secret):
    return {
        "name": ENGINE_NAME,
        "maxThreads": ENGINE_THREADS,
        "maxHash": MAX_HASH_MB,
        "variants": ["chess"],
        "providerSecret": secret,
    }


# --- What Lichess's engine broker does, for the page on this computer ----------
# lila-engine (Sept 2026): src/api.rs Work::sanitize checks the page's request
# and hands it on; src/emit.rs turns the provider's UCI lines into the ndjson
# that lila's ui/lib/src/ceval/engines/externalEngine.ts reads.
MAX_MOVES = 600
PV_MOVES = 30
UCI_MOVE = frozenset("abcdefgh12345678qrbnkPNBRQK@")


class InvalidWork(ValueError):
    """The broker would refuse this request (400)."""


def _whole(value, name, low=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < low:
        raise InvalidWork(f"bad {name}")
    return value


def sanitize_work(work):
    """The work Lichess's broker would hand this provider for a page's
    request, and the position searched; InvalidWork if it would refuse."""
    if not isinstance(work, dict):
        raise InvalidWork("no work")
    if isinstance(work.get("by"), dict):  # as search_command reads it
        work = {**{k: v for k, v in work.items() if k != "by"}, **work["by"]}
    search = next(({k: work[k]} for k in ("movetime", "depth", "nodes") if k in work), None)
    if search is None:
        raise InvalidWork("no search limit")
    for name, value in search.items():
        _whole(value, name)
    if work.get("variant") != "chess":  # what this engine is registered for
        raise InvalidWork("unsupported variant")
    multi_pv = _whole(work.get("multiPv"), "multiPv")
    if multi_pv > 5:
        raise InvalidWork("multiPv: supported range is 1 to 5")
    session = work.get("sessionId")
    if not isinstance(session, str) or not session:
        raise InvalidWork("bad sessionId")
    fen, moves = work.get("initialFen"), work.get("moves")
    if not isinstance(fen, str) or not isinstance(moves, list):
        raise InvalidWork("bad position")
    if len(moves) > MAX_MOVES:
        raise InvalidWork("too many moves")
    try:
        board = chess.Board(fen, chess960=True)
    except ValueError as exc:
        raise InvalidWork(f"illegal initial position: {exc}") from exc
    if not board.is_valid():
        raise InvalidWork("illegal initial position")
    initial_fen = board.fen()
    played = []
    for uci in moves:
        try:
            move = board.parse_uci(uci) if isinstance(uci, str) else None
        except ValueError:
            move = None
        if move is None:
            raise InvalidWork(f"illegal uci move: {uci!r}"[:80])
        # Castling as king-takes-rook: Stockfish runs with UCI_Chess960.
        played.append(board.uci(move, chess960=True))
        board.push(move)
    return {
        "sessionId": session,
        "threads": min(_whole(work.get("threads"), "threads", 1), ENGINE_THREADS),
        "hash": min(_whole(work.get("hash"), "hash", 1), MAX_HASH_MB),
        **search,
        "multiPv": max(1, multi_pv),
        "variant": "chess",
        "initialFen": initial_fen,
        "moves": played,
    }, board


def _parse_info(words):
    """The fields of a UCI "info" line that the broker reads (src/uci.rs)."""
    info = {}
    i = 0
    while i < len(words):
        key = words[i]
        i += 1
        if key in ("multipv", "depth", "time", "nodes") and i < len(words):
            try:
                info[key] = int(words[i])
            except ValueError:
                return None  # the broker stops at a line it can't read
            i += 1
        elif key == "score" and i + 1 < len(words) and words[i] in ("cp", "mate"):
            try:
                info["score"] = (words[i], int(words[i + 1]))
            except ValueError:
                return None
            i += 2
            while i < len(words) and words[i] in ("lowerbound", "upperbound"):
                info["bound"] = True
                i += 1
        elif key == "pv":
            pv = []
            while i < len(words) and 4 <= len(words[i]) <= 5 and set(words[i]) <= UCI_MOVE:
                pv.append(words[i])
                i += 1
            info["pv"] = pv
        elif key == "string":
            break
    return info


class BrokerEmit:
    """lila-engine's Emit: the provider's lines in, the page's ndjson out.

    Each result is a snapshot of every line (MultiPV) at the newest depth,
    sent once all of them are in; the last one carries the best move."""

    def __init__(self, board):
        self.board = board.copy(stack=False)
        self.white = board.turn == chess.WHITE
        self.time = self.depth = self.nodes = 0
        self.pvs = []
        self.done = False

    def _snapshot(self, bestmove=None, ponder=None):
        out = {"time": self.time, "depth": self.depth, "nodes": self.nodes,
               "pvs": [pv for pv in self.pvs if pv is not None]}
        if bestmove is not None:
            out["bestmove"] = bestmove
            if ponder:
                out["ponder"] = ponder
        return (json.dumps(out, separators=(",", ":")) + "\n").encode()

    def _moves(self, pv):
        board = self.board.copy(stack=False)
        moves = []
        for uci in pv[:PV_MOVES]:
            try:
                move = board.parse_uci(uci)
            except ValueError:
                break
            moves.append(board.uci(move, chess960=True))
            board.push(move)
        return moves

    def finish(self, bestmove="(none)", ponder=None):
        if self.done:
            return []
        self.done = True
        self.pvs = [pv for pv in self.pvs if pv is not None]
        return [self._snapshot(bestmove, ponder)]

    def feed(self, line):
        """The ndjson lines to send for one line from analyse()."""
        if self.done:
            return []
        text = line.decode("utf-8", errors="replace").strip()
        if text.startswith("{"):
            try:
                control = json.loads(text)
            except ValueError:
                return self.finish()
            return [b'{"keepalive":true}\n'] if control == {"keepalive": True} else self.finish()
        words = text.split()
        if not words:
            return []
        if words[0] == "bestmove":
            best = words[1] if len(words) > 1 else "(none)"
            ponder = words[3] if len(words) > 3 and words[2] == "ponder" and words[3] != "(none)" else None
            return self.finish(best, ponder)
        if words[0] != "info":
            return []
        info = _parse_info(words[1:])
        if info is None:
            return self.finish()
        multi_pv = max(1, info.get("multipv", 1))
        if multi_pv > 5:
            return self.finish()
        line_pv = None
        if "depth" in info and "score" in info and "pv" in info and (multi_pv > 1 or not info.get("bound")):
            kind, value = info["score"]
            line_pv = {"moves": self._moves(info["pv"]), kind: value if self.white else -value, "depth": info["depth"]}
        if multi_pv == 1:
            for key in ("time", "depth", "nodes"):
                if key in info:
                    setattr(self, key, info[key])
            self.pvs = [None] * len(self.pvs)
        elif "depth" in info:
            self.depth = min(self.depth, info["depth"])
        if len(self.pvs) < multi_pv:
            self.pvs += [None] * (multi_pv - len(self.pvs))
        if line_pv is not None:
            self.pvs[multi_pv - 1] = line_pv
        if self.pvs and all(pv is not None for pv in self.pvs):
            return [self._snapshot()]
        return []


class UciProcess:
    """One Stockfish process, driven over UCI (adapted from the example).

    A single background task reads Stockfish's output into a queue; nobody
    else reads stdout. A job takes lines with a timeout and never leaves a read
    pending, so a job that is abandoned midway (Lichess cancelled, the upload
    broke) cannot steal lines from the next one.
    """

    def __init__(self, process):
        self.process = process
        self.session_id = None
        self.options = {}
        self.last_used = time.monotonic()
        self.stop_lock = asyncio.Lock()
        self.lines = asyncio.Queue()
        self.reader = asyncio.get_running_loop().create_task(self._read())
        # True from "go" until its "bestmove" has been taken. An abandoned
        # search must be stopped and its bestmove drained before the next
        # "go", or the next job gets the OLD bestmove: an instant, eval-less
        # answer for the wrong position, which left Practice stuck.
        self.searching = False

    async def _read(self):
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    head, _, rest = text.partition(" ")
                    self.lines.put_nowait((head, rest))
        finally:
            self.lines.put_nowait(None)  # end of output

    @classmethod
    async def create(cls, path):
        process = await asyncio.create_subprocess_exec(
            path, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        self = cls(process)
        await self.send("uci")
        while (await self.recv())[0] != "uciok":
            pass
        await self.send("setoption name UCI_AnalyseMode value true")
        await self.send("setoption name UCI_Chess960 value true")
        return self

    def alive(self):
        return self.process.returncode is None

    def idle_time(self):
        return time.monotonic() - self.last_used

    async def terminate(self):
        if self.alive():
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.reader.cancel()

    async def send(self, command):
        if not self.alive():
            raise EOFError()
        try:
            self.process.stdin.write((command + "\n").encode())
            await self.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as err:
            raise EOFError() from err

    async def recv(self, timeout=None):
        """The next (head, rest) line; asyncio.TimeoutError after `timeout`."""
        item = await (asyncio.wait_for(self.lines.get(), timeout) if timeout else self.lines.get())
        if item is None:
            self.lines.put_nowait(None)  # stay at end of output for later readers
            raise EOFError()
        return item

    async def isready(self):
        await self.send("isready")
        while (await self.recv())[0] != "readyok":
            pass

    async def stop(self):
        async with self.stop_lock:
            if self.alive():
                await self.send("stop")

    async def settle(self):
        """Make sure no search is running and no stale bestmove is pending."""
        if self.searching and self.alive():
            await self.stop()
            try:
                while (await self.recv(timeout=5))[0] != "bestmove":
                    pass
            except asyncio.TimeoutError:
                log.warning("Lichess engine: Stockfish did not stop in time")
        self.searching = False

    async def analyse(self, job, started, practice_seconds=PRACTICE_SECONDS, record=None, interrupted=lambda: False):
        """Run one job, yielding the lines Lichess expects. ``record`` (a dict)
        is filled in as it runs, for GET /api/lichess-engine's "recent"."""
        work = job["work"]
        record = record if record is not None else {}
        began = time.monotonic()
        try:
            await self.settle()
            if work["sessionId"] != self.session_id:
                self.session_id = work["sessionId"]
                await self.send("ucinewgame")
                await self.isready()
            wanted = {
                # Lichess may send an older saved thread preference.
                "Threads": ENGINE_THREADS,
                "Hash": min(int(work["hash"]), MAX_HASH_MB),
                "MultiPV": work["multiPv"],
                "UCI_Variant": work["variant"],
            }
            changed = False
            for name, value in wanted.items():
                if self.options.get(name) != value:
                    await self.send(f"setoption name {name} value {value}")
                    self.options[name] = value
                    changed = True
            if changed:
                await self.isready()
            moves = " ".join(work.get("moves") or [])
            await self.send(f"position fen {work['initialFen']}" + (f" moves {moves}" if moves else ""))
            command, quiet = search_command(work, practice_seconds)
            if interrupted():
                record["ended"] = "stopped: answered with nothing"
                yield EMPTY_SEARCH
                return
            self.searching = True
            await self.send(command)
            started.set()
            record.update(go=command, threads=self.options["Threads"], quiet=quiet, lines=0, ended="running")

            last_info = None
            last_rest = None  # the newest report sent, to restate as complete
            last_ping = time.monotonic()
            while not interrupted():
                try:
                    head, rest = await self.recv(timeout=max(0.01, 15 + last_ping - time.monotonic()))
                except asyncio.TimeoutError:
                    if interrupted():
                        break
                    record["keepalives"] = record.get("keepalives", 0) + 1
                    yield b'{"keepalive":true}\n'
                    last_ping = time.monotonic()
                    continue
                self.last_used = time.monotonic()
                if head == "bestmove":
                    self.searching = False
                if interrupted():
                    break
                if head == "bestmove":
                    if quiet and last_info:
                        record["lines"] += 1
                        yield last_info
                    elif last_rest:
                        complete = complete_report(last_rest, work)
                        if complete != last_rest:
                            record["completed"] = True
                            yield f"info {complete}\n".encode()
                    if interrupted():
                        break
                    record.update(ended=f"bestmove {rest.split()[0] if rest else ''}",
                                  seconds=round(time.monotonic() - began, 2))
                    yield f"bestmove {rest}\n".encode()
                    return
                # Only reports with a move line. When a search stops at its node
                # limit (Practice), Stockfish's last report has a score but no
                # "pv"; Lichess's engine service turns that into a result with
                # an empty move list, and Lichess's Practice page then crashes
                # ("Cannot read properties of undefined (reading 'moves')") and
                # hangs on "Computer thinking".
                # Bound reports ("lowerbound"/"upperbound": a search cut off
                # mid-depth) are skipped too, as Lichess's own engine client
                # does; the last of them came out as an empty result.
                words = f" {rest} "
                if (head == "info" and " score " in words and " pv " in words
                        and " lowerbound " not in words and " upperbound " not in words):
                    if quiet:
                        last_info = f"info {complete_report(rest, work)}\n".encode()
                    else:
                        last_rest = rest
                        record["lines"] += 1
                        yield f"info {rest}\n".encode()
            record.update(ended="stopped: answered with nothing", seconds=round(time.monotonic() - began, 2))
            yield EMPTY_SEARCH
        finally:
            started.set()
            if record.get("ended") == "running":
                # Lichess moved on (a newer request) or closed the stream.
                record.update(ended="stopped early", seconds=round(time.monotonic() - began, 2))
            try:
                await self.settle()
            except EOFError:
                pass
            self.last_used = time.monotonic()

    async def deep_search(self, initial_fen, moves, movetime_ms, progress=None):
        """One deep-analysis search (deep_analysis.py): ``go movetime M``, no
        depth limit (Stockfish stops by itself at its maximum depth), one line. The last full report as a dict
        (depth, score from the side to move, nodes, pv, seconds), or None if
        Stockfish gave none. Keeps the search memory (no ucinewgame) and the
        hash size Lichess last asked for, so the engine bar loses nothing."""
        await self.settle()
        wanted = {"Threads": ENGINE_THREADS, "Hash": self.options.get("Hash", DEEP_HASH_MB),
                  "MultiPV": 1, "UCI_Variant": "chess"}
        changed = False
        for name, value in wanted.items():
            if self.options.get(name) != value:
                await self.send(f"setoption name {name} value {value}")
                self.options[name] = value
                changed = True
        if changed:
            await self.isready()
        await self.send(f"position fen {initial_fen}" + (f" moves {' '.join(moves)}" if moves else ""))
        self.searching = True
        began = time.monotonic()
        await self.send(f"go movetime {int(movetime_ms)}")
        best = None
        try:
            while True:
                head, rest = await self.recv()
                self.last_used = time.monotonic()
                if head == "bestmove":
                    self.searching = False
                    break
                if head != "info":
                    continue
                info = _parse_info(rest.split())
                if (not info or info.get("multipv", 1) != 1 or info.get("bound") or "score" not in info
                        or not info.get("pv") or "depth" not in info):
                    continue
                kind, value = info["score"]
                best = {"depth": info["depth"], "cp": value if kind == "cp" else None,
                        "mate": value if kind == "mate" else None, "nodes": info.get("nodes", 0),
                        "pv": info["pv"]}
                if progress:
                    progress(info["depth"], time.monotonic() - began)
        finally:
            await self.settle()  # cancelled midway (the service stopping): stop Stockfish
        if best is not None:
            best["seconds"] = round(time.monotonic() - began, 2)
        return best


def _setting_getter(key):
    def get():
        import database as db  # imported late: database imports half the app
        return db.get_setting(key)
    return get


def _secret_store(value=None):
    import database as db
    if value:
        db.set_setting(SECRET_SETTING, value)
        return value
    return db.get_setting(SECRET_SETTING)


class LichessEngineProvider:
    """Background task: keeps the engine registered and answers Lichess."""

    def __init__(self, token_getter=None, secret_store=None, stockfish_path=None,
                 transport=None, poll_pause=5.0, on_activity=None):
        # Called for every job Lichess sends: the engine being used counts as
        # the service being used (idle_exit.py), whatever the extension says.
        self._on_activity = on_activity
        self._token_getter = token_getter or _setting_getter("lichess_token")
        self._secret_store = secret_store or _secret_store
        self._stockfish_path = stockfish_path or stockfish.STOCKFISH_PATH
        self._transport = transport
        self._poll_pause = poll_pause
        self._task = None
        self._engine = None
        self._job_task = None
        self._token_in_use = None
        self.state = "starting"
        self.error = ""
        self.engine_id = None
        self.jobs = 0
        self.local_jobs = 0  # of those, asked by the page on this computer directly
        # One Stockfish serves both paths: a job (from the broker or the page)
        # takes it only after the search before it has stopped and ended.
        self._claim_lock = asyncio.Lock()
        self.recent = collections.deque(maxlen=40)  # what Lichess asked, newest last
        # Background searches (deep_analysis.py) give way to Lichess: one runs
        # only after Lichess has been quiet for QUIET_SECONDS, and a request
        # from Lichess stops it (_claim_engine), which marks it interrupted.
        self._deep_task = None
        self._deep_interrupted = False
        self._last_live = 0.0

    def status(self):
        return {
            "state": self.state,           # starting | no_token | missing_scope | no_stockfish | ready | error
            "error": self.error,
            "engine_name": ENGINE_NAME,
            "engine_id": self.engine_id,
            "token_url": TOKEN_URL,
            "practice_seconds": PRACTICE_SECONDS,
            "jobs": self.jobs,
            "local_jobs": self.local_jobs,
            "recent": list(self.recent),
        }

    def start(self):
        if os.environ.get("OPENINGS_LICHESS_ENGINE", "1") != "1":
            self.state = "off"
            return
        self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._job_task:
            self._job_task.cancel()
        if self._engine:
            await self._engine.terminate()

    async def _run(self):
        timeout = httpx.Timeout(15.0, read=None)
        async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as http:
            while True:
                try:
                    secret = await self._register(http)
                    if secret:
                        await self._serve(http, secret)
                    else:
                        await asyncio.sleep(self._poll_pause)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # network trouble, Lichess down…
                    log.warning("Lichess engine: %s", exc)
                    self.state = "error"
                    self.error = str(exc)[:200] or exc.__class__.__name__
                    await asyncio.sleep(10)

    async def _register(self, http):
        token = await asyncio.to_thread(self._token_getter)
        self._token_in_use = token
        if not token:
            self.state, self.error = "no_token", ""
            return None
        if not (self._stockfish_path and os.access(self._stockfish_path, os.X_OK)):
            self.state, self.error = "no_stockfish", "Stockfish was not found"
            return None
        headers = {"Authorization": f"Bearer {token}"}
        res = await http.get(f"{LICHESS}/api/external-engine", headers=headers)
        if res.status_code in (401, 403):
            self.state = "missing_scope"
            self.error = "The Lichess token saved in the app has no engine access."
            return None
        res.raise_for_status()
        secret = await asyncio.to_thread(self._secret_store)
        if not secret:
            secret = secrets.token_urlsafe(32)
            await asyncio.to_thread(self._secret_store, secret)
        body = registration(secret)
        engines = res.json()
        existing = (next((e for e in engines if e.get("name") == ENGINE_NAME), None)
                    or next((e for e in engines if e.get("name") in FORMER_ENGINE_NAMES), None))
        if existing:
            res = await http.put(f"{LICHESS}/api/external-engine/{existing['id']}", json=body, headers=headers)
            res.raise_for_status()
            self.engine_id = existing["id"]
        else:
            res = await http.post(f"{LICHESS}/api/external-engine", json=body, headers=headers)
            res.raise_for_status()
            self.engine_id = res.json().get("id")
        self.state, self.error = "ready", ""
        return secret

    async def _serve(self, http, secret):
        backoff = 1.0
        while True:
            if await asyncio.to_thread(self._token_getter) != self._token_in_use:
                return  # token changed or removed: register again
            try:
                res = await http.post(f"{BROKER}/api/external-engine/work",
                                      json={"providerSecret": secret}, timeout=12)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                self.error = f"Can't reach Lichess's engine service ({exc.__class__.__name__})"
                backoff = min(backoff * 1.5, 10)
                await asyncio.sleep(backoff)
                continue
            backoff = 1.0
            if res.status_code != 200:
                if res.status_code >= 400:
                    self.error = f"Lichess's engine service answered {res.status_code}"
                    await asyncio.sleep(self._poll_pause)
                else:
                    # "Nothing to do yet" is an answer too: the service is
                    # reachable again, so an earlier refusal no longer stands.
                    self.error = ""
                if (self._engine and self._engine.alive() and self._engine.idle_time() > KEEP_ALIVE_SECONDS
                        and not (self._job_task and not self._job_task.done())):
                    await self._engine.terminate()
                continue
            self.error = ""
            job = res.json()

            def interrupted():
                return False  # a newer job stops this one's search (_claim_engine)

            async with self._claim_lock:
                self._last_live = time.monotonic()
                await self._claim_engine(interrupted)
                started = asyncio.Event()
                self._job_task = asyncio.create_task(self._handle(http, job, started, interrupted))
                await started.wait()

    async def _claim_engine(self, interrupted):
        """Stop the search in progress, wait for its job to end and make sure
        Stockfish runs. False if the request was given up meanwhile (the page
        moved on). Under _claim_lock."""
        if self._job_task is not None and self._job_task is self._deep_task and not self._job_task.done():
            self._deep_interrupted = True
        if self._engine and self._engine.alive():
            try:
                await self._engine.stop()
            except EOFError:
                pass
        if self._job_task and not self._job_task.done():
            # wait(), not gather(): a page that goes away while this waits
            # must not cancel the older job in the middle of its cleanup.
            await asyncio.wait([self._job_task])
        if interrupted():
            return False
        if not (self._engine and self._engine.alive()):
            self._engine = await UciProcess.create(self._stockfish_path)
        return True

    def lichess_busy(self):
        """Lichess is searching, or asked something less than QUIET_SECONDS ago."""
        live = self._job_task is not None and self._job_task is not self._deep_task and not self._job_task.done()
        return live or time.monotonic() - self._last_live < QUIET_SECONDS

    async def deep_search(self, initial_fen, moves, movetime_ms, progress=None):
        """A deep-analysis search on the one Stockfish (the engine bar's own
        process, same priority), only while Lichess is
        quiet. Its result (see UciProcess.deep_search), or None when it could
        not start (Lichess busy, no Stockfish) or a Lichess request stopped it
        (then it is to be searched again later)."""
        if self.lichess_busy() or not self.stockfish_found():
            return None
        async with self._claim_lock:
            if self.lichess_busy():
                return None
            await self._claim_engine(lambda: False)
            self._deep_interrupted = False
            task = asyncio.create_task(self._engine.deep_search(initial_fen, moves, movetime_ms, progress))
            self._deep_task = self._job_task = task
        try:
            result = await task
        except EOFError:
            log.warning("Lichess engine: Stockfish exited during a background search")
            return None
        finally:
            self._engine.last_used = time.monotonic()
        return None if self._deep_interrupted else result

    async def stop_deep(self):
        """Stop the background search running (its chapter was closed, paused
        or changed); deep_search then returns None."""
        task = self._deep_task
        if task is not None and not task.done() and self._job_task is task and self._engine:
            self._deep_interrupted = True
            try:
                await self._engine.stop()
            except EOFError:
                pass

    def can_answer(self, engine_id):
        """Whether a page's request for `engine_id` is this app's to answer."""
        return bool(self.engine_id) and engine_id == self.engine_id

    def stockfish_found(self):
        return bool(self._stockfish_path and os.access(self._stockfish_path, os.X_OK))

    async def local_analysis(self, work, board):
        """Answer the Lichess page on this computer directly: the results
        Lichess's broker would have streamed it (BrokerEmit), as ndjson lines.
        ``work`` and ``board`` come from sanitize_work. The same rules as a
        broker job: a newer request (from either path) stops this search, and
        closing the stream (Lichess cancelled: you moved on) stops Stockfish."""
        emit = BrokerEmit(board)
        record = {"at": time.strftime("%H:%M:%S"), "via": "local",
                  "ask": {k: work[k] for k in ("movetime", "depth", "nodes", "multiPv", "threads", "hash") if k in work},
                  "moves": len(work.get("moves") or [])}
        self.recent.append(record)
        gone = []  # set once the page stopped listening

        def interrupted():
            return bool(gone)

        out = asyncio.Queue()
        task = None
        try:
            async with self._claim_lock:
                self._last_live = time.monotonic()
                if await self._claim_engine(interrupted):
                    started = asyncio.Event()
                    task = self._job_task = asyncio.create_task(
                        self._handle_local(work, emit, out, started, interrupted, record, gone))
                    await started.wait()
            if task is None:
                record["ended"] = "cancelled"
                for chunk in emit.feed(EMPTY_SEARCH):
                    yield chunk
                return
            while (chunk := await out.get()) is not None:
                yield chunk
        finally:
            # No awaiting here: the stream is being cancelled (the page went),
            # and inside a cancelled scope every await is cancelled again.
            if task is not None and not task.done():
                gone.append(True)
                asyncio.get_running_loop().create_task(self._stop_for(task))

    async def _stop_for(self, task):
        """Stop the search of `task`'s job, unless a newer job has taken over."""
        if self._job_task is task and not task.done() and self._engine:
            try:
                await self._engine.stop()
            except EOFError:
                pass

    async def _handle_local(self, work, emit, out, started, interrupted, record, gone):
        self.jobs += 1
        self.local_jobs += 1
        if self._on_activity:
            self._on_activity()
        lines = self._engine.analyse({"work": work}, started, record=record, interrupted=interrupted)
        try:
            async for line in lines:
                for chunk in emit.feed(line):
                    out.put_nowait(chunk)
                if emit.done:
                    break
        except EOFError:
            record["ended"] = "Stockfish exited"
            log.warning("Lichess engine: Stockfish exited")
        finally:
            try:
                await lines.aclose()  # runs analyse()'s cleanup: stop + drain
            except (EOFError, RuntimeError):
                pass
            if gone:  # the page stopped listening (you moved on)
                record["ended"] = "cancelled"
            for chunk in emit.finish():
                out.put_nowait(chunk)
            out.put_nowait(None)
            started.set()
            self._last_live = time.monotonic()

    async def _handle(self, http, job, started, interrupted):
        self.jobs += 1
        if self._on_activity:
            self._on_activity()
        work = job.get("work", {})
        record = {
            "at": time.strftime("%H:%M:%S"),
            "via": "broker",
            "ask": {k: work[k] for k in ("movetime", "depth", "nodes", "by", "infinite", "multiPv", "threads", "hash") if k in work},
            "moves": len(work.get("moves") or []),
        }
        self.recent.append(record)
        lines = self._engine.analyse(job, started, record=record, interrupted=interrupted)
        try:
            res = await http.post(f"{BROKER}/api/external-engine/work/{job['id']}",
                                  content=lines, timeout=httpx.Timeout(None))
            record["broker"] = res.status_code
            if res.status_code >= 400:
                log.info("Lichess engine: answer refused (%s)", res.status_code)
        except httpx.HTTPError as exc:
            record["broker"] = f"stream error: {exc.__class__.__name__}"
            log.info("Lichess engine: stream ended (%s)", exc)
        except EOFError:
            record["broker"] = "Stockfish exited"
            log.warning("Lichess engine: Stockfish exited")
        finally:
            try:
                await lines.aclose()  # runs analyse()'s cleanup: stop + drain
            except (EOFError, RuntimeError):
                pass
            started.set()
            self._last_live = time.monotonic()
