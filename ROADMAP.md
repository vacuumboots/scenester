# Roadmap

Scenester is a tool I actually use to clip films out of my Plex library, not a
demo built to look like one. This roadmap is ordered by what a stranger hits
first: the repo, the README, the code, then the details.

Last updated 2026-11-10. Current state: `main` green in CI, 80+ backend tests,
`ghcr.io/vacuumboots/scenester` publishing on every passing push, container
healthy on the host for weeks at a time.

## How this is prioritised

- **P0 — liability.** Something a careful reader can find that undercuts
  everything else in the repo. Cheap to fix, expensive to be caught by.
- **P1 — first 90 seconds.** What a reviewer sees before deciding whether to
  read further. Highest signal per hour.
- **P2 — depth.** The parts an interviewer will actually probe. Real defects
  and real engineering, in the areas that show judgement.
- **P3 — distribution.** Pointless before P0 and P1 are done, because it sends
  traffic at a repo that is not ready for it.

---

## P0 — Hardening (do this first)

These are small, mechanical, and they remove the only things in the repo that
could read as carelessness. One maintenance window, roughly half a day.

- [ ] **Stop publishing the container port on every interface.** Caddy dials
      `scenester:8096` over the shared Docker network instead of
      `host.docker.internal:8096`, `-p 8096:8096` comes out of `deploy.sh`, and
      the health probe moves to `docker exec`. Both containers are already on
      the same network, so this is three edits and a Caddy reload.
- [ ] **Add the API access-token layer.** `SCENESTER_ACCESS_TOKEN` compared with
      `hmac.compare_digest` on `/api/*`, exempting `/api/auth/*`. The PIN flow
      also needs binding to the client that opened it, so a stranger cannot
      create a PIN and approve it with their own Plex account.
- [ ] **Non-root.** `scenester` user in the image, `chown` of `CLIPS_DIR` and
      `/data`, `--user`, `--cap-drop=ALL`,
      `--security-opt=no-new-privileges`, keeping only
      `--device /dev/dri/renderD128`. Also fixes the root-owned cache files
      that make host-side cleanup need a privileged chroot.
- [ ] **Resource limits.** `--memory=2g --memory-swap=2g --cpus=3
      --pids-limit=256` plus matching `deploy.resources.limits` in the compose
      example. Three of four cores, deliberately leaving one for Plex. A clip
      should not be able to starve the transcoder, and a leak should hit a wall
      instead of the host.
- [ ] **Delete `gitignore_human_handoff/` and rotate the token inside it.**
      Nothing in the repo needs it. It was never committed and never reached
      an image, but it travels with any rsync of the working tree, and this
      tree gets copied around during development.
- [ ] **Pin what the build depends on.** Base images by digest, the apt layer,
      and a hashed lockfile for Python. Not hygiene for its own sake: the
      VAAPI green-frame fix depends on filter-graph negotiation in a specific
      ffmpeg build, so an unpinned `apt-get install ffmpeg` can silently
      reintroduce a visual corruption bug that took a session to find.

## P1 — The first 90 seconds

- [ ] **A demo loop above the fold.** 60–90 seconds, under 8MB, committed:
      browse, quote-search a line, mark a range, clip, download. Screenshots
      prove the UI exists; a loop proves the thing works. This is the single
      highest-value item on the list for a reader who will not run Docker.
- [ ] **Ship a `docker-compose.yml`.** Today the README says "add it to your
      compose file" and hands over a `docker run` block. A compose file is what
      reviewers expect, it makes self-hosting one command, and it gives the
      resource limits somewhere to live.
- [ ] **Restructure the README** into: one-line pitch, demo loop, what it does,
      architecture diagram, design decisions, measured numbers, limitations,
      setup, configuration table, roadmap. Mermaid diagram, not an image, so it
      stays readable and diffable.
- [ ] **A configuration table and a complete `.env.example`.** There are about
      twelve settings and the example documents three. `SCENESTER_FRAME_CONCURRENCY`
      is the single lever that controls the documented load spike and it is
      currently undiscoverable.
- [ ] **Badges that mean something**: CI status, image publish, GHCR pull
      count, licence, Python version, test count. Screen-reader-friendly alt
      text on each.
- [ ] **Move the working docs into `docs/`.** `docs/ARCHITECTURE.md`,
      `docs/SECURITY.md`, `docs/audits/2026-11-08-review.md`. The audit is a
      real asset — it shows the discipline of reviewing my own work and finding
      four defects that mattered — but only once its open items are closed.
      It gets a resolution-status header at that point, not before.
- [ ] **Track `CHANGELOG.md` and cut releases.** Tag `v1.0.0`, publish a GitHub
      Release whose notes point at the GHCR digest. Release notes are the
      cheapest maturity signal a repo can carry, and right now the changelog is
      gitignored as a working file.
- [ ] **Surface the version at runtime** in `/healthz` and the UI footer so a
      bug report can name a build.
- [ ] **Decide what to do with the "Proudly vibecoded with Deepseek" banner.**
      My recommendation: keep the honesty, move it. It is currently the second
      thing in the README, ahead of any description of what the tool does, and
      as a first impression it invites a reader to discount the work before
      they have seen it. Put it near the bottom under "How this was built",
      alongside what the model wrote, what I specified, and what I had to debug
      myself. Same disclosure, better sequencing: the tool first, the tooling
      second. Reversible if you disagree, it is one line either way.

## P2 — Depth

The honest engineering. These are the items an interviewer will pull on,
because each one is a defect class rather than a feature.

- [ ] **Multi-part films.** Eight items in the library are multi-part (`La Flor`
      is eight parts). The path translation returns one part while the timeline
      uses the whole-item runtime, so anything past part one seeks past EOF.
      Fix is per-part addressing: map item time to (part, offset) and clip
      within the part, with the timeline showing cumulative parts.
- [ ] **`.ass`/`.ssa` subtitles.** Currently only `.srt` is parsed. One
      directory has `.ass` only and about a quarter of titles have no subtitle
      file at all. Routing through ffmpeg's subtitles filter, instead of the
      hand-rolled SRT parser, gets styled subtitles and removes a parser.
- [ ] **Cancellable Quick Clip.** An abandoned export keeps encoding and
      downloads up to ten minutes later. The export path already got a
      cancellation fix; Quick Clip did not.
- [ ] **A real queue instead of semaphores.** Two semaphores bound fan-out but
      not footprint. A supervised FIFO with a per-client quota, queue depth in
      `/healthz`, and a deadline on every subprocess would make the load
      behaviour a design instead of a hope.
- [ ] **`/metrics` and structured logs.** Encode duration by tier (VAAPI vs
      libx264), cache hit rate, queue depth, request timing. This is what turns
      "feels faster" into a number I can quote.
- [ ] **Graceful shutdown.** Drain in-flight encodes, remove `.part` leftovers,
      exit clean. The `.part` + ffprobe promotion already makes a crash safe;
      this makes a restart cheap.
- [ ] **Coverage in CI, plus the tests that are missing.** Coverage report,
      target 80% on the backend, and the specific gaps: `_env` precedence
      (`SCENESTER_*` beating `CLIPARR_*`) is a documented compatibility promise
      with no test behind it, and Pydantic validation of clip ranges deserves
      property-based tests rather than example-based ones.
- [ ] **Frontend tests.** There is no frontend test framework at all — CI only
      syntax-checks the JS. A headless Playwright smoke of the clip flow,
      running in CI, would catch the class of regression that currently only
      real-device testing catches.
- [ ] **Accessibility pass.** Keyboard traversal of the mark/fine-tune flow,
      `aria-label` on every icon control, a 44px touch floor enforced in CSS
      rather than by convention, visible focus rings. The delete control was
      once a 22x20px unlabelled x next to Download; that was found by review,
      not by a test, which is the point of adding one.

## P3 — Distribution

- [ ] **Write it up on returnspace.net** — "Making Plex clip encoding 10x
      faster on a 2014 iGPU". The interesting part is not the speedup, it is
      the pure-green encodes caused by a corrupt NV12 surface coming back from
      `hwdownload` on Haswell, and the `format=yuv420p` fix that forces
      swscale. That is a debugging story with a measurement at the end, which
      is a much better artifact than a feature list.
- [ ] **An `awesome-selfhosted` PR and one r/selfhosted post.** Not for stars;
      for the fact that other people's setups will find the edges mine did not.
- [ ] **An OG image and per-screenshot descriptions** so shared links preview
      deliberately instead of cropping the first screenshot.

---

## Resume bullets (keep this current as items ship)

Written to be pasted, with numbers that are measured rather than estimated:

- Built and shipped a self-hosted Plex clipping tool (FastAPI, vanilla JS,
  Docker) that streams, scrubs, and exports frame-accurate 1080p clips from a
  library of 2,000+ films, used daily on desktop and mobile.
- Cut clip export time roughly 10x (111s to 11s for a 60s clip) by routing
  decode, scale and encode through VAAPI on a Haswell iGPU, with automatic
  tiered fallback to CPU when the source codec or hardware cannot be used.
- Diagnosed and fixed a pure-green-encode defect caused by a corrupt NV12
  surface returning from `hwdownload` on i965, by forcing colour conversion
  immediately after download; documented the diagnostic method as a reusable
  recipe.
- Removed a class of silent corruption in exports: artefacts are written to a
  `.part` file, verified with `ffprobe` for a positive duration, and only then
  promoted, after finding that `-movflags +faststart` leaves a playable-looking
  file no player can open when an encode is killed.
- Added 80+ backend tests covering artefact integrity, request validation,
  filename uniqueness across non-Latin and duplicate titles, and readiness
  reporting; gated image publishing on a passing test run so a red build cannot
  overwrite `:latest`.
- Hardened the deployment: container off the published host port behind a
  reverse proxy on a shared Docker network, non-root with all capabilities
  dropped, shared-secret API layer, and CPU/memory limits so an export cannot
  starve the host's transcoder.

## Explicit non-goals

- Multiple users, OIDC, or a hosted SaaS version. It is one household's tool.
- Kubernetes, Helm, or an operator. One container on one host, on purpose.
- A native mobile app. The PWA is already installed on the phone it is used
  from.
- Streamable upload / share targets. Cancelled: Streamable no longer hosts
  media. A share target is an open question, not a backlog item.

## Order and effort

| Phase | Effort | When |
|---|---|---|
| P0 hardening | ~4-6 h | One window, before anything else |
| P1 first 90 seconds | ~6-10 h | This week |
| P2 depth | ~3-4 evenings | Ongoing, one item per sitting |
| P3 distribution | ~2-3 h plus publishing | After P1 |

The ordering is deliberate in one respect only: P0 is not about polish. It is
the only phase where the cost of a reader finding it out is higher than the
cost of fixing it.
