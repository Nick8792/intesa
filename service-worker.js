/* ============================================================================
   INTESA — Service Worker
   Strategia "prima la rete, poi la cache" (network-first):
   • ONLINE  → a ogni apertura/reload usa la versione FRESCA dalla rete e
               aggiorna la cache. Non serve più cambiare versione a ogni deploy.
   • OFFLINE → usa l'ultima versione salvata in cache (l'app resta usabile).
   Percorsi relativi: funziona anche in una sottocartella di GitHub Pages.
   ========================================================================== */
const CACHE = 'intesa';        // non è più necessario cambiarlo a ogni modifica
const TIMEOUT = 4000;          // ms max di attesa rete prima di usare la cache
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-64.png',
];

// Pre-carica l'app-shell (serve solo per il PRIMO avvio offline) e attiva subito.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// Rimuove eventuali cache vecchie e prende il controllo delle pagine aperte.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: prova la rete (con timeout), aggiorna la cache, poi fallback.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT)),
    ]);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    return cached || cache.match('./index.html'); // fallback offline per la navigazione
  }
}
