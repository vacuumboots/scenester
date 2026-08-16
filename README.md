# Scenester

## Proudly vibecoded with Deepseek 🐋

Scenester clips movies from your Plex library. Browse, scrub a live video preview,
mark a range with two buttons, and download frame-accurate 1080p clips.

<p align="center">
  <img src="screenshots/library-desktop.jpg" alt="Scenester movie library on desktop" width="62%">
  <img src="screenshots/editor-desktop.jpg" alt="Clip editor on desktop" width="36%">
</p>
<p align="center">
  <img src="screenshots/library-mobile.jpg" alt="Scenester movie library on mobile" width="180">
  <img src="screenshots/editor-mobile.jpg" alt="Clip editor on mobile" width="180">
</p>

## Features

- **Video-first preview** — direct media streaming with byte-range seeking; the
  native `<video>` controls are the only scrubber.
- **Mobile-friendly** — the full editing workflow works in portrait and
  landscape on phones, not just desktop.
- **Unified mark-from-playhead editor** — one selection model on desktop and
  mobile: play to a moment and tap **Set Start**, play on and tap **Set End**.
  Unset buttons free an edge to ride the playhead again.
- **Frame-precise nudging** — explicit Start/End rows of −30s −10s −5s −1f +1f
  +5s +10s +30s (1 frame ≈ 0.04s). Fat-thumb accessible.
- **Duration presets** — Free (default) plus 5s / 10s / 15s / 45s / 60s.
- **Looped clip preview** — 🔁 Loop auditions the selected range before download.
- **Opt-in film strip** — a navigation-only thumbnail strip (🗂 toggle): tap a
  frame to move the playhead. It never marks clip edges.
- **MP4 or GIF output** — pick the format in the editor; GIFs go through a
  palette-optimized ffmpeg pipeline for small, crisp loops.
- **Optional caption burning** — .srt files found alongside the media (e.g.
  `Movie.en.srt`) can be burned in as bold word-chunked captions, right from
  the editor.
- **Optional 9:16 vertical export** — center-cropped 1080×1920, framed for
  TikTok / Reels / Shorts.
- **Plex OAuth login** — PIN flow via plex.tv, or set `PLEX_TOKEN`.
- **Human-readable filenames** — `Inception_5307.2-5337.4.mp4` (one-decimal
  sub-second precision, so distinct clips never collide).
- **VAAPI-accelerated clips** — hardware encode/decode on Intel iGPUs with a
  transparent libx264 software fallback.
- **Clip gallery** — playback and delete generated clips.
- **Now-playing banner** — Quick Clip (30s) and Jump-to-clip for paused sessions.
- **Dark theme** — immich-inspired design system.

## Setup

*New to Docker? You don't need to understand it. Scenester ships as a
ready-made package — "pulling" just means downloading it, and the commands
below do everything else. You need three things: Docker installed, a Plex
server, and a folder on the same machine containing your media files.*

### 1. Get the app (one time)

```bash
docker pull ghcr.io/vacuumboots/scenester:latest
```

That's the whole app, downloaded. (Using Docker Compose in step 3? Skip
this — Compose downloads it automatically.)

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set your Plex server address:

```
PLEX_URL=http://host.docker.internal:32400
# PLEX_TOKEN=...   (optional — the in-app "Connect to Plex" login is easier)
```

### 3. Run (recommended: Docker Compose)

Save this as `compose.yaml` next to your `.env`. Change the three
`/path/to/...` lines to your real folders — the first one must be the
folder your Plex library lives in:

```yaml
services:
  scenester:
    image: ghcr.io/vacuumboots/scenester:latest
    container_name: scenester
    restart: unless-stopped
    ports:
      - "8096:8096"
    env_file: .env
    extra_hosts:
      - "host.docker.internal:host-gateway"   # required on Linux — just leave it
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128   # Intel GPU = much faster clips; delete if it errors
    volumes:
      - /path/to/your/media:/media:ro   # your movies (read-only)
      - /path/to/clips:/tmp/clips       # where finished clips are saved
      - /path/to/data:/data             # app settings + login (survives restarts)
```

```bash
docker compose up -d
```

Compose downloads the app if needed and starts it. That's it.

### 4. No Docker Compose? One command instead

Prefer no config file? This single command does the same thing — the three
`-v` lines are your three folders from above:

```bash
docker run -d --name scenester \
  --add-host=host.docker.internal:host-gateway \
  --device /dev/dri/renderD128 \
  -p 8096:8096 \
  -v /path/to/your/media:/media:ro \
  -v /path/to/clips:/tmp/clips \
  -v /path/to/data:/data \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/vacuumboots/scenester:latest
```

### 5. Open it

Browse to `http://localhost:8096` (or the IP of the machine running
Docker) and sign in with your Plex account.

### Optional: put it behind a reverse proxy

Any proxy that strips the `/scenester` path prefix works (Caddy, Traefik,
nginx). Caddy example:

```
handle_path /scenester/* {
    reverse_proxy localhost:8096
}
```

*For developers: `docker build -t scenester .` builds from source instead of
pulling — see [Development](#development).*

## Usage

1. Open the app — connect with Plex OAuth (or a pre-set token).
2. Browse or search your movie library.
3. Click a title to open the detail view.
4. Play or scrub to your in-point and click **Set Start**, then to your
   out-point and click **Set End** (or pick a duration preset).
5. Fine-tune with the nudge rows, then click **⬇ Download Clip**.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| I | Mark clip start |
| O | Mark clip end |
| Space | Play / pause |
| ← → | Nudge start ±1s (Shift = ±10s) |
| Alt + ← → | Nudge end ±1s (Shift = ±10s) |
| Enter | Download clip |
| Escape | Back to library |

## Security

Scenester is designed to run on a **private home network behind a reverse proxy**
(Caddy, Traefik, or nginx). Within that trust boundary the API is
unauthenticated — OAuth exists only to obtain a Plex token for library access,
not to gate Scenester's own endpoints.

Do **not** expose the container port (8096) directly to the internet. Put
authentication or access control in front of Scenester at the reverse proxy (or
your network layer), not in the app itself.

## Tech Stack

- **Backend** — Python 3.12 · FastAPI · uvicorn · httpx
  - Clipping runs **server-side via ffmpeg** (raw CLI argument lists, no
    Python bindings): output seeking for frame accuracy, `libx264` encoding,
    and a palette-optimized GIF pipeline (`fps=15`, `palettegen`/`paletteuse`)
    — clips come out identical regardless of your browser or device.
  - **VAAPI hardware acceleration** on Intel iGPUs (decode + scale + encode,
    with per-codec tiers and a transparent libx264 fallback) — a 60s clip
    drops from ~111s to ~11s on a Haswell i5.
  - Subtitle burning parses `.srt` files (UTF-8/Latin-1), chunks them into
    word groups for a "dynamic captions" look, and renders via ffmpeg's
    `subtitles=` filter with ASS styling.
  - Plex integration through the official HTTP API: library, metadata,
    sessions (the now-playing banner), and OAuth PIN login.
- **Frontend** — vanilla HTML/CSS/JS, no framework, no build step
  - Single-page app with one shared mark-from-playhead editor for desktop
    and mobile; direct media streaming over HTTP Range requests (native
    `<video>` controls — no custom scrubber).
  - PWA manifest + service worker so the shell loads fast on phones.
- **Container** — two-stage Docker build (alpine frontend copy →
  python:3.12-slim with ffmpeg + VAAPI drivers). Prebuilt images are
  published to GHCR by GitHub Actions on every push (`latest`, `sha-*`, and
  `v*` tags) — no need to build anything yourself.
- **CI** — GitHub Actions: pytest suite (35 tests) + a `node --check`
  syntax gate on the frontend JS.
- **Storage** — no database. Configuration comes from environment
  variables; Plex OAuth tokens persist to a `/data` volume; clips are plain
  files on disk, served back for download.
- **Reverse proxy** — works behind any proxy that strips a path prefix
  (Caddy, Traefik, nginx); the frontend uses relative URLs throughout.

## Development

Want to build the Docker image from source instead of pulling it?

```bash
docker build -t scenester .
```

Then run it with the compose file from [Setup](#setup) (swap the `image:`
line for `build: .`), or the `docker run` command.

To run the backend locally without Docker (the frontend needs no build step):

```bash
pip install -r backend/requirements.txt -r backend/requirements-dev.txt
uvicorn main:app --reload --app-dir backend
```

`STATIC_DIR` resolves automatically: the container layout (`backend/static`)
when present, otherwise the repo-layout `frontend/` directory. Override with
`CLIPARR_STATIC_DIR` if your checkout differs.

Run the tests:

```bash
python -m pytest
```

CI (`.github/workflows/ci.yml`) runs the same pytest suite on Python 3.12 plus
a `node --check` syntax gate on the frontend JS.

## VAAPI-accelerated clipping

Scenester hardware-accelerates clip generation on Intel iGPUs via ffmpeg's VAAPI
support, with a transparent software fallback:

- **Tier 1** — GPU decode + scale + encode (h264/mpeg2/vc1 sources)
- **Tier 2** — CPU decode + GPU encode (hevc/vp9/av1)
- **Tier 3** — libx264 software fallback (no `/dev/dri`, or a VAAPI run fails)

Enable it with `--device /dev/dri/renderD128` at `docker run`;
`CLIPARR_DISABLE_VAAPI=1` forces the fallback. On a Haswell i5 a 60s clip drops
from ~111s (libx264) to ~11s (VAAPI).
