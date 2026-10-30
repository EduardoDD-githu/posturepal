// Service worker de PosturePal: guarda la app en el dispositivo para que
// funcione sin internet después de la primera visita.
// Si cambias archivos de la app, sube el número de versión para forzar la actualización.
const CACHE = "posturepal-v6";

const APP_SHELL = [
  "./",
  "index.html",
  "css/styles.css",
  "js/app.js",
  "js/charts.js",
  "js/demo.js",
  "fonts/space-grotesk.woff2",
  "fonts/jetbrains-mono.woff2",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png",
  "vendor/mediapipe/vision_bundle.mjs",
  "models/pose_landmarker_lite.task",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function saveCopy(req, res) {
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

// Archivos pesados que no cambian (modelo, WebAssembly, fuentes): primero la caché.
// Así el .wasm que use cada equipo queda guardado sin bajar las dos variantes.
// Código de la app (HTML, CSS, JS): primero la red, para ver siempre la última versión;
// la caché solo se usa si no hay internet.
const HEAVY = /\/(vendor|models|fonts)\//;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (HEAVY.test(url.pathname)) {
    event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => saveCopy(req, res))));
  } else {
    event.respondWith(fetch(req).then((res) => saveCopy(req, res)).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
