"""Your new games, analysed deeply and sent to a Lichess study.

Every game that finishes after this was turned on (Lichess or chess.com, once
a sync has imported it) goes through three steps, one game at a time:

1. **Imported** into a private study of yours on Lichess (the official study
   API, with the Lichess token saved in settings; it needs `study:write`).
   The study is created the first time, and a new one when it is full.
2. **Analysed** by this Mac's Stockfish (3 threads, 256 MB of hash, normal
   priority), position by position:
   - a finished position (mate, stalemate) needs nothing;
   - with seven pieces or fewer the Lichess tablebase decides: draw 0.00,
     a win or loss a mate score (or +-10.00 when it gives no mate distance),
     and the best line follows the tablebase's moves; no Stockfish at all;
   - an opening position Lichess's cloud already knows at depth 32 or more
     takes the cloud's evaluation; below 32 it does not count;
   - every other one is searched for at least `TARGET_SECONDS` (12) and to
     at least `MIN_DEPTH` (32): quick positions go far deeper in those 12 s,
     a hard one keeps going until depth 32, at most `HARD_SECONDS`. A
     search that runs out of depth (Stockfish stops at 245) ends sooner.
3. **Published** to that chapter by the extension, from a Lichess tab (the
   same request as Lichess's own "Publish" after "Analyse on your device",
   which needs your Lichess login rather than a token). Lichess then shows
   the usual blunder notes, ?? marks, accuracy and chart.

The document sent in step 3 follows lila's own format
(ui/analyse/src/local/localAnalysisEngine.ts, modules/tree Info/Advice): scores
from White's side; for each move the score after it, and, only for moves
Lichess will call an inaccuracy, mistake or blunder, the best move and up to
12 plies of the line that was better. Lichess adds a line to the chapter for
every move that has one, so the others are left without.

Nothing runs while a game is being played: the extension's live-game lock
holds this worker, and stops a search already under way.
"""
import io
import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import chess
import chess.engine
import chess.pgn
import httpx

import lichess_tablebase
import stockfish
from database import get_db, get_setting, set_setting

log = logging.getLogger("study_analysis")

MIN_DEPTH = int(os.environ.get("OPENINGS_STUDY_MIN_DEPTH", "32"))
TARGET_SECONDS = float(os.environ.get("OPENINGS_STUDY_TARGET_SECONDS", "12"))
# A sharp middlegame can need five minutes to reach depth 32 on four threads
# (measured: the position after 11. g4 in a real game took 300 s).
HARD_SECONDS = float(os.environ.get("OPENINGS_STUDY_HARD_SECONDS", "600"))
THREADS = int(os.environ.get("OPENINGS_STUDY_THREADS", "3"))
HASH_MB = int(os.environ.get("OPENINGS_STUDY_HASH_MB", "256"))
# Stockfish's own ceiling: it never reports a deeper search.
MAX_DEPTH = 245
# After this many positions in a row the cloud did not know, stop asking it
# for the rest of the game: past the opening it hardly ever does.
CLOUD_MISSES = 2
# Lichess's limits: a line is at most 12 plies (Info.LineMaxPlies), a game at
# most 600 (Analysis.MAX_PLIES), and its own Publish button needs 10 plies.
VARIATION_PLIES = 12
MAX_PLIES = 600
MIN_PLIES = 10
MAX_ATTEMPTS = 6
STUDY_NAME = "My games"
LICHESS = "https://lichess.org"
USER_AGENT = "ChessOpenings/1.0"
_TIMEOUT = httpx.Timeout(15.0)

ENABLED_KEY = "study_analysis_enabled"
SINCE_KEY = "study_analysis_since"
STUDY_KEY = "study_analysis_study"
USER_KEY = "study_analysis_user"


class StudyError(Exception):
    """A step failed in a way worth showing; `retry` says whether to try again."""

    def __init__(self, message, retry=True):
        super().__init__(message)
        self.retry = retry


class Interrupted(Exception):
    """The search was stopped (a game started, or the app is closing)."""


# --- Lichess's judgments (modules/tree/src/main/Advice.scala) -------------

def winning_chances(cp):
    """lila's WinPercent.winningChances: centipawns -> -1..1."""
    return max(-1.0, min(1.0, 2 / (1 + math.exp(-0.00368208 * cp)) - 1))


def judgment(before, after, mover_white):
    """What Lichess will call the move from `before` to `after` (both scores
    from White's side: {"cp": n} or {"mate": n}, mate > 0 White mates):
    "Inaccuracy", "Mistake", "Blunder" or None."""
    if after.get("mate") == 0:
        return None  # the move gave checkmate
    if "cp" in before and "cp" in after:
        delta = winning_chances(after["cp"]) - winning_chances(before["cp"])
        loss = -delta if mover_white else delta
        for threshold, name in ((0.3, "Blunder"), (0.2, "Mistake"), (0.1, "Inaccuracy")):
            if loss >= threshold:
                return name
        return None
    sign = 1 if mover_white else -1
    prev_mate = before.get("mate")
    now_mate = after.get("mate")
    prev_cp = before["cp"] * sign if "cp" in before else 0
    now_cp = after["cp"] * sign if "cp" in after else 0
    prev_mate = prev_mate * sign if prev_mate is not None else None
    now_mate = now_mate * sign if now_mate is not None else None
    if prev_mate is None and now_mate is not None and now_mate < 0:
        # Checkmate is now unavoidable.
        return "Inaccuracy" if prev_cp < -999 else "Mistake" if prev_cp < -700 else "Blunder"
    if prev_mate is not None and prev_mate > 0 and (now_mate is None or now_mate < 0):
        # Lost forced checkmate sequence.
        return "Inaccuracy" if now_cp > 999 else "Mistake" if now_cp > 700 else "Blunder"
    return None


# --- One position ------------------------------------------------------------

def terminal_score(board):
    """The score of a finished position, or None if play goes on."""
    if board.is_checkmate():
        return {"mate": 0, "source": "terminal"}
    if board.is_game_over():
        return {"cp": 0, "source": "terminal"}
    return None


def _white_score(pov_score):
    white = pov_score.white()
    mate = white.mate()
    if mate is not None:
        return {"mate": mate}
    return {"cp": white.score()}


def cloud_eval(fen, client):
    """Lichess's cloud evaluation of `fen` as a score dict, None when the cloud
    does not have it at MIN_DEPTH. Raises StudyError when the cloud refuses
    (rate limit): the caller stops asking for this game."""
    try:
        response = client.get(f"{LICHESS}/api/cloud-eval", params={"fen": fen, "multiPv": 1},
                              headers={"User-Agent": USER_AGENT}, timeout=_TIMEOUT)
    except httpx.HTTPError as exc:
        raise StudyError(f"cloud: {exc}")
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise StudyError(f"cloud: HTTP {response.status_code}")
    data = response.json()
    pvs = data.get("pvs") or []
    if not pvs or (data.get("depth") or 0) < MIN_DEPTH:
        return None
    line = pvs[0]
    score = {"mate": line["mate"]} if line.get("mate") is not None else {"cp": line.get("cp", 0)}
    return {**score, "pv": (line.get("moves") or "").split(), "depth": data["depth"],
            "nodes": int(data.get("knodes") or 0) * 1000, "source": "cloud"}


def _table(board, tablebase):
    if not tablebase or lichess_tablebase.piece_count(board) > lichess_tablebase.MAX_PIECES:
        return None
    try:
        table = tablebase(board.fen())
    except Exception:
        return None
    if not table or not table.get("available") or table.get("outcome") not in ("win", "draw", "loss"):
        return None
    return table


def tablebase_score(board, tablebase, previous=None):
    """The exact score of a position of seven pieces or fewer (None when the
    tablebase cannot say: more pieces, castling rights, offline).

    A win or loss is a mate score when the tablebase gives the distance to
    mate (in plies, positive when the side to move wins), else +-10.00. One
    exception: right after a position scored as a mate for the same side the
    mate is kept, since Lichess would call "mate, then +10.00" a lost mate."""
    table = _table(board, tablebase)
    if table is None:
        return None
    moves = table.get("moves") or []
    score = {"pv": [moves[0]["uci"]] if moves else [], "source": "tablebase"}
    outcome = table["outcome"]
    if outcome == "draw":
        return {**score, "cp": 0}
    # +1: White wins, -1: Black wins.
    winner = (1 if outcome == "win" else -1) * (1 if board.turn == chess.WHITE else -1)
    dtm = table.get("dtm")
    if isinstance(dtm, int) and dtm and (dtm > 0) == (outcome == "win"):
        return {**score, "mate": winner * math.ceil(abs(dtm) / 2)}
    if previous and previous.get("mate") and (previous["mate"] > 0) == (winner > 0):
        return {**score, "mate": previous["mate"]}
    return {**score, "cp": 1000 * winner}


def tablebase_line(board, tablebase):
    """The tablebase's best play from `board`, up to VARIATION_PLIES moves."""
    line = []
    position = board.copy()
    while len(line) < VARIATION_PLIES and not position.is_game_over():
        table = _table(position, tablebase)
        moves = (table or {}).get("moves") or []
        if not moves:
            break
        move = chess.Move.from_uci(moves[0]["uci"])
        if move not in position.legal_moves:
            break
        line.append(move.uci())
        position.push(move)
    return line


def _clean(score):
    return {k: v for k, v in score.items() if v is not None}


class DeepSearch:
    """Stockfish searches that can be stopped from another thread."""

    def __init__(self, engine):
        self.engine = engine
        self._lock = threading.Lock()
        self._current = None
        self._interrupted = False

    def reset(self):
        """Forget an earlier interrupt. Called before checking whether a
        search may start, so an interrupt after that check still counts."""
        with self._lock:
            self._interrupted = False

    def interrupt(self):
        with self._lock:
            self._interrupted = True
            current = self._current
        if current is not None:
            try:
                current.stop()
            except Exception:
                pass

    def search(self, board, on_depth=None):
        """At least MIN_DEPTH and TARGET_SECONDS, at most HARD_SECONDS."""
        started = time.monotonic()
        best = None
        with self.engine.analysis(board, chess.engine.Limit(time=HARD_SECONDS)) as analysis:
            with self._lock:
                self._current = analysis
                if self._interrupted:
                    analysis.stop()
            try:
                for info in analysis:
                    if self._interrupted:
                        break
                    if ("score" in info and info.get("pv") and "depth" in info
                            and not info.get("lowerbound") and not info.get("upperbound")):
                        best = info
                        if on_depth:
                            on_depth(info["depth"])
                    depth = best["depth"] if best else 0
                    elapsed = time.monotonic() - started
                    if depth >= MAX_DEPTH or (depth >= MIN_DEPTH and elapsed >= TARGET_SECONDS):
                        break
            finally:
                with self._lock:
                    self._current = None
        if self._interrupted:
            raise Interrupted()
        if best is None:
            raise StudyError("Stockfish gave no evaluation")
        return {**_white_score(best["score"]), "pv": [m.uci() for m in best["pv"]],
                "depth": best["depth"], "nodes": int(best.get("nodes") or 0), "source": "stockfish"}


def read_game(pgn):
    game = chess.pgn.read_game(io.StringIO(pgn or ""))
    if game is None:
        raise StudyError("The PGN could not be read", retry=False)
    if (game.headers.get("Variant") or "Standard").lower() not in ("standard", "chess"):
        raise StudyError("Only standard chess is analysed", retry=False)
    moves = list(game.mainline_moves())
    board = game.board()
    boards = [board.copy()]
    for move in moves:
        board.push(move)
        boards.append(board.copy())
    return boards, moves


def evaluate_game(boards, search, cloud=None, tablebase=None, done=None, progress=None,
                  save=None):
    """One score per position (the start, then after each move).

    `done` holds scores already worked out (a restart picks up where it was
    stopped); `save(scores)` is called after each new one."""
    scores = list(done or [])
    misses = 0 if cloud else CLOUD_MISSES
    for index in range(len(scores), len(boards)):
        board = boards[index]
        if progress:
            progress(index, len(boards))
        score = terminal_score(board)
        if score is None:
            score = tablebase_score(board, tablebase, scores[-1] if scores else None)
        if score is None and misses < CLOUD_MISSES:
            try:
                score = cloud(board.fen())
            except StudyError:
                misses = CLOUD_MISSES  # refused: no more asking for this game
            else:
                misses = 0 if score else misses + 1
        if score is None:
            score = search(board)
        score = _clean(score)
        scores.append(score)
        if save:
            save(scores)
    return scores


def _line_san(board, ucis):
    sans = []
    position = board.copy()
    for uci in ucis[:VARIATION_PLIES]:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            break
        if move not in position.legal_moves:
            break
        sans.append(position.san(move))
        position.push(move)
    return sans


def _doc_score(score):
    if score.get("mate") == 0:
        return {"mate": 0, "mateGiven": False}
    if "mate" in score:
        return {"mate": score["mate"]}
    return {"cp": score["cp"]}


def build_document(boards, moves, scores, study_id, chapter_id, user_id, engine_version,
                   tablebase=None):
    """The analysis in the shape POST /analysis/publish takes. `tablebase`
    lengthens the one-move line of a tablebase position into its best play."""
    if len(scores) != len(boards):
        raise ValueError("one score per position")
    start_ply = 2 * (boards[0].fullmove_number - 1) + (0 if boards[0].turn == chess.WHITE else 1)
    infos = []
    judged = 0
    for i, move in enumerate(moves):
        before, after = scores[i], scores[i + 1]
        entry = {"ply": start_ply + i + 1, "eval": _doc_score(after), "variation": []}
        best = (before.get("pv") or [None])[0]
        if best and best != move.uci() and judgment(before, after, boards[i].turn == chess.WHITE):
            pv = before["pv"]
            if before.get("source") == "tablebase" and tablebase:
                pv = tablebase_line(boards[i], tablebase) or pv
            line = _line_san(boards[i], pv)
            if line:
                entry["eval"]["best"] = best
                entry["variation"] = line
                judged += 1
        infos.append(entry)
    # Your engine's work only: the cloud's counts run into the billions, and
    # Lichess takes a 32-bit number here (it refused anything larger).
    searched = [s for s in scores if s.get("nodes") and s.get("source") != "cloud"]
    nodes = round(sum(s["nodes"] for s in searched) / len(searched)) if searched else 0
    nodes = min(nodes, 2**31 - 1)
    return {
        "id": chapter_id,
        "studyId": study_id,
        "initialEval": _doc_score(scores[0]),
        "infos": infos,
        "startPly": start_ply,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "engine": {
            "nodesPerMove": nodes,
            "id": "external",
            "userId": user_id,
            "engineVersion": engine_version,
        },
    }


# --- Lichess's study API (needs a token with study:write) --------------------

class LichessStudies:
    def __init__(self, client):
        self.client = client

    def _token(self):
        token = (get_setting("lichess_token") or "").strip()
        if not token:
            raise StudyError("Add a Lichess token with study access in the extension's settings")
        return token

    def _call(self, method, path, **kwargs):
        headers = {"Authorization": f"Bearer {self._token()}", "User-Agent": USER_AGENT,
                   "Accept": "application/json"}
        try:
            response = self.client.request(method, f"{LICHESS}{path}", headers=headers,
                                           timeout=_TIMEOUT, **kwargs)
        except httpx.HTTPError as exc:
            raise StudyError(f"Lichess could not be reached: {exc}")
        if response.status_code in (401, 403):
            raise StudyError("The Lichess token has no study access: create one with "
                             "study:write in the extension's settings")
        if response.status_code == 429:
            raise StudyError("Lichess asked to slow down; trying again later")
        return response

    def user_id(self):
        known = get_setting(USER_KEY)
        if known:
            return known
        response = self._call("GET", "/api/account")
        if response.status_code != 200:
            raise StudyError(f"Lichess account: HTTP {response.status_code}")
        user = response.json().get("id")
        set_setting(USER_KEY, user)
        return user

    def create_study(self):
        made = int(get_setting("study_analysis_studies", "0"))
        number = max(made, 1 if get_setting(STUDY_KEY) else 0) + 1
        name = STUDY_NAME if number == 1 else f"{STUDY_NAME} {number}"
        response = self._call("POST", "/api/study", data={
            "name": name, "visibility": "private", "computer": "everyone",
            "explorer": "everyone", "cloneable": "owner", "shareable": "owner",
            "chat": "nobody", "sticky": "false"})
        if response.status_code != 200:
            raise StudyError(f"Could not create a study: HTTP {response.status_code} {response.text[:200]}")
        study_id = response.json().get("id")
        if not study_id:
            raise StudyError("Lichess did not return the new study")
        set_setting(STUDY_KEY, study_id)
        set_setting("study_analysis_studies", str(number))
        return study_id

    def _import(self, study_id, pgn, orientation):
        response = self._call("POST", f"/api/study/{study_id}/import-pgn",
                              data={"pgn": pgn, "orientation": orientation, "mode": "normal"})
        if response.status_code == 404:
            return None  # the study was deleted
        if response.status_code != 200:
            raise StudyError(f"Import into the study: HTTP {response.status_code} {response.text[:200]}")
        chapters = response.json().get("chapters") or []
        return chapters[-1]["id"] if chapters else None

    def _drop_empty_chapters(self, study_id, keep):
        """A new study comes with an empty "Chapter 1": delete it (and any
        other chapter without moves) once the first game is in. Only ever
        called on a study this app has just created."""
        try:
            response = self._call("GET", f"/api/study/{study_id}.pgn")
            if response.status_code != 200:
                return
            text = io.StringIO(response.text)
            while (game := chess.pgn.read_game(text)) is not None:
                chapter = (game.headers.get("ChapterURL") or "").rstrip("/").rsplit("/", 1)[-1]
                if chapter and chapter != keep and game.next() is None:
                    self._call("DELETE", f"/api/study/{study_id}/{chapter}")
        except (StudyError, ValueError):
            pass  # only tidying: the empty chapter can be deleted by hand

    def import_game(self, pgn, orientation):
        """(study id, chapter id) of the game imported as a new chapter. A full
        or deleted study is replaced by a new one."""
        study_id = get_setting(STUDY_KEY)
        created = not study_id
        if created:
            study_id = self.create_study()
        chapter = self._import(study_id, pgn, orientation)
        if chapter is None:
            study_id = self.create_study()
            created = True
            chapter = self._import(study_id, pgn, orientation)
        if chapter is None:
            raise StudyError("Lichess did not add the chapter")
        if created:
            self._drop_empty_chapters(study_id, chapter)
        return study_id, chapter


# --- The queue ---------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc)


def _stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S+00:00")


def enabled():
    return get_setting(ENABLED_KEY, "1") == "1"


def set_enabled(on):
    set_setting(ENABLED_KEY, "1" if on else "0")
    if on and not get_setting(SINCE_KEY):
        set_setting(SINCE_KEY, _stamp(_now()))


def queue_new_games():
    """Put every game that ended since this was turned on in the queue once.
    Returns how many were added."""
    if not enabled():
        return 0
    since = get_setting(SINCE_KEY)
    if not since:
        since = _stamp(_now())
        set_setting(SINCE_KEY, since)
    conn = get_db()
    try:
        with conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO study_games (game_id) "
                "SELECT id FROM games WHERE user_color IN ('white', 'black') "
                "AND end_time IS NOT NULL AND end_time >= ?", (since,))
            return cur.rowcount
    finally:
        conn.close()


def queue_game(game_id):
    """Send one game (again). A game that already has its chapter keeps it and
    the positions analysed so far, so trying again never adds it twice."""
    conn = get_db()
    try:
        with conn:
            if not conn.execute("SELECT 1 FROM games WHERE id = ?", (game_id,)).fetchone():
                return False
            conn.execute(
                "INSERT INTO study_games (game_id) VALUES (?) ON CONFLICT(game_id) DO UPDATE SET "
                "state = CASE WHEN chapter_id IS NULL THEN 'queued' ELSE 'imported' END, "
                "document = NULL, error = '', attempts = 0, retry_at = NULL, "
                "updated_at = datetime('now')", (game_id,))
        return True
    finally:
        conn.close()


def _update(game_id, **values):
    values["updated_at"] = _stamp(_now())
    for key in ("scores", "document"):
        if key in values and values[key] is not None and not isinstance(values[key], str):
            values[key] = json.dumps(values[key])
    conn = get_db()
    try:
        with conn:
            conn.execute(
                f"UPDATE study_games SET {', '.join(f'{k} = ?' for k in values)} WHERE game_id = ?",
                (*values.values(), game_id))
    finally:
        conn.close()


def next_game():
    """The newest game with work to do here (importing or analysing)."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT s.*, g.pgn, g.user_color, g.white, g.black, g.source FROM study_games s "
            "JOIN games g ON g.id = s.game_id "
            "WHERE s.state IN ('queued', 'imported') AND (s.retry_at IS NULL OR s.retry_at <= ?) "
            "ORDER BY g.end_time DESC, g.id DESC LIMIT 1", (_stamp(_now()),)).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def ready_to_publish(limit=1):
    """Analyses the extension should publish, oldest first."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT s.game_id, s.study_id, s.chapter_id, s.document FROM study_games s "
            "JOIN games g ON g.id = s.game_id WHERE s.state = 'ready' "
            "AND (s.retry_at IS NULL OR s.retry_at <= ?) ORDER BY g.end_time, g.id LIMIT ?",
            (_stamp(_now()), limit)).fetchall()
    finally:
        conn.close()
    return [{"game_id": r["game_id"], "study_id": r["study_id"], "chapter_id": r["chapter_id"],
             "user_id": json.loads(r["document"])["engine"]["userId"],
             "document": json.loads(r["document"])} for r in rows]


def mark_published(game_id):
    conn = get_db()
    try:
        with conn:
            return conn.execute(
                "UPDATE study_games SET state = 'published', error = '', retry_at = NULL, "
                "updated_at = datetime('now') WHERE game_id = ? AND state = 'ready'",
                (game_id,)).rowcount > 0
    finally:
        conn.close()


def publish_failed(game_id, status, message):
    """The extension could not publish. 423: Lichess's own server analysis of
    the chapter is running; anything temporary is tried again later, anything
    else (the chapter was deleted, no access) is final."""
    temporary = status in (0, 423, 429) or status >= 500
    conn = get_db()
    try:
        row = conn.execute("SELECT attempts FROM study_games WHERE game_id = ? AND state = 'ready'",
                           (game_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return False
    attempts = row["attempts"] + 1
    if temporary and attempts < MAX_ATTEMPTS:
        _update(game_id, attempts=attempts, error=message[:300],
                retry_at=_stamp(_now() + timedelta(minutes=5 * attempts)))
    elif status == 404:
        # The chapter (or study) was deleted: trying again adds the game anew.
        _update(game_id, state="failed", attempts=attempts, error=message[:300],
                study_id=None, chapter_id=None)
    else:
        _update(game_id, state="failed", attempts=attempts, error=message[:300])
    return True


def overview(limit=8):
    conn = get_db()
    try:
        counts = dict(conn.execute("SELECT state, COUNT(*) FROM study_games GROUP BY state").fetchall())
        rows = conn.execute(
            "SELECT s.game_id, s.state, s.study_id, s.chapter_id, s.error, s.updated_at, "
            "g.white, g.black, g.source, g.end_time FROM study_games s JOIN games g ON g.id = s.game_id "
            "ORDER BY g.end_time DESC, g.id DESC LIMIT ?", (limit,)).fetchall()
    finally:
        conn.close()
    study = get_setting(STUDY_KEY)
    return {
        "enabled": enabled(),
        "since": get_setting(SINCE_KEY),
        "study_id": study,
        "study_url": f"{LICHESS}/study/{study}" if study else None,
        "counts": counts,
        "games": [dict(row) for row in rows],
    }


# --- The worker ----------------------------------------------------------------

def new_engine():
    engine = chess.engine.SimpleEngine.popen_uci(stockfish.STOCKFISH_PATH)
    engine.configure({"Threads": THREADS, "Hash": HASH_MB})
    return engine


class StudyAnalyzer:
    """One thread: import, then analyse, one game at a time, newest first."""

    def __init__(self, http, tablebase=None, engine_factory=new_engine, allow_network=True):
        self._studies = LichessStudies(http)
        self._http = http
        self._tablebase = tablebase
        self._engine_factory = engine_factory
        self._allow_network = allow_network
        self._wake = threading.Event()
        self._stop = threading.Event()
        # Set while a game is live (fail-closed: the app starts held).
        self._held = threading.Event()
        self._held.set()
        self._thread = None
        self._search = None
        self._lock = threading.Lock()
        self._state = {"game_id": None, "title": "", "position": 0, "positions": 0,
                       "depth": 0, "held": True, "error": None}

    def status(self):
        with self._lock:
            return dict(self._state)

    def _set(self, **values):
        with self._lock:
            self._state.update(values)

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="study-analysis", daemon=True)
        self._thread.start()

    def wake(self):
        self._wake.set()

    def hold(self, held):
        if held:
            self._held.set()
            search = self._search
            if search is not None:
                search.interrupt()
        else:
            self._held.clear()
            self._wake.set()
        self._set(held=held)

    def shutdown(self):
        self._stop.set()
        self._wake.set()
        search = self._search
        if search is not None:
            search.interrupt()
        if self._thread:
            self._thread.join(5)

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(60)
            self._wake.clear()
            self._work()

    def _work(self):
        """Everything there is to do now. Stockfish (and its 256 MB) runs only
        for this round; an unexpected error counts against the game it was on
        and ends the round, never the thread."""
        engine = None
        game = None
        try:
            while not self._stop.is_set():
                if self._held.is_set() or not enabled():
                    return
                try:
                    queue_new_games()
                except Exception:
                    log.exception("queueing new games failed")
                game = next_game()
                if not game:
                    return
                if game["state"] == "queued":
                    self._import(game)
                    continue
                if engine is None:
                    if not stockfish.availability()["available"] and self._engine_factory is new_engine:
                        self._set(error="Stockfish is not installed")
                        return
                    engine = self._engine_factory()
                    self._search = DeepSearch(engine)
                self._analyse(game, engine)
        except Exception as exc:
            log.exception("study analysis failed")
            self._set(error=f"Analysis failed: {exc}")
            if game:
                self._fail(game, exc)
        finally:
            self._search = None
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass

    def _fail(self, game, exc):
        attempts = game["attempts"] + 1
        if getattr(exc, "retry", True) and attempts < MAX_ATTEMPTS:
            _update(game["game_id"], attempts=attempts, error=str(exc)[:300],
                    retry_at=_stamp(_now() + timedelta(minutes=5 * attempts)))
        else:
            _update(game["game_id"], state="failed", attempts=attempts, error=str(exc)[:300])

    def _import(self, game):
        try:
            boards, moves = read_game(game["pgn"])
            if len(moves) < MIN_PLIES:
                _update(game["game_id"], state="skipped", error="Too short to analyse")
                return
            if len(moves) > MAX_PLIES:
                _update(game["game_id"], state="skipped", error="Too long for Lichess's analysis")
                return
            if not self._allow_network:
                raise StudyError("The network is off")
            self._studies.user_id()
            study_id, chapter_id = self._studies.import_game(game["pgn"], game["user_color"])
        except StudyError as exc:
            self._fail(game, exc)
            return
        _update(game["game_id"], state="imported", study_id=study_id, chapter_id=chapter_id,
                error="", attempts=0, retry_at=None)

    def _analyse(self, game, engine):
        try:
            boards, moves = read_game(game["pgn"])
        except StudyError as exc:
            self._fail(game, exc)
            return
        self._set(game_id=game["game_id"], title=f"{game['white']} vs {game['black']}",
                  position=0, positions=len(boards), depth=0, error=None)
        done = json.loads(game["scores"]) if game.get("scores") else []
        cloud = (lambda fen: cloud_eval(fen, self._http)) if self._allow_network else None

        def quiet_now():
            if self._held.is_set() or self._stop.is_set():
                raise Interrupted()

        def search(board):
            self._search.reset()
            quiet_now()
            return self._search.search(board, on_depth=lambda d: self._set(depth=d))

        def progress(index, total):
            quiet_now()
            self._set(position=index, depth=0)

        try:
            scores = evaluate_game(
                boards, search, cloud=cloud, tablebase=self._tablebase, done=done,
                progress=progress,
                save=lambda s: _update(game["game_id"], scores=s))
            document = build_document(
                boards, moves, scores, game["study_id"], game["chapter_id"],
                get_setting(USER_KEY) or "", engine.id.get("name", "Stockfish"),
                tablebase=self._tablebase)
        except Interrupted:
            return  # held or closing: the scores so far are kept
        except StudyError as exc:
            self._fail(game, exc)
            return
        finally:
            self._set(game_id=None, title="", position=0, positions=0, depth=0)
        _update(game["game_id"], state="ready", document=document, error="", attempts=0,
                retry_at=None)
