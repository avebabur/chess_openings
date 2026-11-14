"""Import a tracked account's public games from chess.com / lichess.

Both platforms expose public game archives that need no login (a configured
Lichess token only raises the rate limit). Each game is normalized to the shape
``database.save_imported_games`` expects and tagged with its owning account, so
the personal opening tree can be filtered per-account or combined. Mirrors the
field conventions of the pre-existing imported games (ISO end_time, PGN-derived
ECO code, humanized opening name). See [[chess-data-apis]].
"""
import json
import re
import time
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

import httpx

import database as db

USER_AGENT = "ChessOpenings/1.0"
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_MAX_GAMES = 6000  # safety ceiling per sync so one account can't run away
# A later sync only asks for what is new. Lichess filters by when a game
# STARTED, so reach back far enough for a correspondence game that started long
# before it ended; chess.com files a game under the month it ended.
_LICHESS_OVERLAP = timedelta(days=90)
_ARCHIVE_MONTH_RE = re.compile(r"/(\d{4})/(\d{2})$")

_HEADER_RE = re.compile(r'^\[(\w+)\s+"(.*)"\]\s*$', re.M)


def pgn_player(pgn, color):
    """The White or Black name in a PGN's tags, "Anonymous" when it has none."""
    for tag, value in _HEADER_RE.findall(pgn or ""):
        if tag == color and value.strip() and value.strip() != "?":
            return value.strip()
    return "Anonymous"
# Lichess "speed" → the time-class vocabulary the UI filters on (chess.com's).
# Lichess statuses for games that may never have been played out. With no
# `winner` such a game would otherwise be filed as a draw in the tree. (A
# noStart *can* carry a winner — the player who never moved loses — so only a
# winnerless one is skipped.)
_LICHESS_UNPLAYED = {"created", "started", "aborted", "noStart"}
_LICHESS_SPEED_TO_CLASS = {
    "ultraBullet": "bullet", "bullet": "bullet", "blitz": "blitz",
    "rapid": "rapid", "classical": "rapid", "correspondence": "daily",
}


class ImportError_(Exception):
    """Raised when an account can't be imported (missing user, upstream error)."""


class SyncCancelled(Exception):
    """Raised cooperatively when a queued/running account sync is cancelled."""


def _pgn_headers(pgn):
    return {m.group(1): m.group(2) for m in _HEADER_RE.finditer(pgn or "")}


def _epoch_to_iso(epoch):
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
    except (ValueError, TypeError, OSError):
        return None


def _opening_from_eco_url(url):
    """Humanize a chess.com ECOUrl slug into an opening name."""
    if not url:
        return None
    slug = url.rstrip("/").rsplit("/openings/", 1)[-1]
    # Drop the trailing move list, e.g. "...-Variation-3.Bf4-Bg4-4.e3".
    slug = re.split(r"-\d", slug, maxsplit=1)[0]
    name = slug.replace("-", " ").strip()
    # "Modern-Defense-with-1-d4" leaves a dangling "with" once the moves go.
    name = re.sub(r"\s+with$", "", name)
    return name or None


def _newest_first(items):
    return reversed(list(items or []))


def _archive_before(url, since):
    """Is this monthly archive older than the month before `since`? (The month
    before is kept: a cheap margin around the month boundary.)"""
    match = _ARCHIVE_MONTH_RE.search(url.rstrip("/"))
    if not match:
        return False
    months = int(match.group(1)) * 12 + int(match.group(2))
    return months < since.year * 12 + since.month - 1


def import_chesscom(username, account_id, progress=None, cancelled=None, client=None, since=None):
    """Fetch standard games from chess.com's public monthly archives: all of
    them, or with `since` (a datetime) only the months that can hold newer games."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    uname = username.lower()
    imported = seen = 0
    warnings = []
    manager = nullcontext(client) if client is not None else httpx.Client(
        timeout=_TIMEOUT, headers=headers, follow_redirects=True,
    )
    with manager as http:
        request_options = {} if client is None else {"headers": headers, "timeout": _TIMEOUT}
        r = http.get(
            f"https://api.chess.com/pub/player/{username}/games/archives",
            **request_options,
        )
        if r.status_code == 404:
            raise ImportError_(f"chess.com user “{username}” not found")
        if r.status_code != 200:
            raise ImportError_(f"chess.com returned HTTP {r.status_code}")
        archives = r.json().get("archives", [])
        # Archives and their game arrays are oldest-first. Walk both backwards so
        # the safety ceiling retains the most recent games, not the oldest ones.
        for url in _newest_first(archives):
            if cancelled and cancelled():
                raise SyncCancelled()
            if seen >= _MAX_GAMES or (since and _archive_before(url, since)):
                break
            ar = http.get(url, **request_options)
            if ar.status_code != 200:
                warnings.append(f"Could not import archive {url.rsplit('/', 1)[-1]} (HTTP {ar.status_code})")
                if progress:
                    progress(seen=seen, imported=imported, total=None, warnings=warnings)
                continue
            batch = []
            for g in _newest_first(ar.json().get("games", [])):
                if cancelled and cancelled():
                    raise SyncCancelled()
                if seen >= _MAX_GAMES:
                    break
                if g.get("rules") != "chess":
                    continue
                pgn = g.get("pgn")
                if not pgn:
                    continue
                seen += 1
                white = g.get("white") or {}
                black = g.get("black") or {}
                w_name, b_name = white.get("username", ""), black.get("username", "")
                user_is_white = w_name.lower() == uname
                hdr = _pgn_headers(pgn)
                me, opp = (white, black) if user_is_white else (black, white)
                batch.append({
                    "white": w_name, "black": b_name,
                    "result": hdr.get("Result", ""),
                    "date": hdr.get("UTCDate") or hdr.get("Date", ""),
                    "pgn": pgn,
                    "source": "chesscom",
                    "external_id": g.get("uuid"),
                    "user_color": "white" if user_is_white else "black",
                    "user_rating": me.get("rating"),
                    "opp_rating": opp.get("rating"),
                    "time_class": g.get("time_class"),
                    "time_control": g.get("time_control"),
                    "end_time": _epoch_to_iso(g.get("end_time")),
                    "eco": hdr.get("ECO"),
                    "opening": _opening_from_eco_url(hdr.get("ECOUrl")),
                    "account_id": account_id,
                })
            saved = db.save_imported_games(batch)
            imported += saved["imported"]
            if progress:
                progress(seen=seen, imported=imported, total=None, warnings=warnings)
            time.sleep(0.2)  # be polite between monthly archives
    return {"imported": imported, "seen": seen, "warnings": warnings}


def import_lichess(username, account_id, progress=None, cancelled=None, client=None, since=None):
    """Stream a player's standard games from the Lichess export API (NDJSON):
    all of them, or with `since` (a datetime) only those started around or
    after it."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/x-ndjson"}
    token = db.get_setting("lichess_token")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    uname = username.lower()
    params = {"max": _MAX_GAMES, "pgnInJson": "true", "opening": "true",
              "clocks": "false", "evals": "false"}
    if since:
        params["since"] = int((since - _LICHESS_OVERLAP).timestamp() * 1000)
    imported = seen = 0
    batch = []
    manager = nullcontext(client) if client is not None else httpx.Client(
        timeout=_TIMEOUT, headers=headers, follow_redirects=True,
    )
    with manager as http:
        request_options = {} if client is None else {"headers": headers, "timeout": _TIMEOUT}
        with http.stream(
            "GET", f"https://lichess.org/api/games/user/{username}",
            params=params, **request_options,
        ) as r:
            if r.status_code == 404:
                raise ImportError_(f"lichess user “{username}” not found")
            if r.status_code == 429:
                raise ImportError_("lichess rate-limited — try again in a minute")
            if r.status_code != 200:
                raise ImportError_(f"lichess returned HTTP {r.status_code}")
            for line in r.iter_lines():
                if cancelled and cancelled():
                    raise SyncCancelled()
                if not line.strip():
                    continue
                try:
                    g = json.loads(line)
                except ValueError:
                    continue
                if g.get("variant", "standard") != "standard":
                    continue
                if g.get("status") in _LICHESS_UNPLAYED and not g.get("winner"):
                    continue
                pgn = g.get("pgn")
                if not pgn:
                    continue
                seen += 1
                players = g.get("players") or {}
                w = players.get("white") or {}
                b = players.get("black") or {}
                # The computer and anonymous players have no user: their name
                # is the PGN's ("lichess AI level 8", "Anonymous").
                w_name = (w.get("user") or {}).get("name") or pgn_player(pgn, "White")
                b_name = (b.get("user") or {}).get("name") or pgn_player(pgn, "Black")
                user_is_white = w_name.lower() == uname
                me, opp = (w, b) if user_is_white else (b, w)
                winner = g.get("winner")
                result = "1-0" if winner == "white" else "0-1" if winner == "black" else "1/2-1/2"
                created = g.get("createdAt")
                last = g.get("lastMoveAt") or created
                opening = g.get("opening") or {}
                batch.append({
                    "white": w_name, "black": b_name,
                    "result": result,
                    "date": datetime.fromtimestamp(created / 1000, tz=timezone.utc).strftime("%Y.%m.%d") if created else "",
                    "pgn": pgn,
                    "source": "lichess",
                    "external_id": g.get("id"),
                    "user_color": "white" if user_is_white else "black",
                    "user_rating": me.get("rating"),
                    "opp_rating": opp.get("rating"),
                    "time_class": _LICHESS_SPEED_TO_CLASS.get(g.get("speed"), g.get("speed")),
                    "time_control": None,
                    "end_time": _epoch_to_iso(last / 1000) if last else None,
                    "eco": opening.get("eco"),
                    "opening": opening.get("name"),
                    "account_id": account_id,
                })
                if len(batch) >= 100:
                    saved = db.save_imported_games(batch)
                    imported += saved["imported"]
                    batch = []
                    if progress:
                        progress(seen=seen, imported=imported, total=None, warnings=[])
            if batch:
                saved = db.save_imported_games(batch)
                imported += saved["imported"]
                if progress:
                    progress(seen=seen, imported=imported, total=None, warnings=[])
    return {"imported": imported, "seen": seen, "warnings": []}


_PROFILE_URLS = {
    "chesscom": "https://api.chess.com/pub/player/{}",
    "lichess": "https://lichess.org/api/user/{}",
}
_PROFILE_TIMEOUT = httpx.Timeout(8.0, connect=5.0)


def account_exists(platform, username, client=None):
    """Does ``username`` exist on ``platform``? True / False, or None when the
    platform couldn't be asked (offline, rate-limited, 5xx) — callers should then
    proceed rather than block on a check that never happened.

    Adding an account used to create it unconditionally, so a typo became a dead
    "0 games · never synced" account that the app then switched to.
    """
    url = _PROFILE_URLS.get(platform)
    if not url:
        return None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    try:
        r = (client or httpx).get(url.format(username), headers=headers,
                                  timeout=_PROFILE_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if r.status_code == 200:
        return True
    if r.status_code in (404, 410):
        return False
    return None


def _newest_imported(account):
    """When the newest game already imported ended, once the account's whole
    history is in; None means "fetch everything". A first import that failed or
    was cancelled part-way never set last_synced_at, so it is done again in full."""
    if not account.get("last_synced_at"):
        return None
    try:
        newest = datetime.fromisoformat(db.newest_game_end(account["id"]) or "")
    except ValueError:
        return None
    return newest if newest.tzinfo else newest.replace(tzinfo=timezone.utc)


def sync_account(account, progress=None, cancelled=None, client=None):
    """Import one account's games: everything the first time, afterwards only
    what is new (it used to download the whole history again on every sync,
    every 30 minutes). Returns {imported, seen, warnings}."""
    platform = account["platform"]
    try:
        since = _newest_imported(account)
        if platform == "chesscom":
            result = import_chesscom(
                account["username"], account["id"], progress, cancelled, client, since,
            )
        elif platform == "lichess":
            result = import_lichess(
                account["username"], account["id"], progress, cancelled, client, since,
            )
        else:
            raise ImportError_(f"unknown platform “{platform}”")
    except ImportError_:
        raise
    except httpx.HTTPError as exc:
        raise ImportError_(f"{platform} could not be reached — try again") from exc
    except ValueError as exc:
        raise ImportError_(f"{platform} returned an invalid response") from exc
    # An archive that could not be fetched must be asked for again next time.
    db.mark_account_synced(account["id"], complete=not result.get("warnings"))
    return result
