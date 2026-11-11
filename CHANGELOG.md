# Scenester Changelog

## 2026-11-10 — v1.0.0: unprivileged container, no published port, access gate

The API had no credential of its own and the container published 8096 on every
interface, so anything on the LAN could stream the whole library, delete clips
and occupy both encode slots. Neither is true now, and none of it needed the
reverse proxy to change its shape.

- **No published port.** Caddy dials `scenester:8096` over `hms_media_net`
  instead of `host.docker.internal:8096`. The route was switched and verified
  *before* the port was removed, so there was no outage, and every neighbouring
  route was re-checked afterwards. `deploy.sh` now warns if a host port
  reappears or if Caddy can no longer reach the container by name.
- **Unprivileged.** The image creates uid 1000 and runs as it, with
  `--cap-drop=ALL --security-opt=no-new-privileges` and the render gid added.
  `h264_vaapi` was re-confirmed from inside the container, and a 12s clip
  encoded in 3.21s (3.7x realtime), colour-checked at three timestamps.
  A side effect worth having: clips, cache and the Plex token now land on the
  host owned by the host user instead of root.
- **Access gate.** `SCENESTER_ACCESS_TOKEN`, compared with
  `hmac.compare_digest`, accepted as `X-Scenester-Token` (scripts) or an
  HttpOnly cookie set once by `POST /api/auth/unlock` (browser). The cookie is
  a digest of the secret rather than the secret, so rotating the token
  invalidates every issued cookie. Unset still means open, which keeps a plain
  `docker run` working and lets the tests exercise both states.
- **PIN binding.** Plex PINs are bound to the client that created them with a
  nonce cookie. Before this, any reachable client could start a PIN, approve it
  with its own Plex account and overwrite the stored token — "login" was a
  takeover.
- **Pinned build inputs.** Both base images by digest, ffmpeg and libva by
  version, and a hashed `requirements.lock.txt` installed with
  `--require-hashes`. The VAAPI green-frame fix depends on filter-graph
  negotiation in a particular ffmpeg build, so the input that bug lives in is
  no longer free to drift.
- **`docker-compose.yml`** ships: one command, loopback-only port, resource
  limits, matching uid/render-gid handling.
- **Tests: 94 passing** (14 new) covering the gate in both states, token
  rotation, the PIN binding, a forged PIN cookie, and the `SCENESTER_*` /
  `CLIPARR_*` precedence promise that had no test behind it.
- **CI:** the image smoke test now chowns its bind mounts. GitHub runners are
  uid 1001 and the container is 1000, so `/data` was unwritable, `/healthz`
  correctly reported unhealthy and CI failed a good build.

Verified through Caddy in a real browser: locked state shown, wrong token
refused with a message, right token loads all 1920 library items.

## 2026-11-08 — Renamed to Scenester, everywhere

The product has been called Scenester since the second rebrand, but the
plumbing still said `cliparr`. Everything a human types or reads now matches
the name; the GitHub repo and ghcr package were already `scenester`.

- Container and image: `cliparr` → `scenester` (`deploy.sh` retires an old
  `cliparr` container automatically, since it holds port 8096).
- Repo dir: `~/Git/cliparr` → `~/Git/scenester`; bind mounts
  `/opt/hms-docker/apps/cliparr/{clips,data}` → `.../scenester/...`
  (clips and cache moved, nothing regenerated).
- Env vars: `CLIPARR_*` → `SCENESTER_*`. The old names are still read as a
  fallback, so an existing container definition or cron job does not silently
  fall back to defaults.
- URL: `/cliparr/` → `/scenester/`. `/cliparr/*` 308-redirects to the new path
  (query dropped in the redirect), so old bookmarks open. The installed PWA
  needs one re-install for its new scope.
- Homepage tile, wiki and the `scenester` skill updated.

## 2026-11-08 — Fix: caption exports reused a stale clip + clipped chapters stretched the runtime

Two bugs behind one report ("subtitles aren't burnt and the file is 19
minutes long" for a 78.4s clip at 2:26:47):

- **Clip cache keyed only on (media, start, end).** Toggling *Burn
  subtitles* after exporting the same range returned `{"status":"ready"}`
  for the captionless file already on disk, so the captions never
  appeared. The filename now carries the render options —
  `…_8807.9-8886.3-cap3.mp4` for three-word chunks, `-v` for the 9:16 crop,
  plus `-middle` / `-yellow` when those differ from the defaults. Plain
  clips keep their historical names.
- **Source chapters were copied into the clip.** ffmpeg preserves chapter
  timestamps, so a 78s clip carried a chapter track ending at 1182.6s and
  players reported ~19:42. The clip command now passes
  `-map_chapters -1`.

Verified on `Possible Love (2026)` 8807.9-8886.3: output duration 78.41s,
no data/chapter stream, caption frame at t=3s reads "ONE THING THEN.".

## 2026-08-20 — Fix: video permanently dimmed by the loading-overlay scrim (v=70)

The `#frame-preview` loading/error wrapper carried a 60% black background
(`rgba(0,0,0,0.6)`) and stayed visible over the playing video — every
preview rendered at ~40% brightness vs Plex/VLC. The scrim now lives on
the loading/error message cards only; the wrapper is transparent while
the video plays. Verified: browser frame luminance 101.7 vs 107.3 in the
source (was ~43 before the fix).

## 2026-08-20 — No-scroll desktop editor (v=67) + ±1s fine-tune (v=68)

From live-user feedback on a 4K@125% screen: the v=66 editor pushed the
controls below the fold. The whole editor now fits the viewport without
scrolling on desktop:

- **Removed "← Library"** — the Scenester header wordmark already goes
  home; the detail header is now a single row: title with
  year · movie · runtime inline after it (· separators).
- **Film strip toggle is full-width** — same height, now spans the whole
  player; the "click a frame to jump the playhead" hint text is gone.
- **Dropped the "Position" and "Clip range" section labels** — "Frame at
  0:00" sits directly under the video, Set Start/Set End moved up.
- **One mark row**: Loop · Set Start · Set End · Download (2×2 on
  phones). Download label renamed from "Set Clip", keeps the
  "⚠ Set a clip range" disabled hint.
- **Collapsed control row**: Fine tune · Duration · Export options ·
  Lines as one line of chips. On desktop each opens as an overlay
  dropdown spanning the FULL row width (v=69); on phones they expand
  in-flow. Duration presets moved into the Duration chip.
- **Player hugs the video**: the player-card width is capped to the
  16:9 of the available height (instead of a max-height on the video),
  so there are no letterbox bars inside a stretched black card and the
  whole editor fits 1080p and 4K@125% with zero scroll.
- **±1s fine-tune nudges** (v=68): Start and End rows now run
  −30s −10s −5s −1s −1f +1f +1s +5s +10s +30s.
- Mobile fine-tune no longer auto-opens on load — all four chips stay
  collapsed 2×2.
- **Removed the "Set Start and End to define the clip" hint** (v=69) —
  the range summary line is empty until a range exists.

## 2026-08-17 — Frontend redesign: widen canvas + control polish (v=65→66)

Follow-up on the v=64 redesign from live-user feedback on a 4K@125% screen:

- **Canvas widened 1800 → 2560px cap** (`min(100% - 32px, 2560px)`) — at
  4K@125% the editor column grew from ~58% to ~83% of the viewport,
  killing the dead side margins; 1440p/1080p go effectively full-width.
  Fine-tune START/END columns capped at 1200px so nudge buttons stay
  compact on the wider canvas.
- **Player hugs the movie's native aspect ratio** once metadata loads
  (16:9 placeholder before) — widescreen films fill the full player width
  instead of letterboxing inside a fixed 16:9 box (the "center third"
  symptom on 4K).
- **Format dropdown → MP4 | GIF segmented control** (`setFormat()`), same
  gold-active style as the duration presets.
- **Unified segmented-control look** for search mode (Titles/Lines),
  duration presets, and format — solid gold active segment, unmistakable
  selection. (The v=64 CSS rewrite had accidentally dropped the
  `.search-mode`/`.quote-*` styles entirely; restored here.)
- Header search row now wraps on ~500–767px so the sort select stops
  overflowing (pre-existing edge).
- Cache-bust v=65, v=66.

## 2026-08-17 — Frontend redesign: full-width video-first editor

Presentation-only overhaul of the clip editor — no backend or API changes,
no new dependencies (vanilla CSS/flex/grid, same JS handlers).

- **Wide desktop canvas** — `main` is now `min(100% - 32px, 1800px)` instead
  of the old 1400px column; on 4K the page is a centered 1800px workspace,
  not a floating 1080p webpage.
- **Video is the centerpiece** — the player spans the full content width
  (`aspect-ratio: 16/9`, viewport-height cap so it never dominates a short
  laptop screen). The 480px/80vh height caps that kept it a small window
  are gone.
- **Player card + attached timeline** — the video and thumbnail strip now
  share one black surface (timeline bar with film-strip toggle + "click a
  frame" hint). Thumbnails are bigger on desktop (140px) and on mobile
  (96px, scroll-don't-shrink), and the thumbnail nearest the playhead gets
  a white "current position" ring (gold stays = selected range).
- **Compact detail header** — "← Library" is navigation-styled, the title
  is prominent, metadata secondary; the old padded `target-card` is gone.
- **Controls grouped by workflow** — labelled sections: Position (frame-at
  readout, skip nav, range overview), Clip range (Set Start / Set End +
  live "00:12 → 00:38 · 26.0s" summary + IN/OUT snaps + unset), Duration
  (segmented control: Free | 5s | 10s | 15s | 45s | 60s), Fine-tune
  (START | END nudge rows side by side on desktop), Lines + Export options
  side by side on desktop, then Loop + Set Clip.
- **Primary action hierarchy** — "Set Clip" (renamed from "Download Clip")
  is the gold CTA, disabled with "⚠ Set a clip range" until a range exists;
  Loop is secondary.
- **Transcript panel** — bounded height (300px desktop / 35vh mobile) with
  its own scroll; page height no longer grows with line count.
- Loading/error states now overlay the player instead of sitting below it.
- Cache-bust v=64.

## 2026-08-15 — Rebrand: Cutarr → Scenester

Second rebrand (Cliparr → Cutarr → Scenester). Brand strings updated across
README, frontend (title, manifest, PWA cache, wordmark "Scene·ster"), backend
(FastAPI title, `X-Plex-Product`, clip metadata comment), tests, and docs.
GitHub repo renamed `vacuumboots/cutarr` → `vacuumboots/scenester` (GHCR image
follows automatically). Live deploy names intentionally unchanged: container
`cliparr`, Caddy `/cliparr/`, `CLIPARR_*` env vars, repo dir `~/Git/cliparr`.
Cache-bust v=57.

## 2026-08-12 — Phase 5: robustness polish (codebase-audit cleanup)

Small hardening pass — no visual changes; behavior changes are limited to the
fixes described:

- **`clip_jobs` pruning** — completed jobs older than 1 hour are dropped on
  each new clip request, keeping the in-memory dict bounded over a
  long-running server.
- **Exception cage** — `_run_ffmpeg_clip` wraps the ffmpeg run; an unexpected
  failure now marks the job done-with-error so the client's poll terminates
  instead of timing out.
- **Token file permissions** — the persisted Plex token (and client id) are
  written `0600`.
- **Configurable path prefix** — `PLEX_MEDIA_SRC` / `PLEX_MEDIA_DST` env vars
  replace the hardcoded `/data/media` → `/media` mapping.
- **Minor JS cleanups** — removed the dead `result.duration` branch; the
  service worker's API path is now network-only; the Space shortcut no longer
  fights a focused button.

Tests: 39 (4 new — prune, exception cage, configurable prefix, token perms).
Cache-bust v=49.

## 2026-08-12 — Phase 4: tests, CI, and local dev (codebase-audit cleanup)

Adds the missing engineering scaffolding — no behavior or visual changes:

- **pytest suite** — `tests/test_main.py` + `tests/test_plex.py` (35 tests)
  characterize the pure helpers: clip naming (`_slugify`, `_clip_basename`),
  subtitle parsing (`parse_srt`, `chunk_srt_for_social`), SRT timestamps
  (`_srt_timestamp`/`_fmt_srt_timestamp`), the video MIME map (`_video_mime`),
  Plex path translation (`_translate_path`), and subtitle discovery
  (`_find_subtitle_path`).
- **CI (GitHub Actions)** — `.github/workflows/ci.yml`: a Python 3.12 pytest
  job plus a `node --check` syntax gate on the frontend JS.
- **Local dev** — `STATIC_DIR` now resolves via `CLIPARR_STATIC_DIR`, else the
  container layout, else the repo `frontend/` dir, so `uvicorn main:app
  --app-dir backend` serves the SPA with no build step. README gains a
  "Development" section.

Characterization note: an episode with no `show_title` names its clip
`unknown_...` (because `_slugify("")` returns "unknown") — locked in by a test
and left as-is, since fixing it is a behavior change.

## 2026-08-12 — Revisions: free preset, playhead-only strip, scroll-to-top (v=47)
Follow-up from user testing:
- **"Free" preset is the default** — a chip in the preset row (active on open)
  with NEITHER start nor end pre-selected. The range starts empty, the middle
  counter reads "free", and download shows "⚠ Set a clip range" until both
  edges are marked. In free mode Set Start marks only the start (the end rides
  the playhead); a duration preset still auto-sets end = start + N in one tap.
- **Film strip is navigation-only** — removed long-press-to-end; a tap/click
  now moves the playhead to that frame (it does NOT mark an edge). Edges are
  set only via the Set Start/Set End buttons. Removed the strip hint text (no
  instructions needed).
- **Navigation** — clicking the "Cliparr" header or "← Back to Library" always
  scrolls to the top of the library.
Cache-bust v=47.

## 2026-08-12 — Polish pass: free-length clips, 30s skips, banner dismiss (v=44)
Small follow-up adjustments to the unified mark-from-playhead editor:
- **Double-download fixed** — the download button fired `downloadClip()` twice
  per click (HTML `onclick="mobDownload()"` AND an `addEventListener` in
  `init()`). Removed the listener; `mobDownload()` is the single trigger.
- **Header is just "Cliparr"** — dropped the "plex clip maker" tagline and the
  dev-only "JS ✓" load marker.
- **Default clip length is now "free"** — X.com lifted its 140s cap, so the
  139s default is gone. Opening a movie selects the FULL length, and the middle
  duration counter reflects the real range. Removed the 139s preset chip.
  *(Superseded by v=47 — the default is now an empty "free" range with neither
  edge selected, not the full length.)*
- **30s skips** — ⏮/⏭ buttons join the ⏪/⏩ 10s playhead jumps.
- **Now-playing banner is dismissible** — ✕ button hides it; it stays hidden
  until the paused session ends.
- **Film strip on mobile** — removed the desktop-only gate; the 🗂 toggle moved
  into the shared editor. Dropped the stale "drag to slide range" hint.
- **Desktop cleanup under the player** — removed Clip/Full, mute, S/M/L size,
  and "jump to" (redundant/broken) plus their JS; the "Frame at" readout moved
  down into the clip selection so it shows on both viewports.
Net −171 lines across index.html / app.js / mobile.js / style.css; cache-bust v=44.

## 2026-08-12 — Desktop selection de-clutter (v=43)
Collapsed desktop clip selection onto the validated mobile mark-from-playhead
model. Deleted the redundant desktop surfaces — interactive range bar + zoom +
overview, the micro-scrubbers, the old Mark Start/End buttons, the preset-lock
model, and the editable start/end time inputs. The mobile.js editor is now the
SINGLE selection editor on both viewports; desktop gets a responsive layout,
progressive disclosure (a "✂ Fine-tune" collapsible that stays closed until an
edge is marked), and keyboard shortcuts I / O / Space. The film strip is now
opt-in (🗂 toggle, hidden by default — no server frame extraction until asked).
Net −1275 lines across index.html / app.js / mobile.js / style.css. The review
pass re-pointed the shared `dom.*` refs at the unified `#mob-*` elements to
fix three cross-file breaks (download early-return, dead progress display,
captions option never shown). Headless Firefox verified desktop (1280px) and
mobile (390px): old surfaces absent, new editor present, fine-tune disclosure +
strip toggle + download state + keyboard all green, zero console errors.

## 2026-08-10 — Fix pure-green clips on captions/vertical path (backend-only)
Clips with burned-in captions (or vertical crop) could come out in shades
of green. Cause: the i965 driver's `hwdownload` returns a corrupt NV12
surface, and the following `format=nv12` filter was a no-op — the broken
layout survived into the h264_vaapi encode (measured on Tokyo Sonata:
R=0 G=194 B=0 vs the libx264 reference 53/49/43). Fix: one word,
`hwdownload,format=yuv420p,...` forces a real swscale conversion that
repairs the surface before CPU filters. Plain clips (Tier 1, all-GPU)
were never affected. Fixed output matches the libx264 reference exactly.
No frontend change — cache-bust stays v=42.

## 2026-08-07 — Visible snapshot loading feedback (v=42, commit 8f925f0)
Mobile IN/OUT frame snapshots (v=41) showed only a 0.45 opacity fade while
the server-side ffmpeg extraction ran — 2.5-3s+ per frame on this host,
two in parallel after Set Start. On a phone the taps read as dead/broken.
Added a pulsing "loading frame…" overlay (CSS-only, `.mob-snap-loading::after`)
so the tap is visibly accepted while the frame renders. Cache-bust v=42.
Verified headless E2E: real stream, real seeks, marks pin, both snapshots
render, tap-thumbnail jumps playhead, nudge/preset refresh, unset hides,
download enabled, zero console errors — on both `:8096` and `/cliparr/`.

## 2026-08-05 — GPU-accelerated clipping via VAAPI (v=37, commits 9de90b8 + 3872f7b)
User asked to "go as hard as you can on limited resources" — the host is an
i5-4278U (Haswell, 4 threads, 7.6GB RAM) with a working i965 VAAPI driver.
Benchmarked on real 1080p x264: libx264 fast crf20 = 111s per 60s clip;
full VAAPI = 16.5s (6.7x), vertical 33.9s, captions 30.6s, CPU-decode+HW-
encode 19.4s. RAM 506MB → 108MB. In-container E2E: plain 60s clip **10.7s
(10.4x)**, vertical 12.5s.
- **Tier 1** (h264/mpeg2/vc1): `-hwaccel vaapi -hwaccel_output_format vaapi`
  + `scale_vaapi=1920:-2` + `h264_vaapi` — all on GPU, zero round-trips.
- **Tier 2** (hevc/vp9/av1): CPU decode (Haswell can't HW-decode these) +
  `hwupload` + `h264_vaapi`.
- **Tier 3** (fallback): libx264 — when `/dev/dri` absent or a VAAPI run
  fails (auto-retry, clip never silently breaks).
- Quality: `-global_quality 23` (ICQ) ≈ crf20 bitrate. Haswell encodes
  H264 **Main profile** (no High — fine for social/X).
- `_build_clip_cmd()` builds the ffmpeg list; `_probe_video_codec()` via
  ffprobe picks the tier; `CLIPARR_DISABLE_VAAPI=1` forces legacy.
- Dockerfile: `i965-va-driver libva-drm2`. Deploy: `--device /dev/dri/renderD128`.
- Removed dead `ffmpeg` import + `ffmpeg-python` dep (replaced by raw
  commands). PITFALL: the raw command list must start with `"ffmpeg"` —
  the old lib prepended it; omitting it makes create_subprocess_exec try
  to exec `-init_hw_device` → FileNotFoundError swallowed by create_task.
- Docs: HANDOFF + this entry + skill `references/vaapi-clipping.md`.

## 2026-08-05 — PWA installable (v=36, commit 7fd2d50)
The PWA scaffolding existed but was broken: sw.js lived in `/static/` so
its scope was `/static/` — it could never control the page (no offline
shell, no standalone install). Manifest/sw hardcoded `/cliparr/` paths
that 404 at the direct `:8096` URL (install fails entirely there).
- `frontend/sw.js` + `frontend/manifest.json` moved out of `static/`;
  backend routes `/sw.js` and `/manifest.json` at app root.
- Manifest: `start_url`/`scope` are `.` (relative — resolve to `/cliparr/`
  under Caddy, `/` direct), `purpose: "any maskable"` icons, `id` field.
- sw.js: shell paths derived from `self.registration.scope` (never
  hardcode the prefix), `skipWaiting()` + `clients.claim()` for instant
  updates, cache bumped to `cliparr-v3`.
- index.html: manifest link + SW registration root-relative.
- Verified headless: SW active at `/sw.js` scope `/`, controller claims
  page, manifest standalone + 2 resolvable icons, library still renders.

## 2026-08-05 — Mobile: Mark-From-Playhead rewrite + unset/options/nudges/history (v=32→35)

### v=32 — Mark-From-Playhead rewrite (commit 31fc7d6)
The user rejected the 7-iteration mobile state machine (1077-line mobile.js:
phases, zoom, armed edges, micro-scrubbers, lock buttons) as unusable and
chose a from-scratch rebuild. **Native video controls are the only scrubber;
two huge Set Start / Set End buttons mark `vid.currentTime`. Range follows
the playhead while browsing, anchors when marked.** mobile.js 1077 → ~310
lines, ES5, writes desktop globals directly (no parallel mobile state).
- Deleted: `_mobPhase`, `_mobZoomed`, `_mobArmed`, `_mobViewMin/Max`,
  `_mobPresetDuration`, `_mobMicroDragging`, `mobToggleZoom`,
  `mobLockPhase`, all `.mob-timeline*`/`.mob-micro*` CSS.
- app.js needed ZERO changes (its only mobile hooks are
  `initMobileDetail(item)` / `destroyMobileDetail()`).
- Review fixes: loop-button label needs a `play` listener (async playClip);
  preset-in-browse anchors start to playhead first.

### v=33 — Unset Start/End + options visibility (commit 70fb5e7)
- ✕ Unset Start / ✕ Unset End buttons: per-edge flags `_mobStartSet` /
  `_mobEndSet`; `_mobBrowse` now derived via `_mobSyncBrowse()`. Unsetting
  an edge makes it ride the playhead again; the other stays pinned.
- Follow driver has FOUR modes: browse / end-rides / start-rides / anchored.
- Fixed mobile options unreachable: app.js looked up `"mobile-options"`,
  element ID is `mob-options` (one-line fix) + removed inline
  `display:none` on `#mob-options`. Captions/vertical checkboxes now work
  on mobile.

### Redundancy sweep (commit b249a09)
Removed rewrite fallout: dead `clip-progress-mob*` writes in
`downloadClip()`/`pollClipStatus()`, dead `btn-mark-start-mob` /
`btn-mark-end-mob` flashes, uncalled `nudgeFrame()` and `mobilePreset()`
(+ removed `.mobile-preset-btn` ref), consolidated `_mobOnPause`/`_mobOnPlay`
into `_mobOnPlayPause()`.

### v=34 — 8-step nudge rows (commit acfb495)
Each Start/End row: −30s −10s −5s −1f +1f +5s +10s +30s (was 4 steps).
Pure HTML+CSS — `mobNudgeStart/End(delta)` already took arbitrary deltas.
`.mob-ft-row` is now a 4-column grid (label spans full width, buttons wrap
2 lines) so every button keeps ≥44px fat-thumb targets.

### v=35 — SPA history: back-swipe stays in-app (commit 08beac9)
Cliparr had zero history integration — edge-swipe-back/back-button popped
the ONE real browser entry and left the site. Now: seeded home entries +
pushed detail entries + popstate absorb (push fresh home after every back).
`goHome()`/`goBack()` route through `history.back()` when on detail.
`selectItem()` nav-counter guard stops in-flight fetches yanking the user
back. CSS: `overscroll-behavior: none` on html/body + `contain` on
`.mob-sheet` (no pull-to-refresh reload).

### Misc
- Assets cache-busted to v=35. Deployed.
- Full design spec captured in the project's development notes.

## 2026-08-04 — Mobile selection overhaul (Follow & Pin → Two-Stage Zoom)

### Follow & Pin (commit 07d8b5c)
- **Range follows playhead everywhere**: `_mobOnTimeUpdate` (was a no-op) now slides the clip window to stay centered on the playhead during playback AND native-scrubber seeks (`seeked` listener). Follow/manual modes: any direct manipulation parks the window; browsing outside it re-engages follow.
- **Tap-to-arm edges**: quick tap on a thumb arms it — the edge rides the playhead live; tap again to pin. Tap gold fill centers the window. Tap-vs-drag threshold 10px/400ms. Armed thumb pulses gold.
- **🔁 Loop preview button**: reuses desktop `playClip()` machinery (syncs `_sliderStart/_sliderEnd` first); parks the window so looped playback can't fight pinned edges.
- **Cleanup**: removed 4 dead app.js mobile-sync helpers (`_setMobileStatus`, `_updateMobileTimes`, `_updateMobileRangeBar`, `_updateMobileDownloadBtn`) + 11 call sites — they referenced HTML IDs removed in the bottom-sheet redesign.

### Two-stage zoom v1 (commit e421928)
- View-relative timeline mapping (`_mobViewRange`), 10-min zoom, scrub-drag, playhead line on mobile timeline, 🔍/⤺ Full zoom toggle.

### Rethink — "Neighborhood First, Then In/Out" (commit 54478db)
User feedback: video buffered more, adjusting start/end seemed to change the whole clip time, stages felt entangled. Fixes:
- **Frozen view**: `_mobViewMin/Max` stored once at zoom-in, never re-derived from the clip window (the view-moving bug). Invariant: only `_mobSetViewFrozen()` writes them while zoomed.
- **Stage 1 = bracket**: fixed 600s neighborhood window on the full-movie timeline; follows playhead; fill-drag/skip slide it; thumbs + fine-tune hidden; "STEP 1/2 — pick your 10 minutes" label.
- **Stage 2 = two-phase**: clip centers in the frozen view; tap START thumb (END dims) → scrub to in-point → tap to lock; then END. Tap bar = seek; drag empty = scrub; skip nudges playhead only. "STEP 2/2" instruction label per phase.
- **Debounced seeks**: `_mobSeekTo` 40ms trailing debounce + `_mobFlushSeek` on touchend (fires final position) — fixes the byte-range seek storm on 3h movies.

### Tap fixes (commit 58e8ec5)
- Stage-2 fill-tap now seeks the playhead (was re-centering the whole window — both edges jumped).
- 10px jitter-gate in touchmove so phone-tap wobble stays a tap (arm/seek), not a drag.

### Misc
- Assets cache-busted to v=21. Deployed. Rethink + tap fixes await real-phone verification.

## 2026-07-26 — Plex OAuth Login

### OAuth PIN flow
- **Backend**: New auth routes (`/api/auth/pin`, `/api/auth/status`, `/api/auth/logout`)
- **Backend**: Token management — persists OAuth token to `/data/plex_token.json`
- **Backend**: `PLEX_TOKEN` env var still works as fallback; OAuth is optional
- **Frontend**: Login overlay with "Connect to Plex" button
- **Frontend**: PIN code display + plex.tv/link link + auto-polling for approval
- **Frontend**: If already authenticated (env var or persisted token), login is skipped entirely
- **Dockerfile**: `/data` dir added for token persistence (mount as volume)

### Misc
- `.venv/` added to `.gitignore`
- `.env.example` updated with OAuth instructions

## 2026-07-25 — Dead Proxy Cleanup + 1080p Preference (Session 3)

### Removed proxy generation (replaced by direct media streaming)
- **Backend**: Removed `_run_ffmpeg_proxy()`, `proxy_jobs` dict, 3 `/api/proxy/*` routes (POST start, GET status, GET stream)
  - Direct media streaming via `/api/media/{id}/stream` with HTTP byte-range seeking replaced proxy entirely
  - Removed `PROXY_DIR` and its mkdir
- **Frontend**: Removed `.proxy-controls` and `.proxy-info` CSS blocks (~65 lines)
- **Frontend**: Renamed `state.proxyDuration` → `state.mediaDuration` everywhere (18 occurrences)

### 1080p version preference
- `_translate_path()` now prefers 1080p (height <= 1080) Media parts when both 4K and 1080p exist
  - Collects all candidates with heights, picks first with 720 <= height <= 1080
  - Falls back to any height for 4K-only content

### Already working, now documented
- **Stay on movie after download**: `downloadClip()` preserves `_sliderStart`/`_sliderEnd`, re-enables button immediately. Detail view stays open. Already works — no code change needed.
- **`-map 0:a:0`**: First audio track only mapping was already in `_run_ffmpeg_clip()` (line 366).

### Updated roadmap
- [x] Background-safe proxy polling → **Moot** (proxy removed entirely, no polling needed)
- [x] Stay on movie after download
- [x] 1080p version preference
- [x] `-map 0:a:0` for first audio track only
- [x] Overlay scrubber handles on video → **Draggable range bar handles**
- [ ] Streamable upload — one-click upload clips to Streamable for X/Twitter sharing
- [ ] Plex OAuth login — OAuth pin flow instead of hardcoded token
- [x] Metadata embedding — embed title, season, episode, username into clip MP4 metadata

### Metadata embedding in clips
- `_run_ffmpeg_clip()` now accepts a `meta` dict from Plex metadata
- Injects `-metadata` args before the output file in the ffmpeg command
- Movies: `title`, `date` (year), `comment=Clipped with Cliparr`
- Episodes: `show` (Show - Episode), `show`, `season_number`, `episode_id`, `comment`
- Verified: "Ghost in the Shell" clip shows title, date=2015, comment in ffprobe

### Draggable range bar handles
- **CSS**: Range bar markers now interactive (16x28px, grab cursor, glow on hover)
  - Removed `pointer-events: none`, added `cursor: grab` / `cursor: grabbing`
  - `.dragging` class suppresses transitions for smooth movement
  - Bar itself clickable — snaps nearest handle to click position
- **JS**: `initRangeBarHandles()` + `initRangeBarDragGlobal()`
  - Drag start handle → seeks video to new position in real time
  - Drag end handle → updates range, no video seek
  - Click bar → snaps nearest handle and initiates drag
  - Live status text during drag: "Range: 0:45 – 1:23 (38s)"
  - Reset to "Ready" on mouseup

## 2026-07-24 — Clip Progress Bar (Session 2)

### Async Clip Generation + Progress Bar
- **Backend**: Clip generation is now async (fire-and-forget like proxy)
  - `POST /api/clip` returns immediately with `{status, filename, duration}`
  - New `_run_ffmpeg_clip()` function runs ffmpeg in background asyncio task
  - `GET /api/clip/status/{filename}` now includes `eta_seconds`
  - Idempotent: returns `"ready"` if clip already exists, `"generating"` if running
- **Frontend**: Real-time progress bar for clip encoding
  - New `#clip-progress` UI with progress bar + ETA text
  - `downloadClip()` now: start → poll every 2s → auto-download on completion
  - `pollClipStatus()` shows live percentage + ETA (e.g., "Encoding clip... 67% (ETA 20s)")
- **Verified**: 30s clip encoded in ~20s, progress tracked 0-100%, download at 200 OK through Caddy

### Proxy Range Info + Regenerate
- **Problem**: After proxy loads, no way to see what range you're previewing or regenerate from a different offset without going back to library
- **Solution**: New proxy info bar above the video showing "Preview: 0:00–10:00 of 2:27:00"
  - Regenerate input + button: type a new start minute, click Regenerate → re-encodes proxy from that offset
  - Backend: `POST /api/proxy/{id}` now accepts `?force=true` to bypass cache and regenerate
  - Range sliders default to proxy start offset, not always 0
- **Verified**: Force regenerate from start_min=2 correctly started new generation, stream serves at 200 OK

## 2026-07-23 — Initial Build (Session 1)

### Core Infrastructure
- Dockerfile: two-stage build (alpine frontend copy + python:3.12-slim with ffmpeg)
- FastAPI backend with uvicorn, httpx for Plex communication
- Vanilla HTML/CSS/JS frontend — no frameworks
- Container running on hms_media_net, port 8096

### Plex Integration
- `/api/library` — browses all movies + TV episodes (1,833 items confirmed)
- `/api/library/:id` — single item detail with file path, duration, metadata
- `/api/thumb/:id` — proxies Plex poster thumbnails through backend
- `/api/sessions` — current Plex playback state for now-playing banner
- File path translation: Plex `/data/media` → container `/media` bind mount
- Fixed: `_translate_path` now drills through `Media[0].Part[0].file` (was missing Media layer)

### Proxy Generation
- POST `/api/proxy/:id` starts ffmpeg: 640px, 12fps, CRF 30, video-only
- GET `/api/proxy/:id/status` polls progress with ETA calculation
- GET `/api/proxy/:id/stream` serves the proxy MP4
- Progress tracking via `ffmpeg -progress pipe:2` parsing `out_time_us`
- Capped at 10 minutes per generation (impractical to proxy 3-hour movies)
- Accepts `?start_min=N` to begin proxy from any offset in long movies

### Clip Generation
- POST `/api/clip` with `{media_id, start_sec, end_sec}`
- Output: 1080p h264 + AAC, single `-ss` seek, `-preset fast`, CRF 20
- GET `/api/download/:filename` serves the clip
- Max clip length: 140 seconds (X/Twitter limit)
- Verified: 5-second clip from Puparia = 2.6MB, 1080p, valid MP4

### Frontend
- immich-similar dark design system (#0d0d0d bg, #c4963b gold accent, serif titles)
- Library grid with 1,833 poster cards, lazy-loaded thumbnails
- Search filters locally as you type
- Sort dropdown: title, year (new/old), duration (longest/shortest), recently added
- Click card → detail view with title, metadata, Generate Preview button
- Proxy start offset input for long movies (default 0, accepts any minute)
- Progress bar with live percentage + ETA during proxy generation
- Video player with dual range sliders for start/end selection
- Preset buttons: -10s, +10s, 30s, 1min, 2min clips
- Download Clip button triggers browser download
- Now-playing banner polls Plex sessions every 5s, offers "Jump to clip"
- Clicking "Cliparr" title returns to library view
- Error banner with Retry button (per design plan)
- Mobile-responsive CSS (grid, flex, media queries at 768px)

### Caddy / Networking
- Route: `/cliparr` → `host.docker.internal:8096` via `handle_path`
- Container needs `--add-host=host.docker.internal:host-gateway` (Linux, not Docker Desktop)
- All frontend paths are relative (no `<base>` tag) to survive Caddy prefix stripping
- Confirmed: CSS/JS/API all load through Caddy at 200 OK
- Accessible via the Caddy `/cliparr` route.

### Critical Pitfalls Documented
1. `host.docker.internal` DNS requires `--add-host` on Linux
2. Static asset paths must be relative (Caddy `handle_path` strips prefix)
3. Dockerfile two-stage copy results in `/app/static/static/` nesting — `STATIC_DIR` must match
4. Caddy `reload` sometimes reports "config unchanged" — use `restart` when routes don't take
5. Plex metadata nests `Part` under `Media[0]`, not directly in the item dict

### Git History
The full history is preserved in the repo. Commit SHAs were rewritten in
2026-08-12 (`git filter-repo`) to purge internal agent-plan files, so early
SHAs referenced in older notes are not stable.

### Tested End-to-End
1. Browse library → 1,833 items with thumbnails ✓
2. Sort by duration, year, title ✓
3. Click Puparia (3min, 4K VP9) → detail view ✓
4. Generate Preview → progress bar 0%→100% with ETA ✓
5. Video player loads proxy MP4 ✓
6. Set range with sliders + presets ✓
7. Download Clip → browser downloads valid 1080p MP4 ✓

### Roadmap
- [x] Clip history gallery — list all generated clips with players, download, delete
- [ ] Streamable upload — one-click upload clips to Streamable for X/Twitter sharing
- [ ] Plex OAuth login — OAuth pin flow instead of hardcoded token
- [x] Metadata embedding — embed title, season, episode, username into clip MP4 metadata
- [ ] Overlay scrubber handles on video (future drag-handle UI)
- [ ] Streamable upload — one-click upload clips to Streamable for X/Twitter sharing
- [ ] Plex OAuth login — OAuth pin flow instead of hardcoded token
