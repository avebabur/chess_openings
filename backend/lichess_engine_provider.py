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

Every job first makes sure no earlier search is still running (see
UciProcess.settle): an abandoned search used to hand its stale bestmove to the
next job, which left Practice stuck.
"""
import asyncio
import collections
import logging
import os
import secrets
import time

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
MAX_HASH_MB = 1024
KEEP_ALIVE_SECONDS = 300  # an idle Stockfish is closed after this
# 0 = do what Lichess asks (its normal Practice searches ~600k nodes, under a
# second here; its Mastery mode uses your search time, 8 s by default). A number
# makes every normal-Practice search that many seconds, sent at the end.
PRACTICE_SECONDS = float(os.environ.get("OPENINGS_PRACTICE_SECONDS", "0"))
SECRET_SETTING = "lichess_engine_secret"


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
        "maxThreads": os.cpu_count() or 4,
        "maxHash": MAX_HASH_MB,
        "variants": ["chess"],
        "providerSecret": secret,
    }


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

    async def analyse(self, job, started, practice_seconds=PRACTICE_SECONDS, record=None):
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
                "Threads": work["threads"],
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
            await self.send(command)
            self.searching = True
            started.set()
            record.update(go=command, quiet=quiet, lines=0, ended="running")

            last_info = None
            last_rest = None  # the newest report sent, to restate as complete
            last_ping = time.monotonic()
            while True:
                try:
                    head, rest = await self.recv(timeout=max(0.01, 15 + last_ping - time.monotonic()))
                except asyncio.TimeoutError:
                    record["keepalives"] = record.get("keepalives", 0) + 1
                    yield b'{"keepalive":true}\n'
                    last_ping = time.monotonic()
                    continue
                self.last_used = time.monotonic()
                if head == "bestmove":
                    self.searching = False
                    if quiet and last_info:
                        record["lines"] += 1
                        yield last_info
                    elif last_rest:
                        complete = complete_report(last_rest, work)
                        if complete != last_rest:
                            record["completed"] = True
                            yield f"info {complete}\n".encode()
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
        self.recent = collections.deque(maxlen=40)  # what Lichess asked, newest last

    def status(self):
        return {
            "state": self.state,           # starting | no_token | missing_scope | no_stockfish | ready | error
            "error": self.error,
            "engine_name": ENGINE_NAME,
            "engine_id": self.engine_id,
            "token_url": TOKEN_URL,
            "practice_seconds": PRACTICE_SECONDS,
            "jobs": self.jobs,
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
                if self._engine and self._engine.alive() and self._engine.idle_time() > KEEP_ALIVE_SECONDS:
                    await self._engine.terminate()
                continue
            self.error = ""
            job = res.json()
            if self._engine and self._engine.alive():
                try:
                    await self._engine.stop()
                except EOFError:
                    pass
            if self._job_task:
                await asyncio.gather(self._job_task, return_exceptions=True)
            if not (self._engine and self._engine.alive()):
                self._engine = await UciProcess.create(self._stockfish_path)
            started = asyncio.Event()
            self._job_task = asyncio.create_task(self._handle(http, job, started))
            await started.wait()

    async def _handle(self, http, job, started):
        self.jobs += 1
        if self._on_activity:
            self._on_activity()
        work = job.get("work", {})
        record = {
            "at": time.strftime("%H:%M:%S"),
            "ask": {k: work[k] for k in ("movetime", "depth", "nodes", "by", "infinite", "multiPv", "threads", "hash") if k in work},
            "moves": len(work.get("moves") or []),
        }
        self.recent.append(record)
        lines = self._engine.analyse(job, started, record=record)
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
