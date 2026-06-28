"""Personal opening tree over the user's own games — our own openingtree.com.

Given the user's imported games (each tagged with the color they played), this
aggregates, for any position reached by a move path, the win/draw/loss split from
*the user's* point of view plus each candidate next move's stats. Pure aggregation
over stored PGNs — no engine. The returned node carries the position's FEN so the
frontend can layer on a lichess cloud eval, Maia human %, and Stockfish lines.
"""
import io
import threading

import chess
import chess.pgn

MAX_PLIES = 40  # how deep we index move paths (move 20 per side)

def _parse_moves(pgn, cap=MAX_PLIES):
    node = chess.pgn.read_game(io.StringIO(pgn))
    if node is None:
        return []
    board = node.board()
    out = []
    for mv in node.mainline_moves():
        try:
            out.append(board.san(mv))
            board.push(mv)
        except (ValueError, AssertionError):
            break
        if len(out) >= cap:
            break
    return out


def _result_pov(result, color):
    if result == "1-0":
        return "win" if color == "white" else "loss"
    if result == "0-1":
        return "win" if color == "black" else "loss"
    return "draw"


def _new_agg():
    return {"games": 0, "win": 0, "draw": 0, "loss": 0,
            "opp_sum": 0, "opp_n": 0, "last": None, "_openings": {}}


def _tally(agg, game, color):
    agg["games"] += 1
    agg[_result_pov(game.get("result"), color)] += 1
    opp = game.get("opp_rating")
    if opp:
        agg["opp_sum"] += opp
        agg["opp_n"] += 1
    et = game.get("end_time") or ""
    if et and (agg["last"] is None or et > agg["last"]):
        agg["last"] = et
    op = game.get("opening")
    if op:
        agg["_openings"][op] = agg["_openings"].get(op, 0) + 1


def _summary(san, agg, parent_games, board):
    games = agg["games"] or 0
    g = games or 1
    avg_opp = round(agg["opp_sum"] / agg["opp_n"]) if agg["opp_n"] else None
    opening = max(agg["_openings"].items(), key=lambda x: x[1])[0] if agg["_openings"] else None
    uci = None
    if san and board is not None:
        try:
            uci = board.parse_san(san).uci()
        except ValueError:
            pass
    return {
        "san": san,
        "uci": uci,
        "games": games,
        "share": round(games / parent_games * 100, 1) if parent_games else 0,
        "win": agg["win"], "draw": agg["draw"], "loss": agg["loss"],
        "win_pct": round(agg["win"] / g * 100, 1),
        "draw_pct": round(agg["draw"] / g * 100, 1),
        "loss_pct": round(agg["loss"] / g * 100, 1),
        "score": round((agg["win"] + 0.5 * agg["draw"]) / g * 100, 1),
        "avg_opp_rating": avg_opp,
        "last_played": agg["last"],
        "opening": opening,
    }


def _trie_node():
    return {"agg": _new_agg(), "children": {}, "examples": []}


def _build_tree(games, color, moves_for=None):
    moves_for = moves_for or (lambda game: _parse_moves(game.get("pgn") or ""))
    root = _trie_node()
    for game in games:
        if game.get("user_color") != color:
            continue
        current = root
        _tally(current["agg"], game, color)
        current["examples"].append({
            "id": game["id"], "result": game.get("result"),
            "opp_rating": game.get("opp_rating"),
        }) if len(current["examples"]) < 12 else None
        for san in moves_for(game):
            current = current["children"].setdefault(san, _trie_node())
            _tally(current["agg"], game, color)
            if len(current["examples"]) < 12:
                current["examples"].append({
                    "id": game["id"], "result": game.get("result"),
                    "opp_rating": game.get("opp_rating"),
                })
    return root


def _node_from_tree(root, color, path):
    path = [p for p in path if p]
    board = chess.Board()
    legal_path = True
    current = root
    for san in path:
        try:
            board.push_san(san)
        except ValueError:
            legal_path = False
            break
        current = current["children"].get(san) if current else None

    aggregate = current["agg"] if current else _new_agg()
    children = current["children"] if current else {}
    parent_games = aggregate["games"]
    move_list = [_summary(san, child["agg"], parent_games, board)
                 for san, child in children.items()]
    move_list.sort(key=lambda c: (-c["games"], -c["score"]))

    return {
        "color": color,
        "path": path,
        "fen": board.fen() if legal_path else None,
        "legal": legal_path,
        "summary": _summary(None, aggregate, parent_games or 1, None),
        "moves": move_list,
        "examples": current["examples"] if current else [],
    }


def node(games, color, path):
    """Uncached compatibility entry point used by focused unit tests."""
    return _node_from_tree(_build_tree(games, color), color, path)


class OpeningTreeCache:
    """Lifespan-owned cache of fully aggregated trees and parsed PGNs."""

    def __init__(self, game_loader=None):
        self._lock = threading.Lock()
        self._moves = {}
        self._trees = {}
        self._game_loader = game_loader

    def _moves_for(self, game):
        gid = game["id"]
        with self._lock:
            cached = self._moves.get(gid)
        if cached is not None:
            return cached
        moves = _parse_moves(game.get("pgn") or "")
        with self._lock:
            return self._moves.setdefault(gid, moves)

    def node_for_filter(self, color, path, time_classes=None, account_id=None):
        if self._game_loader is None:
            import database as db
            loader = db.get_games_for_tree
        else:
            loader = self._game_loader
        key = (color, tuple(sorted(time_classes or ())), account_id)
        with self._lock:
            root = self._trees.get(key)
        if root is None:
            games = loader(color=color, time_classes=time_classes, account_id=account_id)
            built = _build_tree(games, color, self._moves_for)
            with self._lock:
                root = self._trees.setdefault(key, built)
        return _node_from_tree(root, color, path)

    def invalidate(self, account_id=None):
        """Drop built trees so the next read rebuilds them.

        The per-game parsed-PGN memo (``_moves``) is keyed by immutable game id —
        a game's mainline never changes — so it is *kept* across invalidations; it
        is the slow part of a rebuild. Passing an ``account_id`` drops only that
        account's trees plus the combined "All accounts" key (``account_id is
        None``), leaving other accounts' trees intact. With no arg, all trees go.
        """
        with self._lock:
            if account_id is None:
                self._trees.clear()
            else:
                # key == (color, time_classes_tuple, account_id)
                for key in [k for k in self._trees if k[2] in (account_id, None)]:
                    del self._trees[key]


# Compatibility entry points for focused repository tests and older callers.
# The FastAPI runtime creates its own cache in the application lifespan.
_default_cache = OpeningTreeCache()


def node_for_filter(color, path, time_classes=None, account_id=None):
    return _default_cache.node_for_filter(color, path, time_classes, account_id)


def invalidate_cache(account_id=None):
    _default_cache.invalidate(account_id)
