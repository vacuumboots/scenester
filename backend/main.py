"""
Cliparr — FastAPI backend.

Serves the frontend SPA and provides API routes for browsing Plex,
generating low-res proxy previews, and creating frame-accurate ffmpeg clips.
"""

import asyncio
import os
import re
import time
from pathlib import Path

import ffmpeg
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import plex

app = FastAPI(title="Cliparr")

# ── Paths ────────────────────────────────────────────────────────────────
STATIC_DIR = Path(__file__).parent / "static"
PROXY_DIR = Path("/tmp/proxy")
CLIPS_DIR = Path("/tmp/clips")
PROXY_DIR.mkdir(parents=True, exist_ok=True)
CLIPS_DIR.mkdir(parents=True, exist_ok=True)

# ── Proxy job tracking ───────────────────────────────────────────────────
proxy_jobs: dict[int, dict] = {}


async def _run_ffmpeg_proxy(media_id: int, file_path: str, total_duration_s: float, start_sec: float = 0):
    """Run ffmpeg to generate a low-res proxy, updating progress in proxy_jobs."""
    proxy_path = PROXY_DIR / f"{media_id}.mp4"
    if proxy_path.exists():
        proxy_jobs[media_id] = {"progress": 1.0, "done": True, "error": None}
        return

    proxy_jobs[media_id] = {"progress": 0.0, "done": False, "error": None, "started_at": time.time()}

    stream = (
        ffmpeg
        .input(file_path, ss=start_sec, t=total_duration_s)
        .output(
            str(proxy_path),
            vf="scale=640:-1,fps=12",
            vcodec="libx264",
            preset="ultrafast",
            crf=30,
            an=None,
        )
        .global_args("-progress", "pipe:2")
        .compile()
    )

    proc = await asyncio.create_subprocess_exec(
        *stream,
        stderr=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
    )

    time_pattern = re.compile(r"out_time_us=(\d+)")
    out_time_ms_pattern = re.compile(r"out_time_ms=(\d+)")
    last_progress = 0.0

    async for line in proc.stderr:
        decoded = line.decode("utf-8", errors="ignore")

        # Try out_time_us first (microseconds), fall back to out_time_ms
        match = time_pattern.search(decoded)
        if match:
            current = int(match.group(1)) / 1_000_000
        else:
            match = out_time_ms_pattern.search(decoded)
            if match:
                current = int(match.group(1)) / 1_000_000

        if match and total_duration_s > 0:
            pct = min(current / total_duration_s, 0.99)
            if pct > last_progress:
                last_progress = pct
                proxy_jobs[media_id]["progress"] = pct

    await proc.wait()

    if proc.returncode == 0 and proxy_path.exists():
        proxy_jobs[media_id] = {"progress": 1.0, "done": True, "error": None}
    else:
        proxy_jobs[media_id] = {
            "progress": 0.0,
            "done": True,
            "error": f"ffmpeg exited with code {proc.returncode}",
        }


# ── Request models ───────────────────────────────────────────────────────

class ClipRequest(BaseModel):
    media_id: int
    start_sec: float
    end_sec: float


# ── Static frontend ──────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


# Serve /static/... from frontend/static/
static_path = STATIC_DIR / "static"
if static_path.exists():
    app.mount("/static", StaticFiles(directory=str(static_path)), name="static")


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


# ── API: Proxy generation ────────────────────────────────────────────────

@app.post("/api/proxy/{media_id}")
async def start_proxy(media_id: int, start_min: int = 0, force: bool = False):
    """Start generating a low-res proxy video.

    Args:
        media_id: Plex media ID
        start_min: Minutes into the movie to start the proxy (default 0)
        force: If true, regenerate even if proxy already exists
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

    duration_s = meta["duration"] / 1000

    # Cap proxy at 10 minutes — longer than that is impractical
    start_sec = start_min * 60
    proxy_duration_s = min(duration_s - start_sec, 600)
    if proxy_duration_s <= 0:
        raise HTTPException(status_code=400, detail="Start time exceeds movie duration")
    warning = None
    if duration_s > (start_sec + 600):
        remaining = (duration_s - start_sec) / 60
        warning = f"Preview limited to 10 minutes (of {remaining:.0f}min remaining). Use start offset to preview other sections."

    # Check if already exists (skip cache check when force=True)
    proxy_path = PROXY_DIR / f"{media_id}.mp4"
    if proxy_path.exists() and not force:
        proxy_jobs[media_id] = {"progress": 1.0, "done": True, "error": None}
        return {"status": "ready", "media_id": media_id}

    # Check if already running
    if media_id in proxy_jobs and not proxy_jobs[media_id].get("done"):
        return {"status": "generating", "media_id": media_id}

    # Start generation in background
    asyncio.create_task(_run_ffmpeg_proxy(media_id, file_path, proxy_duration_s, start_sec))
    result = {"status": "started", "media_id": media_id}
    if warning:
        result["warning"] = warning
    return result


@app.get("/api/proxy/{media_id}/status")
async def proxy_status(media_id: int):
    """Poll proxy generation progress."""
    job = proxy_jobs.get(media_id)
    if job is None:
        return {"progress": 0, "done": False, "error": None, "eta_seconds": None}

    eta = None
    progress = job["progress"]
    if progress > 0.01 and not job.get("done"):
        elapsed = time.time() - job.get("started_at", time.time())
        eta = int(elapsed / progress - elapsed)

    return {
        "progress": progress,
        "done": job["done"],
        "error": job.get("error"),
        "eta_seconds": eta,
    }


@app.get("/api/proxy/{media_id}/stream")
async def proxy_stream(media_id: int):
    """Serve the generated proxy MP4."""
    proxy_path = PROXY_DIR / f"{media_id}.mp4"
    if not proxy_path.exists():
        raise HTTPException(status_code=404, detail="Proxy not yet generated")
    return FileResponse(
        proxy_path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )


# ── API: Clip generation ─────────────────────────────────────────────────

clip_jobs: dict[str, dict] = {}  # filename -> {progress, done, error}


async def _run_ffmpeg_clip(filename: str, file_path: str, start_sec: float, duration: float):
    """Run ffmpeg to generate a clip, updating progress in clip_jobs."""
    output_path = CLIPS_DIR / filename
    clip_jobs[filename] = {"progress": 0.0, "done": False, "error": None, "started_at": time.time()}

    stream = (
        ffmpeg
        .input(file_path, ss=start_sec, t=duration)
        .output(
            str(output_path),
            vf="scale=1920:-2:force_original_aspect_ratio=decrease",
            vcodec="libx264",
            preset="fast",
            crf=20,
            acodec="aac",
            **{"b:a": "128k"},
        )
        .global_args("-progress", "pipe:2", "-map", "0:v:0", "-map", "0:a:0")
        .compile()
    )

    proc = await asyncio.create_subprocess_exec(
        *stream,
        stderr=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
    )

    time_pattern = re.compile(r"out_time_us=(\d+)")
    out_time_ms_pattern = re.compile(r"out_time_ms=(\d+)")
    last_progress = 0.0

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

    if proc.returncode == 0 and output_path.exists():
        clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None}
    else:
        clip_jobs[filename] = {"progress": 0.0, "done": True, "error": f"ffmpeg exited with code {proc.returncode}"}


@app.post("/api/clip")
async def create_clip(req: ClipRequest):
    """Start generating a frame-accurate clip via ffmpeg re-encode (async, poll status)."""
    duration = req.end_sec - req.start_sec
    if duration <= 0:
        raise HTTPException(status_code=400, detail="End must be after start")
    if duration > 140:
        raise HTTPException(status_code=400, detail="Max clip length is 140 seconds")

    try:
        meta = await plex.get_metadata(req.media_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Plex error: {e}")

    file_path = meta.get("file_path", "")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Media file not found on disk")

    filename = f"clip_{req.media_id}_{int(req.start_sec)}-{int(req.end_sec)}.mp4"

    # Check if already running
    if filename in clip_jobs and not clip_jobs[filename].get("done"):
        return {"status": "generating", "filename": filename}

    # Check if already complete
    output_path = CLIPS_DIR / filename
    if output_path.exists():
        clip_jobs[filename] = {"progress": 1.0, "done": True, "error": None}
        return {"status": "ready", "filename": filename}

    # Start generation in background
    asyncio.create_task(_run_ffmpeg_clip(filename, file_path, req.start_sec, duration))
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
    # Sanitize: only allow filenames matching our pattern
    if not filename.startswith("clip_") or not filename.endswith(".mp4"):
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
    """List all generated clips, newest first."""
    clips = []
    for f in sorted(CLIPS_DIR.glob("clip_*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True):
        clips.append({
            "filename": f.name,
            "size": f.stat().st_size,
            "created": f.stat().st_mtime,
        })
    return {"clips": clips}


# ── API: Delete clip ────────────────────────────────────────────────────

@app.delete("/api/clips/{filename}")
async def delete_clip(filename: str):
    """Delete a generated clip."""
    if not filename.startswith("clip_") or not filename.endswith(".mp4"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    file_path = CLIPS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    file_path.unlink()
    return {"deleted": filename}
