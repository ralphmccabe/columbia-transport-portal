const CACHE_NAME = 'columbia-logistics-v14.0.0';
const ASSETS = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './manifest.json',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './pdf.worker.min.js',
    './pdf.min.js',
    './pdf-lib.min.js',
    './lucide.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    'https://unpkg.com/pdf-lib/dist/pdf-lib.min.js',
    'https://unpkg.com/lucide@latest'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        Promise.all([
            caches.keys().then((keys) => {
                return Promise.all(
                    keys.map((key) => {
                        if (key !== CACHE_NAME) return caches.delete(key);
                    })
                );
            }),
            self.clients.claim()
        ])
    );
});

// Handle Share Target (receiving files)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method === 'POST' && url.pathname.endsWith('/index.html')) {
        event.respondWith((async () => {
            const formData = await event.request.formData();
            const file = formData.get('files');
            if (file) {
                // Store file in a temporary cache or use a transition page
                // For simplicity in this PWA, we'll redirect to index.html with a flag
                // and use a BroadcastChannel or similar, BUT a better way is to 
                // just store it in a global variable for a moment if possible, 
                // or use a specific cache.
                const cache = await caches.open('shared-files');
                await cache.put('/last-shared-file', new Response(file));
            }
            return Response.redirect('./index.html?shared=1', 303);
        })());
        return;
    }

    // Standard Stale-While-Revalidate strategy
    event.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(event.request).then((cachedResponse) => {
                const fetchedResponse = fetch(event.request).then((networkResponse) => {
                    cache.put(event.request, networkResponse.clone());
                    return networkResponse;
                }).catch(() => null);
                return cachedResponse || fetchedResponse;
            });
        })
    );
});
