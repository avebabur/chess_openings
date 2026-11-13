"""Find the user's mistakes in their own games and keep them as positions.

Every position of a game is searched once by Stockfish for a short, fixed time.
A move of the user's is a mistake when it lowers their winning chances by ten
points or more, the same scale and thresholds Lichess uses (a blunder is
fifteen). The short search is only a filter: 0.3 seconds is enough to spot a
hung piece but too noisy near the threshold, so every move it suspects is
searched again, before and after, for a full second, and that deeper result
is the one that counts. With seven pieces or fewer the Lichess tablebase decides instead: a
move is a mistake exactly when it changes the result of the game, whatever the
engine thinks of it.

Each mistake is stored with the position before it, the move played and the
best move; the Lichess extension lists them on the game's card.

The search runs on its own Stockfish process, not the one serving Lichess's
analysis, so checking a game does not interrupt the engine bar.
"""
import io
import logging
import math
import os
import threading

import chess
import chess.engine
import chess.pgn

import lichess_tablebase
import stockfish
from database import get_db

log = logging.getLogger(__name__)

ANALYSIS_SECONDS = float(os.environ.get("OPENINGS_ANALYSIS_SECONDS", "0.3"))
VERIFY_SECONDS = float(os.environ.get("OPENINGS_ANALYSIS_VERIFY_SECONDS", "1.0"))
ANALYSIS_THREADS = int(os.environ.get("OPENINGS_ANALYSIS_THREADS", "2"))
ANALYSIS_HASH_MB = int(os.environ.get("OPENINGS_ANALYSIS_HASH_MB", "128"))

MATE_CP = 10000
# Winning-chance points (0-100) lost by a move. Lichess: 10 and 15.
MISTAKE_LOSS = 10.0
BLUNDER_LOSS = 15.0
# The quick search may underrate a mistake by this much and still have it
# looked at again.
VERIFY_MARGIN = 4.0
# A fix may lose up to this much against the best move (Lichess's "inaccuracy").
FIX_TOLERANCE = 5.0
# A fix is never asked to keep more than this, so "+9 instead of mate" passes.
MAX_TARGET_CP = 600
# Targets after a tablebase verdict. Play rates such a position +-MATE_CP or 0
# from the tablebase, or by Stockfish when the tablebase cannot be reached.
TABLEBASE_WIN_TARGET = 300
TABLEBASE_DRAW_TARGET = -100

_OUTCOME_CP = {"win": MATE_CP, "draw": 0, "loss": -MATE_CP}
_OUTCOME_CHANCE = {"win": 100.0, "draw": 50.0, "loss": 0.0}
_WIN_K = 0.00368208  # Lichess's fit of centipawns to results


class AnalysisError(Exception):
    """Analysis could not start; the message is safe to show."""


def win_chance(cp):
    """Centipawns for a side -> that side's winning chances, 0 to 100."""
    cp = max(-MATE_CP, min(MATE_CP, cp))
    return 100.0 / (1.0 + math.exp(-_WIN_K * cp))


def cp_for_chance(chance):
    chance = max(0.5, min(99.5, chance))
    return round(math.log(chance / (100.0 - chance)) / _WIN_K)


def target_cp(cp_before):
    """What a replacement move must keep, from the mover's side."""
    return min(MAX_TARGET_CP, cp_for_chance(win_chance(cp_before) - FIX_TOLERANCE))


def classify(loss):
    if loss >= BLUNDER_LOSS:
        return "blunder"
    if loss >= MISTAKE_LOSS:
        return "mistake"
    return None


def new_engine():
    engine = chess.engine.SimpleEngine.popen_uci(stockfish.STOCKFISH_PATH)
    engine.configure({"Threads": ANALYSIS_THREADS, "Hash": ANALYSIS_HASH_MB})
    return engine


def _search(engine, board, seconds):
    """`(cp for the side to move, principal variation)` for one position."""
    if board.is_checkmate():
        return -MATE_CP, []
    if board.is_game_over():
        return 0, []
    info = engine.analyse(board, chess.engine.Limit(time=seconds))
    cp = info["score"].pov(board.turn).score(mate_score=MATE_CP)
    return cp, list(info.get("pv") or [])


_PIECE_CP = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 300,
             chess.ROOK: 500, chess.QUEEN: 900}


def _material(board, color):
    """`color`'s material minus the opponent's, in centipawns."""
    return sum(
        value * (len(board.pieces(kind, color)) - len(board.pieces(kind, not color)))
        for kind, value in _PIECE_CP.items()
    )


def _material_after(board, line, plies):
    """The mover's material balance after the first `plies` moves of `line`."""
    color = board.turn
    probe = board.copy()
    for move in line[:plies]:
        if move not in probe.legal_moves:
            break
        probe.push(move)
    return _material(probe, color)


def mistake_tag(before, move, best_line, reply_line, cp_before, cp_after):
    """What kind of mistake an engine-judged move was:

    missed_mate      there was a forced mate and the move let it go
    lost_material    the opponent's best reply wins a pawn or more at once
    missed_material  the best line won a pawn or more within two moves
    quiet            none of the above: nothing was lost on the spot
    """
    if cp_before >= MATE_CP - 100 and cp_after < MATE_CP - 100:
        return "missed_mate"
    now = _material(before, before.turn)
    after = before.copy()
    after.push(move)
    if reply_line:
        after.push(reply_line[0])
        if _material(after, before.turn) <= now - 100:
            return "lost_material"
    if _material_after(before, best_line, 3) >= now + 100:
        return "missed_material"
    return "quiet"


def _tablebase_mistake(table, board, move):
    """The tablebase's view of `move`: a mistake dict, or None if it kept the
    result. Raises LookupError when the tablebase cannot judge the move."""
    if not table or not table.get("available") or not table.get("moves"):
        raise LookupError("no tablebase")
    played = next((m for m in table["moves"] if m["uci"] == move.uci()), None)
    before = table.get("outcome")
    if played is None or played.get("outcome") is None or before is None:
        raise LookupError("move not judged")
    after = played["outcome"]
    loss = _OUTCOME_CHANCE[before] - _OUTCOME_CHANCE[after]
    if loss <= 0:
        return None
    best = table["moves"][0]
    return {
        "best_uci": best["uci"], "best_san": best["san"],
        "cp_before": _OUTCOME_CP[before], "cp_after": _OUTCOME_CP[after],
        "target_cp": TABLEBASE_WIN_TARGET if before == "win" else TABLEBASE_DRAW_TARGET,
        "loss": loss, "kind": "blunder", "source": "tablebase", "tag": "technique",
    }


def find_mistakes(pgn, user_color, engine, tablebase=None, seconds=None, should_stop=None,
                  verify_seconds=None):
    """The user's mistakes in one game, in the order they were played.

    `tablebase` is `fen -> table` (see lichess_tablebase.get_tablebase) or None
    to rely on the engine alone. Returns None if `should_stop()` turned true
    part-way, and raises ValueError for a PGN with no moves.
    """
    seconds = ANALYSIS_SECONDS if seconds is None else seconds
    verify_seconds = VERIFY_SECONDS if verify_seconds is None else verify_seconds
    game = chess.pgn.read_game(io.StringIO(pgn or ""))
    moves = list(game.mainline_moves()) if game else []
    if not moves:
        raise ValueError("The game has no moves")
    user_turn = chess.WHITE if user_color == "white" else chess.BLACK

    board = game.board()
    boards = [board.copy()]
    for move in moves:
        board.push(move)
        boards.append(board.copy())

    searched = {}

    def search(index, time=seconds):
        if (index, time) not in searched:
            searched[index, time] = _search(engine, boards[index], time)
        return searched[index, time]

    def judge(ply, move, time):
        """`(cp_before, best line, cp_after, reply line, loss)` at one depth,
        or None when the move played is the engine's own choice."""
        cp_before, best_line = search(ply, time)
        if not best_line or best_line[0] == move:
            return None
        # The position after is searched from the opponent's side.
        reply_cp, reply_line = search(ply + 1, time)
        cp_after = -reply_cp
        return cp_before, best_line, cp_after, reply_line, win_chance(cp_before) - win_chance(cp_after)

    mistakes = []
    for ply, move in enumerate(moves):
        before = boards[ply]
        if before.turn != user_turn:
            continue
        if should_stop and should_stop():
            return None
        base = {
            "ply": ply, "fen": before.fen(), "user_color": user_color,
            "played_san": before.san(move), "played_uci": move.uci(),
        }

        if tablebase and lichess_tablebase.piece_count(before) <= lichess_tablebase.MAX_PIECES:
            try:
                found = _tablebase_mistake(tablebase(before.fen()), before, move)
            except LookupError:
                pass
            else:
                if found:
                    mistakes.append({**base, **found})
                continue

        quick = judge(ply, move, seconds)
        if quick is None or quick[4] < MISTAKE_LOSS - VERIFY_MARGIN:
            continue
        # Suspected: the deeper search decides, and supplies the numbers.
        verified = judge(ply, move, max(verify_seconds, seconds))
        if verified is None:
            continue
        cp_before, best_line, cp_after, reply_line, loss = verified
        kind = classify(loss)
        if not kind:
            continue
        best = best_line[0]
        mistakes.append({
            **base,
            "best_uci": best.uci(), "best_san": before.san(best),
            "cp_before": cp_before, "cp_after": cp_after,
            "target_cp": target_cp(cp_before),
            "loss": round(loss, 1), "kind": kind, "source": "stockfish",
            "tag": mistake_tag(before, move, best_line, reply_line, cp_before, cp_after),
        })
    return mistakes


# --- Storage -------------------------------------------------------------

def store_mistakes(game_id, mistakes):
    """Replace a game's mistakes and mark it analysed. A mistake found again at
    the same move keeps its practice record."""
    conn = get_db()
    try:
        with conn:
            plies = [m["ply"] for m in mistakes]
            marks = ",".join("?" * len(plies))
            conn.execute(
                f"DELETE FROM game_mistakes WHERE game_id = ? AND ply NOT IN ({marks})",
                (game_id, *plies),
            )
            for m in mistakes:
                conn.execute(
                    """INSERT INTO game_mistakes
                       (game_id, ply, fen, user_color, played_san, played_uci, best_san,
                        best_uci, cp_before, cp_after, target_cp, loss, kind, source, tag)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(game_id, ply) DO UPDATE SET
                         fen = excluded.fen, user_color = excluded.user_color,
                         played_san = excluded.played_san, played_uci = excluded.played_uci,
                         best_san = excluded.best_san, best_uci = excluded.best_uci,
                         cp_before = excluded.cp_before, cp_after = excluded.cp_after,
                         target_cp = excluded.target_cp, loss = excluded.loss,
                         kind = excluded.kind, source = excluded.source,
                         tag = excluded.tag""",
                    (game_id, m["ply"], m["fen"], m["user_color"], m["played_san"],
                     m["played_uci"], m["best_san"], m["best_uci"], m["cp_before"],
                     m["cp_after"], m["target_cp"], m["loss"], m["kind"], m["source"],
                     m.get("tag", "")),
                )
            conn.execute(
                "UPDATE games SET mistakes_analyzed_at = datetime('now') WHERE id = ?",
                (game_id,),
            )
    finally:
        conn.close()


def _account_filter(account_id):
    return (" AND g.account_id = ?", [account_id]) if account_id else ("", [])


def games_to_check(game_ids):
    """The given games, if not yet searched for mistakes (one you asked for)."""
    if not game_ids:
        return []
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT g.id, g.pgn, g.user_color, g.white, g.black FROM games g "
            "WHERE g.user_color IN ('white', 'black') AND g.mistakes_analyzed_at IS NULL "
            f"AND g.id IN ({','.join('?' * len(game_ids))})", list(game_ids)).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def pending_games(account_id=None, limit=4):
    """The newest games not yet searched for mistakes, newest first."""
    where, params = _account_filter(account_id)
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT g.id, g.pgn, g.user_color, g.white, g.black FROM games g "
            "WHERE g.user_color IN ('white', 'black') AND g.merged_into_game_id IS NULL "
            "AND g.mistakes_analyzed_at IS NULL" + where +
            " ORDER BY g.end_time DESC, g.id DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def _mistake_dict(row):
    return {
        "id": row["id"], "game_id": row["game_id"], "ply": row["ply"], "fen": row["fen"],
        "user_color": row["user_color"],
        "played_san": row["played_san"], "played_uci": row["played_uci"],
        "best_san": row["best_san"],
        "cp_before": row["cp_before"], "cp_after": row["cp_after"],
        "target_cp": row["target_cp"], "loss": row["loss"],
        "kind": row["kind"], "source": row["source"], "tag": row["tag"],
        "progress": {
            "attempts": row["attempts"], "solved": row["solved_count"],
            "failed": row["failed_count"], "last_result": row["last_result"],
            "last_played_at": row["last_played_at"],
        },
    }


def mistakes_for_game(game_id):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM game_mistakes WHERE game_id = ? ORDER BY ply", (game_id,),
        ).fetchall()
    finally:
        conn.close()
    return [_mistake_dict(row) for row in rows]


# --- Background job ------------------------------------------------------

class GameAnalyzer:
    """Analyses games on a thread so the UI can show progress and stay usable.

    One run at a time: `start` while one is running just reports it, unless
    it is called with `queue=True` (the follow-up to a sync), in which case
    the request is kept and served when the current games are done. A game is
    stored only when it was analysed to the end, so stopping loses at most the
    game in progress.
    """

    def __init__(self, engine_factory=new_engine):
        self._engine_factory = engine_factory
        self._lock = threading.Lock()
        self._thread = None
        self._stop = threading.Event()
        self._queued = []  # (account_id, count) requests waiting for the run to end
        self._state = self._fresh(False)

    @staticmethod
    def _fresh(running, total=0):
        return {"running": running, "done": 0, "total": total, "title": "",
                "mistakes": 0, "error": None, "stopped": False}

    def status(self):
        with self._lock:
            return dict(self._state)

    def start(self, tablebase=None, account_id=None, count=4, queue=False, game_ids=None):
        """Search games for mistakes in the background: the newest `count`
        not yet searched, or exactly `game_ids` (one game you asked for)."""
        with self._lock:
            if self._state["running"]:
                if queue or game_ids:
                    self._queued.append((account_id, count, game_ids))
                return dict(self._state)
            if not stockfish.availability()["available"] and self._engine_factory is new_engine:
                raise AnalysisError("Stockfish is not installed")
            games = games_to_check(game_ids) if game_ids else pending_games(account_id, count)
            self._stop.clear()
            self._queued.clear()
            self._state = self._fresh(bool(games), len(games))
            if games:
                self._thread = threading.Thread(
                    target=self._run, args=(games, tablebase), name="game-analysis", daemon=True)
                self._thread.start()
            return dict(self._state)

    def _next_queued(self):
        """The games of the next waiting request that still has any, counted
        into the run's total; an empty list when nothing is waiting or the run
        was stopped."""
        while not self._stop.is_set():
            with self._lock:
                if not self._queued:
                    return []
                account_id, count, game_ids = self._queued.pop(0)
            games = games_to_check(game_ids) if game_ids else pending_games(account_id, count)
            if games:
                with self._lock:
                    self._state["total"] += len(games)
                return games
        return []

    def join(self, timeout=None):
        thread = self._thread
        if thread:
            thread.join(timeout)

    def shutdown(self):
        self._stop.set()
        self.join(5)

    def _run(self, games, tablebase):
        error = None
        engine = None
        try:
            engine = self._engine_factory()
            while games:
                for game in games:
                    with self._lock:
                        self._state["title"] = f"{game['white']} vs {game['black']}"
                    try:
                        mistakes = find_mistakes(
                            game["pgn"], game["user_color"], engine, tablebase,
                            should_stop=self._stop.is_set)
                    except ValueError:
                        mistakes = []  # unreadable PGN: nothing to learn, do not retry it
                    if mistakes is None:
                        break
                    store_mistakes(game["id"], mistakes)
                    with self._lock:
                        self._state["done"] += 1
                        self._state["mistakes"] += len(mistakes)
                games = self._next_queued()
        except Exception as exc:  # never leave the UI waiting on a dead thread
            log.exception("game analysis crashed")
            error = f"Analysis failed: {exc}"
        finally:
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass
            with self._lock:
                self._queued.clear()
                self._state.update(running=False, error=error, stopped=self._stop.is_set())
