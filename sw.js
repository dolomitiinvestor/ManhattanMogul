// Network-first service worker: every launch fetches the latest files from the
// server, so a new push shows up without bumping a version. The cache is only a
// fallback for when the network is down or hangs.
const CACHE = 'mogul';
const TIMEOUT_MS = 6000; // after this, serve the cached copy if there is one

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Update checks from update.js must always hit the network, never the cache.
  if (url.searchParams.has('__check')) return;

  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
    }
    return res;
  });
  e.waitUntil(network.catch(() => {}));

  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
    const fromCache = () => caches.match(req).then(finish);
    const timer = setTimeout(fromCache, TIMEOUT_MS);
    network
      .then((res) => { clearTimeout(timer); finish(res); })
      .catch(() => { clearTimeout(timer); return fromCache().then(() => finish(Response.error())); });
  }));
});
