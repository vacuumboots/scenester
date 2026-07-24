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
  proxyReady: false,
  proxyDuration: 0,     // seconds
};

// ── DOM refs ───────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  search:       $("#search"),
  libraryGrid:  $("#library-grid"),
  resultCount:  $("#result-count"),
  emptyState:   $("#empty-state"),
  libraryView:  $("#library-view"),
  detailView:   $("#detail-view"),

  detailTitle:  $("#detail-title"),
  detailMeta:   $("#detail-meta"),
  btnGenProxy:  $("#btn-generate-proxy"),
  btnBack:      $("#btn-back"),

  nowPlaying:   $("#now-playing"),
  npTitle:      $("#np-title"),
  npTime:       $("#np-time"),
  btnJumpClip:  $("#btn-jump-clip"),

  proxyProgress: $("#proxy-progress"),
  progressFill:  $("#progress-fill"),
  progressText:  $("#progress-text"),
  proxyError:    $("#proxy-error"),
  proxySection:  $("#proxy-section"),

  proxyVideo:   $("#proxy-video"),
  rangeStart:   $("#range-start"),
  rangeEnd:     $("#range-end"),
  timeStart:    $("#time-start"),
  timeEnd:      $("#time-end"),
  timeDuration: $("#time-duration"),
  btnDownload:  $("#btn-download-clip"),
  clipStatus:   $("#clip-status"),
};

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

async function loadLibrary() {
  try {
    const resp = await fetch("api/library");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.items = data.items || [];
    renderLibrary();
  } catch (err) {
    console.error("Failed to load library:", err);
    dom.libraryGrid.innerHTML =
      '<div class="empty-state"><div class="empty-text">Failed to load library</div>' +
      '<div class="empty-sub">Is Plex reachable?</div></div>';
  }
}

function renderLibrary(filterText = "") {
  const query = filterText.toLowerCase().trim();
  const filtered = query
    ? state.items.filter((item) => {
        const title = (item.title || "").toLowerCase();
        const show = (item.show_title || "").toLowerCase();
        return title.includes(query) || show.includes(query);
      })
    : state.items;

  dom.resultCount.textContent = `(${filtered.length})`;

  if (filtered.length === 0) {
    dom.libraryGrid.innerHTML = "";
    dom.emptyState.style.display = "block";
    return;
  }

  dom.emptyState.style.display = "none";
  dom.libraryGrid.innerHTML = filtered.map(renderCard).join("");
}

function renderCard(item) {
  const title = item.title || "Unknown";
  const year = item.year ? ` · ${item.year}` : "";
  const dur = item.duration ? ` · ${fmtDuration(item.duration)}` : "";

  let subtitle = item.type === "episode"
    ? `${item.show_title || ""} — S${String(item.season).padStart(2,"0")}E${String(item.episode).padStart(2,"0")}`
    : `${item.type || "movie"}${year}${dur}`;

  const thumbSrc = item.thumb
    ? `api/thumb/${item.media_id}`
    : "";

  const thumbHtml = thumbSrc
    ? `<img class="card-thumb" src="${thumbSrc}" alt="${title}" loading="lazy">`
    : `<div class="card-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:32px;">&#127916;</div>`;

  return `
    <div class="card" onclick="selectItem(${item.media_id})" data-id="${item.media_id}">
      <div class="card-content">
        ${thumbHtml}
        <div class="card-info">
          <div class="card-name">${escHtml(title)}</div>
          <div class="card-meta">${escHtml(subtitle)}</div>
        </div>
      </div>
    </div>`;
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Detail View ────────────────────────────────────────────────────────

async function selectItem(mediaId) {
  try {
    const resp = await fetch(`api/library/${mediaId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.currentItem = await resp.json();
    state.proxyReady = false;
    showDetailView();
  } catch (err) {
    console.error("Failed to load item:", err);
  }
}

function showDetailView() {
  const item = state.currentItem;
  if (!item) return;

  dom.libraryView.style.display = "none";
  dom.detailView.style.display = "block";

  dom.detailTitle.textContent = item.title || "Unknown";

  const parts = [];
  if (item.type === "episode") {
    parts.push(`${item.show_title || ""} — S${String(item.season).padStart(2,"0")}E${String(item.episode).padStart(2,"0")}`);
  }
  if (item.year) parts.push(String(item.year));
  parts.push(item.type || "movie");
  if (item.duration) parts.push(fmtDuration(item.duration));
  dom.detailMeta.textContent = parts.join(" · ");

  // Reset proxy state
  dom.proxySection.style.display = "none";
  dom.proxyProgress.style.display = "none";
  dom.proxyError.style.display = "none";
  dom.btnGenProxy.style.display = "inline-flex";
  dom.btnDownload.disabled = true;
  dom.clipStatus.textContent = "";
  state.proxyReady = false;
  state.proxyDuration = 0;
}

function goBack() {
  dom.detailView.style.display = "none";
  dom.libraryView.style.display = "block";
  state.currentItem = null;
  renderLibrary(dom.search.value);
}

// ── Now Playing Banner ─────────────────────────────────────────────────

let sessionPollTimer = null;

async function pollSessions() {
  try {
    const resp = await fetch("api/sessions");
    if (!resp.ok) return;
    const data = await resp.json();
    const sessions = data.sessions || [];

    // Find first paused session
    const paused = sessions.find((s) => s.state === "paused");

    if (paused) {
      dom.nowPlaying.style.display = "block";
      dom.npTitle.textContent = paused.title;
      dom.npTime.textContent = `at ${fmtTime(paused.viewOffset)}`;
      dom.btnJumpClip.onclick = () => jumpToClip(paused);
    } else {
      dom.nowPlaying.style.display = "none";
    }
  } catch (err) {
    // Silently fail — banner is optional
  }
}

function jumpToClip(session) {
  // Pre-select the item and set range around the pause point
  const durationS = session.duration / 1000;
  const viewOffset = session.viewOffset;

  selectItem(session.media_id).then(() => {
    // After detail view loads, pre-set ranges (if proxy ready, otherwise
    // the user still needs to generate the proxy first)
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
  if (!state.currentItem) return;

  const mediaId = state.currentItem.media_id || state.currentItem.id;
  if (!mediaId) return;

  dom.btnGenProxy.style.display = "none";
  dom.proxyError.style.display = "none";
  dom.proxySection.style.display = "none";
  dom.proxyProgress.style.display = "block";
  dom.progressFill.style.width = "0%";
  dom.progressText.textContent = "Starting proxy generation...";

  try {
    // Trigger generation
    const startResp = await fetch(`api/proxy/${mediaId}`, { method: "POST" });
    if (!startResp.ok) {
      const err = await startResp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${startResp.status}`);
    }

    // Poll for progress
    await pollProxyStatus(mediaId);
  } catch (err) {
    dom.proxyProgress.style.display = "none";
    dom.proxyError.style.display = "block";
    dom.proxyError.textContent = `Error: ${err.message}`;
    dom.btnGenProxy.style.display = "inline-flex";
  }
}

async function pollProxyStatus(mediaId) {
  const maxPolls = 300; // 10 minutes at 2s intervals
  let polls = 0;

  while (polls < maxPolls) {
    await sleep(2000);
    polls++;

    try {
      const resp = await fetch(`api/proxy/${mediaId}/status`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const status = await resp.json();

      if (status.error) {
        throw new Error(status.error);
      }

      if (status.done) {
        // Proxy ready!
        dom.proxyProgress.style.display = "none";
        dom.progressFill.style.width = "100%";
        dom.progressText.textContent = "Done!";

        onProxyReady(mediaId);
        return;
      }

      // Update progress
      const pct = Math.round(status.progress * 100);
      dom.progressFill.style.width = `${pct}%`;
      dom.progressText.textContent = `Generating preview... ${pct}%`;
    } catch (err) {
      throw err;
    }
  }

  throw new Error("Proxy generation timed out");
}

function onProxyReady(mediaId) {
  state.proxyReady = true;

  // Get duration from current item
  const item = state.currentItem;
  const durationS = item.duration / 1000;
  state.proxyDuration = durationS;

  // Set up video player
  dom.proxyVideo.src = `api/proxy/${mediaId}/stream`;

  // Set range inputs
  dom.rangeStart.max = Math.floor(durationS);
  dom.rangeEnd.max = Math.floor(durationS);

  // Default: first 30 seconds (or full duration if shorter)
  const defaultEnd = Math.min(30, Math.floor(durationS));
  dom.rangeStart.value = 0;
  dom.rangeEnd.value = defaultEnd;

  // If we jumped from a now-playing session, pre-set the range
  if (window._jumpOffset != null) {
    const offset = window._jumpOffset;
    const start = Math.max(0, offset - 5);
    const end = Math.min(durationS, offset + 25);
    dom.rangeStart.value = Math.floor(start);
    dom.rangeEnd.value = Math.floor(end);
    window._jumpOffset = null;
    window._jumpDuration = null;
  }

  updateTimeDisplay();
  dom.proxySection.style.display = "block";
  dom.btnDownload.disabled = false;

  // Scroll to player
  dom.proxySection.scrollIntoView({ behavior: "smooth" });
}

// ── Scrubber Controls ──────────────────────────────────────────────────

function updateTimeDisplay() {
  const start = parseInt(dom.rangeStart.value) || 0;
  const end = parseInt(dom.rangeEnd.value) || 0;

  dom.timeStart.textContent = fmtTime(start);
  dom.timeEnd.textContent = fmtTime(end);
  dom.timeDuration.textContent = `/ ${fmtTime(state.proxyDuration)}`;

  // Constrain: end must be > start
  if (end <= start) {
    dom.rangeEnd.value = start + 1;
    dom.timeEnd.textContent = fmtTime(start + 1);
  }

  // Cap end at start + 140
  if (end - start > 140) {
    dom.rangeEnd.value = start + 140;
    dom.timeEnd.textContent = fmtTime(start + 140);
  }

  // Ensure end doesn't exceed duration
  if (parseInt(dom.rangeEnd.value) > state.proxyDuration) {
    dom.rangeEnd.value = Math.floor(state.proxyDuration);
    dom.timeEnd.textContent = fmtTime(Math.floor(state.proxyDuration));
  }
}

function onRangeChange() {
  updateTimeDisplay();
}

// ── Preset Buttons ─────────────────────────────────────────────────────

function handlePreset(action, value) {
  const start = parseInt(dom.rangeStart.value) || 0;

  if (action === "shift-start") {
    const newStart = Math.max(0, start + value);
    dom.rangeStart.value = newStart;
    // Keep duration same, adjust end
    const currentEnd = parseInt(dom.rangeEnd.value) || (start + 30);
    const duration = currentEnd - start;
    dom.rangeEnd.value = Math.min(state.proxyDuration, newStart + Math.max(1, duration));
  } else if (action === "set-duration") {
    const newEnd = Math.min(state.proxyDuration, start + value);
    dom.rangeEnd.value = Math.floor(newEnd);
  }

  updateTimeDisplay();
}

// ── Clip Download ──────────────────────────────────────────────────────

async function downloadClip() {
  if (!state.currentItem) return;

  const mediaId = state.currentItem.media_id || state.currentItem.id;
  const startSec = parseInt(dom.rangeStart.value) || 0;
  const endSec = parseInt(dom.rangeEnd.value) || 0;

  if (endSec <= startSec) {
    dom.clipStatus.textContent = "Invalid range — end must be after start";
    return;
  }

  dom.btnDownload.disabled = true;
  dom.btnDownload.textContent = "Clipping...";
  dom.clipStatus.textContent = "Encoding clip (may take 10-30 seconds)...";

  try {
    const resp = await fetch("api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_id: mediaId,
        start_sec: startSec,
        end_sec: endSec,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }

    const data = await resp.json();

    // Trigger browser download (strip leading / to keep paths relative)
    const a = document.createElement("a");
    a.href = data.url.replace(/^\//, "");
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    dom.clipStatus.textContent = `Downloaded ${data.filename} (${Math.round(data.duration)}s)`;
  } catch (err) {
    dom.clipStatus.textContent = `Error: ${err.message}`;
  } finally {
    dom.btnDownload.disabled = false;
    dom.btnDownload.textContent = "\u{1F4E5} Download Clip";
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Event Wiring ───────────────────────────────────────────────────────

function init() {
  // Search
  dom.search.addEventListener("input", () => renderLibrary(dom.search.value));

  // Detail back button
  dom.btnBack.addEventListener("click", goBack);

  // Generate proxy
  dom.btnGenProxy.addEventListener("click", generateProxy);

  // Range sliders
  dom.rangeStart.addEventListener("input", onRangeChange);
  dom.rangeEnd.addEventListener("input", onRangeChange);

  // Preset buttons
  $$(".preset-buttons .btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const offset = parseInt(btn.dataset.offset);
      const duration = parseInt(btn.dataset.duration);
      handlePreset(action, offset || duration);
    });
  });

  // Download clip
  dom.btnDownload.addEventListener("click", downloadClip);

  // Keyboard: Escape to go back
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dom.detailView.style.display !== "none") {
      goBack();
    }
  });

  // Load library
  loadLibrary();
  startSessionPolling();
}

// ── Boot ───────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
