"""
Cliparr — FastAPI backend.

Serves the frontend SPA and provides API routes for browsing Plex and
creating frame-accurate ffmpeg clips (VAAPI-accelerated).
"""

import asyncio
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import plex

app = FastAPI(title="Cliparr")

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

def _clip_basename(meta: dict, start_sec: float, end_sec: float) -> str:
    """Build a human-friendly clip filename without extension.

    Sub-second precision is kept to one decimal so distinct clips never
    collide (same-integer-second ranges produce different filenames).

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
    return f"{prefix}_{start}-{end}"

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
    """Browse full library (movies + TV episodes)."""
    try:
        items = await plex.get_library_sections()
        return {"items": items}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")


@app.get("/api/library/{media_id}")
async def library_item(media_id: int):
    """Get single item detail."""
    try:
        return await plex.get_metadata(media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")


# ── API: Thumbnails ──────────────────────────────────────────────────────

@app.get("/api/thumb/{media_id}")
async def thumb(media_id: int):
    """Proxy Plex thumbnail through the backend."""
    try:
        image_bytes, content_type = await plex.get_thumb_url(media_id)
        return StreamingResponse(
            iter([image_bytes]),
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")


# ── API: Frame extraction ────────────────────────────────────────────────

@app.get("/api/frame/{media_id}")
async def get_frame(media_id: int, t: float = 0):
    """Extract a single JPEG frame at timestamp t (seconds) from the original media file.

    Uses fast seeking (-ss before -i) for sub-second response on local files.
    """
    try:
        meta = await plex.get_metadata(media_id)
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
        "-vf", "scale=1280:-1",
        "-q:v", "4",
        "-f", "image2pipe",
        "-",
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()

    if proc.returncode != 0 or not stdout:
        raise HTTPException(status_code=500, detail="Frame extraction failed")

    return StreamingResponse(
        iter([stdout]),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── API: Media streaming ──────────────────────────────────────────────────


@app.get("/api/media/{media_id}/stream")
async def stream_media(media_id: int):
    """Serve the original media file with range request support for
    HTML5 video seeking.

    The browser's native <video> element handles seeking via HTTP Range
    requests directly against the original file.
    """
    try:
        meta = await plex.get_metadata(media_id)
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


@app.get("/api/subtitle/{media_id}")
async def serve_subtitle(media_id: int):
    """Serve the subtitle file as WebVTT for browser <track> support.

    Reads the .srt file found alongside the media, converts timestamps
    from SRT (commas) to WebVTT (periods), and returns with
    Content-Type: text/vtt. Browsers render this natively via <track>.
    """
    try:
        meta = await plex.get_metadata(media_id)
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

# ── API: Clip generation ─────────────────────────────────────────────────

clip_jobs: dict[str, dict] = {}  # filename -> {progress, done, error}

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
    cmd += ["-progress", "pipe:2"]
    cmd += meta_args
    cmd.append(str(output_path))
    return cmd


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
):
    """Run ffmpeg to generate a clip, updating progress in clip_jobs.

    Optionally embeds metadata, burns in word-chunked captions from an SRT
    file, and crops to vertical 9:16 for social media.
    """
    output_path = CLIPS_DIR / filename
    clip_jobs[filename] = {"progress": 0.0, "done": False, "error": None, "started_at": time.time()}

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
        meta_args.extend(["-metadata", "comment=Clipped with Cliparr"])

    # ── Encoder selection: VAAPI tiers with libx264 fallback ──────────
    # Tier 1 (fastest): HW decode + scale_vaapi + h264_vaapi — all on GPU.
    # Tier 2:           CPU decode (HEVC/VP9/AV1) + HW encode.
    # Tier 3 (fallback): libx264 — used when /dev/dri is absent OR a VAAPI
    #                    run fails (the clip must never silently break).
    use_vaapi = _vaapi_available()
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

    if rc == 0 and output_path.exists() and output_path.stat().st_size > 0:
        clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None}
    else:
        clip_jobs[filename] = {"progress": 0.0, "done": True, "error": f"ffmpeg exited with code {rc}"}


@app.post("/api/clip")
async def create_clip(req: ClipRequest):
    """Start generating a frame-accurate clip via ffmpeg re-encode (async, poll status).

    Optional: captions (burn in word-chunked subtitles), vertical (9:16 crop).
    """
    duration = req.end_sec - req.start_sec
    if duration <= 0:
        raise HTTPException(status_code=400, detail="End must be after start")

    try:
        meta = await plex.get_metadata(req.media_id)
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

    filename = f"{_clip_basename(meta, req.start_sec, req.end_sec)}.mp4"

    # Check if already running
    if filename in clip_jobs and not clip_jobs[filename].get("done"):
        return {"status": "generating", "filename": filename}

    # Check if already complete
    output_path = CLIPS_DIR / filename
    if output_path.exists():
        clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None}
        return {"status": "ready", "filename": filename}

    # Start generation in background
    asyncio.create_task(_run_ffmpeg_clip(
        filename, file_path, req.start_sec, duration, meta,
        subtitle_path=subtitle_path,
        vertical=req.vertical,
        words_per_chunk=req.words_per_chunk,
        caption_color=req.caption_color,
        caption_position=req.caption_position,
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
    # Sanitize: prevent path traversal, only allow .mp4 files
    if ".." in filename or "/" in filename or not filename.endswith(".mp4"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    file_path = CLIPS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=filename,
    )


# ── API: Clip listing ────────────────────────────────────────────────────

@app.get("/api/clips")
async def list_clips():
    """List all generated clips, newest first (skip zero-byte files from failed encodes)."""
    clips = []
    for f in sorted(CLIPS_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True):
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
    if ".." in filename or "/" in filename or not filename.endswith(".mp4"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    file_path = CLIPS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    file_path.unlink()
    return {"deleted": filename}
