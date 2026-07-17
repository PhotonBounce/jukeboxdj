/* JukeboxDJ service worker — offline app shell.
   Rules (see repo CLAUDE.md): precache with cache:"reload" so the SW never
   snapshots a stale server-cached file, and bump CACHE on every release. */
var CACHE = "jukeboxdj-v14";
var ASSETS = [
  "./",
  "index.html",
  "app.html",
  "jukebox.js",
  "jukebox-pro.js",
  "jukebox-automix.js",
  "vinyl-worklet.js",
  "vendor/qrcode.min.js",
  "jukebox.css",
  "manifest.webmanifest",
  "audio/tracks.json",
  "privacy.html",
  "terms.html",
  "assets/icon.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/shots/console.png",
  "assets/shots/deck.png",
  "assets/shots/mixer.png",
  "assets/shots/jukebox.png",
  "assets/shots/mobile.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (a) {
        return fetch(new Request(a, { cache: "reload" })).then(function (res) {
          if (res.ok) return c.put(a, res);
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () { return caches.match("index.html"); });
    })
  );
});
