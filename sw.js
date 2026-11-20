/* Share to Lichess — service worker.
 *
 * Share target: receive a shared image (Web Share Target POST to the exact
 * ./share pathname), validate it, stash it in Cache Storage under a UNIQUE
 * key, and 303-redirect to ./?shared=<key>. A reload never re-submits.
 * The page deletes the entry immediately after reading it, and this worker
 * also sweeps shared images older than 60 seconds on activate and on
 * every new share. Cache Storage is origin-scoped, so unique keys plus
 * immediate deletion are what keep one user's share from leaking into
 * another repo on the same origin.
 *
 * Also precaches the app shell, the fenshot model and the onnxruntime
 * wasm files on install (all self-hosted, nothing from a CDN).
 * All non-share requests pass through to the network untouched.
 */
const CACHE_NAME = "share-to-lichess";
const SHARED_PREFIX = "shared-";
const MAX_SHARED_AGE_MS = 60 * 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./worker.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./models/chess-tiles-v2.onnx",
  "./ort/ort.wasm.min.mjs",
  "./ort/ort-wasm-simd-threaded.mjs",
  "./ort/ort-wasm-simd-threaded.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const path of PRECACHE) {
        try {
          await cache.add(scopeUrl(path));
        } catch (err) {
          // One missing asset must not break the install; the page
          // fetches it from the network instead.
          console.warn("precache failed for", path, err);
        }
      }
      await self.skipWaiting();
    })(),
  );
});

// Delete shared-image entries older than 60s. Keys are
// "shared-<epochMillis>-<random>", so the age is in the key.
async function sweepShared() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const now = Date.now();
    for (const req of keys) {
      const key = req.url.split("/").pop();
      if (!key || !key.startsWith(SHARED_PREFIX)) continue;
      const stamp = Number(key.slice(SHARED_PREFIX.length).split("-")[0]);
      if (!Number.isFinite(stamp) || now - stamp > MAX_SHARED_AGE_MS) {
        await cache.delete(req);
      }
    }
  } catch (err) {
    console.warn("shared sweep failed", err);
  }
}

async function deleteOlderShared(keepKey) {
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const req of await cache.keys()) {
      const key = req.url.split("/").pop();
      if (key && key.startsWith(SHARED_PREFIX) && key !== keepKey) {
        await cache.delete(req);
      }
    }
  } catch (err) {
    console.warn("shared cleanup failed", err);
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await sweepShared();
    await self.clients.claim();
  })());
});

// Magic-byte sniffing: MIME types from a share intent are not trustworthy.
function looksLikeImage(bytes) {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true; // PNG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true; // WebP
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true; // GIF
  return false;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "POST") return;
  let sharePath;
  try {
    sharePath = new URL("./share", self.registration.scope).pathname;
  } catch {
    return;
  }
  // Match ONLY the exact share pathname. Nothing else is intercepted.
  if (new URL(event.request.url).pathname !== sharePath) return;

  event.respondWith(
    (async () => {
      try {
        const formData = await event.request.formData();
        const file = formData.get("image");
        // Empty body: the unconfirmed Chromium bug on Android 17 / Chrome
        // 153 can deliver a share with no file at all. Send the user to
        // the picker instead of failing silently.
        if (!file || !(file instanceof Blob) || file.size === 0) {
          return Response.redirect("./?shared=empty", 303);
        }
        if (file.size > MAX_FILE_BYTES) {
          return Response.redirect("./?shared=error", 303);
        }
        if (file.type && !file.type.startsWith("image/")) {
          return Response.redirect("./?shared=error", 303);
        }
        const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        if (!looksLikeImage(head)) {
          return Response.redirect("./?shared=error", 303);
        }
        const key = `${SHARED_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const cache = await caches.open(CACHE_NAME);
        await deleteOlderShared(key); // cap to one shared entry
        await sweepShared();
        // Cache keys must be URLs: store under scope + key.
        await cache.put(new URL(key, self.registration.scope).href, new Response(file));
        return Response.redirect(`./?shared=${encodeURIComponent(key)}`, 303);
      } catch (err) {
        console.warn("share handling failed", err);
        return Response.redirect("./?shared=error", 303);
      }
    })(),
  );
});
