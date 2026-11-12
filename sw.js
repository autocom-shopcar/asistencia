// Service worker: instala la app y la deja funcionar sin internet (incluidos los modelos del rostro).
const CACHE = 'asistencia-v1';
const ARCHIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'lib/face-api.esm.js',
  'modelos/tiny_face_detector_model-weights_manifest.json', 'modelos/tiny_face_detector_model.bin',
  'modelos/face_landmark_68_model-weights_manifest.json', 'modelos/face_landmark_68_model.bin',
  'modelos/face_recognition_model-weights_manifest.json', 'modelos/face_recognition_model.bin',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Modelos y librería: caché primero (pesan ~7 MB y no cambian). Lo demás: red primero.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const fijo = url.pathname.includes('/modelos/') || url.pathname.includes('/lib/');
  if (fijo) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
