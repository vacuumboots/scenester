#!/usr/bin/env python3
"""Record the README's demo loop by driving a real Scenester in headless Chrome.

No screen-recording permission and no window: navigate over the Chrome DevTools
Protocol, click the app's own buttons, capture frames, and let ffmpeg assemble
them. The loop in the README was produced by this script against a live instance
with a 1,920-film Plex library, which is why the numbers in it are real.

    export SCENESTER_URL=https://your-host/scenester/
    export SCENESTER_ACCESS_TOKEN=...        # omit if the access gate is off
    python3 scripts/record_demo.py            # frames land in ./demo/frames
    ffmpeg -y -framerate 9 -i demo/frames/f%05d.png \
      -vf "scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
      -loop 0 screenshots/demo.gif

Requires: pip install websocket-client, and Chrome at the CHROME path below.
Use an interpreter that actually has it: on a Homebrew Python (externally
managed) `pip install` fails or installs somewhere else, and the error is a bare
`ModuleNotFoundError` several frames later. `python3 -c "import websocket"`
first.
"""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

try:
    import websocket
except ModuleNotFoundError:  # pragma: no cover - operator error, not a code path
    raise SystemExit(
        "this script needs websocket-client: pip install websocket-client\n"
        "and an interpreter that can see it (python3 -c 'import websocket')."
    )

CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
PORT = int(os.environ.get("CDP_PORT", "9226"))
WIDTH, HEIGHT = 1440, 1120
FRAME_INTERVAL = 0.11  # ~9 fps in the assembled GIF


class CDP:
    """Minimal synchronous CDP client: one command, one reply."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.n = 0

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def js(self, expr):
        r = self.send(
            "Runtime.evaluate",
            expression=expr,
            returnByValue=True,
            awaitPromise=True,
            userGesture=True,
        )
        return r.get("result", {}).get("value")


def connect(url):
    host = urllib.parse.urlparse(url).hostname
    scheme = urllib.parse.urlparse(url).scheme
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2) as r:
                pages = [t for t in json.loads(r.read()) if t["type"] == "page"]
            if pages:
                return pages[0]["webSocketDebuggerUrl"], host, scheme
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit(f"no CDP page target on 127.0.0.1:{PORT}")


def main():
    url = os.environ.get("SCENESTER_URL", "").rstrip("/") + "/"
    token = os.environ.get("SCENESTER_ACCESS_TOKEN", "")
    if not url.startswith("http"):
        raise SystemExit("set SCENESTER_URL, e.g. https://host/scenester/")

    out = os.path.abspath(os.environ.get("DEMO_OUT", "demo"))
    frames_dir = os.path.join(out, "frames")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(frames_dir, exist_ok=True)

    chrome = subprocess.Popen(
        [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
         f"--user-data-dir={os.path.join(out, 'profile')}",
         f"--window-size={WIDTH},{HEIGHT}", "--force-device-scale-factor=1",
         "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url, host, scheme = connect(url)
        c = CDP(ws_url)
        c.send("Page.enable")
        c.send("Runtime.enable")
        c.send("Network.enable")
        c.send("Emulation.setDeviceMetricsOverride", width=WIDTH, height=HEIGHT,
               deviceScaleFactor=1, mobile=False)

        if token:
            # Unlock silently with the cookie /api/auth/unlock would have set:
            # the loop should show the product, not a secret being typed.
            c.send("Network.setCookie",
                   name="scenester_access",
                   value=hashlib.sha256(("scenester-access:" + token).encode()).hexdigest(),
                   domain=host, path="/", secure=(scheme == "https"), httpOnly=True)

        c.send("Page.navigate", url=url)
        time.sleep(1.2)

        state = {"i": 0}

        def frames(n, step=FRAME_INTERVAL):
            for _ in range(n):
                data = c.send("Page.captureScreenshot", format="png")["data"]
                with open(os.path.join(frames_dir, f"f{state['i']:05d}.png"), "wb") as fh:
                    fh.write(base64.b64decode(data))
                state["i"] += 1
                time.sleep(step)

        # 1. the library
        for _ in range(80):
            if (c.js("document.querySelectorAll('#library-grid .card').length") or 0) > 20:
                break
            time.sleep(0.25)
        frames(8)
        for _ in range(6):
            c.js("window.scrollBy(0, 260)")
            frames(2, 0.09)
        c.js("window.scrollTo(0,0)")
        frames(3)

        # 2. filter the grid as you type
        c.js("document.querySelector('#search').focus()")
        for ch in "city":
            c.js(
                "(() => { const s = document.querySelector('#search');"
                f"s.value += {ch!r};"
                "s.dispatchEvent(new Event('input', {bubbles:true})); })()"
            )
            frames(3, 0.1)
        c.js("(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()")
        frames(2)

        # 3. open the film, seek into it, and let it play
        c.js("document.querySelector('#library-grid .card').click()")
        for _ in range(120):
            if c.js("(() => { const v = document.querySelector('#preview-video');"
                    " return !!v && v.readyState >= 2; })()"):
                break
            time.sleep(0.3)
        c.js(
            "(() => { const v = document.querySelector('#preview-video');"
            "v.muted = true;"
            "v.currentTime = Math.min(1200, Math.max(30, (v.duration || 600) * 0.35)); })()"
        )
        for _ in range(120):
            if c.js("(() => { const v = document.querySelector('#preview-video');"
                    " return !!v && !v.seeking && v.readyState >= 2; })()"):
                break
            time.sleep(0.25)
        c.js("document.querySelector('#preview-video').play()")
        frames(10, 0.13)
        print("playing at:", c.js("document.querySelector('#preview-video').currentTime"))

        # 4. mark the range with the editor's own buttons
        c.js("document.querySelector('#mob-btn-start').click()")
        frames(5)
        frames(18, 0.16)  # let the playhead run, as a person would
        c.js("document.querySelector('#preview-video').pause()")
        c.js("document.querySelector('#mob-btn-end').click()")
        frames(8)
        print("range:", c.js(
            "document.querySelector('#range-summary').innerText.replace(/\\s+/g,' ').trim()"))

        # 5. export it
        c.js("document.querySelector('#mob-btn-download').click()")
        frames(34, 0.13)
        print("status:", c.js("(document.querySelector('#mob-clip-status')||{}).innerText"))
        frames(10)
        print(f"frames: {state['i']} -> {frames_dir}")
    finally:
        chrome.terminate()


if __name__ == "__main__":
    sys.exit(main())
