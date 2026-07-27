"""
Plex API client for Cliparr.

Talks to the Plex server to fetch library metadata, active sessions,
thumbnails, and media file paths. Paths are translated from Plex's
internal `/data/media` prefix to the `/media` bind mount inside the container.

Supports OAuth login via plex.tv/pin flow — the user
enters a code at https://plex.tv/link. The resulting token is persisted to
/data/plex_token.json so it survives container restarts.
"""

import json
import os
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import httpx

PLEX_URL = os.getenv("PLEX_URL", "http://host.docker.internal:32400")
PLEX_TV = "https://plex.tv"

# Token persistence
TOKEN_FILE = Path(os.getenv("CLIPARR_DATA_DIR", "/data")) / "plex_token.json"
CLIENT_ID_FILE = Path(os.getenv("CLIPARR_DATA_DIR", "/data")) / "client_id.json"

_token: Optional[str] = None
_client_id: Optional[str] = None
_client: Optional[httpx.AsyncClient] = None


# ── Token management ──────────────────────────────────────────────────────

def _load_token() -> Optional[str]:
    """Try to load a persisted token from disk."""
    try:
        if TOKEN_FILE.exists():
            data = json.loads(TOKEN_FILE.read_text())
            return data.get("token")
    except Exception:
        pass
    return None


def get_token() -> str:
    """Return the current Plex token, trying: memory → file → env var."""
    global _token
    if _token:
        return _token
    _token = _load_token()
    if _token:
        return _token
    return os.getenv("PLEX_TOKEN", "")


def set_token(t: str) -> None:
    """Save a token to memory and persist to disk."""
    global _token
    _token = t
    try:
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(json.dumps({"token": t}))
    except Exception:
        pass  # Non-fatal — still have it in memory


def clear_token() -> None:
    """Remove the token from memory and disk."""
    global _token
    _token = None
    try:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
    except Exception:
        pass


def is_authenticated() -> bool:
    """Check whether we have a usable token."""
    return bool(get_token())


# ── Client identifier ─────────────────────────────────────────────────────

def _load_client_id() -> str:
    """Load or generate a persistent client identifier for plex.tv."""
    global _client_id
    if _client_id:
        return _client_id
    try:
        if CLIENT_ID_FILE.exists():
            data = json.loads(CLIENT_ID_FILE.read_text())
            _client_id = data.get("client_id")
            if _client_id:
                return _client_id
    except Exception:
        pass
    # Generate a new one
    _client_id = str(uuid.uuid4())
    try:
        CLIENT_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
        CLIENT_ID_FILE.write_text(json.dumps({"client_id": _client_id}))
    except Exception:
        pass
    return _client_id


# ── HTTP ──────────────────────────────────────────────────────────────────

def _headers() -> dict:
    """Build request headers, using the current token."""
    token = get_token()
    h = {"Accept": "application/json"}
    if token:
        h["X-Plex-Token"] = token
    return h


def _plex_tv_headers() -> dict:
    """Headers for plex.tv OAuth endpoints (no auth token needed)."""
    return {
        "Accept": "application/json",
        "X-Plex-Client-Identifier": _load_client_id(),
        "X-Plex-Product": "Cliparr",
        "X-Plex-Version": "1.0",
    }


def get_client() -> httpx.AsyncClient:
    """Return a shared async HTTP client (lazy init)."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=30)
    return _client


async def _get(path: str) -> dict:
    """GET a Plex API endpoint, return parsed JSON."""
    client = get_client()
    url = urljoin(PLEX_URL, path)
    resp = await client.get(url, headers=_headers())
    resp.raise_for_status()
    return resp.json()


# ── OAuth: PIN flow ───────────────────────────────────────────────────────

async def create_pin() -> dict:
    """Create a Plex PIN for OAuth login.

    Returns dict with keys: id (int), code (str).
    The user enters this code at https://plex.tv/link."""
    client = get_client()
    resp = await client.post(
        f"{PLEX_TV}/api/v2/pins",
        headers=_plex_tv_headers(),
        data={"strong": "true"},
    )
    resp.raise_for_status()
    data = resp.json()
    return {"id": data["id"], "code": data["code"]}


async def check_pin(pin_id: int) -> dict:
    """Check the status of a Plex OAuth PIN.

    Returns dict with:
      status: "waiting" | "done" | "error"
      error:  str (only when status="error")
    """
    client = get_client()
    try:
        resp = await client.get(
            f"{PLEX_TV}/api/v2/pins/{pin_id}",
            headers=_plex_tv_headers(),
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return {"status": "error", "error": str(e)}

    auth_token = data.get("authToken")
    if auth_token:
        set_token(auth_token)
        return {"status": "done"}
    return {"status": "waiting"}


# ── Path translation ──────────────────────────────────────────────────────

def _translate_path(mc: dict) -> str:
    """Convert Plex internal path to container bind-mount path.

    Plex stores media at /data/media/movies/Film.mkv inside
    Media[0].Part[0].file, but the container sees /media/movies/Film.mkv
    via the bind mount.

    When multiple versions exist (e.g. 4K + 1080p), prefers 1080p
    (height <= 1080) to produce clips at a manageable resolution.
    """
    candidates: list[tuple[str, int]] = []  # (path, height)
    for media in mc.get("Media", []):
        height = media.get("height", 0)
        for part in media.get("Part", []):
            fp = part.get("file", "")
            if fp:
                candidates.append((fp, height))
    if not candidates:
        return ""

    # Prefer 1080p or lower; pick smallest height that's >= 720
    for fp, h in candidates:
        if 720 <= h <= 1080:
            return fp.replace("/data/media", "/media", 1)
    # Fall back to any height (e.g. 4K-only content)
    return candidates[0][0].replace("/data/media", "/media", 1)


# ── Plex API ──────────────────────────────────────────────────────────────

async def get_sessions() -> list[dict]:
    """Return currently active Plex sessions.

    Returns a list of dicts with keys:
      title, viewOffset (seconds), duration (ms), media_id, type, state
    """
    data = await _get("/status/sessions")
    sessions = []
    for mc in data.get("MediaContainer", {}).get("Metadata", []):
        sessions.append({
            "title": mc.get("title", "Unknown"),
            "viewOffset": mc.get("viewOffset", 0) // 1000,  # ms → seconds
            "duration": mc.get("duration", 0),             # ms
            "media_id": int(mc.get("ratingKey", 0)),
            "type": mc.get("type", "movie"),
            "state": mc.get("Player", {}).get("state", "unknown"),
        })
    return sessions


async def _get_section_items(section_id: int) -> list[dict]:
    """Fetch all items from a library section."""
    data = await _get(f"/library/sections/{section_id}/all")
    items = []
    for mc in data.get("MediaContainer", {}).get("Metadata", []):
        item = {
            "title": mc.get("title", "Unknown"),
            "year": mc.get("year"),
            "thumb": mc.get("thumb"),
            "media_id": int(mc.get("ratingKey", 0)),
            "type": mc.get("type", "movie"),
            "duration": mc.get("duration", 0),  # ms
        }
        if item["type"] == "episode":
            item["show_title"] = mc.get("grandparentTitle", "")
            item["season"] = mc.get("parentIndex", 0)
            item["episode"] = mc.get("index", 0)
        items.append(item)
    return items


async def get_library_sections() -> list[dict]:
    """Auto-detect movie and TV sections, return combined library items.

    Returns a flat list of all items from all movie + TV sections.
    Each item has a 'type' field: 'movie' or 'episode'.
    """
    data = await _get("/library/sections")
    sections = data.get("MediaContainer", {}).get("Directory", [])
    all_items = []
    for section in sections:
        stype = section.get("type", "")
        if stype in ("movie", "show"):
            items = await _get_section_items(int(section["key"]))
            all_items.extend(items)
    return all_items


async def get_metadata(media_id: int) -> dict:
    """Fetch full metadata for a single media item.

    Returns dict with: title, duration (ms), file_path, thumb, year,
    summary, type, and episode-specific fields (show_title, season, episode).
    """
    data = await _get(f"/library/metadata/{media_id}")
    mc = data.get("MediaContainer", {}).get("Metadata", [])
    if not mc:
        raise ValueError(f"Media ID {media_id} not found")
    mc = mc[0]

    item = {
        "title": mc.get("title", "Unknown"),
        "media_id": int(mc.get("ratingKey", 0)),
        "duration": mc.get("duration", 0),       # ms
        "file_path": _translate_path(mc),
        "thumb": mc.get("thumb"),
        "year": mc.get("year"),
        "summary": mc.get("summary", ""),
        "type": mc.get("type", "movie"),
    }
    if item["type"] == "episode":
        item["show_title"] = mc.get("grandparentTitle", "")
        item["season"] = mc.get("parentIndex", 0)
        item["episode"] = mc.get("index", 0)

    return item


async def get_thumb_url(media_id: int) -> tuple[bytes, str]:
    """Fetch a thumbnail image from Plex.

    Returns (image_bytes, content_type).
    """
    # First get metadata to find the thumb path
    data = await _get(f"/library/metadata/{media_id}")
    mc = data.get("MediaContainer", {}).get("Metadata", [])
    if not mc:
        raise ValueError(f"Media ID {media_id} not found")

    thumb = mc[0].get("thumb", "")
    if not thumb:
        raise ValueError(f"No thumbnail for media ID {media_id}")

    client = get_client()
    url = urljoin(PLEX_URL, thumb)
    resp = await client.get(url, headers=_headers())
    resp.raise_for_status()
    return resp.content, resp.headers.get("content-type", "image/jpeg")
