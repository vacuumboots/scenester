"""
Plex API client for Cliparr.

Talks to the Plex server to fetch library metadata, active sessions,
thumbnails, and media file paths. Paths are translated from Plex's
internal `/data/media` prefix to the `/media` bind mount inside the container.
"""

import os
from typing import Optional
from urllib.parse import urljoin

import httpx

PLEX_URL = os.getenv("PLEX_URL", "http://host.docker.internal:32400")
PLEX_TOKEN = os.getenv("PLEX_TOKEN", "")

HEADERS = {
    "Accept": "application/json",
    "X-Plex-Token": PLEX_TOKEN,
}

_client: Optional[httpx.AsyncClient] = None


def get_client() -> httpx.AsyncClient:
    """Return a shared async HTTP client (lazy init)."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=30)
    return _client


def _translate_path(mc: dict) -> str:
    """Convert Plex internal path to container bind-mount path.

    Plex stores media at /data/media/movies/Film.mkv inside
    Media[0].Part[0].file, but the container sees /media/movies/Film.mkv
    via the bind mount.
    """
    for media in mc.get("Media", []):
        for part in media.get("Part", []):
            fp = part.get("file", "")
            if fp:
                return fp.replace("/data/media", "/media", 1)
    return ""


async def _get(path: str) -> dict:
    """GET a Plex API endpoint, return parsed JSON."""
    client = get_client()
    url = urljoin(PLEX_URL, path)
    resp = await client.get(url, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


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
    resp = await client.get(url, headers=HEADERS)
    resp.raise_for_status()
    return resp.content, resp.headers.get("content-type", "image/jpeg")
