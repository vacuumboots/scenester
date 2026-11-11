# Both base images are pinned by digest, and the apt packages by version.
#
# Why here specifically: the VAAPI path depends on filter-graph negotiation in a
# particular ffmpeg build. Haswell's i965 driver hands back a corrupt NV12
# surface from hwdownload, which turns every encode pure green unless the graph
# forces a colour conversion right after the download. A floating
# `apt-get install ffmpeg` can change that behaviour without changing a line of
# code, so the build input is pinned and bumped deliberately — then re-checked
# with the green-frame recipe before shipping.
#
# Bumping: change the digest/version, build, then run the colour check from
# homelab-administration → references/vaapi-ffmpeg-green-fix.md.

# Stage 1: frontend (vanilla, no build step — just copy)
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f AS frontend
WORKDIR /app
COPY frontend/ ./static/

# Stage 2: runtime
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# i965-va-driver + libva = VAAPI hardware-accelerated clipping on the Haswell
# iGPU (render node /dev/dri/renderD128 passed at runtime).
# --no-install-recommends keeps the ffmpeg Recommends chain out of the image.
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
ARG I965_VA_VERSION=2.4.1+dfsg1-2
ARG LIBVA_DRM_VERSION=2.22.0-3

RUN apt-get update && apt-get install -y --no-install-recommends \
        "ffmpeg=${FFMPEG_VERSION}" \
        "i965-va-driver=${I965_VA_VERSION}" \
        "libva-drm2=${LIBVA_DRM_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Hashed lockfile instead of the >= ranges: --require-hashes makes pip refuse a
# wheel whose bytes are not the ones that were resolved, so a compromised or
# silently-retagged release cannot enter the image. Regenerate with
#   pip-compile --generate-hashes --output-file requirements.lock.txt requirements.txt
# Dependencies come before the app code, so this layer is cached: a JS or CSS
# change no longer re-runs pip (that was most of the old 10-15 minute build).
COPY backend/requirements.lock.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock.txt

COPY backend/ ./

# Frontend LAST — it changes on nearly every UI deploy, so nothing expensive
# may sit below it.
COPY --from=frontend /app/static ./static

# Runtime is unprivileged. /app stays root-owned and is only readable, which is
# all the app needs: Python never writes bytecode (PYTHONDONTWRITEBYTECODE) and
# every writable path is a directory it must own.
#   /tmp/clips  finished clips and .part temp files (bind mount in production)
#   /data       Plex OAuth token + frame/thumbnail cache (bind mount)
# Running as uid 1000 means files created in those binds are owned by the host
# user, so no privileged chown before a rebuild and no root-owned leftovers.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin scenester \
    && mkdir -p /tmp/clips /data/cache/frames /data/cache/thumbs \
    && chown -R 1000:1000 /data /tmp/clips
USER 1000:1000

EXPOSE 8096

# Liveness signal for `--restart` / `docker ps`: a hung-but-listening uvicorn
# never trips a restart without this. python is always present; curl is not.
# HOME is /tmp because some libraries want a writable home and there is no real
# one for a --no-create-home account.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp

LABEL org.opencontainers.image.title="Scenester" \
      org.opencontainers.image.description="Plex clip maker - browse, scrub, mark, download" \
      org.opencontainers.image.source="https://github.com/vacuumboots/scenester"

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8096/healthz', timeout=4)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8096"]
