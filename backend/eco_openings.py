"""Offline opening recognizer built on the Lichess `chess-openings` corpus.

The app had no way to name a line from its moves, so every freshly-saved branch
landed in "Ungrouped" until the user typed an opening by hand. This module turns
a SAN move sequence into the most specific named opening it reaches.

Data: `data/eco/{a,b,c,d,e}.tsv` (vendored from github.com/lichess-org/chess-openings,
public domain). Each row is `eco<TAB>name<TAB>pgn`, e.g. `B12  Caro-Kann Defense:
Advance Variation  1. e4 c6 2. d4 d5 3. e5`. We replay each row's moves once and
index it by board EPD (FEN without the move clocks), so transpositions map to the
same opening regardless of move order.

`classify()` walks the caller's line, and of every position it passes through
returns the deepest one that is a known named opening — the longest prefix match,
which is exactly how Lichess labels a position.
"""
import os
import threading

import chess

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "eco")
_FILES = ("a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv")

# epd -> {"eco", "name"}. Built once, lazily, behind a lock (the API serves
# classify() from a threadpool, so concurrent first-hits must not race).
_index = None
_index_lock = threading.Lock()


def _epd_for_pgn(movetext):
    """Replay a movetext column ("1. e4 c6 2. d4") and return its board EPD.

    The pgn cells are bare SAN with move numbers; we drop the numbers and push
    each move. Returns None if a token doesn't parse (shouldn't happen for the
    vendored data, but we never want one bad row to break the whole index)."""
    board = chess.Board()
    for token in movetext.split():
        if token[0].isdigit():  # "1." / "12." move numbers, and "1-0" etc.
            continue
        try:
            board.push_san(token)
        except ValueError:
            return None
    return board.epd()


def _load():
    index = {}
    for fname in _FILES:
        path = os.path.join(_DATA_DIR, fname)
        try:
            with open(path, encoding="utf-8") as fh:
                next(fh, None)  # skip the `eco\tname\tpgn` header
                for line in fh:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) < 3:
                        continue
                    eco, name, pgn = parts[0], parts[1], parts[2]
                    epd = _epd_for_pgn(pgn)
                    if epd:
                        # Later, more-specific rows can share a prefix EPD with an
                        # earlier base row only via transposition; first write wins
                        # and is fine since the name is identical for a given EPD.
                        index.setdefault(epd, {"eco": eco, "name": name})
        except FileNotFoundError:
            continue
    return index


def _get_index():
    global _index
    if _index is None:
        with _index_lock:
            if _index is None:
                _index = _load()
    return _index


def classify(moves_san):
    """Name the opening reached by a SAN line.

    `moves_san` is a space-separated SAN string ("e4 c6 d4 d5"). Returns
    `{"eco", "name", "family", "variation"}` for the deepest named position the
    line passes through, or None for the empty/unrecognized line. `family` is the
    part before the first colon ("Caro-Kann Defense"); `variation` is the full
    name. Replay stops at the first illegal/unknown move and reports the best
    match found up to that point."""
    index = _get_index()
    board = chess.Board()
    best = None
    for token in (moves_san or "").split():
        try:
            board.push_san(token)
        except ValueError:
            break
        hit = index.get(board.epd())
        if hit:
            best = hit
    if not best:
        return None
    name = best["name"]
    return {
        "eco": best["eco"],
        "name": name,
        "family": name.split(":")[0].strip(),
        "variation": name,
    }
