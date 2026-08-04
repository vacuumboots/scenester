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
var _mobMode = 'follow';   // 'follow' | 'manual'
var _mobArmed = null;      // null | 'start' | 'end'
var _mobTapInfo = null;    // {x, y, t, zone} for tap-vs-drag detection
var _mobZoomed = false;      // true = stage 2 active: frozen 10-min neighborhood view
var _mobZoomSpan = 600;      // seconds — 10 minutes (fixed zoom level)
var _mobBracketStart = 0;    // stage-1 neighborhood window (seconds)
var _mobBracketEnd = 600;
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
  _mobMode = 'follow';
  _mobArmed = null;
  _mobTapInfo = null;
  _mobZoomed = false;
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

  // Stage-1 bracket: fixed 600s neighborhood on the full-movie timeline,
  // starting at 0 (or centered on the jump offset if we jumped in).
  _mobBracketStart = 0;
  _mobBracketEnd = Math.min(_mobZoomSpan, _mobDuration);
  if (jumpOff != null) _mobCenterBracketOn(jumpOff);

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
      _mobMode = 'manual';   // direct manipulation parks the window
      ZONE = 'thumb-start';
    } else if (Math.abs(x - endX) < HIT_RADIUS) {
      _mobDragging = 'end';
      _mobActiveHandle = 'end';
      _mobMode = 'manual';
      ZONE = 'thumb-end';
    } else if (x > startX && x < endX) {
      // Dragging the fill area → slide entire clip window, preserve duration.
      // Record the offset between the touch point and the window center so
      // the window doesn't jump on first touch (relative tracking).
      _mobDragging = 'window';
      _mobMode = 'manual';
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
    // Stage 1: bracket = gold window; thumbs hidden, no thumb zones.
    var bStartPct = span > 0 ? Math.max(0, Math.min(1, (_mobBracketStart - _mobViewMin) / span)) : 0;
    var bEndPct = span > 0 ? Math.max(0, Math.min(1, (_mobBracketEnd - _mobViewMin) / span)) : 1;
    var bStartX = bStartPct * rect.width;
    var bEndX = bEndPct * rect.width;

    if (x > bStartX && x < bEndX) {
      // Fill = bracket: drag slides the fixed 600s neighborhood.
      _mobDragging = 'window';
      _mobMode = 'manual';
      var bTouchT = _mobTimeFromPosition(x);
      var bCenter = (_mobBracketStart + _mobBracketEnd) / 2;
      _mobWindowOffset = bTouchT - bCenter;
      ZONE = 'window';
    } else {
      // Stage 1 empty: zoom into this neighborhood (centered on tap).
      var tapT = (x / rect.width) * _mobDuration;   // full-movie mapping
      var half = _mobZoomSpan / 2;
      var bs = Math.max(0, Math.min(_mobDuration - Math.min(_mobZoomSpan, _mobDuration), tapT - half));
      _mobBracketStart = bs;
      _mobBracketEnd = Math.min(_mobDuration, bs + _mobZoomSpan);
      if (_mobBracketEnd - _mobBracketStart < _mobZoomSpan) _mobBracketStart = Math.max(0, _mobBracketEnd - _mobZoomSpan);
      mobToggleZoom();   // freeze view on bracket, park, center clip
      ZONE = 'zoom';
    }
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
    var newStart;
    if (!_mobZoomed) {
      // Stage 1: slide the BRACKET (fixed 600s neighborhood).
      var bDur = _mobBracketEnd - _mobBracketStart;
      var bHalf = bDur / 2;
      newStart = Math.max(0, Math.min(_mobDuration - bDur, (t - _mobWindowOffset) - bHalf));
      _mobBracketStart = newStart;
      _mobBracketEnd = newStart + bDur;
    } else {
      // Stage 2: slide the clip window WITHIN the frozen view (view untouched).
      var dur = _mobEnd - _mobStart;
      var halfDur = dur / 2;
      var vSpan = _mobViewMax - _mobViewMin;
      newStart = Math.max(_mobViewMin, Math.min(_mobViewMin + Math.max(0, vSpan - dur), (t - _mobWindowOffset) - halfDur));
      _mobStart = newStart;
      _mobEnd = newStart + dur;
    }

    // Debounced seek to where the user's finger is — flushed on touchend
    _mobSeekTo(Math.max(0, Math.min(_mobDuration, t)));
  } else {
    _mobSetHandle(_mobDragging, t, true);   // handle position live, seek debounced
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
        _mobToggleArmed('start');
      } else if (info.zone === 'thumb-end') {
        _mobToggleArmed('end');
      } else if (info.zone === 'window') {
        // Tap the fill: stage 1 → re-center the bracket; stage 2 → seek the
        // playhead there (the range itself only changes via the thumbs).
        var rect = _mobTouchRect;
        if (rect) {
          var t = _mobTimeFromPosition(ct.clientX - rect.left);
          if (!_mobZoomed) {
            _mobCenterBracketOn(t);
          } else {
            _mobSeekTo(Math.max(0, Math.min(_mobDuration, t)), true);
          }
          _mobUpdateTimeline();
          _mobUpdateTimes();
        }
      }
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
    // Stage 1: the gold window IS the 10-min bracket. Thumbs hidden.
    if (fill) {
      fill.style.left = pct(_mobBracketStart) + '%';
      fill.style.width = (pct(_mobBracketEnd) - pct(_mobBracketStart)) + '%';
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
    // Armed phase dimming: the non-active thumb fades while the other is set
    if (thumbS) thumbS.classList.toggle('armed-dim', _mobArmed === 'end');
    if (thumbE) thumbE.classList.toggle('armed-dim', _mobArmed === 'start');
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

  if (thumbS) thumbS.classList.toggle('active', _mobActiveHandle === 'start');
  if (thumbE) thumbE.classList.toggle('active', _mobActiveHandle === 'end');
}

/** Write current times to the three mobile time displays. */
function _mobUpdateTimes() {
  var s = _mobEls.timeStart;
  var e = _mobEls.timeEnd;
  var d = _mobEls.timeDur;

  // Stage 1 shows the bracket; stage 2 shows the clip.
  if (s) s.textContent = fmtTime(_mobZoomed ? _mobStart : _mobBracketStart, true);
  if (e) e.textContent = fmtTime(_mobZoomed ? _mobEnd : _mobBracketEnd, true);

  var dur = _mobZoomed ? (_mobEnd - _mobStart) : (_mobBracketEnd - _mobBracketStart);
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

  if (!_mobZoomed) {
    // Stage 1: slide the bracket to follow the new playback position.
    var dur = _mobBracketEnd - _mobBracketStart;
    _mobBracketStart = Math.max(0, newTime - dur / 2);
    _mobBracketEnd = Math.min(_mobDuration, _mobBracketStart + dur);
    if (_mobBracketEnd - _mobBracketStart < dur) {
      _mobBracketStart = Math.max(0, _mobBracketEnd - dur);
    }
  }
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
  _mobMode = 'manual';   // nudge parks the window
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
  _mobMode = 'manual';   // nudge parks the window
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
  _mobArmed = null;
  _mobMode = 'manual';
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
    // Stage 1 → 2: freeze the view on the bracket, park + center the clip in it.
    _mobZoomed = true;
    _mobMode = 'manual';
    _mobArmed = null;
    _mobSetViewFrozen(_mobBracketStart, _mobBracketEnd);
    var viewCenter = (_mobViewMin + _mobViewMax) / 2;
    _mobCenterWindowOn(viewCenter);   // clip centers in frozen view (preserves duration)
  } else {
    // Stage 2 → 1: back to full movie; bracket re-centers on clip center.
    _mobZoomed = false;
    _mobSetViewFull();
    _mobCenterBracketOn((_mobStart + _mobEnd) / 2);
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
      el.textContent = 'STEP 1/2 \u2014 pick your 10 minutes';
    } else if (_mobArmed === 'start') {
      el.textContent = 'STEP 2/2 \u2014 set start: scrub to the in-point, tap start to lock';
    } else if (_mobArmed === 'end') {
      el.textContent = 'STEP 2/2 \u2014 set end: scrub to the out-point, tap end to lock';
    } else {
      el.textContent = 'STEP 2/2 \u2014 tap a thumb to set start, then end';
    }
  }
  // Fine-tune rows are stage-2 only (the clip is irrelevant in stage 1).
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

  if (_mobArmed === 'start') {
    _mobStart = Math.max(0, Math.min(_mobEnd - 0.04, ct));
  } else if (_mobArmed === 'end') {
    _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobDuration, ct));
  } else if (_mobZoomed) {
    // Zoomed = tuning, not browsing: window stays parked, playhead line
    // updates via _mobUpdateTimeline() below.
  } else if (_mobMode === 'follow') {
    // Stage 1 follow: the BRACKET chases the playhead (not the clip).
    _mobCenterBracketOn(ct);
  } else if (ct < _mobStart || ct > _mobEnd) {
    // browsed outside the parked window → re-enter follow (bracket chases)
    _mobMode = 'follow';
    _mobCenterBracketOn(ct);
  }

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

/** Center the stage-1 bracket (fixed 600s neighborhood) on time ct. */
function _mobCenterBracketOn(ct) {
  var half = _mobZoomSpan / 2;
  var s = Math.max(0, Math.min(_mobDuration - Math.min(_mobZoomSpan, _mobDuration), ct - half));
  _mobBracketStart = s;
  _mobBracketEnd = Math.min(_mobDuration, s + _mobZoomSpan);
  if (_mobBracketEnd - _mobBracketStart < _mobZoomSpan) _mobBracketStart = Math.max(0, _mobBracketEnd - _mobZoomSpan);
}

/**
 * Toggle arm/pin for an edge: armed → lock (edge stays put); locked → arm
 * (edge rides the playhead on the next timeupdate/seeked).
 */
function _mobToggleArmed(which) {
  // Toggle: armed → lock (edge stays at current position). Locked → arm (edge rides playhead).
  if (_mobArmed === which) {
    _mobArmed = null;                       // lock
    _mobMode = 'manual';                    // window is now parked where user pinned it
  } else {
    _mobArmed = which;                      // arm: next timeupdate rides this edge to the playhead
    _mobMode = 'manual';
    // If the playhead is outside the parked window, bring the window to it
    // first — otherwise the armed edge clamps against a far-away edge and
    // the window collapses to a sliver.
    var vid = _mobVideo();
    if (vid && isFinite(vid.currentTime)) {
      var ct = vid.currentTime;
      if (ct < _mobStart || ct > _mobEnd) _mobCenterWindowOn(ct);
    }
  }
  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateStageLabel();   // arm/lock changes the stage-2 instruction text
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
