/**
 * Cliparr — Frontend Application
 *
 * Vanilla JS app handling library browsing, now-playing banner,
 * proxy generation UX, scrubber controls, and clip downloads.
 */

// Quick load test — if you don't see 'JS ✓' in the header, JS didn't load
(function() {
  var el = document.querySelector("header h1 span");
  if (el) el.textContent = el.textContent + " · JS ✓";
})();

// ── State ──────────────────────────────────────────────────────────────

const state = {
  items: [],            // all library items
  currentItem: null,    // selected item metadata
  mediaDuration: 0,     // seconds (full movie duration for sliders)
};

// ── Safe DOM access ────────────────────────────────────────────────────

function qs(sel, parent) {
  return (parent || document).querySelector(sel);
}
function qsa(sel, parent) {
  return (parent || document).querySelectorAll(sel);
}

function getDom() {
  return {
    search:       qs("#search"),
    libraryGrid:  qs("#library-grid"),
    resultCount:  qs("#result-count"),
    emptyState:   qs("#empty-state"),
    libraryView:  qs("#library-view"),
    detailView:   qs("#detail-view"),
    detailTitle:  qs("#detail-title"),
    detailMeta:   qs("#detail-meta"),
    btnBack:      qs("#btn-back"),
    nowPlaying:   qs("#now-playing"),
    npTitle:      qs("#np-title"),
    npTime:       qs("#np-time"),
    btnJumpClip:  qs("#btn-jump-clip"),
    btnQuickClip:     qs("#btn-quick-clip"),
    npProgress:       qs("#np-progress"),
    npProgressFill:   qs("#np-progress-fill"),
    npProgressText:   qs("#np-progress-text"),
    // Video preview
    framePreview:    qs("#frame-preview"),
    previewVideo:    qs("#preview-video"),
    previewError:    qs("#preview-error"),
    previewLoading:  qs("#preview-loading"),
    frameTimeValue:  qs("#frame-time-value"),
    btnPlayClip:  qs("#btn-play-clip"),
    btnPlayFull:  qs("#btn-play-full"),
    btnMuteToggle:  qs("#btn-mute-toggle"),
    frameStrip:      qs("#frame-strip"),
    frameStripInner: qs("#frame-strip-inner"),
    // Range bar (visual only, no interaction)
    rangeBar:          qs("#range-bar"),
    rangeBarFill:      qs("#range-bar-fill"),
    rangeBarMarkerStart: qs("#range-bar-marker-start"),
    rangeBarMarkerEnd:   qs("#range-bar-marker-end"),
    rangeBarPlayhead:   qs("#range-bar-playhead"),
    timeStartInput: qs("#time-start-input"),
    timeEndInput:   qs("#time-end-input"),
    timeDuration: qs("#time-duration"),
    clipDuration:  qs("#clip-duration"),
    btnDownload:  qs("#btn-download-clip"),
    clipStatus:   qs("#clip-status"),
    clipProgress:      qs("#clip-progress"),
    clipProgressFill:  qs("#clip-progress-fill"),
    clipProgressText:  qs("#clip-progress-text"),
    // Clip gallery
    clipGallery:     qs("#clip-gallery"),
    clipGalleryGrid: qs("#clip-gallery-grid"),
    clipCount:       qs("#clip-count"),
    // Social toggles
    socialToggles: qs("#social-toggles"),
    btnCaptions:   qs("#btn-captions"),
    btnCaptionColor: qs("#btn-caption-color"),
    btnCaptionPlacement: qs("#btn-caption-placement"),
    btnVertical:   qs("#btn-vertical"),
  };
}

let dom;

// Clip range state
var _sliderStart = 0;
var _sliderEnd = 139;

// Range lock mode: when _rangeLocked is true, dragging either handle
// slides the entire range as a unit, maintaining _lockedDuration.
var _rangeLocked = false;
var _lockedDuration = 30;

// Social media options
var _captionsEnabled = false;
var _verticalEnabled = false;
var _captionColor = "white";        // "white" or "yellow"
var _captionPosition = "bottom";    // "bottom" or "middle"

// Fine-tune sliders — ±30s window for precise handle positioning
var _fineTuneStartActive = false;
var _fineTuneEndActive = false;
var _FINE_TUNE_WINDOW = 30;

// ── Formatting ─────────────────────────────────────────────────────────

function fmtTime(seconds) {
  if (seconds == null || isNaN(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Library ────────────────────────────────────────────────────────────

var currentSort = "title";

function sortItems(items, sortKey) {
  var sorted = items.slice();
  switch (sortKey) {
    case "title":
      sorted.sort(function(a, b) {
        var ta = (a.show_title || a.title || "").toLowerCase();
        var tb = (b.show_title || b.title || "").toLowerCase();
        return ta.localeCompare(tb);
      });
      break;
    case "year-desc":
      sorted.sort(function(a, b) {
        return (b.year || 0) - (a.year || 0);
      });
      break;
    case "year-asc":
      sorted.sort(function(a, b) {
        return (a.year || 0) - (b.year || 0);
      });
      break;
    case "duration-desc":
      sorted.sort(function(a, b) {
        return (b.duration || 0) - (a.duration || 0);
      });
      break;
    case "duration-asc":
      sorted.sort(function(a, b) {
        return (a.duration || 0) - (b.duration || 0);
      });
      break;
    case "added-desc":
      // Higher media_id generally = newer, fallback for no addedAt field
      sorted.sort(function(a, b) {
        return (b.media_id || 0) - (a.media_id || 0);
      });
      break;
    default:
      break;
  }
  return sorted;
}

async function loadLibrary() {
  try {
    const resp = await fetch("api/library");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.items = data.items || [];
    renderLibrary();
    loadClipGallery();
  } catch (err) {
    console.error("Failed to load library:", err);
    if (dom.libraryGrid) {
      dom.libraryGrid.innerHTML =
        '<div class="empty-state"><div class="empty-text">Failed to load library</div>' +
        '<div class="empty-sub">Is Plex reachable?</div></div>';
    }
  }
}

function renderLibrary(filterText) {
  filterText = filterText || "";
  var query = filterText.toLowerCase().trim();
  var sorted = sortItems(state.items, currentSort);
  var filtered = query
    ? sorted.filter(function(item) {
        var title = (item.title || "").toLowerCase();
        var show = (item.show_title || "").toLowerCase();
        return title.indexOf(query) !== -1 || show.indexOf(query) !== -1;
      })
    : sorted;

  if (dom.resultCount) dom.resultCount.textContent = "(" + filtered.length + ")";

  if (filtered.length === 0) {
    if (dom.libraryGrid) dom.libraryGrid.innerHTML = "";
    if (dom.emptyState) dom.emptyState.style.display = "block";
    return;
  }

  if (dom.emptyState) dom.emptyState.style.display = "none";
  if (dom.libraryGrid) dom.libraryGrid.innerHTML = filtered.map(renderCard).join("");
}

function renderCard(item) {
  var title = item.title || "Unknown";
  var year = item.year ? " \u00b7 " + item.year : "";
  var dur = item.duration ? " \u00b7 " + fmtDuration(item.duration) : "";

  var subtitle = item.type === "episode"
    ? (item.show_title || "") + " \u2014 S" + String(item.season).padStart(2,"0") + "E" + String(item.episode).padStart(2,"0")
    : (item.type || "movie") + year + dur;

  var mid = item.media_id;
  var thumbSrc = item.thumb ? "api/thumb/" + mid : "";

  var thumbHtml = thumbSrc
    ? '<img class="card-thumb" src="' + thumbSrc + '" alt="' + escAttr(title) + '" loading="lazy" onerror="this.style.display=\'none\'">'
    : '<div class="card-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:32px;">&#127916;</div>';

  return (
    '<div class="card" onclick="selectItem(' + mid + ')" data-id="' + mid + '">' +
      '<div class="card-content">' +
        thumbHtml +
        '<div class="card-info">' +
          '<div class="card-name">' + escHtml(title) + '</div>' +
          '<div class="card-meta">' + escHtml(subtitle) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function escHtml(str) {
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Navigation ─────────────────────────────────────────────────────────

function goHome() {
  if (dom.detailView) dom.detailView.style.display = "none";
  if (dom.libraryView) dom.libraryView.style.display = "block";
  if (dom.framePreview) dom.framePreview.style.display = "none";
  state.currentItem = null;
  if (dom.search) dom.search.value = "";
  // Clean up video preview
  if (dom.previewVideo) {
    dom.previewVideo.pause();
    dom.previewVideo.src = "";
  }
  _videoReady = false;
  _videoFailed = false;
  if (dom.previewError) dom.previewError.style.display = "none";
  if (dom.previewLoading) dom.previewLoading.style.display = "none";
  if (dom.rangeBarPlayhead) dom.rangeBarPlayhead.style.display = "none";
  renderLibrary();
}

// ── Detail View ────────────────────────────────────────────────────────

async function selectItem(mediaId) {
  try {
    var resp = await fetch("api/library/" + mediaId);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    state.currentItem = await resp.json();
    showDetailView();
  } catch (err) {
    console.error("Failed to load item:", err);
  }
}

function showDetailView() {
  var item = state.currentItem;
  if (!item) return;

  if (dom.libraryView) dom.libraryView.style.display = "none";
  if (dom.detailView) dom.detailView.style.display = "block";

  if (dom.detailTitle) dom.detailTitle.textContent = item.title || "Unknown";

  var parts = [];
  if (item.type === "episode") {
    parts.push((item.show_title || "") + " \u2014 S" + String(item.season).padStart(2,"0") + "E" + String(item.episode).padStart(2,"0"));
  }
  if (item.year) parts.push(String(item.year));
  parts.push(item.type || "movie");
  if (item.duration) parts.push(fmtDuration(item.duration));
  if (dom.detailMeta) dom.detailMeta.textContent = parts.join(" \u00b7 ");

  var durationS = (item.duration || 0) / 1000;
  state.mediaDuration = durationS;

  // Show frame preview area
  if (dom.framePreview) dom.framePreview.style.display = "block";
  if (dom.btnPlayClip) dom.btnPlayClip.style.display = "inline-flex";
  if (dom.btnPlayFull) dom.btnPlayFull.style.display = "inline-flex";
  if (dom.btnMuteToggle) dom.btnMuteToggle.style.display = "inline-flex";
  if (dom.clipProgress) dom.clipProgress.style.display = "none";
  if (dom.clipStatus) dom.clipStatus.textContent = "";

  // Load video preview from original media file
  var mediaId = item.media_id || item.id;
  loadVideoPreview(mediaId);

  // Build frame strip
  buildFrameStrip(mediaId, durationS);

  // Handle jump-to-clip offset from session banner
  if (window._jumpOffset != null) {
    var offset = window._jumpOffset;
    _sliderStart = Math.max(0, Math.floor(offset - 5));
    _sliderEnd = Math.min(durationS, Math.floor(offset + 25));
    window._jumpOffset = null;
    window._jumpDuration = null;
  } else {
    _sliderStart = 0;
    _sliderEnd = Math.min(139, Math.floor(durationS));
  }

  updateTimeDisplay();
  updateRangeBar();
  updateDownloadButton();
  updateStripRange();
  updateSocialToggles();

  // Reset lock state for new item
  _rangeLocked = false;
  updatePresetButtons();

  // Seek video to start position once ready
  seekVideoTo(_sliderStart);
  if (dom.rangeBarPlayhead) dom.rangeBarPlayhead.style.display = "none";

  if (dom.clipStatus) dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(durationS);
}

function goBack() {
  if (dom.detailView) dom.detailView.style.display = "none";
  if (dom.libraryView) dom.libraryView.style.display = "block";
  if (dom.framePreview) dom.framePreview.style.display = "none";
  state.currentItem = null;
  // Clean up video preview
  if (dom.previewVideo) {
    dom.previewVideo.pause();
    dom.previewVideo.src = "";
  }
  _videoReady = false;
  _videoFailed = false;
  if (dom.previewError) dom.previewError.style.display = "none";
  if (dom.previewLoading) dom.previewLoading.style.display = "none";
  if (dom.rangeBarPlayhead) dom.rangeBarPlayhead.style.display = "none";
  renderLibrary(dom.search ? dom.search.value : "");
}

// ── Now Playing Banner ─────────────────────────────────────────────────

var sessionPollTimer = null;
var _currentSession = null;  // stored for Quick Clip

async function pollSessions() {
  try {
    var resp = await fetch("api/sessions");
    if (!resp.ok) return;
    var data = await resp.json();
    var sessions = data.sessions || [];

    var paused = null;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].state === "paused") {
        paused = sessions[i];
        break;
      }
    }

    if (paused && dom.nowPlaying) {
      _currentSession = paused;
      dom.nowPlaying.style.display = "block";
      if (dom.npTitle) dom.npTitle.textContent = paused.title;
      if (dom.npTime) dom.npTime.textContent = "at " + fmtTime(paused.viewOffset);
      if (dom.btnJumpClip) dom.btnJumpClip.onclick = function() { jumpToClip(paused); };
      if (dom.btnQuickClip) dom.btnQuickClip.onclick = function() { quickClip(); };
    } else if (dom.nowPlaying) {
      _currentSession = null;
      dom.nowPlaying.style.display = "none";
    }
  } catch (err) {
    // Silently fail — banner is optional
  }
}

function jumpToClip(session) {
  window._jumpOffset = session.viewOffset;
  window._jumpDuration = session.duration / 1000;
  selectItem(session.media_id);
}

async function quickClip() {
  // Clip 30s directly from the current session — no proxy needed
  if (!_currentSession) return;

  var mediaId = _currentSession.media_id;
  var durationS = _currentSession.duration / 1000;
  var offset = _currentSession.viewOffset;

  // 30s clip: 5s before pause, 25s after
  var startSec = Math.max(0, offset - 5);
  var endSec = Math.min(durationS, offset + 25);

  // Show progress in banner
  if (dom.npProgress) dom.npProgress.style.display = "block";
  if (dom.npProgressFill) dom.npProgressFill.style.width = "0%";
  if (dom.npProgressText) dom.npProgressText.textContent = "Starting quick clip...";
  if (dom.btnQuickClip) dom.btnQuickClip.disabled = true;

  try {
    // 1) Start clip
    var startResp = await fetch("api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId, start_sec: startSec, end_sec: endSec }),
    });
    if (!startResp.ok) {
      var errData = await startResp.json().catch(function() { return {}; });
      throw new Error(errData.detail || "HTTP " + startResp.status);
    }
    var startData = await startResp.json();
    var filename = startData.filename;

    // 2) Poll with progress in the banner
    await pollQuickClipStatus(filename);

    // 3) Download
    var a = document.createElement("a");
    a.href = "api/download/" + filename;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    if (dom.npProgressText) dom.npProgressText.textContent = "Downloaded " + filename;
    loadClipGallery();
    setTimeout(function() {
      if (dom.npProgress) dom.npProgress.style.display = "none";
    }, 3000);
  } catch (err) {
    if (dom.npProgressText) dom.npProgressText.textContent = "Error: " + err.message;
    setTimeout(function() {
      if (dom.npProgress) dom.npProgress.style.display = "none";
    }, 4000);
  } finally {
    if (dom.btnQuickClip) dom.btnQuickClip.disabled = false;
  }
}

function pollQuickClipStatus(filename) {
  return new Promise(function(resolve, reject) {
    var maxPolls = 300;
    var polls = 0;

    function poll() {
      polls++;
      if (polls > maxPolls) { reject(new Error("Quick clip timed out")); return; }

      fetch("api/clip/status/" + filename)
        .then(function(resp) { return resp.json(); })
        .then(function(status) {
          if (status.error) { reject(new Error(status.error)); return; }
          if (status.done) {
            if (dom.npProgressFill) dom.npProgressFill.style.width = "100%";
            resolve();
            return;
          }
          var pct = Math.round(status.progress * 100);
          var text = "Clipping... " + pct + "%";
          if (status.eta_seconds != null && status.eta_seconds > 0) {
            var mins = Math.floor(status.eta_seconds / 60);
            var secs = status.eta_seconds % 60;
            text += " (ETA " + mins + "m " + secs + "s)";
          }
          if (dom.npProgressFill) dom.npProgressFill.style.width = pct + "%";
          if (dom.npProgressText) dom.npProgressText.textContent = text;
          setTimeout(poll, 2000);
        })
        .catch(function(err) { reject(err); });
    }
    poll();
  });
}

function startSessionPolling() {
  pollSessions();
  sessionPollTimer = setInterval(pollSessions, 5000);
}

// ── Video Preview (direct seeking in original file) ──────────────────

var _videoReady = false;
var _videoFailed = false;
var _loopPlayback = false;   // true when playing within clip range (loops)

function loadVideoPreview(mediaId) {
  _videoReady = false;
  _videoFailed = false;
  _loopPlayback = false;

  if (!dom.previewVideo) return;
  var vid = dom.previewVideo;

  if (dom.previewError) dom.previewError.style.display = "none";
  if (dom.previewLoading) dom.previewLoading.style.display = "block";

  vid.onloadedmetadata = function() {
    _videoReady = true;
    if (dom.previewLoading) dom.previewLoading.style.display = "none";
    vid.currentTime = _sliderStart;
  };

  vid.onerror = function() {
    _videoFailed = true;
    if (dom.previewLoading) dom.previewLoading.style.display = "none";
    if (dom.previewError) dom.previewError.style.display = "block";
    var err = vid.error;
    var codes = {1:"MEDIA_ERR_ABORTED",2:"MEDIA_ERR_NETWORK",3:"MEDIA_ERR_DECODE",4:"MEDIA_ERR_SRC_NOT_SUPPORTED"};
    if (dom.clipStatus) dom.clipStatus.textContent = "Video error: " + (codes[err ? err.code : 0] || "unknown");
  };

  vid.ontimeupdate = function() {
    var ct = vid.currentTime;
    if (dom.frameTimeValue) dom.frameTimeValue.textContent = fmtTime(Math.floor(ct));
    if (dom.rangeBarPlayhead) {
      dom.rangeBarPlayhead.style.display = "block";
      dom.rangeBarPlayhead.style.left = sliderGetPct(ct) + "%";
    }
    // Loop within clip range when playing a clip preview
    if (_loopPlayback && ct >= _sliderEnd) {
      vid.currentTime = _sliderStart;
    }
  };

  vid.src = "api/media/" + mediaId + "/stream";
}

function onPreviewError() {
  _videoFailed = true;
  _videoReady = false;
  if (dom.previewLoading) dom.previewLoading.style.display = "none";
  if (dom.previewError) dom.previewError.style.display = "block";
}

function seekVideoTo(t) {
  if (dom.frameTimeValue) dom.frameTimeValue.textContent = fmtTime(Math.floor(t));
  if (dom.rangeBarPlayhead) {
    dom.rangeBarPlayhead.style.display = "block";
    dom.rangeBarPlayhead.style.left = sliderGetPct(t) + "%";
  }
  // readyState >= 1 means metadata is loaded — browser can seek, it'll buffer
  // data at the new position. Using >= 2 was too strict: during seeks,
  // readyState temporarily drops to 1, silently dropping rapid clicks.
  if (dom.previewVideo && dom.previewVideo.readyState >= 1) {
    dom.previewVideo.currentTime = t;
  }
}

function playClip() {
  if (!dom.previewVideo) return;
  var vid = dom.previewVideo;
  if (vid.readyState < 2) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Video still loading...";
    return;
  }

  if (!vid.paused && _loopPlayback) {
    // Already playing clip — pause
    _loopPlayback = false;
    vid.pause();
    return;
  }

  _loopPlayback = true;
  vid.currentTime = _sliderStart;
  var promise = vid.play();
  if (promise) {
    promise.catch(function(err) {
      _loopPlayback = false;
      if (dom.clipStatus) dom.clipStatus.textContent = "Playback failed: " + (err.message || "unknown error");
    });
  }
}

function playFull() {
  if (!dom.previewVideo) return;
  var vid = dom.previewVideo;
  if (vid.readyState < 2) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Video still loading...";
    return;
  }

  if (!vid.paused && !_loopPlayback) {
    // Already playing full — pause
    vid.pause();
    return;
  }

  _loopPlayback = false;
  vid.currentTime = _sliderStart;
  var promise = vid.play();
  if (promise) {
    promise.catch(function(err) {
      if (dom.clipStatus) dom.clipStatus.textContent = "Playback failed: " + (err.message || "unknown error");
    });
  }
}

// Update play buttons: active mode shows ⏸, inactive is dimmed
function updatePlayButtons() {
  if (!dom.previewVideo) return;
  var playing = !dom.previewVideo.paused;

  if (dom.btnPlayClip) {
    if (playing && _loopPlayback) {
      dom.btnPlayClip.textContent = '⏸ Clip';
    } else {
      dom.btnPlayClip.textContent = '▶ Clip';
    }
    dom.btnPlayClip.disabled = playing && !_loopPlayback;
    dom.btnPlayClip.classList.toggle('active', playing && _loopPlayback);
  }

  if (dom.btnPlayFull) {
    if (playing && !_loopPlayback) {
      dom.btnPlayFull.textContent = '⏸ Full';
    } else {
      dom.btnPlayFull.textContent = '▶ Full';
    }
    dom.btnPlayFull.disabled = playing && _loopPlayback;
    dom.btnPlayFull.classList.toggle('active', playing && !_loopPlayback);
  }
}

// Wire play/pause state tracking
function initPlayStateTracking() {
  if (!dom.previewVideo) return;
  dom.previewVideo.addEventListener('play', updatePlayButtons);
  dom.previewVideo.addEventListener('pause', updatePlayButtons);
  dom.previewVideo.addEventListener('ended', updatePlayButtons);
}

function toggleMute() {
  if (!dom.previewVideo) return;
  dom.previewVideo.muted = !dom.previewVideo.muted;
  if (dom.btnMuteToggle) {
    dom.btnMuteToggle.textContent = dom.previewVideo.muted ? '🔇' : '🔊';
  }
}

// ── Scrubber Controls (frame strip) ───────────────────────────────────

var _stripThumbs = [];  // [{time, el}]

function buildFrameStrip(mediaId, durationS) {
  if (!dom.frameStrip || !dom.frameStripInner) return;
  _stripThumbs = [];

  var count = durationS < 600 ? 8 : durationS < 3600 ? 12 : 16;
  var html = "";
  for (var i = 0; i < count; i++) {
    var t = Math.floor((durationS / (count - 1)) * i);
    html += '<div class="frame-thumb" data-time="' + t + '">' +
            '<img src="api/frame/' + mediaId + '?t=' + t + '" loading="lazy" />' +
            '<span class="frame-thumb-time">' + fmtTime(t) + '</span></div>';
  }
  dom.frameStripInner.innerHTML = html;
  dom.frameStrip.style.display = "block";
  // Hide desktop hint on mobile
  var hint = document.querySelector(".strip-hint");
  if (hint && window.innerWidth <= 480) hint.style.display = "none";

  var thumbs = dom.frameStripInner.querySelectorAll(".frame-thumb");
  for (var j = 0; j < thumbs.length; j++) {
    var t = parseInt(thumbs[j].getAttribute("data-time"));
    _stripThumbs.push({time: t, el: thumbs[j]});
  }
}

// Click/tap: set start. Long-press (mobile): set end. Drag: slide range.
// Desktop: shift+click also sets end.
var _stripDragActive = false;
var _stripDidMove = false;
var _stripClickTime = null;
var _stripDragDuration = 0;   // clip duration when drag started
var _stripLongPressTimer = null;
var _stripLongPressFired = false;

function initStripDrag() {
  if (!dom.frameStripInner) return;

  // Shared drag-start logic — called by both mousedown and touchstart.
  function _startStripDrag(clientX, thumb, isTouch) {
    _stripDragActive = false;
    _stripDidMove = false;
    _stripLongPressFired = false;
    _stripClickTime = parseInt(thumb.getAttribute("data-time"));
    _stripDragDuration = _rangeLocked ? _lockedDuration : (_sliderEnd - _sliderStart);

    // Cache strip rect for smooth continuous tracking
    var stripRect = dom.frameStripInner.getBoundingClientRect();
    var stripLeft = stripRect.left;
    var stripWidth = stripRect.width;

    // Immediate seek for responsive feel
    seekVideoTo(_stripClickTime);

    // On touch: start long-press timer for "set end" gesture
    if (isTouch) {
      if (_stripLongPressTimer) clearTimeout(_stripLongPressTimer);
      thumb.classList.add("long-press-active");
      _stripLongPressTimer = setTimeout(function() {
        _stripLongPressFired = true;
        thumb.classList.remove("long-press-active");
        // Long-press = set end (like shift+click on desktop)
        if (_rangeLocked) {
          setSliderEnd(_stripClickTime);
          setSliderStart(Math.max(0, _stripClickTime - _lockedDuration));
        } else {
          setSliderEnd(_stripClickTime);
        }
        seekVideoTo(_sliderStart);
        updateStripRange();
        if (dom.clipStatus) {
          var mode = _rangeLocked ? " [locked " + _lockedDuration + "s]" : "";
          dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(state.mediaDuration) + mode;
        }
      }, 500);
    }

    function onMove(ev) {
      if (_handleDrag) return;
      var cx = ev.touches ? ev.touches[0].clientX : ev.clientX;

      // Cancel long-press if finger moved significantly
      if (isTouch && _stripLongPressTimer) {
        var dx = Math.abs(cx - clientX);
        if (dx > 10) {
          clearTimeout(_stripLongPressTimer);
          _stripLongPressTimer = null;
          thumb.classList.remove("long-press-active");
        }
      }

      _stripDidMove = true;
      _stripDragActive = true;

      // Continuous time from cursor position (no snapping to thumbs)
      var pct = Math.max(0, Math.min(1, (cx - stripLeft) / stripWidth));
      var pos = pct * state.mediaDuration;

      // Slide the range so its center follows the cursor
      var halfDur = _stripDragDuration / 2;
      var newStart = Math.max(0, pos - halfDur);
      var newEnd = Math.min(state.mediaDuration, pos + halfDur);

      if (newStart === 0 && pos < halfDur) {
        newEnd = Math.min(state.mediaDuration, _stripDragDuration);
      }
      if (newEnd === state.mediaDuration && pos + halfDur > state.mediaDuration) {
        newStart = Math.max(0, state.mediaDuration - _stripDragDuration);
      }

      setSliderStart(Math.floor(newStart));
      setSliderEnd(Math.floor(newEnd));
      seekVideoTo(_sliderStart);
      if (dom.clipStatus) dom.clipStatus.textContent = "Range: " + fmtTime(_sliderStart) + " – " + fmtTime(_sliderEnd) + " (" + _stripDragDuration + "s)";
    }

    function onUp(ev) {
      // Clean up long-press timer
      if (_stripLongPressTimer) {
        clearTimeout(_stripLongPressTimer);
        _stripLongPressTimer = null;
        thumb.classList.remove("long-press-active");
      }

      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);

      if (_stripDragActive) {
        seekVideoTo(_sliderStart);
        if (dom.clipStatus) {
          var mode = _rangeLocked ? " [locked " + _lockedDuration + "s]" : "";
          dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(state.mediaDuration) + mode;
        }
      } else if (!_stripDidMove && !_stripLongPressFired) {
        // Tap (touch) or click (mouse) — set start
        if (ev && ev.shiftKey) {
          // Desktop shift+click = set end
          if (_rangeLocked) {
            setSliderEnd(_stripClickTime);
            setSliderStart(Math.max(0, _stripClickTime - _lockedDuration));
          } else {
            setSliderEnd(_stripClickTime);
          }
          seekVideoTo(_sliderStart);
        } else {
          // Tap / normal click = set start
          if (_rangeLocked) {
            var ns = Math.max(0, _stripClickTime);
            if (ns + _lockedDuration > state.mediaDuration) ns = state.mediaDuration - _lockedDuration;
            setSliderStart(ns);
            setSliderEnd(ns + _lockedDuration);
          } else {
            var dur = _sliderEnd - _sliderStart;
            setSliderStart(_stripClickTime);
            if (dur > 0) {
              setSliderEnd(Math.min(state.mediaDuration, _stripClickTime + dur));
            }
          }
          seekVideoTo(_sliderStart);
        }
        updateStripRange();
      }
      _stripDragActive = false;
      _stripDidMove = false;
      _stripClickTime = null;
      _stripLongPressFired = false;
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove);
    document.addEventListener("touchend", onUp);
  }

  dom.frameStripInner.addEventListener("mousedown", function(e) {
    var thumb = e.target.closest && e.target.closest(".frame-thumb");
    if (!thumb) return;
    e.preventDefault();
    _startStripDrag(e.clientX, thumb, false);
  });

  dom.frameStripInner.addEventListener("touchstart", function(e) {
    var thumb = e.target.closest && e.target.closest(".frame-thumb");
    if (!thumb) return;
    _startStripDrag(e.touches[0].clientX, thumb, true);
  }, { passive: true });
}

// Find the thumb nearest to a given clientX coordinate
function findNearestThumb(clientX) {
  var best = null;
  var bestDist = Infinity;
  for (var i = 0; i < _stripThumbs.length; i++) {
    var rect = _stripThumbs[i].el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var dist = Math.abs(clientX - cx);
    if (dist < bestDist) {
      bestDist = dist;
      best = _stripThumbs[i].time;
    }
  }
  return best;
}

// Highlight thumbnails in selected range
function updateStripRange() {
  for (var i = 0; i < _stripThumbs.length; i++) {
    var t = _stripThumbs[i];
    if (t.time >= _sliderStart && t.time <= _sliderEnd) {
      t.el.classList.add("in-range");
    } else {
      t.el.classList.remove("in-range");
    }
  }
}

function highlightFrameStrip(currentT) {
  for (var i = 0; i < _stripThumbs.length; i++) {
    var t = _stripThumbs[i];
    var dist = Math.abs(t.time - currentT);
    if (dist < 3 || (i > 0 && currentT > _stripThumbs[i-1].time && currentT <= t.time)) {
      t.el.classList.add("active");
      t.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    } else {
      t.el.classList.remove("active");
    }
  }
}

function jumpToFrame(t) {
  // Slide the clip range to follow the jump point
  if (_rangeLocked) {
    var ns = Math.max(0, t);
    if (ns + _lockedDuration > state.mediaDuration) ns = state.mediaDuration - _lockedDuration;
    setSliderStart(ns);
    setSliderEnd(ns + _lockedDuration);
  } else {
    var dur = _sliderEnd - _sliderStart;
    var ns = Math.max(0, t);
    setSliderStart(ns);
    if (dur > 0) {
      setSliderEnd(Math.min(state.mediaDuration, ns + dur));
    }
  }
  seekVideoTo(t);
  highlightFrameStrip(t);
  updateStripRange();
}

// ── Range bar (visual timeline showing selected clip region) ──────────

function sliderGetPct(t) {
  return Math.max(0, Math.min(100, (t / state.mediaDuration) * 100));
}

function updateRangeBar() {
  if (!dom.rangeBar) return;
  var pctStart = sliderGetPct(_sliderStart);
  var pctEnd = sliderGetPct(_sliderEnd);

  if (dom.rangeBarFill) {
    dom.rangeBarFill.style.left = pctStart + "%";
    dom.rangeBarFill.style.width = (pctEnd - pctStart) + "%";
  }
  if (dom.rangeBarMarkerStart) dom.rangeBarMarkerStart.style.left = pctStart + "%";
  if (dom.rangeBarMarkerEnd) dom.rangeBarMarkerEnd.style.left = pctEnd + "%";
}

// ── Range bar drag handles ──────────────────────────────────────────

var _handleDrag = null;  // 'start' | 'end' | null
var _dragGrabPct = 0;    // mouse pct at grab point
var _dragHandlePct = 0;  // handle pct at grab point

function initRangeBarHandles() {
  if (!dom.rangeBar) return;

  var bar = dom.rangeBar;

  // Shared drag-start logic — called by both mousedown and touchstart.
  // Caches bar rect at drag start so onMove never reflows.
  function _startBarDrag(clientX, target) {
    var barRect = bar.getBoundingClientRect();
    var barLeft = barRect.left;
    var barWidth = barRect.width;

    var mousePct = Math.max(0, Math.min(100, ((clientX - barLeft) / barWidth) * 100));
    var sec = (mousePct / 100) * state.mediaDuration;

    if (target === dom.rangeBarMarkerStart || (target.closest && target.closest("#range-bar-marker-start"))) {
      _handleDrag = "start";
      _dragGrabPct = mousePct;
      _dragHandlePct = sliderGetPct(_sliderStart);
      seekVideoTo(_sliderStart);
    } else if (target === dom.rangeBarMarkerEnd || (target.closest && target.closest("#range-bar-marker-end"))) {
      _handleDrag = "end";
      _dragGrabPct = mousePct;
      _dragHandlePct = sliderGetPct(_sliderEnd);
      seekVideoTo(_sliderEnd);
    } else {
      // Clicked on bar itself
      if (_rangeLocked) {
        // Locked: slide range to position at click (clamped to edges)
        var newStart = Math.floor(sec);
        if (newStart + _lockedDuration > state.mediaDuration) newStart = Math.max(0, state.mediaDuration - _lockedDuration);
        setSliderStart(newStart);
        setSliderEnd(newStart + _lockedDuration);
        seekVideoTo(_sliderStart);
        if (dom.clipStatus) {
          dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(state.mediaDuration) + " [locked " + _lockedDuration + "s]";
        }
        return;  // Immediate snap, no drag setup in locked mode
      }
      // Free mode: snap nearest handle
      var distStart = Math.abs(_sliderStart - sec);
      var distEnd = Math.abs(_sliderEnd - sec);
      _handleDrag = distStart <= distEnd ? "start" : "end";
      _dragGrabPct = mousePct;
      _dragHandlePct = _handleDrag === "start" ? sliderGetPct(_sliderStart) : sliderGetPct(_sliderEnd);
      // Apply immediately
      applyDrag(mousePct);
    }

    dom.rangeBar.classList.add("dragging");
    if (_handleDrag === "start") dom.rangeBarMarkerStart.classList.add("dragging");
    else dom.rangeBarMarkerEnd.classList.add("dragging");

    // Dynamic listeners — touch-aware onMove, cleanup for both families.
    // Uses cached bar rect for zero-layout-thrash tracking.
    function onMove(ev) {
      if (!_handleDrag) return;
      var cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      var movePct = Math.max(0, Math.min(100, ((cx - barLeft) / barWidth) * 100));
      var delta = movePct - _dragGrabPct;
      var newPct = _dragHandlePct + delta;
      applyDrag(newPct);
    }

    function onUp() {
      if (_handleDrag) {
        dom.rangeBarMarkerStart.classList.remove("dragging");
        dom.rangeBarMarkerEnd.classList.remove("dragging");
        dom.rangeBar.classList.remove("dragging");
        _handleDrag = null;
        if (dom.clipStatus) {
          var mode = _rangeLocked ? " [locked " + _lockedDuration + "s]" : "";
          dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(state.mediaDuration) + mode;
        }
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove);
    document.addEventListener("touchend", onUp);
  }

  bar.addEventListener("mousedown", function(e) {
    // Ignore right-click and strip drags
    if (e.button !== 0 || _stripDragActive) return;
    _startBarDrag(e.clientX, e.target);
    e.preventDefault();
    e.stopPropagation();
  });

  bar.addEventListener("touchstart", function(e) {
    if (_stripDragActive) return;
    if (!e.cancelable) return;  // passive listener guard
    _startBarDrag(e.touches[0].clientX, e.target);
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
}

function applyDrag(pct) {
  var sec = Math.floor((pct / 100) * state.mediaDuration);

  if (_rangeLocked) {
    // Locked mode: dragging either handle slides the entire range,
    // maintaining _lockedDuration. Both handles move together.
    if (_handleDrag === "start") {
      if (sec + _lockedDuration > state.mediaDuration) sec = state.mediaDuration - _lockedDuration;
      if (sec < 0) sec = 0;
      setSliderStart(sec);
      setSliderEnd(sec + _lockedDuration);
    } else if (_handleDrag === "end") {
      var newStart = sec - _lockedDuration;
      if (newStart < 0) { newStart = 0; sec = _lockedDuration; }
      if (sec > state.mediaDuration) { sec = state.mediaDuration; newStart = sec - _lockedDuration; }
      setSliderStart(newStart);
      setSliderEnd(sec);
    }
    seekVideoTo(_sliderStart);
  } else {
    // Free mode: handles move independently
    if (_handleDrag === "start") {
      if (sec >= _sliderEnd - 1) sec = _sliderEnd - 1;
      setSliderStart(sec);
      seekVideoTo(_sliderStart);
    } else if (_handleDrag === "end") {
      if (sec <= _sliderStart + 1) sec = _sliderStart + 1;
      setSliderEnd(sec);
      seekVideoTo(_sliderEnd);
    }
  }

  // Live feedback during drag
  if (dom.clipStatus) {
    var mode = _rangeLocked ? " [locked " + _lockedDuration + "s]" : "";
    dom.clipStatus.textContent = "Range: " + fmtTime(_sliderStart) + " – " + fmtTime(_sliderEnd) + " (" + (_sliderEnd - _sliderStart) + "s)" + mode;
  }
}

function updateTimeDisplay() {
  // Enforce constraints FIRST, then display.
  // NOTE: no hard 140s cap — handles should move freely. The download
  // button disables itself when duration > 140s; that's the enforcement point.
  if (_sliderEnd <= _sliderStart) _sliderEnd = _sliderStart + 1;
  if (_sliderEnd > state.mediaDuration) _sliderEnd = Math.floor(state.mediaDuration);
  if (_sliderStart > state.mediaDuration) _sliderStart = Math.floor(state.mediaDuration);
  if (_sliderStart < 0) _sliderStart = 0;

  if (dom.timeStartInput) dom.timeStartInput.value = fmtTime(_sliderStart);
  if (dom.timeEndInput) dom.timeEndInput.value = fmtTime(_sliderEnd);
  if (dom.timeDuration) dom.timeDuration.textContent = "/ " + fmtTime(state.mediaDuration);

  var dur = _sliderEnd - _sliderStart;
  if (dom.clipDuration) {
    dom.clipDuration.textContent = dur + "s";
  }

  updateDownloadButton();
  updateFineTuneSliders();
}

function setSliderStart(t) {
  _sliderStart = Math.max(0, Math.min(state.mediaDuration, Math.floor(t)));
  updateTimeDisplay();
  updateRangeBar();
  updateStripRange();
}

function setSliderEnd(t) {
  _sliderEnd = Math.max(1, Math.min(state.mediaDuration, Math.floor(t)));
  if (_sliderEnd <= _sliderStart) _sliderStart = Math.max(0, _sliderEnd - 1);
  updateTimeDisplay();
  updateRangeBar();
  updateStripRange();
}

// ── Download button state ──────────────────────────────────────────────

function updateDownloadButton() {
  if (!dom.btnDownload) return;
  var dur = _sliderEnd - _sliderStart;
  if (dur <= 0) {
    dom.btnDownload.disabled = true;
    dom.btnDownload.textContent = "⚠ Set a clip range";
  } else {
    dom.btnDownload.disabled = false;
    var label = "⬇ Download Clip";
    var parts = [];
    if (_captionsEnabled) {
      var capDetails = "captions";
      if (_captionColor !== "white" || _captionPosition !== "bottom") {
        var opts = [];
        if (_captionColor !== "white") opts.push(_captionColor);
        if (_captionPosition !== "bottom") opts.push(_captionPosition);
        capDetails += " (" + opts.join(", ") + ")";
      }
      parts.push(capDetails);
    }
    if (_verticalEnabled) parts.push("vertical");
    if (parts.length) label = "⬇ Download Clip (" + parts.join(" + ") + ")";
    dom.btnDownload.textContent = label;
  }
}

// ── Fine-tune sliders ────────────────────────────────────────────────────

function initFineTuneSliders() {
  var ss = document.getElementById("fine-tune-start");
  var es = document.getElementById("fine-tune-end");
  if (!ss || !es) return;

  ss.addEventListener("input", function () {
    _fineTuneStartActive = true;
    var v = parseFloat(this.value);
    setSliderStart(Math.min(_sliderEnd - 1, v));
    seekVideoTo(_sliderStart);
    _updateFineTuneStartVal();
  });
  ss.addEventListener("change", function () {
    _fineTuneStartActive = false;
    _updateFineTuneStartRange();
  });

  es.addEventListener("input", function () {
    _fineTuneEndActive = true;
    var v = parseFloat(this.value);
    setSliderEnd(Math.max(_sliderStart + 1, v));
    seekVideoTo(_sliderEnd);
    _updateFineTuneEndVal();
  });
  es.addEventListener("change", function () {
    _fineTuneEndActive = false;
    _updateFineTuneEndRange();
  });
}

function _updateFineTuneStartRange() {
  if (_fineTuneStartActive) return;
  var s = document.getElementById("fine-tune-start");
  if (!s) return;
  var dur = state.mediaDuration || 99999;
  var lo = Math.max(0, _sliderStart - _FINE_TUNE_WINDOW);
  var hi = Math.min(dur, _sliderStart + _FINE_TUNE_WINDOW);
  s.min = lo;
  s.max = hi;
  s.value = _sliderStart;
  _updateFineTuneStartVal();
}

function _updateFineTuneEndRange() {
  if (_fineTuneEndActive) return;
  var s = document.getElementById("fine-tune-end");
  if (!s) return;
  var dur = state.mediaDuration || 99999;
  var lo = Math.max(0, _sliderEnd - _FINE_TUNE_WINDOW);
  var hi = Math.min(dur, _sliderEnd + _FINE_TUNE_WINDOW);
  s.min = lo;
  s.max = hi;
  s.value = _sliderEnd;
  _updateFineTuneEndVal();
}

function _updateFineTuneStartVal() {
  var el = document.getElementById("fine-tune-start-val");
  if (el) el.textContent = fmtTime(_sliderStart);
}

function _updateFineTuneEndVal() {
  var el = document.getElementById("fine-tune-end-val");
  if (el) el.textContent = fmtTime(_sliderEnd);
}

function updateFineTuneSliders() {
  _updateFineTuneStartRange();
  _updateFineTuneEndRange();
}

// ── Preset Buttons ─────────────────────────────────────────────────────

function handlePreset(action, value) {
  if (action === "shift-start") {
    var ns = Math.max(0, _sliderStart + value);
    if (_rangeLocked) {
      // Locked: slide the entire window, keeping duration fixed
      setSliderStart(ns);
      setSliderEnd(Math.min(state.mediaDuration, ns + _lockedDuration));
    } else {
      var dur = _sliderEnd - _sliderStart;
      setSliderStart(ns);
      setSliderEnd(Math.min(state.mediaDuration, ns + Math.max(1, dur)));
    }
    seekVideoTo(_sliderStart);
  } else if (action === "shift-end") {
    var ne = Math.min(state.mediaDuration, _sliderEnd + value);
    if (_rangeLocked) {
      // Locked: slide the entire window
      setSliderEnd(ne);
      setSliderStart(Math.max(0, ne - _lockedDuration));
    } else {
      setSliderEnd(Math.max(_sliderStart + 1, ne));
    }
    seekVideoTo(_sliderEnd);
  } else if (action === "set-duration") {
    _rangeLocked = true;
    _lockedDuration = value;
    setSliderEnd(Math.min(state.mediaDuration, _sliderStart + value));
    seekVideoTo(_sliderStart);
    updatePresetButtons();
  } else if (action === "unlock") {
    _rangeLocked = false;
    updatePresetButtons();
  }
}

// Highlight the active preset button when range is locked.
function updatePresetButtons() {
  var btns = document.querySelectorAll(".preset-duration-btn");
  for (var i = 0; i < btns.length; i++) {
    var dur = parseInt(btns[i].getAttribute("data-duration"));
    btns[i].classList.toggle("active", _rangeLocked && dur === _lockedDuration);
  }
  var freeBtn = document.getElementById("btn-preset-free");
  if (freeBtn) freeBtn.classList.toggle("active", !_rangeLocked);
}

// ── Social media toggles ────────────────────────────────────────────────

function toggleCaptions() {
  _captionsEnabled = !_captionsEnabled;
  updateToggleButtons();
}

function toggleVertical() {
  _verticalEnabled = !_verticalEnabled;
  updateToggleButtons();
}

function toggleCaptionColor() {
  _captionColor = _captionColor === "white" ? "yellow" : "white";
  updateToggleButtons();
}

function toggleCaptionPosition() {
  _captionPosition = _captionPosition === "bottom" ? "middle" : "bottom";
  updateToggleButtons();
}

function updateToggleButtons() {
  if (dom.btnCaptions) {
    dom.btnCaptions.classList.toggle("active", _captionsEnabled);
    dom.btnCaptions.textContent = _captionsEnabled ? "💬 Captions ON" : "💬 Captions";

  // Show/hide collapsible caption options on mobile
  var capOpts = document.querySelector(".caption-options");
  if (capOpts) capOpts.classList.toggle("visible", _captionsEnabled);
  }
  if (dom.btnCaptionColor) {
    var showColor = _captionsEnabled;
    dom.btnCaptionColor.style.display = showColor ? "" : "none";
    if (showColor) {
      dom.btnCaptionColor.textContent = _captionColor === "white" ? "🎨 White" : "🎨 Yellow";
      dom.btnCaptionColor.classList.toggle("active", _captionColor !== "white");
    }
  }
  if (dom.btnCaptionPlacement) {
    var showPlace = _captionsEnabled;
    dom.btnCaptionPlacement.style.display = showPlace ? "" : "none";
    if (showPlace) {
      dom.btnCaptionPlacement.textContent = _captionPosition === "bottom" ? "📍 Bottom" : "📍 Middle";
      dom.btnCaptionPlacement.classList.toggle("active", _captionPosition !== "bottom");
    }
  }
  if (dom.btnVertical) {
    dom.btnVertical.classList.toggle("active", _verticalEnabled);
    dom.btnVertical.textContent = _verticalEnabled ? "📱 Vertical ON" : "📱 Vertical";
  }
  updateDownloadButton();
  updateFineTuneSliders();
}

function updateSocialToggles() {
  if (!dom.socialToggles) return;
  var item = state.currentItem;
  // Show toggles when a media item is selected
  if (item && dom.detailView && dom.detailView.style.display !== "none") {
    dom.socialToggles.style.display = "flex";
    // Captions toggle only if subtitle file exists
    if (dom.btnCaptions) {
      if (item.subtitle_path) {
        dom.btnCaptions.style.display = "";
        dom.btnCaptions.title = "Burn word-by-word captions from subtitle file";
      } else {
        dom.btnCaptions.style.display = "none";
        _captionsEnabled = false;
      }
    }
  } else {
    dom.socialToggles.style.display = "none";
  }
  updateToggleButtons();
}

// ── Clip Download ──────────────────────────────────────────────────────

var _clipPollTimer = null;

async function downloadClip() {
  if (!dom || !dom.btnDownload) return;

  if (!state.currentItem) {
    if (dom.clipStatus) dom.clipStatus.textContent = "No item selected";
    return;
  }

  var mediaId = state.currentItem.media_id || state.currentItem.id;
  if (!mediaId) {
    if (dom.clipStatus) dom.clipStatus.textContent = "No media ID";
    return;
  }

  var startSec = _sliderStart || 0;
  var endSec = _sliderEnd || 0;

  if (endSec <= startSec) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Invalid range: " + fmtTime(startSec) + " - " + fmtTime(endSec);
    return;
  }

  if (dom.btnDownload) { dom.btnDownload.disabled = true; dom.btnDownload.textContent = "Clipping..."; }
  if (dom.clipStatus) dom.clipStatus.textContent = "";
  if (dom.clipProgress) dom.clipProgress.style.display = "block";
  if (dom.clipProgressFill) dom.clipProgressFill.style.width = "0%";
  if (dom.clipProgressText) dom.clipProgressText.textContent = "Starting clip " + fmtTime(startSec) + "-" + fmtTime(endSec) + "...";

  try {
    // 1) Start clip generation (returns immediately)
    var startResp = await fetch("api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId, start_sec: startSec, end_sec: endSec, captions: _captionsEnabled, vertical: _verticalEnabled, caption_color: _captionColor, caption_position: _captionPosition }),
    });

    if (!startResp.ok) {
      var errData = await startResp.json().catch(function() { return {}; });
      throw new Error(errData.detail || "HTTP " + startResp.status);
    }

    var startData = await startResp.json();
    filename = startData.filename;

    // 2) Poll until done
    var result = await pollClipStatus(filename);

    // 3) Download
    if (result.done && !result.error) {
      var a = document.createElement("a");
      a.href = "api/download/" + filename;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      if (dom.clipStatus) dom.clipStatus.textContent = "Downloaded " + filename + " (" + Math.round(result.duration || (endSec - startSec)) + "s)";
      loadClipGallery();
    } else {
      throw new Error(result.error || "Unknown error");
    }
  } catch (err) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Error: " + err.message;
  } finally {
    if (dom.clipProgress) dom.clipProgress.style.display = "none";
    if (dom.btnDownload) { dom.btnDownload.disabled = false; dom.btnDownload.textContent = "\u{1F4E5} Download Clip"; }
  }
}

function pollClipStatus(filename) {
  return new Promise(function(resolve, reject) {
    var maxPolls = 300;
    var polls = 0;

    function poll() {
      polls++;
      if (polls > maxPolls) { reject(new Error("Clip generation timed out")); return; }

      fetch("api/clip/status/" + filename)
        .then(function(resp) { return resp.json(); })
        .then(function(status) {
          if (status.error) { reject(new Error(status.error)); return; }

          if (status.done) {
            // Done — resolve with the result
            if (dom.clipProgressFill) dom.clipProgressFill.style.width = "100%";
            if (dom.clipProgressText) dom.clipProgressText.textContent = "Done!";
            resolve({ done: true, error: null, duration: null, filename: filename });
            return;
          }

          // Update progress
          var pct = Math.round(status.progress * 100);
          var text = "Encoding clip... " + pct + "%";
          if (status.eta_seconds != null && status.eta_seconds > 0) {
            var mins = Math.floor(status.eta_seconds / 60);
            var secs = status.eta_seconds % 60;
            text += " (ETA " + mins + "m " + secs + "s)";
          }
          if (dom.clipProgressFill) dom.clipProgressFill.style.width = pct + "%";
          if (dom.clipProgressText) dom.clipProgressText.textContent = text;

          // Poll again
          setTimeout(poll, 2000);
        })
        .catch(function(err) { reject(err); });
    }

    poll();
  });
}

// ── Clip Gallery ─────────────────────────────────────────────────────

async function loadClipGallery() {
  try {
    var resp = await fetch("api/clips");
    if (!resp.ok) return;
    var data = await resp.json();
    var clips = data.clips || [];

    if (clips.length === 0) {
      if (dom.clipGallery) dom.clipGallery.style.display = "none";
      return;
    }

    if (dom.clipGallery) dom.clipGallery.style.display = "block";
    if (dom.clipCount) dom.clipCount.textContent = "(" + clips.length + ")";

    var html = "";
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      var sizeMB = (c.size / 1048576).toFixed(1);
      html += '<div class="clip-card">' +
        '<video src="api/download/' + c.filename + '" controls preload="metadata"></video>' +
        '<div class="clip-card-info">' +
          '<span class="clip-card-name" title="' + c.filename + '">' + c.filename + ' (' + sizeMB + 'MB)</span>' +
          '<div class="clip-card-actions">' +
            '<a class="btn btn-small" href="api/download/' + c.filename + '" download>DL</a>' +
            '<button class="btn btn-small" onclick="deleteClip(\'' + c.filename + '\')" style="color:var(--red)">✕</button>' +
          '</div>' +
        '</div></div>';
    }
    if (dom.clipGalleryGrid) dom.clipGalleryGrid.innerHTML = html;
  } catch (err) {
    // Silently fail — gallery is optional
  }
}

async function deleteClip(filename) {
  try {
    await fetch("api/clips/" + filename, { method: "DELETE" });
  } catch (e) {}
  loadClipGallery();
}

// ── Utilities ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function parseTimeInput(val) {
  // Parse "1:23", "1:23:45", "90", "90s"
  val = val.replace(/s$/i, "");
  var parts = val.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
  } else if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  } else {
    return parseInt(parts[0]) || null;
  }
}

// ── Event Wiring ───────────────────────────────────────────────────────

function init() {
  dom = getDom();

  // Home link on title
  var titleEl = qs("header h1");
  if (titleEl) {
    titleEl.style.cursor = "pointer";
    titleEl.addEventListener("click", goHome);
  }

  // Search
  if (dom.search) dom.search.addEventListener("input", function() { renderLibrary(dom.search.value); });

  // Sort
  var sortSelect = qs("#sort-by");
  if (sortSelect) {
    sortSelect.addEventListener("change", function() {
      currentSort = sortSelect.value;
      renderLibrary(dom.search ? dom.search.value : "");
    });
  }

  // Detail back button
  if (dom.btnBack) dom.btnBack.addEventListener("click", goBack);

  // Download clip
  if (dom.btnDownload) dom.btnDownload.addEventListener("click", downloadClip);

  // Play/pause + mute are wired via onclick in HTML (survives partial DOM failures)
  initPlayStateTracking();

  // Frame strip drag-to-select
  initStripDrag();

  // Range bar drag handles
  initRangeBarHandles();

  // Fine-tune sliders
  initFineTuneSliders();

  // Play/pause button state tracking
  initPlayStateTracking();

  // Keyboard shortcuts
  document.addEventListener("keydown", function(e) {
    // Escape to go back
    if (e.key === "Escape" && dom.detailView && dom.detailView.style.display !== "none") {
      goBack();
      return;
    }
    // Only in detail view
    if (!dom.detailView || dom.detailView.style.display === "none") return;
    // Don't capture when typing in inputs
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    var start = _sliderStart;
    var step = e.shiftKey ? 10 : 1;
    var isEnd = e.altKey;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isEnd) {
        var ne = Math.max(_sliderStart + 1, _sliderEnd - step);
        setSliderEnd(ne);
        seekVideoTo(_sliderEnd);
      } else {
        var ns = Math.max(0, start - step);
        setSliderStart(ns);
        seekVideoTo(_sliderStart);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (isEnd) {
        var ne = Math.min(state.mediaDuration, _sliderEnd + step);
        setSliderEnd(ne);
        seekVideoTo(_sliderEnd);
      } else {
        var ns = Math.min(state.mediaDuration, start + step);
        setSliderStart(ns);
        seekVideoTo(_sliderStart);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      downloadClip();
    }
  });

  // Load library
  loadLibrary();
  startSessionPolling();

  // Time jump input
  var jumpInput = qs("#jump-time");
  if (jumpInput) {
    jumpInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var val = jumpInput.value.trim();
        if (!val) return;
        var secs = parseTimeInput(val);
        if (secs !== null && secs >= 0 && secs <= state.mediaDuration) {
          jumpToFrame(secs);
          jumpInput.value = "";
        }
      }
    });
  }

  // Editable time inputs: Enter or blur applies the value
  function wireTimeInput(inputEl, isStart) {
    if (!inputEl) return;
    function apply() {
      var secs = parseTimeInput(inputEl.value.trim());
      if (secs !== null && secs >= 0 && secs <= state.mediaDuration) {
        if (isStart) {
          setSliderStart(secs);
          seekVideoTo(_sliderStart);
        } else {
          setSliderEnd(secs);
        }
      } else {
        // Reset to current value on invalid input
        updateTimeDisplay();
      }
    }
    inputEl.addEventListener("keydown", function(e) {
      if (e.key === "Enter") { e.preventDefault(); apply(); inputEl.blur(); }
    });
    inputEl.addEventListener("blur", apply);
  }
  wireTimeInput(dom.timeStartInput, true);
  wireTimeInput(dom.timeEndInput, false);
}

// ── Auth: Plex OAuth PIN flow ───────────────────────────────────────────

var _authPinId = null;
var _authPollTimer = null;
var _authPollCount = 0;
var MAX_PIN_POLLS = 150;  // 5 minutes at 2s intervals

function stopPinPolling() {
  if (_authPollTimer) {
    clearInterval(_authPollTimer);
    _authPollTimer = null;
  }
  _authPinId = null;
  _authPollCount = 0;
}

function showLoginStep(step) {
  var steps = ["login-step-connect", "login-step-pin", "login-step-error"];
  for (var i = 0; i < steps.length; i++) {
    var el = qs("#" + steps[i]);
    if (el) el.style.display = steps[i] === step ? "" : "none";
  }
}

function initAuth() {
  var overlay = qs("#login-overlay");
  var btnConnect = qs("#btn-plex-connect");
  var btnRetry = qs("#btn-login-retry");
  var btnCancel = qs("#btn-pin-cancel");

  // Check if already authenticated
  fetch("api/auth/status")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.authenticated) {
        // Already have a token — hide login, init app
        if (overlay) overlay.classList.add("hidden");
        init();
        return;
      }
      // Show login
      if (overlay) overlay.classList.remove("hidden");
      showLoginStep("login-step-connect");
    })
    .catch(function() {
      // Can't reach backend — show login anyway
      if (overlay) overlay.classList.remove("hidden");
      showLoginStep("login-step-connect");
    });

  // Connect button
  if (btnConnect) {
    btnConnect.addEventListener("click", function() {
      startPinFlow();
    });
  }

  // Cancel button
  if (btnCancel) {
    btnCancel.addEventListener("click", function() {
      cancelPinFlow();
    });
  }

  // Retry button
  if (btnRetry) {
    btnRetry.addEventListener("click", function() {
      stopPinPolling();
      showLoginStep("login-step-connect");
    });
  }
}

function cancelPinFlow() {
  stopPinPolling();
  showLoginStep("login-step-connect");
}

function startPinFlow() {
  showLoginStep("login-step-pin");

  fetch("api/auth/pin", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.code) {
        var codeEl = qs("#login-pin-code");
        if (codeEl) codeEl.textContent = data.code;
        _authPinId = data.id;
        _authPollCount = 0;
        // Start polling
        _authPollTimer = setInterval(pollPinStatus, 2000);
      }
    })
    .catch(function(err) {
      showLoginError("Could not connect to Plex.tv. Is the server online?");
    });
}

function pollPinStatus() {
  if (!_authPinId) return;

  _authPollCount++;
  if (_authPollCount > MAX_PIN_POLLS) {
    stopPinPolling();
    showLoginError("PIN expired. Please try again.");
    return;
  }

  fetch("api/auth/pin/" + _authPinId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === "done") {
        stopPinPolling();
        var overlay = qs("#login-overlay");
        if (overlay) overlay.classList.add("hidden");
        init();
      } else if (data.status === "error") {
        stopPinPolling();
        showLoginError(data.error || "Authentication failed. Please try again.");
      }
      // "waiting" — keep polling
    })
    .catch(function() {
      // Backend error during poll — keep trying
    });
}

function showLoginError(msg) {
  showLoginStep("login-step-error");
  var errEl = qs("#login-error-text");
  if (errEl) errEl.textContent = msg;
}

// ── Boot ───────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAuth);
} else {
  initAuth();
}
