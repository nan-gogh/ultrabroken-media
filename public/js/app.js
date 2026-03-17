/**
 * app.js
 *
 * Entry point. Detects the desired backend mode and initialises the editor.
 *
 * Mode detection:
 *   - Served from /manage/editor/* (Worker proxy)  →  remote mode
 *     CF Access cookie authenticates all API calls automatically.
 *   - Served from GitHub Pages (or anywhere else)   →  local mode
 *     No network calls; processing via FFmpeg.wasm in the browser.
 */

import { initEditor } from './editor-core.js';
import { LocalBackend } from './backend-local.js';
import { RemoteBackend } from './backend-remote.js';

const isRemote = location.pathname.startsWith('/manage/editor');
const backend = isRemote ? new RemoteBackend() : new LocalBackend();

initEditor(backend);
