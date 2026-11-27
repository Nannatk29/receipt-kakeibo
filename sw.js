// オフラインでも開けるようにするための Service Worker。
// 画面の部品は先に保存し、文字認識の大きなファイルは初回に使ったときに保存する。
const VERSION = 'v1.0.0';
const SHELL = `shell-${VERSION}`;
const OCR = 'ocr-v7.0.0';
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/scanner.js', 'js/parser.js', 'js/preprocess.js',
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== SHELL && k !== OCR).map((k) => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isOCR = url.pathname.includes('/vendor/tesseract/core/') || url.pathname.includes('/vendor/tesseract/lang/');
  if (isOCR) {
    // 大きく変わらないファイルはキャッシュ優先
    e.respondWith(caches.open(OCR).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // 画面の部品はネットワーク優先(更新をすぐ反映)、つながらなければキャッシュ
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
