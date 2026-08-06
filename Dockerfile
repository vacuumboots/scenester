# Stage 1: frontend (vanilla, no build needed — just copy)
FROM alpine:3.20 AS frontend
WORKDIR /app
COPY frontend/ ./static/

# Stage 2: runtime
FROM python:3.12-slim
# i965-va-driver + libva = VAAPI hardware-accelerated clipping on the
# Haswell iGPU (render node /dev/dri/renderD128 passed at runtime).
RUN apt-get update && apt-get install -y ffmpeg i965-va-driver libva-drm2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=frontend /app/static ./static
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
RUN mkdir -p /tmp/clips /data
EXPOSE 8096
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8096"]
