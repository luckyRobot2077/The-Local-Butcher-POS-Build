/*
 * The Local Butcher POS service worker.
 *
 * Purpose: let the installed POS open and run with no internet. It does not
 * store business data (that lives in IndexedDB) and it never queues sales;
 * sales sync is handled by the app itself when it is open (Phase 2).
 *
 * Caches:
 *  - STATIC_CACHE: content-hashed build assets (/_next/static), icons and
 *    the logo. Icons and the logo are fetched again on every install.
 *    Names are immutable, so this cache is shared across versions and old
 *    pages keep working while an update rolls out.
 *  - PAGES_CACHE: HTML for the app routes, refreshed on every online visit.
 */
const VERSION = "v10";
const STATIC_CACHE = "tlb-static";
const PAGES_CACHE = `tlb-pages-${VERSION}`;
const APP_ROUTES = ["/pos", "/pos/products", "/pos/members", "/pos/inventory", "/pos/history", "/pos/device", "/office", "/"];
const EXTRA_ASSETS = [
  "/manifest.webmanifest",
  "/icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/brand/logo.jpg",
  "/brand/logo-receipt.png",
];
const ASSET_RE = /\/_next\/static\/[^"'\s)\\]+/g;

async function precache() {
  const pages = await caches.open(PAGES_CACHE);
  const statics = await caches.open(STATIC_CACHE);
  const assets = new Set();
  for (const route of APP_ROUTES) {
    const res = await fetch(route, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error(`precache ${route}: ${res.status}`);
    const html = await res.clone().text();
    await pages.put(route, res);
    for (const m of html.matchAll(ASSET_RE)) assets.add(m[0]);
  }
  const missing = [];
  for (const url of assets) if (!(await statics.match(url))) missing.push(url);
  await statics.addAll([...missing, ...EXTRA_ASSETS]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("tlb-pages-") && k !== PAGES_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function networkFirstPage(request) {
  const url = new URL(request.url);
  const pages = await caches.open(PAGES_CACHE);
  try {
    const res = await Promise.race([fetch(request), timeout(4000)]);
    if (res.ok && APP_ROUTES.includes(url.pathname)) await pages.put(url.pathname, res.clone());
    return res;
  } catch {
    return (
      (await pages.match(url.pathname)) ||
      (await pages.match("/pos")) ||
      new Response("Offline and this page is not cached yet.", { status: 503, headers: { "Content-Type": "text/plain" } })
    );
  }
}

async function cacheFirst(request) {
  const statics = await caches.open(STATIC_CACHE);
  const hit = await statics.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await statics.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const statics = await caches.open(STATIC_CACHE);
  const hit = await statics.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res.ok) statics.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return hit || (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always live
  if (/^\/(_next\/static|icons|brand|product-art)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }
  // RSC payloads for client navigation: network only. If offline, Next.js
  // falls back to a full page load, which the navigate handler serves.
  if (request.headers.get("RSC") || url.searchParams.has("_rsc")) return;
  if (EXTRA_ASSETS.includes(url.pathname)) event.respondWith(staleWhileRevalidate(request));
});
