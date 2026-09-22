/* STRADA service worker: app shell offline, media cached after first play,
   API stale-while-revalidate so a screen you have seen before paints at once. */
const VERSION = 'strada-v3';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function notify(path) {
  for (const client of await self.clients.matchAll()) client.postMessage({ type: 'api-updated', path });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    // Course content barely changes, so serve the cached answer immediately and refresh it in the
    // background; the next visit shows the newer copy. Screens the user has never opened still wait.
    e.respondWith(caches.match(req).then(hit => {
      const fresh = fetch(req).then(async r => {
        if (r.ok) {
          const copy = r.clone();
          const body = await copy.clone().text();
          const old = hit ? await hit.clone().text() : null;
          (await caches.open(VERSION)).put(req, copy);
          if (old !== null && old !== body) notify(url.pathname);   // the page redraws itself if it is safe to
        }
        return r;
      }).catch(() => hit || new Response(JSON.stringify({ detail: 'Offline and not cached yet.' }),
        { status: 503, headers: { 'content-type': 'application/json' } }));
      e.waitUntil(fresh);
      return hit ? hit.clone() : fresh;
    }));
    return;
  }
  // media from Supabase storage and Google Fonts: cache-first
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return r;
  })));
});
