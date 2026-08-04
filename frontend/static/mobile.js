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
  var pct = Math.max(0, Math.min(1, x / rect.width));

  var startPct = _mobDuration > 0 ? _mobStart / _mobDuration : 0;
  var endPct = _mobDuration > 0 ? _mobEnd / _mobDuration : 1;
  var startX = startPct * rect.width;
  var endX = endPct * rect.width;

  var HIT_RADIUS = 30; // px — generous for thumb-sized fingers

  var ZONE; // 'thumb-start' | 'thumb-end' | 'window' | 'empty'

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
    // Tap on empty area — snap the nearest handle to this position
    var toStart = Math.abs(x - startX);
    var toEnd = Math.abs(x - endX);
    _mobDragging = toStart < toEnd ? 'start' : 'end';
    _mobActiveHandle = _mobDragging;
    _mobMode = 'manual';   // snap applies immediately — manual placement

    // Apply snap immediately
    var t = _mobTimeFromPosition(x);
    _mobSetHandle(_mobDragging, t);
    ZONE = 'empty';
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

  if (_mobDragging === 'window') {
    // Slide the entire clip window — preserve duration.
    // Use relative tracking: window center = touch time - stored offset.
    var dur = _mobEnd - _mobStart;
    var newCenter = t - _mobWindowOffset;
    var halfDur = dur / 2;

    // Clamp so the window doesn't go past 0 or _mobDuration
    var newStart = Math.max(0, Math.min(_mobDuration - dur, newCenter - halfDur));
    _mobStart = newStart;
    _mobEnd = newStart + dur;

    // Seek to where the user's finger is — they see the frame they're touching
    seekVideoTo(Math.max(0, Math.min(_mobDuration, t)));
  } else {
    _mobSetHandle(_mobDragging, t);
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
        // Tap the fill → center the window on the tap position
        var rect = _mobTouchRect;
        if (rect) {
          var t = _mobTimeFromPosition(ct.clientX - rect.left);
          _mobCenterWindowOn(t);
          _mobUpdateTimeline();
          _mobUpdateTimes();
        }
      }
    }
  }

  _mobDragging = null;
  _mobTouchRect = null;
  _mobTapInfo = null;
}

// ── Handle & Time Helpers ─────────────────────────────────────────────

/**
 * Convert an x-pixel position within the timeline rect to a time in seconds.
 */
function _mobTimeFromPosition(x) {
  if (_mobDuration <= 0) return 0;
  return (x / (_mobTouchRect ? _mobTouchRect.width : 1)) * _mobDuration;
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

  var fill = _mobEls.fill;
  var thumbS = _mobEls.thumbStart;
  var thumbE = _mobEls.thumbEnd;

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
  var s = _mobEls.timeStart;
  var e = _mobEls.timeEnd;
  var d = _mobEls.timeDur;

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

  // Slide the clip window to follow the playback position
  var dur = _mobEnd - _mobStart;
  _mobStart = Math.max(0, newTime - dur / 2);
  _mobEnd = Math.min(_mobDuration, _mobStart + dur);
  if (_mobEnd - _mobStart < dur) {
    _mobStart = Math.max(0, _mobEnd - dur);
  }

  _mobMode = 'follow';   // skip re-engages follow (it already re-centers)

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
  } else if (_mobMode === 'follow') {
    _mobCenterWindowOn(ct);
  } else if (ct < _mobStart || ct > _mobEnd) {
    // browsed outside the parked window → re-enter follow
    _mobMode = 'follow';
    _mobCenterWindowOn(ct);
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
