"""The local service behind the Lichess extension (extension/), on port 8001.

It keeps your repertoire and your imported chess.com and Lichess games in
chess_review.db, finds the mistakes in those games with Stockfish, and serves
this Mac's Stockfish to Lichess as an external engine.
"""
import asyncio
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
import stockfish  # noqa: E402  (where Stockfish is on this Mac)
import game_analysis  # noqa: E402  (mistakes in the user's own games)
import extension_health  # noqa: E402  (what the Lichess extension could not show)
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


class AccountInput(BaseModel):
    platform: Literal["chesscom", "lichess"]
    username: str = Field(min_length=1, max_length=80, pattern=r"^[^\s/]+$")
    label: str = Field(default="", max_length=80)


class LichessTokenInput(BaseModel):
    token: str = Field(default="", max_length=512)


class AnalysisStartInput(BaseModel):
    account_id: int | None = Field(default=None, gt=0)
    count: int = Field(default=4, ge=1, le=50)
    game_id: int | None = Field(default=None, gt=0)  # check just this game


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
    target_app.state.lichess_engine = lichess_engine_provider.LichessEngineProvider()

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
    try:
        target_app.state.sync_service.start()
        target_app.state.lichess_engine.start()
        auto_sync = (asyncio.get_running_loop().create_task(_auto_sync(target_app.state.sync_service))
                     if os.environ.get("OPENINGS_AUTO_SYNC") == "1" else None)
        yield
    finally:
        if auto_sync:
            auto_sync.cancel()
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


@api.get("/profile")
def get_profile(request: Request):
    return {
        "accounts": db.list_accounts(),
        "has_lichess_token": bool(db.get_setting("lichess_token")),
        "games": db.count_games_by_source(),
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


@api.get("/opening-tree")
async def opening_tree(
    request: Request,
    color: Literal["white", "black"] = "white",
    path: str = Query(default="", max_length=4000),
    time_class: str = Query(default="", max_length=64),
    account_id: int | None = Query(default=None, gt=0),
    fen: str = Query(default="", max_length=128),
):
    """Your games through one position: by ``path`` (SAN moves from the start)
    or, when ``fen`` is given, by the position itself (the Lichess extension
    only knows the board, not the move order)."""
    if fen:
        _validate_fen(fen)
    path_moves = path.split()
    time_classes = [t for t in time_class.split(",") if t] or None
    allowed_time_classes = {"bullet", "blitz", "rapid", "daily"}
    if time_classes and any(t not in allowed_time_classes for t in time_classes):
        raise HTTPException(400, "Invalid time_class")
    return await run_in_threadpool(
        request.app.state.opening_tree_cache.node_for_filter,
        color, path_moves, time_classes, account_id, fen or None,
    )


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
    account_id: int | None = Query(default=None, gt=0),
):
    """Your games that reached this position (any move order), newest first,
    with the ply where each got there. At the start position: all your games."""
    _validate_fen(fen)
    found = request.app.state.opening_tree_cache.games_through(
        fen, None if color == "both" else color, None, account_id)
    page = found[offset:offset + limit]
    details = db.get_game_summaries([game["id"] for game, _ in page])
    games = [{**details[game["id"]], "ply": ply} for game, ply in page if game["id"] in details]
    return {"total": len(found), "games": games}


@api.get("/analysis")
def analysis_status(request: Request):
    """How far the background analysis has got."""
    return request.app.state.game_analyzer.status()


@api.post("/analysis", status_code=202)
def analysis_start(input: AnalysisStartInput, request: Request):
    """Search the newest `count` games that have not been analysed yet for the
    user's mistakes, in the background. Poll GET /analysis for progress."""
    clients = request.app.state.external_clients
    allow_network = _external_network_allowed()
    try:
        return request.app.state.game_analyzer.start(
            tablebase=lambda fen: clients.tablebase(fen, allow_network),
            account_id=input.account_id, count=input.count,
            game_ids=[input.game_id] if input.game_id else None)
    except game_analysis.AnalysisError as exc:
        raise HTTPException(503, str(exc))


@api.get("/games")
def list_games(
    account_id: int | None = Query(default=None, gt=0),
    color: Literal["", "white", "black"] = "",
    time_class: str = Query(default="", max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Game metadata, newest first, paginated."""
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
    """Full game including PGN and the mistakes found in it."""
    game = db.get_game(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    game["mistakes"] = game_analysis.mistakes_for_game(game["id"])
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


def create_app():
    target_app = FastAPI(title="Chess Openings", lifespan=lifespan)
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
