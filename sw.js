/* Tokyo Night Radar — offline support.
   The whole point: on a Tokyo backstreet with no signal, the app still opens and
   every list, phrase and sign is there. Map tiles you've already looked at come
   back too; ones you haven't simply won't draw. */

const SHELL = "tnr-shell-v1";
const TILES = "tnr-tiles-v1";
const MAX_TILES = 400;

const PRECACHE = [
  "./", "./index.html", "./manifest.webmanifest", "./icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // allSettled: one unreachable CDN must not abort the whole install
    await Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache: "reload" }))));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length > MAX_TILES) {
    // drop the oldest quarter so we're not trimming on every single tile
    await Promise.all(keys.slice(0, Math.floor(MAX_TILES / 4)).map(k => c.delete(k)));
  }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // the page itself: fresh when online, cached copy when not
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        (await caches.open(SHELL)).put("./index.html", net.clone());
        return net;
      } catch {
        return (await caches.match("./index.html")) || (await caches.match("./"))
          || new Response("Offline and no cached copy yet.", { status: 503 });
      }
    })());
    return;
  }

  // map tiles: cache first, top up in the background, keep the cache bounded
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const net = await fetch(req);
        if (net.ok) { await c.put(req, net.clone()); trimTiles(); }
        return net;
      } catch {
        return new Response("", { status: 504 });   // tile just doesn't draw
      }
    })());
    return;
  }

  // everything else (fonts, leaflet, icon): cache first, fall back to network
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net.ok && (url.origin === location.origin
          || url.hostname.endsWith("unpkg.com")
          || url.hostname.endsWith("googleapis.com")
          || url.hostname.endsWith("gstatic.com"))) {
        (await caches.open(SHELL)).put(req, net.clone());
      }
      return net;
    } catch {
      return new Response("", { status: 504 });
    }
  })());
});
