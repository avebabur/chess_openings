"""One definition of "the same chess position", shared by every subsystem.

The app used to identify a position by the SAN move path that reached it, so
1.d4 Nf6 2.c4 e6 and 1.d4 e6 2.c4 Nf6 were two unrelated things: split game
stats, duplicated repertoire nodes, and the same position scheduled twice by
spaced repetition. This module is the single answer to "are these the same
position?".

Identity is the **EPD** — the FEN's first four fields:

    <piece placement> <side to move> <castling rights> <en-passant square>

dropping the halfmove clock and the fullmove number, which are the only two
fields a transposition changes. All four kept fields matter:

  * the same pieces with the *other* player to move is a different position;
  * the same pieces where one side has lost the right to castle is a different
    position;
  * en passant is only part of the position when the capture is *actually*
    legal right now — python-chess writes the square only under that condition
    (pin legality included), and so does chess.js 1.4.0's ``fen()``.

That last agreement is why the frontend can compute the same key with
``fen.split(' ').slice(0, 4).join(' ')``. It is not an assumption:
``tests/data/position_key_fixtures.json`` is asserted by both the pytest and
the vitest suite, so the two runtimes drifting fails loudly on one side.

Caveat, accepted deliberately: dropping the halfmove clock means two positions
differing only in progress toward the 50-move rule share a key. That is
meaningless at opening depth, which is all this app deals with.

``eco_openings`` has always keyed its ECO index this way; everything else is
catching up.
"""
import chess

# The initial position. Handy as the seed of a per-game "positions already
# counted" set, where the root has no move that reaches it.
START_KEY = chess.Board().epd()


def position_key(board):
    """The position key for a live ``chess.Board``."""
    return board.epd()


def key_from_fen(fen):
    """The position key for a FEN string.

    Goes through ``chess.Board`` rather than slicing off four fields, because a
    FEN from outside this app can carry an en-passant square that is recorded
    but not actually playable; parsing normalizes it away so such a FEN keys to
    the same position as the identical board without it. Accepts a bare EPD too,
    so calling this on an already-normalized key is a no-op.

    Raises ``ValueError`` on an unparseable FEN, same as ``chess.Board``.
    """
    return chess.Board(fen).epd()


def _san_tokens(sans):
    if isinstance(sans, str):
        return sans.split()
    return [san for san in (sans or []) if san]


def key_from_san_path(sans):
    """The position key reached by a SAN line, or None if a move is illegal.

    ``sans`` is a space-separated string or an iterable of SAN tokens.
    """
    board = chess.Board()
    for san in _san_tokens(sans):
        try:
            board.push_san(san)
        except ValueError:
            return None
    return board.epd()


def keys_along_san_path(sans):
    """Walk a SAN line, yielding ``(san, epd_before, epd_after)`` per ply.

    Stops at the first illegal move and returns what it got, matching how the
    rest of the app replays possibly-imperfect lines (a truncated PGN should
    still contribute the moves it does have). Callers that need an illegal move
    to be an error should validate the line themselves.
    """
    board = chess.Board()
    out = []
    for san in _san_tokens(sans):
        before = board.epd()
        try:
            move = board.parse_san(san)
        except ValueError:
            break
        # Re-derive the SAN from the parsed move so the caller gets the
        # canonical spelling ("e8=Q+" not "e8Q") regardless of what came in.
        canonical = board.san(move)
        board.push(move)
        out.append((canonical, before, board.epd()))
    return out
