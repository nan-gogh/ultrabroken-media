/**
 * editor-core.js
 *
 * Shared UI logic for the video editor: timeline, clip editor (dual-range
 * trim), text overlays, drag reorder (desktop + touch), and preview.
 *
 * Backend-agnostic. Calls into a BackendAdapter (set via initEditor()) for
 * all I/O operations (listing videos, generating preview URLs, exporting).
 *
 * Exports:
 *   initEditor(backend)  — call once on page load with a BackendAdapter
 *   addClip(file)        — add a VideoFile to the timeline
 *   loadLibrary()        — (re)load the remote video list (remote mode only)
 *   doExport()           — validate and dispatch export
 *   cancelExport()       — abort an in-progress local export
 *   addOverlay()         — add a blank text overlay row
 */

// ── State ──────────────────────────────────────────────────────────────────

let backend = null;

let clips = [];
let nextClipId = 1;
let selectedIndex = -1;
let dragSrcIndex = null;

let overlays = [];
let nextOverlayId = 1;

let cancelRequested = false;

// Local library: files the user has dropped/picked, shown in the library list
// before being added to the timeline via the + button.
let localLibrary = [];  // { key, name, size, _file }

// ── Init ───────────────────────────────────────────────────────────────────

export function initEditor(b) {
  backend = b;
  applyModeUI();
  if (backend.mode === 'remote') {
    loadLibrary();
  } else {
    wireLocalPicker();
  }
  renderTimeline();
  renderOverlays();
}

function applyModeUI() {
  const isRemote = backend.mode === 'remote';

  // Mode label
  const label = document.getElementById('modeLabel');
  label.textContent = isRemote ? 'remote' : 'local';
  label.classList.toggle('remote', isRemote);

  // Source sections — local mode shows dropzone + library; remote shows library only
  document.getElementById('localPickerSection').hidden = isRemote;
  document.getElementById('librarySection').hidden = false;
  document.getElementById('libraryRefresh').hidden = !isRemote;
  document.getElementById('libraryTitle').textContent = isRemote ? 'Video Library' : 'Footage';

  // Export button label
  document.getElementById('exportBtn').textContent = isRemote
    ? 'Export → H.264+AAC'
    : 'Process → Download';

  // Warning banner for single-threaded mode
  if (!isRemote && !crossOriginIsolated) {
    showStatus('Processing in single-threaded mode — this may be slower', true, 0);
  }
}

// ── Status messages ────────────────────────────────────────────────────────

let statusTimer = null;

export function showStatus(msg, ok, duration) {
  const el = document.getElementById('status');
  el.className = 'status ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  if (duration !== 0) {
    statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, duration || 8000);
  }
}

// ── Local file picker ──────────────────────────────────────────────────────

function wireLocalPicker() {
  const dropzone = document.getElementById('dropzone');
  const input = document.getElementById('localFileInput');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    addLocalFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => {
    addLocalFiles(input.files);
    input.value = '';
  });
}

function addLocalFiles(fileList) {
  let added = 0;
  for (const file of fileList) {
    if (!file.type.startsWith('video/')) continue;
    if (localLibrary.some(f => f.key === file.name)) continue;
    localLibrary.push({ key: file.name, name: file.name, size: file.size, _file: file });
    added++;
  }
  if (added) renderLocalLibrary();
}

function renderLocalLibrary() {
  const container = document.getElementById('libraryList');
  if (!localLibrary.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:0.82rem;">Drop files above to add footage</div>';
    return;
  }
  let html = '';
  for (const f of localLibrary) {
    const name = escHtml(f.name);
    const size = formatSize(f.size);
    html += `<div class="library-row">`
      + `<span class="name" onclick="previewLocalFile(${attrJson(f.key)})" title="Click to preview">${name}</span>`
      + `<span class="size">${size}</span>`
      + `<button class="btn" onclick="addLocalClip(${attrJson(f.key)})">+</button>`
      + `</div>`;
  }
  container.innerHTML = html;
}

window.previewLocalFile = function(key) {
  const f = localLibrary.find(x => x.key === key);
  if (!f) return;
  const url = URL.createObjectURL(f._file);
  previewUrl(url, key, 0);
};

window.addLocalClip = function(key) {
  const f = localLibrary.find(x => x.key === key);
  if (!f) return;
  addClip({ key: f.key, name: f.name, _file: f._file, _local: true });
};

// ── Remote library ─────────────────────────────────────────────────────────

export async function loadLibrary() {
  const container = document.getElementById('libraryList');
  container.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim);font-size:0.82rem;">Loading…</div>';
  try {
    const files = await backend.listVideos();
    if (!files.length) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:0.82rem;">No videos in R2</div>';
      return;
    }
    let html = '';
    for (const f of files) {
      const name = f.key.replace(/^video\//, '');
      const size = formatSize(f.size);
      const badge = f.transcode === 'pending'
        ? ' <span style="color:#ffaa32;font-size:0.68rem;">⏳</span>' : '';
      html += `<div class="library-row">`
        + `<span class="name" onclick="previewByKey(${attrJson(f.key)})" title="Click to preview">${escHtml(name)}</span>${badge}`
        + `<span class="size">${size}</span>`
        + `<button class="btn" onclick="addRemoteClip(${attrJson(f.key)})">+</button>`
        + `</div>`;
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger);font-size:0.82rem;">Error loading library</div>';
  }
}

// Called from inline onclick in the library list (remote mode)
window.previewByKey = function(key) {
  const url = backend.getPreviewUrl({ key });
  previewUrl(url, key, 0);
};

window.addRemoteClip = function(key) {
  addClip({ key, name: key.replace(/^video\//, ''), _local: false });
};

// ── Preview ────────────────────────────────────────────────────────────────

function previewUrl(url, key, startTime) {
  const box = document.getElementById('previewBox');
  const t = startTime || 0;
  const v = document.createElement('video');
  v.controls = true;
  v.preload = 'metadata';
  v.src = url + '#t=' + t;
  box.replaceChildren(v);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Clip management ────────────────────────────────────────────────────────

export function addClip(file) {
  const clipId = nextClipId++;
  clips.push({ id: clipId, key: file.key, name: file.name, start: 0, end: -1, duration: 0, _file: file._file || null, _local: !!file._local });
  selectedIndex = clips.length - 1;
  renderTimeline();
  renderEditor();
  showStatus('Added: ' + file.name, true, 3000);

  const previewUrl_ = backend.getPreviewUrl(file);
  getVideoDuration(previewUrl_).then(dur => {
    for (let i = 0; i < clips.length; i++) {
      if (clips[i].id === clipId) {
        clips[i].duration = dur || 0;
        clips[i].end = dur || -1;
        break;
      }
    }
    renderTimeline();
    if (selectedIndex >= 0 && selectedIndex < clips.length && clips[selectedIndex].id === clipId) {
      renderEditor();
    }
    renderOverlayTotal();
  });
}

function getVideoDuration(url) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(Math.round(v.duration * 100) / 100);
    v.onerror = () => resolve(0);
    v.src = url;
  });
}

// ── Timeline rendering ─────────────────────────────────────────────────────

export function renderTimeline() {
  const tl = document.getElementById('timeline');
  let html = '';
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const maxVal = c.duration > 0 ? c.duration : 100;
    const endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
    const startPct = (c.start / maxVal * 100).toFixed(1);
    const widthPct = ((endVal - c.start) / maxVal * 100).toFixed(1);
    const clipDur = c.duration > 0 ? endVal - c.start : 0;
    const trimDur = c.duration > 0 ? clipDur.toFixed(1) + 's' : '';
    const timeInfo = c.duration > 0 ? fmtTime(offset) + ' → ' + fmtTime(offset + clipDur) + ' · ' : '';
    offset += clipDur;
    const sel = i === selectedIndex ? ' selected' : '';
    const keyAttr = attrJson(c.key);
    html += `<div class="clip-card${sel}" draggable="true" data-index="${i}"
        onclick="selectClip(${i})"
        ondragstart="onDragStart(event)" ondragover="onDragOver(event)"
        ondrop="onDrop(event)" ondragend="onDragEnd(event)">`
      + `<div class="clip-name" title="${escHtml(c.key)}" onclick="event.stopPropagation();previewClipAt(${keyAttr},${c.start})">${escHtml(c.name)}</div>`
      + `<div class="clip-mini-bar"><div class="clip-mini-fill" style="left:${startPct}%;width:${widthPct}%;"></div></div>`
      + `<div class="clip-meta">${timeInfo}${trimDur || '?'}</div>`
      + `<div class="clip-actions"><button class="btn danger" onclick="event.stopPropagation();removeClip(${i})">&times;</button></div>`
      + `</div>`;
  }
  tl.innerHTML = html;
  document.getElementById('clipCount').textContent = clips.length > 0 ? clips.length + ' clip(s)' : '';
  renderOverlayTotal();
}

window.selectClip = function(i) {
  selectedIndex = i;
  renderTimeline();
  renderEditor();
};

window.removeClip = function(i) {
  clips.splice(i, 1);
  if (selectedIndex === i) selectedIndex = -1;
  else if (selectedIndex > i) selectedIndex--;
  renderTimeline();
  renderEditor();
  renderOverlayTotal();
};

window.previewClipAt = function(key, startTime) {
  const clip = clips.find(c => c.key === key);
  const url = backend.getPreviewUrl(clip || { key });
  previewUrl(url, key, startTime);
};

// ── Clip editor panel ──────────────────────────────────────────────────────

export function renderEditor() {
  const panel = document.getElementById('clipEditor');
  if (selectedIndex < 0 || selectedIndex >= clips.length) {
    panel.innerHTML = '<div class="empty-msg">Select a clip from the timeline to edit its range</div>';
    return;
  }
  const c = clips[selectedIndex];
  const maxVal = c.duration > 0 ? c.duration : 100;
  const endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  const durText = c.duration > 0 ? c.duration.toFixed(1) + 's total' : '?';
  const trimDur = c.duration > 0 ? (endVal - c.start).toFixed(1) + 's' : '';
  panel.innerHTML =
    `<div class="editor-info">`
    + `<span class="editor-name" title="${escHtml(c.key)}">${escHtml(c.name)}</span>`
    + `<span class="editor-dur">${durText}</span></div>`
    + `<div class="editor-times">`
    + `<input type="number" min="0" step="0.1" value="${c.start}" onchange="onNumIn(0,this.value)" title="Start">`
    + `<span>&rarr;</span>`
    + `<input type="number" min="0" step="0.1" value="${endVal.toFixed(1)}" onchange="onNumIn(1,this.value)" title="End">`
    + `</div>`
    + `<div class="editor-range">`
    + `<div class="range-fill" style="left:calc(${c.start / maxVal} * (100% - 24px) + 12px);right:calc(${1 - endVal / maxVal} * (100% - 24px) + 12px);"></div>`
    + `<input type="range" min="0" max="${maxVal}" step="0.1" value="${c.start}" oninput="onEditorRange(0,this.value)">`
    + `<input type="range" min="0" max="${maxVal}" step="0.1" value="${endVal}" oninput="onEditorRange(1,this.value)">`
    + `</div>`
    + `<div class="using-label">Using ${trimDur || '?'}</div>`;
}

window.onEditorRange = function(handle, val) {
  if (selectedIndex < 0 || selectedIndex >= clips.length) return;
  let v = parseFloat(val);
  if (isNaN(v)) return;
  const c = clips[selectedIndex];
  const maxVal = c.duration > 0 ? c.duration : 100;
  const endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  if (handle === 0) {
    if (v >= endVal) v = Math.max(0, endVal - 0.1);
    c.start = Math.round(v * 10) / 10;
  } else {
    if (v <= c.start) v = c.start + 0.1;
    c.end = Math.round(v * 10) / 10;
    if (c.end >= maxVal) c.end = -1;
  }
  patchEditor(c, maxVal);
  renderTimeline();
};

window.onNumIn = function(handle, val) {
  if (selectedIndex < 0 || selectedIndex >= clips.length) return;
  let v = parseFloat(val);
  if (isNaN(v)) return;
  const c = clips[selectedIndex];
  const maxVal = c.duration > 0 ? c.duration : 100;
  const endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  if (handle === 0) {
    if (v < 0) v = 0;
    if (v >= endVal) v = Math.max(0, endVal - 0.1);
    c.start = Math.round(v * 10) / 10;
  } else {
    if (v <= c.start) v = c.start + 0.1;
    if (v > maxVal) v = maxVal;
    c.end = Math.round(v * 10) / 10;
    if (c.end >= maxVal) c.end = -1;
  }
  renderEditor();
  renderTimeline();
};

function patchEditor(c, maxVal) {
  const endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  const panel = document.getElementById('clipEditor');
  const fill = panel.querySelector('.range-fill');
  if (fill) {
    fill.style.left = `calc(${c.start / maxVal} * (100% - 24px) + 12px)`;
    fill.style.right = `calc(${1 - endVal / maxVal} * (100% - 24px) + 12px)`;
  }
  const times = panel.querySelectorAll('.editor-times input[type="number"]');
  if (times[0]) times[0].value = c.start;
  if (times[1]) times[1].value = endVal.toFixed(1);
  const using = panel.querySelector('.using-label');
  if (using) using.textContent = 'Using ' + (c.duration > 0 ? (endVal - c.start).toFixed(1) + 's' : '?');
}

// ── Text overlays ──────────────────────────────────────────────────────────

export function addOverlay() {
  overlays.push({ id: nextOverlayId++, text: '', start: 0, end: Math.min(3, getTotalDuration() || 3) });
  renderOverlays();
}

function renderOverlays() {
  const list = document.getElementById('overlayList');
  let html = '';
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i];
    html += `<div class="overlay-row">`
      + `<input type="text" value="${escHtml(ov.text)}" placeholder="Text…" oninput="onOverlayChange(${i},'text',this.value)">`
      + `<span class="ov-label">from</span>`
      + `<input type="number" min="0" step="0.1" value="${ov.start}" onchange="onOverlayChange(${i},'start',this.value)">`
      + `<span class="ov-label">to</span>`
      + `<input type="number" min="0" step="0.1" value="${ov.end}" onchange="onOverlayChange(${i},'end',this.value)">`
      + `<span class="ov-label">s</span>`
      + `<button class="btn danger" onclick="removeOverlay(${i})">&times;</button>`
      + `</div>`;
  }
  list.innerHTML = html;
  renderOverlayTotal();
}

window.onOverlayChange = function(i, field, val) {
  if (i < 0 || i >= overlays.length) return;
  const ov = overlays[i];
  if (field === 'text') {
    ov.text = val;
  } else {
    let v = parseFloat(val);
    if (isNaN(v) || v < 0) v = 0;
    ov[field] = Math.round(v * 10) / 10;
  }
};

window.removeOverlay = function(i) {
  overlays.splice(i, 1);
  renderOverlays();
};

function renderOverlayTotal() {
  const el = document.getElementById('overlayTotal');
  const dur = getTotalDuration();
  el.textContent = dur > 0 ? 'Total: ' + fmtTime(dur) : '';
}

function getTotalDuration() {
  let total = 0;
  for (const c of clips) {
    const maxVal = c.duration > 0 ? c.duration : 0;
    const endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
    total += endVal - c.start;
  }
  return Math.round(total * 10) / 10;
}

// ── Drag to reorder (desktop) ──────────────────────────────────────────────

window.onDragStart = function(e) {
  dragSrcIndex = parseInt(e.target.getAttribute('data-index'));
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
};

window.onDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.clip-card');
  if (card) {
    document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('dragover'));
    card.classList.add('dragover');
  }
};

window.onDrop = function(e) {
  e.preventDefault();
  const card = e.target.closest('.clip-card');
  if (!card) return;
  const targetIndex = parseInt(card.getAttribute('data-index'));
  if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
  const moved = clips.splice(dragSrcIndex, 1)[0];
  clips.splice(targetIndex, 0, moved);
  if (selectedIndex === dragSrcIndex) selectedIndex = targetIndex;
  else if (dragSrcIndex < selectedIndex && targetIndex >= selectedIndex) selectedIndex--;
  else if (dragSrcIndex > selectedIndex && targetIndex <= selectedIndex) selectedIndex++;
  renderTimeline();
};

window.onDragEnd = function(e) {
  dragSrcIndex = null;
  document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('dragging', 'dragover'));
};

// ── Touch drag to reorder (mobile) ─────────────────────────────────────────

let touchDragIndex = null;
let touchLongPress = null;
let touchDragging = false;

document.getElementById('timeline').addEventListener('touchstart', e => {
  const card = e.target.closest('.clip-card');
  if (!card) return;
  const idx = parseInt(card.getAttribute('data-index'));
  touchLongPress = setTimeout(() => {
    touchDragIndex = idx;
    touchDragging = true;
    card.classList.add('dragging');
  }, 300);
}, { passive: true });

document.getElementById('timeline').addEventListener('touchmove', e => {
  if (!touchDragging) { clearTimeout(touchLongPress); return; }
  e.preventDefault();
  const touch = e.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!el) return;
  const card = el.closest('.clip-card');
  document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('dragover'));
  if (card) card.classList.add('dragover');
}, { passive: false });

document.getElementById('timeline').addEventListener('touchend', e => {
  clearTimeout(touchLongPress);
  if (!touchDragging) return;
  const touch = e.changedTouches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const card = el ? el.closest('.clip-card') : null;
  if (card) {
    const targetIndex = parseInt(card.getAttribute('data-index'));
    if (touchDragIndex !== null && touchDragIndex !== targetIndex) {
      const moved = clips.splice(touchDragIndex, 1)[0];
      clips.splice(targetIndex, 0, moved);
      if (selectedIndex === touchDragIndex) selectedIndex = targetIndex;
      else if (touchDragIndex < selectedIndex && targetIndex >= selectedIndex) selectedIndex--;
      else if (touchDragIndex > selectedIndex && targetIndex <= selectedIndex) selectedIndex++;
      renderTimeline();
    }
  }
  touchDragIndex = null;
  touchDragging = false;
  document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('dragging', 'dragover'));
});

// ── Export ─────────────────────────────────────────────────────────────────

export async function doExport(forceOverwrite) {
  if (clips.length === 0) {
    showStatus('Add at least one clip to the timeline', false);
    return;
  }
  if (backend.mode === 'remote' && clips.length === 1 && clips[0].start <= 0 && clips[0].end === -1 && overlays.length === 0) {
    showStatus('Nothing to render — single untrimmed clip. Use Rename on the manage page instead.', false);
    return;
  }

  const name = document.getElementById('outputName').value.trim();
  if (!name) { showStatus('Enter an output name', false); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    showStatus('Name: letters, numbers, dashes, underscores only', false);
    return;
  }

  const validOverlays = overlays.filter(ov => ov.text.trim().length > 0);
  for (const ov of validOverlays) {
    if (ov.end <= ov.start) {
      showStatus(`Overlay "${ov.text.trim()}" has end (${ov.end}) ≤ start (${ov.start})`, false);
      return;
    }
  }

  const job = {
    clips: clips.map(c => ({ key: c.key, start: c.start, end: c.end, _file: c._file || null })),
    overlays: validOverlays.map(ov => ({ text: ov.text.trim(), start: ov.start, end: ov.end })),
    outputKey: 'video/' + name + '.mp4',
    force: !!forceOverwrite,
  };

  try {
    if (backend.mode === 'local') {
      await runLocalExport(job, name);
    } else {
      await runRemoteExport(job, name, forceOverwrite);
    }
  } catch (e) {
    showStatus('Export failed: ' + e.message, false);
    setProgress(false);
  }
}

async function runLocalExport(job, name) {
  cancelRequested = false;
  setProgress(true, 0);
  showStatus('Processing…', true, 0);

  const result = await backend.execute(job, (ratio) => {
    if (cancelRequested) throw new Error('cancelled');
    setProgress(true, ratio);
  });

  setProgress(false);
  if (!result) return; // cancelled

  // Trigger browser download
  const url = URL.createObjectURL(result);
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.mp4';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  showStatus('Done! Downloading ' + name + '.mp4', true);
}

async function runRemoteExport(job, name, forceOverwrite) {
  showStatus('Dispatching edit job…', true, 0);
  const data = await backend.execute(job);
  if (data.ok) {
    showStatus('Edit dispatched! Output: ' + data.output + ' — processing via GitHub Actions', true, 15000);
  } else if (data.error === 'exists') {
    if (confirm(name + '.mp4 already exists in video storage.\nOverwrite it?')) {
      doExport(true);
    }
  } else {
    showStatus('Error: ' + (data.error || 'unknown'), false);
  }
}

export function cancelExport() {
  cancelRequested = true;
}

function setProgress(visible, ratio) {
  const wrap = document.getElementById('progressWrap');
  const bar = document.getElementById('progressBar');
  const label = document.getElementById('progressLabel');
  wrap.hidden = !visible;
  if (visible) {
    const pct = Math.round((ratio || 0) * 100);
    bar.style.width = pct + '%';
    label.textContent = pct + '%';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? m + ':' + (sec < 10 ? '0' : '') + sec : sec + 's';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// JSON-encode a value for safe embedding inside an HTML attribute delimited by
// double quotes.  JSON.stringify produces double-quoted strings; those inner
// quotes must be escaped as &quot; so the HTML parser doesn't end the attribute
// early, which would truncate the JS expression and cause a SyntaxError.
function attrJson(v) {
  return JSON.stringify(v).replace(/"/g, '&quot;');
}

// Expose to global scope for inline onclick handlers that reference these
window.addOverlay = addOverlay;
window.doExport = doExport;
window.cancelExport = cancelExport;
window.loadLibrary = loadLibrary;
