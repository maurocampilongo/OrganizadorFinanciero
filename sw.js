/**
 * Service Worker mínimo para que la PWA sea instalable en Android.
 *
 * Estrategia:
 *  - Precache del "shell" (HTML, manifest, iconos) para abrir la app sin red.
 *  - Navegación: network-first con fallback al index cacheado.
 *  - Estáticos propios: cache-first + actualización en segundo plano.
 *  - NUNCA cachea terceros (Google Identity Services ni el backend de Apps Script):
 *    así el login y las respuestas de la IA siempre son frescas.
 */
'use strict';

const CACHE_NAME = 'gastos-shell-v2';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Solo GET del mismo origen: el backend (script.google.com) y GIS quedan fuera.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          putInCache(request, response.clone());
          return response;
        })
        .catch(() =>
          caches.match('./index.html', { ignoreSearch: true }).then(
            (cached) => cached || caches.match('./', { ignoreSearch: true })
          )
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) {
        // Revalidación silenciosa para no quedar con versiones viejas.
        fetch(request)
          .then((fresh) => putInCache(request, fresh))
          .catch(() => {});
        return cached;
      }
      return fetch(request).then((response) => {
        putInCache(request, response.clone());
        return response;
      });
    })
  );
});

function putInCache(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return;
  caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, response))
    .catch(() => {});
}
