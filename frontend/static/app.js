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
  proxyReady: false,
  proxyDuration: 0,     // seconds (full movie)
  proxyStartSec: 0,     // seconds into movie where proxy starts
  proxyEndSec: 0,       // seconds into movie where proxy ends (capped)
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
    btnGenProxy:  qs("#btn-generate-proxy"),
    btnBack:      qs("#btn-back"),
    nowPlaying:   qs("#now-playing"),
    npTitle:      qs("#np-title"),
    npTime:       qs("#np-time"),
    btnJumpClip:  qs("#btn-jump-clip"),
    proxyProgress: qs("#proxy-progress"),
    progressFill:  qs("#progress-fill"),
    progressText:  qs("#progress-text"),
    proxyError:    qs("#proxy-error"),
    proxySection:  qs("#proxy-section"),
    proxyVideo:   qs("#proxy-video"),
    proxyInfo:        qs("#proxy-info"),
    proxyInfoText:    qs("#proxy-info-text"),
    proxyRegenStart:  qs("#proxy-regen-start"),
    btnRegenProxy:    qs("#btn-regenerate-proxy"),
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
    state.proxyReady = false;
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

  // Reset proxy state
  if (dom.proxySection) dom.proxySection.style.display = "none";
  if (dom.proxyProgress) dom.proxyProgress.style.display = "none";
  if (dom.proxyError) dom.proxyError.style.display = "none";
  if (dom.btnGenProxy) dom.btnGenProxy.style.display = "inline-flex";
  if (dom.btnDownload) dom.btnDownload.disabled = true;
  if (dom.clipStatus) dom.clipStatus.textContent = "";
  if (dom.clipProgress) dom.clipProgress.style.display = "none";
  state.proxyReady = false;
  state.proxyDuration = 0;
  state.proxyStartSec = 0;
  state.proxyEndSec = 0;
}

function goBack() {
  if (dom.detailView) dom.detailView.style.display = "none";
  if (dom.libraryView) dom.libraryView.style.display = "block";
  state.currentItem = null;
  renderLibrary(dom.search ? dom.search.value : "");
}

// ── Now Playing Banner ─────────────────────────────────────────────────

var sessionPollTimer = null;

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
      dom.nowPlaying.style.display = "block";
      if (dom.npTitle) dom.npTitle.textContent = paused.title;
      if (dom.npTime) dom.npTime.textContent = "at " + fmtTime(paused.viewOffset);
      if (dom.btnJumpClip) dom.btnJumpClip.onclick = function() { jumpToClip(paused); };
    } else if (dom.nowPlaying) {
      dom.nowPlaying.style.display = "none";
    }
  } catch (err) {
    // Silently fail — banner is optional
  }
}

function jumpToClip(session) {
  var durationS = session.duration / 1000;
  var viewOffset = session.viewOffset;

  selectItem(session.media_id).then(function() {
    window._jumpOffset = viewOffset;
    window._jumpDuration = durationS;
  });
}

function startSessionPolling() {
  pollSessions();
  sessionPollTimer = setInterval(pollSessions, 5000);
}

// ── Proxy Generation ───────────────────────────────────────────────────

async function generateProxy() {
  // Safety: if dom isn't initialized at all, show alert
  if (!dom) { alert("DOM not initialized — page may not have loaded fully. Please refresh."); return; }

  // Immediate visual feedback — changes button text instantly
  if (dom.btnGenProxy) {
    dom.btnGenProxy.textContent = "Working...";
    dom.btnGenProxy.disabled = true;
  }

  console.log("generateProxy called, currentItem:", state.currentItem);
  if (!state.currentItem) {
    if (dom.btnGenProxy) { dom.btnGenProxy.textContent = "Error: no item"; dom.btnGenProxy.disabled = false; }
    return;
  }

  var mediaId = state.currentItem.media_id || state.currentItem.id;
  console.log("mediaId:", mediaId);
  if (!mediaId) {
    if (dom.btnGenProxy) { dom.btnGenProxy.textContent = "Error: no media ID"; dom.btnGenProxy.disabled = false; }
    return;
  }

  console.log("Hiding button, showing progress...");
  if (dom.btnGenProxy) dom.btnGenProxy.style.display = "none";

  // Read start offset in minutes
  var startMin = parseInt(qs("#proxy-start") ? qs("#proxy-start").value : 0) || 0;
  state.proxyStartSec = startMin * 60;

  hideError();
  if (dom.proxySection) dom.proxySection.style.display = "none";
  if (dom.proxyProgress) dom.proxyProgress.style.display = "block";
  if (dom.progressFill) dom.progressFill.style.width = "0%";
  if (dom.progressText) dom.progressText.textContent = "Starting proxy generation...";

  try {
    var url = "api/proxy/" + mediaId;
    if (startMin > 0) url += "?start_min=" + startMin;
    var startResp = await fetch(url, { method: "POST" });
    if (!startResp.ok) {
      var errData = await startResp.json().catch(function() { return {}; });
      throw new Error(errData.detail || "HTTP " + startResp.status);
    }

    var startData = await startResp.json();

    // Show warning if movie was too long
    if (startData.warning) {
      dom.progressText.textContent = startData.warning + " " + dom.progressText.textContent;
    }

    await pollProxyStatus(mediaId);
  } catch (err) {
    if (dom.proxyProgress) dom.proxyProgress.style.display = "none";
    showError(err.message);
    if (dom.btnGenProxy) {
      dom.btnGenProxy.style.display = "inline-flex";
      dom.btnGenProxy.textContent = "Generate Preview";
      dom.btnGenProxy.disabled = false;
    }
  }
}

function showError(msg) {
  var banner = qs("#error-banner");
  var msgEl = qs("#error-message");
  if (banner) banner.style.display = "block";
  if (msgEl) msgEl.textContent = msg;
}

function hideError() {
  var banner = qs("#error-banner");
  if (banner) banner.style.display = "none";
}

async function pollProxyStatus(mediaId) {
  var maxPolls = 300;
  var polls = 0;

  while (polls < maxPolls) {
    await sleep(2000);
    polls++;

    try {
      var resp = await fetch("api/proxy/" + mediaId + "/status");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var status = await resp.json();

      if (status.error) throw new Error(status.error);

      if (status.done) {
        if (dom.proxyProgress) dom.proxyProgress.style.display = "none";
        if (dom.progressFill) dom.progressFill.style.width = "100%";
        if (dom.progressText) dom.progressText.textContent = "Done!";
        onProxyReady(mediaId);
        return;
      }
      // Update progress with ETA
      var pct = Math.round(status.progress * 100);
      var text = "Generating preview... " + pct + "%";
      if (status.eta_seconds != null && status.eta_seconds > 0) {
        var mins = Math.floor(status.eta_seconds / 60);
        var secs = status.eta_seconds % 60;
        text += " (ETA " + mins + "m " + secs + "s)";
      }
      if (dom.progressFill) dom.progressFill.style.width = pct + "%";
      if (dom.progressText) dom.progressText.textContent = text;
    } catch (err) {
      throw err;
    }
  }

  throw new Error("Proxy generation timed out");
}

async function regenerateProxy() {
  if (!dom) return;
  if (!state.currentItem) return;

  var startMin = parseInt(dom.proxyRegenStart ? dom.proxyRegenStart.value : 0) || 0;
  state.proxyStartSec = startMin * 60;

  var mediaId = state.currentItem.media_id || state.currentItem.id;
  if (!mediaId) return;

  // Hide current proxy video, show progress
  if (dom.proxySection) dom.proxySection.style.display = "none";
  hideError();
  if (dom.proxyProgress) dom.proxyProgress.style.display = "block";
  if (dom.progressFill) dom.progressFill.style.width = "0%";
  if (dom.progressText) dom.progressText.textContent = "Regenerating preview from " + fmtTime(state.proxyStartSec) + "...";

  try {
    var url = "api/proxy/" + mediaId + "?start_min=" + startMin + "&force=true";
    var startResp = await fetch(url, { method: "POST" });
    if (!startResp.ok) {
      var errData = await startResp.json().catch(function() { return {}; });
      throw new Error(errData.detail || "HTTP " + startResp.status);
    }
    var startData = await startResp.json();
    if (startData.warning && dom.progressText) {
      dom.progressText.textContent = startData.warning + " " + dom.progressText.textContent;
    }
    await pollProxyStatus(mediaId);
  } catch (err) {
    if (dom.proxyProgress) dom.proxyProgress.style.display = "none";
    showError(err.message);
  }
}

function onProxyReady(mediaId) {
  state.proxyReady = true;

  var item = state.currentItem;
  var durationS = item.duration / 1000;
  state.proxyDuration = durationS;

  // Show proxy range info
  var proxyEndSec = Math.min(durationS, state.proxyStartSec + 600);
  state.proxyEndSec = proxyEndSec;
  if (dom.proxyInfoText) {
    dom.proxyInfoText.textContent = "Preview: " + fmtTime(state.proxyStartSec) + " \u2013 " + fmtTime(proxyEndSec) + " of " + fmtTime(durationS);
  }
  // Set regenerate input to next reasonable offset (current end, rounded to minutes)
  if (dom.proxyRegenStart) {
    dom.proxyRegenStart.value = Math.floor(proxyEndSec / 60);
  }

  if (dom.proxyVideo) dom.proxyVideo.src = "api/proxy/" + mediaId + "/stream";

  if (dom.rangeStart) dom.rangeStart.max = Math.floor(durationS);
  if (dom.rangeEnd) dom.rangeEnd.max = Math.floor(durationS);

  var defaultEnd = Math.min(state.proxyStartSec + 30, Math.floor(durationS));
  if (dom.rangeStart) dom.rangeStart.value = Math.floor(state.proxyStartSec);
  if (dom.rangeEnd) dom.rangeEnd.value = Math.floor(defaultEnd);

  if (window._jumpOffset != null) {
    var offset = window._jumpOffset;
    var start = Math.max(0, offset - 5);
    var end = Math.min(durationS, offset + 25);
    if (dom.rangeStart) dom.rangeStart.value = Math.floor(start);
    if (dom.rangeEnd) dom.rangeEnd.value = Math.floor(end);
    window._jumpOffset = null;
    window._jumpDuration = null;
  }

  updateTimeDisplay();
  if (dom.proxySection) dom.proxySection.style.display = "block";
  if (dom.btnDownload) dom.btnDownload.disabled = false;

  // Seek video to start position (queues until metadata loaded)
  var startVal = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  seekVideo(startVal);

  if (dom.proxySection) dom.proxySection.scrollIntoView({ behavior: "smooth" });
}

// ── Scrubber Controls ──────────────────────────────────────────────────

function seekVideo(absoluteSec) {
  // Convert absolute movie time to proxy-relative video time.
  // Returns true if within proxy range, false if outside.
  var relSec = absoluteSec - state.proxyStartSec;
  var proxyLen = state.proxyEndSec - state.proxyStartSec;
  var inRange = relSec >= 0 && relSec <= proxyLen;
  if (dom.proxyVideo) {
    dom.proxyVideo.currentTime = Math.max(0, Math.min(relSec, proxyLen));
  }
  return inRange;
}

function updateTimeDisplay() {
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  var end = parseInt(dom.rangeEnd ? dom.rangeEnd.value : 0) || 0;

  if (dom.timeStart) dom.timeStart.textContent = fmtTime(start);
  if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(end);
  if (dom.timeDuration) dom.timeDuration.textContent = "/ " + fmtTime(state.proxyDuration);

  // Enforce start < end
  if (end <= start && dom.rangeEnd) {
    dom.rangeEnd.value = start + 1;
    if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(start + 1);
    end = start + 1;
  }

  // Enforce max 140s clip
  if (end - start > 140 && dom.rangeEnd) {
    dom.rangeEnd.value = start + 140;
    if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(start + 140);
  }

  // Clamp end to duration
  if (dom.rangeEnd && parseInt(dom.rangeEnd.value) > state.proxyDuration) {
    dom.rangeEnd.value = Math.floor(state.proxyDuration);
    if (dom.timeEnd) dom.timeEnd.textContent = fmtTime(Math.floor(state.proxyDuration));
  }

  // Clamp start to duration
  if (dom.rangeStart && parseInt(dom.rangeStart.value) > state.proxyDuration) {
    dom.rangeStart.value = Math.floor(state.proxyDuration);
    if (dom.timeStart) dom.timeStart.textContent = fmtTime(Math.floor(state.proxyDuration));
  }
}

// During drag: seek but cap silently if outside proxy range
function onRangeInput() {
  updateTimeDisplay();
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  seekVideo(start);
}

// On release: if outside proxy range, auto-regenerate from new position
function onStartReleased() {
  updateTimeDisplay();
  var start = parseInt(dom.rangeStart ? dom.rangeStart.value : 0) || 0;
  var inRange = seekVideo(start);
  if (!inRange) {
    // Outside proxy range — auto-regenerate
    if (dom.proxyRegenStart) dom.proxyRegenStart.value = Math.floor(start / 60);
    regenerateProxy();
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
    seekVideo(newStart);
  } else if (action === "set-duration") {
    var newEnd = Math.min(state.proxyDuration, start + value);
    if (dom.rangeEnd) dom.rangeEnd.value = Math.floor(newEnd);
    updateTimeDisplay();
    seekVideo(start);
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

  // Generate proxy
  if (dom.btnGenProxy) dom.btnGenProxy.addEventListener("click", generateProxy);

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

  // Keyboard: Escape to go back
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && dom.detailView && dom.detailView.style.display !== "none") {
      goBack();
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
