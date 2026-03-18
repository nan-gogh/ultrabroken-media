/**
 * backend-remote.js
 *
 * Remote backend for the video editor. Lists videos from R2 via the Worker
 * management API and dispatches edit jobs to GitHub Actions via /manage/api/edit.
 *
 * Authentication: the editor is served from the Worker origin at /manage/editor/*
 * which is gated by Cloudflare Access (GitHub OAuth).  The CF_Authorization
 * cookie covers all same-origin fetches to /manage/api/* automatically —
 * no Bearer tokens or manual config needed.
 */

import { buildFFmpegArgs } from './ffmpeg-args.js';

export class RemoteBackend {
  constructor() {
    this.mode = 'remote';
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
      const res = await fetch(`/manage/api/list?${params}`);
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
    return '/' + file.key;
  }

  /**
   * Dispatch the edit job to GitHub Actions via the Worker API.
   * @param {import('./ffmpeg-args.js').EditJob} job
   * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
   */
  async execute(job) {
    const { vf } = buildFFmpegArgs(job, {
      preset: 'slow',
      fontFile: 'font.ttf',
    });
    const payload = {
      clips: job.clips.map(c => ({ key: c.key, start: c.start, end: c.end })),
      vf,
      output: job.outputKey,
      force: job.force || false,
    };
    const res = await fetch('/manage/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
