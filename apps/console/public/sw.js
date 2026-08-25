/*
 * Console service worker.
 *
 * Deliberately narrow. This console shows live fleet state, so caching an API
 * response would mean an operator acting on numbers that are no longer true.
 * Only the shell is cached, and only to give navigation something to show when
 * the network is gone.
 */

/*
 * Bump `CACHE` whenever a precached file below changes.
 *
 * `install` is the only thing that ever writes `OFFLINE_URL`, and it only runs
 * when the *bytes of this file* differ from the registered worker's. Editing
 * offline.html without touching this line therefore ships the new page to new
 * visitors and leaves every already-installed console serving the old one
 * forever, with nothing anywhere to say so. `activate` deletes the previous
 * cache by name, so the bump is also what stops them accumulating.
 *
 * v2: offline.html became bilingual (T016).
 */
const CACHE = "vodoge-shell-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/icon.svg"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never serve an API or auth response from cache: stale fleet state read as
  // current is worse than an error, and a cached auth reply is a security bug.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return;

  // Navigations fall back to the offline page rather than the browser's error.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Static build output is content-hashed, so serving it from cache is safe.
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
