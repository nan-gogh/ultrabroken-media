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

let backend;

if (forceMode === 'remote' || (!forceMode && localStorage.getItem('ub-media-token'))) {
  const origin = localStorage.getItem('ub-media-origin') || '';
  const token  = localStorage.getItem('ub-media-token')  || '';
  backend = new RemoteBackend(origin, token);
} else {
  backend = new LocalBackend();
}

initEditor(backend);
