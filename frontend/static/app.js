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
    // Frame preview
    framePreview:    qs("#frame-preview"),
    frameImg:        qs("#frame-img"),
    frameTimeValue:  qs("#frame-time-value"),
    frameOverlay:    qs("#frame-overlay"),
    frameStrip:      qs("#frame-strip"),
    frameStripInner: qs("#frame-strip-inner"),
    rangeStart:   qs("#range-start"),
    rangeEnd:     qs("#range-end"),
    timeStart:    qs("#time-start"),
    timeEnd:      qs("#time-end"),
    timeDuration: qs("#time-duration"),
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

  // Show frame preview + scrubber immediately
  if (dom.framePreview) dom.framePreview.style.display = "block";
  if (dom.clipProgress) dom.clipProgress.style.display = "none";
  if (dom.clipStatus) dom.clipStatus.textContent = "";

  // Build frame strip
  var mediaId = item.media_id || item.id;
  buildFrameStrip(mediaId, durationS);

  if (dom.rangeStart) dom.rangeStart.max = Math.floor(durationS);
  if (dom.rangeEnd) dom.rangeEnd.max = Math.floor(durationS);

  // Handle jump-to-clip offset from session banner
  if (window._jumpOffset != null) {
    var offset = window._jumpOffset;
    var start = Math.max(0, offset - 5);
    var end = Math.min(durationS, offset + 25);
    if (dom.rangeStart) dom.rangeStart.value = Math.floor(start);
    if (dom.rangeEnd) dom.rangeEnd.value = Math.floor(end);
    window._jumpOffset = null;
    window._jumpDuration = null;
  } else {
    if (dom.rangeStart) dom.rangeStart.value = 0;
    if (dom.rangeEnd) dom.rangeEnd.value = Math.min(30, Math.floor(durationS));
  }

  updateTimeDisplay();
  if (dom.btnDownload) dom.btnDownload.disabled = false;

  // Load first frame
  var startVal = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  showFrame(startVal);
}

function goBack() {
  if (dom.detailView) dom.detailView.style.display = "none";
  if (dom.libraryView) dom.libraryView.style.display = "block";
  if (dom.framePreview) dom.framePreview.style.display = "none";
  state.currentItem = null;
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

// ── Scrubber Controls ──────────────────────────────────────────────────

var _frameTimer = null;
var _stripThumbs = [];  // [{time, el}]

function buildFrameStrip(mediaId, durationS) {
  if (!dom.frameStrip || !dom.frameStripInner) return;
  _stripThumbs = [];

  var count = 12;
  var html = "";
  for (var i = 0; i < count; i++) {
    var t = Math.floor((durationS / (count - 1)) * i);
    html += '<div class="frame-thumb" data-time="' + t + '" onclick="jumpToFrame(' + t + ')">' +
            '<img src="api/frame/' + mediaId + '?t=' + t + '" loading="lazy" />' +
            '<span class="frame-thumb-time">' + fmtTime(t) + '</span></div>';
  }
  dom.frameStripInner.innerHTML = html;
  dom.frameStrip.style.display = "block";

  // Cache elements
  var thumbs = dom.frameStripInner.querySelectorAll(".frame-thumb");
  for (var j = 0; j < thumbs.length; j++) {
    var t = parseInt(thumbs[j].getAttribute("data-time"));
    _stripThumbs.push({time: t, el: thumbs[j]});
  }
}

function jumpToFrame(t) {
  if (dom.rangeStart) dom.rangeStart.value = t;
  updateTimeDisplay();
  showFrame(t);
  highlightFrameStrip(t);
}

function highlightFrameStrip(currentT) {
  for (var i = 0; i < _stripThumbs.length; i++) {
    var t = _stripThumbs[i];
    var dist = Math.abs(t.time - currentT);
    if (dist < 3 || (i > 0 && currentT > _stripThumbs[i-1].time && currentT <= t.time)) {
      t.el.classList.add("active");
      // Scroll into view
      t.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    } else {
      t.el.classList.remove("active");
    }
  }
}

function showFrame(absoluteSec) {
  // Update the frame preview image to show the frame at this timestamp
  if (!state.currentItem) return;
  var mediaId = state.currentItem.media_id || state.currentItem.id;
  if (!mediaId) return;

  if (dom.frameTimeValue) dom.frameTimeValue.textContent = fmtTime(Math.floor(absoluteSec));

  // Show loading overlay
  if (dom.frameOverlay) dom.frameOverlay.style.display = "flex";

  var img = new Image();
  img.onload = function() {
    if (dom.frameImg) dom.frameImg.src = img.src;
    if (dom.frameOverlay) dom.frameOverlay.style.display = "none";
    highlightFrameStrip(absoluteSec);
  };
  img.onerror = function() {
    if (dom.frameOverlay) dom.frameOverlay.style.display = "none";
  };
  img.src = "api/frame/" + mediaId + "?t=" + absoluteSec;
}

// Debounced frame fetch during drag
function onRangeInput() {
  updateTimeDisplay();
  if (_frameTimer) clearTimeout(_frameTimer);
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  _frameTimer = setTimeout(function() { showFrame(start); }, 150);
}

// On release: fetch frame immediately
function onStartReleased() {
  updateTimeDisplay();
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  if (_frameTimer) clearTimeout(_frameTimer);
  showFrame(start);
}

function updateTimeDisplay() {
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  var end = parseInt(dom.rangeEnd ? dom.rangeEnd.value : 0) || 0;

  if (dom.timeStart) dom.timeStart.textContent = fmtTime(start);
  if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(end);
  if (dom.timeDuration) dom.timeDuration.textContent = "/ " + fmtTime(state.proxyDuration);

  if (end <= start && dom.rangeEnd) {
    dom.rangeEnd.value = start + 1;
    if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(start + 1);
  }
  if (end - start > 140 && dom.rangeEnd) {
    dom.rangeEnd.value = start + 140;
    if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(start + 140);
  }
  if (dom.rangeEnd && parseInt(dom.rangeEnd.value) > state.proxyDuration) {
    dom.rangeEnd.value = Math.floor(state.proxyDuration);
    if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(Math.floor(state.proxyDuration));
  }
  if (dom.rangeStart && parseInt(dom.rangeStart.value) > state.proxyDuration) {
    dom.rangeStart.value = Math.floor(state.proxyDuration);
    if (dom.timeStart) dom.timeStart.textContent = fmtTime(Math.floor(state.proxyDuration));
  }
}

// ── Preset Buttons ─────────────────────────────────────────────────────

function handlePreset(action, value) {
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;

  if (action === "shift-start") {
    var newStart = Math.max(0, start + value);
    if (dom.rangeStart) dom.rangeStart.value = newStart;
    var currentEnd = parseInt(dom.rangeEnd ? dom.rangeEnd.value : 0) || (start + 30);
    var dur = currentEnd - start;
    if (dom.rangeEnd) dom.rangeEnd.value = Math.min(state.proxyDuration, newStart + Math.max(1, dur));
    updateTimeDisplay();
    showFrame(newStart);
  } else if (action === "set-duration") {
    var newEnd = Math.min(state.proxyDuration, start + value);
    if (dom.rangeEnd) dom.rangeEnd.value = Math.floor(newEnd);
    updateTimeDisplay();
    showFrame(start);
  }
}

// ── Clip Download ──────────────────────────────────────────────────────

var _clipPollTimer = null;

async function downloadClip() {
  if (!state.currentItem) return;

  var mediaId = state.currentItem.media_id || state.currentItem.id;
  var startSec = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  var endSec = parseInt(dom.rangeEnd ? dom.rangeEnd.value : 0) || 0;

  if (endSec <= startSec) {
    if (dom.clipStatus) dom.clipStatus.textContent = "Invalid range — end must be after start";
    return;
  }

  // Hide old status, show progress bar
  if (dom.clipStatus) dom.clipStatus.textContent = "";
  if (dom.clipProgress) dom.clipProgress.style.display = "block";
  if (dom.clipProgressFill) dom.clipProgressFill.style.width = "0%";
  if (dom.clipProgressText) dom.clipProgressText.textContent = "Starting clip...";
  if (dom.btnDownload) { dom.btnDownload.disabled = true; dom.btnDownload.textContent = "Clipping..."; }

  var filename = null;

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

  // Range sliders: input = live display update, change = seek-on-release
  if (dom.rangeStart) {
    dom.rangeStart.addEventListener("input", onRangeInput);
    dom.rangeStart.addEventListener("change", onStartReleased);
  }
  if (dom.rangeEnd) {
    dom.rangeEnd.addEventListener("input", onRangeInput);
  }

  // Download clip
  if (dom.btnDownload) dom.btnDownload.addEventListener("click", downloadClip);

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

    var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
    var step = e.shiftKey ? 10 : 1;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      var ns = Math.max(0, start - step);
      if (dom.rangeStart) dom.rangeStart.value = ns;
      updateTimeDisplay();
      showFrame(ns);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      var ns = Math.min(state.proxyDuration, start + step);
      if (dom.rangeStart) dom.rangeStart.value = ns;
      updateTimeDisplay();
      showFrame(ns);
    } else if (e.key === "Enter") {
      e.preventDefault();
      downloadClip();
    }
  });

  // Load library
  loadLibrary();
  startSessionPolling();
}

// ── Boot ───────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
