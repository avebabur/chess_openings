"""Where this Mac's Stockfish is, and whether it can be run.

Used by the Lichess external-engine link (lichess_engine_provider.py) and by
the search for mistakes in your games (game_analysis.py).
"""
import os


def _stockfish_path():
    configured = os.environ.get("STOCKFISH_PATH")
    if configured:
        return configured
    from shutil import which
    return which("stockfish") or "/opt/homebrew/bin/stockfish"


STOCKFISH_PATH = _stockfish_path()


def availability():
    available = os.path.isfile(STOCKFISH_PATH) and os.access(STOCKFISH_PATH, os.X_OK)
    return {
        "available": available,
        "path": STOCKFISH_PATH if available else None,
        "message": None if available else "Install Stockfish or set STOCKFISH_PATH",
    }
