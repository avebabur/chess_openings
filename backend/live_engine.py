"""Live position evaluation — a single persistent Stockfish for the Explore board.

Why this module exists
----------------------
This is the engine behind the left "Stockfish" panel. It is deliberately
separate from the Game-Review analysis pipeline (shared ``stockfish_engine.py``),
which runs a *pool* of single-threaded workers tuned for throughput across many
positions. Here we care about a *single* position analysed interactively, so the
config and the cancellation model are different.

Threads / memory
----------------
Reported depth and practical search strength are different metrics. Stockfish's
multithreading (Lazy SMP) runs every thread on the same root position and
shares results through the hash table, so extra threads barely raise the
reported depth at a fixed time. They still find the right move sooner and play
stronger. Do NOT compare thread counts by depth; compare time-to-solution or Elo.

Both thread profiles default to ``DEFAULT_THREADS`` (4, capped at the CPU count).
On the 8-core (4 performance + 4 efficiency) dev Mac running Stockfish 19,
nodes/sec rose from about 270k at 1 thread to 825k at 4 but only 890k at 8.
Threads past 4 land on the slower efficiency cores. The cost is that multithreaded results are not bit-for-bit
reproducible: the same position can show a slightly different eval or PV
between runs. The best move is what stays stable.

Depth-targeted searches use ``OPENINGS_LIVE_INTERACTIVE_THREADS``. Infinite and
time-only analysis use ``OPENINGS_LIVE_DEEP_THREADS``. The legacy
``OPENINGS_LIVE_THREADS`` env var still overrides both profiles when set; set it
to 1 for reproducible single-threaded output.

Current default hash is ``Hash=1024`` MB. There is exactly ONE shared engine, so
that 1 GB (plus the binary + NNUE nets) is the app's entire engine footprint, not
per-request. Override with ``OPENINGS_LIVE_HASH_MB``; set it to 256 to trade a
little deep-search strength for lower RAM use.

Architecture (the fix for "stuck Searching…")
---------------------------------------------
The engine is driven by ONE dedicated worker thread (an actor), fully decoupled
from the HTTP request lifecycle. An SSE request just registers a queue and drains
it; it never touches the engine and never holds a lock across ``yield``. That
matters because a browser that navigates away aborts its request mid-stream — if
the request held the engine, that engine would be stranded and every later search
would block behind it (the original bug). Here a disconnect only abandons a queue;
the worker keeps serving the newest request.

Cancellation is instant: a new request bumps the generation and calls
``analysis.stop()`` on the in-flight search (the one thread-safe engine call), so
Stockfish wraps up in ~ms and the worker picks up the new position immediately.
"""
import json
import os
import queue
import threading
import time

import chess
import chess.engine

def _stockfish_path():
    configured = os.environ.get("STOCKFISH_PATH")
    if configured:
        return configured
    from shutil import which
    return which("stockfish") or "/opt/homebrew/bin/stockfish"


STOCKFISH_PATH = _stockfish_path()


def _default_threads():
    """4 search threads, or fewer on a machine with fewer cores."""
    return max(1, min(4, os.cpu_count() or 1))


DEFAULT_THREADS = _default_threads()
_LEGACY_THREADS = os.environ.get("OPENINGS_LIVE_THREADS")
LIVE_INTERACTIVE_THREADS = int(os.environ.get(
    "OPENINGS_LIVE_INTERACTIVE_THREADS", _LEGACY_THREADS or str(DEFAULT_THREADS)))
LIVE_DEEP_THREADS = int(os.environ.get(
    "OPENINGS_LIVE_DEEP_THREADS", _LEGACY_THREADS or str(DEFAULT_THREADS)))
LIVE_THREADS = LIVE_INTERACTIVE_THREADS  # Backward-compatible module constant.
LIVE_HASH_MB = int(os.environ.get("OPENINGS_LIVE_HASH_MB", "1024"))
LIVE_DEPTH = int(os.environ.get("OPENINGS_LIVE_DEPTH", "22"))
# Default browse is time-based: ~4s reaches a useful depth with predictable latency.
# Deeper tiers (10s/30s/∞) are driven by the UI.
LIVE_MAX_SECONDS = float(os.environ.get("OPENINGS_LIVE_MAX_SECONDS", "4"))
# MultiPV=1 lets alpha-beta prune hard (no need to accurately score the 2nd/3rd
# lines), so the single best move is found faster and deeper. Set OPENINGS_LIVE_MULTIPV
# higher if the Explore panel should show multiple candidate lines again.
LIVE_MULTIPV = max(1, int(os.environ.get("OPENINGS_LIVE_MULTIPV", "1")))
PV_PLIES = 8  # half-moves of each principal variation sent to the UI
KEEPALIVE_SECS = 4.0  # heartbeat cadence between completed depths (deep/∞ searches)
DRAIN_TIMEOUT = 30.0  # SSE drain give-up — comfortably above KEEPALIVE_SECS

_SUPERSEDED = object()  # queue sentinel: this request was replaced by a newer one


def _build_limit(depth, max_seconds):
    """Per-request search limit. ``depth<=0`` *and* ``max_seconds<=0`` → an unbounded
    (infinite) search that runs until a newer request supersedes it or the client
    disconnects (both already stop the in-flight search). Otherwise cap by whichever
    of depth/time is given."""
    depth = int(depth or 0)
    max_seconds = float(max_seconds or 0)
    kwargs = {}
    if depth > 0:
        kwargs["depth"] = depth
    if max_seconds > 0:
        kwargs["time"] = max_seconds
    return chess.engine.Limit(**kwargs)


def _threads_for_limit(limit):
    # Separate profiles so shallow vs deep/time-based searches can be tuned
    # independently by env var. Both default to DEFAULT_THREADS.
    depth = getattr(limit, "depth", None)
    if depth is not None and depth <= LIVE_DEPTH:
        return LIVE_INTERACTIVE_THREADS
    return LIVE_DEEP_THREADS


def _new_engine():
    engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    opts = {}
    if LIVE_HASH_MB > 0:
        opts["Hash"] = LIVE_HASH_MB
    if opts:
        engine.configure(opts)
    return engine


def availability():
    available = os.path.isfile(STOCKFISH_PATH) and os.access(STOCKFISH_PATH, os.X_OK)
    return {
        "available": available,
        "path": STOCKFISH_PATH if available else None,
        "message": None if available else "Install Stockfish or set STOCKFISH_PATH",
    }


def _score_to_eval(score):
    """python-chess Score -> float pawns from White's POV; mates as ±(1000+|n|)."""
    white = score.white()
    if white.is_mate():
        mate_in = white.mate()
        return (1000.0 + abs(mate_in)) if mate_in >= 0 else -(1000.0 + abs(mate_in))
    cp = white.score()
    return (cp / 100.0) if cp is not None else 0.0


def _payload_from_multipv(board, infos_by_mpv, depth, done=False, target_depth=None):
    """Assemble one UI payload (headline eval + up to N PV lines) for a depth."""
    primary = infos_by_mpv.get(1) or (infos_by_mpv[min(infos_by_mpv)] if infos_by_mpv else None)
    primary_score = primary.get("score") if primary else None
    primary_pv = (primary.get("pv") if primary else None) or []
    best_move = primary_pv[0] if primary_pv else None

    lines = []
    for mpv in sorted(infos_by_mpv):
        info = infos_by_mpv[mpv]
        score = info.get("score")
        pv = info.get("pv") or []
        if score is None or not pv:
            continue
        temp = board.copy(stack=False)
        sans, ucis = [], []
        for move in pv[:PV_PLIES]:
            sans.append(temp.san(move))
            ucis.append(move.uci())
            temp.push(move)
        if sans:
            lines.append({
                "eval": round(_score_to_eval(score), 2),
                "depth": info.get("depth") or depth,
                "target_depth": target_depth,
                "moves": " ".join(sans),
                "pv": sans,
                "uci": ucis,
            })

    payload = {
        "depth": depth,
        "target_depth": target_depth,
        "eval": round(_score_to_eval(primary_score), 2) if primary_score is not None else 0.0,
        "best_move": board.san(best_move) if best_move else None,
        "best_move_uci": best_move.uci() if best_move else None,
        "lines": lines,
    }
    if done:
        payload["done"] = True
    return payload


def _terminal_payload(board, target_depth=LIVE_DEPTH):
    """Checkmate / stalemate: a final payload with no engine line."""
    if board.is_checkmate():
        eval_val = -1000.0 if board.turn == chess.WHITE else 1000.0
    else:
        eval_val = 0.0
    return {
        "depth": target_depth,
        "target_depth": target_depth,
        "eval": round(eval_val, 2),
        "best_move": None,
        "best_move_uci": None,
        "lines": [],
        "done": True,
    }


def _progress_frame(last_payload, depth, target_depth):
    """A no-``done`` heartbeat carrying the current in-progress ``depth`` (with the
    last completed depth's lines). Keeps the SSE drain fed during long/infinite
    searches and lets the UI show the depth climbing between completed-depth payloads."""
    base = last_payload or {}
    return {
        "depth": depth,
        "target_depth": target_depth,
        "eval": base.get("eval", 0.0),
        "best_move": base.get("best_move"),
        "best_move_uci": base.get("best_move_uci"),
        "lines": base.get("lines", []),
    }


def _sse(payload):
    return f"data: {json.dumps(payload)}\n\n"


class LiveEngineService:
    """Single Stockfish driven by one worker thread; requests are queues."""

    def __init__(self):
        self._engine = None
        self._cv = threading.Condition()
        self._generation = 0
        self._pending = None            # newest (generation, board, queue) awaiting the worker
        self._current_analysis = None   # in-flight AnalysisResult, for cross-thread stop()
        self._stopping = False
        self._worker = None
        self._configured_threads = None

    def availability(self):
        return availability()

    def start(self):
        with self._cv:
            if self._worker and self._worker.is_alive():
                return
            self._stopping = False
            self._pending = None
            self._current_analysis = None
            self._worker = threading.Thread(
                target=self._loop, name="live-engine", daemon=True,
            )
            self._worker.start()
        # Pre-warm: spawn Stockfish + load the NNUE nets now so the first eval
        # isn't paying process-spawn + ~130 MB net-load as visible "Searching…"
        # latency. Best-effort — a missing/broken binary just falls back to the
        # existing lazy path in _get_engine() and is surfaced by availability().
        try:
            self._get_engine()
        except Exception:
            pass

    # -- public API (called from request threads) --------------------------

    def submit(self, board, limit):
        self.start()
        """Register a new analysis; returns (generation, queue) to drain."""
        q = queue.Queue(maxsize=256)
        with self._cv:
            self._generation += 1
            generation = self._generation
            self._pending = (generation, board, limit, q)
            analysis = self._current_analysis
            self._cv.notify()
        if analysis is not None:          # interrupt the in-flight search at once
            self._safe_stop(analysis)
        return generation, q

    def cancel(self, generation):
        """Stop the search for ``generation`` if it is still the current one
        (used when a client disconnects with no follow-up request)."""
        with self._cv:
            analysis = self._current_analysis if generation == self._generation else None
        if analysis is not None:
            self._safe_stop(analysis)

    def shutdown(self):
        with self._cv:
            self._stopping = True
            analysis = self._current_analysis
            self._cv.notify_all()
        if analysis is not None:
            self._safe_stop(analysis)
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None
            self._configured_threads = None
        worker = self._worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout=3)
        self._worker = None

    # -- worker internals --------------------------------------------------

    @staticmethod
    def _safe_stop(analysis):
        try:
            analysis.stop()
        except Exception:
            pass

    def _get_engine(self):
        if self._engine is None:
            self._engine = _new_engine()
            self._configured_threads = None
        return self._engine

    def _configure_for_limit(self, engine, limit):
        threads = _threads_for_limit(limit)
        if threads > 0 and threads != self._configured_threads:
            engine.configure({"Threads": threads})
            self._configured_threads = threads

    def _loop(self):
        while True:
            with self._cv:
                while self._pending is None and not self._stopping:
                    self._cv.wait()
                if self._stopping:
                    return
                generation, board, limit, q = self._pending
                self._pending = None
            self._run_one(generation, board, limit, q)

    def _superseded(self, generation):
        with self._cv:
            return generation != self._generation

    def _run_one(self, generation, board, limit, q):
        target_depth = limit.depth  # None for an unbounded (infinite) search

        state = {"last_emit": time.time()}

        def emit(item):
            try:
                q.put_nowait(item)        # drop frames for a gone/slow client; never block the worker
                state["last_emit"] = time.time()
            except queue.Full:
                pass

        def force_emit(item):
            # Terminal frames (done / error / _SUPERSEDED) must land even if a slow
            # client's queue is momentarily full — otherwise the stream hangs until
            # DRAIN_TIMEOUT. Make room by dropping the oldest (intermediate) frame
            # rather than blocking the worker on a gone client.
            while True:
                try:
                    q.put_nowait(item)
                    state["last_emit"] = time.time()
                    return
                except queue.Full:
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        return

        try:
            engine = self._get_engine()
            self._configure_for_limit(engine, limit)
        except Exception as exc:
            force_emit({"error": str(exc), "done": True})
            return

        pending_mpv = {}
        pending_depth = 0
        last_emitted_depth = 0
        last_payload = None
        analysis = None
        try:
            with engine.analysis(board, limit, multipv=LIVE_MULTIPV) as analysis:
                with self._cv:
                    self._current_analysis = analysis

                for info in analysis:
                    if self._superseded(generation):
                        analysis.stop()
                        break
                    depth = info.get("depth")
                    # Heartbeat: on a long/infinite search a single depth can take
                    # longer than the drain timeout, so re-emit the current depth (with
                    # the last completed lines) to keep the stream alive and the UI
                    # showing progress. Only once we have a real line to carry.
                    if (last_payload is not None and depth
                            and time.time() - state["last_emit"] >= KEEPALIVE_SECS):
                        emit(_progress_frame(last_payload, depth, target_depth))
                    # Need score + pv to render a line; multipv emits bare score
                    # refinements between PV updates that would blank a slot.
                    if depth is None or not info.get("score") or not info.get("pv"):
                        continue
                    mpv = info.get("multipv", 1)

                    # A fresh depth's first line means the previous depth's set is
                    # complete — emit it as one consistent multi-line payload.
                    if mpv == 1 and pending_mpv and depth != pending_depth:
                        if pending_depth > last_emitted_depth:
                            payload = _payload_from_multipv(
                                board, pending_mpv, pending_depth, target_depth=target_depth)
                            if payload["lines"]:
                                last_emitted_depth = pending_depth
                                last_payload = payload
                                emit(payload)
                        pending_mpv = {}

                    pending_mpv[mpv] = info
                    pending_depth = depth

                if (not self._superseded(generation) and pending_mpv
                        and pending_depth > last_emitted_depth):
                    final = _payload_from_multipv(
                        board, pending_mpv, pending_depth, target_depth=target_depth)
                    if final["lines"]:
                        last_payload = final
        except chess.engine.EngineTerminatedError:
            self._engine = None
            self._configured_threads = None
            force_emit({"error": "Engine restarted", "done": True})
            return
        except Exception as exc:
            force_emit({"error": str(exc), "done": True})
            return
        finally:
            with self._cv:
                if self._current_analysis is analysis:
                    self._current_analysis = None

        if self._superseded(generation):
            force_emit(_SUPERSEDED)
        elif last_payload is not None:
            force_emit({**last_payload, "done": True})
        else:
            force_emit({
                "depth": last_emitted_depth,
                "target_depth": target_depth,
                "eval": 0.0,
                "best_move": None,
                "best_move_uci": None,
                "lines": [],
                "done": True,
            })


    def stream(self, fen, depth=LIVE_DEPTH, max_seconds=LIVE_MAX_SECONDS):
        """Yield SSE frames with progressive depth results for ``fen``.

        Emits one frame per completed depth as the search climbs (d12, d13, …) and a
        final frame carrying ``done: True``. Always terminates with a ``done`` (or an
        ``error``) frame so the UI can never get stuck on "Searching…".

        ``depth``/``max_seconds`` cap the search; pass both ``<= 0`` for an unbounded
        (infinite) search that only stops on a newer request or client disconnect.
        """
        try:
            board = chess.Board(fen)
        except ValueError:
            yield _sse({"error": "Invalid FEN", "done": True})
            return

        limit = _build_limit(depth, max_seconds)
        if board.is_game_over():
            yield _sse(_terminal_payload(board, target_depth=limit.depth))
            return

        generation, q = self.submit(board, limit)
        try:
            while True:
                try:
                    item = q.get(timeout=DRAIN_TIMEOUT)
                except queue.Empty:
                    return  # worker vanished — let the client fall back / retry
                if item is _SUPERSEDED:
                    return
                yield _sse(item)
                if item.get("done"):
                    return
        finally:
            # Client gone (navigated away / closed tab): stop the search if it's ours.
            self.cancel(generation)


# Legacy module-level wrappers stay lazy for direct callers. The application uses
# one LiveEngineService stored on app.state and never touches this default.
_default_service = None


def _default():
    global _default_service
    if _default_service is None:
        _default_service = LiveEngineService()
    return _default_service


def start():
    _default().start()


def stream(fen, depth=LIVE_DEPTH, max_seconds=LIVE_MAX_SECONDS):
    return _default().stream(fen, depth, max_seconds)


def shutdown():
    global _default_service
    if _default_service is not None:
        _default_service.shutdown()
        _default_service = None
