/**
 * Ultrabroken Media Worker
 *
 * Serves media files from R2 (public) and provides a management UI
 * at /manage (protected by Cloudflare Access — GitHub OAuth).
 *
 * Routes:
 *   GET  /manage           → Management UI (upload, browse, delete)
 *   GET  /manage/api/list  → JSON listing of files in a prefix
 *   POST /manage/api/upload → Upload file(s) to R2
 *   POST /manage/api/delete → Delete a file from R2
 *   GET  /*                 → Serve file from R2 (public)
 */

const ALLOWED_PREFIXES = ["screens/", "video/", "social/"];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const MIME_TYPES = {
  avif: "image/avif",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  svg: "image/svg+xml",
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function getMime(key) {
  const ext = key.split(".").pop().toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Validate that a key sits under an allowed prefix and contains no traversal.
 */
function isValidKey(key) {
  if (!key || key.includes("..") || key.startsWith("/")) return false;
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

// ── Public file serving ─────────────────────────────────────────────

async function handleGet(request, env) {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.slice(1)); // strip leading /

  if (!key || key === "") {
    return new Response("ultrabroken-media", { status: 200 });
  }

  const object = await env.MEDIA.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("Content-Type", getMime(key));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
}

// ── Management API ──────────────────────────────────────────────────

async function handleList(request, env) {
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") || "";
  const cursor = url.searchParams.get("cursor") || undefined;

  const listed = await env.MEDIA.list({
    prefix: prefix || undefined,
    limit: 1000,
    cursor,
  });

  const files = listed.objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
  }));

  return Response.json({
    files,
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  });
}

async function handleUpload(request, env) {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const prefix = formData.get("prefix") || "";
  const results = [];

  for (const [fieldName, value] of formData.entries()) {
    if (fieldName === "prefix") continue;
    if (!(value instanceof File)) continue;

    const key = prefix ? `${prefix}${value.name}` : value.name;

    if (!isValidKey(key)) {
      results.push({ key, error: `Invalid path. Must start with: ${ALLOWED_PREFIXES.join(", ")}` });
      continue;
    }

    if (value.size > MAX_FILE_SIZE) {
      results.push({ key, error: `File too large (${(value.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)` });
      continue;
    }

    await env.MEDIA.put(key, value.stream(), {
      httpMetadata: { contentType: value.type || getMime(key) },
    });

    results.push({ key, size: value.size, ok: true });
  }

  return Response.json({ results });
}

async function handleDelete(request, env) {
  const { key } = await request.json();

  if (!isValidKey(key)) {
    return Response.json({ error: "Invalid key" }, { status: 400 });
  }

  await env.MEDIA.delete(key);
  return Response.json({ deleted: key });
}

async function handlePurge(request, env) {
  const { prefix } = await request.json();

  if (!prefix || !ALLOWED_PREFIXES.some((p) => prefix === p || prefix.startsWith(p))) {
    return Response.json({ error: "Invalid prefix" }, { status: 400 });
  }

  let deleted = 0;
  let cursor;
  do {
    const listed = await env.MEDIA.list({ prefix, limit: 1000, cursor });
    await Promise.all(listed.objects.map((obj) => env.MEDIA.delete(obj.key)));
    deleted += listed.objects.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return Response.json({ purged: prefix, deleted });
}

// ── Router ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Management routes (protected by Cloudflare Access at the edge)
    if (path === "/manage" || path === "/manage/") {
      return new Response(MANAGE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/manage/api/list" && request.method === "GET") {
      return handleList(request, env);
    }
    if (path === "/manage/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }
    if (path === "/manage/api/delete" && request.method === "POST") {
      return handleDelete(request, env);
    }
    if (path === "/manage/api/purge" && request.method === "POST") {
      return handlePurge(request, env);
    }

    // Public file serving
    if (request.method === "GET" || request.method === "HEAD") {
      return handleGet(request, env);
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};

// ── Inline Management UI ────────────────────────────────────────────

const MANAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ultrabroken Media — Manage</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=New+Rocker&family=Texturina:ital,opsz,wght@0,12..44,100..900;1,12..44,100..900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:        #0f1117;
    --surface:   #1a1f2e;
    --surface2:  #222736;
    --border:    rgba(255,255,255,0.1);
    --text:      #e0e4ee;
    --text-dim:  #8b8fa8;
    --accent:    #00f0c2;
    --accent-dk: #00796b;
    --danger:    #f85149;
    --success:   #00f0c2;
    --glow:      0 0 12px rgba(0,240,194,0.25);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Texturina', Georgia, serif;
    background: var(--bg); color: var(--text);
    max-width: 980px; margin: 0 auto; padding: 32px 20px;
    background-image: radial-gradient(ellipse at 50% 0%, rgba(0,121,107,0.12) 0%, transparent 60%);
    min-height: 100vh;
  }

  /* Header */
  header { margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 20px; }
  h1 {
    font-family: 'New Rocker', serif;
    font-size: 2rem; font-weight: normal; letter-spacing: 0.04em;
    color: var(--accent);
    text-shadow: var(--glow);
  }
  h1 .sub {
    display: block; font-family: 'Texturina', Georgia, serif;
    font-size: 0.85rem; color: var(--text-dim); font-weight: normal;
    letter-spacing: 0.01em; margin-top: 2px;
  }

  /* Tabs */
  .tabs { display: flex; gap: 0; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
  .tabs button {
    padding: 9px 22px;
    border: 1px solid transparent; border-bottom: none;
    background: transparent; color: var(--text-dim); cursor: pointer;
    font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;
    border-radius: 6px 6px 0 0;
    transition: color 0.15s, background 0.15s;
    position: relative; bottom: -1px;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.active {
    background: var(--surface); color: var(--accent);
    border-color: var(--border); border-bottom-color: var(--surface);
  }

  /* Upload zone */
  .upload-zone {
    border: 2px dashed var(--border); border-radius: 8px; padding: 44px;
    text-align: center; cursor: pointer;
    transition: border-color 0.2s, box-shadow 0.2s;
    margin-bottom: 18px; background: var(--surface);
  }
  .upload-zone:hover, .upload-zone.dragover {
    border-color: var(--accent);
    box-shadow: var(--glow);
  }
  .upload-zone p { color: var(--text-dim); font-size: 0.9rem; }
  .upload-zone p strong { color: var(--accent); }

  /* Prefix selector */
  .prefix-bar { display: flex; gap: 10px; margin-bottom: 18px; align-items: center; }
  .prefix-bar label { color: var(--text-dim); font-size: 0.82rem; font-family: 'JetBrains Mono', monospace; }
  .prefix-bar select {
    background: var(--surface); color: var(--accent); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 4px;
    font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;
    cursor: pointer;
  }
  .prefix-bar select:focus { outline: 1px solid var(--accent); }

  /* File list */
  .file-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
  .file-row {
    display: flex; align-items: center; padding: 10px 16px; gap: 12px;
    border-bottom: 1px solid var(--border); font-size: 0.82rem;
    transition: background 0.1s;
  }
  .file-row:last-child { border-bottom: none; }
  .file-row:hover { background: var(--surface2); }
  .file-row .name { flex: 1; word-break: break-all; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text); }
  .file-row .size { color: var(--text-dim); min-width: 72px; text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
  .file-row .date { color: var(--text-dim); min-width: 92px; text-align: right; font-size: 0.75rem; }
  .file-row .actions { display: flex; gap: 6px; }

  button.btn {
    padding: 4px 11px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text-dim); cursor: pointer;
    font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
    transition: color 0.15s, border-color 0.15s;
  }
  button.btn:hover { color: var(--accent); border-color: var(--accent); }
  button.btn.danger { }
  button.btn.danger:hover { color: var(--danger); border-color: var(--danger); }

  /* Status */
  .status {
    padding: 9px 14px; border-radius: 6px; margin-bottom: 14px;
    font-size: 0.84rem; font-family: 'JetBrains Mono', monospace;
    border-left: 3px solid;
  }
  .status.ok  { background: rgba(0,240,194,0.07); color: var(--success); border-color: var(--accent); }
  .status.err { background: rgba(248,81,73,0.08); color: var(--danger);  border-color: var(--danger); }

  .empty   { padding: 48px; text-align: center; color: var(--text-dim); font-size: 0.9rem; }
  .loading { padding: 24px; text-align: center; color: var(--text-dim); font-size: 0.85rem; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent-dk); }
</style>
</head>
<body>

<header>
  <h1>Ultrabroken Archives <span class="sub">Media Asset Manager</span></h1>
</header>

<div class="tabs">
  <button class="active" onclick="switchTab('screens/')">screens/</button>
  <button onclick="switchTab('video/')">video/</button>
  <button onclick="switchTab('social/')">social/</button>
</div>

<div id="status"></div>

<div class="prefix-bar" style="justify-content:space-between;">
  <div style="display:flex;gap:10px;align-items:center;">
  <label>Upload to:</label>
  <select id="prefix">
    <option value="screens/">screens/</option>
    <option value="video/">video/</option>
    <option value="social/">social/</option>
  </select>
  </div>
  <button class="btn danger" onclick="purgePrefix()" title="Delete ALL files in the current tab's prefix">Purge prefix&hellip;</button>
</div>

<div class="upload-zone" id="dropzone">
  <p><strong>Drop files here</strong> or click to browse</p>
  <p style="margin-top:6px;font-size:0.78rem;">Max 25 MB per file &mdash; AVIF, WebP, PNG, WebM&hellip;</p>
  <input type="file" id="fileInput" multiple hidden>
</div>

<div id="fileListContainer">
  <div class="loading">Loading...</div>
</div>

<script>
const API = "/manage/api";
let currentPrefix = "screens/";

// ── Tab switching ──
function switchTab(prefix) {
  currentPrefix = prefix;
  document.getElementById("prefix").value = prefix;
  document.querySelectorAll(".tabs button").forEach(b =>
    b.classList.toggle("active", b.textContent.trim() === prefix));
  loadFiles();
}

// ── Status messages ──
function showStatus(msg, ok) {
  const el = document.getElementById("status");
  el.className = "status " + (ok ? "ok" : "err");
  el.textContent = msg;
  setTimeout(() => el.textContent = "", 5000);
}

// ── Load file list ──
async function loadFiles() {
  const container = document.getElementById("fileListContainer");
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    let allFiles = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({ prefix: currentPrefix });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(API + "/list?" + params);
      const data = await res.json();
      allFiles = allFiles.concat(data.files);
      cursor = data.truncated ? data.cursor : null;
    } while (cursor);

    if (allFiles.length === 0) {
      container.innerHTML = '<div class="empty">No files in ' + currentPrefix + '</div>';
      return;
    }

    let html = '<div class="file-list">';
    for (const f of allFiles) {
      const name = f.key.slice(currentPrefix.length);
      const size = formatSize(f.size);
      const date = new Date(f.uploaded).toLocaleDateString();
      html += '<div class="file-row">'
        + '<span class="name">' + escHtml(name) + '</span>'
        + '<span class="size">' + size + '</span>'
        + '<span class="date">' + date + '</span>'
        + '<span class="actions">'
        + '  <button class="btn" onclick="copyUrl(\\'' + escAttr(f.key) + '\\')">Copy URL</button>'
        + '  <button class="btn danger" onclick="deleteFile(\\'' + escAttr(f.key) + '\\')">Delete</button>'
        + '</span></div>';
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="empty">Error loading files</div>';
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function escHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/'/g, "\\\\'").replace(/"/g, "&quot;"); }

// ── Upload ──
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

async function uploadFiles(files) {
  if (!files.length) return;
  const prefix = document.getElementById("prefix").value;
  const form = new FormData();
  form.set("prefix", prefix);
  for (const f of files) form.append("file", f);

  try {
    showStatus("Uploading " + files.length + " file(s)...", true);
    const res = await fetch(API + "/upload", { method: "POST", body: form });
    const data = await res.json();
    const ok = data.results.filter(r => r.ok).length;
    const fail = data.results.filter(r => r.error);
    if (fail.length) {
      showStatus(ok + " uploaded, " + fail.length + " failed: " + fail.map(f => f.key + " (" + f.error + ")").join(", "), false);
    } else {
      showStatus(ok + " file(s) uploaded", true);
    }
    loadFiles();
  } catch (e) {
    showStatus("Upload failed: " + e.message, false);
  }
  fileInput.value = "";
}

// ── Delete ──
async function deleteFile(key) {
  if (!confirm("Delete " + key + "?")) return;
  try {
    const res = await fetch(API + "/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (data.deleted) { showStatus("Deleted " + key, true); loadFiles(); }
    else showStatus("Failed to delete: " + (data.error || "unknown"), false);
  } catch (e) {
    showStatus("Delete failed: " + e.message, false);
  }
}

// ── Copy URL ──
function copyUrl(key) {
  const url = location.origin + "/" + key;
  navigator.clipboard.writeText(url).then(
    () => showStatus("Copied: " + url, true),
    () => showStatus("Failed to copy URL", false)
  );
}

// ── Purge prefix ──
async function purgePrefix() {
  if (!confirm('Delete ALL files under ' + currentPrefix + '?\nThis cannot be undone.')) return;
  try {
    showStatus('Purging ' + currentPrefix + '...', true);
    const res = await fetch(API + '/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: currentPrefix }),
    });
    const data = await res.json();
    if (data.purged !== undefined) {
      showStatus('Purged ' + data.deleted + ' file(s) from ' + data.purged, true);
      loadFiles();
    } else {
      showStatus('Purge failed: ' + (data.error || 'unknown'), false);
    }
  } catch (e) {
    showStatus('Purge failed: ' + e.message, false);
  }
}

// ── Init ──
loadFiles();
</script>
</body>
</html>`;
