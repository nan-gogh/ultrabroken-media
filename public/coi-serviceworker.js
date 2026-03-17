/**
 * coi-serviceworker.js
 *
 * Injects Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 * via a Service Worker, enabling SharedArrayBuffer on GitHub Pages (which
 * cannot set HTTP response headers natively).
 *
 * SharedArrayBuffer is required for FFmpeg.wasm multi-threaded mode.
 *
 * On first load:
 *   1. SW registers itself.
 *   2. Page reloads (once) so the SW intercepts all subsequent fetches.
 *   3. SW adds COOP + COEP headers to every response.
 *   4. crossOriginIsolated === true → FFmpeg.wasm uses SharedArrayBuffer.
 *
 * Subsequent loads: SW is already active, no reload needed.
 *
 * Based on the widely-used coi-serviceworker pattern:
 * https://github.com/nickspaargaren/coi-serviceworker
 */

/* ── Service Worker scope ────────────────────────────────────────────────── */

if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', e => {
    // Only intercept same-origin requests; let cross-origin pass through.
    if (e.request.url.startsWith(self.location.origin)) {
      e.respondWith(
        fetch(e.request).then(response => {
          // Don't modify opaque or error responses
          if (!response || response.status === 0 || response.type === 'opaque') {
            return response;
          }
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
      );
    }
  });
}

/* ── Page scope ──────────────────────────────────────────────────────────── */

// Registration is handled inline in index.html with a known literal path.
// This file only needs to run as a Service Worker (see ServiceWorkerGlobalScope
// block above).
