# Stage 1: frontend (vanilla, no build needed — just copy)
FROM alpine:3.20 AS frontend
WORKDIR /app
COPY frontend/ ./static/

# Stage 2: runtime
FROM python:3.12-slim
# i965-va-driver + libva = VAAPI hardware-accelerated clipping on the
# Haswell iGPU (render node /dev/dri/renderD128 passed at runtime).
# --no-install-recommends keeps the ffmpeg Recommends chain out of the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg i965-va-driver libva-drm2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Dependencies first: this layer changes only when requirements.txt does, so a
# JS/CSS edit no longer re-runs pip install (most of the old 10-15 min build).
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./

# Frontend LAST — it changes on nearly every UI deploy, so nothing expensive
# may sit below it.
COPY --from=frontend /app/static ./static

RUN mkdir -p /tmp/clips /data /data/cache/frames /data/cache/thumbs
EXPOSE 8096

# Liveness signal for `--restart` / `docker ps`: a hung-but-listening uvicorn
# never trips a restart without this. python is always present; curl is not.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

LABEL org.opencontainers.image.title="Scenester" \
      org.opencontainers.image.description="Plex clip maker - browse, scrub, mark, download" \
      org.opencontainers.image.source="https://github.com/vacuumboots/scenester"

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8096/healthz', timeout=4)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8096"]
