"""Chess Openings — standalone FastAPI service.

Runs separately from the Game Review app on its own port (default :8001).
Shares the chess_review.db file for imported games and repertoire data.
"""
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from typing import Literal

import chess
from contextlib import asynccontextmanager
from fastapi import APIRouter, FastAPI, HTTPException, Path, Query, Request
from fastapi.background import BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from starlette.concurrency import run_in_threadpool

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
OPENINGS_ROOT = os.path.dirname(BACKEND_DIR)

sys.path.insert(0, BACKEND_DIR)
os.environ.setdefault(
    "CHESS_DB_PATH",
    os.path.join(OPENINGS_ROOT, "chess_review.db"),
)

import database as db  # noqa: E402
import eco_openings  # noqa: E402  (offline move-sequence → opening-name recognizer)
import lichess_explorer  # noqa: E402  (SPEEDS / RATING_GROUPS / MIN_YEAR allow-lists)
import live_engine  # noqa: E402  (openings-local interactive eval engine)
import game_import  # noqa: E402
from sync_service import AccountSyncService  # noqa: E402
from services import ExternalApiClients, SQLiteService  # noqa: E402

# Route handlers that touch SQLite are plain `def`, not `async def`: FastAPI runs
# those in its threadpool. As coroutines they ran on the event loop itself, so a
# query waiting out busy_timeout behind the sync writer froze every other request
# (engine streams included) for up to five seconds.
api = APIRouter(prefix="/api")

DIST_DIR = os.path.join(OPENINGS_ROOT, "frontend", "dist")


class RepertoireBranchInput(BaseModel):
    color: Literal["white", "black"]
    name: str = Field(default="", max_length=120)
    moves_san: str = Field(min_length=1, max_length=4000)
    opening: str = Field(default="", max_length=120)
    opening_id: int | None = Field(default=None, gt=0)
    tags: list[str] = Field(default_factory=list, max_length=30)
    label: Literal["main", "alternative", "trap", "sideline"] = "main"
    note: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def validate_tags(self):
        if any(not tag.strip() or len(tag) > 40 or "," in tag for tag in self.tags):
            raise ValueError("tags must be non-empty, at most 40 characters, and contain no commas")
        return self


class RepertoireBranchPatch(BaseModel):
    color: Literal["white", "black"] | None = None
    name: str | None = Field(default=None, max_length=120)
    moves_san: str | None = Field(default=None, min_length=1, max_length=4000)
    opening: str | None = Field(default=None, max_length=120)
    opening_id: int | None = Field(default=None, gt=0)
    tags: list[str] | None = Field(default=None, max_length=30)
    label: Literal["main", "alternative", "trap", "sideline"] | None = None
    note: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_tags(self):
        if self.tags is not None and any(
            not tag.strip() or len(tag) > 40 or "," in tag for tag in self.tags
        ):
            raise ValueError("tags must be non-empty, at most 40 characters, and contain no commas")
        return self


class RepertoireOpeningInput(BaseModel):
    color: Literal["white", "black"]
    name: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=4000)


class RepertoireOpeningPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=4000)


class AccountInput(BaseModel):
    platform: Literal["chesscom", "lichess"]
    username: str = Field(min_length=1, max_length=80, pattern=r"^[^\s/]+$")
    label: str = Field(default="", max_length=80)


class LichessTokenInput(BaseModel):
    token: str = Field(default="", max_length=512)


class SavedEvalInput(BaseModel):
    fen: str = Field(min_length=4, max_length=128)
    payload: dict


class DrillAttemptInput(BaseModel):
    event_key: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9._:-]+$")
    source: Literal["practice", "review"]
    solved: bool
    node_id: int | None = Field(default=None, gt=0)
    branch_id: int | None = Field(default=None, gt=0)
    expected_san: str = Field(default="", max_length=32)
    played_san: str = Field(default="", max_length=32)
    path_san: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def validate_target(self):
        if bool(self.node_id) == bool(self.branch_id):
            raise ValueError("exactly one of node_id or branch_id is required")
        return self


class PlayReplyInput(BaseModel):
    fen: str = Field(min_length=4, max_length=128)
    seconds: float = Field(default=1.0, ge=0.1, le=30)


def _validate_fen(fen):
    try:
        chess.Board(fen)
    except ValueError:
        raise HTTPException(400, "Invalid FEN")


@asynccontextmanager
async def lifespan(target_app):
    import opening_tree as ot

    target_app.state.database = SQLiteService()
    target_app.state.database.start()
    target_app.state.external_clients = ExternalApiClients()
    target_app.state.opening_tree_cache = ot.OpeningTreeCache()
    target_app.state.live_engine = live_engine.LiveEngineService()
    target_app.state.sync_service = AccountSyncService(
        invalidate_cache=target_app.state.opening_tree_cache.invalidate,
        import_client=target_app.state.external_clients.import_client,
    )
    try:
        target_app.state.live_engine.start()
        target_app.state.sync_service.start()
        yield
    finally:
        target_app.state.sync_service.shutdown()
        target_app.state.live_engine.shutdown()
        target_app.state.external_clients.close()
        target_app.state.database.close()


@api.get("/health")
def health(request: Request):
    try:
        request.app.state.database.connect().close()
    except Exception as e:
        raise HTTPException(503, f"Database not ready: {e}")
    return {"status": "ok", "app": "openings", "stockfish": request.app.state.live_engine.availability()}


@api.get("/profile")
def get_profile(request: Request):
    return {
        "accounts": db.list_accounts(),
        "has_lichess_token": bool(db.get_setting("lichess_token")),
        "games": db.count_games_by_source(),
        "stockfish": request.app.state.live_engine.availability(),
    }


@api.get("/accounts")
def get_accounts():
    return db.list_accounts()


@api.post("/accounts", status_code=201)
def add_account(input: AccountInput, request: Request):
    if os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK") != "1":
        exists = game_import.account_exists(
            input.platform, input.username.strip(),
            client=request.app.state.external_clients.http,
        )
        if exists is False:
            site = "Chess.com" if input.platform == "chesscom" else "Lichess"
            raise HTTPException(400, f"{site} has no user named “{input.username.strip()}”")
    try:
        account = db.create_account(input.platform, input.username, input.label)
    except ValueError as e:
        raise HTTPException(400, str(e))
    job = request.app.state.sync_service.enqueue(account["id"])
    return {"account": db.get_account(account["id"]), "job": job}


@api.post("/accounts/{account_id}/sync", status_code=202)
def sync_account(request: Request, account_id: int = Path(gt=0)):
    account = db.get_account(account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    return request.app.state.sync_service.enqueue(account_id)


@api.get("/sync-jobs/{job_id}")
def get_sync_job(job_id: str = Path(
    min_length=36, max_length=36,
    pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
)):
    job = db.get_sync_job(job_id)
    if not job:
        raise HTTPException(404, "Sync job not found")
    return job


@api.delete("/sync-jobs/{job_id}", status_code=202)
def cancel_sync_job(
    request: Request,
    job_id: str = Path(
        min_length=36, max_length=36,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    ),
):
    job = request.app.state.sync_service.cancel(job_id)
    if not job:
        raise HTTPException(404, "Active sync job not found")
    return job


@api.delete("/accounts/{account_id}")
def remove_account(
    request: Request,
    account_id: int = Path(gt=0),
    delete_games: bool = True,
):
    account = db.get_account(account_id)
    if account and (account.get("sync_job") or {}).get("status") in ("queued", "running"):
        raise HTTPException(409, "Cancel the active sync before removing this account")
    if not db.delete_account(account_id, delete_games=delete_games):
        raise HTTPException(404, "Account not found")
    request.app.state.opening_tree_cache.invalidate()
    return {"success": True}


@api.put("/settings/lichess-token")
def set_lichess_token(input: LichessTokenInput):
    token = (input.token or "").strip()
    db.set_setting("lichess_token", token)
    return {"has_lichess_token": bool(token)}


@api.get("/evaluate-stream")
async def evaluate_stream(
    request: Request,
    fen: str = Query(min_length=4, max_length=128),
    depth: int = Query(default=0, ge=0, le=100),
    max_seconds: float = Query(default=live_engine.LIVE_MAX_SECONDS, ge=0, le=300),
):
    """Progressive Stockfish eval via Server-Sent Events (depth 1…N).

    Runs the single persistent live engine; a new request proactively cancels the
    one in flight (see live_engine.stream), so navigating never queues behind a
    stale search. ``depth``/``max_seconds`` let the UI deepen the search (pass both
    ``0`` for an unbounded ∞ search that runs until the user stops/navigates).
    """
    if not fen:
        raise HTTPException(400, "Missing fen parameter")
    _validate_fen(fen)
    return StreamingResponse(
        request.app.state.live_engine.stream(fen, depth, max_seconds),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@api.get("/opening-tree")
async def opening_tree(
    request: Request,
    color: Literal["white", "black"] = "white",
    path: str = Query(default="", max_length=4000),
    time_class: str = Query(default="", max_length=64),
    account_id: int | None = Query(default=None, gt=0),
):
    path_moves = path.split()
    time_classes = [t for t in time_class.split(",") if t] or None
    allowed_time_classes = {"bullet", "blitz", "rapid", "daily"}
    if time_classes and any(t not in allowed_time_classes for t in time_classes):
        raise HTTPException(400, "Invalid time_class")
    return await run_in_threadpool(
        request.app.state.opening_tree_cache.node_for_filter,
        color, path_moves, time_classes, account_id,
    )


@api.get("/cloud-eval")
async def cloud_eval(request: Request, fen: str = Query(min_length=4, max_length=128),
                     multipv: int = Query(default=1, ge=1, le=5), network: bool = False):
    """Lichess cloud eval. Cache-only by default (network=False) so navigating
    never calls Lichess; the UI fetches with network=true on user request."""
    try:
        chess.Board(fen)
    except ValueError:
        raise HTTPException(400, "Invalid FEN")
    return await run_in_threadpool(
        request.app.state.external_clients.cloud_eval, fen, multipv, network)


def _external_network_allowed():
    return os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK") != "1"


@api.get("/tablebase")
async def tablebase(request: Request, fen: str = Query(min_length=4, max_length=128)):
    """Exact result of a position with seven or fewer pieces, and of each legal
    move in it, from the Lichess tablebase. ``available`` is false otherwise."""
    _validate_fen(fen)
    return await run_in_threadpool(
        request.app.state.external_clients.tablebase, fen, _external_network_allowed())


@api.post("/play/reply")
async def play_reply(input: PlayReplyInput, request: Request):
    """The opponent's move in the Play tab.

    With seven or fewer pieces the tablebase's best move is played: it is
    perfect and instant, and as the defender it holds out as long as possible,
    which Stockfish does not guarantee. Otherwise Stockfish searches for
    ``seconds``.
    """
    _validate_fen(input.fen)
    board = chess.Board(input.fen)
    # The Play tab accepts pasted positions. Stockfish 19 exits on one that no
    # game can reach, so those stop here instead of costing an engine restart.
    if not board.is_valid():
        raise HTTPException(400, "That position cannot occur in a game")
    if board.is_game_over():
        raise HTTPException(400, "The game is already over")

    table = await run_in_threadpool(
        request.app.state.external_clients.tablebase, input.fen, _external_network_allowed())
    if table.get("available") and table.get("moves"):
        best = table["moves"][0]
        return {"uci": best["uci"], "san": best["san"], "source": "tablebase"}

    move = await run_in_threadpool(
        request.app.state.live_engine.best_move, input.fen, input.seconds)
    if move is None:
        raise HTTPException(503, "Stockfish did not return a move")
    return {**move, "source": "stockfish"}


@api.get("/saved-eval")
def get_saved_eval(fen: str = Query(min_length=4, max_length=128)):
    """A user-saved deep Stockfish eval for ``fen`` (or null). Loaded on every
    position so a saved line auto-fills the engine panel without re-searching or
    calling Lichess."""
    _validate_fen(fen)
    return db.get_saved_eval(fen)


@api.post("/saved-eval")
def save_saved_eval(input: SavedEvalInput):
    try:
        chess.Board(input.fen)
    except ValueError:
        raise HTTPException(400, "Invalid FEN")
    depth = (input.payload or {}).get("depth")
    db.put_saved_eval(input.fen, input.payload, depth)
    return {"saved": True, "fen": input.fen}


@api.delete("/saved-eval")
def delete_saved_eval(fen: str = Query(min_length=4, max_length=128)):
    _validate_fen(fen)
    db.delete_saved_eval(fen)
    return {"deleted": True, "fen": fen}


_MONTH_RE = re.compile(r"^(19|20)\d{2}-(0[1-9]|1[012])$")


def _explorer_filters(speeds: str, ratings: str, since: str, until: str):
    """Validate the Lichess explorer filters and shape them for lichess_explorer.

    Lichess rejects anything outside its own enums, so we reject it here too rather
    than forwarding junk and surfacing an opaque upstream error. Ratings are band
    lower bounds, not free numbers.
    """
    wanted_speeds = [s for s in speeds.split(",") if s]
    if any(s not in lichess_explorer.SPEEDS for s in wanted_speeds):
        raise HTTPException(400, "Invalid speeds")

    wanted_ratings = []
    for raw in (r for r in ratings.split(",") if r):
        if not raw.isdigit() or int(raw) not in lichess_explorer.RATING_GROUPS:
            raise HTTPException(400, "Invalid ratings")
        wanted_ratings.append(int(raw))

    for label, month in (("since", since), ("until", until)):
        if month and (not _MONTH_RE.match(month)
                      or int(month[:4]) < lichess_explorer.MIN_YEAR):
            raise HTTPException(400, f"Invalid {label} (expected YYYY-MM)")
    if since and until and since > until:
        raise HTTPException(400, "since must not be after until")

    return {"speeds": wanted_speeds, "ratings": wanted_ratings,
            "since": since, "until": until}


@api.get("/opening-explorer")
async def opening_explorer(
    request: Request,
    fen: str = Query(min_length=4, max_length=128),
    speeds: str = Query(default="", max_length=100),
    ratings: str = Query(default="", max_length=100),
    since: str = Query(default="", max_length=7),
    until: str = Query(default="", max_length=7),
):
    try:
        chess.Board(fen)
    except ValueError:
        raise HTTPException(400, "Invalid FEN")
    filters = _explorer_filters(speeds, ratings, since, until)
    allow_network = os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK") != "1"
    return await run_in_threadpool(
        request.app.state.external_clients.opening_explorer, fen, allow_network, filters,
    )


@api.get("/games")
def list_games(
    account_id: int | None = Query(default=None, gt=0),
    color: Literal["", "white", "black"] = "",
    time_class: str = Query(default="", max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Game metadata for the Games browser — newest first, paginated."""
    color = color or None
    time_classes = [t for t in time_class.split(",") if t] or None
    allowed_time_classes = {"bullet", "blitz", "rapid", "daily"}
    if time_classes and any(t not in allowed_time_classes for t in time_classes):
        raise HTTPException(400, "Invalid time_class")
    games = db.list_games(account_id=account_id, color=color,
                          time_classes=time_classes, limit=limit, offset=offset)
    total = db.count_games(account_id=account_id, color=color, time_classes=time_classes)
    return {"games": games, "total": total, "limit": limit, "offset": offset}


@api.get("/games/{game_id}")
def get_game(game_id: int = Path(gt=0)):
    """Full game including PGN, for the in-app review board."""
    game = db.get_game(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    return game


@api.get("/repertoire/tree")
def repertoire_tree(color: str = "white"):
    if color not in ("white", "black"):
        raise HTTPException(400, "color must be 'white' or 'black'")
    return db.get_repertoire_tree(color)


@api.get("/openings/classify")
def classify_opening(moves_san: str = ""):
    """Name the opening a SAN line reaches, or null if unrecognized.

    Used by the editor to pre-fill the opening of a line you're about to save."""
    return eco_openings.classify(moves_san)


@api.get("/repertoire/openings")
def list_repertoire_openings(color: str = "white"):
    if color not in ("white", "black"):
        raise HTTPException(400, "color must be 'white' or 'black'")
    return db.list_repertoire_openings(color)


@api.post("/repertoire/openings")
def create_repertoire_opening(input: RepertoireOpeningInput):
    try:
        return db.create_repertoire_opening(input.color, input.name, input.note)
    except ValueError as e:
        raise HTTPException(400, str(e))


@api.patch("/repertoire/openings/{opening_id}")
def update_repertoire_opening(input: RepertoireOpeningPatch, opening_id: int = Path(gt=0)):
    try:
        opening = db.update_repertoire_opening(opening_id, name=input.name, note=input.note)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not opening:
        raise HTTPException(404, "Opening not found")
    return opening


@api.delete("/repertoire/openings/{opening_id}")
def delete_repertoire_opening(opening_id: int = Path(gt=0)):
    if not db.delete_repertoire_opening(opening_id):
        raise HTTPException(404, "Opening not found")
    return {"success": True}


@api.post("/repertoire/tree/branches")
def save_repertoire_branch(input: RepertoireBranchInput):
    try:
        return db.save_repertoire_branch(
            input.color, input.name, input.moves_san,
            label=input.label, note=input.note,
            opening=input.opening, tags=input.tags,
            opening_id=input.opening_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@api.delete("/repertoire/tree/branches/{branch_id}")
def delete_repertoire_branch(branch_id: int = Path(gt=0)):
    if not db.delete_repertoire_branch(branch_id):
        raise HTTPException(404, "Branch not found")
    return {"success": True}


@api.patch("/repertoire/tree/branches/{branch_id}")
def update_repertoire_branch(input: RepertoireBranchPatch, branch_id: int = Path(gt=0)):
    try:
        branch = db.update_repertoire_branch(
            branch_id,
            color=input.color,
            name=input.name,
            moves_san=input.moves_san,
            label=input.label,
            note=input.note,
            opening=input.opening,
            opening_id=input.opening_id,
            tags=input.tags,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not branch:
        raise HTTPException(404, "Branch not found")
    return branch


@api.post("/repertoire/drill-attempts")
def record_drill_attempt(input: DrillAttemptInput):
    try:
        result = db.record_repertoire_drill_attempt(
            input.event_key,
            input.source,
            input.solved,
            node_id=input.node_id,
            branch_id=input.branch_id,
            expected_san=input.expected_san,
            played_san=input.played_san,
            path_san=input.path_san,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not result:
        raise HTTPException(404, "Drill target not found")
    return result


@api.get("/backup")
async def download_backup(request: Request, background_tasks: BackgroundTasks):
    fd, path = tempfile.mkstemp(prefix="chess-openings-backup-", suffix=".db")
    os.close(fd)
    try:
        await run_in_threadpool(request.app.state.database.backup, path)
    except Exception:
        try:
            os.remove(path)
        except OSError:
            pass
        raise HTTPException(500, "Could not create database backup")
    background_tasks.add_task(os.remove, path)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return FileResponse(
        path,
        media_type="application/vnd.sqlite3",
        filename=f"chess-openings-{stamp}.db",
        background=background_tasks,
    )


class _FingerprintedStaticFiles(StaticFiles):
    """Vite puts a content hash in every dist/assets filename (index-<hash>.js), so
    the bytes behind a URL never change: browsers may keep them for a year instead
    of revalidating the bundle on every load. index.html is what must stay fresh."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def _setup_desktop_frontend(target_app):
    if os.environ.get("CHESS_OPENINGS_DESKTOP") != "1":
        return
    if not os.path.isdir(DIST_DIR):
        return

    public_root = os.path.join(OPENINGS_ROOT, "frontend", "public")
    for mount_path, dir_name in [
        ("/sounds", "sounds"),
        ("/piece", "piece"),
        ("/board", "board"),
    ]:
        mount_dir = os.path.join(public_root, dir_name)
        if os.path.isdir(mount_dir):
            target_app.mount(mount_path, StaticFiles(directory=mount_dir), name=dir_name)

    assets_dir = os.path.join(DIST_DIR, "assets")
    if os.path.isdir(assets_dir):
        target_app.mount("/assets", _FingerprintedStaticFiles(directory=assets_dir), name="assets")

    favicon = os.path.join(public_root, "favicon.svg")
    if os.path.isfile(favicon):
        @target_app.get("/favicon.svg")
        async def favicon_route():
            return FileResponse(favicon)

    dist_real = os.path.realpath(DIST_DIR)

    @target_app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        index = os.path.join(DIST_DIR, "index.html")
        if full_path:
            # Resolve symlinks/.. and require the result to stay inside dist, so an
            # encoded-traversal path (e.g. /..%2F..%2Fchess_review.db) can never
            # reach files outside frontend/dist. Starlette's StaticFiles does the
            # same check; this hand-rolled FileResponse route must do it too.
            target_real = os.path.realpath(os.path.join(DIST_DIR, full_path))
            try:
                contained = os.path.commonpath([dist_real, target_real]) == dist_real
            except ValueError:
                contained = False
            if contained and os.path.isfile(target_real):
                return FileResponse(target_real)
        if os.path.isfile(index):
            # Revalidate every time: it names the current fingerprinted bundle.
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        raise HTTPException(
            503,
            "Frontend not built. Run: cd openings && ./start.sh",
        )

def create_app():
    target_app = FastAPI(title="Chess Openings", lifespan=lifespan)
    target_app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5174",
            "http://localhost:5174",
            "http://127.0.0.1:8001",
            "http://localhost:8001",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # JSON (the repertoire tree especially) and the JS/CSS bundle compress 3-5x.
    # Starlette skips text/event-stream, so engine SSE frames are never buffered.
    target_app.add_middleware(GZipMiddleware, minimum_size=1024)
    target_app.include_router(api)
    _setup_desktop_frontend(target_app)
    return target_app


app = create_app()
