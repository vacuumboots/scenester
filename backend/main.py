"""
Scenester — FastAPI backend.

Serves the frontend SPA and provides API routes for browsing Plex and
creating frame-accurate ffmpeg clips (VAAPI-accelerated).
"""

import asyncio
import os
import re
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import plex


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Expire old cached frames/thumbnails on boot (see _prune_cache)."""
    removed = _prune_cache()
    if removed:
        print(f"scenester: pruned {removed} expired cache files", flush=True)
    yield


app = FastAPI(title="Scenester", lifespan=_lifespan)

# /api/library is ~490KB of JSON and the client fetches it on every page load.
# Over Tailscale (and especially on mobile) that is the single biggest transfer
# in the app, and it compresses to roughly a tenth. Text/JSON only — images and
# video are already compressed and would only burn CPU.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# ── Helpers ───────────────────────────────────────────────────────────────

# Explicit video MIME map. python:3.12-slim ships NO /etc/mime.types, so
# mimetypes.guess_type() returns None for .mkv/.m4v/.ts and the stream
# endpoint used to fall back to video/mp4. Browsers demux by content-type:
# an mkv served as video/mp4 runs the MP4 parser on Matroska bytes, never
# finds a moov atom, and the <video> element stalls at readyState 0
# forever (endless retry — looks like "the player won't load at all").
_VIDEO_MIME = {
    ".mp4":  "video/mp4",
    ".m4v":  "video/mp4",
    ".mkv":  "video/x-matroska",
    ".webm": "video/webm",
    ".avi":  "video/x-msvideo",
    ".mov":  "video/quicktime",
    ".ts":   "video/mp2t",
    ".m2ts": "video/mp2t",
    ".wmv":  "video/x-ms-wmv",
    ".flv":  "video/x-flv",
    ".ogv":  "video/ogg",
    ".mpeg": "video/mpeg",
    ".mpg":  "video/mpeg",
}


def _video_mime(path: str) -> str:
    """Browser media type for a video file (never None, never wrong).

    Do NOT use mimetypes.guess_type here — it returns None for mkv/m4v/ts
    on the slim base image, and the wrong content-type makes browsers pick
    the wrong demuxer (mkv-as-mp4 = infinite stall).
    """
    ext = os.path.splitext(path)[1].lower()
    return _VIDEO_MIME.get(ext, "video/mp4")

def _slugify(text: str) -> str:
    """Convert a title to a filename-safe slug: letters, digits, underscores."""
    # Replace non-alphanumeric (except spaces/hyphens) with nothing
    s = re.sub(r"[^a-zA-Z0-9 _-]", "", text)
    # Replace spaces and hyphens with underscores, collapse multiples
    s = re.sub(r"[ _-]+", "_", s).strip("_")
    return s or "unknown"

def _clip_variant(
    captions: bool, vertical: bool, words_per_chunk: int,
    caption_color: str, caption_position: str,
) -> str:
    """Filename suffix describing the render options, or "" for the plain clip.

    The clip cache is keyed on the filename, so the filename MUST change when
    anything that alters the pixels changes — otherwise toggling "Burn
    subtitles" after a captionless export of the same range returns the old
    file in the `ready` path and the captions silently never appear.

    Plain clip (no captions, no crop) keeps the historical name so existing
    clips and their filenames stay valid.
    """
    parts: list[str] = []
    if vertical:
        parts.append("v")
    if captions:
        parts.append(f"cap{words_per_chunk}")
        if caption_position != "bottom":
            parts.append(caption_position)
        if caption_color != "white":
            parts.append(caption_color)
    return "-" + "-".join(parts) if parts else ""


def _clip_basename(
    meta: dict, start_sec: float, end_sec: float, variant: str = "",
) -> str:
    """Build a human-friendly clip filename without extension.

    Sub-second precision is kept to one decimal so distinct clips never
    collide (same-integer-second ranges produce different filenames).
    `variant` carries the render options (captions/crop) — see _clip_variant.

    Movies:    Movie_Title_5307.2-5337.4
    Episodes:  Show_Title_S01E03_5307.2-5337.4
    """
    title = _slugify(meta.get("title", "Unknown"))
    if meta.get("type") == "episode":
        show = _slugify(meta.get("show_title", ""))
        s = str(meta.get("season", 0)).zfill(2)
        e = str(meta.get("episode", 0)).zfill(2)
        prefix = f"{show}_{title}_S{s}E{e}" if show else f"{title}_S{s}E{e}"
    else:
        prefix = title
    start = f"{start_sec:.1f}"
    end = f"{end_sec:.1f}"
    return f"{prefix}_{start}-{end}{variant}"

# ── Subtitle utilities ────────────────────────────────────────────────────

_SRT_RE = re.compile(
    r"(\d+)\s*\n"                      # index
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*"   # start timestamp
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*\n"       # end timestamp
    r"((?:.+\n?)+?)(?=\n\n|\n*$)",                    # text (one or more lines)
    re.MULTILINE,
)

_STRIP_HTML = re.compile(r"<[^>]+>")


def _srt_timestamp(h: str, m: str, s: str, ms: str) -> float:
    """Convert SRT timestamp components to seconds."""
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def _fmt_srt_timestamp(total_sec: float) -> str:
    """Format seconds as an SRT timestamp: HH:MM:SS,mmm."""
    h = int(total_sec // 3600)
    m = int((total_sec % 3600) // 60)
    s = int(total_sec % 60)
    ms = int((total_sec % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(srt_path: str) -> list[dict]:
    """Parse an .srt file into a list of {start, end, text} dicts.

    start/end are in seconds. Blank lines and HTML tags are stripped.
    """
    try:
        content = Path(srt_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        try:
            content = Path(srt_path).read_text(encoding="latin-1")
        except OSError:
            return []

    entries: list[dict] = []
    for match in _SRT_RE.finditer(content):
        start = _srt_timestamp(match.group(2), match.group(3), match.group(4), match.group(5))
        end = _srt_timestamp(match.group(6), match.group(7), match.group(8), match.group(9))
        text = match.group(10).strip()
        # Strip HTML tags, collapse whitespace
        text = _STRIP_HTML.sub("", text)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            entries.append({"start": start, "end": end, "text": text})
    return entries


def chunk_srt_for_social(srt_entries: list[dict], words_per_chunk: int = 3) -> str:
    """Convert parsed SRT entries into a new SRT with word-chunked timing.

    Each subtitle entry is split into groups of `words_per_chunk` words.
    The entry's time span is distributed evenly across the word groups,
    creating a dynamic word-by-word caption effect when burned in.
    """
    chunks: list[dict] = []
    for entry in srt_entries:
        words = entry["text"].split()
        if not words:
            continue

        total_words = len(words)
        duration = entry["end"] - entry["start"]

        for i in range(0, total_words, words_per_chunk):
            group = words[i : i + words_per_chunk]
            # Distribute time proportionally
            frac_start = i / total_words
            frac_end = min((i + len(group)) / total_words, 1.0)
            chunk_start = entry["start"] + frac_start * duration
            chunk_end = entry["start"] + frac_end * duration

            # Ensure minimum display time of 0.4s per chunk for readability
            if chunk_end - chunk_start < 0.4:
                chunk_end = chunk_start + 0.4
                if chunk_end > entry["end"]:
                    chunk_end = entry["end"]
                    chunk_start = max(entry["start"], chunk_end - 0.4)

            chunks.append({
                "start": chunk_start,
                "end": chunk_end,
                "text": " ".join(group).upper(),  # uppercase for impact
            })

    # Sort by start time (some chunks may overlap slightly)
    chunks.sort(key=lambda c: c["start"])

    # Build new SRT
    lines: list[str] = []
    for idx, c in enumerate(chunks, 1):
        lines.append(str(idx))
        lines.append(
            f"{_fmt_srt_timestamp(c['start'])} --> {_fmt_srt_timestamp(c['end'])}"
        )
        lines.append(c["text"])
        lines.append("")  # blank line separator

    return "\n".join(lines)


# ── Paths ────────────────────────────────────────────────────────────────

def _resolve_static_dir() -> Path:
    """Locate the frontend assets.

    In the Docker image main.py is copied to /app alongside a static/
    directory, so the default `backend/static` (== /app/static) already works.
    For local development from a source checkout there is no backend/static —
    fall back to the repo-layout `frontend/` directory so `uvicorn main:app`
    run from backend/ serves the SPA with no build step. A CLIPARR_STATIC_DIR
    env var overrides both.
    """
    env = os.environ.get("CLIPARR_STATIC_DIR")
    if env:
        return Path(env)
    default = Path(__file__).parent / "static"
    if (default / "index.html").exists():
        return default
    return Path(__file__).parent.parent / "frontend"


STATIC_DIR = _resolve_static_dir()
CLIPS_DIR = Path("/tmp/clips")
CLIPS_DIR.mkdir(parents=True, exist_ok=True)

# ── Derived-artifact cache ────────────────────────────────────────────────
# Frames and thumbnails are the hot path: every scrub/scroll used to re-seek
# the source file on a spinning disk and re-download a full-size poster. Both
# are deterministic for a given (media, timestamp) / media, so cache them on
# disk under /data (a bind mount — survives container recreation, unlike /tmp).
CACHE_DIR = Path(os.environ.get("CLIPARR_CACHE_DIR", "/data/cache"))


def _pick_cache_root(preferred: Path) -> Path:
    """Return a usable cache root, creating it if needed.

    Importing this module must never fail for want of /data: the container bind
    mounts it, but a dev checkout and the test suite do not have it. Fall back to
    a temp directory (and, if even that fails, to the preferred path — writes are
    best-effort everywhere, so a missing directory just means nothing is cached).
    """
    candidates = [preferred]
    if "CLIPARR_CACHE_DIR" not in os.environ:
        candidates.append(Path(tempfile.gettempdir()) / "scenester-cache")
    for candidate in candidates:
        try:
            (candidate / "frames").mkdir(parents=True, exist_ok=True)
            (candidate / "thumbs").mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            continue
    return preferred


CACHE_ROOT = _pick_cache_root(CACHE_DIR)
FRAME_CACHE_DIR = CACHE_ROOT / "frames"
THUMB_CACHE_DIR = CACHE_ROOT / "thumbs"

# Frame extraction is the single most expensive thing the app does per unit of
# output (fresh ffmpeg process + seek into a multi-GB file). Unbounded parallel
# requests turned one film-strip build into a load-8.6 spike on a 4-core box,
# starving the encoder and the UI. Cap it; queueing beats thrashing.
FRAME_CONCURRENCY = max(1, int(os.environ.get("CLIPARR_FRAME_CONCURRENCY", "2")))
_FRAME_SEM = asyncio.Semaphore(FRAME_CONCURRENCY)
FRAME_WIDTH = int(os.environ.get("CLIPARR_FRAME_WIDTH", "640"))
THUMB_WIDTH = int(os.environ.get("CLIPARR_THUMB_WIDTH", "320"))

# In-process TTL caches. Plex metadata is effectively immutable for a title
# that is already on disk, and the library list only changes when the *arr
# stack imports something, so a short TTL costs nothing and saves a Plex
# roundtrip on every frame, thumb and clip request.
META_TTL = float(os.environ.get("CLIPARR_META_TTL", "300"))
LIBRARY_TTL = float(os.environ.get("CLIPARR_LIBRARY_TTL", "60"))

_meta_cache: dict[int, tuple[float, dict]] = {}
_library_cache: dict = {"items": None, "ts": 0.0}
_library_refreshing = {"task": None}


async def _metadata(media_id: int) -> dict:
    """plex.get_metadata with a TTL cache. Raises ValueError if unknown."""
    hit = _meta_cache.get(media_id)
    now = time.time()
    if hit and now - hit[0] < META_TTL:
        return hit[1]
    meta = await plex.get_metadata(media_id)
    _meta_cache[media_id] = (now, meta)
    # Bound the dict so a long browse session cannot grow it without limit.
    if len(_meta_cache) > 4096:
        for mid, _ in sorted(_meta_cache.items(), key=lambda kv: kv[1][0])[:1024]:
            _meta_cache.pop(mid, None)
    return meta


def _cache_path(directory: Path, key: str) -> Path:
    """Filesystem-safe cache path (keys are numeric, but ids can be tuples)."""
    return directory / (re.sub(r"[^0-9A-Za-z_.-]", "_", key))


async def _resize_image(raw: bytes, width: int) -> bytes:
    """Downscale a JPEG/PNG to `width` px (no upscaling). Pillow if present,
    ffmpeg otherwise — never raises, returns the original on any failure."""
    try:
        import io

        from PIL import Image

        def _do() -> bytes:
            with Image.open(io.BytesIO(raw)) as im:
                im = im.convert("RGB")
                if im.width > width:
                    h = max(1, round(im.height * width / im.width))
                    im = im.resize((width, h), Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=82, optimize=True)
                return buf.getvalue()

        out = await asyncio.to_thread(_do)
        return out if out else raw
    except Exception:
        return raw


CACHE_MAX_AGE = float(os.environ.get("CLIPARR_CACHE_MAX_AGE_DAYS", "14")) * 86400


def _prune_cache(max_age: float = CACHE_MAX_AGE) -> int:
    """Drop cached frames/thumbs older than max_age. Returns files removed.

    Frames are keyed by media + timestamp, so a long browsing habit grows the
    directory without bound. Nothing is lost by expiring them: a stale frame is
    simply re-extracted on the next request.
    """
    cutoff = time.time() - max_age
    removed = 0
    for directory in (FRAME_CACHE_DIR, THUMB_CACHE_DIR):
        try:
            for f in directory.iterdir():
                try:
                    if f.is_file() and f.stat().st_mtime < cutoff:
                        f.unlink()
                        removed += 1
                except OSError:
                    continue
        except OSError:
            continue
    return removed


# ── Request models ───────────────────────────────────────────────────────

class ClipRequest(BaseModel):
    media_id: int
    start_sec: float
    end_sec: float
    captions: bool = False
    vertical: bool = False
    words_per_chunk: int = 3
    caption_color: str = "white"   # "white" or "yellow"
    caption_position: str = "bottom"  # "bottom" or "middle"
    format: str = "mp4"  # "mp4" or "gif"


# ── Static frontend ──────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


# PWA root-level files: service worker + manifest MUST be served from the
# app root (not /static/) so their scope covers the whole app at both the
# Caddy /cliparr/ URL and the direct :8096 URL.
@app.get("/sw.js")
async def service_worker():
    return FileResponse(STATIC_DIR / "sw.js")


@app.get("/manifest.json")
async def manifest():
    return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")


# Serve /static/... from frontend/static/
static_path = STATIC_DIR / "static"
if static_path.exists():
    app.mount("/static", StaticFiles(directory=str(static_path)), name="static")


# ── API: Auth ─────────────────────────────────────────────────────────────

@app.get("/api/auth/status")
async def auth_status():
    """Return whether we have a working Plex token."""
    return {"authenticated": plex.is_authenticated()}


@app.post("/api/auth/pin")
async def auth_create_pin():
    """Start the Plex OAuth PIN flow.

    Returns a code the user enters at https://plex.tv/link."""
    try:
        pin = await plex.create_pin()
        return pin
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex.tv error: {e}")


@app.get("/api/auth/pin/{pin_id}")
async def auth_check_pin(pin_id: int):
    """Check whether the user has approved the PIN at plex.tv/link."""
    try:
        result = await plex.check_pin(pin_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex.tv error: {e}")


@app.post("/api/auth/logout")
async def auth_logout():
    """Clear the stored Plex token."""
    plex.clear_token()
    return {"authenticated": False}


# ── API: Sessions ────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def sessions():
    """Return currently active Plex sessions."""
    try:
        return {"sessions": await plex.get_sessions()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")


# ── API: Library ─────────────────────────────────────────────────────────

@app.get("/api/library")
async def library():
    """Browse full library (movies + TV episodes).

    Cached: the list only changes when the *arr stack imports something, and
    rebuilding it means pulling every item out of Plex (~0.9s, ~490KB) on a
    request the client makes on every page load. Serve the cached copy
    immediately and refresh in the background once it goes stale.
    """
    now = time.time()
    cached = _library_cache.get("items")
    fresh = cached is not None and (now - _library_cache["ts"]) < LIBRARY_TTL

    if cached is not None and fresh:
        return {"items": cached}

    if cached is not None:
        # Stale: serve it now, refresh behind the client's back.
        task = _library_refreshing.get("task")
        if task is None or task.done():
            _library_refreshing["task"] = asyncio.create_task(_refresh_library())
        return {"items": cached}

    # Cold: must block once.
    try:
        items = await _refresh_library()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")
    return {"items": items}


async def _refresh_library() -> list[dict]:
    """Fetch the library from Plex and update the cache."""
    items = await plex.get_library_sections()
    _library_cache["items"] = items
    _library_cache["ts"] = time.time()
    return items


@app.get("/api/library/{media_id}")
async def library_item(media_id: int):
    """Get single item detail."""
    try:
        return await _metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")


# ── API: Thumbnails ──────────────────────────────────────────────────────

@app.get("/api/thumb/{media_id}")
async def thumb(media_id: int):
    """Proxy Plex thumbnail through the backend, downscaled and disk-cached.

    Plex hands back the source poster verbatim — often the full-resolution
    poster.jpg (sampled up to 1.4MB, avg ~375KB). A browse grid pulls dozens
    of these, so resize once to THUMB_WIDTH and serve the cached copy from
    then on.
    """
    dest = _cache_path(THUMB_CACHE_DIR, f"{media_id}.jpg")
    if dest.exists():
        return FileResponse(
            dest,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    try:
        meta = await _metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")

    thumb_path = meta.get("thumb") or ""
    if not thumb_path:
        raise HTTPException(status_code=404, detail=f"No thumbnail for media ID {media_id}")

    try:
        raw, _ctype = await plex.fetch_image(thumb_path)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")

    data = await _resize_image(raw, THUMB_WIDTH)
    try:
        dest.write_bytes(data)
    except OSError:
        pass  # cache is best-effort; still serve the bytes

    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"})


# ── API: Frame extraction ────────────────────────────────────────────────

@app.get("/api/frame/{media_id}")
async def get_frame(media_id: int, t: float = 0):
    """Extract a single JPEG frame at timestamp t (seconds) from the original media file.

    Frames are deterministic for a (media, timestamp) pair and were previously
    re-extracted on every request: a fresh Plex metadata call plus a fresh
    ffmpeg process seeking into a multi-GB file on a spinning disk. The strip
    alone asks for 8-16 of them, so cache to disk and cap concurrency.
    """
    cached = _cache_path(FRAME_CACHE_DIR, f"{media_id}_{t:.2f}.jpg")
    if cached.exists():
        return FileResponse(
            cached,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=3600"},
        )

    try:
        meta = await _metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")

    file_path = meta.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Media file not found on disk")

    # Fast-seek to timestamp, extract one frame as JPEG (scaled for preview)
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(t),
        "-i", file_path,
        "-vframes", "1",
        "-vf", f"scale={FRAME_WIDTH}:-1",
        "-q:v", "4",
        "-f", "image2pipe",
        "-",
    ]

    async with _FRAME_SEM:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()

    if proc.returncode != 0 or not stdout:
        raise HTTPException(status_code=500, detail="Frame extraction failed")

    try:
        cached.write_bytes(stdout)
    except OSError:
        pass  # cache is best-effort

    return Response(content=stdout, media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=3600"})


# ── API: Media streaming ──────────────────────────────────────────────────


@app.get("/api/media/{media_id}/stream")
async def stream_media(media_id: int):
    """Serve the original media file with range request support for
    HTML5 video seeking.

    The browser's native <video> element handles seeking via HTTP Range
    requests directly against the original file.
    """
    try:
        meta = await _metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    file_path = meta.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Media file not found on disk")

    # Determine MIME type from extension — explicit map, NOT
    # mimetypes.guess_type (returns None for mkv on slim images -> mkv
    # mislabeled as video/mp4 -> browser MP4 demuxer never finds moov ->
    # video element stalls forever).
    mime_type = _video_mime(file_path)

    return FileResponse(
        file_path,
        media_type=mime_type,
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
        },
    )


# ── API: Subtitles ──────────────────────────────────────────────────────


@app.get("/api/subtitle/lines/{media_id}")
async def subtitle_lines(media_id: int):
    """Return parsed subtitle lines as JSON for caption-line selection.

    Same .srt discovery as serve_subtitle, but as [{start, end, text}]
    with times in seconds, so the frontend can offer tap-to-mark clip
    selection around a spoken line.
    """
    try:
        meta = await _metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    subtitle_path = meta.get("subtitle_path")
    if not subtitle_path or not os.path.isfile(subtitle_path):
        return {"lines": []}
    return {"lines": parse_srt(subtitle_path)}


@app.get("/api/subtitle/{media_id}")
async def serve_subtitle(media_id: int):
    """Serve the subtitle file as WebVTT for browser <track> support.

    Reads the .srt file found alongside the media, converts timestamps
    from SRT (commas) to WebVTT (periods), and returns with
    Content-Type: text/vtt. Browsers render this natively via <track>.
    """
    try:
        meta = await _metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    subtitle_path = meta.get("subtitle_path")
    if not subtitle_path or not os.path.isfile(subtitle_path):
        raise HTTPException(status_code=404, detail="No subtitle file found")

    try:
        with open(subtitle_path, "r", encoding="utf-8", errors="replace") as f:
            srt_content = f.read()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Convert SRT to WebVTT: add header, replace comma with period in timestamps
    vtt = "WEBVTT\n\n"
    vtt += re.sub(
        r'(\d{2}:\d{2}:\d{2}),(\d{3})',
        r'\1.\2',
        srt_content
    )

    return Response(content=vtt, media_type="text/vtt")


# ── Quote search (subtitle lines across the whole library) ──────────────

_quote_index: list[dict] | None = None
_quote_index_ts: float = 0.0
_quote_index_lock = asyncio.Lock()
_QUOTE_INDEX_TTL_SECONDS = 3600
# Safety ceiling only: the real result set is unbounded (per-movie cap
# keeps it diverse), but a pathological query ("the", "a") must not ship
# a multi-MB response. The frontend shows a refine note when hit.
_QUOTE_MAX_MATCHES = 1000
_QUOTE_LINES_PER_MOVIE = 3


async def _build_quote_index() -> list[dict]:
    """Parse every movie's subtitle file once; the result is cached.

    Each entry: {media_id, title, year, lines} where lines is a list of
    (start, end, text) tuples (cheaper than dicts at ~1.2M lines).
    Movies without an SRT are skipped entirely.
    """
    items = await plex.get_library_sections()
    index: list[dict] = []
    for item in items:
        fp = item.get("file_path") or ""
        if not fp:
            continue
        sub_path = plex._find_subtitle_path(fp)
        if not sub_path:
            continue
        lines = parse_srt(sub_path)
        if not lines:
            continue
        index.append({
            "media_id": item["media_id"],
            "title": item["title"],
            "year": item.get("year") or "",
            "lines": [(l["start"], l["end"], l["text"]) for l in lines],
        })
    return index


async def _refresh_quote_index() -> None:
    """Rebuild the index if it is stale. Lock-guarded; on failure the
    previous index (or None) is kept so a transient Plex error never
    wipes a working index."""
    global _quote_index, _quote_index_ts
    async with _quote_index_lock:
        if _quote_index is not None and time.time() - _quote_index_ts < _QUOTE_INDEX_TTL_SECONDS:
            return
        try:
            idx = await _build_quote_index()
        except Exception:
            return
        _quote_index, _quote_index_ts = idx, time.time()


async def _get_quote_index() -> list[dict] | None:
    """Return the cached index; never block a search on a rebuild.

    A stale-but-present index is served immediately while the rebuild runs
    in the background. Only the very first search of a process (index is
    None) waits for the ~15s build. Returns None only if a cold build fails.
    """
    global _quote_index
    if _quote_index is not None and time.time() - _quote_index_ts < _QUOTE_INDEX_TTL_SECONDS:
        return _quote_index
    if _quote_index is not None:
        asyncio.create_task(_refresh_quote_index())
        return _quote_index
    await _refresh_quote_index()
    return _quote_index


def _quote_pattern(query: str) -> re.Pattern | None:
    """Compile a word-boundary-aware pattern for a quote query.
    The whole query is matched with word boundaries on either end (when it
    starts/ends with a word character): "cat" finds "the cat" but not
    "indications", and phrases keep their adjacency.
    """
    q = (query or "").strip()
    if not q:
        return None
    pat = re.escape(q)
    if q[0].isalnum() or q[0] == "_":
        pat = r"\b" + pat
    if q[-1].isalnum() or q[-1] == "_":
        pat = pat + r"\b"
    try:
        return re.compile(pat, re.IGNORECASE)
    except re.error:
        return None


def _search_quote_index(
    index: list[dict],
    query: str,
    cap: int = _QUOTE_MAX_MATCHES,
    per_movie: int = _QUOTE_LINES_PER_MOVIE,
) -> list[dict]:
    """Search a prebuilt quote index for a phrase.
    Word-boundary matching (see _quote_pattern), with at most `per_movie`
    hits per movie so the result set spans the library instead of one
    alphabetically-early title eating the whole cap.
    """
    rx = _quote_pattern(query)
    if rx is None:
        return []
    matches: list[dict] = []
    for movie in index:
        per = 0
        for start, end, text in movie["lines"]:
            if per >= per_movie:
                break
            if rx.search(text):
                matches.append({
                    "media_id": movie["media_id"],
                    "title": movie["title"],
                    "year": movie["year"],
                    "start": start,
                    "end": end,
                    "text": text,
                })
                per += 1
                if len(matches) >= cap:
                    return matches
    return matches


@app.get("/api/quotes")
async def search_quotes(q: str = ""):
    """Search subtitle lines across every movie in the library."""
    index = await _get_quote_index()
    if index is None:
        raise HTTPException(status_code=502, detail="Subtitle index unavailable")
    matches = _search_quote_index(index, q)
    return {
        "matches": matches,
        "truncated": len(matches) >= _QUOTE_MAX_MATCHES,
    }


# ── API: Clip generation ─────────────────────────────────────────────────

clip_jobs: dict[str, dict] = {}  # filename -> {progress, done, error}

_CLIP_JOB_RETENTION_SECONDS = 3600


def _prune_clip_jobs() -> None:
    """Drop completed clip_jobs entries older than the retention window.

    Keeps the in-memory dict bounded over a long-running server. Only removes
    jobs that are done; in-flight jobs are never touched. The status endpoint
    already tolerates missing keys, so a pruned entry simply reads as "not
    found" until the clip file is re-requested.
    """
    cutoff = time.time() - _CLIP_JOB_RETENTION_SECONDS
    stale = [
        name
        for name, job in clip_jobs.items()
        if job.get("done") and job.get("started_at", 0) < cutoff
    ]
    for name in stale:
        clip_jobs.pop(name, None)

# ── Hardware-accelerated clipping (VAAPI) ──────────────────────────────
# The host is a Haswell iGPU (i965 driver): H264/MPEG2/VC1 HW decode,
# H264 Main-profile HW encode. No HEVC/VP9/AV1 HW decode — those fall
# back to CPU decode + HW encode. Set CLIPARR_DISABLE_VAAPI=1 to force
# the legacy libx264 path (debugging / no /dev/dri in container).

VAAPI_DEVICE = "/dev/dri/renderD128"
_VAAPI_DECODE_OK = {"h264", "mpeg2video", "vc1", "vc1image"}
_VAAPI_ENCODE_QUALITY = "23"  # ICQ; ~matches libx264 crf 20 bitrate


def _vaapi_available() -> bool:
    """True if a VAAPI render node is present in the container."""
    if os.environ.get("CLIPARR_DISABLE_VAAPI") == "1":
        return False
    return os.path.exists(VAAPI_DEVICE)


def _probe_video_codec(path: str) -> str:
    """Return the source's primary video codec name via ffprobe."""
    try:
        import subprocess
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        )
        name = (out.stdout or "").strip().lower()
        return name
    except Exception:
        return ""


def _build_clip_cmd(
    file_path: str, start_sec: float, duration: float,
    output_path: str, vf: str, meta_args: list,
    use_vaapi: bool, hw_decode: bool, simple_scale: bool,
) -> list[str]:
    """Assemble the ffmpeg command for one clip.

    use_vaapi: encode with h264_vaapi (and decode on GPU when hw_decode).
    hw_decode: source codec can be decoded by the Haswell iGPU.
    simple_scale: vf is only the plain `scale=1920:-2` (no subtitles /
    vertical crop) — can run fully on GPU via scale_vaapi with zero
    download/upload round-trips (the fastest tier).
    """
    cmd: list[str] = ["ffmpeg"]

    if use_vaapi:
        # Always init the device + filter device explicitly so hwupload /
        # hwdownload work regardless of which tier is active.
        cmd += ["-init_hw_device", f"vaapi=va:{VAAPI_DEVICE}", "-filter_hw_device", "va"]
        if hw_decode and simple_scale:
            # Fastest tier: decode, scale and encode all stay on the GPU.
            cmd += ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"]
            vf_full = "scale_vaapi=1920:-2"
        elif hw_decode:
            # HW decode, drop to CPU for the filter chain, upload again.
            cmd += ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"]
            vf_full = f"hwdownload,format=yuv420p,{vf},format=nv12,hwupload"
        else:
            # CPU decode (HEVC/VP9/AV1 — no HW decode on Haswell), upload
            # frames for HW encode.
            vf_full = f"format=nv12,{vf},format=nv12,hwupload"
    else:
        vf_full = vf

    cmd += ["-y", "-v", "error", "-ss", str(start_sec), "-t", str(duration),
            "-i", file_path, "-vf", vf_full]

    if use_vaapi:
        cmd += ["-c:v", "h264_vaapi", "-global_quality", _VAAPI_ENCODE_QUALITY]
    else:
        cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "20"]

    cmd += ["-c:a", "aac", "-b:a", "128k",
            "-map", "0:v:0", "-map", "0:a:0"]
    # Do NOT copy the source's chapters: ffmpeg keeps their absolute
    # timestamps, so a 78s clip of a 2h40m film gets a chapter track ending
    # at ~1182s and players report the clip as ~19:42 long.
    cmd += ["-map_chapters", "-1"]
    cmd += ["-progress", "pipe:2"]
    cmd += meta_args
    cmd.append(str(output_path))
    return cmd


async def _clip_impl(
    filename: str,
    file_path: str,
    start_sec: float,
    duration: float,
    meta: dict | None = None,
    subtitle_path: str | None = None,
    vertical: bool = False,
    words_per_chunk: int = 3,
    caption_color: str = "white",
    caption_position: str = "bottom",
    fmt: str = "mp4",
):
    """Build and run the ffmpeg command for one clip, writing clip_jobs.

    Optionally embeds metadata, burns in word-chunked captions from an SRT
    file, and crops to vertical 9:16 for social media. Exceptions are NOT
    caged here — _run_ffmpeg_clip wraps this call.
    """
    output_path = CLIPS_DIR / filename

    tmp_srt: Path | None = None
    vf_chain: list[str] = []

    # ── Vertical 9:16 crop ──────────────────────────────────────────
    if vertical:
        # Crop center 9:16 portion, then scale to 1080x1920
        vf_chain.append("crop=ih*9/16:ih:(iw-ow)/2:0,scale=1080:1920")
    else:
        # Standard horizontal: scale width to 1920, keep aspect ratio
        vf_chain.append("scale=1920:-2")

    # ── Caption burning from SRT ────────────────────────────────────
    if subtitle_path and os.path.isfile(subtitle_path):
        entries = parse_srt(subtitle_path)
        if entries:
            # Filter to entries overlapping the clip range, offset to clip time
            clip_start = start_sec
            clip_end = start_sec + duration
            relevant: list[dict] = []
            for e in entries:
                if e["end"] <= clip_start or e["start"] >= clip_end:
                    continue
                # Clip and offset
                s = max(e["start"], clip_start) - clip_start
                e_end = min(e["end"], clip_end) - clip_start
                if e_end - s >= 0.1:
                    relevant.append({"start": s, "end": e_end, "text": e["text"]})

            if relevant:
                chunked = chunk_srt_for_social(relevant, words_per_chunk=words_per_chunk)
                tmp_srt = CLIPS_DIR / f".caption_{filename}.srt"
                tmp_srt.write_text(chunked, encoding="utf-8")

                # Bold, high-contrast style for social media
                primary = "&H00FFFFFF" if caption_color == "white" else "&H0000FFFF"
                if caption_position == "middle":
                    alignment = "5"       # middle-center
                    margin = ""
                else:
                    alignment = "2"       # bottom-center (default)
                    margin = "MarginV=60,"
                style = (
                    "FontName=Arial Bold,"
                    "FontSize=28,"
                    f"PrimaryColour={primary},"
                    "OutlineColour=&H00000000,"
                    "Outline=3,"
                    "Shadow=1,"
                    "BorderStyle=1,"
                    f"{margin}"
                    f"Alignment={alignment}"
                )
                vf_chain.append(f"subtitles={tmp_srt}:force_style='{style}'")

    vf = ",".join(vf_chain) if vf_chain else "scale=1920:-2"
    simple_scale = (vf == "scale=1920:-2")

    # Build metadata for MP4 embedding
    meta_args = []
    if meta:
        title = meta.get("title", "")
        if meta.get("type") == "episode" and meta.get("show_title"):
            meta_args.extend(["-metadata", f"title={meta['show_title']} - {title}"])
            meta_args.extend(["-metadata", f"show={meta['show_title']}"])
            meta_args.extend(["-metadata", f"season_number={meta.get('season', '')}"])
            meta_args.extend(["-metadata", f"episode_id={meta.get('episode', '')}"])
        elif title:
            meta_args.extend(["-metadata", f"title={title}"])
        if meta.get("year"):
            meta_args.extend(["-metadata", f"date={meta['year']}"])
        meta_args.extend(["-metadata", "comment=Clipped with Scenester"])

    # ── Encoder selection: VAAPI tiers with libx264 fallback ──────────
    # Tier 1 (fastest): HW decode + scale_vaapi + h264_vaapi — all on GPU.
    # Tier 2:           CPU decode (HEVC/VP9/AV1) + HW encode.
    # Tier 3 (fallback): libx264 — used when /dev/dri is absent OR a VAAPI
    #                    run fails (the clip must never silently break).
    use_vaapi = fmt != "gif" and _vaapi_available()
    hw_decode = False
    if use_vaapi:
        codec = _probe_video_codec(file_path)
        hw_decode = codec in _VAAPI_DECODE_OK

    async def _run_async(cmd: list[str]) -> int:
        """Execute ffmpeg, stream progress into clip_jobs, return rc."""
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stderr=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
        )
        time_pattern = re.compile(r"out_time_us=(\d+)")
        out_time_ms_pattern = re.compile(r"out_time_ms=(\d+)")
        last_progress = 0.0
        current = 0.0
        async for line in proc.stderr:
            decoded = line.decode("utf-8", errors="ignore")
            match = time_pattern.search(decoded)
            if match:
                current = int(match.group(1)) / 1_000_000
            else:
                match = out_time_ms_pattern.search(decoded)
                if match:
                    current = int(match.group(1)) / 1_000_000
            if match and duration > 0:
                pct = min(current / duration, 0.99)
                if pct > last_progress:
                    last_progress = pct
                    clip_jobs[filename]["progress"] = pct
        await proc.wait()
        return proc.returncode if proc.returncode is not None else 1

    if fmt == "gif":
        # ── GIF output: standalone palette pipeline, no VAAPI ─────────
        # Scale chain first (adapted for GIF), then subtitles, then
        # fps + palettegen/paletteuse.
        gif_scale = "scale=480:-2"
        if vertical:
            gif_scale = "crop=ih*9/16:ih:(iw-ow)/2:0,scale=480:-2"
        gif_chain = [gif_scale] + vf_chain[1:]
        gif_vf = ",".join(gif_chain) + ",fps=15,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
        gif_cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-ss", str(start_sec), "-t", str(duration),
            "-i", file_path,
            "-vf", gif_vf,
            "-loop", "0",
            "-map", "0:v:0",
            "-progress", "pipe:2",
            str(output_path),
        ]
        rc = await _run_async(gif_cmd)

        # Clean up temp SRT
        if tmp_srt and tmp_srt.exists():
            try:
                tmp_srt.unlink()
            except OSError:
                pass

        started = clip_jobs[filename].get("started_at", time.time())
        if rc == 0 and output_path.exists() and output_path.stat().st_size > 0:
            clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None, "started_at": started}
        else:
            clip_jobs[filename] = {"progress": 0.0, "done": True, "error": f"ffmpeg exited with code {rc}", "started_at": started}
        return

    cmd = _build_clip_cmd(
        file_path, start_sec, duration, str(output_path), vf, meta_args,
        use_vaapi=use_vaapi, hw_decode=hw_decode, simple_scale=simple_scale,
    )
    rc = await _run_async(cmd)

    # VAAPI failed (e.g. driver hiccup, odd resolution)? Retry with libx264.
    if rc != 0 and use_vaapi:
        cmd_fallback = _build_clip_cmd(
            file_path, start_sec, duration, str(output_path), vf, meta_args,
            use_vaapi=False, hw_decode=False, simple_scale=simple_scale,
        )
        rc = await _run_async(cmd_fallback)

    # Clean up temp SRT
    if tmp_srt and tmp_srt.exists():
        try:
            tmp_srt.unlink()
        except OSError:
            pass

    started = clip_jobs[filename].get("started_at", time.time())
    if rc == 0 and output_path.exists() and output_path.stat().st_size > 0:
        clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None, "started_at": started}
    else:
        clip_jobs[filename] = {"progress": 0.0, "done": True, "error": f"ffmpeg exited with code {rc}", "started_at": started}


async def _run_ffmpeg_clip(
    filename: str,
    file_path: str,
    start_sec: float,
    duration: float,
    meta: dict | None = None,
    subtitle_path: str | None = None,
    vertical: bool = False,
    words_per_chunk: int = 3,
    caption_color: str = "white",
    caption_position: str = "bottom",
    fmt: str = "mp4",
):
    """Run a clip and mark clip_jobs done on completion OR unexpected error.

    The try/except ensures a failed run (e.g. ffmpeg missing) marks the job
    done-with-error so the client's poll terminates instead of timing out.
    """
    clip_jobs[filename] = {"progress": 0.0, "done": False, "error": None, "started_at": time.time()}
    try:
        await _clip_impl(
            filename, file_path, start_sec, duration, meta, subtitle_path,
            vertical, words_per_chunk, caption_color, caption_position, fmt,
        )
    except Exception as e:
        clip_jobs[filename] = {"progress": 0.0, "done": True, "error": str(e), "started_at": time.time()}


@app.post("/api/clip")
async def create_clip(req: ClipRequest):
    """Start generating a frame-accurate clip via ffmpeg re-encode (async, poll status).

    Optional: captions (burn in word-chunked subtitles), vertical (9:16 crop).
    """
    duration = req.end_sec - req.start_sec
    if duration <= 0:
        raise HTTPException(status_code=400, detail="End must be after start")
    if req.format not in ("mp4", "gif"):
        raise HTTPException(status_code=400, detail="Invalid format")

    _prune_clip_jobs()

    try:
        meta = await _metadata(req.media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")

    file_path = meta.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Media file not found on disk")

    subtitle_path = None
    if req.captions:
        subtitle_path = meta.get("subtitle_path")
        if not subtitle_path or not os.path.isfile(subtitle_path):
            raise HTTPException(status_code=400, detail="No subtitle file found for this media")

    variant = _clip_variant(
        req.captions, req.vertical, req.words_per_chunk,
        req.caption_color, req.caption_position,
    )
    ext = "gif" if req.format == "gif" else "mp4"
    filename = f"{_clip_basename(meta, req.start_sec, req.end_sec, variant)}.{ext}"

    # Check if already running
    if filename in clip_jobs and not clip_jobs[filename].get("done"):
        return {"status": "generating", "filename": filename}

    # Check if already complete
    output_path = CLIPS_DIR / filename
    if output_path.exists():
        clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None, "started_at": time.time()}
        return {"status": "ready", "filename": filename}

    # Start generation in background
    asyncio.create_task(_run_ffmpeg_clip(
        filename, file_path, req.start_sec, duration, meta,
        subtitle_path=subtitle_path,
        vertical=req.vertical,
        words_per_chunk=req.words_per_chunk,
        caption_color=req.caption_color,
        caption_position=req.caption_position,
        fmt=req.format,
    ))
    return {"status": "started", "filename": filename, "duration": duration}


@app.get("/api/clip/status/{filename}")
async def clip_status(filename: str):
    """Poll clip generation progress."""
    job = clip_jobs.get(filename)
    if job is None:
        return {"progress": 0, "done": False, "error": None, "eta_seconds": None}

    eta = None
    progress = job["progress"]
    if progress > 0.01 and not job.get("done"):
        elapsed = time.time() - job.get("started_at", time.time())
        eta = int(elapsed / progress - elapsed)

    return {
        "progress": job["progress"],
        "done": job["done"],
        "error": job.get("error"),
        "eta_seconds": eta,
    }


# ── API: Download ────────────────────────────────────────────────────────

@app.get("/api/download/{filename}")
async def download(filename: str):
    """Serve a generated clip for download."""
    # Sanitize: prevent path traversal, only allow .mp4/.gif files
    if ".." in filename or "/" in filename or not (filename.endswith(".mp4") or filename.endswith(".gif")):
        raise HTTPException(status_code=400, detail="Invalid filename")
    file_path = CLIPS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    media_type = "image/gif" if filename.endswith(".gif") else "video/mp4"
    return FileResponse(
        file_path,
        media_type=media_type,
        filename=filename,
    )


# ── API: Clip listing ────────────────────────────────────────────────────

@app.get("/api/clips")
async def list_clips():
    """List all generated clips, newest first (skip zero-byte files from failed encodes)."""
    clips = []
    files = sorted(
        list(CLIPS_DIR.glob("*.mp4")) + list(CLIPS_DIR.glob("*.gif")),
        key=lambda p: p.stat().st_mtime, reverse=True,
    )
    for f in files:
        size = f.stat().st_size
        if size == 0:
            continue
        clips.append({
            "filename": f.name,
            "size": size,
            "created": f.stat().st_mtime,
        })
    return {"clips": clips}


# ── API: Delete clip ────────────────────────────────────────────────────

@app.delete("/api/clips/{filename}")
async def delete_clip(filename: str):
    """Delete a generated clip."""
    if ".." in filename or "/" in filename or not (filename.endswith(".mp4") or filename.endswith(".gif")):
        raise HTTPException(status_code=400, detail="Invalid filename")
    file_path = CLIPS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    file_path.unlink()
    return {"deleted": filename}
