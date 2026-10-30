// eddytor 서비스 워커 — 앱 껍데기와 폰트를 저장해 오프라인에서도 열리게 해요.
// 앱을 수정해서 올릴 때는 아래 버전 숫자를 올려 주세요.
const VERSION = 'eddytor-v8';
const SHELL = ['./', 'index.html', 'style.css', 'fonts.css', 'my-fonts.css', 'app.js', 'sync.js', 'ink.js', 'rec.js', 'pdf.js', 'config.js', 'manifest.webmanifest', 'icon.svg',
  'assets/star-chrome.png', 'assets/star-chrome-sm.png',
  'fonts/Pretendard-Regular.woff2', 'fonts/Pretendard-Bold.woff2', 'fonts/KoPubWorld-Dotum-Medium.woff2', 'fonts/KoPubWorld-Dotum-Bold.woff2',
  'fonts/NanumMyeongjo-Regular.woff2', 'fonts/NanumMyeongjo-Bold.woff2'];

self.addEventListener('install', e => {
  // 파일 하나가 없어도 설치가 멈추지 않게 하나씩 담아요
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;           // 서버 요청은 항상 네트워크로
  const sameOrigin = url.origin === location.origin;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      if (sameOrigin) {
        if (url.pathname.includes('/fonts/')) {                // 폰트 파일은 크고 안 바뀌니 저장본 먼저
          const hit = await cache.match(req);
          if (hit) return hit;
        }
        // 내 앱 파일: 인터넷이 되면 항상 최신 파일 → 안 되면(오프라인) 저장해 둔 것
        try {
          const res = await fetch(req, { cache: 'no-cache' });
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return (await cache.match(req, { ignoreSearch: true })) || Response.error();
        }
      }
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
