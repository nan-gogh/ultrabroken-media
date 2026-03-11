/**
 * Ultrabroken Media Worker
 *
 * Serves media files from R2 (public) and provides a management UI
 * at /manage (protected by Cloudflare Access â€” GitHub OAuth).
 *
 * Routes:
 *   GET  /manage           â†’ Management UI (upload, browse, delete)
 *   GET  /manage/api/list  â†’ JSON listing of files in a prefix
 *   POST /manage/api/upload â†’ Upload file(s) to R2
 *   POST /manage/api/delete â†’ Delete a file from R2
 *   GET  /*                 â†’ Serve file from R2 (public)
 */

const ALLOWED_PREFIXES = ["screens/", "video/", "social/"];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (raw video before transcode)

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

// â”€â”€ Public file serving â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Management API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleList(request, env) {
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") || "";
  const cursor = url.searchParams.get("cursor") || undefined;

  const listed = await env.MEDIA.list({
    prefix: prefix || undefined,
    limit: 1000,
    cursor,
    include: ['customMetadata'],
  });

  const files = listed.objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
    transcode: obj.customMetadata?.transcode || null,
    optimize: obj.customMetadata?.optimize || null,
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
  const skipWorkflow = formData.get("skipWorkflow") === "true";
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

    const putOptions = {
      httpMetadata: { contentType: value.type || getMime(key) },
    };
    if (!skipWorkflow && /\.(mp4|mov|mkv)$/i.test(key)) {
      putOptions.customMetadata = { transcode: 'pending' };
    } else if (!skipWorkflow && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(key)) {
      putOptions.customMetadata = { optimize: 'pending' };
    }
    await env.MEDIA.put(key, value.stream(), putOptions);

    results.push({ key, size: value.size, ok: true });
  }

  // Dispatch optimization/transcode workflows
  const dispatches = [];
  const videoUploaded = results.some(r => r.ok && /\.(mp4|mov|mkv)$/i.test(r.key));
  if (!skipWorkflow && videoUploaded && env.GITHUB_TOKEN) {
    const videoKeys = results.filter(r => r.ok && /\.(mp4|mov|mkv)$/i.test(r.key)).map(r => r.key);
    try {
      const resp = await fetch('https://api.github.com/repos/' + (env.GITHUB_REPO || 'nan-gogh/ultrabroken-media') + '/actions/workflows/transcode.yml/dispatches', {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + env.GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'ultrabroken-media-worker',
        },
        body: JSON.stringify({ ref: 'main', inputs: { keys: videoKeys.join(',') } }),
      });
      dispatches.push({ workflow: 'transcode', status: resp.status, ok: resp.status === 204 });
    } catch (e) {
      dispatches.push({ workflow: 'transcode', error: e.message });
    }
  }

  const imageUploaded = results.some(r => r.ok && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(r.key));
  if (!skipWorkflow && imageUploaded && env.GITHUB_TOKEN) {
    const imageKeys = results.filter(r => r.ok && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(r.key)).map(r => r.key);
    try {
      const resp = await fetch('https://api.github.com/repos/' + (env.GITHUB_REPO || 'nan-gogh/ultrabroken-media') + '/actions/workflows/optimize.yml/dispatches', {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + env.GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'ultrabroken-media-worker',
        },
        body: JSON.stringify({ ref: 'main', inputs: { keys: imageKeys.join(',') } }),
      });
      dispatches.push({ workflow: 'optimize', status: resp.status, ok: resp.status === 204 });
    } catch (e) {
      dispatches.push({ workflow: 'optimize', error: e.message });
    }
  }

  return Response.json({ results, dispatches });
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

async function handleEdit(request, env) {
  const body = await request.json();
  const { clips, output } = body;

  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return Response.json({ error: "No clips provided" }, { status: 400 });
  }

  if (!output || typeof output !== 'string') {
    return Response.json({ error: "No output name provided" }, { status: 400 });
  }

  const outputKey = output.endsWith('.webm') ? output : output + '.webm';
  if (!isValidKey(outputKey)) {
    return Response.json({ error: "Invalid output path" }, { status: 400 });
  }

  for (const clip of clips) {
    if (!clip.key || !isValidKey(clip.key)) {
      return Response.json({ error: "Invalid clip key: " + clip.key }, { status: 400 });
    }
    if (typeof clip.start !== 'number' || clip.start < 0) {
      return Response.json({ error: "Invalid start time for " + clip.key }, { status: 400 });
    }
    if (typeof clip.end !== 'number' || (clip.end !== -1 && clip.end <= clip.start)) {
      return Response.json({ error: "Invalid end time for " + clip.key }, { status: 400 });
    }
  }

  // Create placeholder so manage page shows pending badge
  await env.MEDIA.put(outputKey, new Uint8Array(0), {
    httpMetadata: { contentType: 'video/webm' },
    customMetadata: { transcode: 'pending' },
  });

  if (!env.GITHUB_TOKEN) {
    return Response.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
  }

  const editPayload = JSON.stringify({ clips, output: outputKey });

  try {
    const resp = await fetch(
      'https://api.github.com/repos/' + (env.GITHUB_REPO || 'nan-gogh/ultrabroken-media') + '/actions/workflows/edit.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + env.GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'ultrabroken-media-worker',
        },
        body: JSON.stringify({ ref: 'main', inputs: { edit: editPayload } }),
      }
    );

    if (resp.status !== 204) {
      const text = await resp.text();
      return Response.json({ error: "Workflow dispatch failed", status: resp.status, detail: text }, { status: 502 });
    }

    return Response.json({ ok: true, output: outputKey });
  } catch (e) {
    return Response.json({ error: "Dispatch failed: " + e.message }, { status: 502 });
  }
}

async function handleRename(request, env) {
  const { key, newKey } = await request.json();

  if (!isValidKey(key)) {
    return Response.json({ error: "Invalid source key" }, { status: 400 });
  }
  if (!isValidKey(newKey)) {
    return Response.json({ error: "Invalid destination key" }, { status: 400 });
  }
  if (key === newKey) {
    return Response.json({ error: "Source and destination are the same" }, { status: 400 });
  }

  const existing = await env.MEDIA.get(newKey);
  if (existing) {
    return Response.json({ error: "A file with that name already exists" }, { status: 409 });
  }

  const source = await env.MEDIA.get(key);
  if (!source) {
    return Response.json({ error: "Source file not found" }, { status: 404 });
  }

  await env.MEDIA.put(newKey, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  await env.MEDIA.delete(key);

  return Response.json({ renamed: newKey });
}

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
    if (path === "/manage/editor" || path === "/manage/editor/") {
      return new Response(EDITOR_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/manage/api/edit" && request.method === "POST") {
      return handleEdit(request, env);
    }
    if (path === "/manage/api/rename" && request.method === "POST") {
      return handleRename(request, env);
    }

    // Public file serving
    if (request.method === "GET" || request.method === "HEAD") {
      return handleGet(request, env);
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};

// â”€â”€ Inline Management UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MANAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ultrabroken Media â€” Manage</title>
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
  header { margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 20px; display: flex; align-items: center; justify-content: space-between; }
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
  .badge-transcode {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.68rem; font-family: 'JetBrains Mono', monospace;
    background: rgba(255, 170, 50, 0.15); color: #ffaa32;
    border: 1px solid rgba(255, 170, 50, 0.3);
    animation: pulse-badge 2s ease-in-out infinite;
    white-space: nowrap;
  }
  @keyframes pulse-badge {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  button.btn, a.btn {
    padding: 4px 11px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text-dim); cursor: pointer;
    font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
    transition: color 0.15s, border-color 0.15s;
    text-decoration: none; display: inline-block; line-height: 1.4;
  }
  button.btn:hover, a.btn:hover { color: var(--accent); border-color: var(--accent); }
  button.btn.danger { }
  button.btn.danger:hover { color: var(--danger); border-color: var(--danger); }

  /* Status */
  .status {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 900;
    padding: 9px 20px; border-radius: 6px;
    font-size: 0.84rem; font-family: 'JetBrains Mono', monospace;
    border-left: 3px solid; pointer-events: none; transition: opacity 0.3s; max-width: 90vw;
  }
  .status:empty { display: none; }
  .status.ok  { background: rgba(0,240,194,0.15); color: var(--success); border-color: var(--accent); }
  .status.err { background: rgba(248,81,73,0.15); color: var(--danger);  border-color: var(--danger); }

  .empty   { padding: 48px; text-align: center; color: var(--text-dim); font-size: 0.9rem; }
  .loading { padding: 24px; text-align: center; color: var(--text-dim); font-size: 0.85rem; }

  /* Preview modal */
  .preview-overlay {
    position: fixed; inset: 0; z-index: 800; background: rgba(0,0,0,0.8);
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .preview-overlay img, .preview-overlay video {
    max-width: 90vw; max-height: 85vh; border-radius: 8px; background: #000; cursor: default;
  }
  .preview-overlay .close-btn {
    position: absolute; top: 12px; right: 18px; color: var(--text);
    font-size: 1.8rem; cursor: pointer; line-height: 1; background: none; border: none;
    font-family: 'JetBrains Mono', monospace;
  }
  .preview-overlay .close-btn:hover { color: var(--accent); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent-dk); }
</style>
</head>
<body>

<header>
  <h1>Ultrabroken Archives <span class="sub">Media Vault</span></h1>
  <div style="display:flex;gap:8px;">
    <a class="btn" href="/manage/editor">Video Editor</a>
    <a class="btn" href="/cdn-cgi/access/logout">Logout</a>
  </div>
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
  <select id="prefix" onchange="switchTab(this.value)">
    <option value="screens/">screens/</option>
    <option value="video/">video/</option>
    <option value="social/">social/</option>
  </select>
  </div>
  <button class="btn danger" onclick="purgePrefix()" title="Delete ALL files in the current tab's prefix">Purge prefix&hellip;</button>
</div>

<div class="upload-zone" id="dropzone">
  <p><strong>Drop files here</strong> or click to browse</p>
  <p id="dropzoneHint" style="margin-top:6px;font-size:0.78rem;">Images only &mdash; auto-optimize to AVIF</p>
  <p style="margin-top:3px;font-size:0.72rem;color:var(--text-dim);">Max 50 MB per file &mdash; Optimization runs server-side via GitHub Actions</p>
  <input type="file" id="fileInput" multiple hidden accept="image/*">
</div>

<div id="fileListContainer">
  <div class="loading">Loading...</div>
</div>

<script>
const API = "/manage/api";
let currentPrefix = "screens/";

// â”€â”€ Tab switching â”€â”€
function switchTab(prefix) {
  currentPrefix = prefix;
  document.getElementById("prefix").value = prefix;
  document.querySelectorAll(".tabs button").forEach(b =>
    b.classList.toggle("active", b.textContent.trim() === prefix));
  const isVideo = prefix === 'video/';
  document.getElementById("fileInput").accept = isVideo ? 'video/*' : 'image/*';
  document.getElementById("dropzoneHint").textContent = isVideo
    ? 'Videos only \u2014 auto-transcode to AV1+Opus WebM'
    : 'Images only \u2014 auto-optimize to AVIF';
  loadFiles();
}

// â”€â”€ Status messages â”€â”€
let statusTimer = null;
function showStatus(msg, ok, duration) {
  const el = document.getElementById("status");
  el.className = "status " + (ok ? "ok" : "err");
  el.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ""; el.className = "status"; }, duration || 8000);
}

// â”€â”€ Load file list â”€â”€
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
      const badge = f.transcode === 'pending'
        ? '<span class="badge-transcode">\u23F3 transcoding</span>'
        : f.optimize === 'pending'
        ? '<span class="badge-transcode">\u23F3 optimizing</span>'
        : '';
      html += '<div class="file-row">'
        + '<span class="name">' + escHtml(name) + ' ' + badge + '</span>'
        + '<span class="size">' + size + '</span>'
        + '<span class="date">' + date + '</span>'
        + '<span class="actions">'
        + '  <button class="btn" onclick="previewFile(\\'' + escAttr(f.key) + '\\')">Preview</button>'
        + '  <a class="btn" href="/' + encodeURI(f.key) + '" download title="Download">&#8595;</a>'
        + '  <button class="btn" onclick="copyUrl(\\'' + escAttr(f.key) + '\\')">Copy URL</button>'
        + '  <button class="btn" onclick="renameFile(\\'' + escAttr(f.key) + '\\')">Rename</button>'
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

// â”€â”€ Upload â”€â”€
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

async function uploadFiles(rawFiles) {
  if (!rawFiles.length) return;
  const prefix = document.getElementById("prefix").value;
  const isVideo = prefix === 'video/';
  const files = Array.from(rawFiles).filter(f =>
    isVideo ? f.type.startsWith('video/') : f.type.startsWith('image/')
  );
  const rejected = rawFiles.length - files.length;
  if (rejected > 0) showStatus(rejected + ' file(s) skipped \u2014 ' + prefix + ' only accepts ' + (isVideo ? 'videos' : 'images'), false);
  if (!files.length) return;

  const form = new FormData();
  form.set("prefix", prefix);
  for (const f of files) {
    form.append("file", f);
  }

  try {
    showStatus("Uploading " + files.length + " file(s)...", true);
    const res = await fetch(API + "/upload", { method: "POST", body: form });
    const data = await res.json();
    const ok = data.results.filter(r => r.ok).length;
    const fail = data.results.filter(r => r.error);
    const videoCount = data.results.filter(r => r.ok && /\.(mp4|mov|webm|mkv)$/i.test(r.key)).length;
    const imageCount = data.results.filter(r => r.ok && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(r.key)).length;
    let msg = ok + " file(s) uploaded";
    if (imageCount) msg += " \u2014 " + imageCount + " image(s) queued for AVIF optimization";
    if (videoCount) msg += " \u2014 " + videoCount + " video(s) queued for AV1 transcode";
    if (fail.length) {
      showStatus(ok + " uploaded, " + fail.length + " failed: " + fail.map(f => f.key + " (" + f.error + ")").join(", "), false);
    } else {
      showStatus(msg, true);
    }
    loadFiles();
  } catch (e) {
    showStatus("Upload failed: " + e.message, false);
  }
  fileInput.value = "";
}

// â”€â”€ Delete â”€â”€
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

// â”€â”€ Copy URL â”€â”€
function copyUrl(key) {
  const url = location.origin + "/" + key;
  navigator.clipboard.writeText(url).then(
    () => showStatus("Copied: " + url, true),
    () => showStatus("Failed to copy URL", false)
  );
}

// â”€â”€ Purge prefix â”€â”€
async function purgePrefix() {
  if (!confirm('Delete ALL files under ' + currentPrefix + '?\\nThis cannot be undone.')) return;
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

// â”€â”€ Auto-refresh for pending transcodes â”€â”€
// -- Preview --
function previewFile(key) {
  var url = location.origin + '/' + key;
  var isVideo = /\.(mp4|mov|webm|mkv)$/i.test(key);
  var overlay = document.createElement('div');
  overlay.className = 'preview-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) document.body.removeChild(overlay); };
  var close = document.createElement('button');
  close.className = 'close-btn';
  close.innerHTML = '&times;';
  close.onclick = function() { document.body.removeChild(overlay); };
  overlay.appendChild(close);
  if (isVideo) {
    var vid = document.createElement('video');
    vid.controls = true; vid.autoplay = true; vid.src = url;
    overlay.appendChild(vid);
  } else {
    var img = document.createElement('img');
    img.src = url; img.alt = key;
    overlay.appendChild(img);
  }
  document.body.appendChild(overlay);
}

// -- Rename --
async function renameFile(key) {
  var prefix = key.substring(0, key.indexOf('/') + 1);
  var oldName = key.slice(prefix.length);
  var newName = prompt('Rename file:\n' + oldName, oldName);
  if (!newName || newName === oldName) return;
  try {
    showStatus('Renaming...', true);
    var res = await fetch(API + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, newKey: prefix + newName }),
    });
    var data = await res.json();
    if (data.renamed) { showStatus('Renamed to ' + data.renamed, true); loadFiles(); }
    else showStatus('Rename failed: ' + (data.error || 'unknown'), false);
  } catch (e) {
    showStatus('Rename failed: ' + e.message, false);
  }
}

let refreshTimer = null;
let refreshCount = 0;
const MAX_REFRESHES = 30; // stop after ~5 min
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshCount = 0;
  refreshTimer = setInterval(async () => {
    refreshCount++;
    const container = document.getElementById('fileListContainer');
    const scrollY = container.scrollTop;
    await loadFiles();
    container.scrollTop = scrollY;
    if (!document.querySelector('.badge-transcode') || refreshCount >= MAX_REFRESHES) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }, 10000);
}

// patch loadFiles to trigger auto-refresh
const _origLoadFiles = loadFiles;
loadFiles = async function() {
  await _origLoadFiles();
  if (document.querySelector('.badge-transcode')) scheduleRefresh();
};

// â”€â”€ Init â”€â”€
loadFiles();
</script>
</body>
</html>`;

// ── Inline Video Editor UI ─────────────────────────────────────────

const EDITOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ultrabroken Media \u2014 Video Editor</title>
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
  header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 20px; display: flex; align-items: center; justify-content: space-between; }
  h1 {
    font-family: 'New Rocker', serif;
    font-size: 2rem; font-weight: normal; letter-spacing: 0.04em;
    color: var(--accent); text-shadow: var(--glow);
  }
  h1 .sub { display: block; font-family: 'Texturina', Georgia, serif; font-size: 0.85rem; color: var(--text-dim); font-weight: normal; letter-spacing: 0.01em; margin-top: 2px; }

  button.btn, a.btn {
    padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text-dim); cursor: pointer;
    font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;
    transition: color 0.15s, border-color 0.15s;
    text-decoration: none; display: inline-block; line-height: 1.4;
  }
  button.btn:hover, a.btn:hover { color: var(--accent); border-color: var(--accent); }
  button.btn.primary { background: var(--accent-dk); color: var(--text); border-color: var(--accent); }
  button.btn.primary:hover { background: var(--accent); color: var(--bg); }
  button.btn.danger:hover { color: var(--danger); border-color: var(--danger); }

  .status { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 900; padding: 9px 20px; border-radius: 6px; font-size: 0.84rem; font-family: 'JetBrains Mono', monospace; border-left: 3px solid; pointer-events: none; transition: opacity 0.3s; max-width: 90vw; }
  .status:empty { display: none; }
  .status.ok { background: rgba(0,240,194,0.15); color: var(--success); border-color: var(--accent); }
  .status.err { background: rgba(248,81,73,0.15); color: var(--danger); border-color: var(--danger); }

  .section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 18px; overflow: hidden; }
  .section-header { padding: 10px 16px; border-bottom: 1px solid var(--border); font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-dim); display: flex; align-items: center; justify-content: space-between; }

  .preview { padding: 16px; text-align: center; }
  .preview video { max-width: 100%; max-height: 320px; border-radius: 6px; background: #000; }
  .preview .placeholder { padding: 60px; color: var(--text-dim); font-size: 0.85rem; }

  .library-list { max-height: 220px; overflow-y: auto; }
  .library-row { display: flex; align-items: center; padding: 7px 16px; gap: 10px; border-bottom: 1px solid var(--border); font-size: 0.78rem; }
  .library-row:last-child { border-bottom: none; }
  .library-row:hover { background: var(--surface2); }
  .library-row .name { flex: 1; font-family: 'JetBrains Mono', monospace; word-break: break-all; cursor: pointer; }
  .library-row .name:hover { color: var(--accent); }
  .library-row .size { color: var(--text-dim); font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; min-width: 60px; text-align: right; }

  .mini-upload { padding: 14px 16px; border-top: 1px solid var(--border); text-align: center; cursor: pointer; color: var(--text-dim); font-size: 0.78rem; transition: color 0.15s; }
  .mini-upload:hover { color: var(--accent); }
  .mini-upload.dragover { background: rgba(0,240,194,0.05); color: var(--accent); }

  .timeline { padding: 12px; min-height: 60px; display: flex; gap: 8px; overflow-x: auto; flex-wrap: wrap; }
  .timeline:empty::after { content: 'Add clips from the library above'; color: var(--text-dim); font-size: 0.82rem; width: 100%; text-align: center; padding: 20px; }

  .clip-card {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; min-width: 120px; max-width: 170px; flex-shrink: 0;
    cursor: grab; user-select: none; transition: border-color 0.15s, transform 0.15s;
  }
  .clip-card:active { cursor: grabbing; }
  .clip-card.selected { border-color: var(--accent); box-shadow: var(--glow); }
  .clip-card.dragging { opacity: 0.4; transform: scale(0.95); }
  .clip-card.dragover { border-color: var(--accent); border-style: dashed; }
  .clip-card .clip-name { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; color: var(--text); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clip-card .clip-mini-bar { position: relative; width: 100%; height: 6px; border-radius: 3px; background: var(--bg); margin-bottom: 4px; }
  .clip-card .clip-mini-fill { position: absolute; top: 0; height: 6px; border-radius: 3px; background: var(--accent-dk); }
  .clip-card .clip-meta { font-size: 0.65rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; margin-bottom: 4px; }
  .clip-card .clip-actions { display: flex; gap: 4px; }
  .clip-card .clip-actions button { padding: 2px 8px; font-size: 0.7rem; }

  /* Global clip editor panel */
  .clip-editor { padding: 16px; }
  .clip-editor .empty-msg { text-align: center; padding: 12px; color: var(--text-dim); font-size: 0.82rem; }
  .clip-editor .editor-info { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .clip-editor .editor-name { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--accent); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .clip-editor .editor-dur { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--text-dim); }
  .clip-editor .editor-times { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-dim); }
  .clip-editor .editor-times input[type="number"] {
    width: 68px; background: var(--bg); border: 1px solid var(--border); border-radius: 3px;
    color: var(--text); padding: 3px 6px; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
    text-align: center;
  }
  .clip-editor .editor-times input[type="number"]:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .editor-range { position: relative; width: 100%; height: 24px; border-radius: 12px; background: var(--bg); margin-bottom: 4px; }
  .editor-range input[type="range"] {
    position: absolute; top: 0; left: 0; width: 100%; height: 24px;
    -webkit-appearance: none; appearance: none; background: none; pointer-events: none; margin: 0;
  }
  .editor-range input[type="range"]::-webkit-slider-runnable-track { height: 24px; background: transparent; border-radius: 12px; }
  .editor-range input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent); border: 3px solid var(--bg); cursor: pointer;
    pointer-events: auto; margin-top: 0; position: relative; z-index: 2;
  }
  .editor-range input[type="range"]::-moz-range-track { height: 24px; background: transparent; border-radius: 12px; border: none; }
  .editor-range input[type="range"]::-moz-range-thumb {
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent); border: 3px solid var(--bg); cursor: pointer;
    pointer-events: auto;
  }
  .editor-range .range-fill {
    position: absolute; top: 0; height: 24px; background: var(--accent-dk); border-radius: 12px;
    pointer-events: none;
  }
  .clip-editor .using-label { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--text-dim); text-align: center; }

  .export-bar { padding: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .export-bar label { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-dim); }
  .export-bar input[type="text"] {
    flex: 1; min-width: 180px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); padding: 7px 12px; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;
  }
  .export-bar input[type="text"]:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .export-bar .suffix { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-dim); }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent-dk); }
</style>
</head>
<body>

<header>
  <h1>Ultrabroken Archives <span class="sub">Video Editor</span></h1>
  <a class="btn" href="/manage">&larr; Back to Manage</a>
</header>

<div id="status"></div>

<div class="section">
  <div class="section-header">Preview</div>
  <div class="preview" id="previewBox">
    <div class="placeholder">Select a clip to preview</div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span>R2 Video Library</span>
    <button class="btn" onclick="loadLibrary()" title="Refresh">&circlearrowright;</button>
  </div>
  <div class="library-list" id="libraryList">
    <div style="padding:20px;text-align:center;color:var(--text-dim);font-size:0.82rem;">Loading\u2026</div>
  </div>
  <div class="mini-upload" id="miniUpload">
    <strong>+ Upload local file</strong> (or drag here)
    <input type="file" id="localFileInput" multiple hidden accept="video/*">
  </div>
</div>

<div class="section">
  <div class="section-header">Clip Editor</div>
  <div class="clip-editor" id="clipEditor">
    <div class="empty-msg">Select a clip from the timeline to edit its range</div>
  </div>
</div>

<div class="section">
  <div class="section-header">Timeline <span id="clipCount" style="margin-left:auto;"></span></div>
  <div class="timeline" id="timeline"></div>
</div>

<div class="section">
  <div class="section-header">Export</div>
  <div class="export-bar">
    <label>Output:</label>
    <span class="suffix">video/</span>
    <input type="text" id="outputName" placeholder="my-edit" spellcheck="false">
    <span class="suffix">.webm</span>
    <button class="btn primary" onclick="doExport()">Export &rarr; AV1+Opus</button>
  </div>
</div>

<script>
var API = "/manage/api";
var BASE_URL = location.origin + "/";
var clips = [];
var nextClipId = 1;
var dragSrcIndex = null;
var selectedIndex = -1;

// ── Status ──
var statusTimer = null;
function showStatus(msg, ok, dur) {
  var el = document.getElementById("status");
  el.className = "status " + (ok ? "ok" : "err");
  el.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(function() { el.textContent = ""; el.className = "status"; }, dur || 8000);
}

// ── Library ──
async function loadLibrary() {
  var container = document.getElementById("libraryList");
  container.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim);font-size:0.82rem;">Loading\\u2026</div>';
  try {
    var allFiles = [];
    var cursor = null;
    do {
      var params = new URLSearchParams({ prefix: "video/" });
      if (cursor) params.set("cursor", cursor);
      var res = await fetch(API + "/list?" + params);
      var data = await res.json();
      allFiles = allFiles.concat(data.files);
      cursor = data.truncated ? data.cursor : null;
    } while (cursor);

    allFiles = allFiles.filter(function(f) { return f.size > 0; });

    if (allFiles.length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:0.82rem;">No videos in R2</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < allFiles.length; i++) {
      var f = allFiles[i];
      var name = f.key.replace(/^video\\//, "");
      var size = formatSize(f.size);
      var badge = f.transcode === "pending" ? ' <span style="color:#ffaa32;font-size:0.68rem;">\\u23F3</span>' : "";
      html += '<div class="library-row">'
        + '<span class="name" onclick="previewClip(\\'' + escAttr(f.key) + '\\')" title="Click to preview">' + escHtml(name) + badge + '</span>'
        + '<span class="size">' + size + '</span>'
        + '<button class="btn" onclick="addClip(\\'' + escAttr(f.key) + '\\')">+</button>'
        + '</div>';
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger);font-size:0.82rem;">Error loading library</div>';
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function escHtml(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/'/g, "\\\\'").replace(/"/g, "&quot;"); }

// ── Preview ──
function previewClip(key, startTime) {
  var box = document.getElementById("previewBox");
  var url = BASE_URL + key;
  var t = startTime || 0;
  box.innerHTML = '<video controls preload="metadata" src="' + url + '#t=' + t + '"></video>';
}

// ── Timeline ──
async function addClip(key) {
  var name = key.replace(/^video\\//, "");
  var dur = await getVideoDuration(BASE_URL + key);
  clips.push({ id: nextClipId++, key: key, name: name, start: 0, end: dur || -1, duration: dur || 0 });
  selectedIndex = clips.length - 1;
  renderTimeline();
  renderEditor();
  showStatus("Added: " + name, true, 3000);
}

function getVideoDuration(url) {
  return new Promise(function(resolve) {
    var v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = function() { resolve(Math.round(v.duration * 100) / 100); };
    v.onerror = function() { resolve(0); };
    v.src = url;
  });
}

function renderTimeline() {
  var tl = document.getElementById("timeline");
  var html = "";
  for (var i = 0; i < clips.length; i++) {
    var c = clips[i];
    var maxVal = c.duration > 0 ? c.duration : 100;
    var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
    var startPct = (c.start / maxVal * 100).toFixed(1);
    var widthPct = ((endVal - c.start) / maxVal * 100).toFixed(1);
    var trimDur = c.duration > 0 ? (endVal - c.start).toFixed(1) + "s" : "";
    var sel = i === selectedIndex ? " selected" : "";
    html += '<div class="clip-card' + sel + '" draggable="true" data-index="' + i + '" '
      + 'onclick="selectClip(' + i + ')" '
      + 'ondragstart="onDragStart(event)" ondragover="onDragOver(event)" ondrop="onDrop(event)" ondragend="onDragEnd(event)">'
      + '<div class="clip-name" title="' + escHtml(c.key) + '">' + escHtml(c.name) + '</div>'
      + '<div class="clip-mini-bar"><div class="clip-mini-fill" style="left:' + startPct + '%;width:' + widthPct + '%;"></div></div>'
      + '<div class="clip-meta">' + (trimDur || "?") + '</div>'
      + '<div class="clip-actions">'
      + '<button class="btn" onclick="event.stopPropagation();previewClip(\\'' + escAttr(c.key) + '\\', ' + c.start + ')">Preview</button>'
      + '<button class="btn danger" onclick="event.stopPropagation();removeClip(' + i + ')">&times;</button>'
      + '</div></div>';
  }
  tl.innerHTML = html;
  document.getElementById("clipCount").textContent = clips.length > 0 ? clips.length + " clip(s)" : "";
}

function selectClip(i) {
  selectedIndex = i;
  renderTimeline();
  renderEditor();
}

function renderEditor() {
  var panel = document.getElementById("clipEditor");
  if (selectedIndex < 0 || selectedIndex >= clips.length) {
    panel.innerHTML = '<div class="empty-msg">Select a clip from the timeline to edit its range</div>';
    return;
  }
  var c = clips[selectedIndex];
  var maxVal = c.duration > 0 ? c.duration : 100;
  var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  var startPct = (c.start / maxVal * 100).toFixed(1);
  var endPct = (endVal / maxVal * 100).toFixed(1);
  var trimDur = c.duration > 0 ? (endVal - c.start).toFixed(1) + "s" : "";
  var durText = c.duration > 0 ? c.duration.toFixed(1) + "s total" : "?";
  panel.innerHTML = '<div class="editor-info">'
    + '<span class="editor-name" title="' + escHtml(c.key) + '">' + escHtml(c.name) + '</span>'
    + '<span class="editor-dur">' + durText + '</span></div>'
    + '<div class="editor-times">'
    + '<input type="number" min="0" step="0.1" value="' + c.start + '" onchange="onNumIn(0,this.value)" title="Start">'
    + '<span>&rarr;</span>'
    + '<input type="number" min="0" step="0.1" value="' + endVal.toFixed(1) + '" onchange="onNumIn(1,this.value)" title="End">'
    + '</div>'
    + '<div class="editor-range">'
    + '<div class="range-fill" style="left:calc(' + (c.start / maxVal) + ' * (100% - 24px) + 12px);right:calc(' + (1 - endVal / maxVal) + ' * (100% - 24px) + 12px);"></div>'
    + '<input type="range" min="0" max="' + maxVal + '" step="0.1" value="' + c.start + '" oninput="onEditorRange(0,this.value)">'
    + '<input type="range" min="0" max="' + maxVal + '" step="0.1" value="' + endVal + '" oninput="onEditorRange(1,this.value)">'
    + '</div>'
    + '<div class="using-label">Using ' + (trimDur || "?") + '</div>';
}

function fmtTime(s) {
  var m = Math.floor(s / 60);
  var sec = (s % 60).toFixed(1);
  return m > 0 ? m + ':' + (sec < 10 ? '0' : '') + sec : sec + 's';
}

function onEditorRange(handle, val) {
  if (selectedIndex < 0 || selectedIndex >= clips.length) return;
  var v = parseFloat(val);
  if (isNaN(v)) return;
  var c = clips[selectedIndex];
  var maxVal = c.duration > 0 ? c.duration : 100;
  var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  if (handle === 0) {
    if (v >= endVal) v = Math.max(0, endVal - 0.1);
    c.start = Math.round(v * 10) / 10;
  } else {
    if (v <= c.start) v = c.start + 0.1;
    c.end = Math.round(v * 10) / 10;
    if (c.end >= maxVal) c.end = -1;
  }
  patchEditor(c, maxVal);
  patchTimelineCard(selectedIndex, c, maxVal);
}

function onNumIn(handle, val) {
  if (selectedIndex < 0 || selectedIndex >= clips.length) return;
  var v = parseFloat(val);
  if (isNaN(v)) return;
  var c = clips[selectedIndex];
  var maxVal = c.duration > 0 ? c.duration : 100;
  var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
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
  patchTimelineCard(selectedIndex, c, maxVal);
}

function patchEditor(c, maxVal) {
  var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  var startPct = (c.start / maxVal * 100).toFixed(1);
  var endPct = (endVal / maxVal * 100).toFixed(1);
  var panel = document.getElementById("clipEditor");
  var fill = panel.querySelector('.range-fill');
  if (fill) { fill.style.left = 'calc(' + (c.start / maxVal) + ' * (100% - 24px) + 12px)'; fill.style.right = 'calc(' + (1 - endVal / maxVal) + ' * (100% - 24px) + 12px)'; }
  var times = panel.querySelectorAll('.editor-times input[type="number"]');
  if (times[0]) times[0].value = c.start;
  if (times[1]) times[1].value = endVal.toFixed(1);
  var using = panel.querySelector('.using-label');
  if (using) using.textContent = 'Using ' + (c.duration > 0 ? (endVal - c.start).toFixed(1) + 's' : '?');
}

function patchTimelineCard(i, c, maxVal) {
  var card = document.querySelector('.clip-card[data-index="' + i + '"]');
  if (!card) return;
  var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
  var startPct = (c.start / maxVal * 100).toFixed(1);
  var widthPct = ((endVal - c.start) / maxVal * 100).toFixed(1);
  var bar = card.querySelector('.clip-mini-fill');
  if (bar) { bar.style.left = startPct + '%'; bar.style.width = widthPct + '%'; }
  var meta = card.querySelector('.clip-meta');
  if (meta) meta.textContent = c.duration > 0 ? (endVal - c.start).toFixed(1) + 's' : '?';
}

function removeClip(i) {
  clips.splice(i, 1);
  if (selectedIndex === i) selectedIndex = -1;
  else if (selectedIndex > i) selectedIndex--;
  renderTimeline();
  renderEditor();
}

// ── Drag to reorder ──
function onDragStart(e) {
  dragSrcIndex = parseInt(e.target.getAttribute("data-index"));
  e.target.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  var card = e.target.closest(".clip-card");
  if (card) {
    document.querySelectorAll(".clip-card").forEach(function(c) { c.classList.remove("dragover"); });
    card.classList.add("dragover");
  }
}

function onDrop(e) {
  e.preventDefault();
  var card = e.target.closest(".clip-card");
  if (!card) return;
  var targetIndex = parseInt(card.getAttribute("data-index"));
  if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
  var moved = clips.splice(dragSrcIndex, 1)[0];
  clips.splice(targetIndex, 0, moved);
  if (selectedIndex === dragSrcIndex) selectedIndex = targetIndex;
  else if (dragSrcIndex < selectedIndex && targetIndex >= selectedIndex) selectedIndex--;
  else if (dragSrcIndex > selectedIndex && targetIndex <= selectedIndex) selectedIndex++;
  renderTimeline();
}

function onDragEnd(e) {
  dragSrcIndex = null;
  document.querySelectorAll(".clip-card").forEach(function(c) {
    c.classList.remove("dragging", "dragover");
  });
}

// ── Local upload ──
var miniUploadEl = document.getElementById("miniUpload");
var localFileInput = document.getElementById("localFileInput");
miniUploadEl.addEventListener("click", function(e) {
  if (e.target === localFileInput) return;
  localFileInput.click();
});
miniUploadEl.addEventListener("dragover", function(e) { e.preventDefault(); miniUploadEl.classList.add("dragover"); });
miniUploadEl.addEventListener("dragleave", function() { miniUploadEl.classList.remove("dragover"); });
miniUploadEl.addEventListener("drop", function(e) {
  e.preventDefault();
  miniUploadEl.classList.remove("dragover");
  uploadLocalFiles(e.dataTransfer.files);
});
localFileInput.addEventListener("change", function() { uploadLocalFiles(localFileInput.files); });

async function uploadLocalFiles(rawFiles) {
  if (!rawFiles.length) return;
  var files = Array.from(rawFiles).filter(function(f) { return f.type.startsWith("video/"); });
  if (files.length === 0) { showStatus("Only video files accepted", false); return; }
  var form = new FormData();
  form.set("prefix", "video/");
  form.set("skipWorkflow", "true");
  for (var i = 0; i < files.length; i++) form.append("file", files[i]);
  try {
    showStatus("Uploading " + files.length + " file(s)\\u2026", true);
    var res = await fetch(API + "/upload", { method: "POST", body: form });
    var data = await res.json();
    var ok = data.results.filter(function(r) { return r.ok; }).length;
    showStatus(ok + " file(s) uploaded to R2", true, 5000);
    loadLibrary();
  } catch (e) {
    showStatus("Upload failed: " + e.message, false);
  }
  localFileInput.value = "";
}

// ── Export ──
async function doExport() {
  if (clips.length === 0) { showStatus("Add at least one clip to the timeline", false); return; }
  var name = document.getElementById("outputName").value.trim();
  if (!name) { showStatus("Enter an output name", false); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    showStatus("Name: letters, numbers, dashes, underscores only", false);
    return;
  }
  var outputKey = "video/" + name + ".webm";
  var payload = {
    clips: clips.map(function(c) { return { key: c.key, start: c.start, end: c.end }; }),
    output: outputKey
  };
  try {
    showStatus("Dispatching edit job\\u2026", true);
    var res = await fetch(API + "/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (data.ok) {
      showStatus("Edit dispatched! Output: " + data.output + " \\u2014 processing via GitHub Actions", true, 15000);
    } else {
      showStatus("Error: " + (data.error || "unknown"), false);
    }
  } catch (e) {
    showStatus("Export failed: " + e.message, false);
  }
}

// ── Init ──
loadLibrary();
</script>
</body>
</html>`;