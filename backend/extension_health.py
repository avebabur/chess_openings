"""What the Lichess extension could and could not show, written to a file.

Lichess changes its pages often. When the extension cannot find the place a
feature goes, it leaves that feature out (nothing on the page breaks) and
reports it here. The report is a JSON file in the repository, so a person or an
agent can read exactly which feature is missing, on which kind of page, and
which selector stopped matching — see ``extension/REPAIR.md``.

The file keeps the latest report per kind of Lichess page (analysis board,
game in progress, other pages), because each kind only shows some features.
"""
import json
import os
import tempfile
from datetime import datetime, timezone

OPENINGS_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(OPENINGS_ROOT, "extension", "health-report.json")

PAGE_KINDS = ("analyse", "round", "puzzle", "other")
BROKEN_STATUSES = ("missing", "hidden", "error")
MAX_TEXT = 300


def report_path():
    return os.environ.get("OPENINGS_EXTENSION_HEALTH_PATH") or DEFAULT_PATH


def _text(value):
    return str(value or "")[:MAX_TEXT]


def _clean_feature(feature):
    return {
        "name": _text(feature.get("name")),
        "status": _text(feature.get("status")),
        "detail": _text(feature.get("detail")),
        "missing_anchors": [
            {"name": _text(a.get("name")), "selector": _text(a.get("selector"))}
            for a in (feature.get("missing_anchors") or [])[:10]
            if isinstance(a, dict)
        ],
    }


def load(path=None):
    try:
        with open(path or report_path(), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"updated_at": None, "pages": {}, "broken": []}


def merge(existing, report, now):
    """Fold one page's report into the file's contents."""
    pages = dict(existing.get("pages") or {})
    kind = report["page_kind"]
    pages[kind] = {
        "url": _text(report.get("url")),
        "checked_at": now,
        "extension_version": _text(report.get("extension_version")),
        "features": {
            _text(fid): _clean_feature(f)
            for fid, f in list((report.get("features") or {}).items())[:30]
            if isinstance(f, dict)
        },
    }
    broken = [
        {"page_kind": page, "feature": fid, **feature}
        for page, page_report in sorted(pages.items())
        for fid, feature in sorted(page_report["features"].items())
        if feature["status"] in BROKEN_STATUSES
    ]
    return {
        "updated_at": now,
        "summary": (
            f"{len(broken)} feature(s) not showing because Lichess's page changed"
            if broken else "Every feature found its place on Lichess."
        ),
        "how_to_fix": "Read extension/REPAIR.md",
        "broken": broken,
        "pages": pages,
    }


def record(report, path=None):
    """Merge ``report`` into the file and return the new contents."""
    if report.get("page_kind") not in PAGE_KINDS:
        raise ValueError("page_kind must be one of " + ", ".join(PAGE_KINDS))
    path = path or report_path()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    merged = merge(load(path), report, now)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)
    return merged
