/**
 * Cliparr — Mobile Interaction Module
 *
 * Two-thumb timeline scrubber, transport controls, fine-tune nudge,
 * preset chips, download flow, social toggle sync, and lifecycle hooks.
 *
 * All functions use 'mob' or '_mob' prefix to avoid collisions with
 * app.js globals. References shared globals: _sliderStart, _sliderEnd,
 * state, dom, seekVideoTo, fmtTime, downloadClip, toggleCaptions,
 * toggleVertical, updateToggleButtons, updateSocialToggles.
 *
 * Loaded after app.js via <script src="static/mobile.js?v=15"></script>.
 */

// ── Module State ───────────────────────────────────────────────────────

var _mobStart = 0;            // float, clip start in seconds
var _mobEnd = 139;            // float, clip end in seconds
var _mobDuration = 0;         // total media duration in seconds
var _mobActiveHandle = 'start';  // which handle was last touched ('start' | 'end')
var _mobDragging = null;      // null | 'start' | 'end' | 'window'
var _mobZoom = 1;             // timeline zoom level (1 = full movie)
var _mobZoomCenter = 0;       // center point of zoom in seconds
var _mobVideoReady = false;

// Pinch-to-zoom tracking
var _mobPinchActive = false;
var _mobPinchBaseDist = 0;
var _mobPinchBaseZoom = 1;

// Progress mirroring
var _mobProgressTimer = null;

// Touch position cache (filled at touchstart, reused in touchmove to avoid
// getBoundingClientRect layout thrash on every move event)
var _mobTouchRect = null;

// ── DOM helpers ────────────────────────────────────────────────────────

/** Get the mobile video element (the second #preview-video in the DOM,
 *  inside .mob-video-container). Two elements share the same id in this
 *  codebase — the first (desktop) lives in #frame-preview, the second
 *  (mobile) in .mob-video-container. */
function _mobVideo() {
  return document.querySelector('.mob-video-container video[id="preview-video"]');
}

// ── Initialisation / Teardown ──────────────────────────────────────────

/**
 * Called from app.js showDetailView() when on a mobile viewport.
 * Initialises the mobile clip detail view with the given Plex item.
 */
function initMobileDetail(item) {
  // Reset zoom to full-movie
  _mobZoom = 1;
  _mobZoomCenter = 0;
  _mobDragging = null;
  _mobVideoReady = false;

  _mobDuration = (item.duration || 0) / 1000;
  if (_mobDuration <= 0) _mobDuration = 139;

  // Sync from desktop / jump-offset state
  if (window._jumpOffset != null) {
    _mobStart = Math.max(0, window._jumpOffset - 5);
    _mobEnd = Math.min(_mobDuration, window._jumpOffset + 25);
    window._jumpOffset = null;
    window._jumpDuration = null;
  } else {
    _mobStart = 0;
    _mobEnd = Math.min(139, _mobDuration);
  }

  _mobActiveHandle = 'start';

  // Wire timeline touch events
  initMobileTimeline();

  // Initial paint
  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateDownloadBtn();
  _mobUpdateActiveLabel();

  // Clear preset highlights
  var btns = document.querySelectorAll('.mob-preset-btn');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');

  // Wire video events on the mobile video element
  var vid = _mobVideo();
  if (vid) {
    vid.addEventListener('timeupdate', _mobOnTimeUpdate);
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

  // Wire video tap-to-play/pause overlay
  var overlay = document.getElementById('mob-video-overlay');
  if (overlay) {
    overlay.addEventListener('click', mobTogglePlay);
    overlay.addEventListener('touchend', function(e) {
      e.preventDefault();
      mobTogglePlay();
    });
  }

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
  }
  _mobDragging = null;
  _mobPinchActive = false;
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
  var tl = document.getElementById('mob-timeline');
  if (!tl) return;

  // Remove old listeners (idempotent re-init)
  tl.removeEventListener('touchstart', _mobTimelineTouchStart);
  document.removeEventListener('touchmove', _mobTimelineTouchMove);
  document.removeEventListener('touchend', _mobTimelineTouchEnd);
  tl.removeEventListener('touchstart', _mobTimelinePinchStart);

  tl.addEventListener('touchstart', _mobTimelineTouchStart, { passive: false });
  tl.addEventListener('touchstart', _mobTimelinePinchStart, { passive: false });
  document.addEventListener('touchmove', _mobTimelineTouchMove, { passive: false });
  document.addEventListener('touchend', _mobTimelineTouchEnd);
  document.addEventListener('touchcancel', _mobTimelineTouchEnd);
}

/** touchstart: identify target (handle, fill window, empty area). */
function _mobTimelineTouchStart(e) {
  if (e.touches.length !== 1) return; // single-finger only; pinch handled separately

  var tl = document.getElementById('mob-timeline');
  if (!tl) return;

  var touch = e.touches[0];
  var rect = tl.getBoundingClientRect();
  _mobTouchRect = rect; // cache for touchmove

  var x = touch.clientX - rect.left;
  var pct = Math.max(0, Math.min(1, x / rect.width));

  var startPct = _mobDuration > 0 ? _mobStart / _mobDuration : 0;
  var endPct = _mobDuration > 0 ? _mobEnd / _mobDuration : 1;
  var startX = startPct * rect.width;
  var endX = endPct * rect.width;

  var HIT_RADIUS = 30; // px — generous for thumb-sized fingers

  if (Math.abs(x - startX) < HIT_RADIUS) {
    _mobDragging = 'start';
    _mobActiveHandle = 'start';
  } else if (Math.abs(x - endX) < HIT_RADIUS) {
    _mobDragging = 'end';
    _mobActiveHandle = 'end';
  } else if (x > startX && x < endX) {
    // Dragging the fill area → slide entire clip window, preserve duration
    _mobDragging = 'window';
  } else {
    // Tap on empty area — snap the nearest handle to this position
    var toStart = Math.abs(x - startX);
    var toEnd = Math.abs(x - endX);
    _mobDragging = toStart < toEnd ? 'start' : 'end';
    _mobActiveHandle = _mobDragging;

    // Apply snap immediately
    var t = _mobTimeFromPosition(x);
    _mobSetHandle(_mobDragging, t);
  }

  _mobUpdateTimeline();
  _mobUpdateTimes();
  _mobUpdateActiveLabel();

  e.preventDefault();
}

/** touchmove: drag handle or slide window, seek video in real-time. */
function _mobTimelineTouchMove(e) {
  if (!_mobDragging) return;
  if (e.touches.length !== 1) return;

  var tl = document.getElementById('mob-timeline');
  if (!tl) return;

  var rect = _mobTouchRect || tl.getBoundingClientRect();
  var touch = e.touches[0];
  var x = Math.max(0, Math.min(rect.width, touch.clientX - rect.left));
  var t = _mobTimeFromPosition(x);

  if (_mobDragging === 'window') {
    // Slide the entire clip window — preserve duration
    var dur = _mobEnd - _mobStart;
    var halfDur = dur / 2;
    var newCenter = t;

    // Clamp so the window doesn't go past 0 or _mobDuration
    var newStart = Math.max(0, Math.min(_mobDuration - dur, newCenter - halfDur));
    _mobStart = newStart;
    _mobEnd = newStart + dur;

    // Seek to the center of the new window position for visual feedback
    var seekT = newStart + halfDur / 2;
    seekVideoTo(Math.max(0, Math.min(_mobDuration, seekT)));
  } else {
    _mobSetHandle(_mobDragging, t);
  }

  _mobUpdateTimeline();
  _mobUpdateTimes();

  e.preventDefault();
}

/** touchend / touchcancel: stop dragging, update button states. */
function _mobTimelineTouchEnd(e) {
  if (_mobDragging) {
    _mobUpdateDownloadBtn();
  }
  _mobDragging = null;
  _mobTouchRect = null;
}

// ── Pinch-to-Zoom ─────────────────────────────────────────────────────

/** Detect two-finger touch on the timeline — begin pinch tracking. */
function _mobTimelinePinchStart(e) {
  if (e.touches.length !== 2) return;

  var tl = document.getElementById('mob-timeline');
  if (!tl) return;

  var t0 = e.touches[0];
  var t1 = e.touches[1];
  var dx = t1.clientX - t0.clientX;
  var dy = t1.clientY - t0.clientY;
  _mobPinchBaseDist = Math.sqrt(dx * dx + dy * dy);
  _mobPinchBaseZoom = _mobZoom;
  _mobPinchActive = true;

  // Record the zoom center in timeline-pixel space
  var rect = tl.getBoundingClientRect();
  var cx = (t0.clientX + t1.clientX) / 2 - rect.left;
  var pct = Math.max(0, Math.min(1, cx / rect.width));
  _mobZoomCenter = _mobTimeFromPosition((t0.clientX + t1.clientX) / 2 - rect.left);

  // Switch to pinch tracking on move
  document.addEventListener('touchmove', _mobTimelinePinchMove, { passive: false });
  document.addEventListener('touchend', _mobTimelinePinchEnd);
  document.addEventListener('touchcancel', _mobTimelinePinchEnd);

  e.preventDefault();
}

function _mobTimelinePinchMove(e) {
  if (!_mobPinchActive || e.touches.length !== 2) return;

  var t0 = e.touches[0];
  var t1 = e.touches[1];
  var dx = t1.clientX - t0.clientX;
  var dy = t1.clientY - t0.clientY;
  var dist = Math.sqrt(dx * dx + dy * dy);

  if (_mobPinchBaseDist <= 0) return;

  var scale = dist / _mobPinchBaseDist;
  var newZoom = Math.max(1, Math.min(20, _mobPinchBaseZoom * scale));
  _mobZoom = newZoom;

  // Apply CSS transform to the timeline for visual feedback
  var tl = document.getElementById('mob-timeline');
  if (tl) {
    tl.style.transform = 'scaleX(' + _mobZoom + ')';
    tl.style.transformOrigin = 'center center';
  }

  _mobUpdateTimeline();

  e.preventDefault();
}

function _mobTimelinePinchEnd(e) {
  _mobPinchActive = false;
  document.removeEventListener('touchmove', _mobTimelinePinchMove);
  document.removeEventListener('touchend', _mobTimelinePinchEnd);
  document.removeEventListener('touchcancel', _mobTimelinePinchEnd);
}

// ── Handle & Time Helpers ─────────────────────────────────────────────

/**
 * Convert an x-pixel position within the timeline rect to a time in
 * seconds, respecting the current zoom level.
 */
function _mobTimeFromPosition(x) {
  if (_mobDuration <= 0) return 0;
  if (_mobZoom <= 1) {
    // Full-movie mode
    return (x / (_mobTouchRect ? _mobTouchRect.width : 1)) * _mobDuration;
  }
  // Zoomed mode: the visible window is _mobDuration / _mobZoom wide,
  // centered on _mobZoomCenter.
  var visibleWidth = _mobDuration / _mobZoom;
  var halfVis = visibleWidth / 2;
  var rectW = _mobTouchRect ? _mobTouchRect.width : 1;
  var pct = Math.max(0, Math.min(1, x / rectW));
  var t = (_mobZoomCenter - halfVis) + pct * visibleWidth;
  return Math.max(0, Math.min(_mobDuration, t));
}

/**
 * Set a handle (start or end) to time t. Clamps so start < end (minimum
 * 0.04 s gap — one frame at 25 fps). Seeks the video to the new position.
 */
function _mobSetHandle(which, t) {
  if (which === 'start') {
    _mobStart = Math.max(0, Math.min(_mobEnd - 0.04, t));
    seekVideoTo(_mobStart);
  } else {
    _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobDuration, t));
    seekVideoTo(_mobEnd);
  }
  _mobActiveHandle = which;
}

/**
 * Reposition the timeline fill bar and thumb handles as CSS percentages.
 */
function _mobUpdateTimeline() {
  if (_mobDuration <= 0) return;

  var startPct = (_mobStart / _mobDuration) * 100;
  var endPct = (_mobEnd / _mobDuration) * 100;

  var fill = document.getElementById('mob-timeline-fill');
  var thumbS = document.getElementById('mob-thumb-start');
  var thumbE = document.getElementById('mob-thumb-end');

  if (fill) {
    fill.style.left = startPct + '%';
    fill.style.width = (endPct - startPct) + '%';
  }
  if (thumbS) thumbS.style.left = startPct + '%';
  if (thumbE) thumbE.style.left = endPct + '%';

  // Highlight active thumb
  if (thumbS) thumbS.classList.toggle('active', _mobActiveHandle === 'start');
  if (thumbE) thumbE.classList.toggle('active', _mobActiveHandle === 'end');
}

/** Write current times to the three mobile time displays. */
function _mobUpdateTimes() {
  var s = document.getElementById('mob-time-start');
  var e = document.getElementById('mob-time-end');
  var d = document.getElementById('mob-time-dur');

  if (s) s.textContent = fmtTime(_mobStart, true);
  if (e) e.textContent = fmtTime(_mobEnd, true);

  var dur = _mobEnd - _mobStart;
  if (d) {
    if (dur >= 1) {
      d.textContent = Math.round(dur) + 's';
    } else {
      d.textContent = dur.toFixed(1) + 's';
    }
  }
}

/** Update the fine-tune active label to show "Start" or "End". */
function _mobUpdateActiveLabel() {
  var lbl = document.getElementById('mob-ft-active-label');
  if (!lbl) return;
  lbl.textContent = _mobActiveHandle === 'start' ? 'Start' : 'End';
  lbl.className = 'mob-ft-active ' + _mobActiveHandle;
}

// ── Transport Controls ─────────────────────────────────────────────────

// ── Fine-Tune (Nudge Bar) ──────────────────────────────────────────────

/**
 * Nudge the active handle by delta seconds.
 * Typical values: ±0.04 (one frame at 25 fps) or ±5 (coarse jump).
 */
function mobNudgeActive(delta) {
  if (_mobActiveHandle === 'start') {
    _mobStart = Math.max(0, Math.min(_mobEnd - 0.04, _mobStart + delta));
    seekVideoTo(_mobStart);
  } else {
    _mobEnd = Math.max(_mobStart + 0.04, Math.min(_mobDuration, _mobEnd + delta));
    seekVideoTo(_mobEnd);
  }
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
  var bar = document.getElementById('mob-clip-progress');
  var fill = document.getElementById('mob-clip-progress-fill');
  var text = document.getElementById('mob-clip-progress-text');
  var status = document.getElementById('mob-clip-status');

  if (bar) bar.style.display = 'block';
  if (fill) fill.style.width = '0%';
  if (text) text.textContent = 'Starting clip...';
  if (status) status.textContent = '';
}

/** Hide the mobile progress bar and stop mirroring. */
function _mobHideProgress() {
  _mobStopProgressPolling();
  var bar = document.getElementById('mob-clip-progress');
  if (bar) bar.style.display = 'none';
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
    var desktopFill = document.getElementById('clip-progress-fill');
    var desktopText = document.getElementById('clip-progress-text');

    // Desktop progress hidden → download finished, stop mirroring
    if (desktopBar && desktopBar.style.display === 'none') {
      _mobHideProgress();
      return;
    }

    var mobFill = document.getElementById('mob-clip-progress-fill');
    var mobText = document.getElementById('mob-clip-progress-text');

    if (desktopFill && mobFill) {
      mobFill.style.width = desktopFill.style.width || '0%';
    }
    if (desktopText && mobText) {
      mobText.textContent = desktopText.textContent || 'Encoding...';
    }

    // Also mirror the desktop status text to mobile status
    var desktopStatus = document.getElementById('clip-status');
    var mobStatus = document.getElementById('mob-clip-status');
    if (desktopStatus && mobStatus && desktopStatus.textContent) {
      mobStatus.textContent = desktopStatus.textContent;
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
  var btn = document.getElementById('mob-btn-download');
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

// ── Social Toggle Sync ─────────────────────────────────────────────────

/**
 * Exported hook called by updateToggleButtons() / updateSocialToggles()
 * from app.js to keep the mobile checkboxes in sync with desktop state.
 * Called automatically after desktop toggle state changes.
 *
 * Since updateToggleButtons() already sets mob-chk-captions/.checked and
 * mob-chk-vertical/.checked (L1463-1467 in app.js), this is a no-op by
 * default. But it's available as an explicit sync point if needed.
 */
function mobSyncSocialState() {
  var cc = document.getElementById('mob-chk-captions');
  var cv = document.getElementById('mob-chk-vertical');
  if (cc && typeof _captionsEnabled !== 'undefined') cc.checked = _captionsEnabled;
  if (cv && typeof _verticalEnabled !== 'undefined') cv.checked = _verticalEnabled;
}

// ── Video Time Update ──────────────────────────────────────────────────

/**
 * Called on the mobile video's timeupdate event. Updates the timeline
 * to reflect the current playback position (playhead tracking).
 */
function _mobOnTimeUpdate() {
  var vid = _mobVideo();
  if (!vid || !isFinite(vid.currentTime)) return;

  // Only update timeline visuals — don't change handle positions.
  // The fill and thumbs remain where the user set them; the playhead
  // is visually indicated by the active handle highlight.
  // We still call _mobUpdateTimeline() so the fill reflects current
  // state, and _mobUpdateTimes() for the time displays.
  _mobUpdateTimes();

  // Highlight the handle closest to the playback position so the user
  // sees the playhead relative to their clip range.
  var toStart = Math.abs(vid.currentTime - _mobStart);
  var toEnd = Math.abs(vid.currentTime - _mobEnd);
  // Don't change _mobActiveHandle during playback — that's user-controlled.
  // But we do provide a visual cue via the range bar if it exists.
  _mobUpdateTimeline();
}

// ── Public API ─────────────────────────────────────────────────────────

// Functions intended for use as onclick handlers in the HTML are hoisted
// via function declarations above and are already globally available:
//   initMobileDetail(item)    — called from app.js showDetailView()
//   destroyMobileDetail()     — called from app.js goBack()/goHome()
//   mobTogglePlay()           — onclick for play/pause button
//   mobSkip(delta)            — onclick for ⏪ / ⏩ buttons
//   mobNudgeActive(delta)     — onclick for fine-tune buttons
//   mobPreset(duration)       — onclick for preset chips
//   mobDownload()             — onclick for download button
//   mobSyncSocialState()      — explicit sync hook
