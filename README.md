# Scenester

## Proudly vibecoded with Deepseek 🐋

Scenester clips movies from your Plex library. Browse, scrub a live video preview,
mark a range with two buttons, and download frame-accurate 1080p clips.

<p align="center">
  <img src="screenshots/library-desktop.jpg" alt="Scenester movie library on desktop, with the now-playing banner" width="62%">
  <br>
  <sub>The library — every title in your Plex server, searchable and sortable. The banner shows what's playing right now.</sub>
  <br><br>
  <img src="screenshots/editor-desktop-clean.jpg" alt="Clip editor on desktop with a live video preview" width="62%">
  <br>
  <sub>The editor — the movie streams right in the page; mark a start and an end and download the clip.</sub>
</p>
<p align="center">
  <img src="screenshots/editor-desktop-multi-lines.jpg" alt="Selecting a run of dialogue lines marks the matching clip range" width="62%">
  <br>
  <sub>Editing by dialogue — select the lines you want and the clip range follows. Six lines here become a 23.6s clip.</sub>
</p>
<p align="center">
  <img src="screenshots/library-desktop-searchline-hell.jpg" alt="Searching every movie's dialogue by quote — 885 matches for &quot;what the hell&quot;" width="62%">
  <br>
  <sub>Quote search — remember the line, not the movie. 885 matches for &quot;what the hell&quot;, each one a click away from clipping.</sub>
</p>
<p align="center">
  <img src="screenshots/editor-desktop-finetune-filmstrip.jpg" alt="Fine-tune nudges and the opt-in film strip" width="62%">
  <br>
  <sub>Fine-tuning — nudge each edge by single frames if you want, with an optional thumbnail film strip for jumping around.</sub>
</p>
<p align="center">
  <img src="screenshots/editor-desktop-line-search.jpg" alt="Searching lines within a movie's transcript" width="36%">
  <img src="screenshots/library-mobile-manual.jpg" alt="Movie library on mobile" width="180">
  <img src="screenshots/editor-mobile-manual.jpg" alt="Clip editor on mobile" width="180">
</p>
<p align="center">
  <sub>Searching within one movie's transcript · the whole workflow on a phone</sub>
</p>

## Why Scenester?

Most clip editors make you drag slider handles and pray. Scenester is built
around a different idea: **edit by selecting lines of dialogue**.

Because Scenester already reads your movies' subtitle files, the clip range
isn't an abstract timeline — it *is* the script. Every line under your playhead
is listed with its timestamp:

- **Tap a line to select it; shift-tap to extend** — the clip's start and end
  snap to the dialogue you picked. Selecting "the argument scene" is just
  selecting those lines.
- **The selection follows your range in real time**: mark Start/End anywhere
  (buttons, keyboard, film strip) and the covered lines light up instantly;
  select lines and the range moves to match. Two views of one edit, always in
  sync.
- **Search quotes across your entire library** — flip the search box to
  **Lines** mode and type any phrase ("we're not in Kansas anymore") to find
  which movie says it, at what timestamp, then jump straight into that moment
  ready to clip it.
- **Double-tap a line to audition it** — the exact span loops instantly so you
  can hear the take before committing.

No other Plex clipper works this way: you mark moments by their words, not by
eyeballing waveform handles.

## Features

- **Dialogue-driven editing** — see above; it's the headline feature.
- **Video-first preview** — the player spans the full editor width on
  desktop (up to a 2560px canvas; native aspect ratio, no letterboxing) and
  streams directly with byte-range seeking; the native `<video>` controls
  are the only scrubber.
- **Mobile-friendly** — the full editing workflow works in portrait and
  landscape on phones, not just desktop.
- **Unified mark-from-playhead editor** — one selection model on desktop and
  mobile: play to a moment and tap **Set Start**, play on and tap **Set End**.
  Unset buttons free an edge to ride the playhead again.
- **Frame-precise nudging** — explicit Start/End rows of −30s −10s −5s −1f +1f
  +5s +10s +30s (1 frame ≈ 0.04s). Fat-thumb accessible.
- **Library view with search & sort** — poster grid for the whole library;
  filter by title as you type and sort by title, year (newest/oldest),
  duration, date added, or shuffle.
- **Duration presets** — Free (default) plus 5s / 10s / 15s / 45s / 60s.
- **Looped clip preview** — 🔁 Loop auditions the selected range before download.
- **Opt-in film strip** — a navigation-only thumbnail strip (🗂 toggle in the
  player's timeline bar): tap a frame to move the playhead.
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

*New to Docker? You don't need to understand it. Add this service to your
existing Docker Compose file and run `docker compose up -d` — that's the whole
install.*

### 1. Configure

Next to your `compose.yaml`, create a `.env` file:

```bash
cp .env.example .env
```

Open `.env` and set your Plex server address:

```
PLEX_URL=http://host.docker.internal:32400
# PLEX_TOKEN=...   (optional — the in-app "Connect to Plex" login is easier)
```

### 2. Add it to your compose file

Paste this service into your existing `compose.yaml`. Change the three
`/path/to/...` lines to your real folders — the first one must be the folder
your Plex library lives in:

```yaml
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

Then:

```bash
docker compose up -d
```

Compose pulls the image automatically and starts it. That's it.

<details>
<summary>Not using Compose? One command instead</summary>

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
</details>

### 3. Open it

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
2. Browse or search your movie library (or switch the search to **Lines**
   mode to find a scene by quoting it).
3. Click a title to open the detail view.
4. Mark your clip: tap dialogue lines, or play/scrub to your in-point and
   click **Set Start**, then to your out-point and click **Set End** (or pick
   a duration preset).
5. Fine-tune with the nudge rows, then click **⬇ Set Clip**.

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
    `subtitles=` filter with ASS styling. The same parser powers dialogue-line
    selection and cross-library quote search.
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
- **CI** — GitHub Actions: pytest suite (50 tests) + a `node --check`
  syntax gate on the frontend JS.
- **Storage** — no database. Configuration comes from environment
  variables; Plex OAuth tokens persist to a `/data` volume; clips are plain
  files on disk, served back for download.
- **Reverse proxy** — works behind any proxy that strips a path prefix
  (Caddy, Traefik, nginx); the frontend uses relative URLs throughout.

## Development

Want to build the Docker image from source instead of pulling it? Swap the
`image:` line in your compose service for `build: .` pointing at a checkout
of this repo, or:

```bash
docker build -t scenester .
```

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
