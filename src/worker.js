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
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-dim: #8b949e; --accent: #58a6ff;
    --danger: #f85149; --success: #3fb950;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text);
    max-width: 960px; margin: 0 auto; padding: 24px 16px;
  }
  h1 { font-size: 1.4rem; margin-bottom: 20px; }
  h1 span { color: var(--text-dim); font-weight: normal; font-size: 0.85rem; }

  /* Tabs */
  .tabs { display: flex; gap: 2px; margin-bottom: 20px; }
  .tabs button {
    padding: 8px 20px; border: 1px solid var(--border); border-bottom: none;
    background: var(--surface); color: var(--text-dim); cursor: pointer;
    border-radius: 6px 6px 0 0; font-size: 0.9rem;
  }
  .tabs button.active { background: var(--bg); color: var(--text); border-bottom: 1px solid var(--bg); }

  /* Upload zone */
  .upload-zone {
    border: 2px dashed var(--border); border-radius: 8px; padding: 40px;
    text-align: center; cursor: pointer; transition: border-color 0.2s;
    margin-bottom: 16px;
  }
  .upload-zone.dragover { border-color: var(--accent); }
  .upload-zone p { color: var(--text-dim); }

  /* Prefix selector */
  .prefix-bar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
  .prefix-bar label { color: var(--text-dim); font-size: 0.85rem; }
  .prefix-bar select {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 6px 10px; border-radius: 4px; font-size: 0.85rem;
  }

  /* File list */
  .file-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .file-row {
    display: flex; align-items: center; padding: 10px 14px; gap: 12px;
    border-bottom: 1px solid var(--border); font-size: 0.85rem;
  }
  .file-row:last-child { border-bottom: none; }
  .file-row .name { flex: 1; word-break: break-all; }
  .file-row .size { color: var(--text-dim); min-width: 70px; text-align: right; }
  .file-row .date { color: var(--text-dim); min-width: 90px; text-align: right; }
  .file-row .actions { display: flex; gap: 6px; }
  .file-row:hover { background: var(--surface); }

  button.btn {
    padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); cursor: pointer; font-size: 0.8rem;
  }
  button.btn:hover { border-color: var(--accent); }
  button.btn.danger { color: var(--danger); }
  button.btn.danger:hover { border-color: var(--danger); }

  .status { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 0.85rem; }
  .status.ok { background: #0d1f0d; color: var(--success); }
  .status.err { background: #1f0d0d; color: var(--danger); }

  .empty { padding: 40px; text-align: center; color: var(--text-dim); }
  .loading { padding: 20px; text-align: center; color: var(--text-dim); }
</style>
</head>
<body>

<h1>Ultrabroken Media <span>— Asset Manager</span></h1>

<div class="tabs">
  <button class="active" onclick="switchTab('screens/')">screens/</button>
  <button onclick="switchTab('video/')">video/</button>
  <button onclick="switchTab('social/')">social/</button>
</div>

<div id="status"></div>

<div class="prefix-bar">
  <label>Upload to:</label>
  <select id="prefix">
    <option value="screens/">screens/</option>
    <option value="video/">video/</option>
    <option value="social/">social/</option>
  </select>
</div>

<div class="upload-zone" id="dropzone">
  <p>Drop files here or click to upload</p>
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

// ── Init ──
loadFiles();
</script>
</body>
</html>`;
