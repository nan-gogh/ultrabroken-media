/**
 * Ultrabroken Media Worker
 *
 * Serves media files from R2 (public) and provides a management UI
 * at /manage (protected by Cloudflare Access - GitHub OAuth).
 *
 * Routes:
 *   GET  /manage            → Management UI (upload, browse, delete)
 *   GET  /manage/editor/*   → Proxied editor (GitHub Pages → same origin)
 *   GET  /manage/api/list   → JSON listing of files in a prefix (authed)
 *   POST /manage/api/upload → Upload file(s) to R2
 *   POST /manage/api/delete → Delete a file from R2
 *   POST /manage/api/edit   → Dispatch edit job to GitHub Actions
 *   POST /manage/api/rename → Rename a file in R2
 *   POST /manage/api/purge  → Delete all files under a prefix
 *   GET  /api/list          → Public read-only file listing (no auth)
 *   GET  /*                 → Serve file from R2 (public)
 */

const ALLOWED_PREFIXES = ["image/", "video/", "social/"];
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

  // Parse Range header for partial content support (required by Discord, browsers)
  const rangeHeader = request.headers.get("Range");
  let rangeOpts = undefined;
  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      rangeOpts = end !== undefined ? { offset: start, length: end - start + 1 } : { offset: start };
    }
  }

  const object = await env.MEDIA.get(key, rangeOpts ? { range: rangeOpts } : undefined);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("Content-Type", getMime(key));
  headers.set("Cache-Control", "public, no-cache");
  headers.set("ETag", object.httpEtag);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "bytes");
  object.writeHttpMetadata(headers);

  // Return 304 if client's cached version matches
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  const totalSize = object.size;

  // Range request → 206 Partial Content
  if (rangeOpts) {
    const start = rangeOpts.offset;
    const length = object.range?.length ?? (rangeOpts.length || (totalSize - start));
    const end = start + length - 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(totalSize));
  return new Response(object.body, { headers });
}

// -- Public read-only list --------------------------------------------------

async function handlePublicList(request, env) {
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

  return new Response(JSON.stringify({
    files,
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, no-cache',
    },
  });
}

// â”€â”€ Management API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// -- Bearer token auth ------------------------------------------------------
//
// Management API routes (/manage/api/*) are protected by CF Access at the edge.
// Browser clients (the proxied editor, the inline manage page) are authenticated
// automatically via the CF_Authorization cookie — no extra headers needed.
//
// requireBearerAuth() provides a secondary auth path: requests that carry a
// valid Authorization: Bearer <GITHUB_TOKEN> header are accepted even without a
// CF Access session.  This enables non-browser automation (scripts, Actions
// runners, etc.) when paired with a CF Access Service Token to pass the edge.
//
// When GITHUB_TOKEN is unset, Bearer auth is disabled and CF Access at the edge
// is the sole gate.

function requireBearerAuth(request, env) {
  if (!env.GITHUB_TOKEN) return null; // CF Access is the only gate -- skip check

  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const spaceIdx = authHeader.indexOf(' ');
    const scheme   = authHeader.slice(0, spaceIdx);
    const token    = authHeader.slice(spaceIdx + 1).trim();
    if (scheme === 'Bearer' && token === env.GITHUB_TOKEN) return null; // OK
    // Header present but wrong -- reject to prevent brute-forcing via other paths.
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // No Authorization header -- let CF Access handle it.
  return null;
}

async function handleList(request, env) {
  const authErr = requireBearerAuth(request, env);
  if (authErr) return authErr;

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
  const authErr = requireBearerAuth(request, env);
  if (authErr) return authErr;

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const prefix = formData.get("prefix") || "";
  const skipWorkflow = formData.get("skipWorkflow") === "true";
  const quality = formData.get("quality") || "24";
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
    if (!skipWorkflow && /\.(mp4|mov|mkv|webm)$/i.test(key)) {
      putOptions.customMetadata = { transcode: 'pending' };
    } else if (!skipWorkflow && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(key)) {
      putOptions.customMetadata = { optimize: 'pending' };
    }
    await env.MEDIA.put(key, value.stream(), putOptions);

    results.push({ key, size: value.size, ok: true });
  }

  // Dispatch optimization/transcode workflows
  const dispatches = [];
  const videoUploaded = results.some(r => r.ok && /\.(mp4|mov|mkv|webm)$/i.test(r.key));
  if (!skipWorkflow && videoUploaded && env.GITHUB_TOKEN) {
    const videoKeys = results.filter(r => r.ok && /\.(mp4|mov|mkv|webm)$/i.test(r.key)).map(r => r.key);
    try {
      const resp = await fetch('https://api.github.com/repos/' + (env.GITHUB_REPO || 'nan-gogh/ultrabroken-media') + '/actions/workflows/transcode.yml/dispatches', {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + env.GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'ultrabroken-media-worker',
        },
        body: JSON.stringify({ ref: 'main', inputs: { keys: videoKeys.join(','), quality } }),
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
  const authErr = requireBearerAuth(request, env);
  if (authErr) return authErr;

  const { key } = await request.json();

  if (!isValidKey(key)) {
    return Response.json({ error: "Invalid key" }, { status: 400 });
  }

  await env.MEDIA.delete(key);
  return Response.json({ deleted: key });
}

async function handlePurge(request, env) {
  const authErr = requireBearerAuth(request, env);
  if (authErr) return authErr;

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
  const authErr = requireBearerAuth(request, env);
  if (authErr) return authErr;

  const body = await request.json();
  const { clips, output, force, vf } = body;

  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return Response.json({ error: "No clips provided" }, { status: 400 });
  }

  if (!output || typeof output !== 'string') {
    return Response.json({ error: "No output name provided" }, { status: 400 });
  }

  const outputKey = output.endsWith('.mp4') ? output : output + '.mp4';
  if (!isValidKey(outputKey)) {
    return Response.json({ error: "Invalid output path" }, { status: 400 });
  }

  if (!vf || typeof vf !== 'string') {
    return Response.json({ error: "No video filter chain provided" }, { status: 400 });
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

  // Check for existing file unless force overwrite
  if (!force) {
    const existing = await env.MEDIA.head(outputKey);
    if (existing && existing.size > 0) {
      return Response.json({ error: "exists", key: outputKey }, { status: 409 });
    }
  }

  // Create placeholder so manage page shows pending badge
  await env.MEDIA.put(outputKey, new Uint8Array(0), {
    httpMetadata: { contentType: 'video/mp4' },
    customMetadata: { transcode: 'pending' },
  });

  if (!env.GITHUB_TOKEN) {
    return Response.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
  }

  const editPayload = JSON.stringify({ clips, output: outputKey, vf });

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
  const authErr = requireBearerAuth(request, env);
  if (authErr) return authErr;

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

// ── CORS helper ─────────────────────────────────────────────────────────────
//
// The management API is accessed both from the Worker's own origin (the inline
// MANAGE_HTML page, via Cloudflare Access) and from the separate GitHub Pages
// editor (via Authorization: Bearer token).  For the cross-origin case the
// browser requires specific-origin CORS + Allow-Credentials: true — wildcards
// are incompatible with credentialed requests.
//
// We reflect the request's Origin back to satisfy that requirement.  Auth is
// enforced by Cloudflare Access at the edge (management HTML) and/or by Bearer
// token validation in the handler (GitHub Pages editor).

function withCors(response, request) {
  const origin = request.headers.get('Origin');
  if (!origin) return response;                    // same-origin — no CORS needed
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

// ── Editor proxy ────────────────────────────────────────────────────────────
//
// Serve the GitHub Pages editor from /manage/editor/* so it shares the Worker
// origin.  CF Access gates /manage/* at the edge — once the user passes GitHub
// OAuth, the CF_Authorization cookie covers both the page load and every
// same-origin fetch to /manage/api/*.  No Bearer token or settings panel needed.

const PROXY_MIMES = { js: 'application/javascript', mjs: 'application/javascript', css: 'text/css', html: 'text/html; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2' };

async function handleEditorProxy(request, env, path) {
  const ghRepo = env.GITHUB_REPO || 'nan-gogh/ultrabroken-media';
  const [ghOwner, ghRepoName] = ghRepo.split('/');
  const pagesOrigin = `https://${ghOwner}.github.io/${ghRepoName}`;

  // Strip /manage to get the GitHub Pages path.
  // /manage/editor/ -> /editor/index.html, /manage/css/* -> /css/*, etc.
  let subpath = path.slice('/manage'.length);
  if (subpath === '/editor' || subpath === '/editor/') subpath = '/editor/index.html';

  const pagesUrl = pagesOrigin + subpath;
  const resp = await fetch(pagesUrl, {
    headers: { 'User-Agent': 'ultrabroken-media-worker' },
    cf: { cacheTtl: 300 },          // cache Pages assets for 5 min at CF edge
  });

  if (!resp.ok) {
    return new Response('Editor file not found: ' + subpath, { status: resp.status });
  }

  const headers = new Headers();
  const ext = subpath.split('.').pop().toLowerCase();
  headers.set('Content-Type', PROXY_MIMES[ext] || resp.headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=300');

  return new Response(resp.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — reflect the requesting Origin so credentialed
    // cross-origin fetches (e.g. from the GitHub Pages editor) work correctly.
    if (request.method === "OPTIONS") {
      const origin = request.headers.get('Origin') || '*';
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
          'Vary': 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          // Authorization: Bearer token auth for the GitHub Pages editor.
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Management routes (protected by Cloudflare Access at the edge)
    if (path === "/manage" || path === "/manage/") {
      return new Response(MANAGE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Editor proxy — serve the GitHub Pages editor and its shared assets
    // (css/, js/, coi-serviceworker.js) from the Worker domain so the
    // CF Access cookie covers the page and all its API calls.
    if (path === "/manage/editor") {
      return Response.redirect(url.origin + "/manage/editor/", 301);
    }
    if (path.startsWith("/manage/editor/") || path.startsWith("/manage/css/") || path.startsWith("/manage/js/") || path === "/manage/coi-serviceworker.js") {
      return handleEditorProxy(request, env, path);
    }

    // Management API — under /manage/* so CF Access gates these at the edge.
    // requireBearerAuth() provides a secondary auth path for non-browser clients.
    if (path === "/manage/api/list" && request.method === "GET") {
      return withCors(await handleList(request, env), request);
    }
    if (path === "/manage/api/upload" && request.method === "POST") {
      return withCors(await handleUpload(request, env), request);
    }
    if (path === "/manage/api/delete" && request.method === "POST") {
      return withCors(await handleDelete(request, env), request);
    }
    if (path === "/manage/api/purge" && request.method === "POST") {
      return withCors(await handlePurge(request, env), request);
    }
    if (path === "/manage/api/edit" && request.method === "POST") {
      return withCors(await handleEdit(request, env), request);
    }
    if (path === "/manage/api/rename" && request.method === "POST") {
      return withCors(await handleRename(request, env), request);
    }
    // Public read-only list API (no auth — used by the vault page)
    if (path === "/api/list" && request.method === "GET") {
      return handlePublicList(request, env);
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
<title>Ultrabroken Media - Manage</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=New+Rocker&family=Texturina:ital,opsz,wght@0,12..44,100..900;1,12..44,100..900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/manage/css/vault.css">
</head>
<body>

<header>
  <h1>Ultrabroken Archives <span class="sub">Media Vault</span></h1>
  <div style="display:flex;gap:8px;">
    <a class="btn" href="/manage/editor">Video Editor</a>
    <a class="btn" href="/cdn-cgi/access/logout">Logout</a>
  </div>
</header>

<div class="upload-zone" id="dropzone">
  <p><strong>Drop files here</strong> or click to browse</p>
  <input type="checkbox" id="compressToggle" hidden>
  <div id="compressArea" style="opacity:0.3;cursor:pointer;user-select:none" onclick="(function(ev){
    ev.stopPropagation();
    var cb=document.getElementById('compressToggle');
    cb.checked=!cb.checked;
    var on=cb.checked;
    document.getElementById('compressArea').style.opacity=on?'1':'0.3';
    document.getElementById('qualitySlider').disabled=!on;
  })(event)">
    <div class="quality-row">
      <span style="color:var(--text-dim);white-space:nowrap">Compression</span>
      <input type="range" id="qualitySlider" min="18" max="30" value="24" disabled onclick="event.stopPropagation()" oninput="document.getElementById('qualityValue').textContent=this.value">
      <span id="qualityValue" style="color:var(--text-dim);min-width:1.4em;text-align:right">24</span>
    </div>
    <div style="margin-top:8px;font-size:0.9rem;color:var(--text-dim);line-height:1.5">
      Videos &rarr; <code>video/</code> (H.264 transcode)<br>
      Images &rarr; <code>image/</code> (AVIF optimize)
    </div>
  </div>
  <input type="file" id="fileInput" multiple hidden>
</div>

<div id="status"></div>

<div class="tabs">
  <button class="active" onclick="switchTab('image/')">image/</button>
  <button onclick="switchTab('video/')">video/</button>
  <button onclick="switchTab('social/')">social/</button>
</div>

<div id="fileListContainer">
  <div class="loading">Loading...</div>
</div>

<script>
const API = "/manage/api";
let currentPrefix = "image/";

// â”€â”€ Tab switching â”€â”€
function switchTab(prefix) {
  currentPrefix = prefix;
  document.querySelectorAll(".tabs button").forEach(b =>
    b.classList.toggle("active", b.textContent.trim() === prefix));
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
    var totalPending = Math.max(globalPending, allFiles.filter(f => f.transcode === 'pending' || f.optimize === 'pending').length);
    for (const f of allFiles) {
      const name = f.key.slice(currentPrefix.length);
      const size = formatSize(f.size);
      const date = new Date(f.uploaded).toLocaleDateString();
      var isPending = f.transcode === 'pending' || f.optimize === 'pending';
      var dis = isPending ? ' disabled' : '';
      var badgeText = f.transcode === 'pending'
        ? (totalPending > 1 ? '\u23F3 transcoding queued' : '\u23F3 transcoding')
        : (totalPending > 1 ? '\u23F3 optimizing queued' : '\u23F3 optimizing');
      var metaHtml = isPending
        ? '<span class="badge-transcode">' + badgeText + '</span>'
        : '<span class="meta"><span class="size">' + size + '</span>'
          + '<span class="date">' + date + '</span></span>';
      html += '<div class="file-row">'
        + '<span class="name" onclick="previewFile(\\'' + escAttr(f.key) + '\\')" title="' + escHtml(f.key) + '">' + escHtml(name) + '</span>'
        + metaHtml
        + '<span class="actions">'
        + '  <a class="btn" href="/' + encodeURI(f.key) + '" download title="Download"' + dis + '>&#8595;</a>'
        + '  <button class="btn" onclick="copyUrl(\\'' + escAttr(f.key) + '\\')" title="Copy URL"' + dis + '>⿻</button>'
        + '  <button class="btn" onclick="renameFile(\\'' + escAttr(f.key) + '\\')" title="Rename"' + dis + '>&#9998;</button>'
        + '  <button class="btn danger" onclick="deleteFile(\\'' + escAttr(f.key) + '\\')" title="Delete">&#10005;</button>'
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
  const files = Array.from(rawFiles).filter(f =>
    f.type.startsWith('video/') || f.type.startsWith('image/')
  );
  const rejected = rawFiles.length - files.length;
  if (rejected > 0) showStatus(rejected + ' file(s) skipped \u2014 only images and videos accepted', false);
  if (!files.length) return;

  const videos = files.filter(f => f.type.startsWith('video/'));
  const images = files.filter(f => f.type.startsWith('image/'));
  const uploads = [];

  const skipCompress = !document.getElementById("compressToggle").checked;
  const quality = document.getElementById("qualitySlider").value;

  if (videos.length) {
    const form = new FormData();
    form.set("prefix", "video/");
    form.set("quality", quality);
    if (skipCompress) form.set("skipWorkflow", "true");
    for (const f of videos) form.append("file", f);
    uploads.push(fetch(API + "/upload", { method: "POST", body: form }).then(r => r.json()));
  }
  if (images.length) {
    const form = new FormData();
    form.set("prefix", "image/");
    for (const f of images) form.append("file", f);
    uploads.push(fetch(API + "/upload", { method: "POST", body: form }).then(r => r.json()));
  }

  try {
    showStatus("Uploading " + files.length + " file(s)...", true);
    const results = (await Promise.all(uploads)).flatMap(d => d.results);
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => r.error);
    const videoCount = results.filter(r => r.ok && /\.(mp4|mov|webm|mkv)$/i.test(r.key)).length;
    const imageCount = results.filter(r => r.ok && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(r.key)).length;
    let msg = ok + " file(s) uploaded";
    if (imageCount) msg += " \u2014 " + imageCount + " image(s) queued for AVIF optimization";
    if (videoCount) msg += " \u2014 " + videoCount + " video(s) queued for H.264 transcode";
    if (fail.length) {
      showStatus(ok + " uploaded, " + fail.length + " failed: " + fail.map(f => f.key + " (" + f.error + ")").join(", "), false);
    } else {
      showStatus(msg, true);
    }
    await updateGlobalPending();
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
  var isVideo = /\\.(mp4|mov|webm|mkv)$/i.test(key);
  var overlay = document.createElement('div');
  overlay.className = 'preview-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeOverlay(); };
  function closeOverlay() { if (overlay.parentNode) document.body.removeChild(overlay); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') closeOverlay(); }
  document.addEventListener('keydown', onKey);
  var close = document.createElement('button');
  close.className = 'close-btn';
  close.innerHTML = '&times;';
  close.onclick = closeOverlay;
  overlay.appendChild(close);
  if (isVideo) {
    var vid = document.createElement('video');
    vid.controls = true; vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    vid.onerror = function() {
      if (overlay.parentNode) {
        vid.remove();
        var msg = document.createElement('div');
        msg.style.cssText = 'text-align:center;color:var(--text);padding:32px;';
        msg.innerHTML = '<p style="margin-bottom:12px;color:var(--text-dim);">This browser cannot play this video format.</p>'
          + '<a class="btn" href="' + url + '" download style="font-size:0.85rem;padding:8px 18px;">Download to view</a>';
        overlay.appendChild(msg);
      }
    };
    vid.src = url;
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
  var dotIdx = oldName.lastIndexOf('.');
  var stem = dotIdx > 0 ? oldName.substring(0, dotIdx) : oldName;
  var ext  = dotIdx > 0 ? oldName.substring(dotIdx) : '';
  var newStem = prompt('Rename file:\\n' + oldName + '\\n\\nExtension (' + ext + ') will be preserved.', stem);
  if (newStem === null || newStem.trim() === '' || newStem === stem) return;
  var newName = newStem.trim() + ext;
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
let globalPending = 0;
async function updateGlobalPending() {
  try {
    const results = await Promise.all(['image/', 'video/'].map(p =>
      fetch(API + '/list?' + new URLSearchParams({ prefix: p })).then(r => r.json()).catch(() => ({ files: [] }))
    ));
    globalPending = results.flatMap(d => d.files || []).filter(f => f.transcode === 'pending' || f.optimize === 'pending').length;
  } catch { globalPending = 0; }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    try {
      var c = document.getElementById('fileListContainer');
      let allFiles = [], cursor = null;
      do {
        const params = new URLSearchParams({ prefix: currentPrefix });
        if (cursor) params.set('cursor', cursor);
        const data = await fetch(API + '/list?' + params).then(r => r.json());
        allFiles = allFiles.concat(data.files);
        cursor = data.truncated ? data.cursor : null;
      } while (cursor);
      const fileMap = new Map(allFiles.map(f => [f.key, f]));
      const rows = c.querySelectorAll('.file-row');
      const totalPending = Math.max(globalPending, allFiles.filter(f => f.transcode === 'pending' || f.optimize === 'pending').length);
      let rebuild = rows.length !== allFiles.length;
      if (!rebuild) rows.forEach(row => {
        if (!fileMap.has(row.querySelector('.name').title)) rebuild = true;
      });
      if (rebuild) {
        c.style.minHeight = c.offsetHeight + 'px';
        await _rawLoadFiles();
        c.style.minHeight = '';
      } else {
        rows.forEach(row => {
          const f = fileMap.get(row.querySelector('.name').title);
          if (!f) return;
          const isPending = f.transcode === 'pending' || f.optimize === 'pending';
          const badge = row.querySelector('.badge-transcode');
          if (badge && !isPending) {
            const meta = document.createElement('span');
            meta.className = 'meta';
            meta.innerHTML = '<span class="size">' + formatSize(f.size) + '</span><span class="date">' + new Date(f.uploaded).toLocaleDateString() + '</span>';
            badge.replaceWith(meta);
            row.querySelectorAll('.actions .btn[disabled]').forEach(b => b.removeAttribute('disabled'));
          } else if (badge) {
            const txt = f.transcode === 'pending'
              ? (totalPending > 1 ? '\\u23F3 transcoding queued' : '\\u23F3 transcoding')
              : (totalPending > 1 ? '\\u23F3 optimizing queued' : '\\u23F3 optimizing');
            if (badge.textContent !== txt) badge.textContent = txt;
          }
        });
      }
      if (!c.querySelector('.badge-transcode')) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    } catch (e) { console.warn('refresh tick:', e); }
  }, 10000);
}

// â”€â”€ Init â”€â”€
const _rawLoadFiles = loadFiles;
loadFiles = async function() {
  await _rawLoadFiles();
  if (document.querySelector('.badge-transcode')) {
    await updateGlobalPending();
    await _rawLoadFiles();
    scheduleRefresh();
  }
};
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

  .status { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 900; padding: 9px 20px; border-radius: 6px; font-size: 0.84rem; font-family: 'JetBrains Mono', monospace; border-left: 3px solid; pointer-events: none; transition: opacity 0.3s; max-width: 90vw; }
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



  .timeline { padding: 12px; min-height: 60px; display: flex; gap: 8px; overflow-x: auto; flex-wrap: wrap; }
  .timeline:empty::after { content: 'Add clips from the library above'; color: var(--text-dim); font-size: 0.82rem; width: 100%; text-align: center; padding: 20px; }

  .clip-card {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; min-width: 120px; max-width: 170px; flex-shrink: 0;
    cursor: grab; -webkit-user-select: none; user-select: none; transition: border-color 0.15s, transform 0.15s;
  }
  .clip-card:active { cursor: grabbing; }
  .clip-card.selected { border-color: var(--accent); box-shadow: var(--glow); }
  .clip-card.dragging { opacity: 0.4; transform: scale(0.95); }
  .clip-card.dragover { border-color: var(--accent); border-style: dashed; }
  .clip-card .clip-name { font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; color: var(--text); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .clip-card .clip-name:hover { color: var(--accent); }
  .clip-card .clip-mini-bar { position: relative; width: 100%; height: 6px; border-radius: 3px; background: var(--bg); margin-bottom: 4px; }
  .clip-card .clip-mini-fill { position: absolute; top: 0; height: 6px; border-radius: 3px; background: var(--accent-dk); }
  .clip-card .clip-meta { font-size: 0.65rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; margin-bottom: 4px; }
  .clip-card .clip-actions { display: flex; gap: 4px; }
  .clip-card .clip-actions button { padding: 2px 8px; font-size: 0.7rem; }

  .overlay-list { padding: 12px; }
  .overlay-list:empty::after { content: 'No text overlays yet'; color: var(--text-dim); font-size: 0.82rem; display: block; text-align: center; padding: 12px; }
  .overlay-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .overlay-row:last-child { border-bottom: none; }
  .overlay-row input[type="text"] { flex: 1; min-width: 120px; background: var(--bg); border: 1px solid var(--border); border-radius: 3px; color: var(--text); padding: 4px 8px; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
  .overlay-row input[type="text"]:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .overlay-row input[type="number"] { width: 58px; background: var(--bg); border: 1px solid var(--border); border-radius: 3px; color: var(--text); padding: 4px 6px; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; text-align: center; }
  .overlay-row input[type="number"]:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .overlay-row .ov-label { font-family: 'JetBrains Mono', monospace; font-size: 0.68rem; color: var(--text-dim); }
  .overlay-total { padding: 6px 12px; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--text-dim); text-align: right; }

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
    -webkit-appearance: none; appearance: none; background: none; pointer-events: none; margin: 0; outline: none;
  }
  .editor-range input[type="range"]:focus { outline: none; box-shadow: none; }
  .editor-range input[type="range"]::-webkit-slider-runnable-track { height: 24px; background: transparent; border-radius: 12px; }
  .editor-range input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent); border: none; cursor: pointer;
    pointer-events: auto; margin-top: 0; position: relative; z-index: 2; outline: none; box-shadow: none;
  }
  .editor-range input[type="range"]::-moz-range-track { height: 24px; background: transparent; border-radius: 12px; border: none; }
  .editor-range input[type="range"]::-moz-range-thumb {
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent); border: none; cursor: pointer;
    pointer-events: auto; outline: none; box-shadow: none;
  }
  .editor-range .range-fill {
    position: absolute; top: 0; height: 24px; background: var(--accent-dk); border-radius: 0;
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
    <span>Video Library</span>
    <button class="btn" onclick="loadLibrary()" title="Refresh">&circlearrowright;</button>
  </div>
  <div class="library-list" id="libraryList">
    <div style="padding:20px;text-align:center;color:var(--text-dim);font-size:0.82rem;">Loading\u2026</div>
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
  <div class="section-header">
    <span>Text Overlays</span>
    <span style="margin-left:auto;display:flex;gap:6px;align-items:center;"><span id="overlayTotal" class="overlay-total"></span><button class="btn" onclick="addOverlay()">+ Add Text</button></span>
  </div>
  <div class="overlay-list" id="overlayList"></div>
</div>

<div class="section">
  <div class="section-header">Export</div>
  <div class="export-bar">
    <label>Output:</label>
    <span class="suffix">video/</span>
    <input type="text" id="outputName" placeholder="my-edit" spellcheck="false">
    <span class="suffix">.mp4</span>
    <button class="btn primary" onclick="doExport()">Export &rarr; H.264+AAC</button>
  </div>
</div>

<script>
var API = "/api";
var BASE_URL = location.origin + "/";
var clips = [];
var nextClipId = 1;
var dragSrcIndex = null;
var selectedIndex = -1;
var overlays = [];
var nextOverlayId = 1;

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
        + '<span class="name" onclick="previewClip(\\'' + escAttr(f.key) + '\\')" title="Click to preview">' + escHtml(name) + '</span>' + badge
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Timeline ──
function addClip(key) {
  var name = key.replace(/^video\\//, "");
  var clipId = nextClipId++;
  clips.push({ id: clipId, key: key, name: name, start: 0, end: -1, duration: 0 });
  selectedIndex = clips.length - 1;
  renderTimeline();
  renderEditor();
  showStatus("Added: " + name, true, 3000);
  getVideoDuration(BASE_URL + key).then(function(dur) {
    for (var i = 0; i < clips.length; i++) {
      if (clips[i].id === clipId) {
        clips[i].duration = dur || 0;
        clips[i].end = dur || -1;
        break;
      }
    }
    renderTimeline();
    if (selectedIndex >= 0 && selectedIndex < clips.length && clips[selectedIndex].id === clipId) renderEditor();
    renderOverlayTotal();
  });
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
  var offset = 0;
  for (var i = 0; i < clips.length; i++) {
    var c = clips[i];
    var maxVal = c.duration > 0 ? c.duration : 100;
    var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
    var startPct = (c.start / maxVal * 100).toFixed(1);
    var widthPct = ((endVal - c.start) / maxVal * 100).toFixed(1);
    var clipDur = c.duration > 0 ? endVal - c.start : 0;
    var trimDur = c.duration > 0 ? clipDur.toFixed(1) + "s" : "";
    var timeInfo = c.duration > 0 ? fmtTime(offset) + ' \u2192 ' + fmtTime(offset + clipDur) + ' \u00b7 ' : '';
    offset += clipDur;
    var sel = i === selectedIndex ? " selected" : "";
    html += '<div class="clip-card' + sel + '" draggable="true" data-index="' + i + '" '
      + 'onclick="selectClip(' + i + ')" '
      + 'ondragstart="onDragStart(event)" ondragover="onDragOver(event)" ondrop="onDrop(event)" ondragend="onDragEnd(event)">'
      + '<div class="clip-name" title="' + escHtml(c.key) + '" onclick="event.stopPropagation();previewClip(\\'' + escAttr(c.key) + '\\', ' + c.start + ')">' + escHtml(c.name) + '</div>'
      + '<div class="clip-mini-bar"><div class="clip-mini-fill" style="left:' + startPct + '%;width:' + widthPct + '%;"></div></div>'
      + '<div class="clip-meta">' + timeInfo + (trimDur || '?') + '</div>'
      + '<div class="clip-actions">'
      + '<button class="btn danger" onclick="event.stopPropagation();removeClip(' + i + ')">&times;</button>'
      + '</div></div>';
  }
  tl.innerHTML = html;
  document.getElementById("clipCount").textContent = clips.length > 0 ? clips.length + " clip(s)" : "";
  renderOverlayTotal();
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
  renderTimeline();
}

function removeClip(i) {
  clips.splice(i, 1);
  if (selectedIndex === i) selectedIndex = -1;
  else if (selectedIndex > i) selectedIndex--;
  renderTimeline();
  renderEditor();
  renderOverlayTotal();
}

// \u2500\u2500 Text Overlays \u2500\u2500
function getTotalDuration() {
  var total = 0;
  for (var i = 0; i < clips.length; i++) {
    var c = clips[i];
    var maxVal = c.duration > 0 ? c.duration : 0;
    var endVal = (c.end === -1 || c.end > maxVal) ? maxVal : c.end;
    total += endVal - c.start;
  }
  return Math.round(total * 10) / 10;
}

function renderOverlayTotal() {
  var el = document.getElementById('overlayTotal');
  var dur = getTotalDuration();
  el.textContent = dur > 0 ? 'Total: ' + fmtTime(dur) : '';
}

function addOverlay() {
  overlays.push({ id: nextOverlayId++, text: '', start: 0, end: Math.min(3, getTotalDuration() || 3) });
  renderOverlays();
}

function removeOverlay(i) {
  overlays.splice(i, 1);
  renderOverlays();
}

function onOverlayChange(i, field, val) {
  if (i < 0 || i >= overlays.length) return;
  var ov = overlays[i];
  if (field === 'text') {
    ov.text = val;
  } else {
    var v = parseFloat(val);
    if (isNaN(v) || v < 0) v = 0;
    if (field === 'start') {
      ov.start = Math.round(v * 10) / 10;
    } else {
      ov.end = Math.round(v * 10) / 10;
    }
  }
}

function renderOverlays() {
  var list = document.getElementById('overlayList');
  var html = '';
  for (var i = 0; i < overlays.length; i++) {
    var ov = overlays[i];
    html += '<div class="overlay-row">'
      + '<input type="text" value="' + escHtml(ov.text) + '" placeholder="Text\u2026" oninput="onOverlayChange(' + i + ',\\'text\\',this.value)">'
      + '<span class="ov-label">from</span>'
      + '<input type="number" min="0" step="0.1" value="' + ov.start + '" onchange="onOverlayChange(' + i + ',\\'start\\',this.value)">'
      + '<span class="ov-label">to</span>'
      + '<input type="number" min="0" step="0.1" value="' + ov.end + '" onchange="onOverlayChange(' + i + ',\\'end\\',this.value)">'
      + '<span class="ov-label">s</span>'
      + '<button class="btn danger" onclick="removeOverlay(' + i + ')">&times;</button>'
      + '</div>';
  }
  list.innerHTML = html;
  renderOverlayTotal();
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

// ── Touch drag to reorder (mobile) ──
var touchDragIndex = null;
var touchLongPress = null;
var touchDragging = false;

document.getElementById("timeline").addEventListener("touchstart", function(e) {
  var card = e.target.closest(".clip-card");
  if (!card) return;
  var idx = parseInt(card.getAttribute("data-index"));
  touchLongPress = setTimeout(function() {
    touchDragIndex = idx;
    touchDragging = true;
    card.classList.add("dragging");
  }, 300);
}, { passive: true });

document.getElementById("timeline").addEventListener("touchmove", function(e) {
  if (!touchDragging) { clearTimeout(touchLongPress); return; }
  e.preventDefault();
  var touch = e.touches[0];
  var el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!el) return;
  var card = el.closest(".clip-card");
  document.querySelectorAll(".clip-card").forEach(function(c) { c.classList.remove("dragover"); });
  if (card) card.classList.add("dragover");
}, { passive: false });

document.getElementById("timeline").addEventListener("touchend", function(e) {
  clearTimeout(touchLongPress);
  if (!touchDragging) return;
  var touch = e.changedTouches[0];
  var el = document.elementFromPoint(touch.clientX, touch.clientY);
  var card = el ? el.closest(".clip-card") : null;
  if (card) {
    var targetIndex = parseInt(card.getAttribute("data-index"));
    if (touchDragIndex !== null && touchDragIndex !== targetIndex) {
      var moved = clips.splice(touchDragIndex, 1)[0];
      clips.splice(targetIndex, 0, moved);
      if (selectedIndex === touchDragIndex) selectedIndex = targetIndex;
      else if (touchDragIndex < selectedIndex && targetIndex >= selectedIndex) selectedIndex--;
      else if (touchDragIndex > selectedIndex && targetIndex <= selectedIndex) selectedIndex++;
      renderTimeline();
    }
  }
  touchDragIndex = null;
  touchDragging = false;
  document.querySelectorAll(".clip-card").forEach(function(c) {
    c.classList.remove("dragging", "dragover");
  });
});

// ── Export ──
async function doExport(forceOverwrite) {
  if (clips.length === 0) { showStatus("Add at least one clip to the timeline", false); return; }
  if (clips.length === 1 && clips[0].start <= 0 && clips[0].end === -1 && overlays.length === 0) {
    showStatus("Nothing to render \u2014 single untrimmed clip. Use Rename on the manage page instead.", false);
    return;
  }
  var name = document.getElementById("outputName").value.trim();
  if (!name) { showStatus("Enter an output name", false); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    showStatus("Name: letters, numbers, dashes, underscores only", false);
    return;
  }
  var outputKey = "video/" + name + ".mp4";
  var validOverlays = overlays.filter(function(ov) { return ov.text.trim().length > 0; });
  for (var oi = 0; oi < validOverlays.length; oi++) {
    var ov = validOverlays[oi];
    if (ov.end <= ov.start) {
      showStatus("Overlay \\\"" + ov.text.trim() + "\\\" has end (" + ov.end + ") \\u2264 start (" + ov.start + ")", false);
      return;
    }
  }
  var payload = {
    clips: clips.map(function(c) { return { key: c.key, start: c.start, end: c.end }; }),
    overlays: validOverlays.map(function(ov) { return { text: ov.text.trim(), start: ov.start, end: ov.end }; }),
    output: outputKey,
    force: !!forceOverwrite
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
    } else if (data.error === "exists") {
      if (confirm(name + ".mp4 already exists in video storage.\\nOverwrite it?")) {
        doExport(true);
      }
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