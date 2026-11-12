"""The Lichess Practice library: every practice set, imported once into SQLite.

Lichess publishes its Practice sets as studies. The index page
(`https://lichess.org/practice`) lists them as `/practice/{section}/{slug}/{id}`
and each study exports as PGN (`/api/study/{id}.pgn`), one game per chapter.
A chapter is one position plus a goal, written in its `Termination` header:

    mate in 3          checkmate within 3 of your moves
    mate               checkmate, no move limit
    +300cp in 2        reach an advantage of 3 pawns within 2 of your moves
    -300cp in 2        the same, written from White's side (you are Black)
    promotion with +100cp   promote a pawn and still be better by 1 pawn
    equalize in 10     get back to an even position within 10 moves
    draw in 20         hold the draw for 20 moves

63 of the 316 chapters have no `Termination`. Some are lessons (an annotated
line to read) and some are plain exercises whose goal is only in the title.
Exercises whose goal is certain are given one (`goal_kind` mate/win); every
other chapter becomes a `study`: it can be played from, but nothing is judged.

You play the colour the board is turned to (`Orientation`); when that is not the
side to move, the opponent moves first. This module only knows how to fetch,
parse and store. Judging a game against the goal is done in the Play tab.

Lichess allows one request at a time and answers 429 when it is exceeded,
asking clients to wait a minute, so the import is sequential, slow and patient.
It is idempotent: a position is keyed by its study and chapter, so running it
again refreshes the text and keeps the progress.
"""
import io
import json
import logging
import re
import threading
import time

import chess
import chess.pgn
import httpx

from database import get_db

log = logging.getLogger("practice_library")

PRACTICE_INDEX_URL = "https://lichess.org/practice"
STUDY_PGN_URL = "https://lichess.org/api/study/{study_id}.pgn"
USER_AGENT = "ChessOpenings/1.0"
_TIMEOUT = httpx.Timeout(30.0)

# Seconds between requests, and how long to wait after a 429 (Lichess asks
# for a full minute). Module-level so tests can make them zero.
REQUEST_PAUSE = 1.5
RATE_LIMIT_WAIT = 62.0
MAX_ATTEMPTS = 4

_STUDY_LINK = re.compile(
    r'<a class="study[^"]*" href="/practice/(?P<section>[a-z-]+)/(?P<slug>[a-z0-9-]+)/(?P<id>[A-Za-z0-9]{8})">'
    r'.*?<h3>(?P<title>.*?)</h3>(?:<em>(?P<subtitle>.*?)</em>)?',
    re.S,
)
_SECTION = re.compile(r"<section><h2>(?P<title>.*?)</h2>(?P<body>.*?)</section>", re.S)
_ANNOTATION = re.compile(r"\[%[^\]]*\]")
_TAG = re.compile(r"<[^>]+>")


class PracticeImportError(Exception):
    """The import could not even start (index unreachable, network off)."""


# --- Parsing -------------------------------------------------------------

def _clean_html(text):
    return (_TAG.sub("", text or "").replace("&amp;", "&").replace("&#x27;", "'")
            .replace("&quot;", '"').strip())


def parse_index(html):
    """The index page -> `[{section, section_title, slug, id, title, subtitle}]`
    in the order Lichess shows them."""
    sets = []
    seen = set()
    for section in _SECTION.finditer(html):
        for link in _STUDY_LINK.finditer(section.group("body")):
            if link.group("id") in seen:
                continue
            seen.add(link.group("id"))
            sets.append({
                "section": link.group("section"),
                "section_title": _clean_html(section.group("title")),
                "slug": link.group("slug"),
                "id": link.group("id"),
                "title": _clean_html(link.group("title")),
                "subtitle": _clean_html(link.group("subtitle")),
            })
    return sets


_MATE_IN = re.compile(r"^mate(?:\s+in\s+(\d+))?$", re.I)
_EVAL_IN = re.compile(r"^([+-]?\d+)\s*cp\s+in\s+(\d+)$", re.I)
_PROMOTION = re.compile(r"^promotion\s+with\s+([+-]?\d+)\s*cp$", re.I)
_EQUALIZE = re.compile(r"^equali[sz]e\s+in\s+(\d+)$", re.I)
_DRAW = re.compile(r"^draw\s+in\s+(\d+)$", re.I)


def parse_goal(text):
    """A `Termination` value -> `{kind, cp, moves}`, or None if unrecognised.

    `cp` is a magnitude in centipawns, always from the point of view of the
    player. Lichess writes it from White's side (`-300cp` for a Black player
    who should be three pawns up), so the sign carries no extra meaning here.
    `moves` counts the player's own moves; None means no limit.
    """
    text = (text or "").strip()
    if match := _MATE_IN.match(text):
        moves = int(match.group(1)) if match.group(1) else None
        return {"kind": "mate", "cp": None, "moves": moves}
    if match := _EVAL_IN.match(text):
        return {"kind": "eval", "cp": abs(int(match.group(1))), "moves": int(match.group(2))}
    if match := _PROMOTION.match(text):
        return {"kind": "promotion", "cp": abs(int(match.group(1))), "moves": None}
    if match := _EQUALIZE.match(text):
        return {"kind": "equalize", "cp": None, "moves": int(match.group(1))}
    if match := _DRAW.match(text):
        return {"kind": "draw", "cp": None, "moves": int(match.group(1))}
    return None


def infer_goal(section, name, has_moves):
    """The goal of a chapter that has no `Termination`, or a `study`.

    Only certain cases get a goal: a mating exercise in the Checkmates section
    (the title names the mate) and a pawn-ending "Exercise: ... = Win".
    Everything else is a lesson, or too unclear to judge honestly.
    """
    lowered = name.lower()
    if section == "checkmates":
        lesson = re.search(r"delivering|restricting|introduction|epic failure", lowered)
        if "mate" in lowered and not lesson and "vs pawn" not in lowered:
            return {"kind": "mate", "cp": None, "moves": None}
        return {"kind": "study", "cp": None, "moves": None}
    if lowered.startswith("exercise:") and not has_moves:
        return {"kind": "win", "cp": None, "moves": None}
    return {"kind": "study", "cp": None, "moves": None}


def _sans(game):
    """Mainline SANs; python-chess stops at the first move that is illegal."""
    try:
        return [node.san() for node in game.mainline()]
    except (ValueError, AssertionError):
        return []


def parse_study(pgn_text, study):
    """One study's PGN -> a list of position dicts, one per chapter."""
    positions = []
    stream = io.StringIO(pgn_text)
    order = 0
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        headers = game.headers
        url = headers.get("ChapterURL", "")
        chapter_id = url.rstrip("/").rsplit("/", 1)[-1]
        if not chapter_id or chapter_id == "?":
            continue
        fen = headers.get("FEN") or chess.STARTING_FEN
        try:
            board = chess.Board(fen)
        except ValueError:
            log.warning("practice %s chapter %s: bad FEN %r", study["id"], chapter_id, fen)
            continue
        order += 1
        orientation = "black" if headers.get("Orientation", "").lower() == "black" else "white"
        solution = _sans(game)
        goal_text = (headers.get("Termination") or "").strip()
        goal = parse_goal(goal_text) if goal_text else None
        if goal is None:
            goal = infer_goal(study["section"], headers.get("ChapterName", ""), bool(solution))
        positions.append({
            "study_id": study["id"],
            "chapter_id": chapter_id,
            "chapter_order": order,
            "name": headers.get("ChapterName") or f"Position {order}",
            "fen": board.fen(),
            "orientation": orientation,
            "goal_text": goal_text,
            "goal_kind": goal["kind"],
            "goal_cp": goal["cp"],
            "goal_moves": goal["moves"],
            "description": _ANNOTATION.sub("", game.comment or "").strip(),
            "solution_san": solution,
            "source_url": url or f"https://lichess.org/study/{study['id']}",
        })
    return positions


# --- Fetching ------------------------------------------------------------

def _get(client, url, wait=None):
    """GET with the one-request-at-a-time courtesy Lichess asks for."""
    wait = RATE_LIMIT_WAIT if wait is None else wait
    for attempt in range(1, MAX_ATTEMPTS + 1):
        response = client.get(url, headers={"User-Agent": USER_AGENT}, timeout=_TIMEOUT)
        if response.status_code == 429 and attempt < MAX_ATTEMPTS:
            log.info("Lichess asked us to slow down; waiting %.0fs", wait)
            time.sleep(wait)
            continue
        response.raise_for_status()
        return response.text
    raise PracticeImportError("Lichess kept refusing the request")


def import_library(client, progress=None):
    """Fetch and store every practice set. Returns `{sets, positions, failed}`.

    `progress(done, total, title)` is called after each set. A set that cannot
    be fetched is skipped and reported in `failed`, so one bad answer does not
    throw away the other 31; running the import again fills it in.
    """
    try:
        html = _get(client, PRACTICE_INDEX_URL)
    except (httpx.HTTPError, PracticeImportError) as exc:
        raise PracticeImportError(f"Could not read the Lichess practice page: {exc}") from exc
    sets = parse_index(html)
    if not sets:
        raise PracticeImportError("The Lichess practice page had no practice sets in it")

    stored = 0
    failed = []
    for index, study in enumerate(sets):
        time.sleep(REQUEST_PAUSE)
        try:
            positions = parse_study(_get(client, STUDY_PGN_URL.format(study_id=study["id"])), study)
        except (httpx.HTTPError, PracticeImportError) as exc:
            log.warning("practice set %s failed: %s", study["id"], exc)
            failed.append(study["title"])
        else:
            if positions:
                store_set(study, index + 1, positions)
                stored += len(positions)
            else:
                failed.append(study["title"])
        if progress:
            progress(index + 1, len(sets), study["title"])
    return {"sets": len(sets) - len(failed), "positions": stored, "failed": failed}


# --- Storage -------------------------------------------------------------

def store_set(study, set_order, positions):
    """Insert or refresh one set's chapters. Progress rows are never touched."""
    conn = get_db()
    try:
        with conn:
            for position in positions:
                conn.execute(
                    """INSERT INTO practice_positions
                       (study_id, chapter_id, section, section_title, set_title, set_subtitle,
                        set_order, chapter_order, name, fen, orientation, goal_text,
                        goal_kind, goal_cp, goal_moves, description, solution_san, source_url)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(study_id, chapter_id) DO UPDATE SET
                         section = excluded.section, section_title = excluded.section_title,
                         set_title = excluded.set_title, set_subtitle = excluded.set_subtitle,
                         set_order = excluded.set_order, chapter_order = excluded.chapter_order,
                         name = excluded.name, fen = excluded.fen,
                         orientation = excluded.orientation, goal_text = excluded.goal_text,
                         goal_kind = excluded.goal_kind, goal_cp = excluded.goal_cp,
                         goal_moves = excluded.goal_moves, description = excluded.description,
                         solution_san = excluded.solution_san, source_url = excluded.source_url,
                         imported_at = datetime('now')""",
                    (position["study_id"], position["chapter_id"], study["section"],
                     study["section_title"], study["title"], study["subtitle"], set_order,
                     position["chapter_order"], position["name"], position["fen"],
                     position["orientation"], position["goal_text"], position["goal_kind"],
                     position["goal_cp"], position["goal_moves"], position["description"],
                     json.dumps(position["solution_san"]), position["source_url"]),
                )
    finally:
        conn.close()


def get_library():
    """Sections -> sets -> positions with progress, in Lichess's own order."""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT p.*, g.attempts, g.solved_count, g.failed_count, g.last_result,
                      g.last_played_at
               FROM practice_positions p
               LEFT JOIN practice_progress g ON g.position_id = p.id
               ORDER BY p.set_order, p.chapter_order"""
        ).fetchall()
    finally:
        conn.close()

    sections = []
    section_by_key = {}
    set_by_id = {}
    for row in rows:
        section = section_by_key.get(row["section"])
        if section is None:
            section = {"id": row["section"], "title": row["section_title"], "sets": []}
            section_by_key[row["section"]] = section
            sections.append(section)
        practice_set = set_by_id.get(row["study_id"])
        if practice_set is None:
            practice_set = {
                "id": row["study_id"], "title": row["set_title"], "subtitle": row["set_subtitle"],
                "positions": [],
            }
            set_by_id[row["study_id"]] = practice_set
            section["sets"].append(practice_set)
        practice_set["positions"].append({
            "id": row["id"],
            "name": row["name"],
            "fen": row["fen"],
            "orientation": row["orientation"],
            "goal": {
                "kind": row["goal_kind"], "cp": row["goal_cp"],
                "moves": row["goal_moves"], "text": row["goal_text"],
            },
            "description": row["description"],
            "source_url": row["source_url"],
            "progress": {
                "attempts": row["attempts"] or 0,
                "solved": row["solved_count"] or 0,
                "failed": row["failed_count"] or 0,
                "last_result": row["last_result"],
                "last_played_at": row["last_played_at"],
            },
        })

    for section in sections:
        for practice_set in section["sets"]:
            playable = [p for p in practice_set["positions"] if p["goal"]["kind"] != "study"]
            practice_set["total"] = len(playable)
            practice_set["solved"] = sum(1 for p in playable if p["progress"]["last_result"] == "solved")
        section["total"] = sum(s["total"] for s in section["sets"])
        section["solved"] = sum(s["solved"] for s in section["sets"])
    return {
        "imported": bool(rows),
        "sections": sections,
        "total": sum(s["total"] for s in sections),
        "solved": sum(s["solved"] for s in sections),
    }


def record_attempt(position_id, solved):
    """Count one finished attempt. Returns the new progress, or None if the
    position does not exist."""
    conn = get_db()
    try:
        with conn:
            if not conn.execute(
                "SELECT 1 FROM practice_positions WHERE id = ?", (position_id,)
            ).fetchone():
                return None
            result = "solved" if solved else "failed"
            conn.execute(
                """INSERT INTO practice_progress
                   (position_id, attempts, solved_count, failed_count, last_result, last_played_at)
                   VALUES (?, 1, ?, ?, ?, datetime('now'))
                   ON CONFLICT(position_id) DO UPDATE SET
                     attempts = attempts + 1,
                     solved_count = solved_count + excluded.solved_count,
                     failed_count = failed_count + excluded.failed_count,
                     last_result = excluded.last_result,
                     last_played_at = datetime('now')""",
                (position_id, 1 if solved else 0, 0 if solved else 1, result),
            )
            row = conn.execute(
                "SELECT attempts, solved_count, failed_count, last_result, last_played_at "
                "FROM practice_progress WHERE position_id = ?", (position_id,),
            ).fetchone()
    finally:
        conn.close()
    return {"attempts": row["attempts"], "solved": row["solved_count"],
            "failed": row["failed_count"], "last_result": row["last_result"],
            "last_played_at": row["last_played_at"]}


# --- Background import ---------------------------------------------------

class PracticeImporter:
    """Runs the import on a thread so the UI can show progress and stay usable.

    One import at a time: `start` while one is running just reports it.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self._state = {"running": False, "done": 0, "total": 0, "title": "",
                       "error": None, "result": None}

    def status(self):
        with self._lock:
            return dict(self._state)

    def start(self, client, allow_network=True):
        if not allow_network:
            raise PracticeImportError("Network access is turned off")
        with self._lock:
            if self._state["running"]:
                return dict(self._state)
            self._state = {"running": True, "done": 0, "total": 0, "title": "",
                           "error": None, "result": None}
            self._thread = threading.Thread(
                target=self._run, args=(client,), name="practice-import", daemon=True)
            self._thread.start()
            return dict(self._state)

    def join(self, timeout=None):
        thread = self._thread
        if thread:
            thread.join(timeout)

    def _progress(self, done, total, title):
        with self._lock:
            self._state.update(done=done, total=total, title=title)

    def _run(self, client):
        try:
            result = import_library(client, self._progress)
            error = None
        except PracticeImportError as exc:
            result, error = None, str(exc)
        except Exception as exc:  # never leave the UI waiting on a dead thread
            log.exception("practice import crashed")
            result, error = None, f"Import failed: {exc}"
        with self._lock:
            self._state.update(running=False, error=error, result=result)
