/**
 * Cliparr — Mobile Interaction Module
 *
 * Two-thumb timeline scrubber, fine-tune nudge, preset chips,
 * download flow, social toggle sync, and lifecycle hooks.
 *
 * All functions use 'mob' or '_mob' prefix to avoid collisions with
 * app.js globals. References shared globals: _sliderStart, _sliderEnd,
 * state, dom, seekVideoTo, fmtTime, downloadClip, toggleCaptions,
 * toggleVertical, updateToggleButtons, updateSocialToggles.
 *
 * Loaded after app.js via <script src="static/mobile.js?v=17"></script>.
 */

// ── Module State ───────────────────────────────────────────────────────

var _mobStart = 0;            // float, clip start in seconds
var _mobEnd = 139;            // float, clip end in seconds
var _mobDuration = 0;         // total media duration in seconds
var _mobActiveHandle = 'start';  // which handle was last touched ('start' | 'end')
var _mobDragging = null;      // null | 'start' | 'end' | 'window'
var _mobWindowOffset = 0;     // offset from touch to window center during window drag
var _mobVideoReady = false;
var _mobTapInfo = null;    // {x, y, t, zone} for tap-vs-drag detection
var _mobZoomed = false;      // true = stage 2 active: frozen 10-min neighborhood view
var _mobZoomSpan = 600;      // seconds — 10 minutes (fixed zoom level)
var _mobPhase = null;        // null | 'start' | 'end' — which edge is being phased in
var _mobPhaseManual = false; // true after user drags the active thumb (stops playhead-ride)
var _mobViewMin = 0;         // view range (seconds) — STORED at zoom-in, never re-derived
var _mobViewMax = 0;
var _mobSeekTimer = null;    // 40ms debounce timer for live drag seeks
var _mobPendingSeekT = 0;    // last position requested by a debounced seek (flushed on touchend)

// Progress mirroring
var _mobProgressTimer = null;

// Touch position cache (filled at touchstart, reused in touchmove to avoid
// getBoundingClientRect layout thrash on every move event)
var _mobTouchRect = null;

// ── Cached DOM references (filled at init, avoids getElementById jank) ─

var _mobEls = {};

function _mobCacheDom() {
  _mobEls.timeline   = document.getElementById('mob-timeline');
  _mobEls.fill       = document.getElementById('mob-timeline-fill');
  _mobEls.thumbStart = document.getElementById('mob-thumb-start');
  _mobEls.thumbEnd   = document.getElementById('mob-thumb-end');
  _mobEls.playhead   = document.getElementById('mob-playhead');
  _mobEls.timeStart  = document.getElementById('mob-time-start');
  _mobEls.timeEnd    = document.getElementById('mob-time-end');
  _mobEls.timeDur    = document.getElementById('mob-time-dur');
  _mobEls.btnDownload = document.getElementById('mob-btn-download');
  _mobEls.progress   = document.getElementById('mob-clip-progress');
  _mobEls.progressFill = document.getElementById('mob-clip-progress-fill');
  _mobEls.progressText = document.getElementById('mob-clip-progress-text');
  _mobEls.status     = document.getElementById('mob-clip-status');
}

// ── DOM helpers ────────────────────────────────────────────────────────

/** Get the shared video element (single #preview-video used by both
 *  desktop and mobile — CSS media queries position it differently). */
function _mobVideo() {
  return document.getElementById('preview-video');
}

// ── Initialisation / Teardown ──────────────────────────────────────────

/**
 * Called from app.js showDetailView() when on a mobile viewport.
 * Initialises the mobile clip detail view with the given Plex item.
 */
function initMobileDetail(item) {
  // Cache DOM references (avoids getElementById jank during drag)
  _mobCacheDom();

  _mobDragging = null;
  _mobTapInfo = null;
  _mobZoomed = false;
  _mobPhase = null;
  _mobPhaseManual = false;
  _mobVideoReady = false;

  _mobDuration = (item.duration || 0) / 1000;
  if (_mobDuration <= 0) _mobDuration = 139;

  // Sync from desktop / jump-offset state
  var jumpOff = null;
  if (window._jumpOffset != null) {
    jumpOff = window._jumpOffset;
    _mobStart = Math.max(0, window._jumpOffset - 5);
    _mobEnd = Math.min(_mobDuration, window._jumpOffset + 25);
    window._jumpOffset = null;
    window._jumpDuration = null;
  } else {
    _mobStart = 0;
    _mobEnd = Math.min(139, _mobDuration);
  }

  // View: full movie in stage 1; frozen range in stage 2 (set at zoom-in only).
  _mobSetViewFull();

  _mobActiveHandle = 'start';

  // Wire timeline touch events
  initMobileTimeline();

  // Initial paint
  _mobUpdateZoomBtn();
  _mobUpdateStageLabel();
  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();

  // Clear preset highlights
  var btns = document.querySelectorAll('.mob-preset-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');

  // Wire video events on the mobile video element
  var vid = _mobVideo();
  if (vid) {
    vid.addEventListener('timeupdate', _mobOnTimeUpdate);
    vid.addEventListener('seeked', _mobOnTimeUpdate);
    vid.addEventListener('pause', _mobUpdateLoopBtn);
    vid.addEventListener('loadedmetadata', function() {
      _mobVideoReady = true;
    });

    // If vid metadata is already loaded by the time init runs (desktop
    // may have pre-loaded it), mark ready immediately.
    if (vid.readyState >= 1) _mobVideoReady = true;
  }

  // Show mobile options panel
  var opts = document.getElementById('mob-options');
  if (opts) opts.style.display = '';
  var capOpt = document.getElementById('mob-opt-captions');
  if (capOpt && item.subtitle_path) capOpt.style.display = '';
  else if (capOpt) capOpt.style.display = 'none';

  // Wire social checkbox sync initial state
  _mobSyncSocialFromDesktop();

  // Hide any stale progress bar
  _mobHideProgress();
}

/**
 * Called from app.js goBack() / goHome() to clean up mobile state.
 */
function destroyMobileDetail() {
  var vid = _mobVideo();
  if (vid) {
    vid.removeEventListener('timeupdate', _mobOnTimeUpdate);
    vid.removeEventListener('seeked', _mobOnTimeUpdate);
    vid.removeEventListener('pause', _mobUpdateLoopBtn);
  }
  _mobDragging = null;
  _mobPhase = null;
  _mobPhaseManual = false;
  if (_mobSeekTimer) { clearTimeout(_mobSeekTimer); _mobSeekTimer = null; }
  _mobStopProgressPolling();
  _mobHideProgress();
}

/** Sync mobile social checkboxes from desktop state. */
function _mobSyncSocialFromDesktop() {
  var cc = document.getElementById('mob-chk-captions');
  var cv = document.getElementById('mob-chk-vertical');
  // _captionsEnabled and _verticalEnabled are app.js globals
  if (cc && typeof _captionsEnabled !== 'undefined') cc.checked = _captionsEnabled;
  if (cv && typeof _verticalEnabled !== 'undefined') cv.checked = _verticalEnabled;
}

// ── Timeline Core ──────────────────────────────────────────────────────

/**
 * Wire touch handlers on the #mob-timeline element.
 *   - touchstart  on the timeline (hit-test thumbs, fill, or tap-to-snap)
 *   - touchmove   on document (for smooth dragging even if finger leaves the bar)
 *   - touchend    on document
 */
function initMobileTimeline() {
  var tl = _mobEls.timeline || document.getElementById('mob-timeline');
  if (!tl) return;

  // Remove old listeners (idempotent re-init)
  tl.removeEventListener('touchstart', _mobTimelineTouchStart);
  document.removeEventListener('touchmove', _mobTimelineTouchMove);
  document.removeEventListener('touchend', _mobTimelineTouchEnd);

  tl.addEventListener('touchstart', _mobTimelineTouchStart, { passive: false });
  document.addEventListener('touchmove', _mobTimelineTouchMove, { passive: false });
  document.addEventListener('touchend', _mobTimelineTouchEnd);
  document.addEventListener('touchcancel', _mobTimelineTouchEnd);
}

/** touchstart: identify target (handle, fill window, empty area). */
function _mobTimelineTouchStart(e) {
  if (e.touches.length !== 1) return; // single-finger only

  var tl = _mobEls.timeline;
  if (!tl) return;

  var touch = e.touches[0];
  var rect = tl.getBoundingClientRect();
  _mobTouchRect = rect; // cache for touchmove

  var x = touch.clientX - rect.left;

  // Hit-test positions are view-relative — same mapping as _mobUpdateTimeline.
  // Stage 1: the gold window IS the bracket (thumbs hidden — no thumb zones).
  // Stage 2: thumbs + clip window, inside the frozen view.
  var span = _mobViewMax - _mobViewMin;
  var HIT_RADIUS = 30; // px — generous for thumb-sized fingers
  var ZONE; // 'thumb-start' | 'thumb-end' | 'window' | 'zoom' | 'scrub'

  if (_mobZoomed) {
    var startPct = span > 0 ? Math.max(0, Math.min(1, (_mobStart - _mobViewMin) / span)) : 0;
    var endPct = span > 0 ? Math.max(0, Math.min(1, (_mobEnd - _mobViewMin) / span)) : 1;
    var startX = startPct * rect.width;
    var endX = endPct * rect.width;

    if (Math.abs(x - startX) < HIT_RADIUS) {
      _mobDragging = 'start';
      _mobActiveHandle = 'start';
      ZONE = 'thumb-start';
    } else if (Math.abs(x - endX) < HIT_RADIUS) {
      _mobDragging = 'end';
      _mobActiveHandle = 'end';
      ZONE = 'thumb-end';
    } else if (x > startX && x < endX) {
      // Dragging the fill area → slide entire clip window, preserve duration.
      // Record the offset between the touch point and the window center so
      // the window doesn't jump on first touch (relative tracking).
      _mobDragging = 'window';
      var touchT = _mobTimeFromPosition(x);
      var windowCenter = _mobStart + (_mobEnd - _mobStart) / 2;
      _mobWindowOffset = touchT - windowCenter;
      ZONE = 'window';
    } else {
      // Stage 2 empty: scrub to tap position immediately (no debounce).
      var t = _mobTimeFromPosition(x);
      _mobDragging = 'scrub';
      _mobSeekTo(Math.max(0, Math.min(_mobDuration, t)), true);
      ZONE = 'scrub';
    }
  } else {
    // Stage 1: bracket is DERIVED from playhead (no stored state).
    // Tap zones are: click empty bar → zoom-in (handled in touchend).
    // No bracket drag — bracket moves via playhead only.
    ZONE = 'zoom';   // empty bar tap → zoom-in, handled in touchend
  }

  _mobTapInfo = { x: touch.clientX, y: touch.clientY, t: Date.now(), zone: ZONE };

  _mobUpdateTimeline();
  _mobUpdateTimes();

  e.preventDefault();
}

/** touchmove: drag handle or slide window, seek video in real-time. */
function _mobTimelineTouchMove(e) {
  if (!_mobDragging) return;
  if (e.touches.length !== 1) return;

  var rect = _mobTouchRect || (_mobEls.timeline ? _mobEls.timeline.getBoundingClientRect() : null);
  if (!rect) return;
  var touch = e.touches[0];
  var x = Math.max(0, Math.min(rect.width, touch.clientX - rect.left));
  var t = _mobTimeFromPosition(x);

  // Tap-vs-drag gate: finger wobble under 10px must stay a tap (arm / seek
  // at the tap point), not a drag. Micro-movement on a phone is normal —
  // without this gate a jittery tap moves the handle several seconds.
  var tapInfo = _mobTapInfo;
  if (tapInfo) {
    var dx = touch.clientX - tapInfo.x;
    var dy = touch.clientY - tapInfo.y;
    if (dx * dx + dy * dy < 100) return;   // within 10px — still a tap
  }

  if (_mobDragging === 'scrub') {
    // Stage 2 scrub: debounced seek, playhead line follows as seeks land
    _mobSeekTo(Math.max(0, Math.min(_mobDuration, t)));
    _mobUpdateTimeline();            // moves playhead line
    _mobUpdateTimes();
    e.preventDefault();
    return;
  }
  if (_mobDragging === 'window') {
    // Use relative tracking: window center = touch time - stored offset.
    // In Stage 1: no window drag (bracket derived from playhead).
    var dur = _mobEnd - _mobStart;
    var halfDur = dur / 2;
    var vSpan = _mobViewMax - _mobViewMin;
    var newStart = Math.max(_mobViewMin, Math.min(_mobViewMin + Math.max(0, vSpan - dur), (t - _mobWindowOffset) - halfDur));
    _mobStart = newStart;
    _mobEnd = newStart + dur;

    // Debounced seek to where the user's finger is — flushed on touchend
    _mobSeekTo(Math.max(0, Math.min(_mobDuration, t)));
  } else {
    _mobSetHandle(_mobDragging, t, true);   // handle position live, seek debounced
    // If the user is dragging the active-phase thumb, mark manual so playhead-ride stops
    if (_mobDragging === _mobPhase) _mobPhaseManual = true;
  }

  _mobUpdateTimeline();
  _mobUpdateTimes();

  e.preventDefault();
}

/** touchend / touchcancel: stop dragging, detect tap, update button states. */
function _mobTimelineTouchEnd(e) {
  if (_mobDragging) {
    _mobUpdateDownloadBtn();
  }

  // Tap-vs-drag detection: a quick touch with <10px movement is a tap.
  var ct = e.changedTouches && e.changedTouches[0];
  var info = _mobTapInfo;
  if (info && ct) {
    var moved = Math.hypot(ct.clientX - info.x, ct.clientY - info.y) > 10;
    var quick = (Date.now() - info.t) < 400;
    if (!moved && quick) {
      if (info.zone === 'thumb-start') {
        if (_mobPhase === 'start') {
          // Commit start at current playhead position, advance to 'end'
          var vid = _mobVideo();
          if (vid && isFinite(vid.currentTime)) {
            _mobStart = Math.max(_mobViewMin, Math.min(_mobEnd - 0.04, vid.currentTime));
          }
          _mobPhase = 'end';
          _mobPhaseManual = false;
          _mobActiveHandle = 'end';
        } else if (_mobPhase === 'end') {
          // Tapping dimmed start thumb in Phase 'end' → return to Phase 'start'
          _mobPhase = 'start';
          _mobPhaseManual = false;
          _mobActiveHandle = 'start';
        }
      } else if (info.zone === 'thumb-end') {
        if (_mobPhase === 'end') {
          // Commit end at current playhead position, done
          var vid2 = _mobVideo();
          if (vid2 && isFinite(vid2.currentTime)) {
            _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobViewMax, vid2.currentTime));
          }
          _mobPhase = null;
          _mobPhaseManual = false;
        }
      } else if (info.zone === 'window') {
        // Tap the fill: Stage 2 → seek playhead (start/end follow if not manual).
        var rect = _mobTouchRect;
        if (rect) {
          var t = _mobTimeFromPosition(ct.clientX - rect.left);
          _mobSeekTo(Math.max(0, Math.min(_mobDuration, t)), true);
          _mobUpdateTimeline();
          _mobUpdateTimes();
        }
      } else if (info.zone === 'zoom') {
        // Stage 1 tap → zoom in around playhead
        mobToggleZoom();
      }
      _mobUpdateStageLabel();
    }
  }

  // Flush any pending debounced seek so the final drag position lands.
  _mobFlushSeek();

  _mobDragging = null;
  _mobTouchRect = null;
  _mobTapInfo = null;
}

// ── Handle & Time Helpers ─────────────────────────────────────────────

/**
 * Set the view to the full movie (stage 1).
 * The ONLY writers of _mobViewMin/_mobViewMax are _mobSetViewFull and
 * _mobSetViewFrozen — the zoomed view is stored at zoom-in and never
 * re-derived from the clip window (fixes "adjusting start/end moves the
 * whole clip").
 */
function _mobSetViewFull() {
  _mobViewMin = 0;
  _mobViewMax = _mobDuration;
}

/** Freeze the view on the given range (stage 2). Clamped to the movie. */
function _mobSetViewFrozen(min, max) {
  var span = Math.max(0, Math.min(max - min, _mobDuration));
  var lo = Math.max(0, Math.min(_mobDuration - span, min));
  _mobViewMin = lo;
  _mobViewMax = lo + span;
}

/**
 * Convert an x-pixel position within the timeline rect to a time in seconds,
 * relative to the current view (full movie in stage 1, frozen range in stage 2).
 */
function _mobTimeFromPosition(x) {
  if (_mobDuration <= 0) return 0;
  var w = _mobTouchRect ? _mobTouchRect.width : 1;
  var span = _mobViewMax - _mobViewMin;
  return _mobViewMin + (x / w) * span;
}

/**
 * Set a handle (start or end) to time t. Clamps so start < end (minimum
 * 0.04 s gap — one frame at 25 fps). Seeks the video to the new position.
 */
function _mobSetHandle(which, t, defer) {
  if (which === 'start') {
    _mobStart = Math.max(0, Math.min(_mobEnd - 0.04, t));
    _mobSeekTo(_mobStart, !defer);
  } else {
    _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobDuration, t));
    _mobSeekTo(_mobEnd, !defer);
  }
  _mobActiveHandle = which;
}

/** Debounced live seek — flushed on touch-end. Prevents byte-range seek
 *  storms on long movies. immediate=true fires synchronously (taps, snaps,
 *  discrete actions). */
function _mobSeekTo(t, immediate) {
  if (immediate) {
    if (_mobSeekTimer) { clearTimeout(_mobSeekTimer); _mobSeekTimer = null; }
    seekVideoTo(t);
    return;
  }
  _mobPendingSeekT = t;
  if (_mobSeekTimer) clearTimeout(_mobSeekTimer);
  _mobSeekTimer = setTimeout(function() {
    _mobSeekTimer = null;
    seekVideoTo(_mobPendingSeekT);
  }, 40);
}

/** Flush a pending debounced seek — fires the final drag position so the
 *  video always lands where the finger released. */
function _mobFlushSeek() {
  if (_mobSeekTimer) {
    clearTimeout(_mobSeekTimer);
    _mobSeekTimer = null;
    seekVideoTo(_mobPendingSeekT);
  }
}

/**
 * Reposition the timeline fill bar, thumb handles, and playhead line as
 * CSS percentages, relative to the current view (full movie or zoomed
 * 10-min neighborhood).
 */
function _mobUpdateTimeline() {
  if (_mobDuration <= 0) return;
  var span = _mobViewMax - _mobViewMin;
  if (span <= 0) return;
  var pct = function(t) {
    return Math.max(0, Math.min(100, ((t - _mobViewMin) / span) * 100));
  };

  var fill = _mobEls.fill;
  var thumbS = _mobEls.thumbStart;
  var thumbE = _mobEls.thumbEnd;

  if (!_mobZoomed) {
    // Stage 1: bracket is DERIVED from playhead (±300s), clamped to [0, _mobDuration].
    var vid = _mobVideo();
    var center = (vid && isFinite(vid.currentTime)) ? vid.currentTime : (_mobViewMin + _mobViewMax) / 2;
    var halfWin = _mobZoomSpan / 2;
    var bStart = Math.max(0, Math.min(_mobDuration - _mobZoomSpan, center - halfWin));
    var bEnd = Math.min(_mobDuration, bStart + _mobZoomSpan);
    if (fill) {
      fill.style.left = pct(bStart) + '%';
      fill.style.width = (pct(bEnd) - pct(bStart)) + '%';
    }
    if (thumbS) thumbS.style.display = 'none';
    if (thumbE) thumbE.style.display = 'none';
  } else {
    // Stage 2: the gold window IS the clip, inside the frozen view.
    if (fill) {
      fill.style.left = pct(_mobStart) + '%';
      fill.style.width = (pct(_mobEnd) - pct(_mobStart)) + '%';
    }
    if (thumbS) { thumbS.style.display = ''; thumbS.style.left = pct(_mobStart) + '%'; }
    if (thumbE) { thumbE.style.display = ''; thumbE.style.left = pct(_mobEnd) + '%'; }
    // Phase-based thumb styling: active thumb gets gold pulse, inactive in a phase gets dimmed
    if (thumbS) {
      thumbS.classList.toggle('active', _mobPhase === 'start');
      thumbS.classList.toggle('armed-dim', _mobZoomed && _mobPhase !== 'start' && _mobPhase !== null);
    }
    if (thumbE) {
      thumbE.classList.toggle('active', _mobPhase === 'end');
      thumbE.classList.toggle('armed-dim', _mobZoomed && _mobPhase !== 'end' && _mobPhase !== null);
    }
  }

  // Playhead line (both stages): show where the video is within the current view
  var ph = _mobEls.playhead;
  if (ph) {
    var vid = _mobVideo();
    if (vid && isFinite(vid.currentTime)) {
      ph.style.left = pct(vid.currentTime) + '%';
      ph.style.display = 'block';
    } else {
      ph.style.display = 'none';
    }
  }

}

/** Write current times to the three mobile time displays. */
function _mobUpdateTimes() {
  var s = _mobEls.timeStart;
  var e = _mobEls.timeEnd;
  var d = _mobEls.timeDur;

  // Stage 1 shows derived bracket (±300s from playhead); stage 2 shows the clip.
  if (_mobZoomed) {
    if (s) s.textContent = fmtTime(_mobStart, true);
    if (e) e.textContent = fmtTime(_mobEnd, true);
  } else {
    var vid = _mobVideo();
    var center = (vid && isFinite(vid.currentTime)) ? vid.currentTime : (_mobViewMin + _mobViewMax) / 2;
    var halfWin = _mobZoomSpan / 2;
    var bStart = Math.max(0, Math.min(_mobDuration - _mobZoomSpan, center - halfWin));
    var bEnd = Math.min(_mobDuration, bStart + _mobZoomSpan);
    if (s) s.textContent = fmtTime(bStart, true);
    if (e) e.textContent = fmtTime(bEnd, true);
  }

  var dur = _mobZoomed ? (_mobEnd - _mobStart) : _mobZoomSpan;
  if (d) {
    if (dur >= 60) {
      d.textContent = Math.round(dur / 60) + 'min';
    } else if (dur >= 1) {
      d.textContent = Math.round(dur) + 's';
    } else {
      d.textContent = dur.toFixed(1) + 's';
    }
  }
}

// ── Skip ──────────────────────────────────────────────────────────────

/**
 * Skip the video forward or backward by delta seconds (typically ±10).
 * Also slides the clip window to follow the new playback position.
 */
function mobSkip(delta) {
  var vid = _mobVideo();
  if (!vid || !isFinite(vid.currentTime) || _mobDuration <= 0) return;

  var newTime = Math.max(0, Math.min(_mobDuration, vid.currentTime + delta));
  vid.currentTime = newTime;

  // Stage 1: bracket follows playhead automatically (derived).
  // Stage 2: skip just nudges the playhead (scrub); view + window untouched.

  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();
}

// ── Fine-Tune (explicit Start / End rows) ─────────────────────────────

/**
 * Nudge the START handle by delta seconds.
 * Typical values: ±0.04 (one frame at 25 fps) or ±5 (coarse jump).
 */
function mobNudgeStart(delta) {
  _mobStart = Math.max(0, Math.min(_mobEnd - 0.04, _mobStart + delta));
  _mobActiveHandle = 'start';
  seekVideoTo(_mobStart);
  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();
}

/**
 * Nudge the END handle by delta seconds.
 */
function mobNudgeEnd(delta) {
  _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobDuration, _mobEnd + delta));
  _mobActiveHandle = 'end';
  seekVideoTo(_mobEnd);
  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();
}

// ── Preset Chips ───────────────────────────────────────────────────────

/**
 * Set clip end so the duration matches the preset value, anchored at the
 * current start position.
 */
function mobPreset(duration) {
  _mobEnd = Math.min(_mobDuration, _mobStart + duration);
  seekVideoTo(_mobStart);

  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();

  // Highlight the active preset button
  var btns = document.querySelectorAll('.mob-preset-btn');
  for (var i = 0; i < btns.length; i++) {
    var btnDur = parseInt(btns[i].getAttribute('data-dur'), 10);
    btns[i].classList.toggle('active', btnDur === duration);
  }
}

// ── Clip Download ──────────────────────────────────────────────────────

/**
 * Sync mobile state into the desktop globals then fire the existing
 * downloadClip() function. Spins up a progress mirror to keep the mobile
 * progress bar in sync with the desktop one.
 */
function mobDownload() {
  // Sync clip range into the globals downloadClip() reads
  _sliderStart = _mobStart;
  _sliderEnd = _mobEnd;

  // Show mobile progress and start mirroring
  _mobShowProgress();
  _mobStartProgressPolling();

  // Fire the existing download flow (async, handles its own lifecycle)
  downloadClip();
}

/** Show the mobile progress bar. */
function _mobShowProgress() {
  if (_mobEls.progress) _mobEls.progress.style.display = 'block';
  if (_mobEls.progressFill) _mobEls.progressFill.style.width = '0%';
  if (_mobEls.progressText) _mobEls.progressText.textContent = 'Starting clip...';
  if (_mobEls.status) _mobEls.status.textContent = '';
}

/** Hide the mobile progress bar and stop mirroring. */
function _mobHideProgress() {
  _mobStopProgressPolling();
  if (_mobEls.progress) _mobEls.progress.style.display = 'none';
}

/**
 * Poll every 500 ms: mirror the desktop progress bar values into the
 * mobile progress elements. Stops automatically when the desktop progress
 * bar is hidden (download complete / error).
 */
function _mobStartProgressPolling() {
  _mobStopProgressPolling(); // clear any existing timer

  _mobProgressTimer = setInterval(function() {
    var desktopBar = document.getElementById('clip-progress');

    // Desktop progress hidden → download finished, stop mirroring
    if (desktopBar && desktopBar.style.display === 'none') {
      _mobHideProgress();
      return;
    }

    var desktopFill = document.getElementById('clip-progress-fill');
    var desktopText = document.getElementById('clip-progress-text');

    if (desktopFill && _mobEls.progressFill) {
      _mobEls.progressFill.style.width = desktopFill.style.width || '0%';
    }
    if (desktopText && _mobEls.progressText) {
      _mobEls.progressText.textContent = desktopText.textContent || 'Encoding...';
    }

    // Also mirror the desktop status text to mobile status
    var desktopStatus = document.getElementById('clip-status');
    if (desktopStatus && _mobEls.status && desktopStatus.textContent) {
      _mobEls.status.textContent = desktopStatus.textContent;
    }
  }, 500);
}

/** Clear the progress mirroring interval. */
function _mobStopProgressPolling() {
  if (_mobProgressTimer) {
    clearInterval(_mobProgressTimer);
    _mobProgressTimer = null;
  }
}

// ── Download Button State ──────────────────────────────────────────────

/**
 * Enable/disable the mobile download button based on whether the clip
 * range is valid and update its label.
 */
function _mobUpdateDownloadBtn() {
  var btn = _mobEls.btnDownload;
  if (!btn) return;

  var dur = _mobEnd - _mobStart;
  if (dur <= 0) {
    btn.disabled = true;
    btn.textContent = 'Set clip range';
  } else {
    btn.disabled = false;

    var label = '\u2B07 Download Clip';  // ⬇
    var parts = [];
    if (typeof _captionsEnabled !== 'undefined' && _captionsEnabled) {
      parts.push('captions');
    }
    if (typeof _verticalEnabled !== 'undefined' && _verticalEnabled) {
      parts.push('vertical');
    }
    if (parts.length > 0) {
      label += ' (' + parts.join(', ') + ')';
    }
    btn.textContent = label;
  }
}

// ── Loop Preview ──────────────────────────────────────────────────────

/**
 * Play the current mobile clip range on a loop. Syncs the desktop
 * _sliderStart/_sliderEnd globals so the existing app.js loop machinery
 * (playClip → _loopPlayback → vid.ontimeupdate) uses the mobile range.
 */
function mobLoop() {
  var vid = _mobVideo();
  if (!vid) return;
  // Park the window: looped playback must not re-center a follow-mode window
  // or ride an armed edge — the user is auditioning their pinned range.
  _mobPhase = null;
  // Sync desktop globals so the existing loop machinery uses the mobile range
  _sliderStart = _mobStart;
  _sliderEnd = _mobEnd;
  playClip();                 // app.js: toggles _loopPlayback, loops via vid.ontimeupdate
  _mobUpdateLoopBtn();
  _mobUpdateStageLabel();     // loop disarms — label must reflect the idle stage state
}

/** Reflect the loop state on the loop button label/class. */
function _mobUpdateLoopBtn() {
  var b = document.getElementById('mob-btn-loop');
  var vid = _mobVideo();
  if (!b) return;
  var active = _loopPlayback && vid && !vid.paused;
  b.textContent = active ? '\u23F9 Loop' : '\uD83D\uDD01 Loop';  // ⏹ / 🔁
  b.classList.toggle('active', active);
}

// ── Zoom (Two-Stage Selection) ────────────────────────────────────────

/** Toggle Stage 2 (10-min neighborhood view). */
function mobToggleZoom() {
  if (_mobDuration <= 0) return;
  if (!_mobZoomed) {
    // Stage 1 → 2: freeze view on current playhead-centered bracket
    var vid = _mobVideo();
    var center = (vid && isFinite(vid.currentTime)) ? vid.currentTime : _mobDuration / 2;
    var half = _mobZoomSpan / 2;
    var lo = Math.max(0, Math.min(_mobDuration - _mobZoomSpan, center - half));
    _mobSetViewFrozen(lo, lo + _mobZoomSpan);
    _mobZoomed = true;
    _mobPhase = 'start';
    _mobPhaseManual = false;
    // Default end = start + 139s, clamped to view
    _mobEnd = Math.min(_mobViewMax, _mobStart + 139);
  } else {
    // Stage 2 → 1: back to full movie
    _mobZoomed = false;
    _mobPhase = null;
    _mobPhaseManual = false;
    _mobSetViewFull();
  }
  _mobUpdateZoomBtn();
  _mobUpdateStageLabel();
  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();
}

function _mobUpdateZoomBtn() {
  var b = document.getElementById('mob-btn-zoom');
  if (!b) return;
  b.textContent = _mobZoomed ? '\u293A Full' : '\uD83D\uDD0D';  // ⤺ / 🔍
  b.classList.toggle('active', _mobZoomed);
  b.title = _mobZoomed ? 'Back to full movie' : 'Zoom to 10-minute view';
}

/** Update the two-stage instruction label + fine-tune row visibility. */
function _mobUpdateStageLabel() {
  var el = document.getElementById('mob-stage-label');
  if (el) {
    if (!_mobZoomed) {
      el.textContent = 'STEP 1/2 \u2014 find your scene, then tap \uD83D\uDD0D';
    } else if (_mobPhase === 'start') {
      el.textContent = 'STEP 2/3 \u2014 start: scrub to in-point, tap \u25C0 to lock';
    } else if (_mobPhase === 'end') {
      el.textContent = 'STEP 3/3 \u2014 end: scrub to out-point, tap \u25B6 to lock';
    } else {
      // Phase null = done
      var dur = _mobEnd - _mobStart;
      if (dur >= 60) {
        el.textContent = 'Clip ready \u2014 ' + Math.round(dur / 60) + 'min';
      } else if (dur >= 1) {
        el.textContent = 'Clip ready \u2014 ' + dur.toFixed(1) + 's';
      } else {
        el.textContent = 'Clip ready \u2014 ' + dur.toFixed(2) + 's';
      }
    }
  }
  // Fine-tune rows are visible in Stage 2 (all phases).
  var ft = document.getElementById('mob-finetune');
  if (ft) ft.style.display = _mobZoomed ? '' : 'none';
}

// ── Social Toggle Sync ─────────────────────────────────────────────────

// ── Video Time Update ──────────────────────────────────────────────────

/**
 * Called on the mobile video's timeupdate AND seeked events.
 * Follow/ride driver: keeps the clip window centered on the playhead
 * (follow mode), rides an armed edge on the playhead, or leaves a
 * parked (manual) window alone until the playhead leaves its bounds.
 * CRITICAL: never seeks the video — only moves window/edge markers.
 */
function _mobOnTimeUpdate() {
  if (_mobDragging) return;                 // never fight the finger
  var vid = _mobVideo();
  if (!vid || !isFinite(vid.currentTime)) return;
  var ct = vid.currentTime;
  if (ct < 0 || ct > _mobDuration + 0.5) return;  // +0.5: stream duration may exceed Plex metadata slightly

  if (!_mobZoomed) {
    // Stage 1: bracket always follows playhead (derived, just re-render)
  } else if (_mobPhase === 'start' && !_mobPhaseManual) {
    _mobStart = Math.max(_mobViewMin, Math.min(_mobEnd - 0.04, ct));
  } else if (_mobPhase === 'end' && !_mobPhaseManual) {
    _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobViewMax, ct));
  }
  // Phase null: no playhead-ride

  _mobUpdateTimeline();
  _mobUpdateTimes();
}

/** Center the clip window on time ct, preserving its duration. */
function _mobCenterWindowOn(ct) {
  var dur = _mobEnd - _mobStart;
  if (dur <= 0 || dur >= _mobDuration) return;  // whole movie — nothing to slide
  var half = dur / 2;
  var s = Math.max(0, Math.min(_mobDuration - dur, ct - half));
  _mobStart = s;
  _mobEnd = s + dur;
}

// ── Public API ─────────────────────────────────────────────────────────

// Functions intended for use as onclick handlers in the HTML are hoisted
// via function declarations above and are already globally available:
//   initMobileDetail(item)    — called from app.js showDetailView()
//   destroyMobileDetail()     — called from app.js goBack()/goHome()
//   mobSkip(delta)            — onclick for ⏪ / ⏩ buttons
//   mobNudgeStart(delta)      — onclick for Start fine-tune buttons
//   mobNudgeEnd(delta)        — onclick for End fine-tune buttons
//   mobPreset(duration)       — onclick for preset chips
//   mobDownload()             — onclick for download button
//   mobLoop()                 — onclick for loop preview button
//   mobToggleZoom()           — onclick for zoom toggle button
