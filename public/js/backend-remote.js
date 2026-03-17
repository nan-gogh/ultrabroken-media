/**
 * backend-remote.js
 *
 * Remote backend for the video editor. Lists videos from R2 via the Worker
 * API and dispatches edit jobs to GitHub Actions via /api/edit.
 *
 * Authentication: the Worker's /api/* routes live outside the /manage path,
 * so they are NOT covered by Cloudflare Access.  Instead, requireBearerAuth()
 * in the Worker validates the Authorization: Bearer token on every request.
 *
 * The GITHUB_TOKEN Worker env var value is the shared secret — the same value
 * the user pastes into the settings panel.  It is stored in localStorage.
 */

export class RemoteBackend {
  /**
   * @param {string} workerOrigin  e.g. "https://your-worker.workers.dev"
   * @param {string} token         GitHub PAT with actions:write scope
   */
  constructor(workerOrigin, token) {
    this.mode = 'remote';
    this.origin = workerOrigin.replace(/\/$/, '');
    this.token = token || '';
  }

  /**
   * List all videos in the R2 `video/` prefix via the Worker API.
   * Paginates automatically via cursor.
   * @returns {Promise<Array<{key: string, size: number, transcode: string|null}>>}
   */
  async listVideos() {
    const allFiles = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({ prefix: 'video/' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`${this.origin}/api/list?${params}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (!res.ok) throw new Error(`List failed: ${res.status}`);
      const data = await res.json();
      allFiles.push(...data.files.filter(f => f.size > 0));
      cursor = data.truncated ? data.cursor : null;
    } while (cursor);
    return allFiles;
  }

  /**
   * Public R2 URL — no auth required for GET.
   * @param {{ key: string }} file
   * @returns {string}
   */
  getPreviewUrl(file) {
    return `${this.origin}/${file.key}`;
  }

  /**
   * Dispatch the edit job to GitHub Actions via the Worker API.
   * @param {import('./ffmpeg-args.js').EditJob} job
   * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
   */
  async execute(job) {
    const payload = {
      clips: job.clips.map(c => ({ key: c.key, start: c.start, end: c.end })),
      overlays: job.overlays.filter(ov => ov.text.trim()),
      output: job.outputKey,
      force: job.force || false,
    };
    const res = await fetch(`${this.origin}/api/edit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  /** @returns {boolean} */
  canProcessLocally() {
    return false;
  }

  /** @returns {{ maxResolution: null, showUploadWarning: boolean }} */
  getConfig() {
    return { maxResolution: null, showUploadWarning: false };
  }
}
