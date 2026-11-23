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

const CACHE_NAME = 'gastos-shell-v10';
const SHARE_CACHE = 'gastos-share-v1';
const SHARE_KEY = new URL('__shared-image', self.registration.scope).href;

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
        Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== SHARE_CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Compartir una imagen desde otra app (share_target del manifest).
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // Solo GET del mismo origen: el backend (script.google.com) y GIS quedan fuera.
  if (request.method !== 'GET') return;
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

/**
 * Guarda la imagen compartida en un cache aparte y vuelve a la app con ?shared=1.
 * La página la consume (y la borra) cuando hay sesión iniciada.
 */
async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    let file = form.get('foto');
    if (!file || typeof file === 'string' || !file.size) {
      for (const value of form.values()) {
        if (value && typeof value !== 'string' && value.size > 0) { file = value; break; }
      }
    }
    if (file && typeof file !== 'string' && file.size > 0) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARE_KEY, new Response(file, {
        headers: { 'Content-Type': file.type || 'image/jpeg' }
      }));
    }
  } catch (err) {
    // Si falla el parseo, igual redirigimos para que el usuario vea la app.
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
