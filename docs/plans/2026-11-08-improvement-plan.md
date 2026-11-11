# Scenester — audit and improvement plan

2026-11-08. A full read of the codebase (backend, frontend, build, deploy, CI)
after the caption/chapter export bug, with every claim below reproduced before
it was fixed. Nothing here is speculative: each fixed item was verified by
running it, each open item was verified by reading the exact lines cited.

---

## What is already solid

Worth saying before the list, because most of this codebase is better than its
age suggests:

- The ffmpeg tiering (GPU decode+scale+encode → CPU decode + GPU encode →
  libx264 fallback) is genuinely good engineering for a 4-core Haswell box, and
  the VAAPI `hwdownload → format=yuv420p` green-frame workaround is documented
  where it belongs.
- The derived-artifact caching (frame/thumb/library/metadata) is the right
  design: deterministic, disk-backed, concurrency-capped, and each layer has a
  comment explaining what it replaced.
- Error handling in the API is consistently degrade-don't-crash (missing cache
  dir, missing subtitles, missing thumbnail, Plex 502s).
- The frontend is dependency-free ES5 that still runs on a phone browser from
  2019, and the tap-to-load gallery is a genuinely smart fix for 60+ clips.

The weak spots are almost all at the edges: what happens on failure, what
happens with unusual input, and what the deployment does when it goes wrong.

---

## Fixed in this pass

### 1. Caption exports served a stale, captionless file (P0)

`POST /api/clip` short-circuits with `{"status":"ready"}` whenever
`CLIPS_DIR/<filename>` exists, and the filename only encoded (media, start,
end). Ticking *Burn subtitles* after exporting the same range re-served the
captionless file — the reported "subtitles aren't burnt".

Fixed: filenames now carry the render options (`-cap3`, `-v`, `-middle`,
`-yellow`) through `_clip_variant()`. Plain clips keep their old names.

### 2. Source chapters stretched every clip's runtime to 19 minutes (P0)

ffmpeg copies chapters with their absolute timestamps, so a 78s clip carried a
chapter/data track ending at 1182.6s and players reported 19:42. Clips now pass
`-map_chapters -1`.

### 3. 10-bit sources produced unplayable MP4s (P1)

The libx264 tier had no `-pix_fmt`, so a 10-bit film produced `High 10 /
yuv420p10le` — rejected by QuickTime, Safari and X. Verified with a synthetic
10-bit source: `yuv420p10le` before, `yuv420p` after. The moov atom is now
faststarted as well.

### 4. Quote search froze the entire app for ~56 seconds (P1)

`parse_srt` ran synchronously over ~2100 subtitle files *on the event loop*,
inside a request. Measured: 56s to first result, +291MB RSS, every other
request stalled for the duration. Parsing now runs in a worker thread, the
index is warmed at boot, and an unchanged library renews the TTL instead of
re-parsing. Measured after: `/api/auth/status` stayed at 2-27ms while the index
built; first search 8s (cold library fetch included).

### 5. Wrong subtitles could be burned onto a clip (P1)

`_find_subtitle_path` preferred *any* English SRT over the one matching the
file. Reproduced: `Film.mkv` + `Film.srt` + `Other_Movie.en.srt` returned
`Other_Movie.en.srt`. Stem match now wins; English is the tiebreaker within
that set. Regression test added.

### 6. Clip ranges have a floor, and the gate is honest (P2)

Marking only *Start* seeds a range through `updateTimeDisplay()`
(`end = start + 1`), which armed Download with a 1s clip — reasonable, but the
underlying test was a bare `dur > 0` in two frontend writers and `end > start`
in the backend, so any future path that produced a sub-second range would have
encoded it. There is now a shared `MIN_CLIP_SECONDS = 0.5` floor on both sides
(`_check_clip_range`), verified in the browser: a 0.04s range disables the
button, a 5s range enables it, and `POST /api/clip` rejects 40ms with
"Clip must be at least 0.5s".

The dead `+ 0.04` seed branch in `mobMarkStartAt` was removed and a stale
comment claiming a 140s cap (which does not exist anywhere) was corrected.

### 7. Failures were invisible and unbounded

- Unbounded clip concurrency: a burst of export taps started N encodes on 4
  cores. Now a semaphore (`CLIPARR_CLIP_CONCURRENCY`, default 2); extra jobs
  queue.
- ffmpeg errors were discarded — the user saw "ffmpeg exited with code 1" with
  no cause. The non-progress stderr tail is now logged and its last line
  surfaced in the job error.
- Frame timestamps were unclamped: `t=-5` returned a 500 and minted a cache key
  per junk value. Now clamped to the file.

### 8. Frontend bugs found by audit and fixed

| Finding | Effect |
|---|---|
| Enter was captured document-wide | pressing Enter with a button focused ran Download instead of activating the button; now skipped for `BUTTON`/`A` |
| Loop arming with no range | every `timeupdate` sought to 0, pinning playback in the first frames |
| Clip status polling not cancellable | kept polling for up to 10 minutes after leaving the view, then fired a download from a hidden screen |
| `init()` not idempotent | boot + PIN poll could both run it, double-binding every listener and leaking a session-poll interval |
| PIN poll overlap | a slow plex.tv response let two polls resolve "done" and call `init()` twice |
| `c.filename` interpolated unescaped | `/api/clips` output went raw into `title`, `href` and an inline `onclick`; now escaped, and delete is a delegated listener |
| Film-strip touch had no pan threshold | a scroll that started in the strip seeked the playhead on release (iOS doesn't always fire `touchcancel`); now 12px / 600ms |
| Download label had three writers | the label flipped wording and stayed stale after an export; one renderer owns the button now |

### 9. Build, deploy and CI

- `.dockerignore` ignored almost nothing: the build context shipped `.git`,
  `tests/`, `scripts/`, `.hermes/`, 49MB of screenshots and a host virtualenv,
  which also landed in the image as `/app/.venv`.
- `Dockerfile` copied the frontend *above* `pip install`, so every CSS/JS edit
  re-ran pip. Dependencies now come first; the frontend is the last layer.
  Added `HEALTHCHECK` (a hung uvicorn never tripped `--restart`) and
  `--no-install-recommends` on the apt layer.
- `deploy.sh` deleted the running container *before* creating the new one, so a
  failed `docker run` left the host with nothing. Now: tag the live image
  `:prev` first, recreate, health-probe for 30s, roll back automatically on
  failure. Added log rotation and a `curl` presence check.
- CI: added a `permissions: contents: read` block, dropped the stale `master`
  hedge (the repo is on `main`), and added a job that builds the image so the
  Dockerfile is exercised before a deploy.

Tests: 64 passing (was 50 before this session), including the new filename
cache-key, chapter, 8-bit, subtitle-discovery, error-format and range-floor
cases.

---

## Open — ranked, with the reason to care

### P1 — no application-layer authentication

Every endpoint is unauthenticated: `/api/library`, `/api/media/{id}/stream`,
`/api/clip`, `/api/download`, and `DELETE /api/clips/{filename}`. "Plex OAuth"
only obtains the *server's* Plex token; it does not gate a caller. Anyone who
can reach port 8096 can browse and stream the library, burn CPU encoding, and
delete clips.

`README.md` documents this as a trust-boundary decision, which is honest but
only holds while the container sits behind a private network. Two real options:

1. **Stop publishing the port on the LAN.** `deploy.sh` publishes
   `-p 8096:8096`, which listens on `0.0.0.0` — any device on the LAN can reach
   the API directly, bypassing Caddy entirely. Prerequisite: Caddy currently
   proxies to `http://host.docker.internal:8096` (`/opt/hms-docker/d/Caddyfile`,
   the `handle_path /scenester/*` block), i.e. it dials the *published host port*,
   so this is not a one-line change. Either point that route at the container
   name over `hms_media_net` (`reverse_proxy http://scenester:8096`), or bind the
   port to the docker bridge gateway (`-p 172.17.0.1:8096:8096`) so only the
   host and containers can reach it. Verify `/scenester/` through the public URL
   afterwards.
2. **Shared secret when `CLIPARR_ACCESS_TOKEN` is set**: middleware compares a
   cookie or `X-Scenester-Token` header and the UI stores it in `localStorage`.
   Opt-in, so the private-network default is unchanged.

Also worth doing regardless: `POST /api/auth/logout` is unauthenticated and
clears the server's Plex token, which breaks the app until re-auth. At minimum
it should require the same request to come from the app.

### P1 — the quote index is expensive and lives only in RAM

~330MB RSS after a build, and it is rebuilt whenever the library fingerprint
changes (a new film invalidates it) or the TTL (6h) expires. On an 8GB box that
shares its spindles with Plex, the build is a minute of seek contention.
Options: persist the index to `/data/quote-index.json` and load it on boot
(makes restarts instant), or store per-film SRT mtimes in the fingerprint so a
single new film doesn't force a full re-parse.

### P2 — clips are never pruned by default

1.7GB of exports accumulate in `/opt/hms-docker/apps/scenester/clips`. Retention
now exists but is opt-in (`CLIPARR_CLIP_MAX_AGE_DAYS`), because deleting a
user's exports by default is the wrong trade. Two better answers than a global
retention policy: show the total size in the gallery header, or add a "clear
clips older than N days" button.

### P2 — the container runs as root with no CPU/memory limits

Root with `/media` read-only is mostly harmless, but ffmpeg on a big source can
happily eat every core. `--memory=2g --cpus=2` in `deploy.sh` bounds the blast
radius. A non-root `USER` needs the host `clips/` and `data/` directories
chowned to a matching uid — a deploy-time change, not a Dockerfile-only one.

### P2 — dependencies are unpinned

`uvicorn`, `httpx` and `pillow` have no upper bound and there is no lockfile or
hash pinning, so image builds are not reproducible. `pip-compile` into a
hashed requirements file, install with `--require-hashes` in both the Dockerfile
and CI.

### P2 — `scripts/verify_player_render.py` claims to gate deploys and does not

Nothing invokes it, `selenium` is in neither requirements file, geckodriver is
hardcoded to a snap path, and `--media-id` is honoured for the source-frame
extraction but the browser step clicks the *first* library card regardless
(`scripts/verify_player_render.py:113`) — so it can compare one film's source
frame against another film's render. Either wire it into CI properly or drop the
gate claim.

### P2 — remaining frontend dead code and stale state

- `loadCaptionLines()` has no staleness guard (contrast `selectItem`'s
  `_navCounter` check): a slow response for film A can leave A's lines active
  while B is displayed.
- `_videoReady` / `_videoFailed` / `_isMobile` are assigned and never read.
- Orphaned CSS from the removed desktop UI: `.btn-back`, `.timeline-hint`,
  `.target-warning`; `#error-banner` / `#error-message` / `#login-pin-error`
  are never written by any JS.
- `showDetailView()` pushes a history entry on every call, including from the
  popstate restore path, so back/forward cycles accumulate entries.
- `_armLoopWhenReady` can leave `canplay`/`seeked` listener pairs attached to
  the persistent `<video>` when it returns early.
- `words_per_chunk` is part of the API and the filename variant but no UI
  control sets it (always the default 3) — fine today, a trap if someone adds
  the control and forgets the variant.

### P2 — backend structure

`backend/main.py` is 1500 lines doing routes, subtitle parsing, caching,
ffmpeg command construction and job state. Splitting `clips.py` (encode +
command building), `cache.py` and `quotes.py` out of `main.py` would make the
ffmpeg logic unit-testable without importing the whole app. Not urgent, but it
is the reason the export pipeline was only covered by characterisation tests.

There are also no API-level tests: everything is pure-function coverage. A
handful of `TestClient` cases over `/api/clip` (validation, ready-path reuse,
404s) would have caught the stale-caption bug.

---

## Attack order for what's left

1. **Loopback-bind the port** (5 minutes, removes the LAN exposure question
   entirely) plus an auth note in the README.
2. **Persist the quote index** (kills the restart cost and most of the memory
   churn).
3. **Resource limits in `deploy.sh`** (one line each).
4. **Pin dependencies** (mechanical, protects future builds from a surprise
   major version).
5. **Split `main.py`** and add `TestClient` coverage of the clip endpoint.
6. Frontend leftovers: caption staleness guard first (it can mark the wrong
   range on the wrong film), then the dead code and orphan CSS sweep, then the
   history/listener cleanups.
7. Decide on `verify_player_render.py`: wire it into CI or delete it.

---

## How this was verified

- Every backend fix ran against a real throwaway container
  (`scenester:audit` on :8099) with the real film *Possible Love (2026)*, then the
  output was probed with `ffprobe` and specific frames were extracted and
  inspected visually for burned-in captions.
- The 19-minute-runtime and 10-bit claims were reproduced with the *original*
  code before the fix and re-measured after.
- The quote-index freeze was measured with concurrent `curl` timing (status
  endpoint latency during a build).
- Frontend changes: `node --check`, and the DOM/behaviour changes were
  exercised against the live container after deploy.
- Tests: `python -m pytest -q` → 64 passed. The repo has no host virtualenv
  (`backend/.venv` exists but has no pytest), so:
  `python3 -m venv /tmp/t && /tmp/t/bin/pip install -r backend/requirements.txt
  -r backend/requirements-dev.txt && /tmp/t/bin/python -m pytest -q`.
