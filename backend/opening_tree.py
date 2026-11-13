"""Personal opening tree over the user's own games — our own openingtree.com.

Given the user's imported games (each tagged with the color they played), this
aggregates, for any position reached by a move path, the win/draw/loss split from
*the user's* point of view plus each candidate next move's stats. Pure aggregation
over stored PGNs — no engine. The returned node carries the position's FEN so the
frontend can layer on a lichess cloud eval, Maia human %, and Stockfish lines.

Positions, not move orders
--------------------------
This used to be a trie keyed on SAN tokens, which meant 1.d4 Nf6 2.c4 and
1.c4 Nf6 2.d4 were different nodes with separately-counted games. For anyone
playing a transposition-heavy system that under-reported badly — in this repo's
own data, a position reached in 30 games displayed 15.

So it is a **directed graph over positions** instead. Nodes are keyed by position
(see [[position_key]]); edges are the SAN moves between them. A node therefore has
many parents, and we keep a `paths` counter of which move orders actually reached
it so the UI can say "30 games, 15 of them by a different move order" and offer
the other orders as links.

Navigation is still by SAN path — a move list is how people read a chess line —
but the path is only a way to *address* a position, never its identity.
"""
import io
import threading
from collections import OrderedDict

import chess
import chess.pgn

from position_key import position_key

MAX_PLIES = 40  # how deep we index move paths (move 20 per side)
MAX_EXAMPLES = 12  # sample games kept per position
MAX_TRANSPOSITIONS = 12  # alternative move orders reported per position
MAX_CACHED_TREES = 4  # built graphs held in memory; see OpeningTreeCache


def _graph_key(board):
    """The graph's internal node key: the same identity as ``position_key``.

    ``board.epd()`` rebuilds a FEN string square by square, and computing it per
    ply was ~70% of a cold tree build. This packs exactly the fields an EPD
    carries — piece placement (six piece bitboards plus White's occupancy),
    castling rights, the en-passant square only when the capture is legal, and
    side to move — into one int, so two boards share a key iff their EPDs match.
    It never leaves this module; responses still report ``position_key``.
    """
    key = board.clean_castling_rights()
    for bitboard in (board.occupied_co[chess.WHITE], board.pawns, board.knights,
                     board.bishops, board.rooks, board.queens, board.kings):
        key = (key << 64) | bitboard
    ep = board.ep_square if board.has_legal_en_passant() else 64
    return (((key << 7) | ep) << 1) | int(board.turn)


START_KEY = _graph_key(chess.Board())


class _OpeningMoves(chess.pgn.BaseVisitor):
    """Collect the first ``cap`` mainline moves of a PGN, then stop parsing SAN.

    ``read_game``'s default GameBuilder parses and validates *every* move of the
    game (plus clock comments) into a node tree, though only the opening is used
    here. Returning SKIP from ``begin_parse_san`` once we have enough makes the
    rest of the game a token scan.
    """

    def __init__(self, cap):
        self.cap = cap
        self.start = None
        self.moves = []

    def begin_variation(self):
        return chess.pgn.SKIP

    def begin_parse_san(self, board, san):
        return chess.pgn.SKIP if len(self.moves) >= self.cap else None

    def visit_move(self, board, move):
        if self.start is None:
            self.start = board.copy(stack=False)
        self.moves.append(move)

    def handle_error(self, error):
        # Like GameBuilder: an illegal move ends the line; keep what came before.
        self.cap = len(self.moves)

    def result(self):
        return self


def _parse_plies(pgn, cap=MAX_PLIES):
    """Replay a PGN mainline into ``[(san, key_before, key_after), ...]``.

    We already had to walk the game on a board to produce canonical SAN, so the
    position keys come almost free — and each ply's ``key_after`` *is* the next
    ply's ``key_before``, so it is computed (and stored) once. Stops at the first
    move that doesn't apply. Keys are ``_graph_key`` values.
    """
    parsed = chess.pgn.read_game(io.StringIO(pgn), Visitor=lambda: _OpeningMoves(cap))
    if parsed is None or parsed.start is None:
        return []
    board = parsed.start
    out = []
    before = _graph_key(board)
    for mv in parsed.moves:
        try:
            san = board.san(mv)
            board.push(mv)
        except (ValueError, AssertionError):
            break
        after = _graph_key(board)
        out.append((san, before, after))
        before = after
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


def _dag_node(key):
    """One position.

    ``moves[san]`` is the outgoing edge: its own aggregate (how the games that
    played *this move from here* went) plus the child position's key. The edge
    aggregate and the child node's aggregate differ precisely by transpositions
    — that difference is what the UI surfaces.

    ``paths`` counts the move orders that reached this position, one tally per
    game, so ``sum(paths.values()) == agg["games"]`` exactly.
    """
    return {"key": key, "agg": _new_agg(), "moves": {},
            "examples": [], "paths": {}}


def _example(game):
    return {"id": game["id"], "result": game.get("result"),
            "opp_rating": game.get("opp_rating")}


def _build_graph(games, color, plies_for=None):
    """Fold games into ``{graph key: node}``. The root is always present."""
    plies_for = plies_for or (lambda game: _parse_plies(game.get("pgn") or ""))
    graph = {START_KEY: _dag_node(START_KEY)}

    for game in games:
        if game.get("user_color") != color:
            continue
        root = graph[START_KEY]
        _tally(root["agg"], game, color)
        root["paths"][()] = root["paths"].get((), 0) + 1
        if len(root["examples"]) < MAX_EXAMPLES:
            root["examples"].append(_example(game))

        # A game can revisit a position (repetitions, knight shuffles). A trie
        # could not; a graph can, so each game counts a node — and an edge — at
        # most once, and is credited to the first move order that got there.
        seen_positions = {START_KEY}
        seen_departures = set()
        path = []

        for san, key_before, key_after in plies_for(game):
            path.append(san)
            parent = graph.get(key_before)
            if parent is None:  # unreachable: the parent was just visited
                parent = graph[key_before] = _dag_node(key_before)

            edge = parent["moves"].get(san)
            if edge is None:
                edge = parent["moves"][san] = {"agg": _new_agg(), "key": key_after}
            if key_before not in seen_departures:
                # One departure per position per game. A game that wanders back
                # (repetitions, knight shuffles) leaves the same position twice,
                # and crediting both made the move shares at that position sum
                # past 100%. The first choice is the one that answers "when I
                # reached here, what did I play?"; the later one only happened
                # because the game returned.
                seen_departures.add(key_before)
                _tally(edge["agg"], game, color)

            node = graph.get(key_after)
            if node is None:
                node = graph[key_after] = _dag_node(key_after)
            if key_after not in seen_positions:
                seen_positions.add(key_after)
                _tally(node["agg"], game, color)
                key = tuple(path)
                node["paths"][key] = node["paths"].get(key, 0) + 1
                if len(node["examples"]) < MAX_EXAMPLES:
                    node["examples"].append(_example(game))

    return graph


def _transpositions(node, path):
    """The move orders other than ``path`` that reached this position."""
    others = [(order, n) for order, n in node["paths"].items() if order != tuple(path)]
    others.sort(key=lambda item: (-item[1], len(item[0]), item[0]))
    return [{"path": list(order), "path_san": " ".join(order), "games": n}
            for order, n in others[:MAX_TRANSPOSITIONS]]


def _node_from_graph(graph, color, path, fen=None):
    """The node at ``path`` (SAN moves from the start), or — when ``fen`` is
    given — at that position directly, whatever move order reached it. The
    graph is keyed by position, so a FEN lookup needs no path at all; it is how
    the Lichess extension asks about the board it is showing."""
    path = [] if fen else [p for p in path if p]
    board = chess.Board(fen) if fen else chess.Board()
    legal_path = True
    for san in path:
        try:
            board.push_san(san)
        except ValueError:
            legal_path = False
            break

    epd = position_key(board) if legal_path else None
    current = graph.get(_graph_key(board)) if legal_path else None
    current = current or _dag_node(None)

    aggregate = current["agg"]
    parent_games = aggregate["games"]
    move_list = []
    for san, edge in current["moves"].items():
        child = graph.get(edge["key"])
        summary = _summary(san, edge["agg"], parent_games, board)
        # `games` is how often this move was played *from here*; `total_games`
        # counts every game that reached the resulting position, by any order.
        summary["total_games"] = child["agg"]["games"] if child else summary["games"]
        summary["transposed_games"] = max(0, summary["total_games"] - summary["games"])
        move_list.append(summary)
    # Deterministic: ties broken by SAN so equal rows can't swap between builds.
    move_list.sort(key=lambda c: (-c["games"], -c["score"], c["san"]))

    return {
        "color": color,
        "path": path,
        "epd": epd,
        "fen": board.fen() if legal_path else None,
        "legal": legal_path,
        "summary": _summary(None, aggregate, parent_games or 1, None),
        "direct_games": current["paths"].get(tuple(path), 0),
        "total_games": aggregate["games"],
        # Orders other than the one asked for. Don't assume the requested path is
        # one of them: a position can be addressed by an order nobody ever played,
        # in which case every recorded order is a transposition.
        "transposition_count": len(current["paths"]) - (
            1 if tuple(path) in current["paths"] else 0
        ),
        "transpositions": _transpositions(current, path),
        "moves": move_list,
        "examples": current["examples"],
    }


def node(games, color, path):
    """Uncached compatibility entry point used by focused unit tests."""
    return _node_from_graph(_build_graph(games, color), color, path)


class OpeningTreeCache:
    """Lifespan-owned cache of fully aggregated graphs and parsed PGNs."""

    def __init__(self, game_loader=None, max_trees=MAX_CACHED_TREES):
        self._lock = threading.Lock()
        self._moves = {}
        # Bounded, least-recently-used first. A position graph is roughly twice
        # the size of the old trie (it carries both node and edge aggregates),
        # and (color × time_classes × account) can reach dozens of keys, so this
        # can no longer grow without a ceiling.
        self._trees = OrderedDict()
        self._max_trees = max(1, max_trees)
        self._game_loader = game_loader
        # Bumped by every invalidate(). A build that started before an
        # invalidation read the old games, so it must not be cached after it.
        self._generation = 0
        # Builds are CPU-bound, so the GIL serializes them anyway; doing it
        # explicitly means a burst of requests for one cold key builds it once.
        self._build_lock = threading.Lock()

    def _moves_for(self, game):
        gid = game["id"]
        with self._lock:
            cached = self._moves.get(gid)
        if cached is not None:
            return cached
        plies = _parse_plies(game.get("pgn") or "")
        with self._lock:
            return self._moves.setdefault(gid, plies)

    def _remember(self, key, graph):
        """Store under the LRU cap, returning whatever is now cached for key."""
        existing = self._trees.get(key)
        if existing is not None:
            self._trees.move_to_end(key)
            return existing
        self._trees[key] = graph
        while len(self._trees) > self._max_trees:
            self._trees.popitem(last=False)
        return graph

    def node_for_filter(self, color, path, time_classes=None, account_id=None, fen=None):
        if self._game_loader is None:
            import database as db
            loader = db.get_games_for_tree
        else:
            loader = self._game_loader
        key = (color, tuple(sorted(time_classes or ())), account_id)
        root = self._cached(key)
        if root is None:
            with self._build_lock:
                root = self._cached(key)
                if root is None:
                    with self._lock:
                        generation = self._generation
                    games = loader(color=color, time_classes=time_classes, account_id=account_id)
                    root = _build_graph(games, color, self._moves_for)
                    with self._lock:
                        # Invalidated mid-build (a sync landed): this graph is
                        # still good for the request that asked, but caching it
                        # would hide the new games until the next invalidation.
                        if generation == self._generation:
                            root = self._remember(key, root)
        return _node_from_graph(root, color, path, fen)

    def games_through(self, fen, color=None, time_classes=None, account_id=None):
        """Your games that reached the position in ``fen`` by any move order,
        newest first, each with the ply where it got there (0 = the start)."""
        if self._game_loader is None:
            import database as db
            loader = db.get_games_for_tree
        else:
            loader = self._game_loader
        target = _graph_key(chess.Board(fen))
        found = []
        for game in loader(color=color, time_classes=time_classes, account_id=account_id):
            if target == START_KEY:
                ply = 0
            else:
                ply = next((i + 1 for i, (_, _, after) in enumerate(self._moves_for(game))
                            if after == target), None)
                if ply is None:
                    continue
            found.append((game, ply))
        found.sort(key=lambda item: (item[0].get("end_time") or "", item[0]["id"]), reverse=True)
        return found

    def _cached(self, key):
        with self._lock:
            root = self._trees.get(key)
            if root is not None:
                self._trees.move_to_end(key)
            return root

    def invalidate(self, account_id=None):
        """Drop built graphs so the next read rebuilds them.

        The per-game parsed-PGN memo (``_moves``) is keyed by immutable game id —
        a game's mainline never changes — so it is *kept* across invalidations; it
        is the slow part of a rebuild. Passing an ``account_id`` drops only that
        account's graphs plus the combined "All accounts" key (``account_id is
        None``), leaving other accounts' graphs intact. With no arg, all go.
        """
        with self._lock:
            self._generation += 1
            if account_id is None:
                self._trees.clear()
            else:
                # key == (color, time_classes_tuple, account_id)
                for key in [k for k in self._trees if k[2] in (account_id, None)]:
                    del self._trees[key]


# Compatibility entry points for focused repository tests and older callers.
# The FastAPI runtime creates its own cache in the application lifespan.
_default_cache = OpeningTreeCache()


def node_for_filter(color, path, time_classes=None, account_id=None, fen=None):
    return _default_cache.node_for_filter(color, path, time_classes, account_id, fen)


def invalidate_cache(account_id=None):
    _default_cache.invalidate(account_id)
