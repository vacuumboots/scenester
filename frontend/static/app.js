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
  proxyDuration: 0,     // seconds (full movie duration for sliders)
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
    btnPlayPreview:  qs("#btn-play-preview"),
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
  };
}

let dom;

// Clip range state
var _sliderStart = 0;
var _sliderEnd = 30;

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
  state.proxyDuration = durationS;

  // Show frame preview area
  if (dom.framePreview) dom.framePreview.style.display = "block";
  if (dom.btnPlayPreview) dom.btnPlayPreview.style.display = "inline-flex";
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
    _sliderEnd = Math.min(30, Math.floor(durationS));
  }

  updateTimeDisplay();
  updateRangeBar();
  if (dom.btnDownload) dom.btnDownload.disabled = false;
  updateStripRange();

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

function loadVideoPreview(mediaId) {
  _videoReady = false;
  _videoFailed = false;

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
  if (dom.previewVideo && dom.previewVideo.readyState >= 2) {
    dom.previewVideo.currentTime = t;
  }
}

function playFromHere() {
  if (!dom.previewVideo) return;

  var vid = dom.previewVideo;

  // If video isn't loaded yet or failed, show what's happening
  if (vid.readyState < 2) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Video still loading...";
    return;
  }

  if (vid.paused) {
    vid.currentTime = _sliderStart;
    var promise = vid.play();
    if (promise) {
      promise.catch(function(err) {
        if (dom.clipStatus) dom.clipStatus.textContent = "Playback failed: " + (err.message || "unknown error");
      });
    }
  } else {
    vid.pause();
  }
}

// Update play button text based on video state
function updatePlayButton() {
  if (!dom.btnPlayPreview || !dom.previewVideo) return;
  dom.btnPlayPreview.textContent = dom.previewVideo.paused ? '▶ Play from here' : '⏸ Pause';
}

// Wire play/pause state tracking
function initPlayStateTracking() {
  if (!dom.previewVideo) return;
  dom.previewVideo.addEventListener('play', updatePlayButton);
  dom.previewVideo.addEventListener('pause', updatePlayButton);
  dom.previewVideo.addEventListener('ended', updatePlayButton);
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
    html += '<div class="frame-thumb" data-time="' + t + '" ' +
            'onclick="stripClick(' + t + ', event)" ' +
            'onmouseenter="seekVideoTo(' + t + ')" ' +
            'onmouseleave="seekVideoTo(_sliderStart)">' +
            '<img src="api/frame/' + mediaId + '?t=' + t + '" loading="lazy" />' +
            '<span class="frame-thumb-time">' + fmtTime(t) + '</span></div>';
  }
  dom.frameStripInner.innerHTML = html;
  dom.frameStrip.style.display = "block";

  var thumbs = dom.frameStripInner.querySelectorAll(".frame-thumb");
  for (var j = 0; j < thumbs.length; j++) {
    var t = parseInt(thumbs[j].getAttribute("data-time"));
    _stripThumbs.push({time: t, el: thumbs[j]});
  }
}

// Click on frame strip: normal = set start, shift+click = set end
// Drag across frames to select a range
var _stripDragStart = null;
var _stripDragActive = false;
var _stripStartBeforeDrag = 0;

function stripClick(t, e) {
  // Skip if we're in the middle of a drag (mousedown/move/up handles that)
  if (_stripDragActive) return;
  if (e && e.shiftKey) {
    setSliderEnd(t);
    seekVideoTo(_sliderStart);
  } else {
    var dur = _sliderEnd - _sliderStart;
    setSliderStart(t);
    if (dur > 0 && dur <= 140) {
      setSliderEnd(Math.min(state.proxyDuration, t + dur));
    }
  }
  updateStripRange();
}

// Drag across frame thumbnails to select a clip range
function initStripDrag() {
  if (!dom.frameStripInner) return;

  dom.frameStripInner.addEventListener("mousedown", function(e) {
    var thumb = e.target.closest && e.target.closest(".frame-thumb");
    if (!thumb) return;
    e.preventDefault();
    _stripDragActive = false;
    _stripDragStart = parseInt(thumb.getAttribute("data-time"));
    _stripStartBeforeDrag = _sliderStart;

    function onMove(ev) {
      var tEl = ev.target.closest && ev.target.closest(".frame-thumb");
      if (!tEl) return;
      var t = parseInt(tEl.getAttribute("data-time"));
      _stripDragActive = true;
      if (t >= _stripDragStart) {
        setSliderStart(_stripDragStart);
        setSliderEnd(t);
      } else {
        setSliderStart(t);
        setSliderEnd(_stripDragStart);
      }
      seekVideoTo(_sliderStart);
      updateStripRange();
      if (dom.clipStatus) dom.clipStatus.textContent = "Drag: " + fmtTime(_sliderStart) + " – " + fmtTime(_sliderEnd);
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (_stripDragActive) {
        seekVideoTo(_sliderStart);
        if (dom.clipStatus) dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(state.proxyDuration);
      }
      _stripDragActive = false;
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
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
  setSliderStart(t);
  seekVideoTo(t);
  highlightFrameStrip(t);
  updateStripRange();
}

// ── Range bar (visual timeline showing selected clip region) ──────────

function sliderGetPct(t) {
  return Math.max(0, Math.min(100, (t / state.proxyDuration) * 100));
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

function updateTimeDisplay() {
  if (dom.timeStartInput) dom.timeStartInput.value = fmtTime(_sliderStart);
  if (dom.timeEndInput) dom.timeEndInput.value = fmtTime(_sliderEnd);
  if (dom.timeDuration) dom.timeDuration.textContent = "/ " + fmtTime(state.proxyDuration);
  if (dom.clipDuration) dom.clipDuration.textContent = (_sliderEnd - _sliderStart) + "s";

  // Enforce constraints
  if (_sliderEnd <= _sliderStart) _sliderEnd = _sliderStart + 1;
  if (_sliderEnd - _sliderStart > 140) _sliderEnd = _sliderStart + 140;
  if (_sliderEnd > state.proxyDuration) _sliderEnd = Math.floor(state.proxyDuration);
  if (_sliderStart > state.proxyDuration) _sliderStart = Math.floor(state.proxyDuration);
  if (_sliderStart < 0) _sliderStart = 0;
}

function setSliderStart(t) {
  _sliderStart = Math.max(0, Math.min(state.proxyDuration, Math.floor(t)));
  updateTimeDisplay();
  updateRangeBar();
  updateStripRange();
}

function setSliderEnd(t) {
  _sliderEnd = Math.max(1, Math.min(state.proxyDuration, Math.floor(t)));
  if (_sliderEnd <= _sliderStart) _sliderStart = Math.max(0, _sliderEnd - 1);
  updateTimeDisplay();
  updateRangeBar();
  updateStripRange();
}

// ── Preset Buttons ─────────────────────────────────────────────────────

function handlePreset(action, value) {
  if (action === "shift-start") {
    var ns = Math.max(0, _sliderStart + value);
    var dur = _sliderEnd - _sliderStart;
    setSliderStart(ns);
    setSliderEnd(Math.min(state.proxyDuration, ns + Math.max(1, dur)));
    seekVideoTo(_sliderStart);
  } else if (action === "set-duration") {
    setSliderEnd(Math.min(state.proxyDuration, _sliderStart + value));
    seekVideoTo(_sliderStart);
  }
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
      body: JSON.stringify({ media_id: mediaId, start_sec: startSec, end_sec: endSec }),
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

  // Play/pause button
  if (dom.btnPlayPreview) dom.btnPlayPreview.addEventListener("click", playFromHere);

  // Mute toggle
  if (dom.btnMuteToggle) dom.btnMuteToggle.addEventListener("click", toggleMute);

  // Frame strip drag-to-select
  initStripDrag();

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

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      var ns = Math.max(0, start - step);
      setSliderStart(ns);
      seekVideoTo(_sliderStart);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      var ns = Math.min(state.proxyDuration, start + step);
      setSliderStart(ns);
      seekVideoTo(_sliderStart);
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
        if (secs !== null && secs >= 0 && secs <= state.proxyDuration) {
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
      if (secs !== null && secs >= 0 && secs <= state.proxyDuration) {
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

// ── Boot ───────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
