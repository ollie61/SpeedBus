const CACHE_NAME = "speedbus-shell-v0.2.6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./speedometer.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./speedbus-icon.svg",
  "./stm-routes.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith("speedbus-shell-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  // Never intercept writes or requests to map tiles and other external services.
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(request)) ||
            (await cache.match("./speedometer.html")) ||
            Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const fresh = fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
