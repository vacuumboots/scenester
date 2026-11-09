/**
 * Scenester — Frontend Application
 *
 * Vanilla JS app handling library browsing, the now-playing banner,
 * the unified mark-from-playhead clip editor, and clip downloads.
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

// Shortest clip the UI will offer to encode. Marking only one edge leaves a
// 0.04s seed range on purpose (so the overview bar has something to draw), so
// the "is there a clip?" test must be a real duration, not dur > 0 — otherwise
// tapping Set Start alone arms Download with a 40ms clip. The backend enforces
// the same floor.
var MIN_CLIP_SECONDS = 0.5;

function clipRangeReady() {
  // Both edges must be marked. updateTimeDisplay() widens a single-mark seed to
  // a full second (so the overview bar has something to draw), which is above
  // MIN_CLIP_SECONDS and used to arm Download after one tap of Set Start.
  return _mobStartSet === true && _mobEndSet === true &&
         (_sliderEnd - _sliderStart) >= MIN_CLIP_SECONDS;
}

// Bumped by goHome()/goBack() so in-flight selectItem() fetches can detect
// that the user navigated away (SPA history integration, v=35).
var _navCounter = 0;

// Social media options
var _captionsEnabled = false;
var _verticalEnabled = false;
var _captionColor = "white";        // "white" or "yellow"
var _captionPosition = "bottom";    // "bottom" or "middle"
var _clipFormat = "mp4";            // "mp4" or "gif"

// Mobile detection
var _isMobile = false;

// Transient seek target for jump-to-clip — consumed by onloadedmetadata.
var _pendingSeek = null;

// ── Formatting ─────────────────────────────────────────────────────────

function fmtTime(seconds) {
  if (seconds == null || isNaN(seconds)) return "0:00";
  // Whole-second point-in-time readout: M:SS under an hour, H:MM:SS at or
  // over (never bare m:ss, never sub-second). Durations use fmtDuration.
  var s = Math.max(0, Math.floor(seconds));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = Math.floor(s % 60);
  if (h > 0) {
    return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }
  return m + ":" + String(sec).padStart(2, "0");
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
  // Leaving the detail view: stop any clip status polling.
  cancelClipPolling();
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
  if (typeof hideQuoteResults === "function") hideQuoteResults();
  if (typeof setSearchMode === "function") setSearchMode("title");
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
    // Doing nothing left the library looking unresponsive and invited repeated
    // taps, which are expensive for this user.
    var banner = document.getElementById("error-banner");
    if (banner) {
      banner.textContent = "Could not open that title - " + (err && err.message ? err.message : "unknown error");
      banner.style.display = "block";
      clearTimeout(selectItem._bannerTimer);
      selectItem._bannerTimer = setTimeout(function() { banner.style.display = "none"; }, 6000);
    }
  }
}

function showDetailView() {
  var item = state.currentItem;

  // Clear the previous film's dialogue before its own metadata arrives. Until
  // then the Lines panel used to stay populated and live, so tapping a line
  // marked a range from the film you had already left.
  _captionLines = [];
  _filteredIdx = [];
  var _staleLines = document.getElementById("mob-lines");
  if (_staleLines) _staleLines.style.display = "none";
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
  if (dom.framePreview) dom.framePreview.style.display = "";
  if (dom.clipProgress) dom.clipProgress.style.display = "none";
  if (dom.clipStatus) dom.clipStatus.textContent = "";

  // Load video preview from original media file
  var mediaId = item.media_id || item.id;
  loadVideoPreview(mediaId);

  // Build frame strip
  if (_filmStripEnabled) buildFrameStrip(mediaId, durationS);

  // Handle jump-to-clip offset from the session banner. The offset is
  // transient intent, NOT selection state: the clip range stays FREE (both
  // edges unset — initMobileDetail below resets them), we only seek the
  // playhead to the paused position. A direct seek here would no-op (video
  // metadata isn't loaded yet), so stash the offset in _pendingSeek for
  // loadVideoPreview's onloadedmetadata to consume.
  _sliderStart = 0;
  _sliderEnd = 0;
  if (window._jumpOffset != null) {
    _pendingSeek = window._jumpOffset;
    window._jumpOffset = null;
  }

  // Reset the "Frame at" readout; it's refreshed once the video loads
  // (onloadedmetadata seeks to _pendingSeek or 0, then timeupdate updates it).
  if (dom.frameTimeValue) dom.frameTimeValue.textContent = "0:00";

  // Sync per-item social option visibility (captions availability, vertical)
  // — also resets _captionsEnabled for subtitle-less movies. The range/readout/
  // download-button render is owned by initMobileDetail → _mobRender below.
  updateSocialToggles();

  // Init the unified mark-from-playhead editor (both viewports)
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
  cancelClipPolling();
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
  selectItem(session.media_id);
}

async function quickClip() {
  // Clip 30s directly from the current session
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
  _pendingSeek = null;

  if (!dom.previewVideo) return;
  var vid = dom.previewVideo;

  // Reset the box to the CSS placeholder ratio (16:9 on desktop) until the
  // movie's own aspect ratio is known — see onloadedmetadata below.
  vid.style.aspectRatio = "";

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
    // Hug the movie's native aspect ratio so widescreen films use the full
    // player width instead of letterboxing inside a fixed 16:9 box. Before
    // metadata the box sits at the CSS placeholder ratio.
    if (vid.videoWidth && vid.videoHeight) {
      vid.style.aspectRatio = vid.videoWidth + " / " + vid.videoHeight;
    }
    vid.currentTime = (_pendingSeek != null) ? _pendingSeek : _sliderStart;
    _pendingSeek = null;
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
    // Caption-line selection panel (self-hides when no subtitles exist)
    loadCaptionLines(mediaId);
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
    // Keep the timeline's playhead marker on the nearest thumbnail
    updateStripPosition();
    // Loop within clip range when playing a clip preview. The range test
    // matters: with loop armed and no edges marked (_sliderEnd === 0) every
    // timeupdate sought to 0 and playback was pinned in the first frames.
    if (_loopPlayback && _sliderEnd > _sliderStart && ct >= _sliderEnd) {
      vid.currentTime = _sliderStart;
    }
  };

  vid.src = "api/media/" + mediaId + "/stream";
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
  if (vid.readyState < 1) {
    // No metadata yet — remember the intent and start once the stream
    // delivers enough data (canplay/seeked fire after the load).
    _loopPlayback = true;
    if (dom.clipStatus) dom.clipStatus.textContent = "Video still loading...";
    _armLoopWhenReady(vid);
    return;
  }

  if (!vid.paused && _loopPlayback) {
    // Already playing clip — pause
    _loopPlayback = false;
    vid.pause();
    return;
  }

  _loopPlayback = true;
  _startLoopPlayback(vid);
}

/** Seek to the range start and play; loop intent is _loopPlayback. */
function _startLoopPlayback(vid) {
  vid.currentTime = _sliderStart;
  if (dom.clipStatus) dom.clipStatus.textContent = "";
  var promise = vid.play();
  if (promise) {
    promise.catch(function(err) {
      _loopPlayback = false;
      if (dom.clipStatus) dom.clipStatus.textContent = "Playback failed: " + (err.message || "unknown error");
    });
  }
}

/** Start looping the range as soon as the stream delivers data at it.
 *  A seek on mobile drops readyState to 1 (metadata only) while the new
 *  position buffers, so playClip arms this instead of bailing. */
function _armLoopWhenReady(vid) {
  var started = false;
  var tryStart = function() {
    if (started || vid.readyState < 2 || !_loopPlayback || !vid.paused) return;
    started = true;
    vid.removeEventListener("canplay", tryStart);
    vid.removeEventListener("seeked", tryStart);
    _startLoopPlayback(vid);
  };
  vid.addEventListener("canplay", tryStart);
  vid.addEventListener("seeked", tryStart);
}


// ── Scrubber Controls (frame strip) ───────────────────────────────────

var _stripThumbs = [];  // [{time, el}]

function buildFrameStrip(mediaId, durationS) {
  if (!dom.frameStrip || !dom.frameStripInner) return;
  _stripThumbs = [];

  // Each frame is a real random seek into a multi-GB file on the spinning
  // media drive (~1.3s cold, more while Plex is streaming from the same
  // platter). The strip is navigation only, so keep it lean: 16 thumbnails
  // meant ~20s of disk work before the last one landed. Cached frames are
  // free on revisits, which is why this can stay small and still be useful.
  var count = durationS < 600 ? 4 : durationS < 3600 ? 6 : 8;
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
var _stripTouchOrigin = null;   // {x, y, t} of the touchstart, to tell tap from pan
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
    if (btn) {
      btn.classList.add("active");
      btn.setAttribute("aria-expanded", "true");
    }
  } else {
    if (dom.frameStrip) dom.frameStrip.style.display = "none";
    if (btn) {
      btn.classList.remove("active");
      btn.setAttribute("aria-expanded", "false");
    }
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
    var t0 = e.touches && e.touches[0];
    _stripTouchOrigin = t0 ? { x: t0.clientX, y: t0.clientY, t: Date.now() } : null;
    // No seek here — a pan/scroll is browsing, not scrubbing. Seek on tap.
  }, { passive: true });

  dom.frameStripInner.addEventListener("touchend", function(e) {
    _lastTouchEndTime = Date.now();
    var origin = _stripTouchOrigin;
    _stripTouchOrigin = null;
    if (_stripClickTime == null) return;
    var t = _stripClickTime;
    _stripClickTime = null;
    // iOS Safari does not reliably fire touchcancel for a scroll that starts
    // inside the strip, so decide tap-vs-pan here: a finger that moved, or that
    // rested for a while, was scrolling rather than tapping a frame.
    if (origin) {
      var end = e.changedTouches && e.changedTouches[0];
      var dx = end ? Math.abs(end.clientX - origin.x) : 0;
      var dy = end ? Math.abs(end.clientY - origin.y) : 0;
      if (dx > 12 || dy > 12 || Date.now() - origin.t > 600) return;
    }
    seekVideoTo(t);  // move the playhead to the tapped frame
  }, { passive: true });

  // The browser claimed the gesture (pan/scroll) — cancel any pending tap.
  dom.frameStripInner.addEventListener("touchcancel", function() {
    _stripClickTime = null;
  }, { passive: true });
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

// Highlight the thumbnail nearest the playhead (white ring = where the
// playhead is now, distinct from gold = the selected clip range).
function updateStripPosition() {
  if (!dom.frameStrip || dom.frameStrip.style.display === "none") return;
  if (!dom.frameStripInner || !_stripThumbs || !_stripThumbs.length) return;
  var ct = dom.previewVideo ? dom.previewVideo.currentTime : _sliderStart;
  var best = 0;
  var bestD = Infinity;
  for (var i = 0; i < _stripThumbs.length; i++) {
    var d = Math.abs(_stripThumbs[i].time - ct);
    if (d < bestD) { bestD = d; best = i; }
  }
  for (var j = 0; j < _stripThumbs.length; j++) {
    if (j === best) _stripThumbs[j].el.classList.add("current");
    else _stripThumbs[j].el.classList.remove("current");
  }
}


function updateTimeDisplay() {
  // Enforce constraints FIRST, then display.
  // There is no maximum clip length — the only gate is MIN_CLIP_SECONDS at the
  // bottom end. Marking Start alone seeds a 1s range here, which is what makes
  // Download armable after one tap.
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
  // The unified editor renderer owns the button (label + disabled state) so
  // the three writers that used to disagree on wording cannot drift apart.
  if (typeof _mobRender === "function" && typeof _mobLast !== "undefined" && _mobLast) {
    _mobRender();
    return;
  }
  if (!clipRangeReady()) {
    dom.btnDownload.disabled = true;
    dom.btnDownload.textContent = "⚠ Set a clip range";
  } else {
    dom.btnDownload.disabled = false;
    var label = "⬇ Set Clip";
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
    if (_clipFormat === "gif") parts.push("gif");
    if (parts.length) label = "⬇ Set Clip (" + parts.join(" + ") + ")";
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

function setFormat(fmt) {
  if (fmt !== "gif") fmt = "mp4";
  _clipFormat = fmt;
  updateToggleButtons();
}

function updateToggleButtons() {
  // Sync the unified editor's option checkboxes
  var mcc = document.getElementById("mob-chk-captions");
  if (mcc) mcc.checked = _captionsEnabled;
  var mcv = document.getElementById("mob-chk-vertical");
  if (mcv) mcv.checked = _verticalEnabled;
  // Sync the format segmented control (MP4 | GIF)
  var fmtBtns = document.querySelectorAll(".mob-format-btn");
  for (var fi = 0; fi < fmtBtns.length; fi++) {
    fmtBtns[fi].classList.toggle("active", fmtBtns[fi].getAttribute("data-format") === _clipFormat);
  }
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

// ── Caption-line selection (tap a line to clip it) ────────────────────

var _captionLines = [];
var _filteredIdx = [];   // full-array indices currently shown (search filter)
var _activeLineIdx = -1;
var _lineSelectionAnchor = -1;
var _selectedLineStart = -1;
var _selectedLineEnd = -1;

/** Fetch parsed subtitle lines once per media load; render the Lines panel. */
function loadCaptionLines(mediaId) {
  var panel = document.getElementById("mob-lines");
  var list = document.getElementById("mob-lines-list");
  var search = document.getElementById("mob-lines-search");
  var count = document.getElementById("mob-lines-count");
  var empty = document.getElementById("mob-lines-empty");
  _captionLines = [];
  _filteredIdx = [];
  _activeLineIdx = -1;
  _lineSelectionAnchor = -1;
  _selectedLineStart = -1;
  _selectedLineEnd = -1;
  if (search) search.value = "";
  if (count) count.textContent = "";
  if (empty) empty.style.display = "none";
  if (!panel || !list) return;
  if (!(state.currentItem && state.currentItem.subtitle_path)) {
    panel.style.display = "none";
    list.innerHTML = "";
    __pendingQuote = null;
    return;
  }
  fetch("api/subtitle/lines/" + mediaId)
    .then(function(r) { return r.ok ? r.json() : { lines: [] }; })
    .then(function(data) {
      // Ignore a slow response for a film the user has already left.
      if (!state.currentItem ||
          (state.currentItem.media_id || state.currentItem.id) !== mediaId) return;
      _captionLines = data.lines || [];
      if (!_captionLines.length) {
        panel.style.display = "none";
        list.innerHTML = "";
        __pendingQuote = null;
        return;
      }
      for (var i = 0; i < _captionLines.length; i++) _filteredIdx.push(i);
      _renderLineList();
      panel.style.display = "";
      // A quote-search tap hands us the exact line to mark once loaded.
      if (__pendingQuote && __pendingQuote.media_id === mediaId) {
        var pq = __pendingQuote;
        __pendingQuote = null;
        var best = -1;
        for (var k = 0; k < _captionLines.length; k++) {
          if (Math.abs(_captionLines[k].start - pq.start) < 0.3 &&
              Math.abs(_captionLines[k].end - pq.end) < 0.3) { best = k; break; }
        }
        if (best < 0) {
          var bestDist = Infinity;
          for (var j = 0; j < _captionLines.length; j++) {
            var d = Math.abs(_captionLines[j].start - pq.start);
            if (d < bestDist) { bestDist = d; best = j; }
          }
        }
        if (best >= 0) selectCaptionLine(best);
      }
    })
    .catch(function() {
      panel.style.display = "none";
      list.innerHTML = "";
      __pendingQuote = null;
    });
}

/** Rebuild the visible line buttons from _filteredIdx (search-aware). */
function _renderLineList() {
  var list = document.getElementById("mob-lines-list");
  if (!list) return;
  list.innerHTML = "";
  for (var i = 0; i < _filteredIdx.length; i++) {
    (function(fullIdx) {
      var line = _captionLines[fullIdx];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mob-line-btn";
      btn.dataset.idx = fullIdx;
      btn.title = fmtTime(Math.floor(line.start)) + " - " + fmtTime(Math.ceil(line.end));
      btn.innerHTML = "<span class=\"mob-line-time\">" + fmtTime(Math.floor(line.start)) + "</span>"
        + "<span class=\"mob-line-text\">" + escHtml(line.text) + "</span>";
      btn.addEventListener("click", function(e) { selectCaptionLine(fullIdx, e); });
      btn.addEventListener("dblclick", function() { dblSelectCaptionLine(fullIdx); });
      list.appendChild(btn);
    })(_filteredIdx[i]);
  }
  // Re-apply the active highlight to the rebuilt DOM (if the line is visible)
  if (_activeLineIdx >= 0) {
    var act = list.querySelector(".mob-line-btn[data-idx=\"" + _activeLineIdx + "\"]");
    if (act) act.classList.add("active");
  }
  _renderSelectedLines();
}

/** Search filter (wired to the Lines panel input via oninput). */
function mobFilterLines(q) {
  var empty = document.getElementById("mob-lines-empty");
  var count = document.getElementById("mob-lines-count");
  var query = (q || "").trim().toLowerCase();
  _filteredIdx = [];
  if (!query) {
    for (var i = 0; i < _captionLines.length; i++) _filteredIdx.push(i);
  } else {
    for (var j = 0; j < _captionLines.length; j++) {
      if (_captionLines[j].text.toLowerCase().indexOf(query) !== -1) _filteredIdx.push(j);
    }
  }
  _renderLineList();
  if (count) count.textContent = query ? _filteredIdx.length + " / " + _captionLines.length : "";
  if (empty) empty.style.display = (query && !_filteredIdx.length) ? "block" : "none";
}

/** Click a line to select it; Shift-click extends from the selection anchor. */
function selectCaptionLine(idx, event) {
  var line = _captionLines[idx];
  if (!line) return;
  var extend = !!(event && event.shiftKey && _lineSelectionAnchor >= 0);
  if (!extend) _lineSelectionAnchor = idx;
  var first = extend ? Math.min(_lineSelectionAnchor, idx) : idx;
  var last = extend ? Math.max(_lineSelectionAnchor, idx) : idx;
  var firstLine = _captionLines[first];
  var lastLine = _captionLines[last];
  // Deactivate any duration preset chip — the line defines the range now.
  if (typeof _mobActivePreset !== "undefined") _mobActivePreset = 0;
  if (typeof mobMarkStartAt === "function") mobMarkStartAt(firstLine.start);
  if (typeof mobMarkEndAt === "function") mobMarkEndAt(lastLine.end);
  seekVideoTo(firstLine.start);
  // A line clip is a caption clip — arm the burn checkbox (user can uncheck).
  if (!_captionsEnabled) {
    _captionsEnabled = true;
    updateToggleButtons();
  }
  var panel = document.getElementById("mob-lines");
  if (panel && !panel.open) panel.open = true;
  _selectedLineStart = first;
  _selectedLineEnd = last;
  _renderSelectedLines();
  _setActiveLine(idx, true);
  if (typeof _mobRender === "function") _mobRender();
}

/** Double-click a line: select it, force loop playback, jump to the video. */
function dblSelectCaptionLine(idx) {
  selectCaptionLine(idx);
  // Loop must turn ON even if already looping — playClip toggles, so pause
  // first to leave its toggle state on the "off" side.
  var vid = document.getElementById("preview-video");
  if (vid && !vid.paused) vid.pause();
  if (typeof mobLoop === "function") mobLoop();
  // Bring the video (top of the page) into view.
  if (vid && vid.scrollIntoView) {
    vid.scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    var mainEl = document.getElementById("main");
    if (mainEl) mainEl.scrollTop = 0;
  }
}

/** Show every dialogue line included in the current contiguous clip range. */
function _renderSelectedLines() {
  var list = document.getElementById("mob-lines-list");
  if (!list) return;
  var buttons = list.querySelectorAll(".mob-line-btn");
  for (var i = 0; i < buttons.length; i++) {
    var idx = parseInt(buttons[i].dataset.idx, 10);
    buttons[i].classList.toggle("selected",
      _selectedLineStart >= 0 && idx >= _selectedLineStart && idx <= _selectedLineEnd);
  }
}

/** Highlight the active line; scroll=true only for explicit taps. */
function _setActiveLine(idx, scroll) {
  var list = document.getElementById("mob-lines-list");
  if (!list) return;
  if (idx === _activeLineIdx) {
    if (scroll && idx >= 0) _scrollLineIntoView(idx);
    return;
  }
  var prev = _activeLineIdx;
  _activeLineIdx = idx;
  var prevEl = (prev >= 0) ? list.querySelector(".mob-line-btn[data-idx=\"" + prev + "\"]") : null;
  if (prevEl) prevEl.classList.remove("active");
  if (idx >= 0) {
    var el = list.querySelector(".mob-line-btn[data-idx=\"" + idx + "\"]");
    if (el) {
      el.classList.add("active");
      if (scroll) _scrollLineIntoView(idx);
    }
  }
}

function _scrollLineIntoView(idx) {
  var list = document.getElementById("mob-lines-list");
  if (!list) return;
  var el = list.querySelector(".mob-line-btn[data-idx=\"" + idx + "\"]");
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

/** Binary search: last line whose start <= t, and end >= t. */
function _findLineAt(t) {
  var lo = 0, hi = _captionLines.length - 1, found = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (_captionLines[mid].start <= t) { found = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (found >= 0 && _captionLines[found].end >= t) return found;
  return -1;
}

// ── Quote search (subtitle lines across the whole library) ────────────

var _searchMode = "title";
var _quoteTimer = null;
var _lastQuoteQuery = "";
var __pendingQuote = null;   // {media_id, start, end} handed to loadCaptionLines

function setSearchMode(mode) {
  if (mode !== "quote") mode = "title";
  _searchMode = mode;
  var btns = document.querySelectorAll(".search-mode-btn");
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle("active", btns[i].dataset.mode === mode);
  }
  var sort = document.getElementById("sort-by");
  var s = dom.search;
  if (mode === "quote") {
    if (s) s.placeholder = "Search lines in every movie...";
    if (sort) sort.style.display = "none";
    runQuoteSearch(s ? s.value : "");
  } else {
    if (s) s.placeholder = "Search library...";
    if (sort) sort.style.display = "";
    hideQuoteResults();
    renderLibrary(s ? s.value : "");
  }
}

function hideQuoteResults() {
  var box = document.getElementById("quote-results");
  if (box) box.style.display = "none";
  if (dom.libraryGrid) dom.libraryGrid.style.display = "";
  if (dom.emptyState) dom.emptyState.style.display = "none";
}

function runQuoteSearch(q) {
  _lastQuoteQuery = (q || "").trim();
  clearTimeout(_quoteTimer);
  _quoteTimer = setTimeout(function() { fetchQuoteResults(_lastQuoteQuery); }, 250);
}

function fetchQuoteResults(query) {
  var box = document.getElementById("quote-results");
  if (!box) return;
  if (!query) { hideQuoteResults(); return; }
  if (dom.libraryGrid) dom.libraryGrid.style.display = "none";
  if (dom.emptyState) dom.emptyState.style.display = "none";
  box.style.display = "block";
  box.innerHTML = "<div class='quote-status'>Searching lines...</div>";
  fetch("api/quotes?q=" + encodeURIComponent(query))
    .then(function(r) { return r.ok ? r.json() : { matches: [] }; })
    .then(function(data) {
      if (_lastQuoteQuery !== query) return;   // stale response
      renderQuoteResults(box, data.matches || [], query, !!data.truncated);
    })
    .catch(function() {
      if (_lastQuoteQuery !== query) return;
      box.innerHTML = "<div class='empty-state'><div class='empty-text'>Search failed</div><div class='empty-sub'>Is Plex reachable?</div></div>";
    });
}

function renderQuoteResults(box, matches, query, truncated) {
  box.style.display = "block";
  if (!matches.length) {
    box.innerHTML = "<div class='empty-state'><div class='empty-text'>No lines match \"" + escHtml(query) + "\"</div>"
      + "<div class='empty-sub'>Lines mode searches subtitle text in every movie.</div></div>";
    return;
  }
  var note = truncated
    ? " <span class='quote-note'>(first " + matches.length + " — refine your search)</span>"
    : "";
  var html = "<div class='results-header'>Lines matching \"" + escHtml(query) + "\" <span class='result-count'>" + matches.length + "</span>" + note + "</div>"
    + "<div class='quote-grid'>";
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    html += "<div class='quote-card' data-mid='" + m.media_id + "' data-start='" + m.start + "' data-end='" + m.end + "' onclick='openQuoteMatch(this)'>"
      + "<img class='quote-thumb' src='api/thumb/" + m.media_id + "' alt='' loading='lazy'>"
      + "<div class='quote-body'>"
      + "<div class='quote-title'>" + escHtml(m.title) + (m.year ? " <span class='quote-year'>" + escHtml(m.year) + "</span>" : "") + "</div>"
      + "<div class='quote-time'>" + fmtTime(Math.floor(m.start)) + "</div>"
      + "<div class='quote-text'>" + escHtml(m.text) + "</div>"
      + "</div></div>";
  }
  html += "</div>";
  box.innerHTML = html;
}

function openQuoteMatch(el) {
  var mid = parseInt(el.getAttribute("data-mid"), 10);
  var start = parseFloat(el.getAttribute("data-start"));
  var end = parseFloat(el.getAttribute("data-end"));
  if (!mid || isNaN(start) || isNaN(end)) return;
  // Hand the exact line to the detail view; loadCaptionLines applies it
  // once that movie's lines are fetched.
  __pendingQuote = { media_id: mid, start: start, end: end };
  selectItem(mid);
}

// ── Clip Download ──────────────────────────────────────────────────────

var _clipPollTimer = null;
var _clipPollCancel = null;   // rejects the in-flight poll (set by pollClipStatus)

/** Stop any in-flight clip status polling. Called when leaving the detail view. */
function cancelClipPolling() {
  if (_clipPollTimer) {
    clearTimeout(_clipPollTimer);
    _clipPollTimer = null;
  }
  if (typeof _clipPollCancel === "function") {
    var cancel = _clipPollCancel;
    _clipPollCancel = null;
    cancel();
  }
}

var _clipInFlight = false;

async function downloadClip() {
  if (!dom) return;

  // Re-entrancy guard: Enter bypassed the disabled button, and two runs shared
  // one poll handle — whichever settled first cleared the other's timer, so the
  // second export was stranded with no error.
  if (_clipInFlight) return;

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

  // Same predicate as the button, so Enter and any programmatic caller cannot
  // post a range the UI itself refuses (the backend answers 400 instead).
  if (!clipRangeReady()) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Set a clip range of at least " + MIN_CLIP_SECONDS + "s";
    return;
  }

  _clipInFlight = true;
  if (dom.btnDownload) { dom.btnDownload.disabled = true; dom.btnDownload.textContent = "Clipping..."; }
  if (dom.clipStatus) dom.clipStatus.textContent = "";
  // Progress UI (unified #mob-clip-progress* — dom.clipProgress* re-point there)
  if (dom.clipProgress) dom.clipProgress.style.display = "block";
  if (dom.clipProgressFill) dom.clipProgressFill.style.width = "0%";
  if (dom.clipProgressText) dom.clipProgressText.textContent = "Starting " + (_clipFormat === "gif" ? "GIF " : "clip ") + fmtTime(startSec) + "-" + fmtTime(endSec) + "...";

  try {
    // 1) Start clip generation (returns immediately)
    var startResp = await fetch("api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId, start_sec: startSec, end_sec: endSec, captions: _captionsEnabled, vertical: _verticalEnabled, caption_color: _captionColor, caption_position: _captionPosition, format: _clipFormat }),
    });

    if (!startResp.ok) {
      var errData = await startResp.json().catch(function() { return {}; });
      throw new Error(errData.detail || "HTTP " + startResp.status);
    }

    var startData = await startResp.json();
    var filename = startData.filename;

    // 2) Poll until done
    var result = await pollClipStatus(filename);

    // 3) Download — unless the user left the detail view meanwhile (the clip is
    // still in the gallery, but nothing should pop up unprompted).
    if (!state.currentItem || (state.currentItem.media_id || state.currentItem.id) !== mediaId) {
      return;
    }
    if (result.done && !result.error) {
      var a = document.createElement("a");
      a.href = "api/download/" + encodeURIComponent(filename);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      if (dom.clipStatus) dom.clipStatus.textContent = "Downloaded " + filename + " (" + Math.round(endSec - startSec) + "s)";
      loadClipGallery();
    } else {
      throw new Error(result.error || "Unknown error");
    }
  } catch (err) {
    if (err && err.message === "Clip polling cancelled") return;
    if (dom.clipStatus) dom.clipStatus.textContent = "Error: " + err.message;
  } finally {
    _clipInFlight = false;
    if (dom.clipProgress) dom.clipProgress.style.display = "none";
    // Let the single renderer restore the button (label + disabled state) —
    // hard-coding a label here is what left it stale after every export.
    updateDownloadButton();
  }
}

function pollClipStatus(filename) {
  return new Promise(function(resolve, reject) {
    var maxPolls = 300;
    var polls = 0;
    var settled = false;

    function settle(err, value) {
      if (settled) return;
      settled = true;
      _clipPollCancel = null;
      if (_clipPollTimer) { clearTimeout(_clipPollTimer); _clipPollTimer = null; }
      if (err) reject(err); else resolve(value);
    }

    // Leaving the detail view must not leave this chain running: it used to
    // keep polling for 10 minutes and then fire a download from a hidden view.
    _clipPollCancel = function() { settle(new Error("Clip polling cancelled")); };

    function poll() {
      polls++;
      if (polls > maxPolls) { settle(new Error("Clip generation timed out")); return; }

      fetch("api/clip/status/" + encodeURIComponent(filename))
        .then(function(resp) { return resp.json(); })
        .then(function(status) {
          if (status.error) { settle(new Error(status.error)); return; }

          if (status.done) {
            // Done — resolve with the result
            if (dom.clipProgressFill) dom.clipProgressFill.style.width = "100%";
            if (dom.clipProgressText) dom.clipProgressText.textContent = "Done!";
            settle(null, { done: true, error: null, filename: filename });
            return;
          }

          // Update progress
          var pct = Math.round(status.progress * 100);
          var text = "Encoding " + (_clipFormat === "gif" ? "GIF" : "clip") + "... " + pct + "%";
          if (status.eta_seconds != null && status.eta_seconds > 0) {
            var mins = Math.floor(status.eta_seconds / 60);
            var secs = status.eta_seconds % 60;
            text += " (ETA " + mins + "m " + secs + "s)";
          }
          if (dom.clipProgressFill) dom.clipProgressFill.style.width = pct + "%";
          if (dom.clipProgressText) dom.clipProgressText.textContent = text;

          // Poll again
          if (!settled) _clipPollTimer = setTimeout(poll, 2000);
        })
        .catch(function(err) { settle(err); });
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
      var isGif = c.filename.slice(-4).toLowerCase() === ".gif";
      // Tap-to-load placeholder. Rendering a <video preload="metadata"> (or a
      // full <img> for a GIF) per clip made opening the gallery fire one
      // request per file — 62 clips / 1.6GB — and every one of those is a
      // seek into the clips directory. Only load the media the user asks for.
      html += '<div class="clip-card">' +
        '<button type="button" class="clip-placeholder" data-clip="' + escAttr(c.filename) + '" data-gif="' + (isGif ? "1" : "0") + '">' +
          '<span class="clip-placeholder-play">▶</span>' +
          '<span class="clip-placeholder-hint">tap to load ' + sizeMB + 'MB</span>' +
        '</button>' +
        '<div class="clip-card-info">' +
          '<span class="clip-card-name" title="' + escAttr(c.filename) + '">' + escHtml(c.filename) + ' (' + sizeMB + 'MB)</span>' +
          '<div class="clip-card-actions">' +
            '<a class="btn btn-small" href="api/download/' + encodeURIComponent(c.filename) + '" download>DL</a>' +
            '<button type="button" class="btn btn-small btn-del" data-del="' + escAttr(c.filename) + '" aria-label="Delete clip">✕</button>' +
          '</div>' +
        '</div></div>';
    }
    if (dom.clipGalleryGrid) {
      dom.clipGalleryGrid.innerHTML = html;
      bindClipPlaceholders();
    }
  } catch (err) {
    // Silently fail — gallery is optional
  }
}

/**
 * Wire the tap-to-load placeholders in the clips gallery.
 *
 * Each placeholder swaps itself for the real <video>/<img> on first tap, so
 * opening the gallery costs zero media requests regardless of how many clips
 * have accumulated.
 */
function bindClipPlaceholders() {
  if (!dom.clipGalleryGrid) return;
  var nodes = dom.clipGalleryGrid.querySelectorAll(".clip-placeholder");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].addEventListener("click", function() {
      var name = this.getAttribute("data-clip");
      var isGif = this.getAttribute("data-gif") === "1";
      var src = "api/download/" + encodeURIComponent(name);
      var el = document.createElement(isGif ? "img" : "video");
      el.src = src;
      if (isGif) {
        el.className = "clip-gif";
        el.alt = "";
      } else {
        el.controls = true;
        el.preload = "metadata";
        el.addEventListener("loadedmetadata", function() { this.play().catch(function() {}); });
      }
      this.replaceWith(el);
    });
  }
  // Delete is wired here instead of an inline onclick: the filename came
  // straight from the API into a JS string literal, so a hand-placed file with
  // a quote in its name could break the markup and the handler.
  var dels = dom.clipGalleryGrid.querySelectorAll("[data-del]");
  for (var j = 0; j < dels.length; j++) {
    dels[j].addEventListener("click", function() {
      // Two steps: this button sits next to Download and the action is
      // irreversible, so a single mis-tap must not destroy an export.
      var btn = this;
      if (btn.getAttribute("data-confirm") !== "1") {
        btn.setAttribute("data-confirm", "1");
        btn.textContent = "Delete?";
        btn.classList.add("btn-del-confirm");
        setTimeout(function() {
          if (!document.body.contains(btn)) return;
          btn.removeAttribute("data-confirm");
          btn.textContent = "✕";
          btn.classList.remove("btn-del-confirm");
        }, 4000);
        return;
      }
      deleteClip(btn.getAttribute("data-del"));
    });
  }
}

async function deleteClip(filename) {
  var note = document.getElementById("clip-gallery-note") || (dom && dom.clipStatus);
  try {
    var resp = await fetch("api/clips/" + encodeURIComponent(filename), { method: "DELETE" });
    if (!resp.ok) {
      // A rejected delete used to look identical to a successful one.
      if (note) note.textContent = "Delete failed (HTTP " + resp.status + ")";
      return;
    }
  } catch (e) {
    if (note) note.textContent = "Delete failed: " + e.message;
    return;
  }
  loadClipGallery();
}

// ── Utilities ──────────────────────────────────────────────────────────

function showClipShortcut() {
  var link = document.getElementById("clip-shortcut-link");
  if (link) link.style.display = "inline-block";
}



// ── Event Wiring ───────────────────────────────────────────────────────

function init() {
  // Idempotent: boot and the Plex PIN poll can both call init(), and a second
  // run rebound every document listener and leaked a second session-poll
  // interval (its handle overwrote the first, so the old timer never stopped).
  if (window.__scenesterInit) return;
  window.__scenesterInit = true;

  dom = getDom();

  // ── SPA history: keep back-swipe / back-button INSIDE the app ──
  // Scenester is a single page with JS-swapped views. Without history
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

  // Search (Titles mode filters the grid; Lines mode searches subtitles)
  if (dom.search) dom.search.addEventListener("input", function() {
    if (_searchMode === "quote") {
      runQuoteSearch(dom.search.value);
    } else {
      renderLibrary(dom.search.value);
      hideQuoteResults();
    }
  });

  // Sort
  var sortSelect = qs("#sort-by");
  if (sortSelect) {
    sortSelect.addEventListener("change", function() {
      currentSort = sortSelect.value;
      renderLibrary(dom.search ? dom.search.value : "");
    });
  }

  // Download clip is wired via onclick="mobDownload()" in HTML (mobDownload
  // calls downloadClip) — no addEventListener here or every click fires twice.

  // Frame strip drag-to-select
  initStripDrag();

  // The compact editor panels behave as one dropdown group: opening one
  // closes any sibling that is already open. The native <details> behavior
  // still handles toggling the selected panel itself.
  var collapseRow = qs(".collapse-row");
  if (collapseRow) {
    collapseRow.addEventListener("toggle", function(e) {
      var opened = e.target;
      if (!opened.matches("details") || !opened.open) return;
      var panels = collapseRow.querySelectorAll(":scope > details[open]");
      for (var i = 0; i < panels.length; i++) {
        if (panels[i] !== opened) panels[i].open = false;
      }
    }, true);
  }

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
    if (e.key === " ") { if (e.target.tagName === "BUTTON") return; e.preventDefault(); var vid = dom.previewVideo; if (vid) { if (vid.paused) vid.play(); else vid.pause(); } return; }

    var start = _sliderStart;
    var step = e.shiftKey ? 10 : 1;
    var isEnd = e.altKey;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isEnd) {
        var ne = Math.max(_sliderStart + 1, _sliderEnd - step);
        setSliderEnd(ne);
        _mobEndSet = true;
        _mobSyncBrowse();
        _mobRender();
        seekVideoTo(_sliderEnd);
      } else {
        var ns = Math.max(0, start - step);
        setSliderStart(ns);
        _mobStartSet = true;
        _mobSyncBrowse();
        _mobRender();
        seekVideoTo(_sliderStart);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (isEnd) {
        var ne = Math.min(state.mediaDuration, _sliderEnd + step);
        setSliderEnd(ne);
        _mobEndSet = true;
        _mobSyncBrowse();
        _mobRender();
        seekVideoTo(_sliderEnd);
      } else {
        var ns = Math.min(state.mediaDuration, start + step);
        setSliderStart(ns);
        _mobStartSet = true;
        _mobSyncBrowse();
        _mobRender();
        seekVideoTo(_sliderStart);
      }
    } else if (e.key === "Enter") {
      // Don't hijack Enter when it is activating a focused button/link — the
      // Space handler above already had this guard.
      if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return;
      e.preventDefault();
      if (!_clipInFlight) downloadClip();
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
  _authPollInFlight = false;
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
  // Double-tap created two PINs and leaked the first interval, which
  // stopPinPolling() could never clear.
  if (_authPollTimer) return;
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

var _authPollInFlight = false;

function pollPinStatus() {
  if (!_authPinId) return;
  // A slow plex.tv response (> the 2s interval) used to let two polls resolve
  // "done" and call init() twice.
  if (_authPollInFlight) return;
  _authPollInFlight = true;

  _authPollCount++;
  if (_authPollCount > MAX_PIN_POLLS) {
    _authPollInFlight = false;
    stopPinPolling();
    showLoginError("PIN expired. Please try again.");
    return;
  }

  fetch("api/auth/pin/" + _authPinId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Release the in-flight guard before branching: the terminal branches
      // return via stopPinPolling(), and a swallowed flag would kill polling
      // for good after a single slow response.
      _authPollInFlight = false;
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
      // Backend error during poll — release the guard and keep trying
      _authPollInFlight = false;
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
