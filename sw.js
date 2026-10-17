'use strict';

const CACHE_VERSION = 'vio-v1.4.0';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon.svg'];
const TAILWIND_HOST = 'cdn.tailwindcss.com';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function putInCache(request, response) {
  const cache = await caches.open(CACHE_VERSION);
  await cache.put(request, response);
}

// Спершу мережа, при збої — кеш (щоб оболонка застосунку оновлювалась)
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) await putInCache(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Миттєво з кешу, фонове оновлення (для Tailwind CDN; відповідь може бути opaque)
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok || response.type === 'opaque') await putInCache(request, response.clone());
      return response;
    })
    .catch((err) => {
      if (cached) return cached;
      throw err;
    });
  return cached || refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === TAILWIND_HOST) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
