"""The local service behind the Lichess extension (extension/), on port 8001.

It keeps your repertoire and your imported chess.com and Lichess games in
chess_review.db, and serves this Mac's Stockfish to Lichess as an external
engine (the only Stockfish it runs).
"""
import asyncio
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from hashlib import sha256
from typing import Literal

import chess
from contextlib import asynccontextmanager
from fastapi import APIRouter, FastAPI, HTTPException, Path, Query, Request
from fastapi.background import BackgroundTasks
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
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
import stockfish  # noqa: E402  (where Stockfish is on this Mac)
import extension_health  # noqa: E402  (what the Lichess extension could not show)
import idle_exit  # noqa: E402  (stops the service when the extension is gone)
import lichess_engine_provider  # noqa: E402  (your Stockfish inside Lichess's own analysis)
import game_import  # noqa: E402
from sync_service import AccountSyncService  # noqa: E402
from services import ExternalApiClients, SQLiteService  # noqa: E402
from account_game_repository import ActiveAccountSync  # noqa: E402
from repertoire_repository import RepertoireConflict  # noqa: E402

# Route handlers that touch SQLite are plain `def`, not `async def`: FastAPI runs
# those in its threadpool. As coroutines they ran on the event loop itself, so a
# query waiting out busy_timeout behind the sync writer froze every other request
# (engine streams included) for up to five seconds.
api = APIRouter(prefix="/api")


RepertoireLabel = Literal["main", "alternative", "trap", "sideline"]


class RepertoireBranchSnapshot(BaseModel):
    id: int = Field(gt=0, lt=2**63)
    name: str
    label: RepertoireLabel


class RepertoireBranchEditSnapshot(BaseModel):
    name: str
    label: RepertoireLabel
    moves_san: str = Field(min_length=1, max_length=4000)


class RepertoireBranchInput(BaseModel):
    color: Literal["white", "black"]
    name: str = Field(default="", max_length=120)
    moves_san: str = Field(min_length=1, max_length=4000)
    label: RepertoireLabel = "main"
    expected: RepertoireBranchSnapshot | Literal["new"] | None = None


class RepertoireBranchPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    moves_san: str | None = Field(default=None, min_length=1, max_length=4000)
    label: RepertoireLabel | None = None
    expected_moves_san: str | None = Field(default=None, min_length=1, max_length=4000)
    expected: RepertoireBranchEditSnapshot | None = None


class AccountInput(BaseModel):
    platform: Literal["chesscom", "lichess"]
    username: str = Field(min_length=1, max_length=80, pattern=r"^[^\s/]+$")
    label: str = Field(default="", max_length=80)


class LichessTokenInput(BaseModel):
    token: str = Field(default="", max_length=512)


# The names this service answers to ("testserver" is the test client's).
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver"]

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
    target_app.state.idle_exit = idle_exit.from_environment()
    # Starts paused (fail-closed): the extension says at once whether a game
    # is on in a Lichess tab (background.js tells it when it sees the app up).
    target_app.state.lichess_engine = lichess_engine_provider.LichessEngineProvider(
        on_activity=target_app.state.idle_exit.touch if target_app.state.idle_exit else None,
        paused=True)

    target_app.state.sync_service = AccountSyncService(
        invalidate_cache=target_app.state.opening_tree_cache.invalidate,
        import_client=target_app.state.external_clients.import_client,
    )
    idle_watch = None
    try:
        target_app.state.sync_service.start()
        target_app.state.lichess_engine.start()
        if target_app.state.idle_exit:
            target_app.state.idle_exit.touch()
            idle_watch = asyncio.get_running_loop().create_task(target_app.state.idle_exit.run())
        yield
    finally:
        if idle_watch:
            idle_watch.cancel()
        await target_app.state.lichess_engine.stop()
        target_app.state.sync_service.shutdown()
        target_app.state.external_clients.close()
        target_app.state.database.close()


@api.get("/health")
def health(request: Request):
    try:
        request.app.state.database.connect().close()
    except Exception as e:
        raise HTTPException(503, f"Database not ready: {e}")
    return {"status": "ok", "app": "openings", "stockfish": stockfish.availability()}


@api.post("/keepalive")
def keepalive(request: Request):
    """The extension's "a Lichess tab is still open". Every request counts as
    use (see idle_exit.py); this one exists for when nothing else is asked."""
    idle = request.app.state.idle_exit
    return {"ok": True, "stops_after_idle_seconds": idle.seconds if idle else None}


@api.get("/profile")
def get_profile(request: Request):
    return {
        "accounts": db.list_accounts(),
        "has_lichess_token": bool(db.get_setting("lichess_token")),
        "stockfish": stockfish.availability(),
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
    if job is None:
        raise HTTPException(404, "Account not found")
    return {"account": db.get_account(account["id"]), "job": job}


@api.post("/accounts/{account_id}/sync", status_code=202)
def sync_account(request: Request, account_id: int = Path(gt=0, lt=2**63)):
    job = request.app.state.sync_service.enqueue(account_id)
    if job is None:
        raise HTTPException(404, "Account not found")
    return job


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
def remove_account(request: Request, account_id: int = Path(gt=0, lt=2**63)):
    """Removes the account together with its imported games."""
    try:
        deleted = db.delete_account(account_id)
    except ActiveAccountSync as exc:
        raise HTTPException(409, "Cancel the active sync before removing this account") from exc
    if not deleted:
        raise HTTPException(404, "Account not found")
    request.app.state.opening_tree_cache.invalidate()
    return {"success": True}


@api.put("/settings/lichess-token")
def set_lichess_token(input: LichessTokenInput):
    token = (input.token or "").strip()
    db.set_setting("lichess_token", token)
    return {"has_lichess_token": bool(token)}


@api.get("/opening-tree")
async def opening_tree(
    request: Request,
    color: Literal["white", "black"] = "white",
    fen: str = Query(min_length=4, max_length=128),
    moves_san: str = Query(default="", max_length=8000),
):
    """Your games through one position, whatever the move order: the moves you
    played from it and how they scored (the explorer's My games tab).

    `opening_name` is the name of the position itself (from the ECO list, by
    the moves on the board when `moves_san` is given), not of the openings
    your games through it ended up in."""
    _validate_fen(fen)
    node = await run_in_threadpool(
        request.app.state.opening_tree_cache.node_for_filter, color, [], None, None, fen,
    )
    node["opening_name"] = await run_in_threadpool(eco_openings.name_at, fen, moves_san)
    return node


class ExtensionHealthInput(BaseModel):
    page_kind: Literal["analyse", "round", "other"]
    # Long on purpose: a game opened from My games has all its moves in its
    # address, and a report refused for its length is a report lost
    # (extension_health keeps the first 300 characters).
    url: str = Field(default="", max_length=8000)
    extension_version: str = Field(default="", max_length=40)
    features: dict = Field(default_factory=dict)


@api.post("/extension/health")
def extension_health_report(input: ExtensionHealthInput):
    """The Lichess extension's report of which features it could place on a
    page. Written to extension/health-report.json for repair."""
    try:
        merged = extension_health.record(input.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"broken": len(merged["broken"])}


@api.get("/lichess-engine")
def lichess_engine_status(request: Request):
    """Whether your Stockfish is connected to Lichess's own analysis."""
    return request.app.state.lichess_engine.status()


class EnginePauseInput(BaseModel):
    paused: bool


@api.put("/lichess-engine/paused")
async def lichess_engine_pause(input: EnginePauseInput, request: Request):
    """The extension's live-game lock: while a game is in progress in any
    Lichess tab, your Stockfish answers Lichess with nothing."""
    await request.app.state.lichess_engine.set_paused(input.paused)
    return {"paused": request.app.state.lichess_engine.paused}


@api.post("/lichess-engine/analyse")
async def lichess_engine_analyse(request: Request):
    """Lichess's analysis for the page on this computer, with no trip through
    Lichess's engine broker (which allows each address only a few requests a
    second, three per position). The extension forwards the page's request
    ({"engineId", "work"}) and hands the page this stream: the same ndjson the
    broker would have sent. 404: not this app's engine, so the extension sends
    the request to the broker as before. The live-game lock holds here too."""
    # JSON only: a website could send a plain-text POST without asking, but
    # never a JSON one (that needs CORS, which this service does not grant).
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "JSON only")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Invalid JSON")
    provider = request.app.state.lichess_engine
    if not isinstance(body, dict) or not provider.can_answer(body.get("engineId")):
        raise HTTPException(404, "Not this app's engine")
    if not provider.stockfish_found():
        raise HTTPException(503, "Stockfish was not found")
    try:
        work, board = lichess_engine_provider.sanitize_work(body.get("work"))
    except lichess_engine_provider.InvalidWork as exc:
        raise HTTPException(400, str(exc))
    return StreamingResponse(
        provider.local_analysis(work, board), media_type="application/x-ndjson",
        # Each line as it comes: never held back to be compressed.
        headers={"Cache-Control": "no-store", "Content-Encoding": "identity"})


@api.get("/extension/build")
def extension_build():
    """When the extension's files last changed. The extension compares it with
    the build it is running and reloads itself, so code updates need no trip to
    chrome://extensions."""
    root = os.path.join(OPENINGS_ROOT, "extension")
    newest = 0.0
    for folder in ("src", "vendor", "icons"):
        for dirpath, _, files in os.walk(os.path.join(root, folder)):
            for name in files:
                newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
    for name in ("manifest.json", "settings.html", "settings.js", "settings.css"):
        newest = max(newest, os.path.getmtime(os.path.join(root, name)))
    return {"build": int(newest)}


@api.get("/position-games")
def position_games(
    request: Request,
    fen: str = Query(min_length=4, max_length=128),
    color: Literal["white", "black", "both"] = "both",
    limit: int = Query(default=15, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    revision: str | None = Query(default=None, pattern=r"^[a-f0-9]{64}$"),
):
    """Your games that reached this position (any move order), newest first,
    with the ply where each got there. At the start position: all your games."""
    _validate_fen(fen)
    found = request.app.state.opening_tree_cache.games_through(
        fen, None if color == "both" else color)
    current_revision = sha256(",".join(str(game["id"]) for game, _ in found).encode()).hexdigest()
    if revision is not None and revision != current_revision:
        raise HTTPException(409, "The game list changed. Reload it from the first page")
    page = found[offset:offset + limit]
    details = db.get_game_summaries([game["id"] for game, _ in page])
    games = [{**details[game["id"]], "ply": ply} for game, ply in page if game["id"] in details]
    if len(games) != len(page):
        raise HTTPException(409, "The game list changed. Reload it from the first page")
    return {"total": len(found), "games": games, "revision": current_revision}


@api.get("/games/{game_id}")
def get_game(game_id: int = Path(gt=0, lt=2**63)):
    """Full game including PGN."""
    game = db.get_game(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    return game


@api.get("/repertoire/tree")
def repertoire_tree(color: Literal["white", "black"] = "white"):
    return db.get_repertoire_tree(color)


@api.get("/openings/classify")
def classify_opening(moves_san: str = ""):
    """Name the opening a SAN line reaches, or null if unrecognized.

    Pre-fills the name of a line you're about to save to your repertoire."""
    return eco_openings.classify(moves_san)


def _line_name(name, moves_san):
    """The name to store for a saved line: yours, in the ECO list's spelling
    when it is one of its openings ("Caro Kann Defense" -> "Caro-Kann
    Defense"); with no name given, the opening the moves reach."""
    name = (name or "").strip()
    if name:
        return eco_openings.canonical_spelling(name)
    found = eco_openings.classify(moves_san or "")
    return found["name"] if found else ""


@api.post("/repertoire/tree/branches")
def save_repertoire_branch(input: RepertoireBranchInput):
    expected = input.expected.model_dump() if isinstance(input.expected, RepertoireBranchSnapshot) else input.expected
    try:
        return db.save_repertoire_branch(
            input.color, _line_name(input.name, input.moves_san), input.moves_san,
            label=input.label, expected=expected)
    except RepertoireConflict as e:
        raise HTTPException(409, "The repertoire line changed while it was open") from e
    except ValueError as e:
        raise HTTPException(400, str(e))


@api.delete("/repertoire/tree/branches/{branch_id}")
def delete_repertoire_branch(
    branch_id: int = Path(gt=0, lt=2**63),
    expected: RepertoireBranchEditSnapshot | None = None,
):
    try:
        deleted = db.delete_repertoire_branch(branch_id, expected=expected.model_dump() if expected else None)
    except RepertoireConflict as e:
        raise HTTPException(409, "The repertoire line changed while it was open") from e
    if not deleted:
        raise HTTPException(404, "Branch not found")
    return {"success": True}


@api.patch("/repertoire/tree/branches/{branch_id}")
def update_repertoire_branch(input: RepertoireBranchPatch, branch_id: int = Path(gt=0, lt=2**63)):
    name = input.name
    if name is not None:
        # An emptied name gets the opening's name rather than the raw moves.
        name = _line_name(name, input.moves_san or db.get_repertoire_branch_moves(branch_id) or "")
    try:
        branch = db.update_repertoire_branch(
            branch_id, name=name, moves_san=input.moves_san, label=input.label,
            expected_moves_san=input.expected_moves_san,
            expected=input.expected.model_dump() if input.expected else None)
    except RepertoireConflict as e:
        raise HTTPException(409, "The repertoire line changed while it was open") from e
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not branch:
        raise HTTPException(404, "Branch not found")
    return branch


@api.get("/backup")
async def download_backup(request: Request, background_tasks: BackgroundTasks):
    """A consistent copy of the database (the extension's settings page)."""
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


class _CountsAsUse:
    """Every request tells the idle watchdog the service is being used."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            idle = getattr(scope["app"].state, "idle_exit", None)
            if idle:
                idle.touch()
        await self.app(scope, receive, send)


class _NoKeepaliveLines(logging.Filter):
    """Keeps the half-minute keepalive out of the access log."""

    def filter(self, record):
        return "/api/keepalive" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_NoKeepaliveLines())


def create_app():
    target_app = FastAPI(title="Chess Openings", lifespan=lifespan)
    target_app.add_middleware(_CountsAsUse)
    # No CORS headers on purpose: the extension's background script reaches
    # this service through its host permission, which needs none, and without
    # them no website (or other extension without that permission) can read
    # your games, your repertoire or the backup with your Lichess token.
    # Answering only to its own address also stops a website that points its
    # own domain name at 127.0.0.1 (DNS rebinding) from doing the same.
    target_app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
    # JSON (the repertoire tree especially) benefits from compression.
    target_app.add_middleware(GZipMiddleware, minimum_size=1024)
    target_app.include_router(api)
    return target_app


app = create_app()
