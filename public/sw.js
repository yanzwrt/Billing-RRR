const CACHE_NAME = 'customer-pwa-v1';
const PRECACHE_URLS = [
  '/css/style.css',
  '/img/logo.png',
  '/img/pwa-icon.svg',
  '/img/hero.png',
  '/customer/login',
  '/customer/register',
  '/customer/tos',
  '/customer/privacy',
  '/customer/about',
  '/customer/contact'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
      ),
      self.clients.claim()
    ])
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(request, fallbackUrl) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('Offline', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  if (req.mode === 'navigate' && path.startsWith('/customer/')) {
    event.respondWith(networkFirst(req, '/customer/login'));
    return;
  }

  // [FUNGSI: IZINKAN CACHE UNTUK SEMUA FILE MANIFEST ROLE]
  if (path.startsWith('/css/') || path.startsWith('/img/') || path.endsWith('.webmanifest')) {
  event.respondWith(cacheFirst(req));
  return;
  }

  event.respondWith(networkFirst(req));
});

// =========================================================================
// [TAMBAHAN 2.1: PENERIMA PUSH NOTIFIKASI DI HP]
// Fungsi: 
// 1. Menerima sinyal notifikasi saat HP layar mati / aplikasi tertutup
// 2. Memunculkan banner pop-up dan getaran di HP Android
// 3. Membuka halaman aplikasi saat notifikasi diketuk oleh teknisi/admin
// =========================================================================

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { 
      title: 'IKDMP Notifikasi', 
      body: event.data ? event.data.text() : 'Ada pemberitahuan baru masuk.' 
    };
  }

  const title = data.title || 'IKDMP Notifikasi';
  const options = {
    body: data.body || '',
    icon: data.icon || '/img/pwa-icon.svg',
    badge: data.badge || '/img/logo.png',
    tag: data.tag || 'ikdmp-alert',
    renotify: true,
    data: {
      url: data.url || '/'
    },
    vibrate: data.vibrate || [200, 100, 200]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) 
    ? event.notification.data.url 
    : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Jika aplikasi sudah terbuka di tab, langsung fokuskan
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // Jika aplikasi sedang tertutup total, buka aplikasi ke halaman tujuan
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
// ===================== AKHIR FILE SW.JS ==================================