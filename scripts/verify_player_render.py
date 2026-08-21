#!/usr/bin/env python3
"""Player-render verification gate for Scenester.

Catches the class of bug where the playing video is visually modified by
an overlay layer — e.g. the v=70 scrim bug: a 60% black background on
the loading/error wrapper that stayed visible over every playing video,
dimming it to ~40% brightness vs Plex/VLC.

Two checks:

  1. STRUCTURAL — while the video plays, no element overlapping the video
     rect may have a non-transparent background (or a dimming filter on
     the video / player card). Scrims belong on transient message cards,
     never on a wrapper that stays visible.

  2. PIXEL — the video area's mean luminance must stay within tolerance
     of an ffmpeg-extracted frame from the same source at the same time.
     A veil/filter/opacity regression drops it to ~40%; the threshold is
     set so any render below ~60% of source brightness fails.

Usage:
  python3 scripts/verify_player_render.py [--url http://localhost:8096]
                                          [--media-id <id>] [--t <sec>]

Defaults: --url http://localhost:8096, first movie in the library,
t = min(30, max(5, 5% of runtime)). Exit 0 = PASS, 1 = FAIL (gates deploys).
Requires: geckodriver + Firefox (headless), ffmpeg, PIL. Media files must
be readable at the host path (see --media-root).
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request

from PIL import Image

MEDIA_ROOT_DEFAULT = "/mnt/DriveA/hms-docker/media_data/_library"
MIN_LUMINANCE_RATIO = 0.60  # browser render must stay >= 60% of source brightness
SETTLE_SECONDS = 1.5


def js(driver, expr):
    return driver.execute_script("return (%s);" % expr)


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.load(r)


def find_source_file(item, media_root):
    """Resolve the item's file path to a host-readable path."""
    p = item.get("file_path") or ""
    if p.startswith("/media/"):
        p = media_root + p[len("/media"):]
    return p


def mean_luminance(im):
    """Mean gray value of a PIL 'L' image via its histogram."""
    hist = im.histogram()
    return sum(i * c for i, c in enumerate(hist)) / (im.width * im.height)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8096")
    ap.add_argument("--media-id", type=int, default=None)
    ap.add_argument("--t", type=float, default=None)
    ap.add_argument("--media-root", default=MEDIA_ROOT_DEFAULT)
    args = ap.parse_args()

    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options
    from selenium.webdriver.firefox.service import Service

    base = args.url.rstrip("/")
    o = Options()
    o.add_argument("--headless")
    o.add_argument("--width=1920")
    o.add_argument("--height=1080")
    driver = webdriver.Firefox(service=Service("/snap/bin/geckodriver"), options=o)
    driver.set_window_size(1920, 1080)

    failures = []

    try:
        # ── Pick the media ────────────────────────────────────────────────
        items = fetch_json(base + "/api/library")["items"]
        if args.media_id:
            item = next((i for i in items if i.get("media_id") == args.media_id), None)
            if not item:
                print("FAIL: media_id %s not found in library" % args.media_id)
                return 1
        else:
            item = next((i for i in items if i.get("file_path")), items[0])
        print("media: %s (id=%s)" % (item.get("title"), item.get("media_id")))

        dur_s = (item.get("duration") or 0) / 1000.0
        t = args.t if args.t is not None else min(30, max(5, dur_s * 0.05))
        t = min(t, max(1, dur_s - 2))

        src = find_source_file(item, args.media_root)
        if not src or not __import__("os").path.exists(src):
            print("SKIP pixel check: source file not readable at %s" % src)
            src = None

        # ── Open the detail view ──────────────────────────────────────────
        driver.get(base + "/")
        time.sleep(2.5)
        driver.find_element("css selector", "#library-grid a, #library-grid .card").click()
        # wait for video metadata (readyState >= 2), up to 25s
        for _ in range(50):
            rs = js(driver, "document.getElementById('preview-video')?.readyState || 0")
            if rs >= 2:
                break
            time.sleep(0.5)
        else:
            print("FAIL: video never reached readyState 2")
            return 1

        # seek to a content frame and let it render
        js(driver, "document.getElementById('preview-video').currentTime = %s" % t)
        time.sleep(SETTLE_SECONDS)

        # ── Check 1: structural overlay invariant ─────────────────────────
        overlay = js(driver, """
        (() => {
          const v = document.getElementById('preview-video');
          const vr = v.getBoundingClientRect();
          const offenders = [];
          for (const el of document.querySelectorAll('.player-card *')) {
            if (el === v) continue;                                   // the video's own bg is the letterbox backing
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;            // hidden
            if (r.bottom <= vr.top || r.top >= vr.bottom) continue; // no overlap
            if (r.right <= vr.left || r.left >= vr.right) continue;
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              offenders.push((el.id ? '#' + el.id : '') + (el.className ? '.' + el.className : '') || el.tagName + ' :: ' + bg);
            }
          }
          const vf = getComputedStyle(v).filter;
          const cf = getComputedStyle(document.querySelector('.player-card')).filter;
          return { offenders, videoFilter: vf, cardFilter: cf };
        })()
        """)
        if overlay["offenders"]:
            failures.append("overlay(s) with non-transparent background over the playing video: %s"
                            % ", ".join(overlay["offenders"]))
            print("FAIL check 1 (structural):", ", ".join(overlay["offenders"]))
        elif overlay["videoFilter"] not in ("none", "") or overlay["cardFilter"] not in ("none", ""):
            failures.append("dimming filter on video/card: video=%s card=%s"
                            % (overlay["videoFilter"], overlay["cardFilter"]))
            print("FAIL check 1 (structural): dimming filter video=%s card=%s"
                  % (overlay["videoFilter"], overlay["cardFilter"]))
        else:
            print("PASS check 1 (structural): no overlay or filter over the playing video")

        # ── Check 2: pixel luminance vs source frame ──────────────────────
        if src:
            frame_path = "/tmp/verify_player_src_frame.jpg"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t), "-i", src,
                            "-frames:v", "1", "-q:v", "2", frame_path], check=True)
            src_im = Image.open(frame_path).convert("L").resize((64, 36))
            src_mean = mean_luminance(src_im)

            vr = js(driver, "(() => { const r = document.getElementById('preview-video').getBoundingClientRect(); "
                            "return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()")
            shot = "/tmp/verify_player_browser.png"
            driver.save_screenshot(shot)
            shot_im = Image.open(shot).convert("L")
            crop = shot_im.crop((vr["x"], vr["y"], vr["x"] + vr["w"], vr["y"] + vr["h"]))
            crop = crop.resize((64, 36))
            browser_mean = mean_luminance(crop)

            ratio = browser_mean / src_mean if src_mean > 0 else 1.0
            print("check 2 (pixel): source=%.1f browser=%.1f ratio=%.2f"
                  % (src_mean, browser_mean, ratio))
            if ratio < MIN_LUMINANCE_RATIO:
                failures.append("video renders at %.0f%% of source brightness (threshold %.0f%%) — "
                                "an overlay/filter is dimming it" % (ratio * 100, MIN_LUMINANCE_RATIO * 100))
                print("FAIL check 2 (pixel): dimmed to %d%% of source" % int(ratio * 100))
            else:
                print("PASS check 2 (pixel): brightness within tolerance")
    finally:
        driver.quit()

    if failures:
        print("\nRESULT: FAIL")
        for f in failures:
            print("  -", f)
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
