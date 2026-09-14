/* ============================================================
   Studydesk — service worker
   Caches the app shell so the site loads and works fully offline.
   Bump CACHE_NAME whenever you change index.html/style.css/script.js
   so returning users get the update instead of a stale cache.
   ============================================================ */

const CACHE_NAME = "studydesk-cache-v5";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./local-ai.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./favicon-32.png"
];

// Install: pre-cache the app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove any old versioned caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for app-shell files, network-first (with cache fallback)
// for everything else (e.g. Google Fonts), so the app still opens with no
// connection even if a cross-origin resource never got cached.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if(isSameOrigin){
    event.respondWith(
      caches.match(req).then((cached) => {
        if(cached) return cached;
        return fetch(req).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return res;
        }).catch(() => caches.match("./index.html"));
      })
    );
  } else {
    event.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
