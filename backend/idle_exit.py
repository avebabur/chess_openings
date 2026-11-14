"""Stops the service by itself once the extension has gone quiet.

The Lichess extension starts this service when a Lichess page opens, and tells
it every half minute that a Lichess tab (or its settings page) is still open.
When Chrome quits or crashes, or the extension is switched off, nobody is left
to say stop, so the service watches for the silence itself: after
``OPENINGS_IDLE_EXIT_SECONDS`` without a request or an engine job it shuts
down, Stockfish included. start.sh sets that only when launchd (the extension's
helper) started it, so a service you start by hand in Terminal keeps running.
"""
import asyncio
import os
import signal
import time


def _stop_this_process():
    # uvicorn turns SIGTERM into a clean shutdown: the lifespan's cleanup runs,
    # which quits Stockfish and the background workers.
    os.kill(os.getpid(), signal.SIGTERM)


class IdleExit:
    def __init__(self, seconds, on_idle=_stop_this_process, clock=time.monotonic):
        self.seconds = float(seconds)
        self._on_idle = on_idle
        self._clock = clock
        self._last = clock()

    def touch(self):
        """Something used the service just now."""
        self._last = self._clock()

    def idle_for(self):
        return self._clock() - self._last

    def expired(self):
        return self.idle_for() >= self.seconds

    async def run(self):
        while not self.expired():
            await asyncio.sleep(max(0.05, min(5.0, self.seconds / 4)))
        self._on_idle()


def from_environment():
    """The watchdog start.sh asked for, or None (the default: never stop)."""
    try:
        seconds = float(os.environ.get("OPENINGS_IDLE_EXIT_SECONDS", "0") or 0)
    except ValueError:
        seconds = 0
    return IdleExit(seconds) if seconds > 0 else None
