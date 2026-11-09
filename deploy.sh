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

# Keep the image that is serving right now addressable for rollback.
if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
  docker tag "$IMAGE:latest" "$IMAGE:prev"
fi

echo "==> building $IMAGE"
docker build -t "$IMAGE" .

run_container() {  # $1 = image
  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
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
    if curl -fsS -o /dev/null http://127.0.0.1:8096/ 2>/dev/null; then
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
exit 1
