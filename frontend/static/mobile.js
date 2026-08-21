/**
 * Scenester — Mobile Mark-From-Playhead Module
 *
 * Minimal mobile clip editor: native video controls are the only scrubber.
 * Two huge buttons mark clip edges from video.currentTime. The range follows
 * the playhead (browse mode) until an edge is marked, then stays anchored
 * (or rides the playhead again after Unset Start/End).
 *
 * Reads/writes the app.js globals DIRECTLY (_sliderStart, _sliderEnd via
 * setSliderStart/setSliderEnd). No parallel mobile state. Mobile state:
 * _mobStartSet/_mobEndSet flags; _mobBrowse is DERIVED via _mobSyncBrowse().
 *
 * ES5 only (no arrow functions, no let/const, no template literals).
 * Loaded after app.js via <script src="static/mobile.js?v=33"></script>.
 */

// ── Module state ───────────────────────────────────────────────────────

var _mobBrowse = true;          // derived: true while NEITHER edge is pinned
var _mobStartSet = false;       // true = start edge explicitly marked/pinned
var _mobEndSet = false;         // true = end edge explicitly marked/pinned
var _mobEls = {};               // cached DOM refs (filled at init)
var _mobActivePreset = 0;       // 0 = free mode; otherwise active preset seconds
var _mobFlashTimer = null;      // "just-marked" button flash timeout

/** Keep _mobBrowse derived from the two edge flags (single source of truth). */
function _mobSyncBrowse() {
  _mobBrowse = !_mobStartSet && !_mobEndSet;
}

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
  _mobEls.snapStart = document.getElementById("mob-snap-start");
  _mobEls.snapStartImg = document.getElementById("mob-snap-start-img");
  _mobEls.snapEnd = document.getElementById("mob-snap-end");
  _mobEls.snapEndImg = document.getElementById("mob-snap-end-img");
  _mobEls.btnUnsetStart = document.getElementById("mob-btn-unset-start");
  _mobEls.btnUnsetEnd = document.getElementById("mob-btn-unset-end");
  _mobEls.progress = document.getElementById("mob-clip-progress");
  _mobEls.progressFill = document.getElementById("mob-clip-progress-fill");
  _mobEls.progressText = document.getElementById("mob-clip-progress-text");
  _mobEls.status = document.getElementById("mob-clip-status");
  _mobEls.presetBtns = document.querySelectorAll(".mob-preset-btn");
  _mobEls.rangeSummary = document.getElementById("range-summary");
}

// ── Lifecycle ──────────────────────────────────────────────────────────

/**
 * Called from app.js showDetailView() on mobile viewports.
 * Idempotent-safe: re-caches DOM and re-wires listeners every call.
 */
function initMobileDetail(item) {
  _mobCacheDom();
  if (_mobFlashTimer) { clearTimeout(_mobFlashTimer); _mobFlashTimer = null; }

  _mobStartSet = false;
  _mobEndSet = false;
  _mobSyncBrowse();
  _mobActivePreset = 0;
  _mobLast = null;  // force full render on entry
  _mobHideSnap("start");
  _mobHideSnap("end");

  var vid = _mobEls.video;
  if (vid) {
    vid.removeEventListener("timeupdate", _mobOnTimeUpdate);
    vid.removeEventListener("seeked", _mobOnTimeUpdate);
    vid.removeEventListener("pause", _mobOnPlayPause);
    vid.removeEventListener("play", _mobOnPlayPause);
    vid.addEventListener("timeupdate", _mobOnTimeUpdate);
    vid.addEventListener("seeked", _mobOnTimeUpdate);
    vid.addEventListener("pause", _mobOnPlayPause);
    vid.addEventListener("play", _mobOnPlayPause);
  }

  // Default: FREE — neither start nor end selected. Empty range; the user
  // marks both edges. (Assign directly so the range stays a true 0-length —
  // setSliderEnd() floors at 0.01s and updateTimeDisplay() would widen it.)
  _sliderStart = 0;
  _sliderEnd = 0;

  if (_mobEls.status) _mobEls.status.textContent = "";
  _mobRender();
  // v=67+: fine-tune is a collapsed chip in the collapse row — no auto-open
  // (the old mobile bottom-sheet default fought the collapsed design).
}

/** Called from app.js goBack()/goHome(). Removes listeners, clears timers. */
function destroyMobileDetail() {
  if (_mobFlashTimer) { clearTimeout(_mobFlashTimer); _mobFlashTimer = null; }
  var vid = _mobEls.video;
  if (vid) {
    vid.removeEventListener("timeupdate", _mobOnTimeUpdate);
    vid.removeEventListener("seeked", _mobOnTimeUpdate);
    vid.removeEventListener("pause", _mobOnPlayPause);
    vid.removeEventListener("play", _mobOnPlayPause);
  }
  _mobStartSet = false;
  _mobEndSet = false;
  _mobSyncBrowse();
}

// ── Follow driver ──────────────────────────────────────────────────────

/**
 * timeupdate + seeked handler on the shared video.
 *
 * FOUR modes (decided by the two edge flags):
 * 1. NEITHER pinned (_mobBrowse): center the range window on the playhead,
 *    preserving duration — "range follows wherever I look/scrub".
 * 2. Start pinned, end free: END rides the playhead (clip grows as you
 *    watch); start stays. This is the natural "mark start, play, clip
 *    extends until I tap Set End" flow.
 * 3. End pinned, start free: START rides the playhead (after Unset Start).
 * 4. BOTH pinned: anchored — no-op.
 *
 * NEVER seeks or writes vid.currentTime here — that would loop forever.
 * Setters only update state + desktop readouts.
 */
function _mobOnTimeUpdate() {
  var vid = _mobEls.video;
  if (!vid || !vid.duration || isNaN(vid.duration) || vid.duration <= 0) return;

  var ct = vid.currentTime;
  var maxDur = state.mediaDuration > 0 ? state.mediaDuration : vid.duration;

  if (!_mobStartSet && !_mobEndSet) {
    // Browse mode: center the window on the playhead. In FREE mode nothing
    // is selected (0-length window) so there's nothing to center — skip.
    var dur = _sliderEnd - _sliderStart;
    if (dur > maxDur) dur = maxDur;
    if (dur > 0.04) {
      var start = ct - (dur / 2);
      start = Math.max(0, Math.min(maxDur - dur, start));
      setSliderStart(start);
      setSliderEnd(start + dur);
    }
  } else if (_mobStartSet && !_mobEndSet) {
    // End rides the playhead (start pinned)
    var ne = Math.max(_sliderStart + 0.04, Math.min(maxDur, ct));
    setSliderEnd(ne);
  } else if (!_mobStartSet && _mobEndSet) {
    // Start rides the playhead (end pinned)
    var ns = Math.max(0, Math.min(_sliderEnd - 0.04, ct));
    setSliderStart(ns);
  }
  // Both pinned: anchored, nothing to do.
  // Caption-line follow: keep the active line highlighted while scrubbing
  // (no-op when no lines are loaded — app.js globals).
  if (_captionLines && _captionLines.length) {
    var li = _findLineAt(ct);
    if (li !== _activeLineIdx) _setActiveLine(li, false);
  }
  _mobRender();
}

/** Play/pause both just re-render (loop button label + unset visibility). */
function _mobOnPlayPause() {
  _mobRender();
}

// ── Mark buttons ───────────────────────────────────────────────────────

/** Mark the start edge at an explicit time (Set Start button AND
 *  film-strip tap). Free mode marks start only (end rides the playhead);
 *  a preset pins start and auto-sets end = start + preset. */
function mobMarkStartAt(t) {
  setSliderStart(t);
  _mobStartSet = true;
  if (_mobActivePreset > 0) {
    setSliderEnd(Math.min(_sliderStart + _mobActivePreset, state.mediaDuration));
    _mobEndSet = true;
    _mobRefreshSnap("end");
  } else {
    _mobEndSet = false;
    if (_sliderEnd <= _sliderStart) setSliderEnd(_sliderStart + 0.04);
  }
  _mobSyncBrowse();
  _mobFlash(_mobEls.btnStart);
  if (_mobEls.status) _mobEls.status.textContent = "";
  _mobRefreshSnap("start");
  _mobRender();
}

function mobMarkStart() {
  var vid = _mobEls.video;
  if (!vid) return;
  mobMarkStartAt(vid.currentTime);
}

/** Mark the end edge at an explicit time (Set End button AND film-strip
 *  shift+click). Guards against end <= start when start is pinned. */
function mobMarkEndAt(t) {
  var vid = _mobEls.video;
  if (_mobStartSet && t <= _sliderStart + 0.04) {
    if (_mobEls.status) _mobEls.status.textContent = "End must be after start";
    return;
  }
  setSliderEnd(t);
  _mobStartSet = true;
  _mobEndSet = true;
  _mobSyncBrowse();
  if (vid) vid.pause();
  _mobFlash(_mobEls.btnEnd);
  if (_mobEls.status) _mobEls.status.textContent = "";
  _mobRefreshSnap("end");
  _mobRender();
}

function mobMarkEnd() {
  var vid = _mobEls.video;
  if (!vid) return;
  mobMarkEndAt(vid.currentTime);
}

// ── Unset buttons ──────────────────────────────────────────────────────

/** Clear the start mark. The start edge rides the playhead again
 *  (end stays pinned if set); if nothing is pinned, back to browse mode. */
function mobUnsetStart() {
  _mobStartSet = false;
  _mobSyncBrowse();
  _mobOnTimeUpdate(); // immediately apply ride/browse to the current playhead
  if (_mobEls.status) _mobEls.status.textContent = "Start unset — follows the playhead";
  _mobHideSnap("start");
  _mobRender();
}

/** Clear the end mark. The end edge rides the playhead again
 *  (start stays pinned if set); if nothing is pinned, back to browse mode. */
function mobUnsetEnd() {
  _mobEndSet = false;
  _mobSyncBrowse();
  _mobOnTimeUpdate();
  if (_mobEls.status) _mobEls.status.textContent = "End unset — follows the playhead";
  _mobHideSnap("end");
  _mobRender();
}

// ── Frame snapshots (marked edge previews) ─────────────────────────────

/** Fetch and show the frame at a marked edge via api/frame (server-side
 *  ffmpeg extraction — the same endpoint the desktop frame strip uses).
 *  Tap-driven only (mark/nudge buttons); never called from the follow
 *  driver, which would hammer the server on every timeupdate. */
function _mobRefreshSnap(edge) {
  var wrap = edge === "start" ? _mobEls.snapStart : _mobEls.snapEnd;
  var img = edge === "start" ? _mobEls.snapStartImg : _mobEls.snapEndImg;
  if (!wrap || !img) return;
  var item = state.currentItem;
  if (!item || !item.media_id) return;
  var t = edge === "start" ? _sliderStart : _sliderEnd;
  if (t == null || isNaN(t) || t < 0) return;
  wrap.style.display = "block";
  wrap.classList.add("mob-snap-loading");
  img.onload = function() { wrap.classList.remove("mob-snap-loading"); };
  img.onerror = function() {
    wrap.classList.remove("mob-snap-loading");
    wrap.style.display = "none";
  };
  img.src = "api/frame/" + item.media_id + "?t=" + t.toFixed(2);
}

function _mobHideSnap(edge) {
  var wrap = edge === "start" ? _mobEls.snapStart : _mobEls.snapEnd;
  if (wrap) wrap.style.display = "none";
}

/** Tap an IN/OUT thumbnail to jump the playhead to that edge. */
function mobJumpToSnap(edge) {
  var vid = _mobEls.video;
  if (!vid) return;
  var t = edge === "start" ? _sliderStart : _sliderEnd;
  if (t == null || isNaN(t)) return;
  seekVideoTo(t);
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
  var dur = _sliderEnd - _sliderStart;
  var locked = _mobActivePreset > 0 && _mobStartSet && _mobEndSet && dur > 0;
  if (locked) {
    // Preset lock: slide the WHOLE window so the locked duration is kept —
    // nudging the start moves the end along with it.
    var ns = Math.max(0, Math.min(state.mediaDuration - dur, _sliderStart + delta));
    setSliderStart(ns);
    setSliderEnd(ns + dur);
    _mobRefreshSnap("end"); // the end slid too — refresh its frame
  } else {
    // Free mode: only the start moves. A PINNED end is a hard boundary; an
    // unpinned (playhead-riding) end leaves the start free to move forward —
    // the end re-anchors to the playhead on the seek below. This is what
    // makes +1f/+5s/+10s/+30s work right after Set Start (previously they
    // were clamped to _sliderEnd - 0.04 == the start, so they did nothing).
    var maxS = _mobEndSet ? (_sliderEnd - 0.04) : state.mediaDuration;
    setSliderStart(Math.max(0, Math.min(maxS, _sliderStart + delta)));
  }
  _mobStartSet = true;
  _mobSyncBrowse();
  seekVideoTo(_sliderStart);
  _mobRefreshSnap("start");
  _mobRender();
}

function mobNudgeEnd(delta) {
  var dur = _sliderEnd - _sliderStart;
  var locked = _mobActivePreset > 0 && _mobStartSet && _mobEndSet && dur > 0;
  if (locked) {
    // Preset lock: slide the whole window (the start moves with the end).
    var ns = Math.max(0, Math.min(state.mediaDuration - dur, _sliderStart + delta));
    setSliderStart(ns);
    setSliderEnd(ns + dur);
    _mobRefreshSnap("start"); // the start slid too — refresh its frame
  } else {
    // Free mode: only the end moves. A PINNED start is a hard floor; an
    // unpinned (playhead-riding) start leaves the end free to move back —
    // symmetric with the start row (the start re-anchors on the seek below).
    var minE = _mobStartSet ? (_sliderStart + 0.04) : 0;
    setSliderEnd(Math.max(minE, Math.min(state.mediaDuration, _sliderEnd + delta)));
  }
  _mobEndSet = true;
  _mobSyncBrowse();
  seekVideoTo(_sliderEnd);
  _mobRefreshSnap("end");
  _mobRender();
}

// ── Preset chips ───────────────────────────────────────────────────────

function _mobClearSelection() {
  _mobActivePreset = 0;
  _mobStartSet = false;
  _mobEndSet = false;
  _mobSyncBrowse();
  _sliderStart = 0;
  _sliderEnd = 0;
  _mobHideSnap("start");
  _mobHideSnap("end");
  if (_mobEls.status) _mobEls.status.textContent = "";
}

function mobPreset(duration) {
  if (duration === 0 || _mobActivePreset === duration) {
    // Free (or deselect): no locked duration — clear any selection.
    _mobClearSelection();
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
    _mobStartSet = true;
    _mobEndSet = true;
    _mobSyncBrowse();
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
  downloadClip(); // app.js writes progress directly to #mob-clip-progress*
}

// ── Progress display (app.js writes #mob-clip-progress* directly) ─────

function _mobShowProgress() {
  if (_mobEls.progress) _mobEls.progress.style.display = "block";
  if (_mobEls.progressFill) _mobEls.progressFill.style.width = "0%";
  if (_mobEls.progressText) _mobEls.progressText.textContent = "Starting clip...";
}

// ── Render ─────────────────────────────────────────────────────────────

// Last-rendered values for dirty-checking. _mobRender is called on every
// timeupdate/seeked (~4Hz during playback); without this cache it rewrites
// ~10 DOM nodes per tick even when nothing changed (e.g. both edges pinned).
// Values only get written when they actually differ from what's on screen.
var _mobLast = null;

function _mobRender() {
  var unselected = !_mobStartSet && !_mobEndSet;
  var dur = unselected ? 0 : (_sliderEnd - _sliderStart);
  var s = unselected ? "0:00" : fmtTime(_sliderStart);
  var e = unselected ? "0:00" : fmtTime(_sliderEnd);
  var d = unselected ? "free" : (dur.toFixed(1) + "s");

  if (!_mobLast) {
    _mobLast = { start: "", end: "", dur: "", ovL: null, ovW: null,
                 dl: null, dlDisabled: null, preset: -1, loop: null,
                 us: null, ue: null, rs: null };
  }

  // Range summary: the resulting clip shown once both edges are set
  if (_mobEls.rangeSummary) {
    var rs;
    if (unselected) {
      rs = "";
    } else {
      rs = fmtTime(_sliderStart) + " → " + fmtTime(_sliderEnd) + " · " + dur.toFixed(1) + "s";
    }
    if (rs !== _mobLast.rs) {
      _mobEls.rangeSummary.textContent = rs;
      _mobLast.rs = rs;
    }
  }

  if (_mobEls.timeStart && s !== _mobLast.start) {
    _mobEls.timeStart.textContent = s;
    _mobLast.start = s;
  }
  if (_mobEls.timeEnd && e !== _mobLast.end) {
    _mobEls.timeEnd.textContent = e;
    _mobLast.end = e;
  }
  if (_mobEls.timeDur && d !== _mobLast.dur) {
    _mobEls.timeDur.textContent = d;
    _mobLast.dur = d;
  }

  var md = state.mediaDuration > 0 ? state.mediaDuration : 0;
  if (_mobEls.overviewFill && md > 0) {
    var pStart = 0;
    var pEnd = 0;
    if (!unselected) {
      pStart = Math.max(0, Math.min(100, (_sliderStart / md) * 100));
      pEnd = Math.max(pStart, Math.min(100, (_sliderEnd / md) * 100));
    }
    var ovL = pStart + "%";
    var ovW = (pEnd - pStart) + "%";
    if (ovL !== _mobLast.ovL) { _mobEls.overviewFill.style.left = ovL; _mobLast.ovL = ovL; }
    if (ovW !== _mobLast.ovW) { _mobEls.overviewFill.style.width = ovW; _mobLast.ovW = ovW; }
  }

  if (_mobEls.btnDownload) {
    var dlDisabled;
    var dlLabel;
    if (dur <= 0) {
      dlDisabled = true;
      dlLabel = "⚠ Set a clip range";
    } else {
      dlDisabled = false;
      dlLabel = "⬇ Download";
      var parts = [];
      if (_captionsEnabled) parts.push("captions");
      if (_verticalEnabled) parts.push("vertical");
      if (_clipFormat === "gif") parts.push("gif");
      if (parts.length) dlLabel = "⬇ Download (" + parts.join(" + ") + ")";
    }
    if (dlDisabled !== _mobLast.dlDisabled) {
      _mobEls.btnDownload.disabled = dlDisabled;
      _mobLast.dlDisabled = dlDisabled;
    }
    if (dlLabel !== _mobLast.dl) {
      _mobEls.btnDownload.textContent = dlLabel;
      _mobLast.dl = dlLabel;
    }
  }

  // Preset chip highlight — only re-loop when the active preset changed
  if (_mobEls.presetBtns && _mobActivePreset !== _mobLast.preset) {
    for (var i = 0; i < _mobEls.presetBtns.length; i++) {
      var b = _mobEls.presetBtns[i];
      var pd = parseFloat(b.getAttribute("data-dur")) || 0;
      if (_mobActivePreset === pd) b.classList.add("active");
      else b.classList.remove("active");
    }
    _mobLast.preset = _mobActivePreset;
  }

  // Loop button label
  if (_mobEls.btnLoop && _mobEls.video) {
    var loopLabel = (_loopPlayback && !_mobEls.video.paused) ? "⏸ Loop" : "🔁 Loop";
    if (loopLabel !== _mobLast.loop) {
      _mobEls.btnLoop.textContent = loopLabel;
      _mobLast.loop = loopLabel;
    }
  }

  // Unset buttons: visible only for pinned edges.
  if (_mobEls.btnUnsetStart) {
    var us = _mobStartSet ? "" : "none";
    if (us !== _mobLast.us) { _mobEls.btnUnsetStart.style.display = us; _mobLast.us = us; }
  }
  if (_mobEls.btnUnsetEnd) {
    var ue = _mobEndSet ? "" : "none";
    if (ue !== _mobLast.ue) { _mobEls.btnUnsetEnd.style.display = ue; _mobLast.ue = ue; }
  }

  // v=67: fine-tune is a collapsed chip in the collapse row — no auto-open
  // (the old desktop progressive disclosure fought the collapsed design).

  _mobRenderCaptionOpts();
}

// Mirror caption color/placement into the mobile Options buttons; show the
// option rows only while captions are enabled. Reads app.js globals only.
function _mobRenderCaptionOpts() {
  var optColor = document.getElementById("mob-opt-caption-color");
  var optPlacement = document.getElementById("mob-opt-caption-placement");
  var btnColor = document.getElementById("mob-btn-caption-color");
  var btnPlacement = document.getElementById("mob-btn-caption-placement");
  var show = _captionsEnabled ? "" : "none";
  if (optColor) optColor.style.display = show;
  if (optPlacement) optPlacement.style.display = show;
  if (btnColor) btnColor.textContent = (_captionColor === "white") ? "🎨 White" : "🎨 Yellow";
  if (btnPlacement) btnPlacement.textContent = (_captionPosition === "bottom") ? "📍 Bottom" : "📍 Middle";
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
