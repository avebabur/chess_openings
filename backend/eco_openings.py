"""Offline opening recognizer built on the Lichess `chess-openings` corpus.

The app had no way to name a line from its moves, so every freshly-saved branch
landed in "Ungrouped" until the user typed an opening by hand. This module turns
a SAN move sequence into the most specific named opening it reaches.

Data: `data/eco/{a,b,c,d,e}.tsv` (vendored from github.com/lichess-org/chess-openings,
public domain). Each row is `eco<TAB>name<TAB>pgn`, e.g. `B12  Caro-Kann Defense:
Advance Variation  1. e4 c6 2. d4 d5 3. e5`. We replay each row's moves once and
index it by position key (see [[position_key]] — the FEN without the move clocks),
so transpositions map to the same opening regardless of move order.

`classify()` walks the caller's line, and of every position it passes through
returns the deepest one that is a known named opening — the longest prefix match,
which is exactly how Lichess labels a position.
"""
import os
import re
import threading

import chess

from position_key import key_from_san_path, position_key

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "eco")
_FILES = ("a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv")

# position key -> {"eco", "name"}. Built once, lazily, behind a lock (the API
# serves classify() from a threadpool, so concurrent first-hits must not race).
_index = None
_index_lock = threading.Lock()


def _key_for_pgn(movetext):
    """Replay a movetext column ("1. e4 c6 2. d4") and return its position key.

    The pgn cells are bare SAN with move numbers; we drop the numbers and push
    each move. Returns None if a token doesn't parse (shouldn't happen for the
    vendored data, but we never want one bad row to break the whole index)."""
    moves = [
        token for token in movetext.split()
        if not token[0].isdigit()  # "1." / "12." move numbers, and "1-0" etc.
    ]
    return key_from_san_path(moves)


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
                    key = _key_for_pgn(pgn)
                    if key:
                        # Two rows can land on one position by transposition. We
                        # keep the first, which means file order (a.tsv…e.tsv)
                        # decides on the rare collision where the names differ.
                        index.setdefault(key, {"eco": eco, "name": name})
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
        hit = index.get(position_key(board))
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


def name_at(fen, moves_san=""):
    """The opening name of the position `fen`, or None.

    With the moves that led there (`moves_san`, from the normal start) it is
    the deepest named position on the way, as Lichess names a position; that
    line is only believed when it really ends in `fen`. Without it, or when it
    does not fit, only a position that is itself a named opening has a name."""
    index = _get_index()
    try:
        target = position_key(chess.Board(fen))
    except ValueError:
        return None
    if moves_san:
        board = chess.Board()
        best = None
        for token in moves_san.split():
            try:
                board.push_san(token)
            except ValueError:
                best = None
                break
            best = index.get(position_key(board)) or best
        else:
            if best and position_key(board) == target:
                return best["name"]
    hit = index.get(target)
    return hit["name"] if hit else None


_spellings = None


def _plain(name):
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def canonical_spelling(name):
    """`name` as the ECO list spells it, when it is one of its openings or
    opening families apart from punctuation and capitals ("Caro Kann Defense
    Classical Variation" -> "Caro-Kann Defense: Classical Variation"). Any
    other name comes back unchanged."""
    global _spellings
    if _spellings is None:
        spellings = {}
        for entry in _get_index().values():
            full = entry["name"]
            for candidate in (full, full.split(":")[0].strip()):
                spellings.setdefault(_plain(candidate), candidate)
        _spellings = spellings
    return _spellings.get(_plain(name), name)
