/* The Home Hive — service worker.
 *
 * This sits behind Cloudflare Access, which changes what a "failed" request
 * means. An expired session answers with a redirect to a login page on another
 * origin; a same-origin `fetch` told to follow that redirect gets a network
 * error, not a response. Two rules follow, and breaking either one produced a
 * genuinely confusing bug:
 *
 *   1. NEVER substitute the app shell for a non-navigation request. The first
 *      version fell back to caches.match("/") for everything, so a failed
 *      fetch of /weeks/index.json returned index.html with status 200 and the
 *      app parsed a web page as JSON. It rendered an empty skeleton and looked
 *      like a data bug for as long as it took to check the response URL.
 *
 *   2. NEVER serve a cached page when the network is asking for a login. Doing
 *      that leaves an unauthenticated tab looking authenticated, running old
 *      code against data it cannot fetch.
 *
 * The cache exists for genuine offline use — a bad signal in the school pickup
 * line — and for nothing else.
 */

const CACHE = "hive-v8";   // v8: HIVE-01 voice and song pack
const SHELL = [
  "/",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin, 200, not a redirect. `redirected` is the Access tell: a response
// that arrived via a login round-trip is a login page wearing the URL we asked
// for, and caching it bricks the installed app until someone clears storage.
function cacheable(res){
  return res && res.ok && res.status === 200 && !res.redirected && res.type === "basic";
}

function put(req, res){
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // YouTube, fonts — leave alone
  if (url.pathname.startsWith("/api/")) return;      // always live, never stored
  if (url.pathname.startsWith("/cdn-cgi/")) return;  // Cloudflare Access's own assets

  // Icons and audio never change without a filename change — voice clips and
  // songs are named after a hash of their content — so cache first, cheaply.
  // The manifests are the exception: they're the thing that names the new
  // files, so they have to come off the network or a regenerated pack never
  // arrives.
  if (url.pathname.startsWith("/icons/") ||
      (url.pathname.startsWith("/audio/") &&
       url.pathname !== "/audio/vo/index.json" &&
       url.pathname !== "/audio/songs/index.json")) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (cacheable(res)) put(req, res);
        return res;
      }))
    );
    return;
  }

  // Navigations. Whatever the network says goes — including "log in first",
  // which must reach the browser so it can follow Access. The cached shell is
  // only for a request that never got an answer at all.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => { if (cacheable(res)) put(req, res); return res; })
        .catch(() => caches.match(req).then(hit => hit || caches.match("/")))
    );
    return;
  }

  // Everything else — app.js, app.css, week JSON. Network first so a deploy is
  // never one load behind, cache only as a real offline fallback, and a miss is
  // an honest failure rather than a page of HTML pretending to be data.
  e.respondWith(
    fetch(req)
      .then(res => { if (cacheable(res)) put(req, res); return res; })
      .catch(() => caches.match(req).then(hit => hit || new Response(
        JSON.stringify({ error: "offline", path: url.pathname }),
        { status: 503, headers: { "content-type": "application/json" } }
      )))
  );
});
