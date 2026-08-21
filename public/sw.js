// Service Worker — offline-stöd för Lager PWA
const CACHE = "lager-v2";
const STATIC = ["/", "/index.html"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  // Cacha bara vanliga http/https-förfrågningar — webbläsartillägg kan
  // trigga fetch-events för egna interna adresser (t.ex. chrome-extension://),
  // och Cache-API:et stödjer inte att spara sådana, bara krasch om vi försöker.
  if (!e.request.url.startsWith("http")) return;

  const url = new URL(e.request.url);

  // API-anrop — alltid nätverket, aldrig cache
  if (url.pathname.includes("/api/")) return;

  // Sidladdningar (navigation) — t.ex. att öppna eller ladda om appen,
  // ELLER en delad länk som /?item=ID. Dessa ska ALLTID hämtas färskt
  // från nätverket i första hand, ALDRIG serveras från en cachad "/"
  // som skulle strippa bort länkparametern. Cachen används bara som
  // sista utväg om nätverket är helt otillgängligt (offline).
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Statiska filer (JS/CSS/bilder) — cache-first med nätverk som fallback,
  // och uppdaterar cachen i bakgrunden. Dessa har unika, versionerade
  // filnamn (byggverktyget lägger till en hash), så det är säkert att
  // cacha dem aggressivt — en gammal fil skrivs aldrig över med fel data.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
