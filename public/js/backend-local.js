/**
 * backend-local.js
 *
 * Local backend for the video editor.  All processing runs in-browser via
 * FFmpeg.wasm — no uploads, no server calls, no auth required.
 *
 * FFmpeg.wasm and its utilities are loaded from unpkg CDN at runtime and
 * cached in-module so they are only fetched once.  WASM binaries are fetched
 * via toBlobURL() which converts them to same-origin blob: URLs, satisfying
 * the COEP: require-corp policy injected by coi-serviceworker.js.
 *
 * Multi-threading: when SharedArrayBuffer is available (crossOriginIsolated is
 * true) we load @ffmpeg/core-mt; otherwise we fall back to @ffmpeg/core (ST).
 *
 * Progress is reported on a per-exec-command basis, weighted so that each
 * trim pass contributes an equal share and the final concat+transcode pass
 * contributes the remaining share.
 */

// ─── CDN imports (pinned versions) ──────────────────────────────────────────

const FFMPEG_VERSION  = '0.12.10';
const UTIL_VERSION    = '0.12.1';
const CORE_VERSION    = '0.12.6';

const UNPKG = 'https://unpkg.com';
const FFMPEG_ESM = `${UNPKG}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js`;
const UTIL_ESM   = `${UNPKG}/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js`;

const CORE_BASE    = `${UNPKG}/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_MT_BASE = `${UNPKG}/@ffmpeg/core-mt@${CORE_VERSION}/dist/esm`;

// ─── Lazy module cache ───────────────────────────────────────────────────────

let _ffmpegMod = null;
let _utilMod   = null;

async function loadModules() {
  if (!_ffmpegMod || !_utilMod) {
    [_ffmpegMod, _utilMod] = await Promise.all([
      import(/* @vite-ignore */ FFMPEG_ESM),
      import(/* @vite-ignore */ UTIL_ESM),
    ]);
  }
  return { FFmpeg: _ffmpegMod.FFmpeg, fetchFile: _utilMod.fetchFile, toBlobURL: _utilMod.toBlobURL };
}

// ─── Backend class ───────────────────────────────────────────────────────────

export class LocalBackend {
  constructor() {
    this.mode   = 'local';
    this.ffmpeg = null;   // FFmpeg instance, created once then reused
    this.loaded = false;  // true after ffmpeg.load() completes
  }

  /**
   * Local mode has no remote library — clips are added via the file picker.
   * @returns {Promise<[]>}
   */
  async listVideos() {
    return [];
  }

  /**
   * Generate a preview URL for a local File.
   * @param {{ key: string, _file?: File }} file
   * @returns {string}
   */
  getPreviewUrl(file) {
    if (file._file instanceof File) {
      return URL.createObjectURL(file._file);
    }
    return '';
  }

  /**
   * Initialize FFmpeg.wasm.  Called automatically on first execute().
   * Safe to call again after a terminate() — it reinitialises cleanly.
   */
  async init() {
    const { FFmpeg, toBlobURL } = await loadModules();

    this.ffmpeg = new FFmpeg();

    // Optionally surface FFmpeg log output in the console for debugging.
    if (typeof process === 'undefined') { // silence in test environments
      this.ffmpeg.on('log', ({ message }) => {
        console.debug('[ffmpeg]', message);
      });
    }

    if (crossOriginIsolated) {
      // Multi-threaded core — requires SharedArrayBuffer (needs COOP+COEP).
      await this.ffmpeg.load({
        coreURL:   await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.js`,        'text/javascript'),
        wasmURL:   await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.wasm`,      'application/wasm'),
        workerURL: await toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
      });
    } else {
      // Single-threaded core — works without COOP/COEP but is significantly
      // slower; the progress bar is still updated via the progress event.
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`,   'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }

    this.loaded = true;
  }

  /**
   * Process the edit job entirely in-browser using FFmpeg.wasm.
   *
   * The job is translated to FFmpeg command arrays by buildFFmpegArgs() using
   * preset 'medium' (trades a small quality reduction for practical run times
   * in-browser; the Actions workflow uses 'slow').
   *
   * @param {import('./ffmpeg-args.js').EditJob} job
   * @param {(ratio: number) => void} [onProgress]  - called with 0..1
   * @returns {Promise<Blob>}  the finished MP4 as a Blob
   */
  async execute(job, onProgress) {
    if (!this.loaded) await this.init();

    const { fetchFile } = await loadModules();
    const { buildFFmpegArgs } = await import('./ffmpeg-args.js');

    const args        = buildFFmpegArgs(job, { preset: 'medium' });
    const totalSteps  = args.trimCommands.length + 1; // trims + final transcode
    let   stepsDone   = 0;

    // Attach progress listener — fired by FFmpeg.wasm during each exec().
    const onFFmpegProgress = ({ progress }) => {
      if (typeof onProgress === 'function') {
        // Map within-step progress to overall progress.
        const overall = (stepsDone + Math.min(1, Math.max(0, progress))) / totalSteps;
        onProgress(Math.min(0.99, overall));
      }
    };
    this.ffmpeg.on('progress', onFFmpegProgress);

    const writtenFiles = [];

    try {
      // 1. Write each source clip into the FFmpeg virtual FS.
      for (const [i, clip] of job.clips.entries()) {
        const name = `clip_${i}.mp4`;
        await this.ffmpeg.writeFile(name, await fetchFile(clip._file));
        writtenFiles.push(name);
      }

      // 2. Trim each clip to its in/out range.
      for (const trimCmd of args.trimCommands) {
        await this._exec(trimCmd);
        stepsDone++;
        // The trimmed MKV filename is always the last argument.
        writtenFiles.push(trimCmd[trimCmd.length - 1]);
      }

      // 3. Write the concat manifest.
      await this.ffmpeg.writeFile('concat_list.txt', args.concatList);
      writtenFiles.push('concat_list.txt');

      // 4. Final concat + transcode.
      await this._exec(args.finalCommand);
      writtenFiles.push('output.mp4');

      // 5. Read the output back as a Blob.
      const data = await this.ffmpeg.readFile('output.mp4');
      onProgress?.(1);
      return new Blob([data], { type: 'video/mp4' });

    } finally {
      this.ffmpeg.off('progress', onFFmpegProgress);
      await this._cleanup(writtenFiles);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Run a single FFmpeg exec and throw a descriptive error on non-zero exit.
   * @param {string[]} cmd
   */
  async _exec(cmd) {
    const ret = await this.ffmpeg.exec(cmd);
    if (ret !== 0) {
      throw new Error(`FFmpeg exited with code ${ret}. Command: ${cmd.join(' ')}`);
    }
  }

  /**
   * Delete virtual FS files, ignoring errors for files that weren't created.
   * @param {string[]} names
   */
  async _cleanup(names) {
    for (const name of names) {
      try { await this.ffmpeg.deleteFile(name); } catch { /* ignore */ }
    }
  }

  /** @returns {boolean} */
  canProcessLocally() {
    return typeof crossOriginIsolated !== 'undefined';
  }

  /** @returns {{ maxResolution: string, showUploadWarning: boolean }} */
  getConfig() {
    return { maxResolution: '720p', showUploadWarning: false };
  }
}
