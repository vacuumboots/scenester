/**
 * Cliparr — Mobile Mark-From-Playhead Module
 *
 * Minimal mobile clip editor: native video controls are the only scrubber.
 * Two huge buttons mark clip edges from video.currentTime. The range follows
 * the playhead (browse mode) until an edge is marked, then stays anchored.
 *
 * Reads/writes the app.js globals DIRECTLY (_sliderStart, _sliderEnd via
 * setSliderStart/setSliderEnd). No parallel mobile state. The only mobile
 * state is _mobBrowse.
 *
 * ES5 only (no arrow functions, no let/const, no template literals).
 * Loaded after app.js via <script src="static/mobile.js?v=32"></script>.
 */

// ── Module state ───────────────────────────────────────────────────────

var _mobBrowse = true;          // true = range follows the playhead
var _mobEls = {};               // cached DOM refs (filled at init)
var _mobActivePreset = 0;       // 0 = free mode; otherwise active preset seconds
var _mobProgressTimer = null;   // download progress poll interval
var _mobFlashTimer = null;      // "just-marked" button flash timeout

// ── DOM caching ────────────────────────────────────────────────────────

function _mobCacheDom() {
  _mobEls.video = document.getElementById("preview-video");
  _mobEls.timeStart = document.getElementById("mob-time-start");
  _mobEls.timeEnd = document.getElementById("mob-time-end");
  _mobEls.timeDur = document.getElementById("mob-time-dur");
  _mobEls.overviewFill = document.getElementById("mob-overview-fill");
  _mobEls.btnDownload = document.getElementById("mob-btn-download");
  _mobEls.btnLoop = document.getElementById("mob-btn-loop");
  _mobEls.btnStart = document.getElementById("mob-btn-start");
  _mobEls.btnEnd = document.getElementById("mob-btn-end");
  _mobEls.progress = document.getElementById("mob-clip-progress");
  _mobEls.progressFill = document.getElementById("mob-clip-progress-fill");
  _mobEls.progressText = document.getElementById("mob-clip-progress-text");
  _mobEls.status = document.getElementById("mob-clip-status");
  _mobEls.presetBtns = document.querySelectorAll(".mob-preset-btn");
  // Desktop elements mirrored during download progress polling
  _mobEls.desktopProgress = document.getElementById("clip-progress");
  _mobEls.desktopProgressFill = document.getElementById("clip-progress-fill");
  _mobEls.desktopProgressText = document.getElementById("clip-progress-text");
  _mobEls.desktopStatus = document.getElementById("clip-status");
}

// ── Lifecycle ──────────────────────────────────────────────────────────

/**
 * Called from app.js showDetailView() on mobile viewports.
 * Idempotent-safe: re-caches DOM and re-wires listeners every call.
 */
function initMobileDetail(item) {
  _mobCacheDom();
  _mobStopProgressPolling();
  if (_mobFlashTimer) { clearTimeout(_mobFlashTimer); _mobFlashTimer = null; }

  _mobBrowse = true;
  _mobActivePreset = 0;

  var vid = _mobEls.video;
  if (vid) {
    vid.removeEventListener("timeupdate", _mobOnTimeUpdate);
    vid.removeEventListener("seeked", _mobOnTimeUpdate);
    vid.removeEventListener("pause", _mobOnPause);
    vid.removeEventListener("play", _mobOnPlay);
    vid.addEventListener("timeupdate", _mobOnTimeUpdate);
    vid.addEventListener("seeked", _mobOnTimeUpdate);
    vid.addEventListener("pause", _mobOnPause);
    vid.addEventListener("play", _mobOnPlay);
  }

  // Default range: [0, min(139, duration)]
  var dur = 139;
  if (item && item.duration && item.duration > 0) dur = item.duration;
  else if (state.mediaDuration > 0) dur = state.mediaDuration;
  if (dur > 139) dur = 139;
  setSliderStart(0);
  setSliderEnd(dur);

  if (_mobEls.status) _mobEls.status.textContent = "";
  _mobRender();
}

/** Called from app.js goBack()/goHome(). Removes listeners, clears timers. */
function destroyMobileDetail() {
  _mobStopProgressPolling();
  if (_mobFlashTimer) { clearTimeout(_mobFlashTimer); _mobFlashTimer = null; }
  var vid = _mobEls.video;
  if (vid) {
    vid.removeEventListener("timeupdate", _mobOnTimeUpdate);
    vid.removeEventListener("seeked", _mobOnTimeUpdate);
    vid.removeEventListener("pause", _mobOnPause);
    vid.removeEventListener("play", _mobOnPlay);
  }
  _mobBrowse = true;
}

// ── Follow driver ──────────────────────────────────────────────────────

/**
 * timeupdate + seeked handler on the shared video. While _mobBrowse,
 * centers the range window on the playhead (preserving its duration),
 * clamped to media bounds. NEVER seeks or writes vid.currentTime here —
 * that would loop forever. Setters only update desktop readouts.
 */
function _mobOnTimeUpdate() {
  if (!_mobBrowse) return;
  var vid = _mobEls.video;
  if (!vid || !vid.duration || isNaN(vid.duration) || vid.duration <= 0) return;

  var dur = _sliderEnd - _sliderStart;
  var maxDur = state.mediaDuration > 0 ? state.mediaDuration : vid.duration;
  if (dur > maxDur) dur = maxDur;

  var start = vid.currentTime - (dur / 2);
  start = Math.max(0, Math.min(maxDur - dur, start));
  setSliderStart(start);
  setSliderEnd(start + dur);
  _mobRender();
}

/** Pause restores the loop button label (called via listener). */
function _mobOnPause() {
  _mobRender();
}

/** Play sets the loop button label to the active state (called via listener). */
function _mobOnPlay() {
  _mobRender();
}

// ── Mark buttons ───────────────────────────────────────────────────────

function mobMarkStart() {
  var vid = _mobEls.video;
  if (!vid) return;
  setSliderStart(vid.currentTime);
  if (_sliderEnd - _sliderStart < 0.04) {
    var fallbackDur = _mobActivePreset > 0 ? _mobActivePreset : 139;
    setSliderEnd(_sliderStart + fallbackDur); // setSliderEnd clamps to mediaDuration
  }
  _mobBrowse = false;
  _mobFlash(_mobEls.btnStart);
  if (_mobEls.status) _mobEls.status.textContent = "";
  _mobRender();
}

function mobMarkEnd() {
  var vid = _mobEls.video;
  if (!vid) return;
  if (vid.currentTime <= _sliderStart + 0.04) {
    if (_mobEls.status) _mobEls.status.textContent = "End must be after start";
    return;
  }
  setSliderEnd(vid.currentTime);
  _mobBrowse = false;
  vid.pause();
  _mobFlash(_mobEls.btnEnd);
  if (_mobEls.status) _mobEls.status.textContent = "";
  _mobRender();
}

/** Nudge the playhead; the timeupdate listener follows while _mobBrowse. */
function mobSkip(delta) {
  var vid = _mobEls.video;
  if (!vid) return;
  var maxT = state.mediaDuration > 0 ? state.mediaDuration : (vid.duration || 0);
  var t = Math.max(0, Math.min(maxT, vid.currentTime + delta));
  vid.currentTime = t;
}

// ── Nudge rows ─────────────────────────────────────────────────────────

function mobNudgeStart(delta) {
  var ns = Math.max(0, Math.min(_sliderEnd - 0.04, _sliderStart + delta));
  setSliderStart(ns);
  _mobBrowse = false;
  seekVideoTo(_sliderStart);
  _mobRender();
}

function mobNudgeEnd(delta) {
  var ne = Math.max(_sliderStart + 0.04, Math.min(state.mediaDuration, _sliderEnd + delta));
  setSliderEnd(ne);
  _mobBrowse = false;
  seekVideoTo(_sliderEnd);
  _mobRender();
}

// ── Preset chips ───────────────────────────────────────────────────────

function mobPreset(duration) {
  if (_mobActivePreset === duration) {
    _mobActivePreset = 0; // same chip again = deselect, free mode, duration stays
  } else {
    _mobActivePreset = duration;
    // In browse mode (no start marked yet), anchor the start to the playhead
    // first — "I want N seconds starting from where I'm looking".
    if (_mobBrowse) {
      var vid = _mobEls.video;
      if (vid) {
        setSliderStart(vid.currentTime);
        setSliderEnd(Math.min(_sliderStart + duration, state.mediaDuration));
      }
    } else {
      setSliderEnd(Math.min(_sliderStart + duration, state.mediaDuration));
    }
    _mobBrowse = false;
  }
  _mobRender();
}

// ── Actions ────────────────────────────────────────────────────────────

function mobLoop() {
  playClip(); // app.js reads the shared _sliderStart/_sliderEnd
  _mobRender();
}

function mobDownload() {
  _mobShowProgress();
  _mobStartProgressPolling();
  downloadClip(); // app.js flow; mirror-poll keeps mob progress in sync
}

// ── Progress mirroring (desktop -> mobile) ─────────────────────────────

function _mobShowProgress() {
  if (_mobEls.progress) _mobEls.progress.style.display = "block";
  if (_mobEls.progressFill) _mobEls.progressFill.style.width = "0%";
  if (_mobEls.progressText) _mobEls.progressText.textContent = "Starting clip...";
}

function _mobStartProgressPolling() {
  _mobStopProgressPolling();
  _mobProgressTimer = setInterval(_mobPollProgress, 500);
}

function _mobStopProgressPolling() {
  if (_mobProgressTimer) {
    clearInterval(_mobProgressTimer);
    _mobProgressTimer = null;
  }
}

function _mobPollProgress() {
  var dp = _mobEls.desktopProgress;
  if (!dp || dp.style.display === "none") {
    _mobStopProgressPolling();
    if (_mobEls.progress) _mobEls.progress.style.display = "none";
    return;
  }
  if (_mobEls.progressFill && _mobEls.desktopProgressFill) {
    _mobEls.progressFill.style.width = _mobEls.desktopProgressFill.style.width || "0%";
  }
  if (_mobEls.progressText && _mobEls.desktopProgressText) {
    _mobEls.progressText.textContent = _mobEls.desktopProgressText.textContent || "";
  }
  if (_mobEls.status && _mobEls.desktopStatus) {
    _mobEls.status.textContent = _mobEls.desktopStatus.textContent || "";
  }
}

// ── Render ─────────────────────────────────────────────────────────────

function _mobRender() {
  var dur = _sliderEnd - _sliderStart;

  if (_mobEls.timeStart) _mobEls.timeStart.textContent = fmtTime(_sliderStart, true);
  if (_mobEls.timeEnd) _mobEls.timeEnd.textContent = fmtTime(_sliderEnd, true);
  if (_mobEls.timeDur) _mobEls.timeDur.textContent = dur.toFixed(1) + "s";

  var md = state.mediaDuration > 0 ? state.mediaDuration : 0;
  if (_mobEls.overviewFill && md > 0) {
    var pStart = Math.max(0, Math.min(100, (_sliderStart / md) * 100));
    var pEnd = Math.max(pStart, Math.min(100, (_sliderEnd / md) * 100));
    _mobEls.overviewFill.style.left = pStart + "%";
    _mobEls.overviewFill.style.width = (pEnd - pStart) + "%";
  }

  if (_mobEls.btnDownload) {
    if (dur <= 0) {
      _mobEls.btnDownload.disabled = true;
      _mobEls.btnDownload.textContent = "⬇ Download Clip";
    } else {
      _mobEls.btnDownload.disabled = false;
      var label = "⬇ Download Clip";
      var parts = [];
      if (_captionsEnabled) parts.push("captions");
      if (_verticalEnabled) parts.push("vertical");
      if (parts.length) label = "⬇ Download Clip (" + parts.join(" + ") + ")";
      _mobEls.btnDownload.textContent = label;
    }
  }

  // Preset chip highlight
  if (_mobEls.presetBtns) {
    for (var i = 0; i < _mobEls.presetBtns.length; i++) {
      var b = _mobEls.presetBtns[i];
      var d = parseFloat(b.getAttribute("data-dur")) || 0;
      if (_mobActivePreset === d) b.classList.add("active");
      else b.classList.remove("active");
    }
  }

  // Loop button label
  if (_mobEls.btnLoop && _mobEls.video) {
    if (_loopPlayback && !_mobEls.video.paused) _mobEls.btnLoop.textContent = "⏸ Loop";
    else _mobEls.btnLoop.textContent = "🔁 Loop";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function _mobFlash(btn) {
  if (!btn) return;
  if (_mobFlashTimer) clearTimeout(_mobFlashTimer);
  btn.classList.add("just-marked");
  _mobFlashTimer = setTimeout(function() {
    btn.classList.remove("just-marked");
    _mobFlashTimer = null;
  }, 600);
}
