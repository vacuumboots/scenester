#!/usr/bin/env bash
# Rebuild the Scenester image and recreate the container.
#
# There is no compose file — the container was created by hand, so the flags
# live here instead of being retyped from memory on every deploy.
#
# The three things that are easy to get wrong:
#   --device /dev/dri/renderD128          VAAPI hardware clipping (Haswell iGPU)
#   --add-host host.docker.internal       Linux Docker has no host.docker.internal
#                                         without this, and Plex is reached by name
#   -v $APP_DIR/data:/data                frame + thumbnail cache lives here; a
#                                         --rm/blank volume makes every scroll re-extract
#
# Recreate is rollback-safe: the pre-deploy image is tagged :prev first, and if
# the new container does not answer within 30s the previous image is started
# instead. Before that, a failed `docker run` left the host with NO container.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
IMAGE=scenester
NAME=scenester
APP_DIR=/opt/hms-docker/apps/scenester

cd "$REPO"

if [ ! -f .env ]; then
  echo "missing .env (PLEX_URL / PLEX_TOKEN) — see .env.example" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found — the health probe needs it" >&2
  exit 1
fi

# Bind-mount sources must exist, or Docker creates them root-owned.
mkdir -p "$APP_DIR/clips" "$APP_DIR/data"

# The container and image were called cliparr before the rename. Retire the
# old container explicitly: it holds port 8096, so a rebuild would fail to bind.
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
if ss -ltn 2>/dev/null | grep -q ":8096 " && ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "==> port 8096 is held by something that is not $NAME:" >&2
  ss -ltnp 2>/dev/null | grep ":8096 " >&2
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
    --memory=3g --memory-swap=3g --cpus=3 --pids-limit=512 \
    --network hms_media_net \
    --device /dev/dri/renderD128 \
    --add-host=host.docker.internal:host-gateway \
    --env-file .env \
    --log-opt max-size=10m --log-opt max-file=3 \
    -p 8096:8096 \
    -v /mnt/DriveA/hms-docker/media_data/_library:/media:ro \
    -v "$APP_DIR/clips:/tmp/clips" \
    -v "$APP_DIR/data:/data" \
    "$1" >/dev/null
}

wait_ready() {
  for i in $(seq 1 30); do
    # /healthz, not "/": "/" is a static file that answers 200 with Plex
    # unreachable, /media unmounted, /data unwritable or ffmpeg missing.
    if curl -fsS -o /dev/null http://127.0.0.1:8096/healthz 2>/dev/null; then
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
