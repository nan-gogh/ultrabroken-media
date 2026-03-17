/**
 * app.js
 *
 * Entry point. Detects the desired backend mode and initialises the editor.
 *
 * Mode resolution order:
 *   1. ?mode=remote in the URL (e.g. redirect from Worker /manage/editor)
 *   2. ?mode=local  in the URL (explicit override)
 *   3. localStorage 'ub-media-token' present → remote mode
 *   4. Default → local mode
 */

import { initEditor } from './editor-core.js';
import { LocalBackend } from './backend-local.js';
import { RemoteBackend } from './backend-remote.js';

const params = new URLSearchParams(location.search);
const forceMode = params.get('mode');
const urlOrigin = params.get('origin');  // From Worker redirect

// Debug: log what we read from URL params
console.log('[app.js] URL params:', { forceMode, urlOrigin, href: location.href });

let backend;

if (forceMode === 'remote' || (!forceMode && localStorage.getItem('ub-media-token'))) {
  // Priority: URL param (from Worker redirect) > localStorage > empty
  const origin = urlOrigin || localStorage.getItem('ub-media-origin') || '';
  const token  = localStorage.getItem('ub-media-token')  || '';
  
  console.log('[app.js] Remote mode detected:', { origin, hasToken: !!token });
  
  // Warn if origin is empty
  if (!origin) {
    const msg = 'Worker origin not set. Please enter it in Settings or visit via /manage/editor redirect.';
    console.warn('[app.js]', msg);
    document.body.innerHTML += `<div style="padding: 20px; color: #f85149; font-family: monospace;"><strong>⚠ ${msg}</strong></div>`;
  }
  
  // If we got origin from URL param, save it to localStorage for next time
  if (urlOrigin) localStorage.setItem('ub-media-origin', urlOrigin);
  backend = new RemoteBackend(origin, token);
} else {
  console.log('[app.js] Local mode');
  backend = new LocalBackend();
}

initEditor(backend);
