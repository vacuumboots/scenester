# Cliparr

Plex clip maker. Browse your library, scrub through video with a live preview, select a range, and download clips — no transcoding proxy, no complexity.

## Features

- **Video-first preview** — direct media streaming with instant seeking, no proxy generation
- **Frame strip (click-only)** — click to set start, shift+click to set end; tap/long-press on mobile. Not a scrubber — the video + range bar scrub.
- **Mobile mark-from-playhead editor** — native video controls as the scrubber, huge Set Start/Set End buttons, unset buttons, 8-step nudge rows, presets, loop preview. Fat-thumb accessible.
- **Range bar with lock mode** — draggable handles, duration presets (5s–139s), range slides as a unit when locked
- **Looped clip preview** — separate Clip/Full play buttons, clip playback loops within the selected range
- **Plex OAuth login** — no token management needed, or use `PLEX_TOKEN` env var
- **Human-readable filenames** — `Inception_5307-5337.mp4` instead of `clip_7795_5307-5337.mp4`
- **1080p h264 clips** with embedded metadata, progress bar, auto-download
- **Clip gallery** — playback and delete generated clips
- **Now-playing banner** with Quick Clip for paused sessions
- **Dark theme** — immich-inspired design system

## Setup

### Prerequisites

- Docker
- Plex server (local network)
- Media files accessible as a Docker volume

### 1. Clone

```bash
git clone <repo-url> ~/Git/cliparr
cd ~/Git/cliparr
```

### 2. Configure

Copy and edit the env file:

```bash
cp .env.example .env
```

Edit `.env`:
```
PLEX_URL=http://host.docker.internal:32400
# PLEX_TOKEN=...   (optional — OAuth login is preferred)
```

### 3. Build and run

```bash
docker build -t cliparr .
docker run -d --name cliparr \
  --add-host=host.docker.internal:host-gateway \
  -p 8096:8096 \
  -v /path/to/your/media:/media:ro \
  -v /path/to/clips:/tmp/clips \
  -v /path/to/data:/data \
  --env-file .env \
  --restart unless-stopped \
  cliparr
```

**Critical on Linux:** `--add-host=host.docker.internal:host-gateway` is required.

### 4. Reverse proxy (optional)

Caddy example:
```
handle_path /cliparr/* {
    reverse_proxy localhost:8096
}
```

## Usage

1. Open the app — log in with Plex OAuth (or use a pre-set token)
2. Browse or search your library
3. Click a title to open the detail view
4. Use the frame strip to set start (click) and end (shift+click), or drag handles on the range bar
5. Click a duration preset to lock the range, or use Free mode for independent handles
6. Click **▶ Clip** to preview the looped selection, or **▶ Full** to play the whole movie
7. Click **⬇ Download Clip** to generate and download

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| ← → | Nudge start ±1s |
| Shift + ← → | Nudge start ±10s |
| Alt + ← → | Nudge end ±1s |
| Shift + Alt + ← → | Nudge end ±10s |
| Enter | Download clip |
| Escape | Back to library |

## Tech Stack

- **Backend:** Python, FastAPI, ffmpeg-python, httpx
- **Frontend:** Vanilla JS, HTML, CSS — no frameworks, no build step
- **Container:** Docker, two-stage build (alpine → python:3.12-slim)
- **Reverse proxy:** Caddy (Tailscale-friendly)
