"""Lichess endgame-tablebase lookups (Syzygy, up to 7 pieces) with a local cache.

`GET https://tablebase.lichess.ovh/standard?fen=...` answers with the exact
result of a position with seven or fewer pieces, and of every legal move in it.
Unlike an engine evaluation this is a proof, not an estimate: it is what lets the
Play tab say "that move threw away the win" with certainty. No token is needed.

Two things about the upstream shape are easy to get backwards, so they are
normalized here once:

  - A *move's* `category` is given from the point of view of the side to move
    **after** the move, i.e. the opponent. `loss` on a move means the mover wins.
    Everything this module returns is from the mover's point of view instead.
  - Moves arrive sorted best-first for the side to move (fastest win first, then
    draws, then slowest loss), so `moves[0]` is perfect play. That order is kept.

Upstream answers `unknown` (HTTP 200) for more than seven pieces and for
positions that still have castling rights. Those are reported as unavailable and
never cached, and a position with too many pieces is not sent at all.

Results never change, so a hit is cached forever. The cache key keeps the
halfmove clock: with the 50-move rule a win can turn into a draw as the clock
runs, so two positions that differ only in that counter are different entries.
"""
import logging

import chess
import httpx

import database as db

log = logging.getLogger("lichess_tablebase")

TABLEBASE_URL = "https://tablebase.lichess.ovh/standard"
USER_AGENT = "ChessOpenings/1.0"
MAX_PIECES = 7
_TIMEOUT = httpx.Timeout(6.0)

# Upstream categories, collapsed to the practical result under the 50-move rule.
# `cursed-win` and `blessed-loss` are wins/losses that the 50-move rule turns
# into draws; `maybe-*` are wins/losses unless the clock interferes.
_OUTCOME = {
    "win": "win", "syzygy-win": "win", "maybe-win": "win",
    "cursed-win": "draw", "draw": "draw", "blessed-loss": "draw",
    "loss": "loss", "syzygy-loss": "loss", "maybe-loss": "loss",
}
_FLIP = {"win": "loss", "loss": "win", "draw": "draw"}
_FIFTY_MOVE = {"cursed-win", "blessed-loss"}


def cache_key(fen):
    """Position plus halfmove clock; the fullmove number is irrelevant."""
    return " ".join(fen.split()[:5])


def piece_count(board):
    return chess.popcount(board.occupied)


def _unavailable(reason):
    return {"available": False, "reason": reason}


def _negate(value):
    return -value if isinstance(value, int) else None


def normalize(data, board):
    """Upstream JSON -> the app's shape, everything from the mover's side."""
    outcome = _OUTCOME.get(data.get("category"))
    if outcome is None:
        return None
    moves = []
    for item in data.get("moves") or []:
        after = _OUTCOME.get(item.get("category"))
        try:
            move = chess.Move.from_uci(item["uci"])
            san = item.get("san") or board.san(move)
        except (KeyError, ValueError, AssertionError):
            continue
        moves.append({
            "uci": item["uci"],
            "san": san,
            # None when the move leads somewhere the tablebase cannot judge.
            "outcome": _FLIP.get(after),
            "fifty_move": item.get("category") in _FIFTY_MOVE,
            # Upstream counts from the opponent's side after the move; negated,
            # a positive number is "the mover mates in / zeroes in" that many plies.
            "dtm": _negate(item.get("dtm")),
            "dtz": _negate(item.get("dtz")),
            "zeroing": bool(item.get("zeroing")),
            "checkmate": bool(item.get("checkmate")),
            "stalemate": bool(item.get("stalemate")),
        })
    return {
        "available": True,
        "outcome": outcome,
        "fifty_move": data.get("category") in _FIFTY_MOVE,
        "dtm": data.get("dtm"),
        "dtz": data.get("dtz"),
        "moves": moves,
    }


def get_tablebase(fen, allow_network=True, client=None):
    """Exact result for `fen` and each of its moves, or `{"available": False}`.

    Reasons for unavailability: `pieces` (more than seven), `castling`,
    `offline` (not cached and the network is off), `unknown` (upstream cannot
    judge it) and `error` (the request failed).
    """
    board = chess.Board(fen)
    if piece_count(board) > MAX_PIECES:
        return _unavailable("pieces")
    if board.castling_rights:
        return _unavailable("castling")

    cached = db.get_tablebase_cached(cache_key(fen))
    if cached is not None:
        return cached
    if not allow_network:
        return _unavailable("offline")

    try:
        response = (client or httpx).get(
            TABLEBASE_URL,
            params={"fen": fen},
            headers={"User-Agent": USER_AGENT},
            timeout=_TIMEOUT,
        )
    except Exception as exc:
        log.warning("Lichess tablebase request failed: %s", exc)
        return _unavailable("error")
    if response.status_code != 200:
        log.warning("Lichess tablebase HTTP %s for fen=%s", response.status_code, fen)
        return _unavailable("error")

    try:
        result = normalize(response.json(), board)
    except ValueError:
        return _unavailable("error")
    if result is None:
        return _unavailable("unknown")
    db.put_tablebase(cache_key(fen), result)
    return result
