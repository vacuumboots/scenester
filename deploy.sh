#!/usr/bin/env bash
# Rebuild the Scenester image and recreate the container.
#
# There is no compose file — the container was created by hand, so the flags
# live here instead of being retyped from memory on every deploy.
#
# The four things that are easy to get wrong:
#   --device /dev/dri/renderD128          VAAPI hardware clipping (Haswell iGPU)
#   --add-host host.docker.internal       Linux Docker has no host.docker.internal
#                                         without this, and Plex is reached by name
#   -v $APP_DIR/data:/data                frame + thumbnail cache lives here; a
#                                         --rm/blank volume makes every scroll re-extract
#   NO -p FLAG                            the port is NOT published. Caddy joins
#                                         hms_media_net and dials scenester:8096
#                                         by container name, so the app is not
#                                         reachable from the LAN at all — only
#                                         through the reverse proxy, which is the
#                                         one place TLS and the access gate live.
#                                         Publishing it again re-opens the whole
#                                         library (streaming, clip delete, both
#                                         encode slots) to anything on the LAN.
#
# Recreate is rollback-safe: the pre-deploy image is tagged :prev first, and if
# the new container does not answer within 30s the previous image is started
# instead. Before that, a failed `docker run` left the host with NO container.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
IMAGE=scenester
NAME=scenester
APP_DIR=/opt/hms-docker/apps/scenester

# The container runs as uid 1000 (no root) and needs the render group to open
# /dev/dri/renderD128. Resolve the host gid instead of hardcoding 992, and fall
# back to the Debian default if getent is unavailable.
RENDER_GID="$(getent group render 2>/dev/null | cut -d: -f3)"
RENDER_GID="${RENDER_GID:-992}"

cd "$REPO"

if [ ! -f .env ]; then
  echo "missing .env (PLEX_URL / PLEX_TOKEN) — see .env.example" >&2
  exit 1
fi

# Bind-mount sources must exist, or Docker creates them root-owned.
mkdir -p "$APP_DIR/clips" "$APP_DIR/data"

# The container runs as uid 1000. Root-owned leftovers (they exist: an earlier
# root container wrote them) are unwritable, and the failure lands at the first
# frame request rather than at boot, so check before touching anything.
stray="$(find "$APP_DIR/clips" "$APP_DIR/data" ! -user 1000 -print -quit 2>/dev/null || true)"
if [ -n "$stray" ]; then
  echo "==> $stray is not owned by uid 1000, but the container runs as 1000:" >&2
  echo "    docker run --rm --privileged -v /:/host alpine chroot /host chown -R 1000:1000 $APP_DIR" >&2
  exit 1
fi

# The container and image were called cliparr before the rename. Retire the old
# container explicitly: an old one still joins the network under that name.
if docker ps -a --format '{{.Names}}' | grep -qx cliparr; then
  echo "==> removing legacy container 'cliparr'"
  docker rm -f cliparr >/dev/null
fi

# Environment preflight before anything is touched. A rollback re-runs the
# same docker run, so an environment fault (device gone, port held) would fail
# twice and leave no container at all.
if [ ! -e /dev/dri/renderD128 ]; then
  echo "==> WARNING: /dev/dri/renderD128 missing - clips will use the slow x264 tier" >&2
fi
# Caddy reaches the container by name over this network, so it must exist before
# a recreate; without it the container starts and every request 502s.
if ! docker network inspect hms_media_net >/dev/null 2>&1; then
  echo "hms_media_net does not exist — Caddy could not reach $NAME" >&2
  exit 1
fi

# Keep the image that is serving RIGHT NOW addressable for rollback. Tagging
# :latest before the build (the old behaviour) meant a failed deploy left
# :latest on the broken image, so the next run saved that as :prev.
if docker inspect "$NAME" >/dev/null 2>&1; then
  docker tag "$(docker inspect -f '{{.Image}}' "$NAME")" "$IMAGE:prev"
elif docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  docker tag "$IMAGE:latest" "$IMAGE:prev"
fi

echo "==> building $IMAGE"
docker build -t "$IMAGE" .

run_container() {  # $1 = image
  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    --init \
    --user 1000:1000 \
    --group-add "$RENDER_GID" \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --memory=3g --memory-swap=3g --cpus=3 --pids-limit=512 \
    --network hms_media_net \
    --device /dev/dri/renderD128 \
    --add-host=host.docker.internal:host-gateway \
    --env-file .env \
    --log-opt max-size=10m --log-opt max-file=3 \
    -v /mnt/DriveA/hms-docker/media_data/_library:/media:ro \
    -v "$APP_DIR/clips:/tmp/clips" \
    -v "$APP_DIR/data:/data" \
    "$1" >/dev/null
}

wait_ready() {
  # Probe from INSIDE the container: the port is no longer published on the
  # host, so 127.0.0.1:8096 from the host is nothing. python is guaranteed to
  # exist (it is the runtime); /healthz is the real readiness check — "/" is a
  # static file that answers 200 with Plex unreachable, /media unmounted,
  # /data unwritable or ffmpeg missing. urlopen raises on 503, which is what we
  # want: unhealthy must read as not-ready.
  for i in $(seq 1 30); do
    if docker exec "$NAME" python -c \
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8096/healthz', timeout=3)" \
        >/dev/null 2>&1; then
      echo "==> up after ${i}s"
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "==> recreating $NAME"
docker rm -f "$NAME" >/dev/null 2>&1 || true
if run_container "$IMAGE" && wait_ready; then
  # Publishing a host port again silently re-exposes the whole library on the
  # LAN; nothing needs it, Caddy dials the container name.
  if [ -n "$(docker port "$NAME" 2>/dev/null)" ]; then
    echo "==> WARNING: $NAME publishes a host port — the reverse proxy does not need it" >&2
    docker port "$NAME" >&2
  fi
  # What users experience is reachability THROUGH the proxy: a healthy container
  # behind a stale route is indistinguishable from an outage from the outside.
  if docker inspect caddy >/dev/null 2>&1 &&
     ! docker exec caddy wget -qO- --timeout=3 "http://$NAME:8096/healthz" >/dev/null 2>&1; then
    echo "==> WARNING: caddy cannot reach http://$NAME:8096 — check the /scenester route" >&2
  fi
  exit 0
fi

echo "==> $NAME did NOT come up; last logs:" >&2
docker logs --tail 40 "$NAME" >&2 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true

if docker image inspect "$IMAGE:prev" >/dev/null 2>&1; then
  echo "==> rolling back to $IMAGE:prev" >&2
  if run_container "$IMAGE:prev" && wait_ready; then
    echo "==> rolled back — fix the build before retrying" >&2
  else
    echo "==> rollback FAILED — $NAME is down" >&2
    docker logs --tail 40 "$NAME" >&2 || true
  fi
else
  echo "==> no $IMAGE:prev image to roll back to — $NAME is down" >&2
fi

# Put :latest back on the last known-good image so the NEXT deploy does not
# save the broken build as :prev.
if docker image inspect "$IMAGE:prev" >/dev/null 2>&1; then
  docker tag "$IMAGE:prev" "$IMAGE:latest"
  echo "==> :latest restored to the previous image" >&2
fi
exit 1
