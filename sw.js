// Service Worker — 离线缓存
var CACHE = 'aq-stocks-v1';
var FILES = [
    '.',
    'index.html',
    'css/style.css',
    'js/api.js',
    'js/filter.js',
    'js/ui.js',
    'js/app.js',
    'manifest.json'
];

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE).then(function(cache) {
            return cache.addAll(FILES);
        })
    );
});

self.addEventListener('fetch', function(e) {
    e.respondWith(
        caches.match(e.request).then(function(r) {
            return r || fetch(e.request);
        })
    );
});
