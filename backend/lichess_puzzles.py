"""Lichess puzzles, one at a time.

`GET https://lichess.org/api/puzzle/next` hands out a puzzle for a theme
("angle") and a difficulty, with no account needed. The answer carries the
position, the opponent's last move and the whole solution, so a move is
checked here without an engine. Every puzzle that is fetched is kept, with
the user's record on it, so missed ones can be tried again later, offline.

No token is sent: an anonymous request is rated around 1500, and
`difficulty` moves that by up to 600 either way.
"""
import json
import logging

import chess
import httpx

from database import get_db

log = logging.getLogger(__name__)

NEXT_URL = "https://lichess.org/api/puzzle/next"
USER_AGENT = "ChessOpenings/1.0"
_TIMEOUT = httpx.Timeout(15.0)

# Rating offsets Lichess applies: -600, -300, 0, +300, +600.
DIFFICULTIES = ("easiest", "easier", "normal", "harder", "hardest")

# Every theme key Lichess accepts as `angle`, grouped as on lichess.org/training/themes.
THEME_GROUPS = (
    ("Recommended", (("mix", "Healthy mix"),)),
    ("Phases", (
        ("opening", "Opening"), ("middlegame", "Middlegame"), ("endgame", "Endgame"),
        ("rookEndgame", "Rook endgame"), ("pawnEndgame", "Pawn endgame"),
        ("bishopEndgame", "Bishop endgame"), ("knightEndgame", "Knight endgame"),
        ("queenEndgame", "Queen endgame"), ("queenRookEndgame", "Queen and rook endgame"),
    )),
    ("Motifs", (
        ("advancedPawn", "Advanced pawn"), ("attackingF2F7", "Attacking f2 or f7"),
        ("capturingDefender", "Capture the defender"), ("discoveredAttack", "Discovered attack"),
        ("doubleCheck", "Double check"), ("exposedKing", "Exposed king"), ("fork", "Fork"),
        ("hangingPiece", "Hanging piece"), ("kingsideAttack", "Kingside attack"),
        ("pin", "Pin"), ("queensideAttack", "Queenside attack"), ("sacrifice", "Sacrifice"),
        ("skewer", "Skewer"), ("trappedPiece", "Trapped piece"),
    )),
    ("Advanced", (
        ("attraction", "Attraction"), ("clearance", "Clearance"),
        ("defensiveMove", "Defensive move"), ("deflection", "Deflection"),
        ("interference", "Interference"), ("intermezzo", "Intermezzo"),
        ("quietMove", "Quiet move"), ("xRayAttack", "X-ray attack"), ("zugzwang", "Zugzwang"),
    )),
    ("Mates", (
        ("mate", "Checkmate"), ("mateIn1", "Mate in 1"), ("mateIn2", "Mate in 2"),
        ("mateIn3", "Mate in 3"), ("mateIn4", "Mate in 4"), ("mateIn5", "Mate in 5 or more"),
        ("anastasiaMate", "Anastasia's mate"), ("arabianMate", "Arabian mate"),
        ("backRankMate", "Back rank mate"), ("bodenMate", "Boden's mate"),
        ("doubleBishopMate", "Double bishop mate"), ("dovetailMate", "Dovetail mate"),
        ("hookMate", "Hook mate"), ("smotheredMate", "Smothered mate"),
    )),
    ("Special moves", (
        ("castling", "Castling"), ("enPassant", "En passant"), ("promotion", "Promotion"),
        ("underPromotion", "Underpromotion"),
    )),
    ("Goals", (
        ("equality", "Equality"), ("advantage", "Advantage"), ("crushing", "Crushing"),
    )),
    ("Lengths", (
        ("oneMove", "One-move puzzle"), ("short", "Short puzzle"), ("long", "Long puzzle"),
        ("veryLong", "Very long puzzle"),
    )),
    ("Origin", (
        ("master", "Master games"), ("masterVsMaster", "Master vs master"),
        ("superGM", "Super GM games"),
    )),
)
THEMES = {key: label for _, items in THEME_GROUPS for key, label in items}


class PuzzleError(Exception):
    """A puzzle could not be fetched; the message is safe to show."""


def parse_puzzle(data, theme):
    """Lichess's answer -> the row this app stores. Raises PuzzleError when the
    solution does not play from the position, which would make it unsolvable."""
    try:
        puzzle = data["puzzle"]
        board = chess.Board(puzzle["fen"])
        solution = list(puzzle["solution"])
        sans = []
        line = board.copy()
        for uci in solution:
            move = chess.Move.from_uci(uci)
            if move not in line.legal_moves:
                raise ValueError(f"illegal solution move {uci}")
            sans.append(line.san(move))
            line.push(move)
        if not solution:
            raise ValueError("empty solution")
        return {
            "id": str(puzzle["id"]),
            "fen": board.fen(),
            "user_color": "white" if board.turn == chess.WHITE else "black",
            "last_move": puzzle.get("lastMove") or "",
            "solution": solution,
            "solution_san": sans,
            "rating": int(puzzle.get("rating") or 0),
            "themes": list(puzzle.get("themes") or []),
            "theme": theme,
            "game_id": str((data.get("game") or {}).get("id") or ""),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise PuzzleError("Lichess sent a puzzle this app cannot read") from exc


def fetch_next(client, theme="mix", difficulty="normal"):
    """Ask Lichess for a puzzle, keep it, and return it with the user's record."""
    if theme not in THEMES:
        raise PuzzleError("Unknown puzzle theme")
    if difficulty not in DIFFICULTIES:
        raise PuzzleError("Unknown difficulty")
    try:
        response = (client or httpx).get(
            NEXT_URL, params={"angle": theme, "difficulty": difficulty},
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=_TIMEOUT,
        )
    except Exception as exc:
        log.warning("Lichess puzzle request failed: %s", exc)
        raise PuzzleError("Could not reach Lichess") from exc
    if response.status_code == 429:
        raise PuzzleError("Lichess asked to slow down. Wait a minute and try again.")
    if response.status_code != 200:
        raise PuzzleError(f"Lichess answered with an error ({response.status_code})")
    try:
        data = response.json()
    except ValueError as exc:
        raise PuzzleError("Lichess sent a puzzle this app cannot read") from exc
    puzzle = parse_puzzle(data, theme)
    store(puzzle)
    return get(puzzle["id"])


# --- Storage -------------------------------------------------------------

def store(puzzle):
    """Keep a puzzle. One that comes round again keeps its record and the
    theme it was first played under, so the per-theme counts do not move."""
    conn = get_db()
    try:
        with conn:
            conn.execute(
                """INSERT INTO lichess_puzzles
                   (id, fen, user_color, last_move, solution, solution_san, rating, themes,
                    theme, game_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     rating = excluded.rating, themes = excluded.themes,
                     fetched_at = datetime('now')""",
                (puzzle["id"], puzzle["fen"], puzzle["user_color"], puzzle["last_move"],
                 json.dumps(puzzle["solution"]), json.dumps(puzzle["solution_san"]),
                 puzzle["rating"], json.dumps(puzzle["themes"]), puzzle["theme"],
                 puzzle["game_id"]),
            )
    finally:
        conn.close()


def _puzzle_dict(row):
    return {
        "id": row["id"], "fen": row["fen"], "user_color": row["user_color"],
        "last_move": row["last_move"],
        "solution": json.loads(row["solution"]),
        "solution_san": json.loads(row["solution_san"]),
        "rating": row["rating"], "themes": json.loads(row["themes"]), "theme": row["theme"],
        "url": f"https://lichess.org/training/{row['id']}",
        "progress": {
            "attempts": row["attempts"], "solved": row["solved_count"],
            "failed": row["failed_count"], "last_result": row["last_result"],
            "last_played_at": row["last_played_at"],
        },
    }


def get(puzzle_id):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM lichess_puzzles WHERE id = ?", (puzzle_id,)).fetchone()
    finally:
        conn.close()
    return _puzzle_dict(row) if row else None


def record_attempt(puzzle_id, solved):
    conn = get_db()
    try:
        with conn:
            done = conn.execute(
                """UPDATE lichess_puzzles SET attempts = attempts + 1,
                     solved_count = solved_count + ?, failed_count = failed_count + ?,
                     first_result = COALESCE(first_result, ?),
                     last_result = ?, last_played_at = datetime('now')
                   WHERE id = ?""",
                (1 if solved else 0, 0 if solved else 1,
                 "solved" if solved else "failed",
                 "solved" if solved else "failed", puzzle_id),
            )
            if not done.rowcount:
                return None
    finally:
        conn.close()
    return get(puzzle_id)["progress"]


def summary(missed_limit=30):
    """What the Play tab shows: the themes, the user's totals, how each theme
    has gone (by the first try, as Lichess counts), and the missed puzzles."""
    conn = get_db()
    try:
        played = conn.execute(
            "SELECT theme, first_result, COUNT(*) AS n FROM lichess_puzzles "
            "WHERE first_result IS NOT NULL GROUP BY theme, first_result"
        ).fetchall()
        missed = conn.execute(
            "SELECT * FROM lichess_puzzles WHERE last_result = 'failed' "
            "ORDER BY last_played_at DESC LIMIT ?", (missed_limit,),
        ).fetchall()
    finally:
        conn.close()
    by_theme = {}
    for row in played:
        entry = by_theme.setdefault(row["theme"], {"played": 0, "solved": 0})
        entry["played"] += row["n"]
        if row["first_result"] == "solved":
            entry["solved"] += row["n"]
    return {
        "groups": [
            {"title": title, "themes": [
                {"key": key, "label": label, **by_theme.get(key, {"played": 0, "solved": 0})}
                for key, label in items
            ]}
            for title, items in THEME_GROUPS
        ],
        "difficulties": list(DIFFICULTIES),
        "played": sum(e["played"] for e in by_theme.values()),
        "solved": sum(e["solved"] for e in by_theme.values()),
        "missed": [_puzzle_dict(row) for row in missed],
    }
