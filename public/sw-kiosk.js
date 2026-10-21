'use strict';
// Service worker del terminale: tiene in memoria la pagina, così si apre
// anche se il Raspberry si riavvia senza rete. Le API non passano mai dalla cache.

const CACHE = 'tb-kiosk-v1';
const FILE = ['/kiosk', '/kiosk.js', '/kiosk.css', '/stile.css'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x))))
    .then(() => self.clients.claim()));
});

// Prima la rete (così gli aggiornamenti arrivano subito), la cache solo se manca.
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin || !FILE.includes(url.pathname)) return;
  ev.respondWith(fetch(ev.request)
    .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copia)); return r; })
    .catch(() => caches.match(ev.request)));
});
