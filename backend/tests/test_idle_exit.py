import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import idle_exit  # noqa: E402


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class IdleExitTests(unittest.TestCase):
    def test_it_expires_only_after_the_quiet_time_and_use_starts_it_again(self):
        clock = Clock()
        idle = idle_exit.IdleExit(120, on_idle=lambda: None, clock=clock)
        clock.now += 119
        self.assertFalse(idle.expired())
        idle.touch()            # a request, a keepalive or an engine job
        clock.now += 119
        self.assertFalse(idle.expired())
        clock.now += 2
        self.assertTrue(idle.expired())

    def test_the_watch_stops_the_service_once_and_not_while_it_is_used(self):
        async def scenario():
            stopped = []
            idle = idle_exit.IdleExit(0.3, on_idle=lambda: stopped.append(True))
            watch = asyncio.get_running_loop().create_task(idle.run())
            for _ in range(5):      # used every 0.1 s: stays up
                await asyncio.sleep(0.1)
                idle.touch()
            self.assertEqual(stopped, [])
            await asyncio.wait_for(watch, 2)  # then left alone: stops
            self.assertEqual(stopped, [True])
        asyncio.run(scenario())

    def test_it_is_off_unless_the_start_script_asks_for_it(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENINGS_IDLE_EXIT_SECONDS", None)
            self.assertIsNone(idle_exit.from_environment())
        with patch.dict(os.environ, {"OPENINGS_IDLE_EXIT_SECONDS": "120"}):
            self.assertEqual(idle_exit.from_environment().seconds, 120)
        with patch.dict(os.environ, {"OPENINGS_IDLE_EXIT_SECONDS": "nonsense"}):
            self.assertIsNone(idle_exit.from_environment())


if __name__ == "__main__":
    unittest.main()
