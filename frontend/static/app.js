/**
 * Cliparr — Frontend Application
 *
 * Vanilla JS app handling library browsing, now-playing banner,
 * proxy generation UX, scrubber controls, and clip downloads.
 */


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
    frameStrip:      qs("#frame-strip"),
    frameStripInner: qs("#frame-strip-inner"),
    // Unified editor elements (single selection + download surface on both
    // desktop and mobile; the old desktop-only #btn-download-clip / #clip-*
    // / #social-toggles / time-input elements were removed in the de-clutter).
    btnDownload:      qs("#mob-btn-download"),
    clipStatus:       qs("#mob-clip-status"),
    clipProgress:     qs("#mob-clip-progress"),
    clipProgressFill: qs("#mob-clip-progress-fill"),
    clipProgressText: qs("#mob-clip-progress-text"),
    // Clip gallery
    clipGallery:     qs("#clip-gallery"),
    clipGalleryGrid: qs("#clip-gallery-grid"),
    clipCount:       qs("#clip-count"),
  };
}

let dom;

// Clip range state — float precision for frame-accurate seeking
var _sliderStart = 0;
var _sliderEnd = 0;

// Bumped by goHome()/goBack() so in-flight selectItem() fetches can detect
// that the user navigated away (SPA history integration, v=35).
var _navCounter = 0;

// Social media options
var _captionsEnabled = false;
var _verticalEnabled = false;
var _captionColor = "white";        // "white" or "yellow"
var _captionPosition = "bottom";    // "bottom" or "middle"

// Mobile detection
var _isMobile = false;
function isMobile() { return _isMobile; }

// ── Formatting ─────────────────────────────────────────────────────────

function fmtTime(seconds, precise) {
  if (seconds == null || isNaN(seconds)) return "0:00";
  // Round to 2dp BEFORE splitting minutes/seconds so boundary values
  // roll over correctly (59.999s -> 1:00.00, not 0:60.00).
  var s = Math.max(0, Math.round(seconds * 100) / 100);
  var m = Math.floor(s / 60);
  var sec = s % 60;
  if (precise) {
    return m + ":" + sec.toFixed(2).padStart(5, "0");
  }
  return m + ":" + String(Math.floor(sec)).padStart(2, "0");
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
    case "random":
      // Fisher-Yates shuffle
      for (var i = sorted.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = sorted[i];
        sorted[i] = sorted[j];
        sorted[j] = tmp;
      }
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
  _navCounter++;
  // On a pushed detail entry, route through history so the browser
  // back-stack stays consistent (popstate handler does the view switch).
  if (window.history && history.state && history.state.view === "detail") {
    try { history.back(); return; } catch (e) {}
  }
  if (dom.detailView) dom.detailView.style.display = "none";
  if (dom.libraryView) dom.libraryView.style.display = "block";
  var mainEl = document.getElementById("main");
  if (mainEl) mainEl.scrollTop = 0;
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
  renderLibrary();
  if (typeof destroyMobileDetail === 'function') destroyMobileDetail();
}

// ── Detail View ────────────────────────────────────────────────────────

async function selectItem(mediaId) {
  var navAtStart = _navCounter;
  try {
    var resp = await fetch("api/library/" + mediaId);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var item = await resp.json();
    // User may have swiped back / hit Home while the fetch was in flight —
    // don't yank them back into the detail view.
    if (_navCounter !== navAtStart) return;
    state.currentItem = item;
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

  // Landing position: the library grid is huge (100k+ px), so swapping
  // views clamps the old scrollTop to the much shorter detail view —
  // on mobile that lands at the BOTTOM of the clip sheet (video hidden,
  // page feels stuck). Always start the detail view at the top.
  var mainEl = document.getElementById("main");
  if (mainEl) mainEl.scrollTop = 0;

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
  if (dom.clipProgress) dom.clipProgress.style.display = "none";
  if (dom.clipStatus) dom.clipStatus.textContent = "";

  // Load video preview from original media file
  var mediaId = item.media_id || item.id;
  loadVideoPreview(mediaId);

  // Build frame strip
  if (_filmStripEnabled) buildFrameStrip(mediaId, durationS);

  // Handle jump-to-clip offset from session banner
  if (window._jumpOffset != null) {
    var offset = window._jumpOffset;
    _sliderStart = Math.max(0, Math.floor(offset - 5));
    _sliderEnd = Math.min(durationS, Math.floor(offset + 25));
    window._jumpOffset = null;
    window._jumpDuration = null;
  } else {
    _sliderStart = 0;
    _sliderEnd = Math.floor(durationS);
  }

  updateTimeDisplay();
  updateDownloadButton();
  updateStripRange();
  updateSocialToggles();

  // Seek video to start position once ready
  seekVideoTo(_sliderStart);

  if (dom.clipStatus) dom.clipStatus.textContent = "Ready — range: " + fmtTime(_sliderStart) + "–" + fmtTime(_sliderEnd) + " of " + fmtTime(durationS);

  // Init radical mobile timeline (two-thumb scrubber)
  if (typeof initMobileDetail === 'function') {
    initMobileDetail(item);
  }

  // Push a "detail" history entry so back-swipe/back-button from a movie
  // lands on the in-app home (popstate handler switches views) instead of
  // popping the real entry and leaving the site.
  if (window.history && history.pushState) {
    try { history.pushState({ view: "detail" }, ""); } catch (e) {}
  }
}

function goBack() {
  _navCounter++;
  // On a pushed detail entry, route through history so the browser
  // back-stack stays consistent (popstate handler does the view switch).
  if (window.history && history.state && history.state.view === "detail") {
    try { history.back(); return; } catch (e) {}
  }
  if (dom.detailView) dom.detailView.style.display = "none";
  if (dom.libraryView) dom.libraryView.style.display = "block";
  var mainEl = document.getElementById("main");
  if (mainEl) mainEl.scrollTop = 0;
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
  renderLibrary(dom.search ? dom.search.value : "");
  if (typeof destroyMobileDetail === 'function') destroyMobileDetail();
}

// ── Now Playing Banner ─────────────────────────────────────────────────

var sessionPollTimer = null;
var _currentSession = null;  // stored for Quick Clip
var _bannerDismissed = false;  // ✕ dismiss; auto-clears when no session paused

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
      if (!_bannerDismissed) {
        dom.nowPlaying.style.display = "block";
        if (dom.npTitle) dom.npTitle.textContent = paused.title;
        if (dom.npTime) dom.npTime.textContent = "at " + fmtTime(paused.viewOffset);
        if (dom.btnJumpClip) dom.btnJumpClip.onclick = function() { jumpToClip(paused); };
        if (dom.btnQuickClip) dom.btnQuickClip.onclick = function() { quickClip(); };
      }
    } else if (dom.nowPlaying) {
      _currentSession = null;
      _bannerDismissed = false;
      dom.nowPlaying.style.display = "none";
    }
  } catch (err) {
    // Silently fail — banner is optional
  }
}

function dismissNowPlaying() {
  _bannerDismissed = true;
  if (dom.nowPlaying) dom.nowPlaying.style.display = "none";
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

  // Clear any subtitle <track> left over from a previous movie. A stale
  // track element stays attached to <video> across src changes, and the
  // browser re-associates its TextTrack with the new resource — so the
  // previous movie's subtitles can render over the next one. Removing the
  // elements (and disabling any lingering TextTrack objects) here, BEFORE
  // the new src is set, gives every load a clean slate — including movies
  // that have no subtitle file at all.
  var staleTracks = vid.querySelectorAll("track");
  for (var sti = 0; sti < staleTracks.length; sti++) staleTracks[sti].remove();
  var staleTT = vid.textTracks;
  for (var stj = 0; stj < staleTT.length; stj++) staleTT[stj].mode = "disabled";

  if (dom.previewError) dom.previewError.style.display = "none";
  if (dom.previewLoading) dom.previewLoading.style.display = "block";

  vid.onloadedmetadata = function() {
    _videoReady = true;
    if (dom.previewLoading) dom.previewLoading.style.display = "none";
    if (dom.previewError) dom.previewError.style.display = "none";
    vid.currentTime = _sliderStart;
    // Always clear stale subtitle tracks (belt & braces — loadVideoPreview
    // already cleared before setting src). A track left from a previous
    // movie renders its cues over the new one. Must be AFTER metadata
    // loads (adding before vid.src causes MEDIA_ERR_SRC_NOT_SUPPORTED on
    // mobile).
    var oldTracks = vid.querySelectorAll("track");
    for (var ti = 0; ti < oldTracks.length; ti++) oldTracks[ti].remove();
    var oldTT = vid.textTracks;
    for (var tj = 0; tj < oldTT.length; tj++) oldTT[tj].mode = "disabled";
    if (state.currentItem && state.currentItem.subtitle_path) {
      try {
        var track = document.createElement("track");
        track.kind = "subtitles";
        track.label = "English";
        track.srclang = "en";
        track.src = "api/subtitle/" + mediaId;
        track.default = true;
        track.onload = function() { console.log("Subtitle track loaded"); };
        track.onerror = function() { console.warn("Subtitle track failed to load"); };
        vid.appendChild(track);
        // Force-show: default=true only auto-shows a track at resource-fetch
        // time, but this track is added AFTER metadata — without this the
        // subtitles silently stay off on subsequent loads of the same movie.
        var tt = vid.textTracks;
        if (tt && tt.length) tt[tt.length - 1].mode = "showing";
        // Enable native subtitle toggle in controls
        if (!vid.hasAttribute("controls")) vid.setAttribute("controls", "controls");
      } catch(e) {
        console.warn("Failed to add subtitle track:", e);
      }
    }
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
    // Current "Frame at" readout (now shared desktop+mobile — lives in the
    // unified clip editor).
    if (dom.frameTimeValue) dom.frameTimeValue.textContent = fmtTime(Math.floor(ct));
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

  var thumbs = dom.frameStripInner.querySelectorAll(".frame-thumb");
  for (var j = 0; j < thumbs.length; j++) {
    var t = parseInt(thumbs[j].getAttribute("data-time"));
    _stripThumbs.push({time: t, el: thumbs[j]});
  }
}

// The film strip is navigation-only — it is NOT a scrubber and does NOT
// mark clip edges. Tap/click a thumbnail to move the playhead there.
// Dragging/panning never seeks.
var _stripClickTime = null;
var _lastTouchEndTime = 0;  // suppresses compatibility mouse events after touch
// Film-strip opt-in toggle — hidden by default, shown on request.
var _filmStripEnabled = false;
function toggleFilmStrip() {
  _filmStripEnabled = !_filmStripEnabled;
  var btn = document.getElementById("btn-film-strip");
  if (_filmStripEnabled) {
    if (!_stripThumbs || !_stripThumbs.length) {
      var it = state.currentItem;
      buildFrameStrip((it && (it.media_id || it.id)) || "", state.mediaDuration);
    }
    if (dom.frameStrip) dom.frameStrip.style.display = "block";
    if (btn) btn.classList.add("active");
  } else {
    if (dom.frameStrip) dom.frameStrip.style.display = "none";
    if (btn) btn.classList.remove("active");
  }
}

function initStripDrag() {
  if (!dom.frameStripInner) return;

  dom.frameStripInner.addEventListener("mousedown", function(e) {
    if (e.button !== 0) return;
    if (Date.now() - _lastTouchEndTime < 600) return;  // ghost mousedown after touch
    var thumb = e.target.closest && e.target.closest(".frame-thumb");
    if (!thumb) return;
    e.preventDefault();
    seekVideoTo(parseInt(thumb.getAttribute("data-time")));  // move the playhead
  });

  dom.frameStripInner.addEventListener("touchstart", function(e) {
    var thumb = e.target.closest && e.target.closest(".frame-thumb");
    if (!thumb) return;
    _stripClickTime = parseInt(thumb.getAttribute("data-time"));
    // No seek here — a pan/scroll is browsing, not scrubbing. Seek on tap.
  }, { passive: true });

  dom.frameStripInner.addEventListener("touchend", function() {
    _lastTouchEndTime = Date.now();
    if (_stripClickTime == null) return;
    var t = _stripClickTime;
    _stripClickTime = null;
    seekVideoTo(t);  // move the playhead to the tapped frame
  }, { passive: true });

  // The browser claimed the gesture (pan/scroll) — cancel any pending tap.
  dom.frameStripInner.addEventListener("touchcancel", function() {
    _stripClickTime = null;
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
  if (!dom.frameStrip || dom.frameStrip.style.display === "none") return;
  if (!dom.frameStripInner || !_stripThumbs || !_stripThumbs.length) return;
  for (var i = 0; i < _stripThumbs.length; i++) {
    var t = _stripThumbs[i];
    if (t.time >= _sliderStart && t.time <= _sliderEnd) {
      t.el.classList.add("in-range");
    } else {
      t.el.classList.remove("in-range");
    }
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
}

function setSliderStart(t) {
  _sliderStart = Math.max(0, Math.min(state.mediaDuration, Math.round(t * 100) / 100));
  updateTimeDisplay();
  updateStripRange();
}

function setSliderEnd(t) {
  _sliderEnd = Math.max(0.01, Math.min(state.mediaDuration, Math.round(t * 100) / 100));
  if (_sliderEnd <= _sliderStart) _sliderStart = Math.max(0, _sliderEnd - 0.01);
  updateTimeDisplay();
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
  // Sync the unified editor's option checkboxes
  var mcc = document.getElementById("mob-chk-captions");
  if (mcc) mcc.checked = _captionsEnabled;
  var mcv = document.getElementById("mob-chk-vertical");
  if (mcv) mcv.checked = _verticalEnabled;
  // Sync caption color/placement option buttons (logic lives in mobile.js)
  if (typeof _mobRenderCaptionOpts === "function") _mobRenderCaptionOpts();
  updateDownloadButton();
}

function updateSocialToggles() {
  var item = state.currentItem;
  var inDetail = item && dom.detailView && dom.detailView.style.display !== "none";
  // Captions option only when a subtitle file exists for this item
  if (item && !item.subtitle_path) _captionsEnabled = false;
  var mobOpts = document.getElementById("mob-options");
  if (mobOpts) mobOpts.style.display = inDetail ? "" : "none";
  var mobCaptions = document.getElementById("mob-opt-captions");
  if (mobCaptions) mobCaptions.style.display = (item && item.subtitle_path) ? "" : "none";
  updateToggleButtons();
}

// ── Clip Download ──────────────────────────────────────────────────────

var _clipPollTimer = null;

async function downloadClip() {
  if (!dom) return;

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
  // Desktop progress
  if (dom.clipProgress) dom.clipProgress.style.display = "block";
  if (dom.clipProgressFill) dom.clipProgressFill.style.width = "0%";
  if (dom.clipProgressText) dom.clipProgressText.textContent = "Starting clip " + fmtTime(startSec) + "-" + fmtTime(endSec) + "...";
  // NOTE: mobile progress is driven by mobile.js mobDownload() ->
  // _mobShowProgress()/_mobStartProgressPolling(), which mirrors the
  // desktop bar into #mob-clip-progress*. No app.js mobile writes here.

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
    showClipShortcut();
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

function showClipShortcut() {
  var link = document.getElementById("clip-shortcut-link");
  if (link) link.style.display = "inline-block";
}



// ── Event Wiring ───────────────────────────────────────────────────────

function init() {
  dom = getDom();

  // ── SPA history: keep back-swipe / back-button INSIDE the app ──
  // Cliparr is a single page with JS-swapped views. Without history
  // entries, a phone's edge-swipe-back (iOS) or back button pops the ONE
  // real entry and navigates away from the site entirely. Seed two in-app
  // "home" entries, push a "detail" entry when a movie opens, and intercept
  // popstate to switch views in-app instead of leaving.
  if (window.history && history.pushState) {
    try {
      history.replaceState({ view: "home" }, "");
      history.pushState({ view: "home" }, "");
    } catch (e) { /* history API unavailable — fall back to no-op */ }
  }
  window.addEventListener("popstate", function(e) {
    var st = e.state;
    if (st && st.view === "detail") {
      // Forward/restore into detail: only if we still have an item.
      if (state.currentItem) showDetailView();
      return;
    }
    // Back to home: switch in-app, never leave the site.
    goHome();
    // Absorb the back gesture: push a fresh home entry so the NEXT back
    // also lands in-app instead of popping into the previous website.
    try { history.pushState({ view: "home" }, ""); } catch (err) {}
  });

  // Detect mobile at init
  _isMobile = window.innerWidth <= 768;
  window.addEventListener("resize", function() {
    _isMobile = window.innerWidth <= 768;
  });

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

  // Download clip is wired via onclick="mobDownload()" in HTML (mobDownload
  // calls downloadClip) — no addEventListener here or every click fires twice.

  // Frame strip drag-to-select
  initStripDrag();

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
    if ((e.key === "i" || e.key === "I") && typeof mobMarkStart === "function") { e.preventDefault(); mobMarkStart(); return; }
    if ((e.key === "o" || e.key === "O") && typeof mobMarkEnd === "function") { e.preventDefault(); mobMarkEnd(); return; }
    if (e.key === " ") { e.preventDefault(); var vid = dom.previewVideo; if (vid) { if (vid.paused) vid.play(); else vid.pause(); } return; }

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
