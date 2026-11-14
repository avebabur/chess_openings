"""The local service behind the Lichess extension (extension/), on port 8001.

It keeps your repertoire and your imported chess.com and Lichess games in
chess_review.db, finds the mistakes in those games with Stockfish, and serves
this Mac's Stockfish to Lichess as an external engine.
"""
import asyncio
import logging
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
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
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
import game_analysis  # noqa: E402  (mistakes in the user's own games)
import extension_health  # noqa: E402  (what the Lichess extension could not show)
import idle_exit  # noqa: E402  (stops the service when the extension is gone)
import lichess_engine_provider  # noqa: E402  (your Stockfish inside Lichess's own analysis)
import game_import  # noqa: E402
from sync_service import AccountSyncService  # noqa: E402
from services import ExternalApiClients, SQLiteService  # noqa: E402

# Route handlers that touch SQLite are plain `def`, not `async def`: FastAPI runs
# those in its threadpool. As coroutines they ran on the event loop itself, so a
# query waiting out busy_timeout behind the sync writer froze every other request
# (engine streams included) for up to five seconds.
api = APIRouter(prefix="/api")


class RepertoireBranchInput(BaseModel):
    color: Literal["white", "black"]
    name: str = Field(default="", max_length=120)
    moves_san: str = Field(min_length=1, max_length=4000)
    label: Literal["main", "alternative", "trap", "sideline"] = "main"


class RepertoireBranchPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    moves_san: str | None = Field(default=None, min_length=1, max_length=4000)
    label: Literal["main", "alternative", "trap", "sideline"] | None = None


class AccountInput(BaseModel):
    platform: Literal["chesscom", "lichess"]
    username: str = Field(min_length=1, max_length=80, pattern=r"^[^\s/]+$")
    label: str = Field(default="", max_length=80)


class LichessTokenInput(BaseModel):
    token: str = Field(default="", max_length=512)


class AnalysisStartInput(BaseModel):
    game_id: int | None = Field(default=None, gt=0)  # the one game to check
    all: bool = False  # or: every game not checked yet


# The names this service answers to ("testserver" is the test client's).
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver"]

# Games analysed on their own after a sync brings in new ones.
AUTO_ANALYSE_MAX_GAMES = 10
# start.sh turns this on: fetch new games when the app starts and every 30 min,
# so My games on Lichess is never missing your latest games.
AUTO_SYNC_SECONDS = 30 * 60


async def _auto_sync(sync_service):
    while True:
        try:
            accounts = await run_in_threadpool(db.list_accounts)
            now = datetime.now(timezone.utc)
            for account in accounts:
                last = account.get("last_synced_at")
                if last:
                    age = now - datetime.fromisoformat(last.replace(" ", "T")).replace(tzinfo=timezone.utc)
                    if age.total_seconds() < AUTO_SYNC_SECONDS - 60:
                        continue
                await run_in_threadpool(sync_service.enqueue, account["id"])
        except Exception as exc:  # network or DB trouble: try again next round
            print(f"auto-sync: {exc}", file=sys.stderr)
        await asyncio.sleep(AUTO_SYNC_SECONDS)


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
    target_app.state.game_analyzer = game_analysis.GameAnalyzer()
    target_app.state.idle_exit = idle_exit.from_environment()
    target_app.state.lichess_engine = lichess_engine_provider.LichessEngineProvider(
        on_activity=target_app.state.idle_exit.touch if target_app.state.idle_exit else None)

    def analyse_new_games(account_id, imported):
        """Search the games a sync just brought in for mistakes. Capped, so a
        first import of a thousand games does not keep the engine busy for
        hours; the rest can be checked one by one from the game's card."""
        if os.environ.get("OPENINGS_AUTO_ANALYSE", "1") != "1":
            return
        clients = target_app.state.external_clients
        allow_network = _external_network_allowed()
        try:
            target_app.state.game_analyzer.start(
                tablebase=lambda fen: clients.tablebase(fen, allow_network),
                account_id=account_id, count=min(imported, AUTO_ANALYSE_MAX_GAMES),
                queue=True)
        except game_analysis.AnalysisError:
            pass  # no Stockfish: the game's card says so when asked

    target_app.state.sync_service = AccountSyncService(
        invalidate_cache=target_app.state.opening_tree_cache.invalidate,
        import_client=target_app.state.external_clients.import_client,
        on_imported=analyse_new_games,
    )
    auto_sync = None
    idle_watch = None
    try:
        target_app.state.sync_service.start()
        target_app.state.lichess_engine.start()
        if target_app.state.idle_exit:
            target_app.state.idle_exit.touch()
            idle_watch = asyncio.get_running_loop().create_task(target_app.state.idle_exit.run())
        auto_sync = (asyncio.get_running_loop().create_task(_auto_sync(target_app.state.sync_service))
                     if os.environ.get("OPENINGS_AUTO_SYNC") == "1" else None)
        yield
    finally:
        if auto_sync:
            auto_sync.cancel()
        if idle_watch:
            idle_watch.cancel()
        await target_app.state.lichess_engine.stop()
        target_app.state.game_analyzer.shutdown()
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
def remove_account(request: Request, account_id: int = Path(gt=0)):
    """Removes the account together with its imported games."""
    account = db.get_account(account_id)
    if account and (account.get("sync_job") or {}).get("status") in ("queued", "running"):
        raise HTTPException(409, "Cancel the active sync before removing this account")
    if not db.delete_account(account_id):
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


def _external_network_allowed():
    return os.environ.get("OPENINGS_DISABLE_EXTERNAL_NETWORK") != "1"


class ExtensionHealthInput(BaseModel):
    page_kind: Literal["analyse", "round", "other"]
    url: str = Field(default="", max_length=500)
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
    newest = max(newest, os.path.getmtime(os.path.join(root, "manifest.json")))
    return {"build": int(newest)}


@api.get("/games/by-link")
def game_by_link(url: str = Query(min_length=8, max_length=300)):
    """The imported game a Lichess game page belongs to (the extension's game
    card on one of your own Lichess games)."""
    lichess = re.search(r"lichess\.org/(?:game/)?([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:[/?#]|$)", url)
    if not lichess:
        raise HTTPException(400, "Not a Lichess game address")
    game = db.find_game_by_external_id("lichess", lichess.group(1))
    if not game:
        raise HTTPException(404, "That Lichess game has not been imported yet")
    return game


@api.get("/position-games")
def position_games(
    request: Request,
    fen: str = Query(min_length=4, max_length=128),
    color: Literal["white", "black", "both"] = "both",
    limit: int = Query(default=15, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    """Your games that reached this position (any move order), newest first,
    with the ply where each got there. At the start position: all your games."""
    _validate_fen(fen)
    found = request.app.state.opening_tree_cache.games_through(
        fen, None if color == "both" else color)
    page = found[offset:offset + limit]
    details = db.get_game_summaries([game["id"] for game, _ in page])
    games = [{**details[game["id"]], "ply": ply} for game, ply in page if game["id"] in details]
    return {"total": len(found), "games": games}


def _analysis_status(request):
    return {**request.app.state.game_analyzer.status(),
            "unchecked": game_analysis.count_pending()}


@api.get("/analysis")
def analysis_status(request: Request):
    """How far the background analysis has got, and how many games are still
    unchecked."""
    return _analysis_status(request)


@api.post("/analysis", status_code=202)
def analysis_start(input: AnalysisStartInput, request: Request):
    """Search one game (`game_id`) or every unchecked game (`all`) for the
    user's mistakes, in the background, after the games already being
    searched. Poll GET /analysis for progress."""
    if input.all == (input.game_id is not None):
        raise HTTPException(422, "Give either game_id or all")
    if input.game_id is not None and not db.get_game(input.game_id):
        raise HTTPException(404, "Game not found")
    clients = request.app.state.external_clients
    allow_network = _external_network_allowed()
    chosen = ({"count": game_analysis.CHECK_ALL_LIMIT, "queue": True} if input.all
              else {"game_ids": [input.game_id]})
    try:
        request.app.state.game_analyzer.start(
            tablebase=lambda fen: clients.tablebase(fen, allow_network), **chosen)
    except game_analysis.AnalysisError as exc:
        raise HTTPException(503, str(exc))
    return _analysis_status(request)


@api.delete("/analysis")
def analysis_stop(request: Request):
    """Stop checking games. The game in progress is dropped; the ones already
    checked are kept."""
    request.app.state.game_analyzer.stop()
    return _analysis_status(request)


@api.get("/games/{game_id}")
def get_game(game_id: int = Path(gt=0)):
    """Full game including PGN and the mistakes found in it."""
    game = db.get_game(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    game["mistakes"] = game_analysis.mistakes_for_game(game["id"])
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
    try:
        return db.save_repertoire_branch(
            input.color, _line_name(input.name, input.moves_san), input.moves_san,
            label=input.label)
    except ValueError as e:
        raise HTTPException(400, str(e))


@api.delete("/repertoire/tree/branches/{branch_id}")
def delete_repertoire_branch(branch_id: int = Path(gt=0)):
    if not db.delete_repertoire_branch(branch_id):
        raise HTTPException(404, "Branch not found")
    return {"success": True}


@api.patch("/repertoire/tree/branches/{branch_id}")
def update_repertoire_branch(input: RepertoireBranchPatch, branch_id: int = Path(gt=0)):
    name = input.name
    if name is not None:
        # An emptied name gets the opening's name rather than the raw moves.
        name = _line_name(name, input.moves_san or db.get_repertoire_branch_moves(branch_id) or "")
    try:
        branch = db.update_repertoire_branch(
            branch_id, name=name, moves_san=input.moves_san, label=input.label)
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
