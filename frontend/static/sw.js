// Basic service worker — caches the app shell for offline access
const CACHE = "cliparr-v1";
const SHELL = [
  "/cliparr/",
  "/cliparr/static/style.css",
  "/cliparr/static/app.js",
  "/cliparr/static/manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
});

self.addEventListener("fetch", e => {
  // Cache-first for static assets, network-first for API
  if (e.request.url.includes("/api/")) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});
