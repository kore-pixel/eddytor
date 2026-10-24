// 별문서 서비스 워커 — 앱 껍데기를 저장해 오프라인에서도 열리게 해요.
// 앱을 수정해서 올릴 때는 아래 버전 숫자를 올려 주세요.
const VERSION = 'byeol-v5';
const SHELL = ['./', 'index.html', 'style.css', 'my-fonts.css', 'assets/star.png', 'assets/deco.png', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;           // 공유 서버 요청은 항상 네트워크로
  const sameOrigin = url.origin === location.origin;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      if (sameOrigin) {
        // 내 앱 파일: 인터넷이 되면 항상 최신 파일 → 안 되면(오프라인) 저장해 둔 것
        try {
          const res = await fetch(req, { cache: 'no-cache' });
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return (await cache.match(req, { ignoreSearch: true })) || Response.error();
        }
      }
      // 폰트 같은 외부 파일: 저장본 먼저, 뒤에서 갱신
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
