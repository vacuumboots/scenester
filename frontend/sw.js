// Service worker — app-shell caching with network-first freshness for code.
// HTML/JS/CSS are network-first (deploys show immediately; cached copy is the
// offline fallback). Icons/manifest are cache-first. API is network-only.
//
// Served from the APP ROOT (not /static/) so its scope covers the whole app
// at both the Caddy /scenester/ URL and the direct :8096 URL. All shell paths
// are derived from self.registration.scope — never hardcode the prefix.
const CACHE = "scenester-v1";

self.addEventListener("install", e => {
  const scope = self.registration.scope;           // "/" or "/scenester/"
  const shell = [scope, scope + "manifest.json"];
  self.skipWaiting();                              // new SW activates at once
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(shell))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())            // control open tabs now
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // API: network-only — never cached, never served from cache
  if (url.pathname.includes("/api/")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell + code: network-first so the newest deploy always loads.
  const isCode = url.pathname.endsWith(".js") || url.pathname.endsWith(".css");
  if (e.request.mode === "navigate" || isCode) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Icons, manifest, images: cache-first
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
