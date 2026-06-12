// Service Worker — 网络优先策略
var CACHE = 'aq-breakout-v1';

self.addEventListener('install', function(e) {
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.map(function(key) {
                if (key !== CACHE) return caches.delete(key);
            }));
        })
    );
});

self.addEventListener('fetch', function(e) {
    // 对API请求不缓存
    if (e.request.url.indexOf('eastmoney.com') > -1 ||
        e.request.url.indexOf('sina.com') > -1 ||
        e.request.url.indexOf('gtimg.cn') > -1) {
        return;
    }
    e.respondWith(
        fetch(e.request).then(function(resp) {
            var clone = resp.clone();
            caches.open(CACHE).then(function(cache) {
                cache.put(e.request, clone);
            });
            return resp;
        }).catch(function() {
            return caches.match(e.request);
        })
    );
});
