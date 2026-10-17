// FloodGuard service worker.
// Pages are fetched network-first so users always see the latest warnings;
// the cache is only a fallback for when the device is offline.
const CACHE = "floodguard-v1";
const PRECACHE = ["/", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {}));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(async (cached) => cached || await caches.match("/") ||
          new Response("FloodGuard is offline. Reconnect to load current flood information.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })),
      ),
  );
});

// Flood alerts pushed from the server (lib/alerts.ts).
self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || "FloodGuard alert", {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One notification per place and kind: a newer alert replaces the older one but still buzzes.
      tag: data.tag,
      renotify: Boolean(data.tag),
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" },
    }),
  );
});

// Open the app at the alert's place, reusing an open window when there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      return open ? open.navigate(url).then((w) => (w || open).focus()) : self.clients.openWindow(url);
    }),
  );
});
