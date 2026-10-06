/*
 * PlanesView service worker: the app installs, and opens without a network.
 *
 * Three rules, by what a request is for:
 *
 *  - The page itself: network first, so a deployment is picked up on the next
 *    visit; the last copy when there is no network, so the app still opens on
 *    a plane with no Wi-Fi (the ground it has seen is in IndexedDB already).
 *  - Build output (`/assets/`, hashed, immutable) and the heavy static files
 *    (models, routes, the night map, the map style): from the cache once
 *    fetched, refreshed in the background. A 777 is downloaded once.
 *  - Live data (`/feeds/`) and everything cross-origin: never touched. Stale
 *    traffic is worse than none, and the tile caches are the app's own.
 *
 * Nothing is precached: installing must not cost a phone a hundred megabytes
 * of airframes it may never fly in. Static files are cached as they are used,
 * and the caches are bounded.
 */

const VERSION = 'v1';
const SHELL = `pv-shell-${VERSION}`;
const STATIC = `pv-static-${VERSION}`;
/** Static entries kept; the oldest go first. Models are a few megabytes each. */
const STATIC_MAX = 160;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('pv-') && key !== SHELL && key !== STATIC) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

const STATIC_PATH = /\/(?:assets|models|routes|night|map)\/|\.(?:webmanifest|png|svg|ico)$/;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/feeds/') || url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(page(request));
    return;
  }
  if (STATIC_PATH.test(url.pathname)) event.respondWith(staticFile(request, event));
});

async function page(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    // One copy of the page, whatever the query or fragment it was opened with.
    if (fresh.ok) await cache.put(new URL('./', self.registration.scope).href, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(new URL('./', self.registration.scope).href)) ?? Response.error();
  }
}

async function staticFile(request, event) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then(async (fresh) => {
      // Partial (range) and failed answers are not worth keeping.
      if (fresh.ok && fresh.status === 200) {
        await cache.put(request, fresh.clone());
        await trim(cache);
      }
      return fresh;
    })
    .catch(() => null);
  if (hit) {
    // Hashed build files never change: no need to ask again.
    if (!new URL(request.url).pathname.includes('/assets/')) event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) ?? Response.error();
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - STATIC_MAX; i++) await cache.delete(keys[i]);
}
