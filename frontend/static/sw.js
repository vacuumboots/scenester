// Service worker — app shell caching with network-first freshness for code.
// HTML/JS/CSS are network-first (deploys show immediately; cached copy is the
// offline fallback). Icons/manifest are cache-first. API is network-only.
const CACHE = "cliparr-v2";
const SHELL = [
  "/cliparr/",
  "/cliparr/static/manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // API: never serve stale
  if (url.pathname.includes("/api/")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
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
